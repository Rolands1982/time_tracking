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
import { cellDate, cellNumber, cellText, rawValue } from './cells'

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

/** One line of a cell note: the text as written and the amount it names, when it names one. */
export interface NoteLine {
  text: string
  amount?: number
  /** What the line was worth last time it was counted (a line without an amount gets its share of an increase). */
  worth?: number
  /** The line was there last week with another amount; `amount` is the difference. */
  changed?: boolean
}

const NUM = String.raw`\d+(?:[.,]\d+)?`
/** "120", "25 EUR", "~30", "100.5 + 20.25" (sums are added up). */
const SUM = String.raw`~?\s*(${NUM}(?:\s*\+\s*${NUM})*)\s*(?:eur|€)?`
const LEADING = new RegExp(String.raw`^${SUM}(?:\s*[-–—:]\s*|\s+)(?=\S)`, 'i')
const TRAILING = new RegExp(String.raw`^(.*?\S)\s*[-–—:]\s*${SUM}(?![\d.,])(?!\s*(?:eur|€)?\s*\/)`, 'i')
const addUp = (expr: string) => round2(expr.split('+').reduce((s, x) => s + Number(x.trim().replace(',', '.')), 0))

/**
 * The amount a note line names: "120 - Pabalsts", "25 EUR - pārdoti zābaki", "18.03 Akciju dividendes",
 * "Noguldījuma procenti - 10.5", "Apavu pārdošana - 15 + 15". A rate such as "~30 EUR/dienā" is not an
 * amount, and neither is a name such as "22.lv".
 */
export function parseNoteLine(text: string): NoteLine {
  const t = text.trim()
  const leading = LEADING.exec(t)
  if (leading) return { text: t, amount: addUp(leading[1]) }
  const trailing = TRAILING.exec(t)
  if (trailing) return { text: t, amount: addUp(trailing[2]) }
  return { text: t }
}

/** Kind of income a note line describes; `fallback` when its words say nothing. Order matters. */
export function incomeCategoryOfText(text: string, fallback: IncomeCategory): IncomeCategory {
  const t = fold(text)
  // State support first: "procentu kompensācija" is a mortgage interest subsidy, not an investment return.
  if (/(pabalst|atbalst|kompensacij|vsaa|benefit|bezdarb)/.test(t)) return 'benefit'
  if (/(dividend|procent|noguldij|depozit|mintos|obligacij|uzkraj|akcij|interest)/.test(t)) return 'investment'
  if (/(nodok|tax|atmaks|parmaks|atgriez)/.test(t)) return 'other'
  if (/(slimib|sick)/.test(t)) return 'benefit'
  if (/(pardot|pardos|pardev|viensviens|ss\.lv|sold|\bsale)/.test(t)) return 'sale'
  // Used things sold on: children's clothes, shoes, furniture, devices.
  if (/(zabak|apav|kombinezon|jaka|bikses|uzvalk|kresl|plaukt|galds|galdin|skapit|kumod|velosiped|skuter|skrejriten|gultin|telefon|dator|router|slidas|\bsom[au]|sedeklit|kengursom|kedin|kapslit|buci)/.test(t)) return 'sale'
  return fallback
}

/** The words of a line without its amounts, to recognise a line whose amount changed or that was reworded slightly. */
function words(text: string): Set<string> {
  return new Set(
    fold(text)
      .replace(/[\d.,+~€%]+/g, ' ')
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length > 2 && w !== 'eur'),
  )
}
const sameText = (a: string, b: string) => fold(a).replace(/\s+/g, ' ') === fold(b).replace(/\s+/g, ' ')
function sameDescription(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)]
  if (!x.size || !y.size) return false
  const [small, big] = x.size <= y.size ? [x, y] : [y, x]
  return [...small].every((w) => big.has(w))
}

/**
 * What is new in this week's note compared with last week's. A line with the same text is old; a line with the
 * same description and a different amount contributes the difference; a reworded line with the same amount is
 * old. Lines carry their `worth` over, so a line without an amount that later gets one only adds the difference.
 */
