/** Pure helpers for dates, times, durations and money. No DOM, no DB. */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Format a Date as local "YYYY-MM-DD". */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Format a Date as local "HH:mm". */
export function toHm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function todayIso(): string {
  return toIsoDate(new Date())
}

/** Parse "HH:mm" into minutes since midnight. Accepts "24:00". */
export function hmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) throw new Error(`Invalid time "${hm}"`)
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 24 || mi < 0 || mi > 59 || (h === 24 && mi !== 0)) {
    throw new Error(`Invalid time "${hm}"`)
  }
  return h * 60 + mi
}

export function minutesToHm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}

export function isValidHm(hm: string): boolean {
  try {
    hmToMinutes(hm)
    return true
  } catch {
    return false
  }
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00`)
  return !Number.isNaN(d.getTime()) && toIsoDate(d) === s
}

/**
 * Duration in minutes between two wall-clock times.
 * If end <= start the interval is assumed to cross midnight (e.g. 22:00 → 00:30 = 150 min).
 * "24:00" is accepted as an end time meaning midnight at the end of the day.
 */
export function durationMinutes(startHm: string, endHm: string): number {
  const s = hmToMinutes(startHm)
  let e = hmToMinutes(endHm)
  if (e <= s) e += 1440
  return e - s
}

/** Money for an entry: rounded to cents. */
export function computeAmount(durationMin: number, hourlyRate: number): number {
  return Math.round((durationMin / 60) * hourlyRate * 100) / 100
}

export function formatHours(min: number, decimals = 2): string {
  return (min / 60).toFixed(decimals)
}

/** "1h 30m" style, used in lists and the timer. */
export function formatDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${pad2(m)}m`
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

export function formatMoney(amount: number, currency = 'EUR'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** "YYYY-MM" for grouping by month. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7)
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function formatDateLong(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

/** First and last day of the month containing `isoDate`. */
export function monthRange(isoDate: string): { from: string; to: string } {
  const d = new Date(`${isoDate}T00:00:00`)
  const from = new Date(d.getFullYear(), d.getMonth(), 1)
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: toIsoDate(from), to: toIsoDate(to) }
}

export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}
