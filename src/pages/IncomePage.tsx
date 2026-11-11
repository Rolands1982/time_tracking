import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import { useSettings } from '../db/hooks'
import {
  addOtherIncome,
  adjustOtherIncome,
  countedAmount,
  countsNothing,
  defaultIncomeDate,
  deleteOtherIncome,
  incomeTotals,
  isFromFinanceApp,
  knownTypes,
  queryOtherIncome,
  typeResolver,
  updateOtherIncome,
} from '../db/income'
import { db, updateSettings } from '../db/schema'
import type { OtherIncome } from '../db/types'
import { formatDate, periodFromParams, periodRange, periodToParams, type PeriodState } from '../lib/period'
import { formatMoney, todayIso } from '../lib/time'

/** A row added by hand: everything is editable. */
interface ManualDraft {
  mode: 'manual'
  id?: number
  date: string
  type: string
  amount: string
  source: string
  notes: string
}

/** A row from the finance app: only the owner's type and counted amount are editable here. */
interface AdjustDraft {
  mode: 'adjust'
  row: OtherIncome
  type: string
  amount: string
}

type Draft = ManualDraft | AdjustDraft

const emptyDraft = (): ManualDraft => ({ mode: 'manual', date: defaultIncomeDate(), type: '', amount: '', source: '', notes: '' })
const parseAmount = (s: string) => Number(s.replace(',', '.'))
const NEW_TYPE = '__new__'

/**
 * Type as a dropdown of every type in use (a text list with suggestions would only offer what matches the text
 * already in it), with "New type…" for one that does not exist yet. An empty value means the suggestion.
 */
function TypeSelect({ value, onChange, types, suggestion, testId }: { value: string; onChange: (v: string) => void; types: string[]; suggestion?: string; testId: string }) {
  const [custom, setCustom] = useState(() => Boolean(value) && !types.includes(value))
  return (
    <>
      <select
        value={custom ? NEW_TYPE : value}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === NEW_TYPE)
          onChange(v === NEW_TYPE ? '' : v)
        }}
        data-testid={testId}
      >
        <option value="">{suggestion ? `Suggested: ${suggestion}` : 'Choose a type'}</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value={NEW_TYPE}>New type…</option>
      </select>
      {custom && <input autoFocus value={value} placeholder="New type" onChange={(e) => onChange(e.target.value)} data-testid={`${testId}-new`} />}
    </>
  )
}

/**
 * Other income (rent, investments, sales, benefits…), so Reports can show the whole income of a period: billed work
 * net in EUR plus this. Most rows come from the personal finances app on its daily sync; the owner files them under
 * their own types, adjusts the counted amount or leaves a row out. Rows can also be added by hand.
 */
