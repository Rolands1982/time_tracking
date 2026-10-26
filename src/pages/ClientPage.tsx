import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { useProjects, useSettings } from '../db/hooks'
import { rateFor, sortedRates } from '../db/repo'
import { db } from '../db/schema'
import type { Client, Project, RatePeriod } from '../db/types'
import { formatDate } from '../lib/period'
import { computeAmount, formatMoney, todayIso } from '../lib/time'

type Draft = Omit<Client, 'id' | 'rates'> & { id?: number; rates: RatePeriod[] }

const EMPTY: Draft = { name: '', defaultRate: 0, rates: [], currency: 'EUR', email: '', businessName: '', registrationNumber: '', vatNumber: '', vatApplicable: true, address: '', notes: '' }

function toDraft(c: Client): Draft {
  return { ...EMPTY, ...c, rates: sortedRates(c) }
}

/** Create or edit one client: invoice data, rate history and projects. */
export default function ClientPage() {
  const { id } = useParams()
  const isNew = id === 'new'
  const clientId = isNew ? undefined : Number(id)
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useSettings()
  const stored = useLiveQuery(async () => (clientId ? await db.clients.get(clientId) : undefined), [clientId])
  // Unsaved edits; while there are none the form shows the stored client (and follows changes from sync).
  const [edits, setEdits] = useState<Draft | null>(null)
  const base: Draft | null = isNew ? { ...EMPTY, currency: settings.defaultCurrency } : stored ? toDraft(stored) : null
  const draft = edits ?? base
  const dirty = edits != null

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setEdits((d) => ({ ...(d ?? base!), [key]: value }))
  const setRate = (i: number, patch: Partial<RatePeriod>) => set('rates', draft!.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) return toast('Name is required')
    const clash = await db.clients.where('name').equalsIgnoreCase(name).first()
    if (clash && clash.id !== draft.id) return toast('A client with this name already exists')
    const rates = draft.rates.map((r) => ({ from: r.from, rate: Number(r.rate) || 0 }))
    if (rates.some((r) => !r.from)) return toast('Every rate change needs a "valid from" date')
    const record: Client = {
      ...(stored ?? {}),
      ...draft,
      name,
      defaultRate: Number(draft.defaultRate) || 0,
      rates: rates.sort((a, b) => a.from.localeCompare(b.from)),
      currency: draft.currency.trim().toUpperCase() || 'EUR',
      email: draft.email?.trim() || undefined,
      businessName: draft.businessName?.trim() || undefined,
      registrationNumber: draft.registrationNumber?.trim() || undefined,
      vatNumber: draft.vatNumber?.trim() || undefined,
      address: draft.address?.trim() || undefined,
      notes: draft.notes?.trim() || undefined,
    }
    if (!record.rates!.length) delete record.rates
    if (record.id != null) await db.clients.put(record)
    else record.id = (await db.clients.add(record)) as number
    setEdits(null)
    toast('Client saved')
    if (isNew) navigate(`/clients`, { replace: true })
  }

  if (!draft) {
    return (
      <>
        <div className="topbar">
          <h1>Client</h1>
        </div>
        <div className="card">{stored === undefined && clientId ? <div className="empty">Loading…</div> : <div className="empty">Client not found.</div>}</div>
      </>
    )
  }

  const today = todayIso()
  return (
    <>
      <div className="topbar">
        <h1>{isNew ? 'New client' : draft.name || 'Client'}</h1>
        <Link className="btn small" to="/clients">
          ‹ Clients
        </Link>
      </div>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="card stack">
          <h2>Client</h2>
          <label className="field">
            <span>Name (short, used in the app)</span>
            <input value={draft.name} onChange={(e) => set('name', e.target.value)} autoFocus={isNew} required />
          </label>
          <label className="field">
            <span>Invoice e-mail</span>
            <input type="email" value={draft.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          </label>
          <label className="field">
            <span>Currency</span>
            <input value={draft.currency} onChange={(e) => set('currency', e.target.value)} maxLength={3} style={{ width: 90 }} />
          </label>
          <label className="check">
            <input type="checkbox" checked={Boolean(draft.archived)} onChange={(e) => set('archived', e.target.checked)} />
            Archived (hidden from pickers)
          </label>
        </div>

        <div className="card stack">
          <h2>Invoice data</h2>
          <label className="field">
            <span>Business name (as on the invoice)</span>
            <input value={draft.businessName ?? ''} onChange={(e) => set('businessName', e.target.value)} placeholder={draft.name} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Registration number</span>
              <input value={draft.registrationNumber ?? ''} onChange={(e) => set('registrationNumber', e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              <span>VAT number</span>
              <input value={draft.vatNumber ?? ''} onChange={(e) => set('vatNumber', e.target.value)} placeholder="LV…" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={draft.vatApplicable !== false} onChange={(e) => set('vatApplicable', e.target.checked)} />
            VAT applies to invoices for this client
          </label>
          <label className="field">
            <span>Address</span>
            <textarea value={draft.address ?? ''} onChange={(e) => set('address', e.target.value)} rows={3} />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea value={draft.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={2} />
          </label>
        </div>

        <div className="card stack">
          <h2>Hourly rate</h2>
          <label className="field">
            <span>{draft.rates.length ? `Rate before ${formatDate(draft.rates[0].from || today)}` : 'Hourly rate'}</span>
            <input type="number" inputMode="decimal" step="0.01" min="0" value={draft.defaultRate} onChange={(e) => set('defaultRate', Number(e.target.value))} aria-label="Hourly rate" />
          </label>
          {draft.rates.map((r, i) => (
            <div className="row" key={i}>
              <label className="field grow">
                <span>Valid from</span>
                <input type="date" value={r.from} onChange={(e) => setRate(i, { from: e.target.value })} required />
              </label>
              <label className="field" style={{ width: 110 }}>
                <span>Rate</span>
                <input type="number" inputMode="decimal" step="0.01" min="0" value={r.rate} onChange={(e) => setRate(i, { rate: Number(e.target.value) })} />
              </label>
              <button type="button" className="btn small" style={{ marginTop: 22 }} onClick={() => set('rates', draft.rates.filter((_, j) => j !== i))} aria-label="Remove rate change">
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => set('rates', [...draft.rates, { from: today, rate: rateFor({ defaultRate: draft.defaultRate, rates: draft.rates }, today) }])}>
            + Rate change from a date
          </button>
          <p className="muted small">
            New entries take the rate valid on their date; existing entries keep the rate they were saved with. Today's rate: {formatMoney(rateFor({ defaultRate: Number(draft.defaultRate) || 0, rates: draft.rates }, today), draft.currency)}/h.
          </p>
        </div>

        <div className="actions">
          {!isNew && (
            <Link className="btn" to={`/summary?client=${clientId}&period=all`}>
              Customer summary
            </Link>
          )}
          <button type="submit" className="btn primary" disabled={!dirty && !isNew} data-testid="save-client">
            Save
          </button>
        </div>
      </form>

      {!isNew && stored && <ProjectsCard client={stored} />}
    </>
  )
}

function ProjectsCard({ client }: { client: Client }) {
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
  const noRate = useLiveQuery(() => db.entries.where('clientId').equals(client.id!).filter((e) => e.hourlyRate === 0).count(), [client.id], 0)
  const applyRate = async () => {
    if (!confirm(`Apply the client's rate (by date) to ${noRate} entries without a rate?`)) return
    const rows = await db.entries.where('clientId').equals(client.id!).filter((e) => e.hourlyRate === 0).toArray()
    const now = new Date().toISOString()
    await db.entries.bulkPut(
      rows.map((e) => {
        const rate = rateFor(client, e.date)
        return { ...e, hourlyRate: rate, amount: computeAmount(e.billedMin ?? e.durationMin, rate), updatedAt: now }
      }),
    )
    toast(`${rows.length} entries updated`)
  }

  return (
    <div className="card stack">
      <h2>Projects</h2>
      {projects.length === 0 && <p className="muted small">No projects yet. Entries can be saved without a project.</p>}
      {projects.map((p) => (
        <div className="row" key={p.id}>
          <span className="grow" style={{ textDecoration: p.archived ? 'line-through' : undefined }}>
            {p.name}
          </span>
          <button className="btn small" onClick={() => updateProject(p, { archived: !p.archived })}>
            {p.archived ? 'Restore' : 'Archive'}
          </button>
        </div>
      ))}
      <div className="row">
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addProject())} aria-label="New project name" />
        <button className="btn small" onClick={addProject}>
          Add
        </button>
      </div>
      {noRate > 0 && (
        <button className="btn" onClick={applyRate}>
          Apply rate to {noRate} entries without a rate
        </button>
      )}
    </div>
  )
}
