import { db, getSettings, updateSettings, type TimeTrackingDB } from './schema'
import type { Client, Project, RunningTimer, TimeEntry } from './types'
import { computeAmount, durationMinutes, roundDuration, toHm, toIsoDate } from '../lib/time'

/** Fields the user supplies; derived fields are computed here. */
export type EntryInput = Omit<
  TimeEntry,
  'id' | 'durationMin' | 'amount' | 'createdAt' | 'updatedAt' | 'source'
> & { source?: TimeEntry['source'] }

export function buildEntry(input: EntryInput, existing?: TimeEntry): TimeEntry {
  const durationMin = durationMinutes(input.startTime, input.endTime)
  const now = new Date().toISOString()
  return {
    ...existing,
    ...input,
    comments: input.comments ?? '',
    isBilled: Boolean(input.isBilled),
    invoiceDate: input.isBilled ? input.invoiceDate || undefined : undefined,
    invoiceRef: input.isBilled ? input.invoiceRef?.trim() || undefined : undefined,
    billable: input.billable === false ? false : undefined,
    durationMin,
    amount: computeAmount(durationMin, input.hourlyRate),
    source: input.source ?? existing?.source ?? 'manual',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function addEntry(input: EntryInput, database: TimeTrackingDB = db): Promise<number> {
  const entry = buildEntry(input)
  const id = await database.entries.add(entry)
  await updateSettings({ lastClientId: entry.clientId, lastProjectId: entry.projectId }, database)
  return id as number
}

export async function updateEntry(
  id: number,
  input: EntryInput,
  database: TimeTrackingDB = db,
): Promise<void> {
  const existing = await database.entries.get(id)
  if (!existing) throw new Error(`Entry ${id} not found`)
  await database.entries.put({ ...buildEntry(input, existing), id })
}

export async function deleteEntry(id: number, database: TimeTrackingDB = db): Promise<void> {
  await database.deleteSynced('entries', id)
}

/** Mark entries as billed (or unbilled when invoiceDate is undefined). */
export async function setBilled(
  ids: number[],
  invoiceDate: string | undefined,
  database: TimeTrackingDB = db,
): Promise<void> {
  const now = new Date().toISOString()
  await database.transaction('rw', database.entries, async () => {
    for (const id of ids) {
      await database.entries.update(id, {
        isBilled: Boolean(invoiceDate),
        invoiceDate: invoiceDate || undefined,
        updatedAt: now,
      })
    }
  })
}

// ---------------------------------------------------------------- clients / projects

export async function findOrCreateClient(
  name: string,
  defaults: Partial<Client> = {},
  database: TimeTrackingDB = db,
): Promise<Client> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Client name is required')
  const existing = await database.clients.where('name').equalsIgnoreCase(trimmed).first()
  if (existing) return existing
  const client: Client = {
    name: trimmed,
    defaultRate: defaults.defaultRate ?? 0,
    currency: defaults.currency ?? (await getSettings(database)).defaultCurrency,
    email: defaults.email,
    notes: defaults.notes,
  }
  client.id = (await database.clients.add(client)) as number
  return client
}

export async function findOrCreateProject(
  clientId: number,
  name: string,
  defaults: Partial<Project> = {},
  database: TimeTrackingDB = db,
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required')
  const existing = (await database.projects.where('clientId').equals(clientId).toArray()).find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
  )
  if (existing) return existing
  const project: Project = { clientId, name: trimmed, defaultRate: defaults.defaultRate }
  project.id = (await database.projects.add(project)) as number
  return project
}

/** The rate that applies to a client/project combination. */
export function effectiveRate(client?: Client, project?: Project): number {
  if (project?.defaultRate != null && project.defaultRate > 0) return project.defaultRate
  return client?.defaultRate ?? 0
}

// ---------------------------------------------------------------- timer

export async function startTimer(
  timer: Omit<RunningTimer, 'startedAt'>,
  database: TimeTrackingDB = db,
): Promise<RunningTimer> {
  const running: RunningTimer = { ...timer, startedAt: new Date().toISOString() }
  await updateSettings({ runningTimer: running }, database)
  return running
}

