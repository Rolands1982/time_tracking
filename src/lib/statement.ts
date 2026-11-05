/**
 * Customer summary ("statement"): one client, one period, every entry plus totals.
 * Pure data, built from plain arrays; rendered to Excel (excel/exportStatement.ts)
 * or PDF (pdf/statementPdf.ts).
 */
import type { Client, Project, TimeEntry } from '../db/types'
import { billedMinutes, isBillable, netEurOf, netOf } from '../db/repo'
import { rangeLabel } from './period'
import { todayIso } from './time'

export type StatementFilter = 'all' | 'unbilled' | 'billed'

export type StatementColumn = 'date' | 'time' | 'project' | 'category' | 'description' | 'hours' | 'rate' | 'amount' | 'net' | 'netEur' | 'invoice'

/** Every column a summary can show, in document order. */
export const STATEMENT_COLUMNS: { key: StatementColumn; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'time', label: 'Time' },
  { key: 'project', label: 'Project' },
  { key: 'category', label: 'Category' },
  { key: 'description', label: 'Description' },
  { key: 'hours', label: 'Hours' },
  { key: 'rate', label: 'Rate' },
  { key: 'amount', label: 'Amount' },
  { key: 'net', label: 'Net' },
  { key: 'netEur', label: 'Net EUR' },
  { key: 'invoice', label: 'Invoice' },
]

export const DEFAULT_COLUMNS: StatementColumn[] = ['date', 'time', 'project', 'description', 'hours', 'rate', 'amount', 'invoice']
/** Platform clients (Upwork): the work is billed gross, the fee comes off, and the bank receives EUR. No times: the rows are daily. */
export const PLATFORM_DEFAULT_COLUMNS: StatementColumn[] = ['date', 'project', 'description', 'hours', 'rate', 'amount', 'net', 'netEur', 'invoice']

/** Keep only known keys, in document order; falls back to the default set when nothing is left. */
export function normalizeColumns(keys: readonly string[] | undefined, fallback: readonly StatementColumn[] = DEFAULT_COLUMNS): StatementColumn[] {
  const wanted = new Set(keys ?? fallback)
  const cols = STATEMENT_COLUMNS.map((c) => c.key).filter((k) => wanted.has(k))
  return cols.length ? cols : [...fallback]
}

export interface StatementRow {
  date: string
  startTime: string
  endTime: string
  /** Platform rows report a duration only; the times are a convention and are not shown. */
  timeless?: boolean
  /** Minutes on the billing basis (billedMin when present, else the real minutes). */
  minutes: number
  actualMin: number
  project: string
  category?: string
  comments: string
  rate: number
  amount: number
  /** After the platform fee (equal to amount for direct work), and in EUR when a rate is known. */
  netAmount: number
  netAmountEur?: number
  billable: boolean
  isBilled: boolean
  invoiceDate?: string
  invoiceRef?: string
}

export interface StatementGroup {
  name: string
  count: number
  minutes: number
  amount: number
  netAmount: number
  netAmountEur: number
}

export interface Statement {
  clientName: string
  clientEmail?: string
  clientNotes?: string
  currency: string
  from?: string
  to?: string
  periodLabel: string
  filter: StatementFilter
  columns: StatementColumn[]
  /** ISO date the document was produced. */
  generatedAt: string
  rows: StatementRow[]
  /** Billable entries only. */
  count: number
  minutes: number
  actualMin: number
  amount: number
  netAmount: number
  netAmountEur: number
  /** Billable rows whose EUR value is unknown (no rate yet). */
  eurMissing: number
  /** Work listed but never invoiced (billable === false). */
  nonBillableCount: number
  nonBillableMin: number
  byProject: StatementGroup[]
}

export interface StatementInput {
  client: Client
  entries: TimeEntry[]
  projects: Project[]
  from?: string
  to?: string
  filter?: StatementFilter
  columns?: readonly string[]
  generatedAt?: string
}

export const FILTER_LABELS: Record<StatementFilter, string> = { all: 'All entries', unbilled: 'Not yet billed', billed: 'Billed' }

