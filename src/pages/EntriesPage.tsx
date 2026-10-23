import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useLookups, useSettings } from '../db/hooks'
import { compareEntries, groupBy, isBillable, totals } from '../db/repo'
import { db } from '../db/schema'
import { addMonths, formatDateLong, formatDuration, formatMoney, monthLabel, todayIso } from '../lib/time'

type BilledFilter = 'all' | 'open' | 'billed'

export default function EntriesPage() {
  const [month, setMonth] = useState(() => todayIso().slice(0, 7))
  const [clientId, setClientId] = useState<number | undefined>()
  const [billed, setBilled] = useState<BilledFilter>('all')
  const [search, setSearch] = useState('')
  const { clients, clientName, projectName, clientById } = useLookups()
  const settings = useSettings()

  const entries = useLiveQuery(
    () => db.entries.where('date').between(`${month}-01`, `${month}-31`, true, true).toArray(),
    [month],
    [],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries
      .filter((e) => (clientId == null ? true : e.clientId === clientId))
      .filter((e) => (billed === 'all' ? true : billed === 'billed' ? e.isBilled : !e.isBilled))
      .filter((e) => (q ? `${e.comments} ${projectName(e.projectId)} ${e.category ?? ''}`.toLowerCase().includes(q) : true))
      .sort(compareEntries)
      .reverse()
  }, [entries, clientId, billed, search, projectName])
  const t = useMemo(() => totals(filtered), [filtered])
  const byDay = useMemo(() => groupBy(filtered, (e) => e.date), [filtered])
  const currency = (clientId != null && clientById.get(clientId)?.currency) || settings.defaultCurrency

  return (
    <>
      <div className="topbar">
        <h1>Entries</h1>
        <Link to="/entries/new" className="btn small primary">
          + Add
        </Link>
      </div>

      <div className="card stack">
        <div className="month-nav">
          <button className="btn" onClick={() => setMonth((m) => addMonths(m, -1))} aria-label="Previous month">
            ‹
          </button>
          <strong>{monthLabel(month)}</strong>
          <button className="btn" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month">
            ›
          </button>
        </div>
        <div className="grid-2">
          <select value={clientId ?? ''} onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : undefined)} aria-label="Client filter">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input placeholder="Search comments…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        </div>
        <div className="segmented">
          {(['all', 'open', 'billed'] as BilledFilter[]).map((f) => (
            <button key={f} className={billed === f ? 'active' : ''} onClick={() => setBilled(f)}>
              {f === 'all' ? 'All' : f === 'open' ? 'Not billed' : 'Billed'}
            </button>
          ))}
        </div>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Entries</div>
            <div className="value">{t.count}</div>
          </div>
          <div className="stat">
            <div className="label">Hours</div>
            <div className="value">{formatDuration(t.durationMin)}</div>
          </div>
          <div className="stat">
            <div className="label">Amount</div>
            <div className="value">{formatMoney(t.amount, currency)}</div>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty">No entries in this month.</div>
        </div>
      ) : (
        [...byDay.entries()].map(([date, list]) => {
          const dt = totals(list)
          return (
            <div className="card tight" key={date}>
              <div className="group-head">
                <span>{formatDateLong(date)}</span>
                <span className="mono">{formatDuration(dt.durationMin)}</span>
              </div>
              {list.map((e) => (
                <Link key={e.id} to={`/entries/${e.id}`} className="list-item">
                  <div className="grow">
                    <div className="title">
                      {clientName(e.clientId)}
                      {e.projectId != null ? ` · ${projectName(e.projectId)}` : ''}
                    </div>
                    <div className="sub">
                      {e.startTime}–{e.endTime}
                      {e.comments ? ` · ${e.comments}` : ''}
                    </div>
                  </div>
                  <div className="right nowrap">
                    <div className="mono">{formatDuration(e.durationMin)}</div>
                    <span className={`badge ${e.isBilled ? 'billed' : isBillable(e) ? 'open' : ''}`}>
                      {e.isBilled ? 'billed' : isBillable(e) ? 'open' : 'non-billable'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )
        })
      )}
    </>
  )
}
