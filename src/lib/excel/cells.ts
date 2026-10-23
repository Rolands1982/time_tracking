/**
 * Low level helpers for reading ExcelJS cell values of unknown shape.
 * ExcelJS returns Dates for date/time formatted cells (as UTC), plain numbers,
 * strings, rich text objects, and {formula, result} objects for formulas.
 */
import type { Cell, CellValue, Worksheet } from 'exceljs'

const pad2 = (n: number) => String(n).padStart(2, '0')

type FormulaLike = { formula?: string; sharedFormula?: string; result?: CellValue }
type RichTextLike = { richText: { text: string }[] }

function isFormula(v: unknown): v is FormulaLike {
  return typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v)
}
function isRichText(v: unknown): v is RichTextLike {
  return typeof v === 'object' && v !== null && 'richText' in v
}

/** Unwrap formula results / rich text so callers only deal with primitives and Dates. */
export function rawValue(v: CellValue | undefined): string | number | boolean | Date | null {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (isFormula(v)) return rawValue(v.result as CellValue)
  if (isRichText(v)) return v.richText.map((r) => r.text).join('')
  if (typeof v === 'object' && 'error' in v) return null
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text)
  return String(v)
}

export function cellText(cell: Cell | undefined): string {
  const v = rawValue(cell?.value)
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  return String(v).trim()
}

/** Formula text for a cell, resolving shared formulas to their master cell. */
export function cellFormula(cell: Cell | undefined, ws: Worksheet): string | undefined {
  const v = cell?.value
  if (!isFormula(v)) return undefined
  if (v.formula) return v.formula
  if (v.sharedFormula) {
    const master = ws.getCell(v.sharedFormula).value
    if (isFormula(master) && master.formula) return master.formula
  }
  return undefined
}

/** Convert an Excel serial date number (1900 system) to a UTC Date. */
export function serialToDate(serial: number): Date {
  // Excel day 1 = 1900-01-01, with the Lotus 1-2-3 leap year bug: day 60 = 1900-02-29.
  const epoch = Date.UTC(1899, 11, 30)
  return new Date(epoch + Math.round(serial * 86_400_000))
}

/** "YYYY-MM-DD" from a cell holding a date, a serial number, or a date-like string. */
export function cellDate(cell: Cell | undefined): string | null {
  const v = rawValue(cell?.value)
  if (v == null || v === '') return null
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`
  }
  if (typeof v === 'number') {
    if (v < 1000) return null
    const d = serialToDate(v)
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  }
  if (typeof v === 'string') return parseDateString(v)
  return null
}

/** Parse "dd/mm/yyyy", "dd.mm.yyyy", "yyyy-mm-dd" or "yyyy.mm.dd" into "YYYY-MM-DD". */
export function parseDateString(s: string): string | null {
  const t = s.trim()
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(t)
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(t)
  if (m) return `${m[3]}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`
  const d = new Date(t)
  if (!Number.isNaN(d.getTime()) && /\d{4}/.test(t)) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
  return null
}

/**
 * Minutes since midnight from a time cell.
 * Returns 1440 for an "end of day" midnight (Excel value 1.0, shown as 24:00 or 0:00 of the next day).
 */
export function cellTimeMinutes(cell: Cell | undefined): number | null {
  const v = rawValue(cell?.value)
  if (v == null || v === '') return null
  if (v instanceof Date) {
    const dayOffset = Math.floor((v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000)
    const mins = v.getUTCHours() * 60 + v.getUTCMinutes()
    // A time cell holding a whole later day (e.g. 1900-01-01 00:00) is "midnight at the end of the day".
    if (dayOffset >= 1 && mins === 0 && v.getUTCFullYear() < 1905) return 1440
    return mins
  }
  if (typeof v === 'number') {
    if (v === 1) return 1440
    const frac = v - Math.floor(v)
    return Math.round(frac * 1440)
  }
  if (typeof v === 'string') {
    const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(v.trim())
    if (!m) return null
    let h = Number(m[1])
    const mi = Number(m[2])
    if (m[3]) {
      const pm = m[3].toLowerCase() === 'pm'
      if (h === 12) h = pm ? 12 : 0
      else if (pm) h += 12
    }
    if (h === 24 && mi === 0) return 1440
    if (h > 23 || mi > 59) return null
    return h * 60 + mi
  }
  return null
}

export function cellNumber(cell: Cell | undefined): number | null {
  const v = rawValue(cell?.value)
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.').replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) && v.trim() !== '' ? n : null
  }
  return null
}

/** Extract the constant multiplier from formulas such as "D2*60" or "IF(ISBLANK(B3),"",D3*50)". */
export function rateFromFormula(formula: string | undefined): number | null {
  if (!formula) return null
  const m = /\*\s*(\d+(?:[.,]\d+)?)\s*\)*\s*$/.exec(formula.trim())
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
