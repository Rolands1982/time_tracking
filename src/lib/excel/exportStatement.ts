/** Customer summary as a one-sheet Excel workbook. */
import ExcelJS from 'exceljs'
import { FILTER_LABELS, hours, type Statement } from '../statement'
import { formatDate } from '../period'

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }
const TOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }

function excelDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function buildStatementWorkbook(st: Statement): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Time Tracking app'
  wb.created = new Date()
  const ws = wb.addWorksheet('Summary', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  const money = `#,##0.00 "${st.currency}"`

  ws.getColumn(1).width = 12
  ws.getColumn(2).width = 7
  ws.getColumn(3).width = 7
  ws.getColumn(4).width = 8
  ws.getColumn(5).width = 22
  ws.getColumn(6).width = 60
  ws.getColumn(7).width = 10
  ws.getColumn(8).width = 14
  ws.getColumn(9).width = 16

  ws.addRow([`Time summary – ${st.clientName}`]).font = { bold: true, size: 14 }
  ws.addRow([`Period: ${st.periodLabel}`])
  ws.addRow([`Entries: ${FILTER_LABELS[st.filter]} · generated ${formatDate(st.generatedAt)}`])
  ws.addRow([])

  const stat = (label: string, value: number | string, numFmt?: string) => {
    const r = ws.addRow([label, null, null, value])
    r.getCell(1).font = { bold: true }
    if (numFmt) r.getCell(4).numFmt = numFmt
    r.getCell(4).alignment = { horizontal: 'left' }
    return r
  }
  stat('Total hours', hours(st.minutes), '0.00').getCell(4).font = { bold: true, size: 12 }
  stat('Total amount', st.amount, money).getCell(4).font = { bold: true, size: 12 }
  stat('Entries', st.count)
  if (st.nonBillableCount) stat('Non-billable hours (not charged)', hours(st.nonBillableMin), '0.00')
  ws.addRow([])

  const header = ws.addRow(['Date', 'Start', 'End', 'Hours', 'Project', 'Description', 'Rate', 'Amount', 'Invoice'])
  header.font = { bold: true }
  header.fill = HEADER_FILL
  const firstDataRow = header.number + 1
  for (const r of st.rows) {
    const row = ws.addRow([
      excelDate(r.date),
      r.startTime,
      r.endTime,
      hours(r.minutes),
      r.project,
      [r.category, r.comments].filter(Boolean).join(': '),
      r.rate,
      r.amount,
      !r.billable ? 'non-billable' : r.isBilled ? (r.invoiceRef ?? (r.invoiceDate ? formatDate(r.invoiceDate) : 'billed')) : 'open',
    ])
    row.getCell(1).numFmt = 'dd.mm.yyyy'
    row.getCell(4).numFmt = '0.00'
    row.getCell(7).numFmt = money
    row.getCell(8).numFmt = money
    row.getCell(6).alignment = { wrapText: true, vertical: 'top' }
    if (!r.billable) row.font = { italic: true, color: { argb: 'FF808080' } }
  }
  const lastDataRow = ws.rowCount
  const total = ws.addRow(['Total', null, null, st.rows.length ? { formula: `SUBTOTAL(9,D${firstDataRow}:D${lastDataRow})`, result: hours(st.minutes + st.nonBillableMin) } : 0, null, null, null, st.rows.length ? { formula: `SUBTOTAL(9,H${firstDataRow}:H${lastDataRow})`, result: st.amount } : 0])
  total.font = { bold: true }
  total.fill = TOTAL_FILL
  total.getCell(4).numFmt = '0.00'
  total.getCell(8).numFmt = money
  ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: lastDataRow, column: 9 } }
  ws.views = [{ state: 'frozen', ySplit: header.number }]

  if (st.byProject.length > 1) {
    ws.addRow([])
    const h = ws.addRow(['By project', null, null, 'Hours', null, null, null, 'Amount'])
    h.font = { bold: true }
    h.fill = HEADER_FILL
    for (const g of st.byProject) {
      const r = ws.addRow([g.name, null, null, hours(g.minutes), null, null, null, g.amount])
      r.getCell(4).numFmt = '0.00'
      r.getCell(8).numFmt = money
    }
  }
  return wb
}

export async function statementToBuffer(st: Statement): Promise<ArrayBuffer> {
  return (await buildStatementWorkbook(st).xlsx.writeBuffer()) as ArrayBuffer
}
