import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import {
  addOtherIncome,
  defaultIncomeDate,
  deleteOtherIncome,
  INCOME_CATEGORIES,
  INCOME_CATEGORY_KEYS,
  incomeTotals,
  isFromFinanceApp,
  queryOtherIncome,
  updateOtherIncome,
} from '../db/income'
import type { IncomeCategory, OtherIncome } from '../db/types'
import { formatDate, periodFromParams, periodRange, periodToParams, type PeriodState } from '../lib/period'
import { formatMoney, todayIso } from '../lib/time'

interface Draft {
  id?: number
  date: string
  category: IncomeCategory
  amount: string
  source: string
  notes: string
}

const emptyDraft = (): Draft => ({ date: defaultIncomeDate(), category: 'rent', amount: '', source: '', notes: '' })

/**
 * Other income (rent, investments, sales, benefits…), so Reports can show the whole income of a period: billed work
 * net in EUR plus this. Most rows come from the personal finances app with their real dates and categories (read-only
 * here); rows can also be added by hand.
 */
export default function IncomePage() {
  const [params, setParams] = useSearchParams()
  const period = periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } })
  const setPeriod = (next: PeriodState) => setParams(periodToParams(next), { replace: true })
  const toast = useToast()
  const range = periodRange(period)
  const rows = useLiveQuery(() => queryOtherIncome(range), [range.from, range.to], [] as OtherIncome[])
  const t = useMemo(() => incomeTotals(rows), [rows])
  const fromFinanceApp = rows.filter(isFromFinanceApp).length

  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const edit = (row: OtherIncome) => {
    if (isFromFinanceApp(row)) {
      toast('This row comes from the finance app; change it there')
      return
    }
    setDraft({ id: row.id, date: row.date, category: row.category, amount: String(row.amount), source: row.source ?? '', notes: row.notes })
  }
  const save = async () => {
    const amount = Number(draft.amount.replace(',', '.'))
    if (!draft.date || !Number.isFinite(amount) || amount === 0) {
      toast('Enter a date and an amount')
      return
    }
    const input = { date: draft.date, category: draft.category, amount, source: draft.source, notes: draft.notes }
    if (draft.id != null) {
      await updateOtherIncome(draft.id, input)
      toast('Income updated')
    } else {
      await addOtherIncome(input)
      toast('Income added')
    }
    // Keep the date and the kind for the next row (the current ones, in case they were already changed); clear the rest.
    setDraft((d) => ({ ...emptyDraft(), date: d.date, category: d.category }))
  }
  const remove = async () => {
    if (draft.id == null || !confirm('Delete this income row?')) return
    await deleteOtherIncome(draft.id)
    setDraft(emptyDraft())
    toast('Income deleted')
  }

  return (
    <>
      <div className="topbar">
        <h1>Other income</h1>
        <Link className="btn small" to={{ pathname: '/reports', search: new URLSearchParams(periodToParams(period)).toString() }}>
          Reports
        </Link>
      </div>

      <div className="card stack">
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Other income</div>
            <div className="value" data-testid="income-total">
              {formatMoney(t.total, 'EUR')}
            </div>
            <div className="label">
              {t.count} rows{fromFinanceApp ? ` · ${fromFinanceApp} from the finance app` : ''}
            </div>
          </div>
          {INCOME_CATEGORY_KEYS.filter((k) => t.byCategory[k] !== 0).map((k) => (
            <div className="stat" key={k}>
              <div className="label">{INCOME_CATEGORIES[k]}</div>
              <div className="value">{formatMoney(t.byCategory[k], 'EUR')}</div>
            </div>
          ))}
        </div>
        <p className="muted small">
          Rent, investment returns, sales of goods, social benefits and other income. The personal finances app sends its income
          records here on every bank sync, with their real dates, categories and descriptions (salary and Upwork payouts stay
          out: they are the billed work). Reports adds this to the billed work for the total income of a period.
        </p>
      </div>

      <h2>{draft.id != null ? 'Edit income' : 'Add income by hand'}</h2>
      <div className="card stack">
        <div className="grid-2">
          <label className="field">
            <span>Date</span>
            <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} data-testid="income-date" />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as IncomeCategory })} data-testid="income-category">
              {INCOME_CATEGORY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {INCOME_CATEGORIES[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount (EUR)</span>
            <input type="number" inputMode="decimal" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} data-testid="income-amount" />
          </label>
          <label className="field">
            <span>Source (Mintos, tenant, buyer…)</span>
            <input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Notes</span>
          <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        </label>
        <div className="actions">
          {draft.id != null && (
            <>
              <button className="btn danger" onClick={remove}>
                Delete
              </button>
              <button className="btn" onClick={() => setDraft(emptyDraft())}>
                Cancel
              </button>
            </>
          )}
          <button className="btn primary" onClick={save} data-testid="income-save">
            {draft.id != null ? 'Save changes' : 'Add'}
          </button>
        </div>
      </div>

      <h2>Rows</h2>
      <div className="card">
        {rows.length === 0 ? (
          <p className="muted">No other income in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Kind</th>
                <th className="num">EUR</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => edit(r)} style={{ cursor: 'pointer' }} data-testid="income-row">
                  <td className="nowrap">{formatDate(r.date)}</td>
                  <td>
                    {r.sourceCategory ?? INCOME_CATEGORIES[r.category] ?? r.category}
                    {r.source && <span className="muted"> · {r.source}</span>}
                    {r.notes && <div className="muted small">{r.notes}</div>}
                  </td>
                  <td className="num">{formatMoney(r.amount, 'EUR')}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={2}>Total</td>
                <td className="num">{formatMoney(t.total, 'EUR')}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
