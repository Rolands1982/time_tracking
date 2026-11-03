/**
 * Upwork settlement: which fee row paid for which invoice, which payout paid for which earnings, and what
 * that means for every Upwork entry (fee, net, exchange rate, EUR). Pure functions over the raw ledger; the
 * cached columns on the entries are rewritten by recalculateUpwork(). See docs/plans/upwork-integration.md,
 * "Allocation rules".
 */
import { db, getSettings, type TimeTrackingDB } from '../../db/schema'
import type { Project, TimeEntry, UpworkTransaction } from '../../db/types'
import { ensureFxRates } from '../fx'
import { addDays } from '../period'
import { feePercentFor } from './import'

const round2 = (n: number) => Math.round(n * 100) / 100
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// ---------------------------------------------------------------- earnings and fees

/** An invoice (hourly week, fixed-price milestone, bonus) with the fee rows that belong to it. */
export interface Earning {
  tx: UpworkTransaction
  gross: number
  /** Fee charged on this invoice (positive), service fee plus VAT on it. */
  fee: number
  net: number
  /** Payouts that covered this earning, in FIFO order. */
  payouts: { payoutId: string; amount: number }[]
}

export interface FeeLink {
  earnings: Earning[]
  /** Fee rows (with their VAT) that match no invoice, e.g. the fee of a bonus that has no entry yet. */
  unallocatedFees: { tx: UpworkTransaction; amount: number }[]
}

const EARNING_TYPES = new Set(['hourly', 'fixed', 'bonus'])

/** Ids of earnings cancelled by a reversal row ("Reversed Bonus ref 288619456 - …") or flagged REVERSED. */
function reversedIds(txs: UpworkTransaction[]): Set<string> {
  const ids = new Set<string>()
  for (const t of txs) {
    if (t.reversed) ids.add(t.txId)
    const m = /Reversed .*?ref (\d+)/i.exec(t.description)
    if (m && t.amount < 0) {
      ids.add(m[1])
      ids.add(t.txId)
    }
  }
  return ids
}

/** Match every fee (and the VAT on it) to the invoice it was charged on: same contract and date, by fee base. */
export function linkFees(txs: UpworkTransaction[]): FeeLink {
  const reversed = reversedIds(txs)
  const byId = new Map(txs.map((t) => [t.txId, t]))
  const earnings: Earning[] = txs
    .filter((t) => EARNING_TYPES.has(t.type) && t.amount > 0 && !reversed.has(t.txId))
    .map((tx) => ({ tx, gross: tx.amount, fee: 0, net: tx.amount, payouts: [] }))

  const feeTotal = new Map<string, number>()
  for (const t of txs) if (t.type === 'fee' && !reversed.has(t.txId)) feeTotal.set(t.txId, -t.amount)
  // VAT on the service fee (2016–2018) comes as its own row, "Related invoice: <id>" naming the invoice it was
  // charged on (or, defensively, the fee row). VAT on membership is positive and not a cost of an invoice.
  const earningById = new Map(earnings.map((e) => [e.tx.txId, e]))
  const unallocatedFees: FeeLink['unallocatedFees'] = []
  for (const t of txs) {
    if (t.type !== 'vat' || t.amount >= 0) continue
    const m = /Related invoice:\s*(\d+)/.exec(t.description)
    const id = m?.[1]
    if (id && earningById.has(id)) earningById.get(id)!.fee += -t.amount
    else if (id && feeTotal.has(id)) feeTotal.set(id, feeTotal.get(id)! - t.amount)
    else if (!(id && reversed.has(id))) unallocatedFees.push({ tx: t, amount: -t.amount })
  }

  const byContractDate = new Map<string, Earning[]>()
  for (const e of earnings) {
    if (!e.tx.contractId) continue
    const key = `${e.tx.contractId}:${e.tx.date}`
    byContractDate.set(key, [...(byContractDate.get(key) ?? []), e])
  }
  const candidatesFor = (contractId: string, date: string): Earning[] => {
    for (const d of [date, addDays(date, -1), addDays(date, 1)]) {
      const list = byContractDate.get(`${contractId}:${d}`)
      if (list?.length) return list
    }
    return []
  }

  // Group fee rows per contract and date so that several fees on one day (hourly + bonus) can be matched by base.
  const feeGroups = new Map<string, UpworkTransaction[]>()
  // A refunded fee (positive row, e.g. when a bonus was reversed) goes through the same matching with a
  // negative amount, so it cancels the fee it refunds on the same invoice.
  for (const [id, amount] of feeTotal) {
    const t = byId.get(id)!
    if (!t.contractId || amount === 0) {
      if (amount !== 0) unallocatedFees.push({ tx: t, amount })
      continue
    }
    const key = `${t.contractId}:${t.date}`
    feeGroups.set(key, [...(feeGroups.get(key) ?? []), t])
  }
  for (const [key, fees] of feeGroups) {
    const [contractId, date] = key.split(':')
    const candidates = candidatesFor(contractId, date)
    if (!candidates.length) {
      for (const f of fees) unallocatedFees.push({ tx: f, amount: feeTotal.get(f.txId)! })
      continue
    }
    const taken = new Set<Earning>()
    const leftover: UpworkTransaction[] = []
    for (const f of fees) {
      const amount = feeTotal.get(f.txId)!
      const match = f.feeBase != null ? candidates.find((e) => !taken.has(e) && Math.abs(e.gross - f.feeBase!) < 0.02) : undefined
      if (match) {
        match.fee += amount
        taken.add(match)
      } else leftover.push(f)
    }
    if (!leftover.length) continue
    // Fees that match no single invoice by base: spread them over the untaken invoices in proportion to gross,
    // but never more than the fee percent they state (the remainder belongs to an invoice without an entry).
    const open = candidates.filter((e) => !taken.has(e))
    const pool = open.length ? open : candidates
    const poolGross = pool.reduce((s, e) => s + e.gross, 0)
    for (const f of leftover) {
      const amount = feeTotal.get(f.txId)!
      const base = f.feeBase ?? poolGross
      const share = base > 0 ? Math.min(1, poolGross / base) : 1
      const allocated = amount * share
      for (const e of pool) e.fee += poolGross > 0 ? (allocated * e.gross) / poolGross : 0
      if (Math.abs(amount - allocated) > 0.005) unallocatedFees.push({ tx: f, amount: round2(amount - allocated) })
    }
  }
  for (const e of earnings) {
    e.fee = round2(e.fee)
    e.net = round2(e.gross - e.fee)
  }
  earnings.sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.txId.localeCompare(b.tx.txId))
  return { earnings, unallocatedFees }
}

