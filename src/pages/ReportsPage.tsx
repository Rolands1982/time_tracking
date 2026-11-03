import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { groupBy, isBillable, setBilled, totals } from '../db/repo'
import { db, updateSettings } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob, stamp, XLSX_MIME } from '../lib/download'
import { amountOf, MONEY_MODES, type MoneyMode } from '../lib/moneyMode'
import { periodLabel as labelFor, periodRange, periodToParams, type PeriodState } from '../lib/period'
import { formatDuration, formatMoney, monthKey, monthLabel, todayIso } from '../lib/time'

export default function ReportsPage() {
  const [period, setPeriod] = useState<PeriodState>(() => ({ period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } }))
  const [clientId, setClientId] = useState<number | undefined>()
  const [invoiceDate, setInvoiceDate] = useState(todayIso())
  const [money, setMoney] = useState<MoneyMode>('gross')
  const { clients, projects, clientName, projectName, clientById } = useLookups()
  const settings = useSettings()
  const toast = useToast()

  const range = periodRange(period)
  const entries = useLiveQuery(async () => {
    const rows =
      range.from || range.to
        ? await db.entries.where('date').between(range.from ?? '0000', range.to ?? '9999', true, true).toArray()
        : await db.entries.toArray()
    return rows
  }, [range.from, range.to], [] as TimeEntry[])

  // The click takes effect at once; the setting persists in the background and wins after a reload.
  const [includeOverride, setIncludeOverride] = useState<boolean | null>(null)
  const includeNonBillable = includeOverride ?? settings.reportsIncludeNonBillable ?? false
  const setIncludeNonBillable = (on: boolean) => {
    setIncludeOverride(on)
    void updateSettings({ reportsIncludeNonBillable: on })
  }
  const filtered = useMemo(
    () => entries.filter((e) => (clientId == null ? true : e.clientId === clientId)).filter((e) => includeNonBillable || isBillable(e)),
    [entries, clientId, includeNonBillable],
  )
  const t = useMemo(() => totals(filtered), [filtered])
  const baseCurrency = (clientId != null && clientById.get(clientId)?.currency) || settings.defaultCurrency
  const currency = money === 'eur' ? 'EUR' : baseCurrency

  const byClient = useMemo(() => groupBy(filtered, (e) => e.clientId), [filtered])
  const byProject = useMemo(() => groupBy(filtered, (e) => `${e.clientId}:${e.projectId ?? ''}`), [filtered])
  const byMonth = useMemo(() => groupBy(filtered, (e) => monthKey(e.date)), [filtered])
  const unbilledByClient = useMemo(() => groupBy(filtered.filter((e) => !e.isBilled), (e) => e.clientId), [filtered])

  const periodLabel = labelFor(period)

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
        <PeriodPicker value={period} onChange={setPeriod} />
        <select value={clientId ?? ''} onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : undefined)} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={includeNonBillable} onChange={(e) => setIncludeNonBillable(e.target.checked)} data-testid="include-non-billable" />
          Include non-billable hours
        </label>
        <div className="segmented" role="radiogroup" aria-label="Money">
          {MONEY_MODES.map((m) => (
            <button key={m.key} className={money === m.key ? 'active' : ''} onClick={() => setMoney(m.key)} role="radio" aria-checked={money === m.key}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">{includeNonBillable ? 'Hours' : 'Billed hours'}</div>
            <div className="value" data-testid="report-hours">
              {(t.billedMin / 60).toFixed(2)}
            </div>
            {t.nonBillableMin > 0 && <div className="label">{(t.nonBillableMin / 60).toFixed(2)} non-billable</div>}
            {t.billedMin !== t.durationMin && <div className="label">actual {(t.durationMin / 60).toFixed(2)}</div>}
          </div>
          <div className="stat">
            <div className="label">{money === 'gross' ? 'Amount' : money === 'net' ? 'Net after fees' : 'Net in EUR'}</div>
            <div className="value" data-testid="report-amount">
              {formatMoney(amountOf(t, money), currency)}
            </div>
            {money !== 'gross' && t.feeAmount > 0 && <div className="label">fees {formatMoney(t.feeAmount, baseCurrency)}</div>}
            {money === 'eur' && t.eurMissing > 0 && <div className="label">{t.eurMissing} entries without a rate</div>}
          </div>
          <div className="stat">
            <div className="label">Not billed</div>
            <div className="value">{formatMoney(t.unbilledAmount, baseCurrency)}</div>
            {t.estimated > 0 && <div className="label">{t.estimated} estimated</div>}
          </div>
        </div>
        <Link className="btn block" to={{ pathname: '/summary', search: new URLSearchParams({ ...periodToParams(period), ...(clientId != null ? { client: String(clientId) } : {}) }).toString() }}>
          Customer summary (Excel / PDF)
        </Link>
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

      <SummaryTable title="By client" rows={[...byClient.entries()].map(([k, list]) => [clientName(k), list] as const)} currency={currency} openCurrency={baseCurrency} money={money} />
      <SummaryTable
        title="By project"
        rows={[...byProject.entries()].map(([k, list]) => {
          const [c, p] = k.split(':')
          return [`${clientName(Number(c))}${p ? ` · ${projectName(Number(p))}` : ''}`, list] as const
        })}
        currency={currency}
        openCurrency={baseCurrency}
        money={money}
      />
      <SummaryTable
        title="By month"
        rows={[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, list]) => [monthLabel(k), list] as const)}
        currency={currency}
        openCurrency={baseCurrency}
        money={money}
      />
      <p className="muted small">
        Hours and amounts are on the billed basis (start snapped to 10 minutes, 15-minute steps); actual minutes are shown
        where they differ. Non-billable work {includeNonBillable ? 'is counted in the hours but never in the amounts' : 'is left out'}.{' '}
        {money === 'gross'
          ? `Totals per client use that client's currency; the overall figures use ${currency}.`
          : money === 'net'
            ? `Net = gross minus platform fees (Upwork); direct work has no fee. Figures in ${currency}.`
            : 'Net in EUR uses the exchange rate of the payout that paid each entry; entries not paid out yet use the ECB rate of the day.'}
        {t.estimated > 0 && ` ${t.estimated} entries still carry estimated fees or rates.`}
      </p>
    </>
  )
}

function SummaryTable({ title, rows, currency, openCurrency, money }: { title: string; rows: readonly (readonly [string, TimeEntry[]])[]; currency: string; openCurrency: string; money: MoneyMode }) {
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
                  <td className="num">{formatMoney(amountOf(t, money), currency)}</td>
                  <td className="num">{t.unbilledAmount ? formatMoney(t.unbilledAmount, openCurrency) : '–'}</td>
                </tr>
              )
            })}
            <tr className="total">
              <td>Total</td>
              <td className="num">{formatDuration(all.billedMin)}</td>
              <td className="num">{formatMoney(amountOf(all, money), currency)}</td>
              <td className="num">{all.unbilledAmount ? formatMoney(all.unbilledAmount, openCurrency) : '–'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
