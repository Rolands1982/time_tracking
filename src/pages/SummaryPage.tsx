import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import { useLookups } from '../db/hooks'
import { db } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob, XLSX_MIME } from '../lib/download'
import { periodFromParams, periodRange, periodToParams, formatDate, type PeriodState } from '../lib/period'
import { buildStatement, FILTER_LABELS, hours, statementFileName, type StatementFilter } from '../lib/statement'
import { formatMoney, todayIso } from '../lib/time'

const FILTERS: StatementFilter[] = ['all', 'unbilled', 'billed']
const PREVIEW_ROWS = 200

export default function SummaryPage() {
  const [params, setParams] = useSearchParams()
  const { clients, projects, clientById } = useLookups()
  const toast = useToast()
  const [period, setPeriod] = useState<PeriodState>(() =>
    periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } }),
  )
  const [filter, setFilter] = useState<StatementFilter>(() => (FILTERS.includes(params.get('filter') as StatementFilter) ? (params.get('filter') as StatementFilter) : 'all'))
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  const clientParam = Number(params.get('client'))
  const clientId = clientParam > 0 ? clientParam : undefined

  // Keep the selection in the URL so the page survives a reload and can be linked to.
  useEffect(() => {
    const next: Record<string, string> = { ...periodToParams(period), filter }
    if (clientId != null) next.client = String(clientId)
    setParams(next, { replace: true })
  }, [period, filter, clientId, setParams])

  const range = periodRange(period)
  const entries = useLiveQuery(
    async () => {
      if (clientId == null) return []
      const rows = range.from || range.to ? await db.entries.where('date').between(range.from ?? '0000', range.to ?? '9999', true, true).toArray() : await db.entries.toArray()
      return rows.filter((e) => e.clientId === clientId)
    },
    [clientId, range.from, range.to],
    [] as TimeEntry[],
  )

  const client = clientId != null ? clientById.get(clientId) : undefined
  const statement = useMemo(() => (client ? buildStatement({ client, entries, projects, from: range.from, to: range.to, filter }) : null), [client, entries, projects, range.from, range.to, filter])

  const exportFile = async (kind: 'xlsx' | 'pdf') => {
    if (!statement) return
    setBusy(kind)
    try {
      if (kind === 'xlsx') {
        const { statementToBuffer } = await import('../lib/excel/exportStatement')
        downloadBlob(await statementToBuffer(statement), statementFileName(statement, 'xlsx'), XLSX_MIME)
      } else {
        const { statementPdfBlob } = await import('../lib/pdf/statementPdf')
        downloadBlob(await statementPdfBlob(statement), statementFileName(statement, 'pdf'), 'application/pdf')
      }
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Customer summary</h1>
      </div>

      <div className="card stack">
        <select value={clientId ?? ''} onChange={(e) => setParams({ ...Object.fromEntries(params), client: e.target.value }, { replace: true })} aria-label="Client">
          <option value="">Choose a client…</option>
          {clients
            .filter((c) => !c.archived || c.id === clientId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="segmented" role="group" aria-label="Entries to include">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {!statement ? (
        <div className="card">
          <div className="empty">Choose a client to see the summary.</div>
        </div>
      ) : (
        <>
          <div className="card stack">
            <div className="stat-grid">
              <div className="stat">
                <div className="label">Total hours</div>
                <div className="value" data-testid="summary-hours">
                  {hours(statement.minutes).toFixed(2)}
                </div>
                {statement.actualMin !== statement.minutes && <div className="label">actual {hours(statement.actualMin).toFixed(2)}</div>}
              </div>
              <div className="stat">
                <div className="label">Total amount</div>
                <div className="value">{formatMoney(statement.amount, statement.currency)}</div>
              </div>
              <div className="stat">
                <div className="label">Entries</div>
                <div className="value">{statement.count}</div>
                {statement.nonBillableCount > 0 && <div className="label">+{statement.nonBillableCount} non-billable</div>}
              </div>
            </div>
            <div className="actions">
              <button className="btn primary" onClick={() => exportFile('xlsx')} disabled={busy != null || statement.rows.length === 0} data-testid="summary-xlsx">
                {busy === 'xlsx' ? 'Preparing…' : '⬇ Excel'}
              </button>
              <button className="btn primary" onClick={() => exportFile('pdf')} disabled={busy != null || statement.rows.length === 0} data-testid="summary-pdf">
                {busy === 'pdf' ? 'Preparing…' : '⬇ PDF'}
              </button>
            </div>
          </div>

          {statement.byProject.length > 1 && (
            <>
              <h2>By project</h2>
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="num">Hours</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.byProject.map((g) => (
                      <tr key={g.name}>
                        <td>
                          {g.name} <span className="muted small">({g.count})</span>
                        </td>
                        <td className="num">{hours(g.minutes).toFixed(2)}</td>
                        <td className="num">{formatMoney(g.amount, statement.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2>Entries</h2>
          <div className="card">
            {statement.rows.length === 0 ? (
              <p className="muted">No entries for {statement.clientName} in this period.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Work</th>
                    <th className="num">Hours</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={i} className={r.billable ? '' : 'muted'}>
                      <td className="nowrap">
                        {formatDate(r.date)}
                        <div className="muted small">
                          {r.startTime}–{r.endTime}
                        </div>
                      </td>
                      <td>
                        {r.project && <strong>{r.project} · </strong>}
                        {[r.category, r.comments].filter(Boolean).join(': ') || <span className="muted">(no description)</span>}
                        {!r.billable && <span className="badge"> non-billable</span>}
                        {r.isBilled && filter === 'all' && <span className="badge billed"> {r.invoiceRef ?? (r.invoiceDate ? formatDate(r.invoiceDate) : 'billed')}</span>}
                      </td>
                      <td className="num">{hours(r.minutes).toFixed(2)}</td>
                      <td className="num">{r.billable ? formatMoney(r.amount, statement.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {statement.rows.length > PREVIEW_ROWS && (
              <p className="muted small">Showing the first {PREVIEW_ROWS} of {statement.rows.length} entries; the exported file contains all of them.</p>
            )}
          </div>
          <p className="muted small">
            Hours and amounts are on the billed basis. Non-billable entries are listed for information and not counted in the totals.
          </p>
        </>
      )}
    </>
  )
}
