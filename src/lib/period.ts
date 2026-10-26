/** Reporting periods shared by the Reports and Customer summary screens. */
import { addMonths, monthLabel, todayIso } from './time'

export type Period = 'week' | 'month' | 'quarter' | 'year' | 'all' | 'custom'

export const PERIODS: Period[] = ['week', 'month', 'quarter', 'year', 'all', 'custom']

export interface PeriodState {
  period: Period
  /** "YYYY-MM" the month / quarter / year is anchored on. */
  anchor: string
  /** "YYYY-MM-DD": any day of the selected week (weeks run Monday to Sunday). Defaults to today. */
  week?: string
  custom: { from: string; to: string }
}

export interface DateRange {
  from?: string
  to?: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (iso: string) => new Date(`${iso}T00:00:00`)

/** Monday and Sunday of the week containing `iso`. */
export function weekRange(iso: string): { from: string; to: string } {
  const d = fromIso(iso)
  const offset = (d.getDay() + 6) % 7 // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { from: toIso(monday), to: toIso(sunday) }
}

/** ISO 8601 week number of the week containing `iso`. */
export function isoWeek(iso: string): number {
  const d = fromIso(iso)
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(thursday.getFullYear(), 0, 4)
  const jan4Monday = new Date(jan4.getFullYear(), 0, 4 - ((jan4.getDay() + 6) % 7))
  return 1 + Math.round((thursday.getTime() - jan4Monday.getTime()) / (7 * 86_400_000))
}

export function addDays(iso: string, days: number): string {
  const d = fromIso(iso)
  return toIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

export function periodRange({ period, anchor, week, custom }: PeriodState): DateRange {
  const [y, m] = anchor.split('-').map(Number)
  switch (period) {
    case 'week':
      return weekRange(week ?? todayIso())
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }
    case 'quarter': {
      const q0 = Math.floor((m - 1) / 3) * 3 + 1
      return { from: `${y}-${pad(q0)}-01`, to: `${y}-${pad(q0 + 2)}-${pad(lastDay(y, q0 + 2))}` }
    }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    case 'custom':
      return { from: custom.from || undefined, to: custom.to || undefined }
    default:
      return {}
  }
}

export function periodLabel(s: PeriodState): string {
  switch (s.period) {
    case 'week': {
      const r = weekRange(s.week ?? todayIso())
      return `Week ${isoWeek(r.from)} · ${formatDate(r.from).slice(0, 5)} – ${formatDate(r.to)}`
    }
    case 'month':
      return monthLabel(s.anchor)
    case 'quarter':
      return `Q${Math.floor((Number(s.anchor.slice(5)) - 1) / 3) + 1} ${s.anchor.slice(0, 4)}`
    case 'year':
      return s.anchor.slice(0, 4)
    case 'all':
      return 'All time'
    default:
      return rangeLabel(periodRange(s))
  }
}

/** Human readable label for a from/to range, e.g. "01.03.2026 – 31.03.2026". */
export function rangeLabel({ from, to }: DateRange): string {
  if (!from && !to) return 'All time'
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`
  if (from) return `from ${formatDate(from)}`
  return `until ${formatDate(to!)}`
}

/** "DD.MM.YYYY" independent of the device locale, so documents look the same everywhere. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** The state after stepping the period backwards or forwards (a week, a month, a quarter, a year). */
export function stepPeriod(s: PeriodState, direction: 1 | -1): PeriodState {
  if (s.period === 'week') return { ...s, week: addDays(s.week ?? todayIso(), direction * 7) }
  const months = s.period === 'month' ? 1 : s.period === 'quarter' ? 3 : 12
  return { ...s, anchor: addMonths(s.anchor, direction * months) }
}

/** Round-trip the period through URL search parameters (used to hand a period from Reports to the summary). */
export function periodToParams(s: PeriodState): Record<string, string> {
  const p: Record<string, string> = { period: s.period }
  if (s.period === 'custom') {
    if (s.custom.from) p.from = s.custom.from
    if (s.custom.to) p.to = s.custom.to
  } else if (s.period === 'week') p.week = s.week ?? todayIso()
  else if (s.period !== 'all') p.anchor = s.anchor
  return p
}

export function periodFromParams(get: (key: string) => string | null, fallback: PeriodState): PeriodState {
  const period = get('period') as Period | null
  if (!period || !PERIODS.includes(period)) return fallback
  return {
    period,
    anchor: /^\d{4}-\d{2}$/.test(get('anchor') ?? '') ? get('anchor')! : fallback.anchor,
    week: /^\d{4}-\d{2}-\d{2}$/.test(get('week') ?? '') ? get('week')! : fallback.week,
    custom: { from: get('from') ?? '', to: get('to') ?? '' },
  }
}
