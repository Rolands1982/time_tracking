import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { useSettings } from '../db/hooks'
import { db } from '../db/schema'
import type { TimeEntry, UpworkTransaction } from '../db/types'
import { formatDate } from '../lib/period'
import { formatMoney } from '../lib/time'
import { allocatePayouts, linkFees, payoutsOf, rateEstimator, recalculateUpwork, recalculateWithRates, refreshRatesAndRecalculate, setPayoutEur, type Payout } from '../lib/upwork/allocate'
import { matchBankCredits, parseBankCredits, type BankMatchReport } from '../lib/upwork/bankCredits'
import { pullLatest } from '../sync/pullLatest'

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
  const [bank, setBank] = useState<{ name: string; report: BankMatchReport } | null>(null)
  const [bankKey, setBankKey] = useState(0)
  const settings = useSettings()

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
      await pullLatest()
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

  /** A bank export: match its credits to the payouts, show what would change, apply on request. */
  const onBankFile = async (f: File | null) => {
    setBank(null)
    if (!f) return
    try {
      const credits = parseBankCredits(await f.text())
      if (!credits.length) throw new Error('No credits found in the file')
      const all = payoutsOf(txs)
      const report = matchBankCredits(credits, all, rateEstimator(settings.upwork?.fxRates))
      setBank({ name: f.name, report })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  const applyBank = async () => {
    if (!bank) return
    const fresh = bank.report.matches.filter((m) => !m.already)
    setBusy(true)
    try {
      await pullLatest()
      for (const m of fresh) await setPayoutEur(m.payout.tx.txId, m.credit.amount, m.credit.date)
      setBank(null)
      setBankKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
    await recalc(`${fresh.length} payouts priced from ${bank.name}`)
  }

  const recalcWithRates = async () => {
    setBusy(true)
    try {
      await pullLatest()
      const r = await recalculateWithRates()
      const days = r.ratesFetched + r.ratesCached
      toast(
        r.rateError
          ? `Recalculated: ${r.updated} entries updated. ECB rates could not be fetched: ${r.rateError}`
          : r.ratesFetched > 0
            ? `Recalculated: ${r.ratesFetched} new ECB rates (${days} days covered), ${r.updated} entries updated`
            : `Recalculated: ECB rates already known for all ${days} days, ${r.updated} entries updated`,
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
    await pullLatest()
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
            <div className="label">Waiting for a payout</div>
            <div className="value">{estimated}</div>
            <div className="label">{noRate > 0 ? `${noRate} without any rate` : 'all with an ECB rate'}</div>
          </div>
        </div>
        <p className="muted small">
          Type what your bank received for each payout (from the bank statement) and leave the field to save. Every payout pays the oldest earnings
          first, so each entry gets the exchange rate of the payout that covered it. Until a payout with its EUR amount covers an entry, the entry
          uses the ECB rate of its day and counts as an estimate.
        </p>
        <button className="btn" onClick={() => void recalcWithRates()} disabled={busy} data-testid="upwork-recalc">
          {busy ? 'Working…' : 'Fetch ECB rates and recalculate'}
        </button>
      </div>

      <h2>Bank credits</h2>
      <div className="card stack">
        <p className="muted small">
          Load a bank statement (CSV) or an export of the Upwork credits from your finance app: columns Date and Amount (or Datums and Summa), plus
          an optional description. Each credit is matched to the withdrawal it paid out: the bank books it one to four days after the Upwork date
          and the implied rate must be a plausible EUR/USD rate.
        </p>
        <input key={bankKey} type="file" accept=".csv,.txt,text/csv" onChange={(e) => void onBankFile(e.target.files?.[0] ?? null)} aria-label="Bank credits file" />
        {bank && (
          <>
            <p className="small">
              <strong>{bank.name}</strong>: {bank.report.matches.length} credits matched ({bank.report.matches.filter((m) => m.already).length} already priced),{' '}
              {bank.report.unmatched.length} without a payout.
            </p>
            {bank.report.unmatched.length > 0 && (
              <ul className="small muted">
                {bank.report.unmatched.map((u, i) => (
                  <li key={i}>
                    {formatDate(u.credit.date)} {formatMoney(u.credit.amount, 'EUR')}
                    {u.nearest ? ` — nearest payout ${formatDate(u.nearest.tx.date)} ${formatMoney(u.nearest.usd, 'USD')} (rate ${u.rate?.toFixed(4)}); type it in below if it is the one` : ''}
                  </li>
                ))}
              </ul>
            )}
            <button className="btn primary" onClick={() => void applyBank()} disabled={busy || bank.report.matches.every((m) => m.already)} data-testid="bank-apply">
              Apply {bank.report.matches.filter((m) => !m.already).length} matches
            </button>
          </>
        )}
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
