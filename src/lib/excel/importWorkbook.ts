/**
 * Parses the "one sheet per month" time sheets the app replaces, as well as
 * the app's own master-file export, into a flat list of entries.
 *
 * Recognised columns (matched by header text, case/space insensitive):
 *   Date | From/Start | Till/To/End | Total hours | Earned/Amount | Project |
 *   What is done?/Comments/Description | Category | When billed?/Billed | Invoice date | Client | Rate
 *
 * Rules learned from the existing workbooks:
 *   - a blank Date means "same day as the row above"
 *   - an end time of 1900-01-01 00:00 (Excel 24:00) means midnight at the end of the day
 *   - the hourly rate is the constant in the Earned formula (=D2*60), or Earned/Hours
 *   - "Billed 01/10/2023" in the billing column means billed on that invoice date
 */
import ExcelJS, { type Worksheet } from 'exceljs'
import { computeAmount, minutesToHm } from '../time'
import {
  cellDate,
  cellFormula,
  cellNumber,
  cellText,
  cellTimeMinutes,
  parseDateString,
  rateFromFormula,
} from './cells'

export interface ImportOptions {
  /** Client used for rows whose sheet has no Client column. */
  clientName: string
  /** Rate used when it cannot be derived from the sheet. */
  defaultRate: number
  /** Sheet names to ignore. */
  skipSheets?: string[]
}

export interface ParsedEntry {
  date: string
  startTime: string
  endTime: string
  durationMin: number
  hourlyRate: number
  amount: number
  client: string
  project?: string
  category?: string
  comments: string
  isBilled: boolean
  invoiceDate?: string
  invoiceRef?: string
  /** false when the row is marked as not to be invoiced. */
  billable?: boolean
  /** True when the sheet has a billing / invoice column at all (old sheets have none). */
  hasBillingInfo: boolean
  sheet: string
  row: number
  importKey: string
}

export interface SheetReport {
  name: string
  imported: number
  skipped: number
  reason?: string
}

export interface ParseResult {
  entries: ParsedEntry[]
  sheets: SheetReport[]
  warnings: string[]
}

type ColumnKey =
  | 'date'
  | 'start'
  | 'end'
  | 'hours'
  | 'earned'
  | 'project'
  | 'comments'
  | 'category'
  | 'billed'
  | 'invoiceDate'
  | 'client'
  | 'rate'
  | 'invoiceRef'
  | 'billable'

const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  date: ['date', 'datums', 'day'],
  start: ['from', 'start', 'start time', 'no', 'sākums'],
  end: ['till', 'to', 'end', 'end time', 'until', 'līdz', 'beigas'],
  hours: ['total hours', 'hours', 'duration', 'stundas', 'stundas kopā'],
  earned: ['earned', 'amount', 'total', 'sum', 'summa', 'summa (eur)', 'summa eur'],
  project: ['project', 'projekts'],
  comments: ['what is done?', 'what is done', 'comments', 'comment', 'description', 'task', 'notes', 'apraksts', 'kas tika izdarīts'],
  category: ['category', 'kategorija', 'type', 'projekta stadija', 'stadija'],
  billed: ['when billed?', 'when billed', 'billed', 'is billed', 'invoiced', 'rēķins', 'invoice'],
  invoiceDate: ['invoice date', 'invoiced on', 'rēķina datums'],
  client: ['client', 'customer', 'klients'],
  rate: ['rate', 'hourly rate', 'likme'],
  invoiceRef: ['invoice ref', 'invoice reference', 'invoice number', 'invoice no', 'rēķina nr', 'rēķina numurs'],
  billable: ['billable', 'piestādāms'],
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[:*]/g, '').trim()

function matchHeader(text: string): ColumnKey | null {
  const n = normalize(text)
  if (!n) return null
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColumnKey, string[]][]) {
    if (aliases.includes(n)) return key
  }
  return null
}

interface HeaderMap {
  row: number
  cols: Partial<Record<ColumnKey, number>>
}

/** Find the header row within the first rows of a sheet: it must contain Date, a start and an end column. */
function findHeader(ws: Worksheet): HeaderMap | null {
  const maxScan = Math.min(ws.rowCount, 10)
  for (let r = 1; r <= maxScan; r++) {
    const row = ws.getRow(r)
    const cols: Partial<Record<ColumnKey, number>> = {}
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = matchHeader(cellText(cell))
      if (key && cols[key] == null) cols[key] = col
    })
    if (cols.date != null && cols.start != null && cols.end != null) return { row: r, cols }
  }
  return null
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  janvāris: 1, februāris: 2, marts: 3, aprīlis: 4, maijs: 5, jūnijs: 6, jūlijs: 7, augusts: 8, septembris: 9, oktobris: 10, novembris: 11, decembris: 12,
  janvaris: 1, februaris: 2, aprilis: 4, junijs: 6, julijs: 7,
}

