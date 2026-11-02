/**
 * Upwork import: turns what the Upwork MCP server returns (contracts, daily time rows, the transaction
 * ledger) into clients, projects, entries and raw transactions. Idempotent: contracts are matched by id,
 * time rows by contract + day + memo (Upwork reports one row per memo and day), transactions by Upwork
 * record id. See docs/plans/upwork-integration.md.
 */
import { db, getSettings, type TimeTrackingDB } from '../../db/schema'
import { buildEntry } from '../../db/repo'
import type { Client, Project, TimeEntry, UpworkTransaction, UpworkTxType } from '../../db/types'
import { addDays } from '../period'
import { minutesToHm } from '../time'

// ---------------------------------------------------------------- import file (raw MCP shapes)

export interface UpworkContractRow {
  id: string
  title: string
  status?: string
  startDate?: string
  endDate?: string
  clientOrganization?: { id?: string; name?: string }
}

export interface UpworkTimeRow {
  /** Row cursor as the MCP server returns it: YYYYMMDD followed by a stable memo id. */
  cursor?: string
  contract: { id: string; title?: string }
  dateWorkedOn: string
  weekWorkedOn?: string
  totalHoursWorked: number
  totalCharges: number
  memo?: string
  termId?: string
}

export interface UpworkTxRow {
  recordId: string
  accountingSubtype?: string
  type?: string
  description?: string
  transactionAmount: { currency?: string; rawValue?: string | number; displayValue?: string }
  transactionCreationDate: string
  assignmentCompanyName?: string
  paymentStatus?: string
}

export interface UpworkImportFile {
  app: 'time-tracking-upwork'
  version: 1
  exportedAt?: string
  account?: { orgUid?: string; name?: string }
  contracts?: UpworkContractRow[]
  time?: UpworkTimeRow[]
  transactions?: UpworkTxRow[]
}

export function isUpworkImportFile(x: unknown): x is UpworkImportFile {
  return typeof x === 'object' && x !== null && (x as UpworkImportFile).app === 'time-tracking-upwork'
}

/**
 * Identity of a time row: contract, day and memo. The memo id is the tail of the row cursor (stable across
 * pulls for the same memo text); rows without a cursor fall back to the memo text itself.
 */
export function timeRowKey(t: UpworkTimeRow): string {
  const memoId = t.cursor && t.cursor.length > 8 ? t.cursor.slice(8) : t.memo?.trim() || '-'
  return `${t.contract.id}:${t.dateWorkedOn}:${memoId}`
}

/** Merge several pulls (e.g. one per year) into one file; later rows win on equal keys. */
export function mergeUpworkFiles(files: UpworkImportFile[]): UpworkImportFile {
  const contracts = new Map<string, UpworkContractRow>()
  const time = new Map<string, UpworkTimeRow>()
  const transactions = new Map<string, UpworkTxRow>()
  for (const f of files) {
    for (const c of f.contracts ?? []) contracts.set(c.id, c)
    for (const t of f.time ?? []) time.set(timeRowKey(t), t)
    for (const t of f.transactions ?? []) transactions.set(t.recordId, t)
  }
  return { app: 'time-tracking-upwork', version: 1, exportedAt: new Date().toISOString(), account: files[0]?.account, contracts: [...contracts.values()], time: [...time.values()], transactions: [...transactions.values()] }
}

// ---------------------------------------------------------------- transactions

const SUBTYPE_TO_TYPE: Record<string, UpworkTxType> = {
  hourly: 'hourly',
  'fixed price': 'fixed',
  'fixed-price': 'fixed',
  milestone: 'fixed',
  bonus: 'bonus',
  'service fee': 'fee',
  'vat for service fee': 'vat',
  vat: 'vat',
  withdrawal: 'withdrawal',
  'withdrawal fee': 'withdrawalFee',
  refund: 'refund',
  'membership fee': 'membership',
  // One-off client payments outside the hourly/fixed invoices: reimbursed expenses, "Miscellaneous Payment".
  expense: 'bonus',
  miscellaneous: 'bonus',
}

export function classifyTransaction(subtype: string | undefined): UpworkTxType {
  const key = (subtype ?? '').trim().toLowerCase()
  if (SUBTYPE_TO_TYPE[key]) return SUBTYPE_TO_TYPE[key]
  if (key.includes('fee')) return 'fee'
  if (key.includes('refund')) return 'refund'
  return 'other'
}

