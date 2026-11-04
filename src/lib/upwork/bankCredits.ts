/**
 * Bank credits → Upwork payouts. A bank export (CSV from the bank, or the rows a finance app exported) lists
 * what the bank received in EUR; each credit is matched to the Upwork withdrawal it paid out, which gives the
 * payout its EUR amount and so every entry it covered its real exchange rate.
 *
 * Matching rule, checked against ten years of real statements: the bank books a payout one to four days after
 * Upwork's withdrawal date (never before, never later than two weeks), payouts are weekly, and EUR ÷ USD is a
 * plausible exchange rate. The candidate whose rate is closest to the reference rate of the day wins.
 */
import type { UpworkTransaction } from '../../db/types'
import { addDays } from '../period'
import { payoutsOf, type Payout, type RateEstimate } from './allocate'

export interface BankCredit {
  /** YYYY-MM-DD booking date. */
  date: string
  /** EUR received. */
  amount: number
  description?: string
}

/** Header aliases (lower case) for the columns a statement or export may use. */
const DATE_HEADERS = ['date', 'datums', 'booking date', 'value date', 'valutēšanas datums']
const AMOUNT_HEADERS = ['amount', 'summa', 'eur', 'eur received', 'credit']
const TEXT_HEADERS = ['description', 'party', 'saņēmējs/maksātājs', 'informācija saņēmējam', 'details', 'memo', 'payer']
const DIRECTION_HEADERS = ['debets/kredīts', 'direction', 'type', 'd/k']

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
    } else if (ch === delimiter && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function detectDelimiter(header: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, header.split(d).length - 1] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

/** "2026-10-23", "23.10.2026", "23/10/2026" and ISO datetimes → YYYY-MM-DD; anything else → undefined. */
export function parseBankDate(raw: string): string | undefined {
  const s = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return undefined
}

function parseAmount(raw: string): number {
  const s = raw.replace(/\s/g, '').replace(/[€$]/g, '')
  // "1 234,56" / "1.234,56" → comma decimal; "1,234.56" → dot decimal.
  const normalized = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  return Number(normalized)
}

/** Read credits out of a CSV text. Rows naming Upwork are kept when any row does; debits are dropped. */
export function parseBankCredits(text: string): BankCredit[] {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
  if (lines.length < 2) return []
  const delimiter = detectDelimiter(lines[0])
  const header = splitLine(lines[0], delimiter).map((h) => h.toLowerCase())
  const col = (names: string[]) => header.findIndex((h) => names.includes(h))
  const dateCol = col(DATE_HEADERS)
  const amountCol = col(AMOUNT_HEADERS)
  if (dateCol < 0 || amountCol < 0) throw new Error('No date and amount columns found (expected headers like Date / Amount or Datums / Summa)')
  const textCols = header.map((h, i) => (TEXT_HEADERS.includes(h) ? i : -1)).filter((i) => i >= 0)
  const dirCol = col(DIRECTION_HEADERS)
  const rows: (BankCredit & { upwork: boolean })[] = []
  for (const line of lines.slice(1)) {
    const f = splitLine(line, delimiter)
    const date = parseBankDate(f[dateCol] ?? '')
    const amount = parseAmount(f[amountCol] ?? '')
    if (!date || !(amount > 0)) continue
    if (dirCol >= 0 && /^(d|dbit|debit|debets)$/i.test(f[dirCol] ?? '')) continue
    const description = textCols.map((i) => f[i]).filter(Boolean).join(' · ') || undefined
    rows.push({ date, amount: Math.round(amount * 100) / 100, description, upwork: /upwork/i.test(description ?? '') })
  }
  const named = rows.filter((r) => r.upwork)
  return (named.length ? named : rows).map(({ upwork: _u, ...r }) => r)
}

export interface BankMatch {
  credit: BankCredit
  payout: Payout
  rate: number
  /** True when the payout already carries this EUR amount. */
  already: boolean
}

export interface BankMatchReport {
  matches: BankMatch[]
  /** Credits with no plausible payout, each with the nearest earlier payout as a hint. */
  unmatched: { credit: BankCredit; nearest?: Payout; rate?: number }[]
}

const MAX_LAG_DAYS = 14
const RATE_MIN = 0.78
const RATE_MAX = 1.02

/** Pair credits with payouts (oldest first). `reference` gives the expected EUR per USD on a date, if known. */
export function matchBankCredits(credits: BankCredit[], payouts: Payout[], reference: RateEstimate = () => undefined): BankMatchReport {
  const taken = new Set<string>()
  const matches: BankMatch[] = []
  const unmatched: BankMatchReport['unmatched'] = []
  let running = 0.9
  for (const credit of [...credits].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount)) {
    const earliest = addDays(credit.date, -MAX_LAG_DAYS)
    const window = payouts.filter((p) => !taken.has(p.tx.txId) && p.tx.date <= credit.date && p.tx.date >= earliest && p.usd > 0)
    const ref = reference(credit.date) ?? running
    const candidates = window.map((p) => ({ p, rate: credit.amount / p.usd })).filter((c) => c.rate >= RATE_MIN && c.rate <= RATE_MAX)
    // A payout already priced only matches the credit that carries the same amount.
    const open = candidates.filter((c) => c.p.eurAmount == null || Math.abs(c.p.eurAmount - credit.amount) < 0.005)
    if (!open.length) {
      const nearest = window.sort((a, b) => b.tx.date.localeCompare(a.tx.date))[0]
      unmatched.push({ credit, nearest, rate: nearest ? Math.round((credit.amount / nearest.usd) * 1e4) / 1e4 : undefined })
      continue
    }
    open.sort((a, b) => Math.abs(a.rate - ref) - Math.abs(b.rate - ref))
    const best = open[0]
    taken.add(best.p.tx.txId)
    matches.push({ credit, payout: best.p, rate: Math.round(best.rate * 1e6) / 1e6, already: best.p.eurAmount != null && Math.abs(best.p.eurAmount - credit.amount) < 0.005 })
    running = running * 0.7 + best.rate * 0.3
  }
  return { matches, unmatched }
}

/** Convenience: payouts from the raw ledger, then the match. */
export function matchBankCreditsToLedger(credits: BankCredit[], transactions: UpworkTransaction[], reference?: RateEstimate): BankMatchReport {
  return matchBankCredits(credits, payoutsOf(transactions), reference)
}