export function buildStatement({ client, entries, projects, from, to, filter = 'all', columns, generatedAt = todayIso() }: StatementInput): Statement {
  const projectName = new Map(projects.map((p) => [p.id!, p.name]))
  const selected = entries
    .filter((e) => e.clientId === client.id)
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .filter((e) => (filter === 'all' ? true : filter === 'billed' ? e.isBilled : !e.isBilled && isBillable(e)))
    .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)))

  const rows: StatementRow[] = selected.map((e) => {
    const billable = isBillable(e)
    return {
      date: e.date,
      startTime: e.startTime,
      endTime: e.endTime,
      timeless: e.timeless || undefined,
      minutes: billedMinutes(e),
      actualMin: e.durationMin,
      project: e.projectId == null ? '' : (projectName.get(e.projectId) ?? ''),
      category: e.category,
      comments: e.comments,
      rate: e.hourlyRate,
      amount: billable ? e.amount : 0,
      netAmount: billable ? netOf(e) : 0,
      netAmountEur: billable ? netEurOf(e) : 0,
      billable,
      isBilled: e.isBilled,
      invoiceDate: e.invoiceDate,
      invoiceRef: e.invoiceRef,
    }
  })

  const st: Statement = {
    clientName: client.name,
    clientEmail: client.email,
    clientNotes: client.notes,
    currency: client.currency || 'EUR',
    from,
    to,
    periodLabel: rangeLabel({ from, to }),
    filter,
    columns: normalizeColumns(columns),
    generatedAt,
    rows,
    count: 0,
    minutes: 0,
    actualMin: 0,
    amount: 0,
    netAmount: 0,
    netAmountEur: 0,
    eurMissing: 0,
    nonBillableCount: 0,
    nonBillableMin: 0,
    byProject: [],
  }
  const groups = new Map<string, StatementGroup>()
  for (const r of rows) {
    if (!r.billable) {
      st.nonBillableCount++
      st.nonBillableMin += r.minutes
      continue
    }
    st.count++
    st.minutes += r.minutes
    st.actualMin += r.actualMin
    st.amount += r.amount
    st.netAmount += r.netAmount
    if (r.netAmountEur != null) st.netAmountEur += r.netAmountEur
    else st.eurMissing++
    const g = groups.get(r.project) ?? { name: r.project || '(no project)', count: 0, minutes: 0, amount: 0, netAmount: 0, netAmountEur: 0 }
    g.count++
    g.minutes += r.minutes
    g.amount += r.amount
    g.netAmount += r.netAmount
    g.netAmountEur += r.netAmountEur ?? 0
    groups.set(r.project, g)
  }
  const round2 = (n: number) => Math.round(n * 100) / 100
  st.amount = round2(st.amount)
  st.netAmount = round2(st.netAmount)
  st.netAmountEur = round2(st.netAmountEur)
  for (const g of groups.values()) {
    g.amount = round2(g.amount)
    g.netAmount = round2(g.netAmount)
    g.netAmountEur = round2(g.netAmountEur)
  }
  st.byProject = [...groups.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
  return st
}

/** Description cell: the category is folded into it unless it has a column of its own. */
export function describe(r: StatementRow, columns: readonly StatementColumn[]): string {
  return columns.includes('category') ? r.comments : [r.category, r.comments].filter(Boolean).join(': ')
}

/** Time cell: the clock span, or empty for rows that only report a duration. */
export function timeText(r: Pick<StatementRow, 'startTime' | 'endTime' | 'timeless'>): string {
  return r.timeless ? '' : `${r.startTime}–${r.endTime}`
}

/** Invoice cell: reference, else invoice date, else status. */
export function invoiceText(r: StatementRow, formatDate: (iso: string) => string): string {
  if (!r.billable) return 'non-billable'
  if (!r.isBilled) return 'open'
  return r.invoiceRef ?? (r.invoiceDate ? formatDate(r.invoiceDate) : 'billed')
}

export function hours(min: number): number {
  return Math.round((min / 60) * 100) / 100
}

/** "Summary_Acme_2026-03-01_2026-03-31.pdf" */
export function statementFileName(st: Statement, ext: 'xlsx' | 'pdf'): string {
  const safe = (s: string) => s.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_|_$/g, '')
  const period = !st.from && !st.to ? 'all' : `${st.from ?? 'start'}_${st.to ?? st.generatedAt}`
  return `Summary_${safe(st.clientName)}_${period}.${ext}`
}
