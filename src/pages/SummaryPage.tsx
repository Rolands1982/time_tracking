import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { db, updateSettings } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob, XLSX_MIME } from '../lib/download'
import { periodFromParams, periodRange, periodToParams, formatDate, type PeriodState } from '../lib/period'
import { canShareFiles, mailtoLink, shareFile } from '../lib/share'
import {
  buildStatement,
  DEFAULT_COLUMNS,
  describe,
  FILTER_LABELS,
  hours,
  invoiceText,
  normalizeColumns,
  STATEMENT_COLUMNS,
  statementFileName,
  type Statement,
  type StatementColumn,
  type StatementFilter,
} from '../lib/statement'
import { formatMoney, todayIso } from '../lib/time'

type Format = 'pdf' | 'xlsx'
const FILTERS: StatementFilter[] = ['all', 'unbilled', 'billed']
const PREVIEW_ROWS = 200
const PDF_MIME = 'application/pdf'

async function render(st: Statement, format: Format): Promise<{ data: Blob | ArrayBuffer; name: string; type: string }> {
  if (format === 'xlsx') {
    const { statementToBuffer } = await import('../lib/excel/exportStatement')
    return { data: await statementToBuffer(st), name: statementFileName(st, 'xlsx'), type: XLSX_MIME }
  }
  const { statementPdfBlob } = await import('../lib/pdf/statementPdf')
  return { data: await statementPdfBlob(st), name: statementFileName(st, 'pdf'), type: PDF_MIME }
}

function emailText(st: Statement): { subject: string; body: string } {
  const subject = `Time summary ${st.clientName} – ${st.periodLabel}`
  const body = [
    'Hello,',
    '',
    `please find attached the time summary for ${st.periodLabel}:`,
    `${st.count} entries, ${hours(st.minutes).toFixed(2)} hours, ${formatMoney(st.amount, st.currency)}.`,
    '',
    'Best regards',
  ].join('\n')
  return { subject, body }
}

