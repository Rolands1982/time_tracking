import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { Client, TimeEntry } from '../../src/db/types'
import { buildMonthlyReport, monthlyReportFileName, wholeHoursOf } from '../../src/lib/monthlyReport'
import { buildMonthlyWorkbook } from '../../src/lib/excel/exportMonthly'
import { monthlyDocDefinition } from '../../src/lib/pdf/monthlyPdf'

const clients: Client[] = [
  { id: 1, name: 'Polystylex', businessName: 'Polystylex SIA', defaultRate: 60, currency: 'EUR' },
  { id: 2, name: 'Northwind Supply', defaultRate: 0, currency: 'USD', platform: 'upwork', upworkClientId: '4' },
]
let n = 0
function entry(partial: Partial<TimeEntry>): TimeEntry {
  n++
  return { date: '2026-10-10', startTime: '09:00', endTime: '10:00', durationMin: 60, clientId: 1, hourlyRate: 60, amount: 60, netAmount: 60, netAmountEur: 60, currency: 'EUR', comments: `work ${n}`, isBilled: false, source: 'manual', createdAt: '', updatedAt: '', ...partial }
}
const entries: TimeEntry[] = [
  entry({ date: '2026-10-01', durationMin: 120, billedMin: 120, amount: 120, netAmount: 120, netAmountEur: 120 }),
  entry({ date: '2026-10-01', durationMin: 24, billedMin: 30, amount: 30, netAmount: 30, netAmountEur: 30 }),
  entry({ date: '2026-10-02', durationMin: 5, billedMin: 5, amount: 5, netAmount: 5, netAmountEur: 5, billable: false }),
  entry({ date: '2026-10-02', clientId: 2, durationMin: 390, amount: 520, currency: 'USD', feeAmount: 52, netAmount: 468, fxRate: 0.9, netAmountEur: 421.2, settlement: 'actual', source: 'upwork', timeless: true, isBilled: true }),
  entry({ date: '2026-10-03', clientId: 2, durationMin: 120, amount: 200, currency: 'USD', feeAmount: 20, netAmount: 180, netAmountEur: undefined, settlement: 'estimated', source: 'upwork', timeless: true, estimatedHours: true }),
  entry({ date: '2026-09-30', comments: 'previous month' }),
  entry({ date: '2026-11-01', comments: 'next month' }),
]

describe('monthly hours report', () => {
  it('sums hours per client and per day for the month, money net in EUR', () => {
    const r = buildMonthlyReport({ month: '2026-10', entries, clients, generatedAt: '2026-11-02' })
    expect(r.label).toBe('October 2026')
    expect(r.totals).toEqual({ entries: 5, minutes: 665, actualMin: 659, wholeHours: 12, nonBillableMin: 5, estimatedHours: 1, netEur: 571.2, eurMissing: 1, estimated: 1, daysWorked: 3 })
    expect(r.rows.map((x) => [x.name, x.entries, x.minutes, x.wholeHours, x.netEur, x.platform, x.estimatedHours, x.eurMissing])).toEqual([
      ['Northwind Supply', 2, 510, 9, 421.2, true, 1, 1],
      ['Polystylex', 3, 155, 3, 150, false, 0, 0],
    ])
    expect(r.rows[1].businessName).toBe('Polystylex SIA')
    expect(r.days).toEqual([
      { date: '2026-10-01', minutes: 150, wholeHours: 3, clients: ['Polystylex'] },
      { date: '2026-10-02', minutes: 395, wholeHours: 7, clients: ['Northwind Supply', 'Polystylex'] },
      { date: '2026-10-03', minutes: 120, wholeHours: 2, clients: ['Northwind Supply'] },
    ])
    expect(monthlyReportFileName(r, 'pdf')).toBe('Hours_2026-10.pdf')
    expect([0, 29, 30, 90, 665].map(wholeHoursOf)).toEqual([0, 0, 1, 2, 11])

    // Without non-billable work the 5 minutes drop out of the hours; the money was never in.
    const billable = buildMonthlyReport({ month: '2026-10', entries, clients, includeNonBillable: false })
    expect(billable.totals).toMatchObject({ entries: 4, minutes: 660, nonBillableMin: 0, netEur: 571.2 })
  })

  it('renders the Excel workbook and the PDF definition', async () => {
    const r = buildMonthlyReport({ month: '2026-10', entries, clients, generatedAt: '2026-11-02' })
    const read = new ExcelJS.Workbook()
    await read.xlsx.load((await buildMonthlyWorkbook(r).xlsx.writeBuffer()) as never)
    const ws = read.getWorksheet('Hours')!
    expect(ws.getCell('A1').value).toBe('Monthly hours report – October 2026')
    expect(ws.getCell('B4').value).toBe(11.08)
    expect(ws.getCell('B5').value).toBe(12)
    expect(ws.getCell('B6').value).toBe(3)
    expect(ws.getCell('B8').value).toBe(571.2)
    const header = [...Array(20).keys()].map((i) => ws.getRow(i + 1).getCell(1).value).findIndex((v) => v === 'Client') + 1
    expect(header).toBeGreaterThan(8)
    expect(ws.getRow(header + 1).getCell(1).value).toBe('Northwind Supply')
    expect(ws.getRow(header + 1).getCell(3).value).toBe(8.5)
    expect(ws.getRow(header + 1).getCell(4).value).toBe(9)
    expect(ws.getRow(header + 1).getCell(5).value).toBe(421.2)
    expect(ws.getRow(header + 2).getCell(1).value).toBe('Polystylex (Polystylex SIA)')
    expect(ws.getRow(header + 3).getCell(1).value).toBe('Total')
    expect(ws.getRow(header + 3).getCell(3).value).toMatchObject({ formula: `SUM(C${header + 1}:C${header + 2})` })
    expect(ws.getRow(header + 3).getCell(4).value).toMatchObject({ formula: `SUM(D${header + 1}:D${header + 2})`, result: 12 })
    expect(ws.getRow(header + 3).getCell(5).value).toMatchObject({ formula: `SUM(E${header + 1}:E${header + 2})` })

    const def = monthlyDocDefinition(r)
    const text = JSON.stringify(def.content)
    expect(text).toContain('October 2026')
    expect(text).toContain('"11.08"')
    expect(text).toContain('571.20 EUR')
    expect(text).toContain('8.50 *')
    expect(text).toContain('"9 h"')
    expect(text).toContain('"12 h"')
    expect(text).toContain('1 entry with estimated hours')
  })
})
