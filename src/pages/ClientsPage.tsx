import { Link } from 'react-router-dom'
import { useClients, useProjects } from '../db/hooks'
import { rateFor } from '../db/repo'
import { formatMoney, todayIso } from '../lib/time'

export default function ClientsPage() {
  const clients = useClients(true)
  const projects = useProjects(undefined, true)
  const today = todayIso()

  return (
    <>
      <div className="topbar">
        <h1>Clients</h1>
        <Link className="btn small primary" to="/clients/new">
          + Add
        </Link>
      </div>

      <div className="card tight">
        {clients.length === 0 ? (
          <div className="empty">No clients yet. Add one, or import an Excel file under Data.</div>
        ) : (
          clients.map((c) => {
            const count = projects.filter((p) => p.clientId === c.id && !p.archived).length
            return (
              <Link key={c.id} className="list-item" to={`/clients/${c.id}`}>
                <div className="grow">
                  <div className="title">
                    {c.name} {c.archived && <span className="badge">archived</span>}
                  </div>
                  <div className="sub">
                    {formatMoney(rateFor(c, today), c.currency)}/h{c.rates?.length ? ` · ${c.rates.length} rate change${c.rates.length === 1 ? '' : 's'}` : ''}
                    {count ? ` · ${count} project${count === 1 ? '' : 's'}` : ''}
                    {c.businessName ? ` · ${c.businessName}` : ''}
                  </div>
                </div>
                <span className="muted">›</span>
              </Link>
            )
          })
        )}
      </div>
    </>
  )
}