export function newNoteLines(previous: NoteLine[], current: NoteLine[]): NoteLine[] {
  const left = [...previous]
  const take = (i: number) => left.splice(i, 1)[0]
  const fresh: NoteLine[] = []
  const pending: NoteLine[] = []
  for (const line of current) {
    const i = left.findIndex((p) => sameText(p.text, line.text))
    if (i >= 0) line.worth = take(i).worth ?? line.amount
    else pending.push(line)
  }
  for (const line of pending) {
    const i = left.findIndex((p) => sameDescription(p.text, line.text))
    if (i >= 0) {
      const before = take(i).worth
      if (line.amount == null) line.worth = before
      else {
        line.worth = line.amount
        const delta = round2(line.amount - (before ?? 0))
        if (delta !== 0) fresh.push({ text: line.text, amount: delta, worth: line.amount, changed: true })
      }
      continue
    }
    const j = line.amount == null ? -1 : left.findIndex((p) => p.amount != null && Math.abs(p.amount - line.amount!) < 0.005)
    if (j >= 0) {
      take(j)
      line.worth = line.amount
      continue
    }
    line.worth = line.amount
    fresh.push(line)
  }
  return fresh
}

export interface WeekPart {
  category: IncomeCategory
  amount: number
  notes: string
}

export interface WeekSplit {
  parts: WeekPart[]
  /** Set when the note does not explain the increase; the parts are then a best effort to review. */
  problem?: string
}

/** Subset of the amounts that adds up to `target` (a few lines at most, so brute force is fine). */
function subsetSum(amounts: number[], target: number): number[] | null {
  const n = Math.min(amounts.length, 12)
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += amounts[i]
    if (Math.abs(sum - target) < 0.01) return [...Array(n).keys()].filter((i) => mask & (1 << i))
  }
  return null
}

/** Differences up to this much between the note and the figure are rounding; the largest part absorbs them. */
const ROUNDING = 0.5

/**
 * Split one week's increase by the new lines of its note: a line with an amount gets that amount, the line(s)
 * without an amount share what is left (all of it when no line names an amount), each line its own kind. A single
 * line without an amount remembers its share in `worth`, so a later amount on it only adds the difference.
 */
export function splitWeek(increase: number, lines: NoteLine[], fallback: IncomeCategory, classify: boolean): WeekSplit {
  const kind = (text: string) => (classify ? incomeCategoryOfText(text, fallback) : fallback)
  const part = (amount: number, texts: string[]): WeekPart => ({ category: kind(texts.join(' ')), amount: round2(amount), notes: texts.join('; ') })
  if (!lines.length) return { parts: [{ category: fallback, amount: increase, notes: '' }] }
  const priced = lines.filter((l) => l.amount != null)
  const bare = lines.filter((l) => l.amount == null)
  const pricedSum = round2(priced.reduce((s, l) => s + l.amount!, 0))
  const rest = round2(increase - pricedSum)
  const pricedParts = priced.map((l) => part(l.amount!, [l.text]))
  if (bare.length && rest > 0) {
    if (bare.length === 1) bare[0].worth = rest
    return { parts: [...pricedParts, part(rest, bare.map((l) => l.text))] }
  }
  if (!bare.length && Math.abs(rest) <= ROUNDING && pricedParts.length) {
    const largest = pricedParts.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a))
    largest.amount = round2(largest.amount + rest)
    return { parts: pricedParts }
  }
  if (!bare.length && rest > 0) {
    return {
      parts: [...pricedParts, { category: fallback, amount: rest, notes: '' }],
      problem: `the note explains ${pricedSum} of ${increase}; the rest (${rest}) is imported without a note`,
    }
  }
  // The new lines name more than the increase: some are probably corrections of earlier weeks.
  const subset = subsetSum(priced.map((l) => l.amount!), increase)
  if (subset) return { parts: subset.map((i) => pricedParts[i]) }
  // One line changed its amount: its earlier share was probably counted differently, so it takes what is left.
  const changed = priced.filter((l) => l.changed)
  if (changed.length === 1 && !bare.length) {
    const others = round2(pricedSum - changed[0].amount!)
    const left = round2(increase - others)
    if (left > 0) {
      const i = priced.indexOf(changed[0])
      pricedParts[i].amount = left
      return { parts: pricedParts, problem: `"${changed[0].text}" changed by ${changed[0].amount}; ${left} of it is counted this week so the lines add up to ${increase}` }
    }
  }
  return {
    parts: [{ category: fallback, amount: increase, notes: lines.map((l) => l.text).join('; ') }],
    problem: `the note's new amounts (${pricedSum}) do not add up to the increase (${increase}); imported as one row with the whole note`,
  }
}

