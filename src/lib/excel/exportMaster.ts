/**
 * Builds the single "master file" workbook: every entry on one sheet plus
 * summary sheets. Works from plain arrays so it can run in the browser and in
 * the Node merge script alike.
 */
import ExcelJS from 'exceljs'
import type { Client, Project, TimeEntry } from '../../db/types'
import { billedMinutes, isBillable, sortedRates } from '../../db/repo'
import { hmToMinutes, monthKey } from '../time'

export interface MasterData {
  entries: TimeEntry[]
  clients: Client[]
  projects: Project[]
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }

function excelDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Time as a fraction of a day, in the same convention as the original sheets (midnight end = 1.0). */
function excelTime(hm: string, wrapAfter?: string): number {
  let min = hmToMinutes(hm)
  if (wrapAfter != null && min <= hmToMinutes(wrapAfter)) min += 1440
  return min / 1440
}

function styleHeader(ws: ExcelJS.Worksheet, widths: number[]) {
  const row = ws.getRow(1)
  row.font = { bold: true }
  row.fill = HEADER_FILL
  row.alignment = { vertical: 'middle' }
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w))
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

export function buildMasterWorkbook(data: MasterData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Time Tracking app'
  wb.created = new Date()

  const clientName = new Map(data.clients.map((c) => [c.id, c.name]))
  const projectName = new Map(data.projects.map((p) => [p.id, p.name]))
  const currency = data.clients[0]?.currency ?? 'EUR'
  const entries = [...data.entries].sort((a, b) =>
    a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
  )

  // ------------------------------------------------------------------ Entries
  const ws = wb.addWorksheet('Entries')
  ws.addRow([
    'Date',
    'Start',
    'End',
    'Hours',
    'Billed hours',
    'Client',
    'Project',
    'Category',
    'Hourly rate',
    'Amount',
    'Comments',
    'Billed',
    'Invoice date',
    'Invoice ref',
    'Billable',
    'Source',
    'ID',
  ])
  styleHeader(ws, [12, 8, 8, 8, 10, 18, 16, 12, 11, 11, 60, 8, 12, 14, 9, 8, 6])
  entries.forEach((e, i) => {
    const r = i + 2
    const row = ws.addRow([
      excelDate(e.date),
      excelTime(e.startTime),
      excelTime(e.endTime, e.startTime),
      { formula: `(C${r}-B${r})*24`, result: Math.round((e.durationMin / 60) * 10000) / 10000 },
      Math.round((billedMinutes(e) / 60) * 10000) / 10000,
      clientName.get(e.clientId) ?? '',
      e.projectId != null ? (projectName.get(e.projectId) ?? '') : '',
      e.category ?? '',
      e.hourlyRate,
      { formula: `E${r}*I${r}`, result: e.amount },
      e.comments,
      e.isBilled ? 'Yes' : 'No',
      e.invoiceDate ? excelDate(e.invoiceDate) : null,
      e.invoiceRef ?? '',
      isBillable(e) ? 'Yes' : 'No',
      e.source,
      e.id ?? null,
    ])
    row.getCell(1).numFmt = 'yyyy-mm-dd'
    row.getCell(2).numFmt = 'hh:mm'
    row.getCell(3).numFmt = 'hh:mm'
    row.getCell(4).numFmt = '0.00'
    row.getCell(5).numFmt = '0.00'
    row.getCell(9).numFmt = '#,##0.00'
    row.getCell(10).numFmt = '#,##0.00'
    row.getCell(13).numFmt = 'yyyy-mm-dd'
    row.getCell(11).alignment = { wrapText: false }
  })
  const last = entries.length + 1
  if (entries.length) {
    ws.autoFilter = { from: 'A1', to: `Q${last}` }
    const total = ws.addRow(['Total', null, null, { formula: `SUM(D2:D${last})` }, { formula: `SUM(E2:E${last})` }, null, null, null, null, { formula: `SUM(J2:J${last})` }])
    total.font = { bold: true }
    total.getCell(4).numFmt = '0.00'
    total.getCell(5).numFmt = '0.00'
    total.getCell(10).numFmt = '#,##0.00'
  }

  // ------------------------------------------------------------------ Summaries
  const addSummary = (
    name: string,
    keyLabel: string,
    keyOf: (e: TimeEntry) => string,
    sortKeys?: (a: string, b: string) => number,
  ) => {
    const sheet = wb.addWorksheet(name)
    sheet.addRow([keyLabel, 'Entries', 'Hours', 'Billed hours', `Amount (${currency})`, 'Billed', 'Unbilled', 'Unbilled hours'])
    styleHeader(sheet, [26, 9, 10, 12, 14, 14, 14, 14])
    const groups = new Map<string, TimeEntry[]>()
    for (const e of entries) {
      const k = keyOf(e)
      groups.set(k, [...(groups.get(k) ?? []), e])
    }
    const keys = [...groups.keys()].sort(sortKeys)
    for (const k of keys) {
      const g = groups.get(k)!
      const hours = g.reduce((s, e) => s + e.durationMin, 0) / 60
      const billedHours = g.reduce((s, e) => s + billedMinutes(e), 0) / 60
      const amount = g.reduce((s, e) => s + e.amount, 0)
      const billed = g.filter((e) => e.isBilled).reduce((s, e) => s + e.amount, 0)
      const unbilledMin = g.filter((e) => !e.isBilled && isBillable(e)).reduce((s, e) => s + billedMinutes(e), 0)
      const unbilled = g.filter((e) => !e.isBilled && isBillable(e)).reduce((s, e) => s + e.amount, 0)
      const row = sheet.addRow([k, g.length, hours, billedHours, amount, billed, unbilled, unbilledMin / 60])
      ;[3, 4, 8].forEach((c) => (row.getCell(c).numFmt = '0.00'))
      ;[5, 6, 7].forEach((c) => (row.getCell(c).numFmt = '#,##0.00'))
    }
    if (keys.length) {
      const n = keys.length + 1
      const total = sheet.addRow([
        'Total',
        { formula: `SUM(B2:B${n})` },
        { formula: `SUM(C2:C${n})` },
        { formula: `SUM(D2:D${n})` },
        { formula: `SUM(E2:E${n})` },
        { formula: `SUM(F2:F${n})` },
        { formula: `SUM(G2:G${n})` },
        { formula: `SUM(H2:H${n})` },
      ])
      total.font = { bold: true }
      ;[3, 4, 8].forEach((c) => (total.getCell(c).numFmt = '0.00'))
      ;[5, 6, 7].forEach((c) => (total.getCell(c).numFmt = '#,##0.00'))
    }
  }
  addSummary('By month', 'Month', (e) => monthKey(e.date))
  addSummary('By client', 'Client', (e) => clientName.get(e.clientId) ?? '')
  addSummary(
    'By client & project',
    'Client / Project',
    (e) => `${clientName.get(e.clientId) ?? ''} / ${e.projectId != null ? (projectName.get(e.projectId) ?? '') : '-'}`,
  )
  addSummary('By invoice', 'Invoice', (e) =>
    e.isBilled ? (e.invoiceRef ? `${e.invoiceDate ?? ''} ${e.invoiceRef}`.trim() : (e.invoiceDate ?? 'billed, no date')) : isBillable(e) ? 'NOT BILLED' : 'NON-BILLABLE',
  )

  // ------------------------------------------------------------------ Clients
  const cs = wb.addWorksheet('Clients')
  cs.addRow(['Client', 'Default rate', 'Rate changes', 'Currency', 'Email', 'Business name', 'Registration no.', 'VAT no.', 'VAT', 'Address', 'Notes', 'Projects'])
  styleHeader(cs, [24, 12, 28, 10, 28, 28, 16, 16, 6, 36, 40, 40])
  for (const c of data.clients) {
    cs.addRow([
      c.name,
      c.defaultRate,
      sortedRates(c)
        .map((r) => `${r.rate} from ${r.from}`)
        .join('; '),
      c.currency,
      c.email ?? '',
      c.businessName ?? '',
      c.registrationNumber ?? '',
      c.vatNumber ?? '',
      c.vatApplicable == null ? '' : c.vatApplicable ? 'Yes' : 'No',
      c.address ?? '',
      c.notes ?? '',
      data.projects
        .filter((p) => p.clientId === c.id)
        .map((p) => p.name)
        .join(', '),
    ])
  }
  return wb
}

export async function masterWorkbookToBuffer(data: MasterData): Promise<ArrayBuffer> {
  const wb = buildMasterWorkbook(data)
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