export async function updateTimer(
  patch: Partial<RunningTimer>,
  database: TimeTrackingDB = db,
): Promise<void> {
  const s = await getSettings(database)
  if (!s.runningTimer) return
  await updateSettings({ runningTimer: { ...s.runningTimer, ...patch } }, database)
}

export async function cancelTimer(database: TimeTrackingDB = db): Promise<void> {
  await updateSettings({ runningTimer: undefined }, database)
}

/**
 * Stop the running timer and turn it into an entry.
 * Returns the new entry id, or undefined when no timer was running.
 */
export async function stopTimer(
  opts: { hourlyRate: number; clientId: number; projectId?: number; comments?: string; category?: string },
  database: TimeTrackingDB = db,
  now: Date = new Date(),
): Promise<number | undefined> {
  const s = await getSettings(database)
  const t = s.runningTimer
  if (!t) return undefined
  const started = new Date(t.startedAt)
  let end = now
  // Never produce a zero-length entry: the minimum is one minute.
  if (end.getTime() - started.getTime() < 60_000) end = new Date(started.getTime() + 60_000)
  let endHm = toHm(end)
  if (s.timerRoundingMin > 0) {
    const raw = Math.round((end.getTime() - started.getTime()) / 60_000)
    const rounded = roundDuration(raw, s.timerRoundingMin)
    endHm = toHm(new Date(started.getTime() + rounded * 60_000))
  }
  const id = await addEntry(
    {
      date: toIsoDate(started),
      startTime: toHm(started),
      endTime: endHm,
      clientId: opts.clientId,
      projectId: opts.projectId,
      hourlyRate: opts.hourlyRate,
      comments: opts.comments ?? t.comments ?? '',
      category: opts.category ?? t.category,
      isBilled: false,
      source: 'timer',
    },
    database,
  )
  await updateSettings({ runningTimer: undefined }, database)
  return id
}

// ---------------------------------------------------------------- reporting

export interface EntryFilter {
  from?: string
  to?: string
  clientId?: number
  projectId?: number
  billed?: boolean
}

export async function queryEntries(
  filter: EntryFilter = {},
  database: TimeTrackingDB = db,
): Promise<TimeEntry[]> {
  let coll = database.entries.orderBy('date')
  if (filter.from || filter.to) {
    coll = database.entries.where('date').between(filter.from ?? '0000', filter.to ?? '9999', true, true)
  }
  const rows = await coll.toArray()
  return rows
    .filter((e) => (filter.clientId == null ? true : e.clientId === filter.clientId))
    .filter((e) => (filter.projectId == null ? true : e.projectId === filter.projectId))
    .filter((e) => (filter.billed == null ? true : e.isBilled === filter.billed))
    .sort(compareEntries)
}

export function compareEntries(a: TimeEntry, b: TimeEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1
  return (a.id ?? 0) - (b.id ?? 0)
}

export interface Totals {
  count: number
  durationMin: number
  amount: number
  billedAmount: number
  unbilledAmount: number
  unbilledMin: number
}

export function totals(entries: TimeEntry[]): Totals {
  const t: Totals = { count: 0, durationMin: 0, amount: 0, billedAmount: 0, unbilledAmount: 0, unbilledMin: 0 }
  for (const e of entries) {
    t.count++
    t.durationMin += e.durationMin
    t.amount += e.amount
    if (e.isBilled) t.billedAmount += e.amount
    else if (isBillable(e)) {
      t.unbilledAmount += e.amount
      t.unbilledMin += e.durationMin
    }
  }
  return t
}

/** Entries are billable unless explicitly flagged otherwise. */
export function isBillable(e: Pick<TimeEntry, 'billable'>): boolean {
  return e.billable !== false
}

export function groupBy<K extends string | number>(
  entries: TimeEntry[],
  key: (e: TimeEntry) => K,
): Map<K, TimeEntry[]> {
  const m = new Map<K, TimeEntry[]>()
  for (const e of entries) {
    const k = key(e)
    const arr = m.get(k)
    if (arr) arr.push(e)
    else m.set(k, [e])
  }
  return m
}
