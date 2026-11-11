import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { groupBy, isBillable, isPlatformClient, setBilled, totals, type Totals } from '../db/repo'
import { countResolver, incomeTotals, queryOtherIncome, typeResolver } from '../db/income'
import { db, updateSettings } from '../db/schema'
import type { OtherIncome, TimeEntry } from '../db/types'
import { downloadBlob, stamp, XLSX_MIME } from '../lib/download'
import { periodFromParams, periodLabel as labelFor, periodRange, periodToParams, type PeriodState } from '../lib/period'
import { formatDuration, formatMoney, monthKey, monthLabel, todayIso } from '../lib/time'

/**
 * Money in the reports: without a platform client selected everything is net in EUR, so direct and Upwork
 * work add up (direct work as invoiced; Upwork work after its fee, at the rate of the payout that paid it or
 * the ECB rate of the day until then). With an Upwork client selected, gross, net and net EUR stand side by
 * side in that client's currency.
 */
export default function ReportsPage() {
  const [params] = useSearchParams()
  const [period, setPeriod] = useState<PeriodState>(() => periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } }))
  const [clientId, setClientId] = useState<number | undefined>()
  const [invoiceDate, setInvoiceDate] = useState(todayIso())
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
  // Other income (rent, investments…) of the period, so the total income of a week or a month is one figure.
  const income = useLiveQuery(() => queryOtherIncome(range), [range.from, range.to], [] as OtherIncome[])
  // The owner's types are learned from every row, so rows of this period file themselves like earlier ones.
  const allIncome = useLiveQuery(() => db.otherIncome.toArray(), [], [] as OtherIncome[])
  const incomeType = useMemo(() => typeResolver(allIncome), [allIncome])
  const incomeCount = useMemo(() => countResolver(allIncome, incomeType), [allIncome, incomeType])
  const inc = useMemo(() => incomeTotals(income, incomeType, incomeCount), [income, incomeType, incomeCount])
  const client = clientId != null ? clientById.get(clientId) : undefined
  const platform = isPlatformClient(client)
  const currency = client?.currency || settings.defaultCurrency

  const byClient = useMemo(() => groupBy(filtered, (e) => e.clientId), [filtered])
  const byProject = useMemo(() => groupBy(filtered, (e) => `${e.clientId}:${e.projectId ?? ''}`), [filtered])
  const byMonth = useMemo(() => groupBy(filtered, (e) => monthKey(e.date)), [filtered])
  const unbilledByClient = useMemo(() => groupBy(filtered.filter((e) => !e.isBilled), (e) => e.clientId), [filtered])

  const periodLabel = labelFor(period)
  // The filter offers the clients that have entries in the period (plus the one selected, so the choice stays valid).
  const clientOptions = useMemo(() => {
    const present = new Set(entries.map((e) => e.clientId))
    return clients.filter((c) => present.has(c.id!) || c.id === clientId)
  }, [entries, clients, clientId])

  // Upwork bills its own work with the weekly invoice; only direct work is marked billed by hand.
  const manual = (list: TimeEntry[]) => list.filter((e) => e.source !== 'upwork')
  const markBilled = async (cid: number) => {
    const ids = manual(unbilledByClient.get(cid) ?? []).map((e) => e.id!)
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

  const eurNotes = (x: Totals) => [x.estimated > 0 ? `${x.estimated} estimated` : '', x.eurMissing > 0 ? `${x.eurMissing} without a rate` : ''].filter(Boolean)
  const awaiting = t.feeEstimated > 0 ? `${t.feeEstimated} awaiting Upwork invoice` : ''

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
          {clientOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={includeNonBillable} onChange={(e) => setIncludeNonBillable(e.target.checked)} data-testid="include-non-billable" />
          Include non-billable hours
        </label>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">{includeNonBillable ? 'Hours' : 'Billed hours'}</div>
            <div className="value" data-testid="report-hours">
              {(t.billedMin / 60).toFixed(2)}
            </div>
            {t.nonBillableMin > 0 && <div className="label">{(t.nonBillableMin / 60).toFixed(2)} non-billable</div>}
            {t.billedMin !== t.durationMin && <div className="label">actual {(t.durationMin / 60).toFixed(2)}</div>}
            {t.estimatedHours > 0 && <div className="label">{t.estimatedHours} with estimated hours</div>}
          </div>
          {platform && (
            <>
              <div className="stat">
                <div className="label">Gross</div>
                <div className="value">{formatMoney(t.amount, currency)}</div>
              </div>
              <div className="stat">
                <div className="label">Net after fees</div>
                <div className="value">{formatMoney(t.netAmount, currency)}</div>
                {t.feeAmount > 0 && <div className="label">fees {formatMoney(t.feeAmount, currency)}</div>}
              </div>
            </>
          )}
          <div className="stat">
            <div className="label">Net EUR</div>
            <div className="value" data-testid="report-amount">
              {formatMoney(t.netAmountEur, 'EUR')}
            </div>
            {eurNotes(t).map((s) => (
              <div className="label" key={s}>
                {s}
              </div>
            ))}
          </div>
          <div className="stat">
            <div className="label">{platform ? 'Not billed (net)' : 'Not billed (net EUR)'}</div>
            <div className="value">{platform ? formatMoney(t.unbilledAmount, currency) : formatMoney(t.unbilledAmountEur, 'EUR')}</div>
            {awaiting && <div className="label">{awaiting}</div>}
          </div>
        </div>
        <Link className="btn block" to={{ pathname: '/summary', search: new URLSearchParams({ ...periodToParams(period), ...(clientId != null ? { client: String(clientId) } : {}) }).toString() }}>
          Customer summary (Excel / PDF)
        </Link>
        <Link className="btn block" to={{ pathname: '/reports/monthly', search: new URLSearchParams({ month: period.period === 'month' ? period.anchor.slice(0, 7) : todayIso().slice(0, 7) }).toString() }} data-testid="monthly-report">
          Monthly hours report (PDF / Excel)
        </Link>
      </div>

      {clientId == null && (
        <>
          <h2>Income in the period</h2>
          <div className="card stack">
            <table>
              <tbody>
                <tr>
                  <td>Billed work (net EUR)</td>
                  <td className="num">{formatMoney(t.netAmountEur, 'EUR')}</td>
                </tr>
                {inc.byType.map((b) => (
                  <tr key={b.type}>
                    <td>{b.type}</td>
                    <td className="num" data-testid={`report-income-${b.type}`}>
                      {formatMoney(b.amount, 'EUR')}
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total income</td>
                  <td className="num" data-testid="report-total-income">
                    {formatMoney(t.netAmountEur + inc.total, 'EUR')}
                  </td>
                </tr>
              </tbody>
            </table>
            <Link className="btn block" to={{ pathname: '/income', search: new URLSearchParams(periodToParams(period)).toString() }} data-testid="other-income-link">
              Other income ({inc.count} rows)
            </Link>
          </div>
        </>
      )}

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
                  <th className="num">{platform ? 'Net' : 'Net EUR'}</th>
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
                        {manual(list).length === 0 && <div className="muted small">billed weekly by Upwork</div>}
                      </td>
                      <td className="num">{(ut.durationMin / 60).toFixed(2)}</td>
                      <td className="num">{platform ? formatMoney(ut.netAmount, currency) : formatMoney(ut.netAmountEur, 'EUR')}</td>
                      <td className="num">
                        {manual(list).length > 0 && (
                          <button className="btn small" onClick={() => markBilled(cid)}>
                            Mark billed
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      <SummaryTable title="By client" rows={[...byClient.entries()].map(([k, list]) => [clientName(k), list] as const)} platform={platform} currency={currency} />
      <SummaryTable
        title="By project"
        rows={[...byProject.entries()].map(([k, list]) => {
          const [c, p] = k.split(':')
          return [`${clientName(Number(c))}${p ? ` · ${projectName(Number(p))}` : ''}`, list] as const
        })}
        platform={platform}
        currency={currency}
      />
      <SummaryTable
        title="By month"
        rows={[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, list]) => [monthLabel(k), list] as const)}
        platform={platform}
        currency={currency}
      />
      <p className="muted small">
        Hours and amounts are on the billed basis (start snapped to 10 minutes, 15-minute steps); actual minutes are shown
        where they differ. Non-billable work {includeNonBillable ? 'is counted in the hours but never in the amounts' : 'is left out'}.{' '}
        {platform
          ? `Gross as invoiced by Upwork, net after its fee, and net in EUR at the rate of the payout that paid each entry (the ECB rate of the day until it is paid out). Work counts as billed once Upwork's weekly invoice is in the ledger; until then its fee, and so its net, is an estimate.`
          : 'Amounts are net in EUR so that all clients add up: direct work as invoiced, Upwork work after its fee at the rate of the payout that paid it (the ECB rate of the day until then). Select an Upwork client to see gross, net and EUR side by side.'}
        {t.estimated > 0 && ` ${t.estimated} entries are still estimates.`}
      </p>
    </>
  )
}

/**
 * Per-group totals: a table with net EUR and what is open, or, for a platform client, one block per group with
 * hours, gross, net and net EUR in a mini grid (four money columns do not fit a phone-width table).
 */
function SummaryTable({ title, rows, platform, currency }: { title: string; rows: readonly (readonly [string, TimeEntry[]])[]; platform: boolean; currency: string }) {
  if (!rows.length) return null
  const all = totals(rows.flatMap(([, l]) => l))
  if (platform) {
    const figures = (t: Totals) => [
      ['Hours', formatDuration(t.billedMin)],
      ['Gross', formatMoney(t.amount, currency)],
      ['Net', formatMoney(t.netAmount, currency)],
      ['Net EUR', formatMoney(t.netAmountEur, 'EUR')],
    ]
    const block = (label: string, t: Totals, total = false) => (
      <div className={`group-row${total ? ' total' : ''}`} key={label} data-testid="report-group">
        <div className="group-name">{label}</div>
        <div className="mini-grid">
          {figures(t).map(([l, v]) => (
            <div key={l}>
              <span className="label">{l}</span>
              <span className="value">{v}</span>
            </div>
          ))}
        </div>
      </div>
    )
    return (
      <>
        <h2>{title}</h2>
        <div className="card group-list">
          {rows.map(([label, list]) => block(label, totals(list)))}
          {rows.length > 1 && block('Total', all, true)}
        </div>
      </>
    )
  }
  const cells = (t: Totals) => [formatMoney(t.netAmountEur, 'EUR'), t.unbilledAmountEur ? formatMoney(t.unbilledAmountEur, 'EUR') : '–']
  const heads = ['Net EUR', 'Open']
  return (
    <>
      <h2>{title}</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{title.replace('By ', '')}</th>
              <th className="num">Hours</th>
              {heads.map((h) => (
                <th className="num" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, list]) => {
              const t = totals(list)
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{formatDuration(t.billedMin)}</td>
                  {cells(t).map((v, i) => (
                    <td className="num" key={i}>
                      {v}
                    </td>
                  ))}
                </tr>
              )
            })}
            <tr className="total">
              <td>Total</td>
              <td className="num">{formatDuration(all.billedMin)}</td>
              {cells(all).map((v, i) => (
                <td className="num" key={i}>
                  {v}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
