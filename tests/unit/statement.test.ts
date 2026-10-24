import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import pdfMake from 'pdfmake'
import type { Client, Project, TimeEntry } from '../../src/db/types'
import { buildStatement, statementFileName } from '../../src/lib/statement'
import { buildStatementWorkbook } from '../../src/lib/excel/exportStatement'
import { statementDocDefinition } from '../../src/lib/pdf/statementPdf'
import { periodFromParams, periodLabel, periodRange, periodToParams, rangeLabel } from '../../src/lib/period'

const client: Client = { id: 1, name: 'Polystylex SIA', defaultRate: 60, currency: 'EUR' }
const other: Client = { id: 2, name: 'Other', defaultRate: 10, currency: 'EUR' }
const projects: Project[] = [
  { id: 10, clientId: 1, name: 'Izstrāde' },
  { id: 11, clientId: 1, name: 'Support' },
]
let n = 0
function entry(partial: Partial<TimeEntry>): TimeEntry {
  n++
  return {
    date: '2026-03-10',
    startTime: '09:00',
    endTime: '10:00',
    durationMin: 60,
    clientId: 1,
    hourlyRate: 60,
    amount: 60,
    comments: `work ${n}`,
    isBilled: false,
    source: 'manual',
    createdAt: '2026-03-10T10:00:00.000Z',
    updatedAt: '2026-03-10T10:00:00.000Z',
    ...partial,
  }
}
const entries: TimeEntry[] = [
  entry({ date: '2026-03-12', startTime: '14:07', endTime: '14:31', durationMin: 24, billedMin: 30, amount: 30, projectId: 10, comments: 'Sapulce ar klientu' }),
  entry({ date: '2026-03-12', startTime: '09:00', endTime: '11:00', durationMin: 120, amount: 120, projectId: 10, comments: 'Jauna funkcionalitāte' }),
  entry({ date: '2026-03-01', projectId: 11, comments: 'Kļūda', isBilled: true, invoiceDate: '2026-03-31', invoiceRef: 'Marts 2026' }),
  entry({ date: '2026-03-20', durationMin: 5, billedMin: 5, amount: 5, billable: false, comments: 'quick call' }),
  entry({ date: '2026-02-28', comments: 'previous month' }),
  entry({ date: '2026-04-01', comments: 'next month' }),
  entry({ clientId: 2, comments: 'someone else' }),
]

