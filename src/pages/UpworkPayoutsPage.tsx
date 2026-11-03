import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { db } from '../db/schema'
import type { TimeEntry, UpworkTransaction } from '../db/types'
import { formatDate } from '../lib/period'
import { formatMoney } from '../lib/time'
import { allocatePayouts, linkFees, payoutsOf, recalculateUpwork, recalculateWithRates, refreshRatesAndRecalculate, setPayoutEur, type Payout } from '../lib/upwork/allocate'

/**
 * Upwork payouts: what Upwork withdrew to the bank, what the bank received in EUR (typed in from the bank
 * statement), and which earnings each payout covered. Saving an amount recalculates every Upwork entry.
 */
export default function UpworkPayoutsPage() {
  const toast = useToast()
  const txs = useLiveQuery(() => db.upworkTransactions.toArray(), [], [] as UpworkTransaction[])
  const entries = useLiveQuery(() => db.entries.where('source').equals('upwork').toArray(), [], [] as TimeEntry[])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const { payouts, unpaidNet } = useMemo(() => {
    const { earnings } = linkFees(txs)
    const payouts = payoutsOf(txs)
    allocatePayouts(earnings, payouts)
    const unpaidNet = earnings.reduce((s, e) => s + e.net - e.payouts.reduce((c, p) => c + p.amount, 0), 0)
    return { payouts: [...payouts].reverse(), unpaidNet }
  }, [txs])
  const withEur = payouts.filter((p) => p.eurAmount != null)
  const estimated = entries.filter((e) => e.settlement === 'estimated' && e.amount > 0).length
  const noRate = entries.filter((e) => e.amount > 0 && e.fxRate == null).length

  /** Settle from the ledger at once; the ECB rates for whatever stays estimated are fetched afterwards. */
  const recalc = async (why: string) => {
    setBusy(true)
    try {
      const r = await recalculateUpwork()
      toast(`${why}: ${r.updated} entries updated, ${r.estimated} still estimated`)
      if (r.estimated > 0) {
        void refreshRatesAndRecalculate().then((x) => {
          if (x.rateError) toast(`ECB rates: ${x.rateError}`)
          else if (x.updated) toast(`ECB rates: ${x.updated} estimates updated`)
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const recalcWithRates = async () => {
    setBusy(true)
    try {
      const r = await recalculateWithRates()
      toast(
        r.rateError
          ? `Recalculated: ${r.updated} entries updated. ECB rates could not be fetched: ${r.rateError}`
          : `Recalculated: ${r.ratesFetched} ECB rates fetched, ${r.updated} entries updated, ${r.estimated} still estimated (not paid out yet)`,
      )
    } finally {
      setBusy(false)
    }
  }

  const save = async (p: Payout) => {
    const raw = drafts[p.tx.txId]
    if (raw == null) return
    const value = raw.trim() === '' ? undefined : Number(raw.replace(',', '.'))
    if (value != null && !(value > 0)) {
      toast('Enter the EUR amount the bank received, or leave it empty')
      return
    }
    if (value === p.eurAmount) {
      setDrafts(({ [p.tx.txId]: _drop, ...rest }) => rest)
      return
    }
    await setPayoutEur(p.tx.txId, value, value != null ? p.tx.date : undefined)
    setDrafts(({ [p.tx.txId]: _drop, ...rest }) => rest)
    await recalc(`Payout ${formatDate(p.tx.date)} saved`)
  }

  return (
    <>
      <div className="topbar">
        <h1>Upwork payouts</h1>
        <Link className="btn small" to="/data">
          ← Data
        </Link>
      </div>

      <div className="card stack">
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Payouts</div>
            <div className="value">{payouts.length}</div>
            <div className="label">{payouts.length - withEur.length} without EUR amount</div>
          </div>
          <div className="stat">
            <div className="label">Not yet paid out</div>
            <div className="value">{formatMoney(unpaidNet, 'USD')}</div>
            <div className="label">net, per the ledger</div>
          </div>
          <div className="stat">
            <div className="label">Entries estimated</div>
            <div className="value">{estimated}</div>
            <div className="label">{noRate > 0 ? `${noRate} without any rate` : `of ${entries.filter((e) => e.amount > 0).length}`}</div>
          </div>
        </div>
        <p className="muted small">
          Type what your bank received for each payout (from the bank statement) and leave the field to save. Every payout pays the oldest earnings
          first, so each entry gets the exchange rate of the payout that covered it. Entries not paid out yet use the ECB rate of the day and stay
          marked as estimates.
        </p>
        <button className="btn" onClick={() => void recalcWithRates()} disabled={busy} data-testid="upwork-recalc">
          {busy ? 'Working…' : 'Fetch ECB rates and recalculate'}
        </button>
      </div>

      <div className="card">
        {payouts.length === 0 ? (
          <div className="empty">No payouts yet. Import an Upwork pull on the Data screen first.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">USD</th>
                  <th>Covers</th>
                  <th className="num">EUR received</th>
                  <th className="num">Rate</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.tx.txId}>
                    <td className="nowrap">{formatDate(p.tx.date)}</td>
                    <td className="num nowrap">
                      {formatMoney(p.tx.amount, 'USD')}
                      {p.fee + p.adjustments > 0 && <div className="muted small">+ {formatMoney(p.fee + p.adjustments, 'USD')} fees</div>}
                    </td>
                    <td className="small">{p.from ? (p.from === p.to ? formatDate(p.from) : `${formatDate(p.from)} – ${formatDate(p.to!)}`) : '–'}</td>
                    <td className="num">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        style={{ width: '7.5em', textAlign: 'right' }}
                        aria-label={`EUR received for payout ${p.tx.date}`}
                        value={drafts[p.tx.txId] ?? (p.eurAmount != null ? String(p.eurAmount) : '')}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.tx.txId]: e.target.value }))}
                        onBlur={() => void save(p)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        disabled={busy}
                      />
                    </td>
                    <td className="num mono">{p.rate != null ? p.rate.toFixed(4) : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">
        Rate = EUR received ÷ (USD withdrawn + withdrawal fee + any FX adjustment Upwork booked on the payout), so the fees are inside the rate.
      </p>
    </>
  )
}
