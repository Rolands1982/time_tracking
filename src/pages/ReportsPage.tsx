import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { groupBy, setBilled, totals } from '../db/repo'
import { db } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob, stamp, XLSX_MIME } from '../lib/download'
import { addMonths, formatDuration, formatMoney, monthKey, monthLabel, todayIso } from '../lib/time'

type Period = 'month' | 'quarter' | 'year' | 'all' | 'custom'

function periodRange(period: Period, anchor: string, custom: { from: string; to: string }): { from?: string; to?: string } {
  const [y, m] = anchor.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastDay = (yy: number, mm: number) => new Date(yy, mm, 0).getDate()
  switch (period) {
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }
    case 'quarter': {
      const q0 = Math.floor((m - 1) / 3) * 3 + 1
      return { from: `${y}-${pad(q0)}-01`, to: `${y}-${pad(q0 + 2)}-${pad(lastDay(y, q0 + 2))}` }
    }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    case 'custom':
      return { from: custom.from || undefined, to: custom.to || undefined }
    default:
      return {}
  }
}

export default function ReportsPage() {
  const [period, setPeriod] = useState<Period>('month')
  const [anchor, setAnchor] = useState(() => todayIso().slice(0, 7))
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [clientId, setClientId] = useState<number | undefined>()
  const [invoiceDate, setInvoiceDate] = useState(todayIso())
  const { clients, projects, clientName, projectName, clientById } = useLookups()
  const settings = useSettings()
  const toast = useToast()

  const range = periodRange(period, anchor, custom)
  const entries = useLiveQuery(async () => {
    const rows =
      range.from || range.to
        ? await db.entries.where('date').between(range.from ?? '0000', range.to ?? '9999', true, true).toArray()
        : await db.entries.toArray()
    return rows
  }, [range.from, range.to], [] as TimeEntry[])

  const filtered = useMemo(() => entries.filter((e) => (clientId == null ? true : e.clientId === clientId)), [entries, clientId])
  const t = useMemo(() => totals(filtered), [filtered])
  const currency = (clientId != null && clientById.get(clientId)?.currency) || settings.defaultCurrency

  const byClient = useMemo(() => groupBy(filtered, (e) => e.clientId), [filtered])
  const byProject = useMemo(() => groupBy(filtered, (e) => `${e.clientId}:${e.projectId ?? ''}`), [filtered])
  const byMonth = useMemo(() => groupBy(filtered, (e) => monthKey(e.date)), [filtered])
  const unbilledByClient = useMemo(() => groupBy(filtered.filter((e) => !e.isBilled), (e) => e.clientId), [filtered])

  const periodLabel =
    period === 'month' ? monthLabel(anchor) : period === 'quarter' ? `Q${Math.floor((Number(anchor.slice(5)) - 1) / 3) + 1} ${anchor.slice(0, 4)}` : period === 'year' ? anchor.slice(0, 4) : period === 'all' ? 'All time' : `${custom.from || '…'} – ${custom.to || '…'}`

  const markBilled = async (cid: number) => {
    const ids = (unbilledByClient.get(cid) ?? []).map((e) => e.id!)
    if (!ids.length) return
    if (!confirm(`Mark ${ids.length} entries of ${clientName(cid)} as billed on ${invoiceDate}?`)) return
    await setBilled(ids, invoiceDate)
    toast(`${ids.length} entries marked as billed`)
  }

  const exportStatement = async () => {
    const { masterWorkbookToBuffer } = await import('../lib/excel/exportMaster')
    const buf = await masterWorkbookToBuffer({
      entries: filtered,
      clients: clients.filter((c) => clientId == null || c.id === clientId),
      projects,
    })
    const who = clientId != null ? clientName(clientId).replace(/[^\w-]+/g, '_') : 'all_clients'
    downloadBlob(buf, `Statement_${who}_${periodLabel.replace(/[^\w-]+/g, '_')}_${stamp()}.xlsx`, XLSX_MIME)
  }

  return (
    <>
      <div className="topbar">
        <h1>Reports</h1>
        <button className="btn small" onClick={exportStatement} disabled={filtered.length === 0}>
          ⬇ Excel statement
        </button>
      </div>

      <div className="card stack">
        <div className="segmented">
          {(['month', 'quarter', 'year', 'all', 'custom'] as Period[]).map((p) => (
            <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        {(period === 'month' || period === 'quarter' || period === 'year') && (
          <div className="month-nav">
            <button className="btn" onClick={() => setAnchor((a) => addMonths(a, period === 'month' ? -1 : period === 'quarter' ? -3 : -12))} aria-label="Previous period">
              ‹
            </button>
            <strong>{periodLabel}</strong>
            <button className="btn" onClick={() => setAnchor((a) => addMonths(a, period === 'month' ? 1 : period === 'quarter' ? 3 : 12))} aria-label="Next period">
              ›
            </button>
          </div>
        )}
        {period === 'custom' && (
          <div className="grid-2">
            <label className="field">
              <span>From</span>
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
        <select value={clientId ?? ''} onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : undefined)} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Billed hours</div>
            <div className="value">{(t.billedMin / 60).toFixed(2)}</div>
            {t.billedMin !== t.durationMin && <div className="label">actual {(t.durationMin / 60).toFixed(2)}</div>}
          </div>
          <div className="stat">
            <div className="label">Amount</div>
            <div className="value">{formatMoney(t.amount, currency)}</div>
          </div>
          <div className="stat">
            <div className="label">Not billed</div>
            <div className="value">{formatMoney(t.unbilledAmount, currency)}</div>
          </div>
        </div>
      </div>

      <h2>Open (not yet billed)</h2>
      <div className="card">
        {unbilledByClient.size === 0 ? (
          <p className="muted">Everything in this period is billed.</p>
        ) : (
          <>
            <label className="field">
              <span>Invoice date to apply</span>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </label>
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">Hours</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...unbilledByClient.entries()].map(([cid, list]) => {
                  const ut = totals(list)
                  return (
                    <tr key={cid}>
                      <td>
                        {clientName(cid)} <span className="muted small">({ut.count})</span>
                      </td>
                      <td className="num">{(ut.durationMin / 60).toFixed(2)}</td>
                      <td className="num">{formatMoney(ut.amount, clientById.get(cid)?.currency)}</td>
                      <td className="num">
                        <button className="btn small" onClick={() => markBilled(cid)}>
                          Mark billed
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      <SummaryTable title="By client" rows={[...byClient.entries()].map(([k, list]) => [clientName(k), list] as const)} currency={currency} />
      <SummaryTable
        title="By project"
        rows={[...byProject.entries()].map(([k, list]) => {
          const [c, p] = k.split(':')
          return [`${clientName(Number(c))}${p ? ` · ${projectName(Number(p))}` : ''}`, list] as const
        })}
        currency={currency}
      />
      <SummaryTable
        title="By month"
        rows={[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, list]) => [monthLabel(k), list] as const)}
        currency={currency}
      />
      <p className="muted small">
        Hours and amounts are on the billed basis (start snapped to 10 minutes, 15-minute steps); actual minutes are shown
        where they differ. Totals per client use that client's currency; the overall figures use {currency}.
      </p>
    </>
  )
}

function SummaryTable({ title, rows, currency }: { title: string; rows: readonly (readonly [string, TimeEntry[]])[]; currency: string }) {
  if (!rows.length) return null
  const all = totals(rows.flatMap(([, l]) => l))
  return (
    <>
      <h2>{title}</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{title.replace('By ', '')}</th>
              <th className="num">Hours</th>
              <th className="num">Amount</th>
              <th className="num">Open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, list]) => {
              const t = totals(list)
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{formatDuration(t.billedMin)}</td>
                  <td className="num">{formatMoney(t.amount, currency)}</td>
                  <td className="num">{t.unbilledAmount ? formatMoney(t.unbilledAmount, currency) : '–'}</td>
                </tr>
              )
            })}
            <tr className="total">
              <td>Total</td>
              <td className="num">{formatDuration(all.billedMin)}</td>
              <td className="num">{formatMoney(all.amount, currency)}</td>
              <td className="num">{all.unbilledAmount ? formatMoney(all.unbilledAmount, currency) : '–'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