// ---------------------------------------------------------------- payouts

export interface Payout {
  tx: UpworkTransaction
  /** What left the balance for this payout: the withdrawal, its fee and any FX adjustment Upwork booked on it. */
  usd: number
  fee: number
  adjustments: number
  eurAmount?: number
  /** EUR received per USD of earnings consumed; undefined until the EUR amount is known. */
  rate?: number
  /** USD of earnings this payout was matched to (≤ usd; less when earnings were not yet booked). */
  covered: number
  /** First and last earning date covered. */
  from?: string
  to?: string
}

/** Pair each withdrawal with its same-day fee and referenced adjustments, oldest first. */
export function payoutsOf(txs: UpworkTransaction[]): Payout[] {
  const payouts: Payout[] = txs
    .filter((t) => t.type === 'withdrawal' && t.amount > 0 && !t.reversed)
    .sort((a, b) => a.date.localeCompare(b.date) || a.txId.localeCompare(b.txId))
    .map((tx) => ({ tx, usd: tx.amount, fee: 0, adjustments: 0, eurAmount: tx.eurAmount, covered: 0 }))
  const byDate = new Map<string, Payout[]>()
  for (const p of payouts) byDate.set(p.tx.date, [...(byDate.get(p.tx.date) ?? []), p])
  const byId = new Map(payouts.map((p) => [p.tx.txId, p]))
  for (const t of txs) {
    if (t.type === 'withdrawalFee' && t.amount < 0) {
      const same = byDate.get(t.date)
      if (same?.length) same[0].fee += -t.amount
    } else if (t.type === 'other' && t.amount < 0) {
      const m = /Payout Transaction ([\w-]+)/i.exec(t.description)
      const p = m && byId.get(m[1])
      if (p) p.adjustments += -t.amount
    }
  }
  for (const p of payouts) {
    p.usd = round2(p.tx.amount + p.fee + p.adjustments)
    if (p.eurAmount != null && p.usd > 0) p.rate = round6(p.eurAmount / p.usd)
  }
  return payouts
}

/** FIFO: each payout pays the oldest earnings booked on or before its date. Mutates earnings[].payouts. */
export function allocatePayouts(earnings: Earning[], payouts: Payout[]): void {
  let i = 0
  let left = earnings[0]?.net ?? 0
  for (const p of payouts) {
    let remaining = p.usd
    while (remaining > 0.005 && i < earnings.length && earnings[i].tx.date <= p.tx.date) {
      const take = Math.min(remaining, left)
      if (take > 0) {
        earnings[i].payouts.push({ payoutId: p.tx.txId, amount: round2(take) })
        p.covered = round2(p.covered + take)
        p.from ??= earnings[i].tx.date
        p.to = earnings[i].tx.date
      }
      remaining -= take
      left -= take
      if (left <= 0.005) {
        i++
        left = earnings[i]?.net ?? 0
      }
    }
  }
}

