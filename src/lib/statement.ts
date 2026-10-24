/**
 * Customer summary ("statement"): one client, one period, every entry plus totals.
 * Pure data, built from plain arrays; rendered to Excel (excel/exportStatement.ts)
 * or PDF (pdf/statementPdf.ts).
 */
import type { Client, Project, TimeEntry } from '../db/types'
import { billedMinutes, isBillable } from '../db/repo'
import { rangeLabel } from './period'
import { todayIso } from './time'

export type StatementFilter = 'all' | 'unbilled' | 'billed'

export interface StatementRow {
  date: string
  startTime: string
  endTime: string
  /** Minutes on the billing basis (billedMin when present, else the real minutes). */
  minutes: number
  actualMin: number
  project: string
  category?: string
  comments: string
  rate: number
  amount: number
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
  /** ISO date the document was produced. */
  generatedAt: string
  rows: StatementRow[]
  /** Billable entries only. */
  count: number
  minutes: number
  actualMin: number
  amount: number
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
  generatedAt?: string
}

export const FILTER_LABELS: Record<StatementFilter, string> = { all: 'All entries', unbilled: 'Not yet billed', billed: 'Billed' }

export function buildStatement({ client, entries, projects, from, to, filter = 'all', generatedAt = todayIso() }: StatementInput): Statement {
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
      minutes: billedMinutes(e),
      actualMin: e.durationMin,
      project: e.projectId == null ? '' : (projectName.get(e.projectId) ?? ''),
      category: e.category,
      comments: e.comments,
      rate: e.hourlyRate,
      amount: billable ? e.amount : 0,
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
    generatedAt,
    rows,
    count: 0,
    minutes: 0,
    actualMin: 0,
    amount: 0,
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
    const g = groups.get(r.project) ?? { name: r.project || '(no project)', count: 0, minutes: 0, amount: 0 }
    g.count++
    g.minutes += r.minutes
    g.amount += r.amount
    groups.set(r.project, g)
  }
  st.amount = Math.round(st.amount * 100) / 100
  st.byProject = [...groups.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
  return st
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
