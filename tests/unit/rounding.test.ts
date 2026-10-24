import { describe, expect, it } from 'vitest'
import { roundBillingDuration, roundInterval, snapStartDate, snapStartHm } from '../../src/lib/rounding'

describe('billing rounding', () => {
  it('snaps start times to the nearest 10 minutes', () => {
    expect(snapStartHm('14:00')).toBe('14:00')
    expect(snapStartHm('14:03')).toBe('14:00')
    expect(snapStartHm('14:05')).toBe('14:10')
    expect(snapStartHm('14:07')).toBe('14:10')
    expect(snapStartHm('14:14')).toBe('14:10')
    expect(snapStartHm('14:15')).toBe('14:20')
    expect(snapStartHm('23:57')).toBe('00:00')
    const d = snapStartDate(new Date(2026, 9, 24, 9, 26, 40))
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([9, 30, 0])
  })

  it('records less than 7 minutes as actual time, non-billable', () => {
    expect(roundBillingDuration(0)).toEqual({ durationMin: 1, billable: false })
    expect(roundBillingDuration(1)).toEqual({ durationMin: 1, billable: false })
    expect(roundBillingDuration(6)).toEqual({ durationMin: 6, billable: false })
    expect(roundBillingDuration(6.4)).toEqual({ durationMin: 6, billable: false })
  })

  it('rounds to 15-minute steps once 5 minutes into the next step', () => {
    const cases: [number, number][] = [
      [7, 15],
      [14, 15],
      [15, 15],
      [19, 15],
      [20, 30],
      [29, 30],
      [30, 30],
      [34, 30],
      [35, 45],
      [49, 45],
      [50, 60],
      [60, 60],
      [64, 60],
      [65, 75],
      [124, 120],
      [125, 135],
    ]
    for (const [actual, expected] of cases) {
      expect(roundBillingDuration(actual), `${actual} min`).toEqual({ durationMin: expected, billable: true })
    }
  })

  it('rounds a manual interval: snapped start, rounded duration, derived end', () => {
    expect(roundInterval('14:07', '14:31')).toMatchObject({ startTime: '14:10', endTime: '14:40', durationMin: 30, billable: true, actualMin: 24 })
    expect(roundInterval('09:00', '09:05')).toMatchObject({ startTime: '09:00', endTime: '09:05', durationMin: 5, billable: false })
    expect(roundInterval('23:50', '00:20')).toMatchObject({ startTime: '23:50', endTime: '00:20', durationMin: 30, actualMin: 30 })
  })
})
