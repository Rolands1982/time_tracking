/**
 * Other income: rent, investment returns, sales, benefits and the rest, recorded as of the end of a week so a
 * period's total income (billed work net in EUR plus this) can be read off one screen.
 */
import { db, type TimeTrackingDB } from './schema'
import type { IncomeCategory, OtherIncome } from './types'
import { weekRange } from '../lib/period'
import { todayIso } from '../lib/time'

export const INCOME_CATEGORIES: Record<IncomeCategory, string> = {
  rent: 'Rent',
  investment: 'Investments',
  sale: 'Sales of goods',
  benefit: 'Social benefits',
  other: 'Other',
}

export const INCOME_CATEGORY_KEYS = Object.keys(INCOME_CATEGORIES) as IncomeCategory[]

export interface OtherIncomeInput {
  date: string
  category: IncomeCategory
  amount: number
  currency?: string
  source?: string
  notes?: string
  importKey?: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

function build(input: OtherIncomeInput, existing?: OtherIncome): OtherIncome {
  const now = new Date().toISOString()
  return {
    ...existing,
    date: input.date,
    category: input.category,
    amount: round2(input.amount),
    currency: input.currency || existing?.currency || 'EUR',
    source: input.source?.trim() || undefined,
    notes: input.notes?.trim() ?? existing?.notes ?? '',
    importKey: input.importKey ?? existing?.importKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function addOtherIncome(input: OtherIncomeInput, database: TimeTrackingDB = db): Promise<number> {
  if (!input.date) throw new Error('Date is required')
  return (await database.otherIncome.add(build(input))) as number
}

export async function updateOtherIncome(id: number, input: OtherIncomeInput, database: TimeTrackingDB = db): Promise<void> {
  const existing = await database.otherIncome.get(id)
  if (!existing) throw new Error('Income row not found')
  await database.otherIncome.put({ ...build(input, existing), id })
}

export async function deleteOtherIncome(id: number, database: TimeTrackingDB = db): Promise<void> {
  await database.deleteSynced('otherIncome', id)
}

/** The Sunday of the week containing today: income is recorded as of the end of the week. */
export function defaultIncomeDate(today = todayIso()): string {
  return weekRange(today).to
}

export interface IncomeImportSummary {
  added: number
  duplicates: number
}

/** Store imported rows, skipping any whose importKey is already present (so a file can be imported again). */
export async function importOtherIncome(rows: OtherIncomeInput[], database: TimeTrackingDB = db): Promise<IncomeImportSummary> {
  const keys = rows.map((r) => r.importKey).filter((k): k is string => Boolean(k))
  const existing = new Set((await database.otherIncome.where('importKey').anyOf(keys).toArray()).map((o) => o.importKey))
  const seen = new Set<string>()
  const fresh: OtherIncome[] = []
  let duplicates = 0
  for (const r of rows) {
    if (r.importKey && (existing.has(r.importKey) || seen.has(r.importKey))) {
      duplicates++
      continue
    }
    if (r.importKey) seen.add(r.importKey)
    fresh.push(build(r))
  }
  if (fresh.length) await database.otherIncome.bulkAdd(fresh)
  return { added: fresh.length, duplicates }
}

export async function queryOtherIncome(range: { from?: string; to?: string }, database: TimeTrackingDB = db): Promise<OtherIncome[]> {
  const rows =
    range.from || range.to
      ? await database.otherIncome.where('date').between(range.from ?? '0000', range.to ?? '9999', true, true).toArray()
      : await database.otherIncome.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
}

export interface IncomeTotals {
  count: number
  total: number
  byCategory: Record<IncomeCategory, number>
}

export function incomeTotals(rows: OtherIncome[]): IncomeTotals {
  const byCategory = { rent: 0, investment: 0, sale: 0, benefit: 0, other: 0 }
  let total = 0
  for (const r of rows) {
    byCategory[r.category in byCategory ? r.category : 'other'] += r.amount
    total += r.amount
  }
  for (const k of INCOME_CATEGORY_KEYS) byCategory[k] = round2(byCategory[k])
  return { count: rows.length, total: round2(total), byCategory }
}
