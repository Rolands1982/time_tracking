/**
 * USD → EUR reference rates for estimating the EUR value of earnings not yet paid out. Source: the ECB
 * fixings as published by frankfurter.dev (free, no key, CORS enabled). Rates are cached per day in
 * settings.upwork.fxRates; weekends and holidays reuse the last fixing before them.
 */
import { db, getSettings, updateSettings, type TimeTrackingDB } from '../db/schema'
import { addDays } from './period'

export const FX_API = 'https://api.frankfurter.dev/v1'

export type RateFetcher = (from: string, to: string) => Promise<Record<string, number>>

/** Fetch USD→EUR fixings for a date range (inclusive). Returns { 'YYYY-MM-DD': eurPerUsd } for trading days. */
export async function fetchUsdEurRates(from: string, to: string, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<Record<string, number>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchFn(`${FX_API}/${from}..${to}?base=USD&symbols=EUR`, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`Exchange rates: HTTP ${res.status}`)
  const body = (await res.json()) as { rates?: Record<string, { EUR?: number }> }
  const out: Record<string, number> = {}
  for (const [date, r] of Object.entries(body.rates ?? {})) if (typeof r.EUR === 'number') out[date] = r.EUR
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
export async function ensureFxRates(dates: string[], database: TimeTrackingDB = db, fetcher: RateFetcher = fetchUsdEurRates): Promise<{ fetched: number; error?: string }> {
  const settings = await getSettings(database)
  const cache = settings.upwork?.fxRates ?? {}
  const missing = dates.filter((d) => cache[d] == null).sort()
  if (!missing.length) return { fetched: 0 }
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
    return { fetched: n }
  } catch (err) {
    return { fetched: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