export default function SummaryPage() {
  const [params, setParams] = useSearchParams()
  const { clients, projects, clientById } = useLookups()
  const settings = useSettings()
  const toast = useToast()
  const [period, setPeriod] = useState<PeriodState>(() =>
    periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } }),
  )
  const [filter, setFilter] = useState<StatementFilter>(() => (FILTERS.includes(params.get('filter') as StatementFilter) ? (params.get('filter') as StatementFilter) : 'all'))
  const [format, setFormat] = useState<Format>('pdf')
  const [busy, setBusy] = useState<string | null>(null)
  const [showColumns, setShowColumns] = useState(false)
  const clientParam = Number(params.get('client'))
  const clientId = clientParam > 0 ? clientParam : undefined
  const columns = useMemo(() => normalizeColumns(settings.summaryColumns), [settings.summaryColumns])
  const shareable = useMemo(() => canShareFiles(), [])

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
  const statement = useMemo(
    () => (client ? buildStatement({ client, entries, projects, from: range.from, to: range.to, filter, columns }) : null),
    [client, entries, projects, range.from, range.to, filter, columns],
  )

  const toggleColumn = (key: StatementColumn) => {
    const next = columns.includes(key) ? columns.filter((c) => c !== key) : [...columns, key]
    if (!next.length) return toast('Keep at least one column')
    void updateSettings({ summaryColumns: normalizeColumns(next) })
  }

  const run = async (action: 'download' | 'share' | 'email') => {
    if (!statement) return
    setBusy(action)
    try {
      const file = await render(statement, format)
      if (action === 'share') {
        const { subject, body } = emailText(statement)
        const result = await shareFile(new Blob([file.data], { type: file.type }), file.name, file.type, { title: subject, body })
        if (result === 'shared') toast('Shared')
        else if (result === 'unsupported') {
          downloadBlob(file.data, file.name, file.type)
          toast('Sharing is not available here; the file was downloaded instead')
        }
        return
      }
      downloadBlob(file.data, file.name, file.type)
      if (action === 'email') {
        const { subject, body } = emailText(statement)
        toast('File downloaded – attach it to the e-mail that opens')
        window.location.href = mailtoLink(statement.clientEmail, subject, body)
      }
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const has = (c: StatementColumn) => columns.includes(c)

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
        <button type="button" className="btn small" onClick={() => setShowColumns((v) => !v)} aria-expanded={showColumns} data-testid="toggle-columns">
          Columns ({columns.length} of {STATEMENT_COLUMNS.length}) {showColumns ? '▾' : '▸'}
        </button>
        {showColumns && (
          <>
            <div className="chips" role="group" aria-label="Columns">
              {STATEMENT_COLUMNS.map((c) => (
                <button key={c.key} type="button" aria-pressed={has(c.key)} onClick={() => toggleColumn(c.key)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn small ghost" onClick={() => void updateSettings({ summaryColumns: [...DEFAULT_COLUMNS] })}>
                Reset to default
              </button>
              <span className="muted small">The selection is remembered on this device and applies to the preview, Excel and PDF.</span>
            </div>
          </>
        )}
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
            <div className="segmented" role="group" aria-label="File format">
              {(['pdf', 'xlsx'] as Format[]).map((f) => (
                <button key={f} type="button" className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
                  {f === 'pdf' ? 'PDF' : 'Excel'}
                </button>
              ))}
            </div>
            <div className="actions">
              <button className="btn primary" onClick={() => run('download')} disabled={busy != null || statement.rows.length === 0} data-testid="summary-download">
                {busy === 'download' ? 'Preparing…' : '⬇ Download'}
              </button>
              {shareable && (
                <button className="btn" onClick={() => run('share')} disabled={busy != null || statement.rows.length === 0} data-testid="summary-share">
                  {busy === 'share' ? 'Preparing…' : 'Share…'}
                </button>
              )}
              <button
                className="btn"
                onClick={() => run('email')}
                disabled={busy != null || statement.rows.length === 0}
                title={statement.clientEmail ? `To ${statement.clientEmail}` : 'The client has no e-mail address yet; you can type one in the mail app'}
                data-testid="summary-email"
              >
                {busy === 'email' ? 'Preparing…' : '✉ E-mail'}
              </button>
            </div>
            <p className="muted small">
              {shareable
                ? 'Share… opens the phone’s share sheet with the file attached (e-mail, WhatsApp, …). '
                : ''}
              E-mail downloads the file and opens a new message to {statement.clientEmail ?? 'the client'} with subject and text filled in; attach the downloaded file before sending.
            </p>
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
                    {(has('date') || has('time')) && <th>{has('date') ? 'Date' : 'Time'}</th>}
                    {(has('project') || has('category') || has('description') || has('invoice')) && <th>Work</th>}
                    {has('hours') && <th className="num">Hours</th>}
                    {(has('amount') || has('rate')) && <th className="num">{has('amount') ? 'Amount' : 'Rate'}</th>}
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={i} className={r.billable ? '' : 'muted'}>
                      {(has('date') || has('time')) && (
                        <td className="nowrap">
                          {has('date') && formatDate(r.date)}
                          {has('time') && (
                            <div className="muted small">
                              {r.startTime}–{r.endTime}
                            </div>
                          )}
                        </td>
                      )}
                      {(has('project') || has('category') || has('description') || has('invoice')) && (
                        <td>
                          {has('project') && r.project && <strong>{r.project} · </strong>}
                          {has('category') && r.category && <span className="badge">{r.category}</span>}{has('category') && r.category && ' '}
                          {has('description') && (describe(r, columns) || <span className="muted">(no description)</span>)}
                          {has('invoice') && <span className={`badge ${r.isBilled ? 'billed' : r.billable ? 'open' : ''}`}> {invoiceText(r, formatDate)}</span>}
                        </td>
                      )}
                      {has('hours') && <td className="num">{hours(r.minutes).toFixed(2)}</td>}
                      {(has('amount') || has('rate')) && (
                        <td className="num">{!r.billable ? '–' : has('amount') ? formatMoney(r.amount, statement.currency) : formatMoney(r.rate, statement.currency)}</td>
                      )}
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
