import { describe, expect, it } from 'vitest'
import {
  addMonths,
  computeAmount,
  durationMinutes,
  formatDuration,
  hmToMinutes,
  isValidHm,
  isValidIsoDate,
  minutesToHm,
  monthRange,
  roundDuration,
} from '../../src/lib/time'

describe('time helpers', () => {
  it('parses and formats HH:mm', () => {
    expect(hmToMinutes('00:00')).toBe(0)
    expect(hmToMinutes('9:05')).toBe(545)
    expect(hmToMinutes('24:00')).toBe(1440)
    expect(minutesToHm(545)).toBe('09:05')
    expect(minutesToHm(1440)).toBe('00:00')
    expect(isValidHm('25:00')).toBe(false)
    expect(isValidHm('12:60')).toBe(false)
    expect(isValidHm('12:30')).toBe(true)
  })

  it('computes durations, wrapping past midnight', () => {
    expect(durationMinutes('14:00', '15:00')).toBe(60)
    expect(durationMinutes('22:00', '00:00')).toBe(120)
    expect(durationMinutes('22:30', '00:30')).toBe(120)
    expect(durationMinutes('21:30', '24:00')).toBe(150)
    expect(durationMinutes('10:00', '10:00')).toBe(1440)
  })

  it('rounds durations up to steps', () => {
    expect(roundDuration(7, 0)).toBe(7)
    expect(roundDuration(7, 15)).toBe(15)
    expect(roundDuration(15, 15)).toBe(15)
    expect(roundDuration(16, 15)).toBe(30)
    expect(roundDuration(0, 5)).toBe(5)
  })

  it('computes money to cents', () => {
    expect(computeAmount(90, 60)).toBe(90)
    expect(computeAmount(20, 50)).toBe(16.67)
  })

  it('formats and validates dates', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false)
    expect(isValidIsoDate('2024-02-29')).toBe(true)
    expect(monthRange('2026-10-23')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(formatDuration(150)).toBe('2h 30m')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(120)).toBe('2h')
  })
})
