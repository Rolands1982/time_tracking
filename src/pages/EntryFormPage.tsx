import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ClientProjectPicker from '../components/ClientProjectPicker'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { addEntry, deleteEntry, effectiveRate, updateEntry, type EntryInput } from '../db/repo'
import { db, DEFAULT_SETTINGS } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { durationMinutes, formatDuration, formatMoney, isValidHm, isValidIsoDate, toHm, todayIso } from '../lib/time'

interface FormState {
  date: string
  startTime: string
  endTime: string
  clientId?: number
  projectId?: number
  /** Rate typed by the user; null = follow the client/project default. */
  hourlyRate: string | null
  category: string
  comments: string
  isBilled: boolean
  invoiceDate: string
  invoiceRef: string
  billable: boolean
}

function stateFromEntry(e: TimeEntry): FormState {
  return {
    date: e.date,
    startTime: e.startTime,
    endTime: e.endTime,
    clientId: e.clientId,
    projectId: e.projectId,
    hourlyRate: String(e.hourlyRate),
    category: e.category ?? '',
    comments: e.comments,
    isBilled: e.isBilled,
    invoiceDate: e.invoiceDate ?? '',
    invoiceRef: e.invoiceRef ?? '',
    billable: e.billable !== false,
  }
}

function freshState(lastClientId?: number, lastProjectId?: number): FormState {
  const now = new Date()
  const start = new Date(now.getTime() - 60 * 60_000)
  return {
    date: todayIso(),
    startTime: toHm(start),
    endTime: toHm(now),
    clientId: lastClientId,
    projectId: lastProjectId,
    hourlyRate: null,
    category: '',
    comments: '',
    isBilled: false,
    invoiceDate: '',
    invoiceRef: '',
    billable: true,
  }
}

/** Route wrapper: loads the entry (if editing) and the settings before mounting the form. */
export default function EntryFormPage() {
  const { id } = useParams()
  const entryId = id ? Number(id) : undefined
  // Resolves to undefined only while loading (a missing settings row yields the defaults).
  const settings = useLiveQuery(async () => (await db.settings.get('app')) ?? DEFAULT_SETTINGS, [])
  const existing = useLiveQuery<TimeEntry | null | undefined>(
    async () => (entryId != null ? ((await db.entries.get(entryId)) ?? null) : null),
    [entryId],
  )

  if (existing === undefined || settings === undefined) return <p className="muted">Loading…</p>
  if (entryId != null && existing === null) return <p className="muted">Entry not found.</p>
  return (
    <EntryForm
      key={entryId ?? 'new'}
      entryId={entryId}
      existing={existing ?? undefined}
      initial={existing ? stateFromEntry(existing) : freshState(settings.lastClientId, settings.lastProjectId)}
    />
  )
}