const money = (s: string) => Number(s.replace(/,/g, ''))
const round2 = (n: number) => Math.round(n * 100) / 100
const usDate = (m: string, d: string, y: string) => `${y}-${m}-${d}`

/** Parse the facts hidden in Upwork's free-text descriptions. */
export function parseTransaction(row: UpworkTxRow): UpworkTransaction {
  const type = classifyTransaction(row.accountingSubtype)
  const description = row.description ?? ''
  const amount = Number(row.transactionAmount.rawValue ?? row.transactionAmount.displayValue ?? 0)
  const t: UpworkTransaction = {
    txId: String(row.recordId),
    date: row.transactionCreationDate.slice(0, 10),
    type,
    subtype: row.accountingSubtype ?? '',
    description,
    amount: Math.round(amount * 100) / 100,
    currency: row.transactionAmount.currency ?? 'USD',
    clientName: row.assignmentCompanyName || undefined,
    reversed: row.paymentStatus === 'REVERSED' ? true : undefined,
  }
  // "(36599829) Client - 37:10 hrs @ $80.00/hr - 10/12/2026 - 10/18/2026"
  const hourly = /^\((\d+)\)\s*(.*?)\s*-\s*(\d+):(\d{2}) hrs @ \$([\d.,]+)\/hr\s*-\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(description)
  if (hourly) {
    t.contractId = hourly[1]
    t.clientName ??= hourly[2] || undefined
    t.hours = Number(hourly[3]) + Number(hourly[4]) / 60
    t.rate = money(hourly[5])
    t.periodFrom = usDate(hourly[6], hourly[7], hourly[8])
    t.periodTo = usDate(hourly[9], hourly[10], hourly[11])
  } else {
    const leading = /^\((\d+)\)/.exec(description)
    if (leading) t.contractId = leading[1]
  }
  const term = /Contract ID:\s*(\d+)/i.exec(description)
  if (term) t.termId = term[1]
  // "$3146.67 USD x 10% = $314.67 USD"; a blended fee lists one such line per tier, the base is their sum.
  const tiers = [...description.matchAll(/\$([\d.,]+)\s*USD\s*x\s*([\d.]+)%\s*=/g)]
  if (tiers.length) {
    t.feeBase = round2(tiers.reduce((s, m) => s + money(m[1]), 0))
    t.feePercent = tiers.length === 1 ? Number(tiers[0][2]) : t.feeBase > 0 ? round2((Math.abs(amount) / t.feeBase) * 100) : undefined
  }
  const client = /Client:\s*(.+)/.exec(description)
  if (client && !t.clientName) t.clientName = client[1].trim()
  return t
}

/**
 * Tie a transaction to its contract. Hourly invoices name the contract or, after a rate change, the term;
 * fee rows name the term (which for fixed-price contracts is the contract id itself); fixed-price invoices
 * only carry the contract title, so they are matched by title, then client name and contract dates when
 * several contracts share a title. Rows that stay unresolved keep contractId undefined.
 */
export function resolveContract(t: UpworkTransaction, contracts: Map<string, UpworkContractRow>, termToContract: Map<string, string>): void {
  if (t.contractId && contracts.has(t.contractId)) return
  if (t.contractId && termToContract.has(t.contractId)) {
    t.termId ??= t.contractId
    t.contractId = termToContract.get(t.contractId)
    return
  }
  if (t.termId && termToContract.has(t.termId)) {
    t.contractId = termToContract.get(t.termId)
    return
  }
  if (t.termId && contracts.has(t.termId)) {
    t.contractId = t.termId
    return
  }
  if (t.type !== 'hourly' && t.type !== 'fixed' && t.type !== 'bonus') return
  // "Reversed Bonus ref 288619456 - (23791962) Client - Bonus"
  const anywhere = /\((\d{6,})\)/.exec(t.description)
  if (anywhere && contracts.has(anywhere[1])) {
    t.contractId = anywhere[1]
    return
  }
  // "Invoice for <contract title>: Milestone 1 - <milestone>"
  const titled = /^Invoice for (.+?): Milestone/.exec(t.description) ?? /^Invoice for (.+)$/.exec(t.description)
  if (!titled) return
  const title = titled[1].trim().toLowerCase()
  let candidates = [...contracts.values()].filter((c) => c.title.trim().toLowerCase() === title)
  if (candidates.length > 1 && t.clientName) {
    const byClient = candidates.filter((c) => c.clientOrganization?.name?.trim().toLowerCase() === t.clientName!.trim().toLowerCase())
    if (byClient.length) candidates = byClient
  }
  if (candidates.length > 1) {
    const inRange = candidates.filter((c) => (!c.startDate || c.startDate.slice(0, 10) <= t.date) && (!c.endDate || t.date <= addDays(c.endDate.slice(0, 10), 14)))
    if (inRange.length) candidates = inRange
  }
  if (candidates.length === 1) t.contractId = String(candidates[0].id)
}