describe('customer summary', () => {
  it('selects the client and period, sorts by date and totals billable work only', () => {
    const st = buildStatement({ client, entries, projects, from: '2026-03-01', to: '2026-03-31', generatedAt: '2026-04-02' })
    expect(st.rows.map((r) => r.comments)).toEqual(['Kļūda', 'Jauna funkcionalitāte', 'Sapulce ar klientu', 'quick call'])
    expect(st).toMatchObject({ count: 3, minutes: 210, actualMin: 204, amount: 210, nonBillableCount: 1, nonBillableMin: 5, currency: 'EUR' })
    expect(st.periodLabel).toBe('01.03.2026 – 31.03.2026')
    expect(st.rows[2]).toMatchObject({ minutes: 30, actualMin: 24, project: 'Izstrāde' })
    expect(st.rows[3]).toMatchObject({ billable: false, amount: 0 })
    expect(st.byProject).toEqual([
      { name: 'Izstrāde', count: 2, minutes: 150, amount: 150 },
      { name: 'Support', count: 1, minutes: 60, amount: 60 },
    ])
    expect(statementFileName(st, 'pdf')).toBe('Summary_Polystylex_SIA_2026-03-01_2026-03-31.pdf')
  })

  it('filters billed / not billed and handles open-ended periods', () => {
    const open = buildStatement({ client, entries, projects, filter: 'unbilled' })
    expect(open.rows.map((r) => r.comments)).toEqual(['previous month', 'Jauna funkcionalitāte', 'Sapulce ar klientu', 'next month'])
    expect(open.periodLabel).toBe('All time')
    const billed = buildStatement({ client, entries, projects, filter: 'billed', from: '2026-01-01' })
    expect(billed.rows).toHaveLength(1)
    expect(billed.periodLabel).toBe('from 01.01.2026')
    expect(statementFileName(billed, 'xlsx')).toMatch(/^Summary_Polystylex_SIA_2026-01-01_\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(buildStatement({ client: other, entries, projects }).count).toBe(1)
  })

  it('writes an Excel workbook with the totals in the header and every entry', async () => {
    const st = buildStatement({ client, entries, projects, from: '2026-03-01', to: '2026-03-31', generatedAt: '2026-04-02' })
    const wb = buildStatementWorkbook(st)
    const buf = await wb.xlsx.writeBuffer()
    const read = new ExcelJS.Workbook()
    await read.xlsx.load(buf as never)
    const ws = read.getWorksheet('Summary')!
    expect(ws.getCell('A1').value).toBe('Time summary – Polystylex SIA')
    expect(ws.getCell('A2').value).toBe('Period: 01.03.2026 – 31.03.2026')
    expect(ws.getCell('D5').value).toBe(3.5)
    expect(ws.getCell('D6').value).toBe(210)
    expect(ws.getCell('D7').value).toBe(3)
    const header = ws.getRow(10).values as unknown[]
    expect(header.slice(1)).toEqual(['Date', 'Start', 'End', 'Hours', 'Project', 'Description', 'Rate', 'Amount', 'Invoice'])
    expect(ws.getRow(11).getCell(6).value).toBe('Kļūda')
    expect(ws.getRow(11).getCell(9).value).toBe('Marts 2026')
    expect(ws.getRow(14).getCell(9).value).toBe('non-billable')
    const total = ws.getRow(15)
    expect(total.getCell(1).value).toBe('Total')
    expect((total.getCell(8).value as { formula: string }).formula).toBe('SUBTOTAL(9,H11:H14)')
    expect(ws.getCell('A17').value).toBe('By project')
  })

  it('renders a PDF with Latvian characters through pdfmake', async () => {
    const st = buildStatement({ client, entries, projects, from: '2026-03-01', to: '2026-03-31', generatedAt: '2026-04-02' })
    const def = statementDocDefinition(st)
    const text = JSON.stringify(def.content)
    expect(text).toContain('Polystylex SIA')
    expect(text).toContain('Jauna funkcionalitāte')
    expect(text).toContain('210.00 EUR')
    expect(text).toContain('"3.50"')

    const dir = 'node_modules/pdfmake/build/fonts/Roboto'
    pdfMake.addFonts({ Roboto: { normal: `${dir}/Roboto-Regular.ttf`, bold: `${dir}/Roboto-Medium.ttf`, italics: `${dir}/Roboto-Italic.ttf`, bolditalics: `${dir}/Roboto-MediumItalic.ttf` } })
    const buffer = await pdfMake.createPdf(def).getBuffer()
    expect(Buffer.from(buffer).subarray(0, 5).toString()).toBe('%PDF-')
    expect(buffer.byteLength).toBeGreaterThan(10_000)
  })
})

describe('periods', () => {
  it('computes ranges and labels', () => {
    expect(periodRange({ period: 'month', anchor: '2026-02', custom: { from: '', to: '' } })).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(periodRange({ period: 'quarter', anchor: '2026-05', custom: { from: '', to: '' } })).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(periodRange({ period: 'year', anchor: '2026-05', custom: { from: '', to: '' } })).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(periodRange({ period: 'all', anchor: '2026-05', custom: { from: '', to: '' } })).toEqual({})
    expect(periodRange({ period: 'custom', anchor: '2026-05', custom: { from: '2026-01-15', to: '' } })).toEqual({ from: '2026-01-15', to: undefined })
    expect(periodLabel({ period: 'quarter', anchor: '2026-05', custom: { from: '', to: '' } })).toBe('Q2 2026')
    expect(rangeLabel({ to: '2026-01-31' })).toBe('until 31.01.2026')
  })

  it('round-trips through URL parameters', () => {
    const s = { period: 'custom' as const, anchor: '2026-05', custom: { from: '2026-01-01', to: '2026-01-31' } }
    const params = periodToParams(s)
    expect(params).toEqual({ period: 'custom', from: '2026-01-01', to: '2026-01-31' })
    const back = periodFromParams((k) => params[k] ?? null, { period: 'month', anchor: '2026-10', custom: { from: '', to: '' } })
    expect(back).toEqual({ period: 'custom', anchor: '2026-10', custom: { from: '2026-01-01', to: '2026-01-31' } })
    expect(periodToParams({ period: 'all', anchor: '2026-05', custom: { from: '', to: '' } })).toEqual({ period: 'all' })
    expect(periodFromParams(() => null, { period: 'year', anchor: '2025-01', custom: { from: '', to: '' } }).period).toBe('year')
  })
})
