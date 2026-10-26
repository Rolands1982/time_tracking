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
import { sendMail, type MailAttachment } from '../lib/mail'
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
const NUMERIC = new Set<StatementColumn>(['hours', 'rate', 'amount'])
const COLUMN_LABEL = Object.fromEntries(STATEMENT_COLUMNS.map((c) => [c.key, c.label])) as Record<StatementColumn, string>

function previewCell(r: Statement['rows'][number], c: StatementColumn, st: Statement) {
  switch (c) {
    case 'date':
      return formatDate(r.date)
    case 'time':
      return `${r.startTime}–${r.endTime}`
    case 'project':
      return r.project
    case 'category':
      return r.category ?? ''
    case 'description':
      return describe(r, st.columns) || <span className="muted">(no description)</span>
    case 'hours':
      return hours(r.minutes).toFixed(2)
    case 'rate':
      return r.billable ? formatMoney(r.rate, st.currency) : '–'
    case 'amount':
      return r.billable ? formatMoney(r.amount, st.currency) : '–'
    default:
      return <span className={`badge ${r.isBilled ? 'billed' : r.billable ? 'open' : ''}`}>{invoiceText(r, formatDate)}</span>
  }
}
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

function emailText(st: Statement, signature?: string): { subject: string; body: string } {
  const subject = `Time summary ${st.clientName} – ${st.periodLabel}`
  const body = [
    'Hello,',
    '',
    `please find attached the time summary for ${st.periodLabel}:`,
    `${st.count} entries, ${hours(st.minutes).toFixed(2)} hours, ${formatMoney(st.amount, st.currency)}.`,
    '',
    signature?.trim() || 'Best regards',
  ].join('\n')
  return { subject, body }
}

interface Compose {
  to: string
  subject: string
  text: string
  copyToSender: boolean
  file: MailAttachment
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
  const [compose, setCompose] = useState<Compose | null>(null)
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
        const { subject, body } = emailText(statement, settings.mail?.signature)
        const result = await shareFile(new Blob([file.data], { type: file.type }), file.name, file.type, { title: subject, body })
        if (result === 'shared') toast('Shared')
        else if (result === 'unsupported') {
          downloadBlob(file.data, file.name, file.type)
          toast('Sharing is not available here; the file was downloaded instead')
        }
        return
      }
      if (action === 'email') {
        const { subject, body } = emailText(statement, settings.mail?.signature)
        setCompose({ to: statement.clientEmail ?? '', subject, text: body, copyToSender: settings.mail?.copyToSender ?? true, file: { filename: file.name, contentType: file.type, data: file.data } })
        return
      }
      downloadBlob(file.data, file.name, file.type)
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const send = async () => {
    if (!compose) return
    setBusy('send')
    try {
      const outcome = await sendMail({ to: compose.to, subject: compose.subject, text: compose.text, copyToSender: compose.copyToSender, attachments: [compose.file] })
      if (outcome.ok) {
        toast(`Sent to ${outcome.to.join(', ')}`)
        void updateSettings({ mail: { ...settings.mail, copyToSender: compose.copyToSender } })
        setCompose(null)
      } else toast(outcome.error)
    } finally {
      setBusy(null)
    }
  }

  /** Fallback without the server: download the file and open the mail app with the text. */
  const openMailApp = () => {
    if (!compose) return
    downloadBlob(compose.file.data, compose.file.filename, compose.file.contentType)
    toast('File downloaded – attach it to the e-mail that opens')
    window.location.href = mailtoLink(compose.to || undefined, compose.subject, compose.text)
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
                  {has(c.key) ? '✓ ' : ''}
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
              {shareable ? 'Share… opens the phone\u2019s share sheet with the file attached. ' : ''}
              E-mail sends the file from your business mailbox to {statement.clientEmail ?? 'the client'}, with an editable message.
            </p>
          </div>

          {compose && (
            <form
              className="card stack"
              data-testid="compose"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <h2>Send by e-mail</h2>
              <label className="field">
                <span>To</span>
                <input type="text" inputMode="email" autoComplete="email" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="client@example.com" required />
              </label>
              <label className="field">
                <span>Subject</span>
                <input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} required />
              </label>
              <label className="field">
                <span>Message</span>
                <textarea rows={7} value={compose.text} onChange={(e) => setCompose({ ...compose, text: e.target.value })} required />
              </label>
              <label className="check">
                <input type="checkbox" checked={compose.copyToSender} onChange={(e) => setCompose({ ...compose, copyToSender: e.target.checked })} />
                Send me a copy
              </label>
              <p className="small muted">
                Attachment: <strong>{compose.file.filename}</strong> ({Math.max(1, Math.round((compose.file.data instanceof Blob ? compose.file.data.size : compose.file.data.byteLength) / 1024))} KB). Sent from your business mailbox through the
                app's mail function; you need to be signed in to cloud sync.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={() => setCompose(null)} disabled={busy === 'send'}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={openMailApp} disabled={busy === 'send'} title="Without attachment; attach the downloaded file yourself">
                  Open in mail app
                </button>
                <button type="submit" className="btn primary" disabled={busy === 'send'} data-testid="send-mail">
                  {busy === 'send' ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}

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
              <div className="table-scroll">
                <table className="preview" data-testid="preview-table">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c} className={NUMERIC.has(c) ? 'num' : ''}>
                          {COLUMN_LABEL[c]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i} className={r.billable ? '' : 'muted'}>
                        {columns.map((c) => (
                          <td key={c} className={NUMERIC.has(c) ? 'num' : c === 'description' ? 'wrap' : 'nowrap'}>
                            {previewCell(r, c, statement)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