export default function IncomePage() {
  const [params, setParams] = useSearchParams()
  const period = periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } })
  const setPeriod = (next: PeriodState) => setParams(periodToParams(next), { replace: true })
  const toast = useToast()
  const range = periodRange(period)
  const rows = useLiveQuery(() => queryOtherIncome(range), [range.from, range.to], [] as OtherIncome[])
  // Types are learned from every row, not only the period's, so a new row files itself like the earlier ones.
  const all = useLiveQuery(() => db.otherIncome.toArray(), [], [] as OtherIncome[])
  const typeOf = useMemo(() => typeResolver(all), [all])
  const types = useMemo(() => knownTypes(all, typeOf), [all, typeOf])
  const t = useMemo(() => incomeTotals(rows, typeOf), [rows, typeOf])
  const fromFinanceApp = rows.filter(isFromFinanceApp).length
  // Lines counting 0 are hidden unless the owner shows them; the click applies at once, the setting persists.
  const settings = useSettings()
  const [showZeroOverride, setShowZeroOverride] = useState<boolean | null>(null)
  const showZero = showZeroOverride ?? settings.incomeShowZero ?? false
  const setShowZero = (on: boolean) => {
    setShowZeroOverride(on)
    void updateSettings({ incomeShowZero: on })
  }
  const visible = useMemo(() => (showZero ? rows : rows.filter((r) => !countsNothing(r))), [rows, showZero])
  const hiddenCount = rows.length - visible.length

  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const open = (row: OtherIncome) => {
    if (isFromFinanceApp(row)) {
      setDraft({ mode: 'adjust', row, type: row.type ?? '', amount: row.amountOverride != null ? String(row.amountOverride) : '' })
    } else {
      setDraft({ mode: 'manual', id: row.id, date: row.date, type: typeOf(row), amount: String(row.amount), source: row.source ?? '', notes: row.notes })
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const saveManual = async (d: ManualDraft) => {
    const amount = parseAmount(d.amount)
    if (!d.date || !Number.isFinite(amount) || amount === 0) {
      toast('Enter a date and an amount')
      return
    }
    const input = { date: d.date, type: d.type, amount, source: d.source, notes: d.notes }
    if (d.id != null) {
      await updateOtherIncome(d.id, input)
      toast('Income updated')
    } else {
      await addOtherIncome(input)
      toast('Income added')
    }
    // Keep the date and the type for the next row; clear the rest.
    setDraft((x) => ({ ...emptyDraft(), date: x.mode === 'manual' ? x.date : defaultIncomeDate(), type: x.type }))
  }
  const saveAdjust = async (d: AdjustDraft) => {
    const amount = d.amount.trim() ? parseAmount(d.amount) : undefined
    if (amount != null && !Number.isFinite(amount)) {
      toast('Enter a number for the counted amount, or leave it empty')
      return
    }
    await adjustOtherIncome(d.row.id!, { type: d.type, amountOverride: amount, excluded: d.row.excluded })
    toast('Income adjusted')
    setDraft(emptyDraft())
  }
  const remove = async (id: number) => {
    if (!confirm('Delete this income row?')) return
    await deleteOtherIncome(id)
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
              {t.zero + t.excluded ? ` · ${t.zero + t.excluded} counting 0` : ''}
            </div>
          </div>
          {t.byType.map((b) => (
            <div className="stat" key={b.type}>
              <div className="label">{b.type}</div>
              <div className="value">{formatMoney(b.amount, 'EUR')}</div>
            </div>
          ))}
        </div>
        <p className="muted small">
          The personal finances app sends its income records on every bank sync (salary and client payments stay out: they
          are the billed work). Tap a row to file it under one of your types, count a different amount or leave it out; the
          sync never overwrites that. Set the counted amount to 0 to leave a row out. New rows take the type you used most for
          the same kind of record.
        </p>
      </div>

      {draft.mode === 'adjust' ? (
        <AdjustCard
          key={draft.row.id}
          draft={draft}
          types={types}
          learned={typeOf({ ...draft.row, type: undefined })}
          onChange={setDraft}
          onSave={saveAdjust}
          onCancel={() => setDraft(emptyDraft())}
        />
      ) : (
        <>
          <h2>{draft.id != null ? 'Edit income' : 'Add income by hand'}</h2>
          <div className="card stack">
            <div className="grid-2">
              <label className="field">
                <span>Date</span>
                <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} data-testid="income-date" />
              </label>
              <label className="field">
                <span>Type</span>
                <TypeSelect key={draft.id ?? 'new'} value={draft.type} types={types} onChange={(type) => setDraft({ ...draft, type })} testId="income-type" />
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
                  <button className="btn danger" onClick={() => remove(draft.id!)}>
                    Delete
                  </button>
                  <button className="btn" onClick={() => setDraft(emptyDraft())}>
                    Cancel
                  </button>
                </>
              )}
              <button className="btn primary" onClick={() => saveManual(draft)} data-testid="income-save">
                {draft.id != null ? 'Save changes' : 'Add'}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="row between">
        <h2>Rows</h2>
        <label className="check small">
          <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} data-testid="income-show-zero" />
          Show lines counting 0{!showZero && hiddenCount ? ` (${hiddenCount})` : ''}
        </label>
      </div>
      <div className="card">
        {visible.length === 0 ? (
          <p className="muted">{rows.length ? 'Every line in this period counts 0.' : 'No other income in this period.'}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="num">EUR</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const adjusted = r.amountOverride != null
                const editing = draft.mode === 'adjust' ? draft.row.id === r.id : draft.id === r.id
                return (
                  <tr
                    key={r.id}
                    onClick={() => open(r)}
                    className={editing ? 'editing' : undefined}
                    aria-selected={editing}
                    style={{ cursor: 'pointer', opacity: countsNothing(r) ? 0.5 : 1 }}
                    data-testid="income-row"
                  >
                    <td className="nowrap">{formatDate(r.date)}</td>
                    <td>
                      {typeOf(r)}
                      {r.excluded && <span className="muted"> · excluded</span>}
                      {r.source && <span className="muted"> · {r.source}</span>}
                      {r.notes && <div className="muted small">{r.notes}</div>}
                      {r.sourceCategory && r.sourceCategory !== typeOf(r) && <div className="muted small">Finance app: {r.sourceCategory}</div>}
                    </td>
                    <td className="num">
                      {formatMoney(countedAmount(r), 'EUR')}
                      {adjusted && (
                        <div className="muted small" style={{ textDecoration: 'line-through' }}>
                          {formatMoney(r.amount, 'EUR')}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
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

function AdjustCard({
  draft,
  types,
  learned,
  onChange,
  onSave,
  onCancel,
}: {
  draft: AdjustDraft
  types: string[]
  learned: string
  onChange: (d: Draft) => void
  onSave: (d: AdjustDraft) => void
  onCancel: () => void
}) {
  const r = draft.row
  return (
    <>
      <h2>Adjust income</h2>
      <div className="card stack" data-testid="income-adjust">
        <div>
          <strong>
            {formatDate(r.date)} · {formatMoney(r.amount, 'EUR')}
          </strong>
          {r.source && <span className="muted"> · {r.source}</span>}
          {r.notes && <div className="muted small">{r.notes}</div>}
          <div className="muted small">From the finance app{r.sourceCategory ? `: ${r.sourceCategory}` : ''}. Date, amount and description are changed there.</div>
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Type</span>
            <TypeSelect value={draft.type} types={types} suggestion={learned} onChange={(type) => onChange({ ...draft, type })} testId="adjust-type" />
          </label>
          <label className="field">
            <span>Counted amount (EUR)</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={draft.amount}
              placeholder={String(r.amount)}
              onChange={(e) => onChange({ ...draft, amount: e.target.value })}
              data-testid="adjust-amount"
            />
          </label>
        </div>
        <p className="muted small">Counted amount 0 leaves the row out. Leave it empty to count the booked amount; the type left on "Suggested" follows the suggestion ({learned}).</p>
        <div className="actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(draft)} data-testid="adjust-save">
            Save
          </button>
        </div>
      </div>
    </>
  )
}
