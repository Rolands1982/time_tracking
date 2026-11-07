import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import PeriodPicker from '../components/PeriodPicker'
import { useToast } from '../components/toastContext'
import {
  addOtherIncome,
  defaultIncomeDate,
  deleteOtherIncome,
  importOtherIncome,
  INCOME_CATEGORIES,
  INCOME_CATEGORY_KEYS,
  incomeTotals,
  queryOtherIncome,
  updateOtherIncome,
  type IncomeImportSummary,
} from '../db/income'
import type { IncomeCategory, OtherIncome } from '../db/types'
import type { IncomeParseResult } from '../lib/excel/importOtherIncome'
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
 * Other income (rent, investments, sales, benefits…) recorded as of the end of a week, so Reports can show the
 * whole income of a period: billed work net in EUR plus this.
 */
export default function IncomePage() {
  const [params, setParams] = useSearchParams()
  const period = periodFromParams((k) => params.get(k), { period: 'month', anchor: todayIso().slice(0, 7), custom: { from: '', to: '' } })
  const setPeriod = (next: PeriodState) => setParams(periodToParams(next), { replace: true })
  const toast = useToast()
  const range = periodRange(period)
  const rows = useLiveQuery(() => queryOtherIncome(range), [range.from, range.to], [] as OtherIncome[])
  const t = useMemo(() => incomeTotals(rows), [rows])

  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [busy, setBusy] = useState(false)
  const edit = (row: OtherIncome) =>
    setDraft({ id: row.id, date: row.date, category: row.category, amount: String(row.amount), source: row.source ?? '', notes: row.notes })
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

  // Import of the weekly income workbook (one sheet per month, month-to-date figures per week-end date).
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<IncomeParseResult | null>(null)
  const [summary, setSummary] = useState<IncomeImportSummary | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const analyse = async () => {
    if (!file) return
    setBusy(true)
    try {
      const { parseOtherIncomeWorkbook } = await import('../lib/excel/importOtherIncome')
      const r = await parseOtherIncomeWorkbook(await file.arrayBuffer())
      setPreview(r)
      if (!r.rows.length) toast('No income rows recognised in this file')
    } catch (err) {
      toast(`Could not read file: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const doImport = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const s = await importOtherIncome(preview.rows)
      setSummary(s)
      toast(`Imported ${s.added} income rows${s.duplicates ? `, ${s.duplicates} already present` : ''}`)
      setPreview(null)
      setFile(null)
      setInputKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }
  const previewTotals = preview ? incomeTotals(preview.rows.map((r) => ({ ...r, notes: r.notes ?? '', currency: 'EUR', createdAt: '', updatedAt: '' }))) : null

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
            <div className="label">{t.count} rows</div>
          </div>
          {INCOME_CATEGORY_KEYS.filter((k) => t.byCategory[k] !== 0).map((k) => (
            <div className="stat" key={k}>
              <div className="label">{INCOME_CATEGORIES[k]}</div>
              <div className="value">{formatMoney(t.byCategory[k], 'EUR')}</div>
            </div>
          ))}
        </div>
        <p className="muted small">
          Rent, investment returns, sales of goods, social benefits and other income, recorded as of the end of the week they
          arrived in. Reports adds them to the billed work for the total income of a period.
        </p>
      </div>

      <h2>{draft.id != null ? 'Edit income' : 'Add income'}</h2>
      <div className="card stack">
        <div className="grid-2">
          <label className="field">
            <span>Date (end of the week)</span>
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
                    {INCOME_CATEGORIES[r.category] ?? r.category}
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

      <h2>Import the weekly income workbook</h2>
      <div className="card stack">
        <p className="muted small">
          Reads the "one sheet per month" income workbook: dates in row 1, month-to-date figures per row, the other income (Īre,
          Mintos, Citi with details in the cell notes, Pabalsti…) below the clients' Total. Each week's increase is recorded as
          of the column's date. Rows already imported are skipped, so importing the file again is safe.
        </p>
        <input
          key={inputKey}
          type="file"
          accept=".xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setPreview(null)
            setSummary(null)
          }}
          aria-label="Income workbook"
        />
        {file && !preview && (
          <button className="btn primary" onClick={analyse} disabled={busy}>
            {busy ? 'Reading…' : 'Analyse file'}
          </button>
        )}
        {preview && previewTotals && (
          <>
            <p>
              <strong>{preview.rows.length}</strong> income rows in {preview.sheets.filter((s) => s.rows > 0).length} sheets · {formatMoney(previewTotals.total, 'EUR')}
              {INCOME_CATEGORY_KEYS.filter((k) => previewTotals.byCategory[k] !== 0).map((k) => ` · ${INCOME_CATEGORIES[k]} ${formatMoney(previewTotals.byCategory[k], 'EUR')}`)}
            </p>
            <details>
              <summary className="small muted">Sheets ({preview.sheets.length})</summary>
              <pre className="log">{preview.sheets.map((s) => `${s.name}: ${s.rows} rows${s.reason ? ` (${s.reason})` : ''}`).join('\n')}</pre>
            </details>
            {preview.warnings.length > 0 && (
              <details open>
                <summary className="small muted">Warnings ({preview.warnings.length})</summary>
                <pre className="log">{preview.warnings.join('\n')}</pre>
              </details>
            )}
            <div className="actions">
              <button className="btn" onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={doImport} disabled={busy || preview.rows.length === 0} data-testid="confirm-income-import">
                Import {preview.rows.length} rows
              </button>
            </div>
          </>
        )}
        {summary && (
          <p className="small">
            Imported <strong>{summary.added}</strong> rows ({summary.duplicates} duplicates skipped).
          </p>
        )}
      </div>
    </>
  )
}
