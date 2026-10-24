/** Reporting periods shared by the Reports and Customer summary screens. */
import { addMonths, monthLabel } from './time'

export type Period = 'month' | 'quarter' | 'year' | 'all' | 'custom'

export interface PeriodState {
  period: Period
  /** "YYYY-MM" the month / quarter / year is anchored on. */
  anchor: string
  custom: { from: string; to: string }
}

export interface DateRange {
  from?: string
  to?: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

export function periodRange({ period, anchor, custom }: PeriodState): DateRange {
  const [y, m] = anchor.split('-').map(Number)
  switch (period) {
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

/** Months to move the anchor by when stepping a period backwards or forwards. */
export function stepAnchor(s: PeriodState, direction: 1 | -1): string {
  const months = s.period === 'month' ? 1 : s.period === 'quarter' ? 3 : 12
  return addMonths(s.anchor, direction * months)
}

/** Round-trip the period through URL search parameters (used to hand a period from Reports to the summary). */
export function periodToParams(s: PeriodState): Record<string, string> {
  const p: Record<string, string> = { period: s.period }
  if (s.period === 'custom') {
    if (s.custom.from) p.from = s.custom.from
    if (s.custom.to) p.to = s.custom.to
  } else if (s.period !== 'all') p.anchor = s.anchor
  return p
}

export function periodFromParams(get: (key: string) => string | null, fallback: PeriodState): PeriodState {
  const period = get('period') as Period | null
  if (!period || !['month', 'quarter', 'year', 'all', 'custom'].includes(period)) return fallback
  return {
    period,
    anchor: /^\d{4}-\d{2}$/.test(get('anchor') ?? '') ? get('anchor')! : fallback.anchor,
    custom: { from: get('from') ?? '', to: get('to') ?? '' },
  }
}