function EntryForm({ entryId, existing, initial }: { entryId?: number; existing?: TimeEntry; initial: FormState }) {
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useSettings()
  const { clientById, projectById } = useLookups()
  const categories = useLiveQuery(
    async () => [...new Set((await db.entries.toArray()).map((e) => e.category).filter(Boolean))] as string[],
    [],
    [],
  )
  const [form, setForm] = useState<FormState>(initial)
  const [error, setError] = useState<string | null>(null)

  const client = form.clientId != null ? clientById.get(form.clientId) : undefined
  const project = form.projectId != null ? projectById.get(form.projectId) : undefined
  const suggestedRate = effectiveRate(client, project)
  const rateText = form.hourlyRate ?? String(suggestedRate)
  const rateNum = Number(rateText)

  const duration = useMemo(() => {
    try {
      return durationMinutes(form.startTime, form.endTime)
    } catch {
      return null
    }
  }, [form.startTime, form.endTime])
  const amount = duration != null && Number.isFinite(rateNum) ? (duration / 60) * rateNum : 0
  const currency = client?.currency ?? settings.defaultCurrency

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const onSave = async () => {
    setError(null)
    if (!isValidIsoDate(form.date)) return setError('Please enter a valid date.')
    if (!isValidHm(form.startTime) || !isValidHm(form.endTime)) return setError('Please enter valid start and end times.')
    if (form.clientId == null) return setError('Please choose a client.')
    if (!Number.isFinite(rateNum) || rateNum < 0) return setError('Hourly rate must be a number.')
    if (form.isBilled && form.invoiceDate && !isValidIsoDate(form.invoiceDate)) return setError('Invoice date is invalid.')
    const input: EntryInput = {
      date: form.date,
      startTime: form.startTime,
      endTime: form.endTime,
      clientId: form.clientId,
      projectId: form.projectId,
      hourlyRate: rateNum,
      category: form.category.trim() || undefined,
      comments: form.comments.trim(),
      isBilled: form.isBilled,
      invoiceDate: form.isBilled ? form.invoiceDate || undefined : undefined,
      invoiceRef: form.isBilled ? form.invoiceRef : undefined,
      billable: form.billable,
      importKey: existing?.importKey,
    }
    if (entryId != null) {
      await updateEntry(entryId, input)
      toast('Entry updated')
    } else {
      await addEntry(input)
      toast('Entry saved')
    }
    navigate(-1)
  }

  const onDelete = async () => {
    if (entryId == null || !confirm('Delete this entry?')) return
    await deleteEntry(entryId)
    toast('Entry deleted')
    navigate('/entries', { replace: true })
  }

  return (
    <>
      <div className="topbar">
        <h1>{entryId != null ? 'Edit entry' : 'New entry'}</h1>
        <Link to="/entries" className="btn small ghost">
          Cancel
        </Link>
      </div>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault()
          void onSave()
        }}
      >
        <label className="field">
          <span>Date</span>
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Start time</span>
            <input type="time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)} required />
          </label>
          <label className="field">
            <span>End time</span>
            <input type="time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)} required />
          </label>
        </div>
        <p className="muted small">
          {duration != null ? (
            <>
              Duration <strong>{formatDuration(duration)}</strong>
              {form.endTime <= form.startTime ? ' (ends after midnight)' : ''} · Amount <strong>{formatMoney(amount, currency)}</strong>
            </>
          ) : (
            'Enter start and end times'
          )}
        </p>

        <ClientProjectPicker
          clientId={form.clientId}
          projectId={form.projectId}
          newClientRate={rateNum || 0}
          onChange={(next) => setForm((f) => ({ ...f, ...next }))}
        />

        <div className="grid-2">
          <label className="field">
            <span>
              Hourly rate ({currency})
              {form.hourlyRate != null && suggestedRate > 0 && suggestedRate !== rateNum && (
                <button type="button" className="btn ghost small" style={{ minHeight: 0, padding: 0 }} onClick={() => set('hourlyRate', null)}>
                  use {suggestedRate}
                </button>
              )}
            </span>
            <input type="number" inputMode="decimal" step="0.01" min="0" value={rateText} onChange={(e) => set('hourlyRate', e.target.value)} />
          </label>
          <label className="field">
            <span>Category</span>
            <input list="categories" value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. Support" />
            <datalist id="categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
        </div>

        <label className="field">
          <span>Comments</span>
          <textarea value={form.comments} onChange={(e) => set('comments', e.target.value)} placeholder="What was done?" />
        </label>

        <label className="check">
          <input type="checkbox" checked={form.billable} onChange={(e) => set('billable', e.target.checked)} />
          Billable
        </label>
        <label className="check">
          <input type="checkbox" checked={form.isBilled} onChange={(e) => set('isBilled', e.target.checked)} />
          Is billed
        </label>
        {form.isBilled && (
          <div className="grid-2">
            <label className="field">
              <span>Invoice date</span>
              <input type="date" value={form.invoiceDate} onChange={(e) => set('invoiceDate', e.target.value)} />
            </label>
            <label className="field">
              <span>Invoice reference</span>
              <input value={form.invoiceRef} onChange={(e) => set('invoiceRef', e.target.value)} placeholder="number / period" />
            </label>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          {entryId != null && (
            <button type="button" className="btn danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="submit" className="btn primary" data-testid="save-entry">
            Save
          </button>
        </div>
      </form>
    </>
  )
}
