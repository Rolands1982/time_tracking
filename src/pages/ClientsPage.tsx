import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { useClients, useProjects, useSettings } from '../db/hooks'
import { db } from '../db/schema'
import type { Client, Project } from '../db/types'
import { computeAmount, formatMoney } from '../lib/time'

type ClientDraft = Omit<Client, 'id'> & { id?: number }

export default function ClientsPage() {
  const clients = useClients(true)
  const settings = useSettings()
  const [editing, setEditing] = useState<ClientDraft | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const toast = useToast()

  const newClient = () =>
    setEditing({ name: '', defaultRate: 0, currency: settings.defaultCurrency, email: '', notes: '' })

  const save = async () => {
    if (!editing) return
    const name = editing.name.trim()
    if (!name) return toast('Name is required')
    const clash = clients.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== editing.id)
    if (clash) return toast('A client with this name already exists')
    const record: Client = {
      ...editing,
      name,
      defaultRate: Number(editing.defaultRate) || 0,
      currency: editing.currency.trim().toUpperCase() || 'EUR',
      email: editing.email?.trim() || undefined,
      notes: editing.notes?.trim() || undefined,
    }
    if (record.id != null) await db.clients.put(record)
    else record.id = (await db.clients.add(record)) as number
    setEditing(null)
    toast('Client saved')
  }

  return (
    <>
      <div className="topbar">
        <h1>Clients</h1>
        <button className="btn small primary" onClick={newClient}>
          + Add
        </button>
      </div>

      {editing && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <h2>{editing.id != null ? 'Edit client' : 'New client'}</h2>
          <label className="field">
            <span>Name</span>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus required />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Hourly rate</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={editing.defaultRate}
                onChange={(e) => setEditing({ ...editing, defaultRate: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Currency</span>
              <input value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value })} maxLength={3} />
            </label>
          </div>
          <label className="field">
            <span>Invoice e-mail</span>
            <input type="email" value={editing.email ?? ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Notes (address, VAT number, …)</span>
            <textarea value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={Boolean(editing.archived)} onChange={(e) => setEditing({ ...editing, archived: e.target.checked })} />
            Archived (hidden from pickers)
          </label>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>
      )}

      <div className="card tight">
        {clients.length === 0 ? (
          <div className="empty">No clients yet. Add one, or import an Excel file under Data.</div>
        ) : (
          clients.map((c) => (
            <div key={c.id}>
              <button className="list-item" onClick={() => setOpenId(openId === c.id ? null : c.id!)}>
                <div className="grow">
                  <div className="title">
                    {c.name} {c.archived && <span className="badge">archived</span>}
                  </div>
                  <div className="sub">
                    {formatMoney(c.defaultRate, c.currency)}/h{c.email ? ` · ${c.email}` : ''}
                  </div>
                </div>
                <span className="muted">{openId === c.id ? '▾' : '▸'}</span>
              </button>
              {openId === c.id && <ClientDetails client={c} onEdit={() => setEditing({ ...c })} />}
            </div>
          ))
        )}
      </div>
    </>
  )
}

function ClientDetails({ client, onEdit }: { client: Client; onEdit: () => void }) {
  const projects = useProjects(client.id, true)
  const [name, setName] = useState('')
  const toast = useToast()

  const addProject = async () => {
    const n = name.trim()
    if (!n) return
    if (projects.some((p) => p.name.toLowerCase() === n.toLowerCase())) return toast('Project already exists')
    await db.projects.add({ clientId: client.id!, name: n })
    setName('')
  }
  const updateProject = (p: Project, patch: Partial<Project>) => db.projects.put({ ...p, ...patch })
  const noRate = useLiveQuery(
    () => db.entries.where('clientId').equals(client.id!).filter((e) => e.hourlyRate === 0).count(),
    [client.id],
    0,
  )
  const applyRate = async () => {
    if (client.defaultRate <= 0) return toast('Set a client rate first')
    if (!confirm(`Apply ${client.defaultRate} ${client.currency}/h to ${noRate} entries without a rate?`)) return
    const rows = await db.entries.where('clientId').equals(client.id!).filter((e) => e.hourlyRate === 0).toArray()
    await db.entries.bulkPut(
      rows.map((e) => ({ ...e, hourlyRate: client.defaultRate, amount: computeAmount(e.durationMin, client.defaultRate), updatedAt: new Date().toISOString() })),
    )
    toast(`${rows.length} entries updated`)
  }

  return (
    <div className="stack" style={{ padding: '4px 14px 14px', background: 'var(--surface-2)' }}>
      {client.notes && <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{client.notes}</p>}
      <h3>Projects</h3>
      {projects.length === 0 && <p className="muted small">No projects. Entries can be saved without a project.</p>}
      {projects.map((p) => (
        <div className="row" key={p.id}>
          <span className="grow" style={{ textDecoration: p.archived ? 'line-through' : undefined }}>
            {p.name}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            style={{ width: 110 }}
            placeholder={`rate (${client.defaultRate})`}
            value={p.defaultRate ?? ''}
            onChange={(e) => updateProject(p, { defaultRate: e.target.value === '' ? undefined : Number(e.target.value) })}
            aria-label={`Rate for ${p.name}`}
          />
          <button className="btn small" onClick={() => updateProject(p, { archived: !p.archived })}>
            {p.archived ? 'Restore' : 'Archive'}
          </button>
        </div>
      ))}
      <div className="row">
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addProject())} />
        <button className="btn small" onClick={addProject}>
          Add
        </button>
      </div>
      {noRate > 0 && (
        <button className="btn" onClick={applyRate}>
          Apply rate to {noRate} entries without a rate
        </button>
      )}
      <Link className="btn" to={`/summary?client=${client.id}&period=all`}>
        Customer summary (Excel / PDF)
      </Link>
      <button className="btn" onClick={onEdit}>
        Edit client
      </button>
    </div>
  )
}
