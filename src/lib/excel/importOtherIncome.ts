/**
 * Import of the "weekly income" workbook: one sheet per month, row 1 holds the dates the figures were recorded
 * on (the end of each week), column A the names; every cell is the month-to-date total as of that date. Above
 * the first "Total" row are the clients (billed work, which the app already knows from the time entries); the
 * rows between the first and the second "Total" are the other income: rent, Mintos, "Citi" (other, details in
 * the cell note), benefits… Each row's figures are turned into the week's increment, recorded as of the column's
 * date, with the note lines that appeared in that column as the notes.
 */
import ExcelJS from 'exceljs'
import type { OtherIncomeInput } from '../../db/income'
import type { IncomeCategory } from '../../db/types'
import { cellDate, cellNumber, cellText } from './cells'

export interface ParsedIncome extends OtherIncomeInput {
  importKey: string
  sheet: string
  cell: string
  label: string
}

export interface IncomeSheetResult {
  name: string
  rows: number
  reason?: string
}

export interface IncomeParseResult {
  rows: ParsedIncome[]
  sheets: IncomeSheetResult[]
  warnings: string[]
}

const CATEGORY_WORDS: Record<IncomeCategory, string[]> = {
  rent: ['ire', 'rent', 'noma'],
  investment: ['mintos', 'investicijas', 'investments', 'investment', 'dividendes', 'dividends', 'procenti', 'interest'],
  sale: ['pardosana', 'pardots', 'sale', 'sales'],
  benefit: ['pabalsti', 'pabalsts', 'benefits', 'benefit', 'vsaa'],
  other: ['citi', 'cits', 'other', 'others', 'misc'],
}
/** Labels that only name the category; anything else (Mintos, a tenant) is kept as the source. */
const GENERIC = new Set(['ire', 'rent', 'noma', 'investicijas', 'investments', 'investment', 'pardosana', 'pardots', 'sale', 'sales', 'pabalsti', 'pabalsts', 'benefits', 'benefit', 'citi', 'cits', 'other', 'others', 'misc'])

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

export function incomeCategoryOf(label: string): IncomeCategory | undefined {
  const key = fold(label).replace(/\s*\(.*$/, '')
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [IncomeCategory, string[]][]) {
    if (words.some((w) => key === w || key.startsWith(`${w} `))) return cat
  }
  return undefined
}

/** Lines of a cell note, without the author line Excel puts first ("Name:"). */
function noteLines(cell: ExcelJS.Cell): string[] {
  const note = cell.note as string | { texts?: { text: string }[] } | undefined
  const text = note == null ? '' : typeof note === 'string' ? note : (note.texts ?? []).map((t) => t.text).join('')
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length && /:\s*$/.test(lines[0])) lines.shift()
  return lines
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function parseOtherIncomeWorkbook(data: ArrayBuffer | Uint8Array): Promise<IncomeParseResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data as ArrayBuffer)
  const result: IncomeParseResult = { rows: [], sheets: [], warnings: [] }
  for (const ws of wb.worksheets) {
    const dateCols: { col: number; date: string }[] = []
    for (let c = 2; c <= ws.columnCount; c++) {
      const date = cellDate(ws.getCell(1, c))
      if (date) dateCols.push({ col: c, date })
    }
    if (!dateCols.length) {
      result.sheets.push({ name: ws.name, rows: 0, reason: 'no dates in row 1' })
      continue
    }
    const totalRows: number[] = []
    for (let r = 2; r <= ws.rowCount; r++) if (fold(cellText(ws.getCell(r, 1))) === 'total') totalRows.push(r)
    if (!totalRows.length) {
      result.sheets.push({ name: ws.name, rows: 0, reason: 'no "Total" row' })
      continue
    }
    const from = totalRows[0] + 1
    const to = (totalRows[1] ?? ws.rowCount + 1) - 1
    let count = 0
    for (let r = from; r <= to; r++) {
      const label = cellText(ws.getCell(r, 1))
      if (!label) continue
      const category = incomeCategoryOf(label)
      const figures = dateCols.map(({ col, date }) => ({ col, date, value: cellNumber(ws.getCell(r, col)) }))
      if (!category) {
        const last = figures.filter((f) => f.value != null).pop()
        if (last?.value) result.warnings.push(`${ws.name}: "${label}" is not a known kind of income (${last.value} as of ${last.date}); add it by hand if it is income.`)
        continue
      }
      const source = GENERIC.has(fold(label).replace(/\s*\(.*$/, '')) ? undefined : label
      let previous = 0
      let previousLines: string[] = []
      for (const { col, date, value } of figures) {
        if (value == null) continue
        const amount = round2(value - previous)
        previous = value
        const cell = ws.getCell(r, col)
        const lines = noteLines(cell)
        const fresh = lines.filter((l) => !previousLines.includes(l))
        previousLines = lines
        if (amount === 0) continue
        result.rows.push({
          date,
          category,
          amount,
          currency: 'EUR',
          source,
          notes: fresh.join('; '),
          importKey: `income:${date}:${fold(label)}`,
          sheet: ws.name,
          cell: cell.address,
          label,
        })
        count++
      }
    }
    result.sheets.push({ name: ws.name, rows: count })
  }
  return result
}
