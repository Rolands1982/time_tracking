/** Customer summary as a one-sheet Excel workbook, with the columns the statement selects. */
import ExcelJS from 'exceljs'
import { describe, FILTER_LABELS, hours, invoiceText, type Statement, type StatementColumn, type StatementRow } from '../statement'
import { formatDate } from '../period'

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }
const TOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }

function excelDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

interface ColumnSpec {
  header: string
  width: number
  value: (r: StatementRow) => ExcelJS.CellValue
  numFmt?: string
  wrap?: boolean
}

function columnSpecs(st: Statement): Record<StatementColumn, ColumnSpec> {
  const money = `#,##0.00 "${st.currency}"`
  return {
    date: { header: 'Date', width: 12, value: (r) => excelDate(r.date), numFmt: 'dd.mm.yyyy' },
    time: { header: 'Time', width: 13, value: (r) => `${r.startTime}–${r.endTime}` },
    project: { header: 'Project', width: 22, value: (r) => r.project },
    category: { header: 'Category', width: 14, value: (r) => r.category ?? '' },
    description: { header: 'Description', width: 60, value: (r) => describe(r, st.columns), wrap: true },
    hours: { header: 'Hours', width: 8, value: (r) => hours(r.minutes), numFmt: '0.00' },
    rate: { header: 'Rate', width: 10, value: (r) => (r.billable ? r.rate : null), numFmt: money },
    amount: { header: 'Amount', width: 14, value: (r) => (r.billable ? r.amount : null), numFmt: money },
    invoice: { header: 'Invoice', width: 16, value: (r) => invoiceText(r, formatDate) },
  }
}

export function buildStatementWorkbook(st: Statement): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Time Tracking app'
  wb.created = new Date()
  const ws = wb.addWorksheet('Summary', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  const money = `#,##0.00 "${st.currency}"`
  const specs = columnSpecs(st)
  const cols = st.columns.map((key) => ({ key, ...specs[key] }))
  const colIndex = (key: StatementColumn) => cols.findIndex((c) => c.key === key) + 1 // 0 when hidden
  const letter = (i: number) => String.fromCharCode(64 + i)
  const width = Math.max(cols.length, 4)

  cols.forEach((c, i) => (ws.getColumn(i + 1).width = c.width))
  for (let i = cols.length; i < width; i++) ws.getColumn(i + 1).width = 14

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

  const header = ws.addRow(cols.map((c) => c.header))
  header.font = { bold: true }
  header.fill = HEADER_FILL
  const firstDataRow = header.number + 1
  for (const r of st.rows) {
    const row = ws.addRow(cols.map((c) => c.value(r)))
    cols.forEach((c, i) => {
      if (c.numFmt) row.getCell(i + 1).numFmt = c.numFmt
      if (c.wrap) row.getCell(i + 1).alignment = { wrapText: true, vertical: 'top' }
    })
    if (!r.billable) row.font = { italic: true, color: { argb: 'FF808080' } }
  }
  const lastDataRow = ws.rowCount

  const totalValues: ExcelJS.CellValue[] = cols.map(() => null)
  totalValues[0] = 'Total'
  const subtotal = (key: StatementColumn, result: number) => {
    const i = colIndex(key)
    if (!i) return
    totalValues[i - 1] = st.rows.length ? { formula: `SUBTOTAL(9,${letter(i)}${firstDataRow}:${letter(i)}${lastDataRow})`, result } : 0
  }
  subtotal('hours', hours(st.minutes + st.nonBillableMin))
  subtotal('amount', st.amount)
  const total = ws.addRow(totalValues)
  total.font = { bold: true }
  total.fill = TOTAL_FILL
  if (colIndex('hours')) total.getCell(colIndex('hours')).numFmt = '0.00'
  if (colIndex('amount')) total.getCell(colIndex('amount')).numFmt = money
  ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: lastDataRow, column: cols.length } }
  ws.views = [{ state: 'frozen', ySplit: header.number }]

  if (st.byProject.length > 1) {
    ws.addRow([])
    const h = ws.addRow(['By project', null, 'Hours', 'Amount'])
    h.font = { bold: true }
    h.fill = HEADER_FILL
    for (const g of st.byProject) {
      const r = ws.addRow([g.name, null, hours(g.minutes), g.amount])
      r.getCell(3).numFmt = '0.00'
      r.getCell(4).numFmt = money
    }
  }
  return wb
}

export async function statementToBuffer(st: Statement): Promise<ArrayBuffer> {
  return (await buildStatementWorkbook(st).xlsx.writeBuffer()) as ArrayBuffer
}
