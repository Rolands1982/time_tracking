/**
 * Other income: rent, investment returns, sales, benefits and the rest, so a period's total income (billed work net
 * in EUR plus this) can be read off one screen. The personal finances app sends its income records (with their real
 * dates and categories, keyed `pf:<record Id>`); rows can also be added by hand.
 *
 * The owner's own categorisation lives on the rows: `type` (the owner's category, e.g. from the review workbook),
 * `amountOverride` (the amount to count instead of the one booked) and `excluded` (left out of the totals). The
 * finance app never sends those three, so they survive its daily sync; everything else on its rows is its own.
 */
import { db, type TimeTrackingDB } from './schema'
import type { IncomeCategory, OtherIncome } from './types'
import { weekRange } from '../lib/period'
import { todayIso } from '../lib/time'

/** Labels of the finance app's kinds, the last fallback when a row has no type and none can be learned. */
export const INCOME_CATEGORIES: Record<IncomeCategory, string> = {
  rent: 'Rent',
  investment: 'Investments',
  sale: 'Sales of goods',
  benefit: 'Social benefits',
  other: 'Other',
}

export const INCOME_CATEGORY_KEYS = Object.keys(INCOME_CATEGORIES) as IncomeCategory[]

export interface OtherIncomeInput {
  date: string
  /** The owner's category. */
  type?: string
  amount: number
  currency?: string
  source?: string
  notes?: string
  importKey?: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

function build(input: OtherIncomeInput, existing?: OtherIncome): OtherIncome {
  const now = new Date().toISOString()
  return {
    ...existing,
    date: input.date,
    category: existing?.category ?? 'other',
    type: input.type?.trim() || undefined,
    amount: round2(input.amount),
    currency: input.currency || existing?.currency || 'EUR',
    source: input.source?.trim() || undefined,
    notes: input.notes?.trim() ?? existing?.notes ?? '',
    importKey: input.importKey ?? existing?.importKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function addOtherIncome(input: OtherIncomeInput, database: TimeTrackingDB = db): Promise<number> {
  if (!input.date) throw new Error('Date is required')
  return (await database.otherIncome.add(build(input))) as number
}

/** Edit a row added by hand (all of it). */
export async function updateOtherIncome(id: number, input: OtherIncomeInput, database: TimeTrackingDB = db): Promise<void> {
  const existing = await database.otherIncome.get(id)
  if (!existing) throw new Error('Income row not found')
  await database.otherIncome.put({ ...build(input, existing), id })
}

export interface IncomeAdjustment {
  /** The owner's category; empty clears it (the learned one applies again). */
  type?: string
  /** The amount to count instead of the booked one; undefined clears it. */
  amountOverride?: number
  excluded?: boolean
}

/** The owner's adjustment of any row, also one from the finance app: only type, counted amount and exclusion change. */
export async function adjustOtherIncome(id: number, adj: IncomeAdjustment, database: TimeTrackingDB = db): Promise<void> {
  const existing = await database.otherIncome.get(id)
  if (!existing) throw new Error('Income row not found')
  const amountOverride = adj.amountOverride == null || !Number.isFinite(adj.amountOverride) ? undefined : round2(adj.amountOverride)
  await database.otherIncome.put({
    ...existing,
    type: adj.type?.trim() || undefined,
    amountOverride: amountOverride === round2(existing.amount) ? undefined : amountOverride,
    excluded: adj.excluded ? true : undefined,
    updatedAt: new Date().toISOString(),
  })
}

export async function deleteOtherIncome(id: number, database: TimeTrackingDB = db): Promise<void> {
  await database.deleteSynced('otherIncome', id)
}

/** The Sunday of the week containing today: the default date for a row added by hand. */
export function defaultIncomeDate(today = todayIso()): string {
  return weekRange(today).to
}

/** Rows the personal finances app sent: date, booked amount, party and description are its own and not edited here. */
export function isFromFinanceApp(row: Pick<OtherIncome, 'importKey'>): boolean {
  return Boolean(row.importKey?.startsWith('pf:'))
}

/** What the row counts for: the adjusted amount when the owner set one, else the booked amount. */
export function countedAmount(row: Pick<OtherIncome, 'amount' | 'amountOverride'>): number {
  return row.amountOverride ?? row.amount
}

/**
 * The type of every row: the owner's own when set; else the type the owner gave most often to rows of the same
 * finance-app category and kind, excluded rows not counting (so a new rent payment arriving from the daily sync files
 * itself like the earlier ones); else the finance app's category name; else the kind's label.
 */
export function typeResolver(all: OtherIncome[]): (row: OtherIncome) => string {
  const counts = new Map<string, Map<string, number>>()
  const tally = (key: string, type: string) => {
    const m = counts.get(key) ?? new Map<string, number>()
    m.set(type, (m.get(type) ?? 0) + 1)
    counts.set(key, m)
  }
  for (const r of all) {
    // Excluded rows (an insurance payout, a refund) say nothing about how new income of that kind should be filed.
    if (!r.type || !r.sourceCategory || r.excluded) continue
    tally(`${r.sourceCategory}|${r.category}`, r.type)
    tally(r.sourceCategory, r.type)
  }
  const best = (key: string) => {
    const m = counts.get(key)
    if (!m) return undefined
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  }
  return (row) =>
    row.type ??
    (row.sourceCategory ? (best(`${row.sourceCategory}|${row.category}`) ?? best(row.sourceCategory)) : undefined) ??
    row.sourceCategory ??
    INCOME_CATEGORIES[row.category] ??
    'Other'
}

/** Every type in use, for the suggestions when typing one. */
export function knownTypes(all: OtherIncome[], typeOf = typeResolver(all)): string[] {
  return [...new Set(all.map(typeOf))].sort((a, b) => a.localeCompare(b))
}

export async function queryOtherIncome(range: { from?: string; to?: string }, database: TimeTrackingDB = db): Promise<OtherIncome[]> {
  const rows =
    range.from || range.to
      ? await database.otherIncome.where('date').between(range.from ?? '0000', range.to ?? '9999', true, true).toArray()
      : await database.otherIncome.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
}

export interface IncomeTotals {
  /** Rows that count (excluded ones are not in here). */
  count: number
  total: number
  /** Per type, largest first. */
  byType: { type: string; amount: number; count: number }[]
  excluded: number
}

export function incomeTotals(rows: OtherIncome[], typeOf: (row: OtherIncome) => string = typeResolver(rows)): IncomeTotals {
  const by = new Map<string, { amount: number; count: number }>()
  let total = 0
  let count = 0
  let excluded = 0
  for (const r of rows) {
    if (r.excluded) {
      excluded++
      continue
    }
    const amount = countedAmount(r)
    const t = typeOf(r)
    const b = by.get(t) ?? { amount: 0, count: 0 }
    b.amount += amount
    b.count++
    by.set(t, b)
    total += amount
    count++
  }
  const byType = [...by.entries()]
    .map(([type, b]) => ({ type, amount: round2(b.amount), count: b.count }))
    .filter((b) => b.amount !== 0 || b.count > 0)
    .sort((a, b) => b.amount - a.amount || a.type.localeCompare(b.type))
  return { count, total: round2(total), byType, excluded }
}
