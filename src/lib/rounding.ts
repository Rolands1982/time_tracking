/**
 * Billing normalisation of time records.
 *
 * Records keep the real start, end and minutes. For billing and customer-facing reports a
 * normalised copy is derived (`billedStartTime`, `billedEndTime`, `billedMin`):
 *
 *  - Work is billed from a round 10-minute mark (:00, :10, :20, :30, :40, :50): the start
 *    time is snapped to the nearest one.
 *  - Time is billed in 15-minute steps. A step counts as soon as the actual time is
 *    5 minutes into it: 7–19 min → 15, 20–34 → 30, 35–49 → 45, 50–64 → 60, …
 *  - Less than 7 minutes is kept as the real minutes and marked non-billable.
 *
 * Only new records get the normalised columns; records that predate the rules keep their
 * real minutes as the billed minutes.
 */
import { hmToMinutes, minutesToHm } from './time'

export type RoundingMode = 'billing' | 'exact'

export const START_STEP_MIN = 10
export const BILLING_STEP_MIN = 15
/** Below this many minutes the work is recorded as is and is not billable. */
export const MIN_BILLABLE_MIN = 7
/** Minutes into a 15-minute step after which the whole step is recorded. */
export const STEP_THRESHOLD_MIN = 5

export interface RoundedDuration {
  durationMin: number
  billable: boolean
}

/** Snap minutes-since-midnight to the nearest 10-minute mark (may return 1440 = next midnight). */
export function snapStartMinutes(min: number): number {
  return Math.round(min / START_STEP_MIN) * START_STEP_MIN
}

export function snapStartHm(hm: string): string {
  return minutesToHm(snapStartMinutes(hmToMinutes(hm)))
}

/** Snap a Date to the nearest 10-minute mark (seconds dropped). */
export function snapStartDate(d: Date): Date {
  const snapped = new Date(d)
  snapped.setSeconds(0, 0)
  const m = snapped.getMinutes()
  snapped.setMinutes(0)
  return new Date(snapped.getTime() + Math.round(m / START_STEP_MIN) * START_STEP_MIN * 60_000)
}

/** Apply the 15-minute billing steps to an actual duration in minutes. */
export function roundBillingDuration(actualMin: number): RoundedDuration {
  const actual = Math.max(0, Math.round(actualMin))
  if (actual < MIN_BILLABLE_MIN) return { durationMin: Math.max(1, actual), billable: false }
  const steps = Math.floor(actual / BILLING_STEP_MIN)
  const rest = actual % BILLING_STEP_MIN
  const counted = Math.max(1, rest >= STEP_THRESHOLD_MIN ? steps + 1 : steps)
  return { durationMin: counted * BILLING_STEP_MIN, billable: true }
}

export interface RoundedInterval {
  startTime: string
  endTime: string
  durationMin: number
  billable: boolean
  /** The real minutes between the given start and end, before rounding. */
  actualMin: number
}

/**
 * Normalise an interval for billing: the start snaps to 10 minutes, the real duration between
 * the times is rounded, and the billed end time follows from both.
 */
export function roundInterval(startHm: string, endHm: string): RoundedInterval {
  const start = hmToMinutes(startHm)
  let end = hmToMinutes(endHm)
  if (end <= start) end += 1440
  const actualMin = end - start
  const snappedStart = snapStartMinutes(start)
  const rounded = roundBillingDuration(actualMin)
  return {
    startTime: minutesToHm(snappedStart),
    endTime: minutesToHm(snappedStart + rounded.durationMin),
    durationMin: rounded.durationMin,
    billable: rounded.billable,
    actualMin,
  }
}

/** Quick-pick durations offered when logging time by hand (minutes). */
export const DURATION_CHOICES_MIN = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480]
