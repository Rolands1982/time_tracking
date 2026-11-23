import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { approveAllOtherIncome, approveOtherIncome, countResolver, knownTypes, needsReview, typeResolver } from '../db/income'
import { db } from '../db/schema'
import type { OtherIncome } from '../db/types'
import { formatDate } from '../lib/period'
import { formatMoney } from '../lib/time'
import TypeSelect from './TypeSelect'
import { useToast } from './toastContext'

const parseAmount = (s: string) => Number(s.replace(',', '.'))

/**
 * New lines from the finance app, waiting for the owner: each shows the type and the amount it would be counted
 * with, to approve as they are or after changing them. Shows nothing when no line is waiting.
 */
export default function IncomeReview() {
  const toast = useToast()
  const all = useLiveQuery(() => db.otherIncome.toArray(), [], [] as OtherIncome[])
  const typeOf = useMemo(() => typeResolver(all), [all])
  const types = useMemo(() => knownTypes(all, typeOf), [all, typeOf])
  const countOf = useMemo(() => countResolver(all, typeOf), [all, typeOf])
  const pending = useMemo(() => all.filter(needsReview).sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0)), [all])
  // What the owner changed on a line before approving it; untouched lines keep following the suggestion.
  const [edits, setEdits] = useState<Record<number, { type?: string; amount?: string }>>({})
  const [busy, setBusy] = useState(false)

  if (pending.length === 0) return null

  const edit = (id: number, patch: { type?: string; amount?: string }) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }))

  const approve = async (row: OtherIncome) => {
    const e = edits[row.id!] ?? {}
    const type = (e.type ?? typeOf(row)).trim()
    const amount = e.amount != null && e.amount.trim() ? parseAmount(e.amount) : countOf(row)
    if (!type) {
      toast('Choose a type')
      return
    }
    if (!Number.isFinite(amount)) {
      toast('Enter a number for the counted amount')
      return
    }
    await approveOtherIncome(row.id!, { type, amount })
    toast(`Approved: ${type}, ${formatMoney(amount, 'EUR')}`)
  }

  const approveAll = async () => {
    if (!confirm(`Approve all ${pending.length} lines with the type and amount shown as suggested? Changes typed in the list are not used.`)) return
    setBusy(true)
    try {
      const n = await approveAllOtherIncome()
      setEdits({})
      toast(`${n} lines approved`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 id="income-review">Other income to review ({pending.length})</h2>
      <div className="card" data-testid="income-review">
        <p className="muted small">
          New lines from the finance app. Each shows the type and the amount it is counted with until you decide: change
          them if needed, then approve. Count 0 to leave a line out.
        </p>
        {pending.map((row) => {
          const e = edits[row.id!] ?? {}
          return (
            <div className="review-line" key={row.id} data-testid="income-review-row">
              <div>
                <strong>
                  {formatDate(row.date)} · {formatMoney(row.amount, 'EUR')}
                </strong>
                {row.source && <span className="muted"> · {row.source}</span>}
                {row.notes && <div className="muted small">{row.notes}</div>}
                {row.sourceCategory && <div className="muted small">Finance app: {row.sourceCategory}</div>}
              </div>
              <div className="review-controls">
                <div className="review-type">
                  <TypeSelect value={e.type ?? typeOf(row)} types={types} onChange={(type) => edit(row.id!, { type })} testId="review-type" />
                </div>
                <input
                  className="review-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  aria-label={`Counted amount for ${formatDate(row.date)}`}
                  value={e.amount ?? String(countOf(row))}
                  onChange={(ev) => edit(row.id!, { amount: ev.target.value })}
                  data-testid="review-amount"
                />
                <button className="btn primary" onClick={() => approve(row)} disabled={busy} data-testid="review-approve">
                  Approve
                </button>
              </div>
            </div>
          )
        })}
        {pending.length > 1 && (
          <button className="btn block" onClick={approveAll} disabled={busy} style={{ marginTop: 12 }} data-testid="review-approve-all">
            Approve all {pending.length} as suggested
          </button>
        )}
      </div>
    </>
  )
}