// ---------------------------------------------------------------- fee estimate

export const DEFAULT_FEE_PERCENT = 10

export function feePercentFor(date: string, schedule?: { from: string; percent: number }[]): number {
  let percent = DEFAULT_FEE_PERCENT
  for (const p of [...(schedule ?? [])].sort((a, b) => a.from.localeCompare(b.from))) if (p.from <= date) percent = p.percent
  return percent
}

// ---------------------------------------------------------------- import

export interface UpworkImportReport {
  clients: { created: number; matched: number }
  projects: { created: number; matched: number }
  /** removed: entries for a contract and day the file covers that Upwork no longer reports (memo edited, time deleted). */
  entries: { added: number; updated: number; unchanged: number; removed: number }
  transactions: { added: number; updated: number; unchanged: number }
  warnings: string[]
}

/** Display name for an Upwork client organisation; anonymous ones get the id so they stay distinct. */
export function upworkClientName(org: { id?: string; name?: string } | undefined, contractId: string): string {
  const name = org?.name?.trim()
  if (name && !/^(deleted|private)$/i.test(name)) return name
  return org?.id ? `Upwork client ${String(org.id).slice(-6)}` : `Upwork contract ${contractId}`
}

export async function importUpwork(file: UpworkImportFile, database: TimeTrackingDB = db): Promise<UpworkImportReport> {
  const report: UpworkImportReport = {
    clients: { created: 0, matched: 0 },
    projects: { created: 0, matched: 0 },
    entries: { added: 0, updated: 0, unchanged: 0, removed: 0 },
    transactions: { added: 0, updated: 0, unchanged: 0 },
    warnings: [],
  }
  const settings = await getSettings(database)
  const schedule = settings.upwork?.feeSchedule
  const contracts = new Map((file.contracts ?? []).map((c) => [String(c.id), c]))
  // Contracts seen only in time rows still need a project.
  for (const t of file.time ?? []) {
    const id = String(t.contract.id)
    if (!contracts.has(id)) contracts.set(id, { id, title: t.contract.title ?? `Upwork contract ${id}` })
  }
  const termToContract = new Map<string, string>()
  for (const t of file.time ?? []) if (t.termId) termToContract.set(String(t.termId), String(t.contract.id))

  // Which contracts are fixed-price: those with fixed-price transactions and no hourly ones.
  const parsedTx = (file.transactions ?? []).map(parseTransaction)
  const fixedContracts = new Set(parsedTx.filter((t) => t.type === 'fixed' && t.contractId).map((t) => t.contractId!))
  for (const t of parsedTx) if (t.type === 'hourly' && t.contractId) fixedContracts.delete(t.contractId)
  for (const t of parsedTx) resolveContract(t, contracts, termToContract)

  await database.transaction('rw', [database.clients, database.projects, database.entries, database.upworkTransactions, database.settings, database.tombstones], async () => {
    const clients = await database.clients.toArray()
    const projects = await database.projects.toArray()
    const clientByUpworkId = new Map(clients.filter((c) => c.upworkClientId).map((c) => [c.upworkClientId!, c]))
    const clientByName = new Map(clients.map((c) => [c.name.toLowerCase(), c]))
    const projectByContract = new Map(projects.filter((p) => p.upwork?.contractId).map((p) => [p.upwork!.contractId, p]))

    const ensureClient = async (org: UpworkContractRow['clientOrganization'], contractId: string): Promise<Client> => {
      const orgId = org?.id ? String(org.id) : undefined
      const name = upworkClientName(org, contractId)
      let client = (orgId && clientByUpworkId.get(orgId)) || clientByName.get(name.toLowerCase())
      if (client) {
        if (orgId && !client.upworkClientId) {
          client = { ...client, platform: 'upwork', upworkClientId: orgId }
          await database.clients.put(client)
          clientByUpworkId.set(orgId, client)
        }
        report.clients.matched++
        return client
      }
      client = { name, defaultRate: 0, currency: 'USD', platform: 'upwork', upworkClientId: orgId }
      client.id = (await database.clients.add(client)) as number
      clientByName.set(name.toLowerCase(), client)
      if (orgId) clientByUpworkId.set(orgId, client)
      report.clients.created++
      return client
    }

    const projectForContract = new Map<string, Project>()
    for (const c of contracts.values()) {
      const id = String(c.id)
      let project = projectByContract.get(id)
      if (project) {
        report.projects.matched++
      } else {
        const client = await ensureClient(c.clientOrganization, id)
        project = { clientId: client.id!, name: c.title || `Upwork contract ${id}`, upwork: { contractId: id, type: fixedContracts.has(id) ? 'fixed' : 'hourly' } }
        project.id = (await database.projects.add(project)) as number
        projectByContract.set(id, project)
        report.projects.created++
      }
      projectForContract.set(id, project)
    }

    // Time rows → entries, one per contract, day and memo.
    const existingByExternal = new Map<string, TimeEntry>()
    for (const e of await database.entries.where('source').equals('upwork').toArray()) if (e.externalId) existingByExternal.set(e.externalId, e)
    const seen = new Set<string>()
    const daysInFile = new Set<string>()
    for (const t of file.time ?? []) {
      const contractId = String(t.contract.id)
      const project = projectForContract.get(contractId)!
      const externalId = `upwork:${timeRowKey(t)}`
      seen.add(externalId)
      daysInFile.add(`${contractId}:${t.dateWorkedOn}`)
      const durationMin = Math.round(t.totalHoursWorked * 60)
      if (durationMin <= 0) continue
      const amount = round2(t.totalCharges)
      // Unpaid hours (charges 0) are kept for the record but never count as money.
      const billable = amount > 0
      const hourlyRate = billable ? round2(t.totalCharges / t.totalHoursWorked) : 0
      const week = t.weekWorkedOn ?? t.dateWorkedOn
      const existing = existingByExternal.get(externalId)
      const feePercent = feePercentFor(t.dateWorkedOn, schedule)
      const input = {
        date: t.dateWorkedOn,
        startTime: '00:00',
        endTime: minutesToHm(durationMin % 1440),
        durationMin,
        amount,
        clientId: project.clientId,
        projectId: project.id,
        hourlyRate,
        comments: t.memo?.trim() ?? '',
        isBilled: true,
        invoiceDate: addDays(week, 6),
        invoiceRef: `Upwork week ${week}`,
        billable: billable ? undefined : false,
        source: 'upwork' as const,
        externalId,
        timeless: true,
        currency: 'USD',
        normalize: false,
      }
      if (existing) {
        const same = existing.durationMin === durationMin && existing.amount === amount && existing.comments === input.comments && existing.projectId === project.id && (existing.billable === false) === !billable
        if (same) {
          report.entries.unchanged++
          continue
        }
        await database.entries.put({ ...buildEntry(input, existing), id: existing.id })
        report.entries.updated++
      } else {
        const estimatedFee = round2((amount * feePercent) / 100)
        await database.entries.add(buildEntry({ ...input, feeAmount: estimatedFee, netAmount: round2(amount - estimatedFee), settlement: 'estimated' }))
        report.entries.added++
      }
    }
    // A day the file covers is complete: rows Upwork no longer reports for it are gone (memo edited, time removed).
    for (const e of existingByExternal.values()) {
      const key = e.externalId!.split(':')
      if (seen.has(e.externalId!) || key.length < 4 || !daysInFile.has(`${key[1]}:${key[2]}`)) continue
      await database.deleteSynced('entries', e.id!)
      report.entries.removed++
    }

    // Transactions, raw.
    const existingTx = new Map((await database.upworkTransactions.toArray()).map((t) => [t.txId, t]))
    for (const t of parsedTx) {
      const existing = existingTx.get(t.txId)
      if (!existing) {
        await database.upworkTransactions.add(t)
        report.transactions.added++
      } else if (existing.amount !== t.amount || existing.description !== t.description || existing.type !== t.type || (!existing.contractId && t.contractId) || Boolean(existing.reversed) !== Boolean(t.reversed)) {
        await database.upworkTransactions.put({ ...existing, ...t, eurAmount: existing.eurAmount, eurDate: existing.eurDate, id: existing.id })
        report.transactions.updated++
      } else report.transactions.unchanged++
    }
  })
  return report
}
