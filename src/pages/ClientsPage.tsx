import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useClients, useProjects } from '../db/hooks'
import { isPlatformClient, rateFor } from '../db/repo'
import type { Client, Project } from '../db/types'
import { formatMoney, todayIso } from '../lib/time'

type GroupKey = 'current' | 'upwork' | 'archive'

/** Clients in three groups: the ones work is tracked for by hand, the Upwork ones (imported), and the archive. */
export default function ClientsPage() {
  const clients = useClients(true)
  const projects = useProjects(undefined, true)
  const [open, setOpen] = useState<Record<GroupKey, boolean>>({ current: true, upwork: false, archive: false })

  const groups: { key: GroupKey; title: string; items: Client[]; collapsible: boolean }[] = [
    { key: 'current', title: 'Current', items: clients.filter((c) => !c.archived && !isPlatformClient(c)), collapsible: false },
    { key: 'upwork', title: 'Upwork', items: clients.filter((c) => !c.archived && isPlatformClient(c)), collapsible: true },
    { key: 'archive', title: 'Archive', items: clients.filter((c) => c.archived), collapsible: true },
  ]

  return (
    <>
      <div className="topbar">
        <h1>Clients</h1>
        <Link className="btn small primary" to="/clients/new">
          + Add
        </Link>
      </div>

      {clients.length === 0 && (
        <div className="card">
          <div className="empty">No clients yet. Add one, or import an Excel file under Data.</div>
        </div>
      )}
      {groups
        .filter((g) => g.items.length > 0 || g.key === 'current')
        .map((g) => {
          const shown = !g.collapsible || open[g.key]
          return (
            <section key={g.key}>
              <div className="row between">
                <h2>
                  {g.title} <span className="muted small">({g.items.length})</span>
                </h2>
                {g.collapsible && (
                  <button className="btn small" onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))} aria-expanded={shown} data-testid={`clients-${g.key}`}>
                    {shown ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
              {shown && (
                <div className="card tight">
                  {g.items.length === 0 ? <div className="empty">No current clients. Add one above.</div> : g.items.map((c) => <ClientRow key={c.id} client={c} projects={projects} />)}
                </div>
              )}
            </section>
          )
        })}
    </>
  )
}

function ClientRow({ client: c, projects }: { client: Client; projects: Project[] }) {
  const today = todayIso()
  const count = projects.filter((p) => p.clientId === c.id && !p.archived).length
  return (
    <Link className="list-item" to={`/clients/${c.id}`}>
      <div className="grow">
        <div className="title">{c.name}</div>
        <div className="sub">
          {formatMoney(rateFor(c, today), c.currency)}/h{c.rates?.length ? ` · ${c.rates.length} rate change${c.rates.length === 1 ? '' : 's'}` : ''}
          {count ? ` · ${count} project${count === 1 ? '' : 's'}` : ''}
          {c.businessName ? ` · ${c.businessName}` : ''}
        </div>
      </div>
      <span className="muted">›</span>
    </Link>
  )
}