// ---------------------------------------------------------------- entries

export type RateEstimate = (date: string) => number | undefined

export interface SettlementPatch {
  feeAmount: number
  netAmount: number
  fxRate?: number
  netAmountEur?: number
  settlement: 'actual' | 'estimated'
  payoutId?: string
}

/** The hourly earning (weekly invoice) an entry belongs to: same contract, date inside the invoiced period. */
function earningFor(entry: TimeEntry, contractId: string, byContract: Map<string, Earning[]>): Earning | undefined {
  const list = byContract.get(contractId)
  if (!list) return undefined
  return list.find((e) => e.tx.type === 'hourly' && e.tx.periodFrom != null && e.tx.periodTo != null && e.tx.periodFrom <= entry.date && entry.date <= e.tx.periodTo)
}

/** Work out fee, net, rate and EUR for one entry from its invoice and the payouts that covered it. */
export function settleEntry(entry: TimeEntry, earning: Earning | undefined, payoutById: Map<string, Payout>, feePercent: number, estimate: RateEstimate): SettlementPatch {
  const gross = entry.amount
  if (!(gross > 0)) return { feeAmount: 0, netAmount: 0, fxRate: undefined, netAmountEur: 0, settlement: 'actual', payoutId: undefined }
  let fee: number
  let feeActual = false
  if (earning && earning.gross > 0) {
    fee = round2((earning.fee * gross) / earning.gross)
    feeActual = true
  } else fee = round2((gross * feePercent) / 100)
  const net = round2(gross - fee)

  let fxRate: number | undefined
  let payoutId: string | undefined
  let fxActual = false
  if (earning) {
    const covered = earning.payouts.reduce((s, p) => s + p.amount, 0)
    const rated = earning.payouts.map((p) => ({ ...p, rate: payoutById.get(p.payoutId)?.rate }))
    if (covered >= earning.net - 0.01 && rated.length && rated.every((p) => p.rate != null)) {
      fxRate = round6(rated.reduce((s, p) => s + p.rate! * p.amount, 0) / covered)
      payoutId = rated.reduce((a, b) => (b.amount > a.amount ? b : a)).payoutId
      fxActual = true
    }
  }
  if (!fxActual) fxRate = estimate(entry.date)
  return {
    feeAmount: fee,
    netAmount: net,
    fxRate,
    netAmountEur: fxRate != null ? round2(net * fxRate) : undefined,
    settlement: feeActual && fxActual ? 'actual' : 'estimated',
    payoutId,
  }
}

export interface Settlement {
  earnings: Earning[]
  payouts: Payout[]
  unallocatedFees: FeeLink['unallocatedFees']
  /** Net USD earned (per the ledger) that no payout has covered yet. */
  unpaidNet: number
  patches: Map<number, SettlementPatch>
}

export interface SettleInput {
  entries: TimeEntry[]
  transactions: UpworkTransaction[]
  projects: Project[]
  feeSchedule?: { from: string; percent: number }[]
  estimate: RateEstimate
}

/** Run the whole allocation and return what every Upwork entry should carry. */
export function settle({ entries, transactions, projects, feeSchedule, estimate }: SettleInput): Settlement {
  const { earnings, unallocatedFees } = linkFees(transactions)
  const payouts = payoutsOf(transactions)
  allocatePayouts(earnings, payouts)
  const payoutById = new Map(payouts.map((p) => [p.tx.txId, p]))
  const byContract = new Map<string, Earning[]>()
  for (const e of earnings) if (e.tx.contractId) byContract.set(e.tx.contractId, [...(byContract.get(e.tx.contractId) ?? []), e])
  const contractOfProject = new Map(projects.filter((p) => p.upwork?.contractId).map((p) => [p.id!, p.upwork!.contractId]))

  const patches = new Map<number, SettlementPatch>()
  for (const entry of entries) {
    const contractId = entry.projectId != null ? contractOfProject.get(entry.projectId) : undefined
    const earning = contractId ? earningFor(entry, contractId, byContract) : undefined
    patches.set(entry.id!, settleEntry(entry, earning, payoutById, feePercentFor(entry.date, feeSchedule), estimate))
  }
  const unpaidNet = round2(earnings.reduce((s, e) => s + e.net - e.payouts.reduce((c, p) => c + p.amount, 0), 0))
  return { earnings, payouts, unallocatedFees, unpaidNet, patches }
}

/** True when the cached columns already match the patch. */
export function sameSettlement(e: TimeEntry, p: SettlementPatch): boolean {
  const eq = (a: number | undefined, b: number | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9)
  return eq(e.feeAmount, p.feeAmount) && eq(e.netAmount, p.netAmount) && eq(e.fxRate, p.fxRate) && eq(e.netAmountEur, p.netAmountEur) && e.settlement === p.settlement && (e.payoutId ?? undefined) === p.payoutId
}

