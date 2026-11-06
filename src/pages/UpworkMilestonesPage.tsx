import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import ClientProjectPicker from '../components/ClientProjectPicker'
import { useToast } from '../components/toastContext'
import { useLookups } from '../db/hooks'
import { db } from '../db/schema'
import type { TimeEntry, UpworkTransaction } from '../db/types'
import { formatDate } from '../lib/period'
import { formatMoney } from '../lib/time'
import { recalculateUpwork } from '../lib/upwork/allocate'
import { addMilestoneEntry, milestonesWithoutHours, suggestedMilestoneHours, type Milestone } from '../lib/upwork/milestones'
import { pullLatest } from '../sync/pullLatest'

interface Draft {
  hours: string
  date: string
  clientId?: number
  projectId?: number
}

/**
 * Fixed-price milestones and bonuses have no hours on Upwork. Here the user types an estimate per row and the
 * app makes an entry of it (gross as invoiced, rate = gross ÷ hours); fees and payouts settle it like hourly work.
 */
export default function UpworkMilestonesPage() {
  const toast = useToast()
  const { projects, clientById, clientName, projectName } = useLookups()
  const txs = useLiveQuery(() => db.upworkTransactions.toArray(), [], [] as UpworkTransaction[])
  const entries = useLiveQuery(() => db.entries.where('source').equals('upwork').toArray(), [], [] as TimeEntry[])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const list = useMemo(() => milestonesWithoutHours(txs, entries, projects), [txs, entries, projects])
  const total = list.reduce((s, m) => s + m.tx.amount, 0)
  // Hours follow from the amount and the rate: the client's own rate when it has one, else 60 USD/h.
  const suggestion = (m: Milestone, clientId = m.project?.clientId) => suggestedMilestoneHours(m.tx, clientId != null ? clientById.get(clientId) : undefined)
  const draftOf = (m: Milestone): Draft =>
    drafts[m.tx.txId] ?? { hours: String(suggestion(m).hours), date: m.tx.date, clientId: m.project?.clientId, projectId: m.project?.id }
  const setDraft = (id: string, patch: Partial<Draft>, base: Draft) => setDrafts((d) => ({ ...d, [id]: { ...base, ...patch } }))

  const add = async (m: Milestone) => {
    const d = draftOf(m)
    const hours = d.hours.trim() === '' ? NaN : Number(d.hours.replace(',', '.'))
    if (!(hours >= 0)) return toast('Enter the hours (0 keeps the money without time)')
    if (d.clientId == null) return toast('Choose the client (the contract is unknown)')
    setBusy(m.tx.txId)
    try {
      await pullLatest()
      await addMilestoneEntry({ tx: m.tx, clientId: d.clientId, projectId: d.projectId, hours, date: d.date || m.tx.date }, db)
      const r = await recalculateUpwork()
      toast(`${m.title}: ${hours} h entered${r.updated ? `, ${r.updated} entries settled` : ''}`)
      setDrafts(({ [m.tx.txId]: _drop, ...rest }) => rest)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /** The rest at the suggested hours (client's rate, else 60 USD/h); each can be corrected on its entry later. */
  const addAllSuggested = async () => {
    const ready = list.filter((m) => m.project)
    if (!ready.length) return
    if (!confirm(`Create ${ready.length} entries with the suggested hours (amount ÷ the client's rate, or ÷ 60 USD/h)? Hours can be corrected on each entry later.`)) return
    setBusy('all')
    try {
      await pullLatest()
      for (const m of ready) await addMilestoneEntry({ tx: m.tx, clientId: m.project!.clientId, projectId: m.project!.id, hours: suggestion(m).hours }, db)
      const r = await recalculateUpwork()
      toast(`${ready.length} entries created, ${r.updated} settled`)
      setDrafts({})
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Upwork milestones</h1>
        <Link className="btn small" to="/data">
          ← Data
        </Link>
      </div>

      <div className="card stack">
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Without hours</div>
            <div className="value">{list.length}</div>
          </div>
          <div className="stat">
            <div className="label">Gross not yet in the reports</div>
            <div className="value">{formatMoney(total, 'USD')}</div>
          </div>
        </div>
        <p className="muted small">
          Fixed-price milestones and bonuses are invoiced without hours. The hours are suggested from the amount at the client's hourly rate, or at
          60 USD/h when the client has none. Correct the hours where you know better (0 keeps the money without time), then Add; fees and payouts
          settle the entry like hourly work, and the hours can be changed on the entry later.
        </p>
        {list.some((m) => m.project) && (
          <button className="btn" onClick={() => void addAllSuggested()} disabled={busy != null} data-testid="milestones-add-all">
            Add all {list.filter((m) => m.project).length} with the suggested hours
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card">
          <p className="muted">Every milestone and bonus has its entry.</p>
        </div>
      ) : (
        list.map((m) => {
          const d = draftOf(m)
          return (
            <div className="card stack" key={m.tx.txId} data-testid="milestone">
              <div className="row between">
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{m.title}</div>
                  <div className="muted small">
                    {formatDate(m.tx.date)} · {m.project ? `${clientName(m.project.clientId)} · ${projectName(m.project.id!)}` : (m.tx.clientName ?? 'contract unknown')}
                    {m.tx.type === 'bonus' ? ' · bonus' : ''}
                  </div>
                </div>
                <div className="mono nowrap">{formatMoney(m.tx.amount, m.tx.currency)}</div>
              </div>
              {!m.project && (
                <ClientProjectPicker clientId={d.clientId} projectId={d.projectId} onChange={(next) => setDraft(m.tx.txId, { clientId: next.clientId, projectId: next.projectId }, d)} />
              )}
              <div className="grid-2">
                <label className="field">
                  <span>
                    Hours
                    <span className="muted small">
                      {' '}
                      · at {formatMoney(suggestion(m, d.clientId).rate, m.tx.currency)}/h{suggestion(m, d.clientId).clientRate ? '' : ' (default)'}
                    </span>
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.25"
                    min="0"
                    placeholder="e.g. 6.5"
                    value={d.hours}
                    aria-label={`Hours for ${m.title}`}
                    onChange={(e) => setDraft(m.tx.txId, { hours: e.target.value }, d)}
                  />
                </label>
                <label className="field">
                  <span>Date</span>
                  <input type="date" value={d.date} onChange={(e) => setDraft(m.tx.txId, { date: e.target.value }, d)} />
                </label>
              </div>
              <button className="btn primary" onClick={() => void add(m)} disabled={busy != null} data-testid="milestone-add">
                {busy === m.tx.txId ? 'Saving…' : 'Add entry'}
              </button>
            </div>
          )
        })
      )}
    </>
  )
}
