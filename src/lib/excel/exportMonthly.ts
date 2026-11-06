/** Monthly hours report as a one-sheet Excel workbook: hours per client and per day, net in EUR. */
import ExcelJS from 'exceljs'
import { hoursOf, type MonthlyReport } from '../monthlyReport'
import { formatDate } from '../period'

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }
const TOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
const EUR = '#,##0.00 "EUR"'

export function buildMonthlyWorkbook(r: MonthlyReport): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Time Tracking app'
  wb.created = new Date()
  const ws = wb.addWorksheet('Hours', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  ws.getColumn(1).width = 34
  ws.getColumn(2).width = 10
  ws.getColumn(3).width = 10
  ws.getColumn(4).width = 16
  ws.getColumn(5).width = 40
  const t = r.totals

  ws.addRow([`Monthly hours report – ${r.label}`]).font = { bold: true, size: 14 }
  ws.addRow([`Generated ${formatDate(r.generatedAt)} · hours on the billed basis`])
  ws.addRow([])
  const stat = (label: string, value: number | string, numFmt?: string) => {
    const row = ws.addRow([label, value])
    row.getCell(1).font = { bold: true }
    if (numFmt) row.getCell(2).numFmt = numFmt
    row.getCell(2).alignment = { horizontal: 'left' }
    return row
  }
  stat('Total hours', hoursOf(t.minutes), '0.00').getCell(2).font = { bold: true, size: 12 }
  stat('Days worked', t.daysWorked)
  stat('Entries', t.entries)
  stat('Net EUR', t.netEur, EUR).getCell(2).font = { bold: true, size: 12 }
  if (t.nonBillableMin) stat('Non-billable hours (in the hours, not the money)', hoursOf(t.nonBillableMin), '0.00')
  if (t.estimatedHours) stat('Entries with estimated hours', t.estimatedHours)
  if (t.estimated || t.eurMissing) stat('Entries with an estimated fee or rate / without a rate', `${t.estimated} / ${t.eurMissing}`)
  ws.addRow([])

  const h1 = ws.addRow(['Client', 'Entries', 'Hours', 'Net EUR', 'Note'])
  h1.font = { bold: true }
  h1.fill = HEADER_FILL
  const first = h1.number + 1
  for (const row of r.rows) {
    const note = [row.platform ? 'Upwork' : '', row.estimatedHours ? `${row.estimatedHours} with estimated hours` : '', row.estimated ? `${row.estimated} estimated` : '', row.eurMissing ? `${row.eurMissing} without a rate` : '']
      .filter(Boolean)
      .join(', ')
    const x = ws.addRow([row.businessName ? `${row.name} (${row.businessName})` : row.name, row.entries, hoursOf(row.minutes), row.netEur, note])
    x.getCell(3).numFmt = '0.00'
    x.getCell(4).numFmt = EUR
  }
  const last = ws.rowCount
  const total = ws.addRow(['Total', t.entries, r.rows.length ? { formula: `SUM(C${first}:C${last})`, result: hoursOf(t.minutes) } : 0, r.rows.length ? { formula: `SUM(D${first}:D${last})`, result: t.netEur } : 0])
  total.font = { bold: true }
  total.fill = TOTAL_FILL
  total.getCell(3).numFmt = '0.00'
  total.getCell(4).numFmt = EUR
  ws.addRow([])

  const h2 = ws.addRow(['Date', 'Hours', '', '', 'Clients'])
  h2.font = { bold: true }
  h2.fill = HEADER_FILL
  for (const d of r.days) {
    const x = ws.addRow([new Date(`${d.date}T00:00:00Z`), hoursOf(d.minutes), null, null, d.clients.join(', ')])
    x.getCell(1).numFmt = 'dd.mm.yyyy'
    x.getCell(2).numFmt = '0.00'
  }
  ws.views = [{ state: 'frozen', ySplit: h1.number }]
  return wb
}

export async function monthlyToBuffer(r: MonthlyReport): Promise<ArrayBuffer> {
  return (await buildMonthlyWorkbook(r).xlsx.writeBuffer()) as ArrayBuffer
}