/**
 * Row 1 dates with a slip in the year (a December sheet with "31.12.2022" instead of 2021): a date more than 40 days
 * from the sheet's middle date that lands within 40 days of it with the middle date's year is taken in that year.
 */
function fixHeaderYears(cols: { col: number; date: string }[], sheet: string, warnings: string[]): void {
  const days = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
  const middle = [...cols].map((c) => c.date).sort()[Math.floor(cols.length / 2)]
  for (const c of cols) {
    if (Math.abs(days(c.date) - days(middle)) <= 40) continue
    const fixed = `${middle.slice(0, 4)}${c.date.slice(4)}`
    if (Math.abs(days(fixed) - days(middle)) <= 40) {
      warnings.push(`${sheet}: the date ${c.date} in row 1 is read as ${fixed} (the sheet's other dates are around ${middle}).`)
      c.date = fixed
    }
  }
}

export async function parseOtherIncomeWorkbook(data: ArrayBuffer | Uint8Array): Promise<IncomeParseResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data as ArrayBuffer)
  const result: IncomeParseResult = { rows: [], sheets: [], warnings: [] }
  for (const ws of wb.worksheets) {
    const dateCols: { col: number; date: string }[] = []
    for (let c = 2; c <= ws.columnCount; c++) {
      // Only real dates: the sheets keep helper figures in row 1 too, and a number is not a week-end date.
      const head = rawValue(ws.getCell(1, c).value)
      const date = head instanceof Date || typeof head === 'string' ? cellDate(ws.getCell(1, c)) : null
      if (date) dateCols.push({ col: c, date })
    }
    if (!dateCols.length) {
      result.sheets.push({ name: ws.name, rows: 0, reason: 'no dates in row 1' })
      continue
    }
    fixHeaderYears(dateCols, ws.name, result.warnings)
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
      let previousLines: NoteLine[] = []
      for (const { col, date, value } of figures) {
        if (value == null) continue
        const increase = round2(value - previous)
        previous = value
        const cell = ws.getCell(r, col)
        const lines = noteLines(cell).map(parseNoteLine)
        // A week without a note keeps last week's lines as the reference for the next note.
        const fresh = lines.length ? newNoteLines(previousLines, lines) : []
        if (lines.length) previousLines = lines
        if (increase === 0) continue
        // Only the catch-all rows ("Citi") are split by kind; a rent or Mintos note just describes that income.
        const split = splitWeek(increase, fresh, category, category === 'other')
        if (split.problem) result.warnings.push(`${ws.name} ${cell.address} (${date}): ${split.problem}.`)
        // The cell identifies the figure (two columns can carry the same date); a re-import finds the same keys.
        const base = `income:${ws.name}!${cell.address}`
        split.parts.forEach((p, i) => {
          result.rows.push({
            date,
            category: p.category,
            amount: p.amount,
            currency: 'EUR',
            source,
            notes: p.notes,
            importKey: split.parts.length > 1 ? `${base}#${i + 1}` : base,
            sheet: ws.name,
            cell: cell.address,
            label,
          })
          count++
        })
      }
    }
    result.sheets.push({ name: ws.name, rows: count })
  }
  return result
}
