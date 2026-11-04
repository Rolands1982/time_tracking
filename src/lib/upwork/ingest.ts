/**
 * Unattended ingest: pull the cloud copy into a local database, apply an Upwork import file (and
 * optionally a bank credits file), settle, push back. The same importer, matcher and settlement the
 * app uses, so a device and the daily task never disagree. Used by scripts/upwork-ingest.ts.
 */
import type { TimeTrackingDB } from '../../db/schema'
import { SyncEngine } from '../../sync/engine'
import type { Remote } from '../../sync/remote'
import { ensureFxRates } from '../fx'
import { payoutsOf, rateEstimator, recalculateUpwork, setPayoutEur } from './allocate'
import { matchBankCredits, type BankCredit } from './bankCredits'
import { importUpwork, type UpworkImportFile, type UpworkImportReport } from './import'

export interface IngestOptions {
  db: TimeTrackingDB
  remote: Remote
  file?: UpworkImportFile
  bankCredits?: BankCredit[]
  /** Fetch ECB rates for estimated days (network); off for tests. */
  fetchRates?: boolean
  /** Report only: nothing is pushed. */
  dryRun?: boolean
}

export interface IngestSummary {
  pulled: number
  import?: UpworkImportReport
  bank?: { matched: number; alreadyPriced: number; unmatched: number }
  settlement: { updated: number; estimated: number; unpaidNet: number; payoutsWithoutEur: number }
  rates?: { fetched: number; cached: number; error?: string }
  pushed: number
}

export async function ingestUpwork({ db, remote, file, bankCredits, fetchRates = true, dryRun = false }: IngestOptions): Promise<IngestSummary> {
  const engine = new SyncEngine(remote, db)
  const first = await engine.run()
  const summary: IngestSummary = { pulled: first.pulled, settlement: { updated: 0, estimated: 0, unpaidNet: 0, payoutsWithoutEur: 0 }, pushed: 0 }

  if (file) summary.import = await importUpwork(file, db)

  if (bankCredits?.length) {
    const txs = await db.upworkTransactions.toArray()
    const payouts = payoutsOf(txs)
    const settings = await db.settings.get('app')
    const report = matchBankCredits(bankCredits, payouts, rateEstimator(settings?.upwork?.fxRates, payouts))
    const fresh = report.matches.filter((m) => !m.already)
    for (const m of fresh) await setPayoutEur(m.payout.tx.txId, m.credit.amount, m.credit.date, db)
    summary.bank = { matched: fresh.length, alreadyPriced: report.matches.length - fresh.length, unmatched: report.unmatched.length }
  }

  let settlement = await recalculateUpwork(db)
  if (fetchRates && settlement.estimated > 0) {
    const estimated = await db.entries.where('source').equals('upwork').filter((e) => e.settlement === 'estimated' && e.amount > 0).toArray()
    const rates = await ensureFxRates([...new Set(estimated.map((e) => e.date))], db)
    summary.rates = rates
    if (rates.fetched > 0) {
      const again = await recalculateUpwork(db)
      settlement = { ...again, updated: settlement.updated + again.updated }
    }
  }
  summary.settlement = { updated: settlement.updated, estimated: settlement.estimated, unpaidNet: settlement.unpaidNet, payoutsWithoutEur: settlement.payoutsWithoutEur }

  if (!dryRun) {
    const second = await engine.run()
    summary.pushed = second.pushed
  }
  return summary
}
