import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../db/schema'
import { recalculateUpwork, refreshRatesAndRecalculate } from '../lib/upwork/allocate'
import { importUpwork, isUpworkImportFile, type UpworkImportFile, type UpworkImportReport } from '../lib/upwork/import'
import { formatMoney } from '../lib/time'
import { pullLatest } from '../sync/pullLatest'
import { useToast } from './toastContext'

/** Data screen section: load an Upwork pull (JSON produced from the Upwork MCP server) into the app. */
export default function UpworkImportCard() {
  const toast = useToast()
  const [file, setFile] = useState<UpworkImportFile | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<UpworkImportReport | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const stats = useLiveQuery(
    async () => {
      const entries = await db.entries.where('source').equals('upwork').toArray()
      const txCount = await db.upworkTransactions.count()
      const dates = entries.map((e) => e.date).sort()
      return {
        entries: new Set(dates).size,
        minutes: entries.reduce((s, e) => s + e.durationMin, 0),
        gross: entries.reduce((s, e) => s + e.amount, 0),
        estimated: entries.filter((e) => e.settlement !== 'actual').length,
        first: dates[0],
        last: dates[dates.length - 1],
        txCount,
      }
    },
    [],
    null,
  )

  const onPick = async (f: File | null) => {
    setFile(null)
    setReport(null)
    if (!f) return
    try {
      const parsed = JSON.parse(await f.text()) as unknown
      if (!isUpworkImportFile(parsed)) throw new Error('Not an Upwork import file (expected app = time-tracking-upwork)')
      setFile(parsed)
      setFileName(f.name)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      await pullLatest()
      const r = await importUpwork(file)
      setReport(r)
      toast(`Upwork: ${r.entries.added} new rows, ${r.entries.updated} updated, ${r.entries.removed} removed, ${r.transactions.added} new transactions`)
      const s = await recalculateUpwork()
      if (s.updated) toast(`Fees and exchange rates: ${s.updated} entries settled, ${s.estimated} still estimated`)
      if (s.estimated > 0) void refreshRatesAndRecalculate().then((x) => x.updated && toast(`ECB rates: ${x.updated} estimates updated`))
      setFile(null)
      setInputKey((k) => k + 1)
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Upwork</h2>
      <div className="card stack">
        <p className="muted small">
          Hours and money pulled from Upwork (contracts, time rows, the transaction ledger). Rows are matched by contract, day and memo, so a file
          can be loaded again at any time. Fees come from Upwork's fee rows; exchange rates from the payouts once their EUR amounts are known,
          until then from the ECB rate of the day (marked as estimates).
        </p>
        {stats && stats.entries > 0 && (
          <div className="stat-grid">
            <div className="stat">
              <div className="label">Upwork days</div>
              <div className="value">{stats.entries}</div>
              <div className="label">
                {stats.first} – {stats.last}
              </div>
            </div>
            <div className="stat">
              <div className="label">Hours</div>
              <div className="value">{(stats.minutes / 60).toFixed(1)}</div>
              {stats.estimated > 0 && <div className="label">{stats.estimated} estimated</div>}
            </div>
            <div className="stat">
              <div className="label">Gross</div>
              <div className="value">{formatMoney(stats.gross, 'USD')}</div>
              <div className="label">{stats.txCount} transactions</div>
            </div>
          </div>
        )}
        {stats && stats.txCount > 0 && (
          <Link className="btn block" to="/upwork/payouts" data-testid="upwork-payouts">
            Payouts and exchange rates
          </Link>
        )}
        <input key={inputKey} type="file" accept=".json,application/json" onChange={(e) => void onPick(e.target.files?.[0] ?? null)} aria-label="Upwork import file" />
        {file && (
          <>
            <p className="small">
              <strong>{fileName}</strong>: {file.contracts?.length ?? 0} contracts, {file.time?.length ?? 0} time rows, {file.transactions?.length ?? 0} transactions
              {file.account?.name ? ` · account ${file.account.name}` : ''}
            </p>
            <button className="btn primary" onClick={run} disabled={busy} data-testid="upwork-import">
              {busy ? 'Importing…' : 'Import into the app'}
            </button>
          </>
        )}
        {report && (
          <p className="small muted">
            Clients {report.clients.created} new / {report.clients.matched} matched · projects {report.projects.created} new · time rows {report.entries.added} new,{' '}
            {report.entries.updated} updated, {report.entries.unchanged} unchanged, {report.entries.removed} removed · transactions {report.transactions.added} new, {report.transactions.updated} updated.
          </p>
        )}
      </div>
    </>
  )
}
