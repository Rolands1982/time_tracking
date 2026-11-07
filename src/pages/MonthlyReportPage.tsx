import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { useLookups } from '../db/hooks'
import { db } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob, XLSX_MIME } from '../lib/download'
import { buildMonthlyReport, hoursOf, monthlyReportFileName } from '../lib/monthlyReport'
import { formatDate } from '../lib/period'
import { addMonths, formatDuration, formatMoney, monthLabel, monthRange, todayIso } from '../lib/time'

const PDF_MIME = 'application/pdf'

/** One month's hours per client and per day, with the net in EUR; on screen and as PDF or Excel. */
export default function MonthlyReportPage() {
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const { clients } = useLookups()
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : todayIso().slice(0, 7)
  const setMonth = (m: string) => setParams({ month: m }, { replace: true })
  const [includeNonBillable, setIncludeNonBillable] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const range = monthRange(`${month}-01`)
  const entries = useLiveQuery(() => db.entries.where('date').between(range.from, range.to, true, true).toArray(), [range.from, range.to], [] as TimeEntry[])
  const report = useMemo(() => buildMonthlyReport({ month, entries, clients, includeNonBillable }), [month, entries, clients, includeNonBillable])
  const t = report.totals

  const download = async (format: 'pdf' | 'xlsx') => {
    setBusy(format)
    try {
      if (format === 'xlsx') {
        const { monthlyToBuffer } = await import('../lib/excel/exportMonthly')
        downloadBlob(await monthlyToBuffer(report), monthlyReportFileName(report, 'xlsx'), XLSX_MIME)
      } else {
        const { monthlyPdfBlob } = await import('../lib/pdf/monthlyPdf')
        downloadBlob(await monthlyPdfBlob(report), monthlyReportFileName(report, 'pdf'), PDF_MIME)
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
        <h1>Monthly hours</h1>
        <Link className="btn small" to="/reports">
          ← Reports
        </Link>
      </div>

      <div className="card stack">
        <div className="month-nav">
          <button className="btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
            ‹
          </button>
          <strong>{monthLabel(month)}</strong>
          <button className="btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
            ›
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={includeNonBillable} onChange={(e) => setIncludeNonBillable(e.target.checked)} />
          Include non-billable hours
        </label>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Hours</div>
            <div className="value" data-testid="monthly-hours">
              {hoursOf(t.minutes).toFixed(2)}
            </div>
            <div className="label">{t.wholeHours} rounded to whole hours</div>
            {t.actualMin !== t.minutes && <div className="label">actual {hoursOf(t.actualMin).toFixed(2)}</div>}
            {t.estimatedHours > 0 && <div className="label">{t.estimatedHours} with estimated hours</div>}
          </div>
          <div className="stat">
            <div className="label">Days worked</div>
            <div className="value">{t.daysWorked}</div>
            <div className="label">{t.entries} entries</div>
          </div>
          <div className="stat">
            <div className="label">Net EUR</div>
            <div className="value">{formatMoney(t.netEur, 'EUR')}</div>
            {t.estimated > 0 && <div className="label">{t.estimated} estimated</div>}
            {t.eurMissing > 0 && <div className="label">{t.eurMissing} without a rate</div>}
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => void download('pdf')} disabled={busy != null || t.entries === 0} data-testid="monthly-pdf">
            {busy === 'pdf' ? 'Preparing…' : '⬇ PDF'}
          </button>
          <button className="btn" onClick={() => void download('xlsx')} disabled={busy != null || t.entries === 0} data-testid="monthly-xlsx">
            {busy === 'xlsx' ? 'Preparing…' : '⬇ Excel'}
          </button>
        </div>
        <p className="muted small">
          Hours on the billed basis per client and per day; the money is net in EUR (Upwork work after its fee at the payout's rate, or the ECB rate
          of the day until paid out). Non-billable work counts in the hours, never in the money. Rounded hours are whole hours per client
          or day; the total is their sum.
        </p>
      </div>

      <h2>By client</h2>
      <div className="card">
        {report.rows.length === 0 ? (
          <p className="muted">No entries in {monthLabel(month)}.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Hours</th>
                <th className="num">Rounded</th>
                <th className="num">Net EUR</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.clientId}>
                  <td>
                    {r.name} <span className="muted small">({r.entries})</span>
                    {(r.platform || r.estimatedHours > 0 || r.estimated > 0 || r.eurMissing > 0) && (
                      <div className="muted small">
                        {[r.platform ? 'Upwork' : '', r.estimatedHours ? `${r.estimatedHours} with estimated hours` : '', r.estimated ? `${r.estimated} estimated` : '', r.eurMissing ? `${r.eurMissing} without a rate` : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="num">{formatDuration(r.minutes)}</td>
                  <td className="num">{r.wholeHours} h</td>
                  <td className="num">{formatMoney(r.netEur, 'EUR')}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td className="num">{formatDuration(t.minutes)}</td>
                <td className="num" data-testid="monthly-whole-hours">{t.wholeHours} h</td>
                <td className="num">{formatMoney(t.netEur, 'EUR')}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {report.days.length > 0 && (
        <>
          <h2>By day</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Hours</th>
                  <th className="num">Rounded</th>
                  <th>Clients</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((d) => (
                  <tr key={d.date}>
                    <td className="nowrap">{formatDate(d.date)}</td>
                    <td className="num">{formatDuration(d.minutes)}</td>
                    <td className="num">{d.wholeHours} h</td>
                    <td>{d.clients.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