// ---------------------------------------------------------------- recalculation

export interface RecalculationReport {
  entries: number
  updated: number
  estimated: number
  unallocatedFees: number
  unpaidNet: number
  payoutsWithoutEur: number
}

/** Rate for a date from the cached ECB rates, else the nearest cached day before it, else the latest known payout rate. */
export function rateEstimator(cache: Record<string, number> | undefined, payouts: Payout[]): RateEstimate {
  const days = Object.keys(cache ?? {}).sort()
  const rated = payouts.filter((p) => p.rate != null)
  return (date) => {
    if (cache?.[date] != null) return cache[date]
    // Weekends and holidays: the last ECB fixing before the date, if it is close enough to mean something.
    let lo = 0
    let hi = days.length - 1
    let best: string | undefined
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (days[mid] <= date) {
        best = days[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    if (best && best >= addDays(date, -7)) return cache![best]
    const before = rated.filter((p) => p.tx.date <= date)
    const pick = before.at(-1) ?? rated[0]
    return pick?.rate
  }
}

/** Rewrite the cached settlement columns of every Upwork entry from the ledger. Returns what changed. */
export async function recalculateUpwork(database: TimeTrackingDB = db): Promise<RecalculationReport> {
  const settings = await getSettings(database)
  const [entries, transactions, projects] = await Promise.all([
    database.entries.where('source').equals('upwork').toArray(),
    database.upworkTransactions.toArray(),
    database.projects.toArray(),
  ])
  const payouts = payoutsOf(transactions)
  const estimate = rateEstimator(settings.upwork?.fxRates, payouts)
  const result = settle({ entries, transactions, projects, feeSchedule: settings.upwork?.feeSchedule, estimate })
  let estimated = 0
  const now = new Date().toISOString()
  const changed: TimeEntry[] = []
  for (const e of entries) {
    const patch = result.patches.get(e.id!)!
    if (patch.settlement === 'estimated') estimated++
    if (sameSettlement(e, patch)) continue
    // Spread so that fields the patch leaves undefined (fxRate, payoutId) are really cleared.
    changed.push({ ...e, ...patch, updatedAt: now })
  }
  if (changed.length) await database.entries.bulkPut(changed)
  return {
    entries: entries.length,
    updated: changed.length,
    estimated,
    unallocatedFees: round2(result.unallocatedFees.reduce((s, f) => s + f.amount, 0)),
    unpaidNet: result.unpaidNet,
    payoutsWithoutEur: result.payouts.filter((p) => p.eurAmount == null).length,
  }
}

/**
 * Fetch ECB rates for the days that are still estimated and, when new ones arrived, recalculate so the
 * estimates use the rate of the day. Network failures leave the fallback rate in place and are reported.
 * Callers run recalculateUpwork() first and show its result; this part may take a while or fail quietly.
 */
export async function refreshRatesAndRecalculate(database: TimeTrackingDB = db): Promise<{ ratesFetched: number; ratesCached: number; updated: number; rateError?: string }> {
  const estimated = await database.entries.where('source').equals('upwork').filter((e) => e.settlement === 'estimated' && e.amount > 0).toArray()
  const dates = [...new Set(estimated.map((e) => e.date))]
  if (!dates.length) return { ratesFetched: 0, ratesCached: 0, updated: 0 }
  const rates = await ensureFxRates(dates, database)
  const updated = rates.fetched > 0 ? (await recalculateUpwork(database)).updated : 0
  return { ratesFetched: rates.fetched, ratesCached: rates.cached, updated, rateError: rates.error }
}

/** Recalculate now, then refresh the ECB rates and recalculate again. */
export async function recalculateWithRates(database: TimeTrackingDB = db): Promise<RecalculationReport & { ratesFetched: number; ratesCached: number; rateError?: string }> {
  const report = await recalculateUpwork(database)
  const rates = await refreshRatesAndRecalculate(database)
  const after = rates.updated ? await recalculateUpwork(database) : report
  return { ...after, ratesFetched: rates.ratesFetched, ratesCached: rates.ratesCached, rateError: rates.rateError }
}

/** Record what the bank received for a payout; the settlement is recalculated by the caller. */
export async function setPayoutEur(txId: string, eurAmount: number | undefined, eurDate: string | undefined, database: TimeTrackingDB = db): Promise<void> {
  const tx = await database.upworkTransactions.where('txId').equals(txId).first()
  if (!tx) throw new Error(`Unknown payout ${txId}`)
  await database.upworkTransactions.update(tx.id!, { eurAmount, eurDate, updatedAt: new Date().toISOString() })
}
