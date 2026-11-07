/**
 * Monthly hours report (for the tax authority and one's own records): the month's hours per client and per
 * day, with the net in EUR. Pure data built from plain arrays; rendered on screen (pages/MonthlyReportPage),
 * to Excel (excel/exportMonthly.ts) and to PDF (pdf/monthlyPdf.ts), so every form agrees.
 */
import type { Client, TimeEntry } from '../db/types'
import { billedMinutes, isBillable, isPlatformClient, netEurOf, totals } from '../db/repo'
import { monthLabel, monthRange, todayIso } from './time'

export interface MonthlyClientRow {
  clientId: number
  name: string
  businessName?: string
  /** Hours come from a platform (Upwork). */
  platform: boolean
  entries: number
  /** Minutes on the billing basis, and the real minutes where they differ. */
  minutes: number
  actualMin: number
  /** `minutes` rounded to whole hours (half an hour rounds up). */
  wholeHours: number
  nonBillableMin: number
  /** Entries whose hours the user estimated (fixed-price milestones). */
  estimatedHours: number
  /** Gross in the client's currency and net in EUR; rows without a rate are counted, not summed. */
  gross: number
  currency: string
  netEur: number
  eurMissing: number
  /** Platform rows whose fee or rate is still an estimate. */
  estimated: number
}

export interface MonthlyDayRow {
  date: string
  minutes: number
  wholeHours: number
  clients: string[]
}

export interface MonthlyReport {
  /** YYYY-MM */
  month: string
  label: string
  generatedAt: string
  includeNonBillable: boolean
  rows: MonthlyClientRow[]
  days: MonthlyDayRow[]
  totals: {
    entries: number
    minutes: number
    actualMin: number
    /** Sum of the clients' whole hours, so the rounded column adds up (it may differ from the total rounded once). */
    wholeHours: number
    nonBillableMin: number
    estimatedHours: number
    netEur: number
    eurMissing: number
    estimated: number
    daysWorked: number
  }
}

export interface MonthlyReportInput {
  month: string
  entries: TimeEntry[]
  clients: Client[]
  /** Count non-billable work in the hours (never in the money). Default on: the hours were worked. */
  includeNonBillable?: boolean
  generatedAt?: string
}

export function buildMonthlyReport({ month, entries, clients, includeNonBillable = true, generatedAt = todayIso() }: MonthlyReportInput): MonthlyReport {
  const { from, to } = monthRange(`${month}-01`)
  const clientById = new Map(clients.map((c) => [c.id!, c]))
  const selected = entries.filter((e) => e.date >= from && e.date <= to).filter((e) => includeNonBillable || isBillable(e))

  const byClient = new Map<number, TimeEntry[]>()
  for (const e of selected) byClient.set(e.clientId, [...(byClient.get(e.clientId) ?? []), e])
  const rows: MonthlyClientRow[] = [...byClient.entries()]
    .map(([clientId, list]) => {
      const c = clientById.get(clientId)
      const t = totals(list)
      return {
        clientId,
        name: c?.name ?? `Client ${clientId}`,
        businessName: c?.businessName,
        platform: isPlatformClient(c),
        entries: t.count,
        minutes: t.billedMin,
        actualMin: t.durationMin,
        wholeHours: wholeHoursOf(t.billedMin),
        nonBillableMin: t.nonBillableMin,
        estimatedHours: t.estimatedHours,
        gross: Math.round(t.amount * 100) / 100,
        currency: c?.currency || 'EUR',
        netEur: Math.round(t.netAmountEur * 100) / 100,
        eurMissing: t.eurMissing,
        estimated: t.estimated,
      }
    })
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))

  const byDay = new Map<string, TimeEntry[]>()
  for (const e of selected) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e])
  const days: MonthlyDayRow[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, list]) => ({
      date,
      minutes: list.reduce((s, e) => s + billedMinutes(e), 0),
      wholeHours: wholeHoursOf(list.reduce((s, e) => s + billedMinutes(e), 0)),
      clients: [...new Set(list.map((e) => clientById.get(e.clientId)?.name ?? `Client ${e.clientId}`))].sort(),
    }))

  const all = totals(selected)
  return {
    month,
    label: monthLabel(month),
    generatedAt,
    includeNonBillable,
    rows,
    days,
    totals: {
      entries: all.count,
      minutes: all.billedMin,
      actualMin: all.durationMin,
      wholeHours: rows.reduce((s, r) => s + r.wholeHours, 0),
      nonBillableMin: all.nonBillableMin,
      estimatedHours: all.estimatedHours,
      netEur: Math.round(all.netAmountEur * 100) / 100,
      eurMissing: all.eurMissing,
      estimated: all.estimated,
      daysWorked: days.length,
    },
  }
}

export function hoursOf(min: number): number {
  return Math.round((min / 60) * 100) / 100
}

/** Minutes rounded to whole hours: 29 min → 0, 30 min → 1, 90 min → 2. */
export function wholeHoursOf(min: number): number {
  return Math.round(min / 60)
}

/** Net EUR of one entry for a per-entry listing; undefined without a rate. */
export function entryNetEur(e: TimeEntry): number | undefined {
  return netEurOf(e)
}

/** "Hours_2026-11.pdf" */
export function monthlyReportFileName(r: MonthlyReport, ext: 'xlsx' | 'pdf'): string {
  return `Hours_${r.month}.${ext}`
}
