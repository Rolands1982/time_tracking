/**
 * USD → EUR reference rates for estimating the EUR value of earnings not yet paid out. Source: the ECB
 * fixings as published by frankfurter.dev (free, no key, CORS enabled). Rates are cached per day in
 * settings.upwork.fxRates; weekends and holidays reuse the last fixing before them.
 */
import { db, getSettings, updateSettings, type TimeTrackingDB } from '../db/schema'
import { addDays } from './period'

export const FX_API = 'https://api.frankfurter.dev/v1'

export type RateFetcher = (from: string, to: string) => Promise<Record<string, number>>

/** Browsers refuse `fetch` called without `window` as `this`, so the default always goes through globalThis. */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

/** Split a range into spans of at most a year, so one request never grows unbounded. */
export function yearSpans(from: string, to: string): [string, string][] {
  const spans: [string, string][] = []
  let start = from
  while (start <= to) {
    const end = addDays(start, 365) < to ? addDays(start, 365) : to
    spans.push([start, end])
    start = addDays(end, 1)
  }
  return spans
}

/** Fetch USD→EUR fixings for a date range (inclusive). Returns { 'YYYY-MM-DD': eurPerUsd } for trading days. */
export async function fetchUsdEurRates(from: string, to: string, fetchFn: typeof fetch = defaultFetch, timeoutMs = 20_000): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [start, end] of yearSpans(from, to)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchFn(`${FX_API}/${start}..${end}?base=USD&symbols=EUR`, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`Exchange rates: HTTP ${res.status}`)
    const body = (await res.json()) as { rates?: Record<string, { EUR?: number }> }
    for (const [date, r] of Object.entries(body.rates ?? {})) if (typeof r.EUR === 'number') out[date] = r.EUR
  }
  return out
}

/** Fill every day from `from` to `to` with the last fixing on or before it. */
export function fillGaps(rates: Record<string, number>, from: string, to: string): Record<string, number> {
  const out: Record<string, number> = { ...rates }
  const days = Object.keys(rates).sort()
  let last: number | undefined = days.filter((d) => d < from).map((d) => rates[d]).at(-1)
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (rates[d] != null) last = rates[d]
    else if (last != null) out[d] = last
  }
  return out
}

/** Make sure the cache holds a rate for each of `dates`; fetches the missing span once. Errors are returned, not thrown. */
export async function ensureFxRates(dates: string[], database: TimeTrackingDB = db, fetcher: RateFetcher = fetchUsdEurRates): Promise<{ fetched: number; cached: number; error?: string }> {
  const settings = await getSettings(database)
  const cache = settings.upwork?.fxRates ?? {}
  const missing = dates.filter((d) => cache[d] == null).sort()
  const cached = dates.length - missing.length
  if (!missing.length) return { fetched: 0, cached }
  const from = missing[0]
  const to = missing.at(-1)!
  try {
    // Start a week early so the first days can take the previous fixing when they fall on a weekend.
    const fetched = await fetcher(addDays(from, -7), to)
    const filled = fillGaps(fetched, from, to)
    const next = { ...cache }
    let n = 0
    for (const d of missing) {
      if (filled[d] != null) {
        next[d] = filled[d]
        n++
      }
    }
    if (n) await updateSettings({ upwork: { ...settings.upwork, fxRates: next } }, database)
    return { fetched: n, cached }
  } catch (err) {
    return { fetched: 0, cached, error: err instanceof Error ? err.message : String(err) }
  }
}
