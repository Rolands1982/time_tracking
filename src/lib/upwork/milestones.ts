/**
 * Fixed-price milestones and bonuses: Upwork invoices them without hours, so no time row (and no entry) exists.
 * The hours are suggested from the amount at the client's rate (else a default rate), corrected by the user on
 * the "Upwork milestones" screen, and the app creates one entry per row, keyed `upwork:milestone:<txId>`, with
 * `estimatedHours: true`; fees and payouts then settle it like hourly work (allocate.ts matches it to its
 * invoice row by id). Zero hours are allowed: the money still counts.
 */
import { addEntry, rateFor } from '../../db/repo'
import { db, type TimeTrackingDB } from '../../db/schema'
import type { Client, Project, TimeEntry, UpworkTransaction } from '../../db/types'
import { minutesToHm } from '../time'
import { linkFees } from './allocate'
import { milestoneKey, milestoneTxId } from './keys'

export { MILESTONE_PREFIX, milestoneKey, milestoneTxId } from './keys'

export interface Milestone {
  tx: UpworkTransaction
  /** The contract's project, when the row names a known contract. */
  project?: Project
  /** "Milestone 3 - Dashboard", "Bonus", "Expense", … */
  title: string
}

/** "Invoice for Power BI: Milestone 30 - Formatting" → "Milestone 30 - Formatting"; bonuses and expenses by type. */
export function milestoneTitle(tx: Pick<UpworkTransaction, 'type' | 'description' | 'subtype'>): string {
  const m = /^Invoice for .+?: (Milestone .+)$/.exec(tx.description)
  if (m) return m[1].trim()
  if (tx.type === 'bonus') {
    const tail = /- ([^-]+)$/.exec(tx.description)
    return tail?.[1].trim() || tx.subtype || 'Bonus'
  }
  return tx.description.replace(/^Invoice for /, '').trim() || 'Milestone'
}

/**
 * Fixed-price and bonus rows that have no entry yet, newest first. Uses the settlement's own view of the
 * earnings, so rows Upwork reversed (and their reversals) never show up.
 */
export function milestonesWithoutHours(txs: UpworkTransaction[], entries: Pick<TimeEntry, 'externalId'>[], projects: Project[]): Milestone[] {
  const done = new Set(entries.map((e) => milestoneTxId(e.externalId)).filter(Boolean))
  const byContract = new Map(projects.filter((p) => p.upwork?.contractId).map((p) => [p.upwork!.contractId, p]))
  return linkFees(txs)
    .earnings.map((e) => e.tx)
    .filter((t) => (t.type === 'fixed' || t.type === 'bonus') && t.amount > 0 && !done.has(t.txId))
    .sort((a, b) => b.date.localeCompare(a.date) || b.txId.localeCompare(a.txId))
    .map((tx) => ({ tx, project: tx.contractId ? byContract.get(tx.contractId) : undefined, title: milestoneTitle(tx) }))
}

/** Rate assumed for a milestone when its client has no hourly rate of its own (USD per hour). */
export const DEFAULT_MILESTONE_RATE = 60

/**
 * Hours a milestone or bonus suggests: its amount at the client's rate on that date, or at the default rate
 * when the client has none.
 */
export function suggestedMilestoneHours(tx: Pick<UpworkTransaction, 'type' | 'amount' | 'date'>, client: Pick<Client, 'defaultRate' | 'rates'> | undefined): { hours: number; rate: number; clientRate: boolean } {
  const own = client ? rateFor(client, tx.date) : 0
  const rate = own > 0 ? own : DEFAULT_MILESTONE_RATE
  return { hours: Math.round((tx.amount / rate) * 100) / 100, rate, clientRate: own > 0 }
}

export interface MilestoneEntryInput {
  tx: UpworkTransaction
  clientId: number
  projectId?: number
  /** Estimated hours; 0 keeps the money without any time. */
  hours: number
  /** Entry date; defaults to the invoice date. */
  date?: string
  comments?: string
}

/** One entry for the milestone: the gross as invoiced, the hours as estimated, the rate derived from both. */
export async function addMilestoneEntry({ tx, clientId, projectId, hours, date, comments }: MilestoneEntryInput, database: TimeTrackingDB = db): Promise<number> {
  if (!(hours >= 0) || !Number.isFinite(hours)) throw new Error('Hours must be zero or more')
  const durationMin = Math.round(hours * 60)
  const hourlyRate = durationMin > 0 ? Math.round((tx.amount / (durationMin / 60)) * 100) / 100 : 0
  return addEntry(
    {
      date: date || tx.date,
      startTime: '00:00',
      endTime: minutesToHm(durationMin % 1440),
      durationMin,
      amount: tx.amount,
      clientId,
      projectId,
      hourlyRate,
      comments: comments ?? milestoneTitle(tx),
      isBilled: false,
      source: 'upwork',
      externalId: milestoneKey(tx.txId),
      timeless: true,
      estimatedHours: true,
      currency: tx.currency,
      normalize: false,
    },
    database,
  )
}