/** "Aprīlis 2024" / "April 2024" → last day of that month, or null. */
export function parseMonthLabel(text: string): string | null {
  const m = /^([\p{L}]+)\.?\s+(\d{4})$/u.exec(text.trim())
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const year = Number(m[2])
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

const NOT_BILLED = new Set(['no', 'false', 'n', 'nē', '0', 'not billed', 'unbilled', 'open', '-'])
const NON_BILLABLE = new Set(['nepiestādāmas', 'nepiestadamas', 'non-billable', 'not billable', 'free', 'bez maksas', 'n/a'])

export interface BilledInfo {
  isBilled: boolean
  invoiceDate?: string
  invoiceRef?: string
  billable?: boolean
}

/**
 * Interprets a billing cell: "Billed 01/10/2023", "Aprīlis 2024", "yes", "x", a date, "Nepiestādāmas" (never billed).
 * An explicit invoice-date column wins over a date found in the text.
 */
export function parseBilled(text: string, invoiceDateText?: string): BilledInfo {
  const explicitDate = invoiceDateText ? parseDateString(invoiceDateText) : null
  const t = text.trim()
  if (!t && !explicitDate) return { isBilled: false }
  const lower = t.toLowerCase()
  if (NOT_BILLED.has(lower)) return { isBilled: false }
  if (NON_BILLABLE.has(lower)) return { isBilled: false, billable: false }
  const monthEnd = parseMonthLabel(t)
  const inText = monthEnd ?? parseDateString(t.replace(/^[^\d]*/, ''))
  const invoiceDate = explicitDate ?? inText ?? undefined
  // Keep the original label when it is more than a plain yes/date, e.g. an invoice number or "Aprīlis 2024".
  const plain = /^(yes|y|true|x|jā|billed|1)$/i.test(t) || (!monthEnd && inText != null && /^(billed\s*)?[\d./-]+$/i.test(t))
  return { isBilled: true, invoiceDate, invoiceRef: plain || !t ? undefined : t }
}

export function makeImportKey(e: {
  date: string
  startTime: string
  endTime: string
  client: string
  project?: string
  comments: string
}): string {
  return [e.date, e.startTime, e.endTime, e.client, e.project ?? '', e.comments]
    .map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|')
}

function parseSheet(ws: Worksheet, opts: ImportOptions, warnings: string[]): { entries: ParsedEntry[]; report: SheetReport } {
  const header = findHeader(ws)
  const report: SheetReport = { name: ws.name, imported: 0, skipped: 0 }
  const entries: ParsedEntry[] = []
  if (!header) {
    report.reason = 'no Date/From/Till header found'
    return { entries, report }
  }
  const c = header.cols
  let carriedDate: string | null = null
  let sheetRate: number | null = null

  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const dateCell = row.getCell(c.date!)
    const startMin = cellTimeMinutes(row.getCell(c.start!))
    const endMin = cellTimeMinutes(row.getCell(c.end!))
    const rowDate = cellDate(dateCell)
    const label = cellText(dateCell).toLowerCase()

    if (label === 'total' || label.startsWith('total')) break
    if (rowDate) carriedDate = rowDate

    if (startMin == null && endMin == null) continue // empty / formula-only row
    if (startMin == null || endMin == null || !carriedDate) {
      report.skipped++
      warnings.push(`${ws.name}!${r}: incomplete row (date/start/end) skipped`)
      continue
    }

    const startTime = minutesToHm(startMin)
    let endTime = minutesToHm(endMin)
    let durationMin = endMin - startMin
    if (durationMin <= 0) durationMin += 1440
    if (durationMin <= 0 || durationMin > 1440) {
      report.skipped++
      warnings.push(`${ws.name}!${r}: invalid time range ${startTime}–${endTime} skipped`)
      continue
    }

    // Hours typed directly into the sheet (not a formula) override the start/end times:
    // they are what was actually invoiced, so keep them and move the end time to match.
    if (c.hours != null) {
      const hoursCell = row.getCell(c.hours)
      const typedHours = cellFormula(hoursCell, ws) == null ? cellNumber(hoursCell) : null
      if (typedHours != null && typedHours > 0) {
        const typedMin = Math.round(typedHours * 60)
        if (Math.abs(typedMin - durationMin) >= 1 && typedMin <= 1440) {
          warnings.push(
            `${ws.name}!${r}: hours typed in sheet (${typedHours}) differ from ${startTime}–${endTime}; using ${typedHours} h`,
          )
          durationMin = typedMin
          endTime = minutesToHm(startMin + typedMin)
        }
      }
    }

    // Rate: explicit column, Earned formula constant, Earned/Hours, previously seen sheet rate, default.
    let rate: number | null = c.rate != null ? cellNumber(row.getCell(c.rate)) : null
    if (rate == null && c.earned != null) {
      rate = rateFromFormula(cellFormula(row.getCell(c.earned), ws))
      if (rate == null) {
        const earned = cellNumber(row.getCell(c.earned))
        const hours = c.hours != null ? cellNumber(row.getCell(c.hours)) : durationMin / 60
        if (earned != null && hours && hours > 0) rate = Math.round((earned / hours) * 100) / 100
      }
    }
    // Some sheets put the money formula under the "Total hours" header: (C2-B2)*24*80 → rate 80.
    if (rate == null && c.hours != null) {
      const f = cellFormula(row.getCell(c.hours), ws)
      if (f && /\*\s*24\s*\*\s*\d/.test(f)) rate = rateFromFormula(f)
    }
    if (rate != null) sheetRate = rate
    const hourlyRate = rate ?? sheetRate ?? opts.defaultRate

    const client = (c.client != null ? cellText(row.getCell(c.client)) : '') || opts.clientName
    const project = c.project != null ? cellText(row.getCell(c.project)) || undefined : undefined
    const category = c.category != null ? cellText(row.getCell(c.category)) || undefined : undefined
    const comments = c.comments != null ? cellText(row.getCell(c.comments)) : ''
    const billed = parseBilled(
      c.billed != null ? cellText(row.getCell(c.billed)) : '',
      c.invoiceDate != null ? cellText(row.getCell(c.invoiceDate)) : undefined,
    )
    if (c.invoiceRef != null) {
      const ref = cellText(row.getCell(c.invoiceRef))
      if (ref) {
        billed.isBilled = true
        billed.invoiceRef = ref
      }
    }
    if (c.billable != null) {
      const flag = cellText(row.getCell(c.billable)).toLowerCase()
      if (NOT_BILLED.has(flag) || NON_BILLABLE.has(flag)) billed.billable = false
    }

    const base = { date: carriedDate, startTime, endTime, client, project, comments }
    entries.push({
      ...base,
      durationMin,
      hourlyRate,
      amount: computeAmount(durationMin, hourlyRate),
      category,
      isBilled: billed.isBilled,
      invoiceDate: billed.invoiceDate,
      invoiceRef: billed.invoiceRef,
      billable: billed.billable,
      hasBillingInfo: c.billed != null || c.invoiceDate != null || c.invoiceRef != null,
      sheet: ws.name,
      row: r,
      importKey: makeImportKey(base),
    })
    report.imported++
  }
  return { entries, report }
}

/** Parse every sheet of a workbook given as ArrayBuffer (browser) or Buffer (Node). */
export async function parseWorkbook(data: ArrayBuffer | Uint8Array, opts: ImportOptions): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data as never)
  const result: ParseResult = { entries: [], sheets: [], warnings: [] }
  const skip = new Set((opts.skipSheets ?? []).map((s) => s.toLowerCase()))
  wb.eachSheet((ws) => {
    if (skip.has(ws.name.toLowerCase())) {
      result.sheets.push({ name: ws.name, imported: 0, skipped: 0, reason: 'skipped by user' })
      return
    }
    const { entries, report } = parseSheet(ws, opts, result.warnings)
    result.entries.push(...entries)
    result.sheets.push(report)
  })
  return result
}

/**
 * Old sheets carry no billing column although everything in them was invoiced long ago.
 * Marks such rows dated before `isoDate` as billed (without an invoice date). Returns the number changed.
 */
export function applyBilledBefore(entries: ParsedEntry[], isoDate: string): number {
  let n = 0
  for (const e of entries) {
    if (!e.hasBillingInfo && !e.isBilled && e.billable !== false && e.date < isoDate) {
      e.isBilled = true
      n++
    }
  }
  return n
}

export { guessClientName } from './guessClientName'
