import { db, getSettings, updateSettings, type TimeTrackingDB } from './schema'
import type { Client, Project, RatePeriod, RunningTimer, TimeEntry } from './types'
import { roundInterval } from '../lib/rounding'
import { computeAmount, durationMinutes, toHm, toIsoDate } from '../lib/time'

/** Fields the user supplies; derived fields are computed here. */
export type EntryInput = Omit<
  TimeEntry,
  'id' | 'durationMin' | 'amount' | 'createdAt' | 'updatedAt' | 'source' | 'billedStartTime' | 'billedEndTime' | 'billedMin'
> & {
  source?: TimeEntry['source']
  /**
   * Whether to derive the billed columns with the billing rules. Defaults to "keep what the
   * record had": normalised records stay normalised, old records stay untouched. New records
   * get the default from settings in addEntry().
   */
  normalize?: boolean
}

/** Minutes that are invoiced for an entry: the normalised value when present, else the real minutes. */
export function billedMinutes(e: Pick<TimeEntry, 'durationMin' | 'billedMin'>): number {
  return e.billedMin ?? e.durationMin
}

export function buildEntry(input: EntryInput, existing?: TimeEntry): TimeEntry {
  const durationMin = durationMinutes(input.startTime, input.endTime)
  const now = new Date().toISOString()
  const normalize = input.normalize ?? existing?.billedMin != null
  let billable = input.billable === false ? false : undefined
  let billed: Pick<TimeEntry, 'billedStartTime' | 'billedEndTime' | 'billedMin'> = {
    billedStartTime: undefined,
    billedEndTime: undefined,
    billedMin: undefined,
  }
  if (normalize) {
    const r = roundInterval(input.startTime, input.endTime)
    billed = { billedStartTime: r.startTime, billedEndTime: r.endTime, billedMin: r.durationMin }
    if (!r.billable) billable = false
  }
  const { normalize: _ignored, ...fields } = input
  void _ignored
  return {
    ...existing,
    ...fields,
    comments: input.comments ?? '',
    isBilled: Boolean(input.isBilled),
    invoiceDate: input.isBilled ? input.invoiceDate || undefined : undefined,
    invoiceRef: input.isBilled ? input.invoiceRef?.trim() || undefined : undefined,
    billable,
    durationMin,
    ...billed,
    amount: computeAmount(billed.billedMin ?? durationMin, input.hourlyRate),
    source: input.source ?? existing?.source ?? 'manual',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function addEntry(input: EntryInput, database: TimeTrackingDB = db): Promise<number> {
  const normalize = input.normalize ?? (await getSettings(database)).roundingMode !== 'exact'
  const entry = buildEntry({ ...input, normalize })
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
  _defaults: Partial<Project> = {},
  database: TimeTrackingDB = db,
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required')
  const existing = (await database.projects.where('clientId').equals(clientId).toArray()).find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
  )
  if (existing) return existing
  const project: Project = { clientId, name: trimmed }
  project.id = (await database.projects.add(project)) as number
  return project
}

/** Rate periods sorted by start date, without blanks. */
export function sortedRates(client: Pick<Client, 'rates'>): RatePeriod[] {
  return (client.rates ?? []).filter((r) => r.from && Number.isFinite(r.rate)).sort((a, b) => a.from.localeCompare(b.from))
}

/** The hourly rate a client is charged on a given date: the latest period starting on or before it, else the default rate. */
export function rateFor(client: Pick<Client, 'defaultRate' | 'rates'> | undefined, date: string): number {
  if (!client) return 0
  let rate = client.defaultRate ?? 0
  for (const p of sortedRates(client)) {
    if (p.from <= date) rate = p.rate
    else break
  }
  return rate
}

/** The rate to suggest for a new entry of a client on a date. Projects no longer carry rates. */
export function effectiveRate(client: Client | undefined, date: string): number {
  return rateFor(client, date)
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

export interface TimerRecording {
  /** Real start and end (seconds dropped, at least one minute long). */
  start: Date
  end: Date
  actualMin: number
  /** What the billing rules make of it. */
  billedStartTime: string
  billedEndTime: string
  billedMin: number
  billable: boolean
}

/** What a running timer would be recorded and billed as right now. */
export function timerRecording(started: Date, now: Date): TimerRecording {
  // Elapsed time is measured on the real timestamps; the stored interval starts on the whole minute.
  const actualMin = Math.max(1, Math.round((now.getTime() - started.getTime()) / 60_000))
  const start = new Date(started)
  start.setSeconds(0, 0)
  const end = new Date(start.getTime() + actualMin * 60_000)
  const r = roundInterval(toHm(start), toHm(end))
  return { start, end, actualMin, billedStartTime: r.startTime, billedEndTime: r.endTime, billedMin: r.durationMin, billable: r.billable }
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
  const rec = timerRecording(started, now)
  const id = await addEntry(
    {
      date: toIsoDate(rec.start),
      startTime: toHm(rec.start),
      endTime: toHm(rec.end),
      clientId: opts.clientId,
      projectId: opts.projectId,
      hourlyRate: opts.hourlyRate,
      comments: opts.comments ?? t.comments ?? '',
      category: opts.category ?? t.category,
      isBilled: false,
      source: 'timer',
      normalize: s.roundingMode !== 'exact',
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
  /** Real minutes. */
  durationMin: number
  /** Minutes on the invoice (normalised where available). */
  billedMin: number
  amount: number
  billedAmount: number
  unbilledAmount: number
  unbilledMin: number
}

export function totals(entries: TimeEntry[]): Totals {
  const t: Totals = { count: 0, durationMin: 0, billedMin: 0, amount: 0, billedAmount: 0, unbilledAmount: 0, unbilledMin: 0 }
  for (const e of entries) {
    t.count++
    t.durationMin += e.durationMin
    t.billedMin += billedMinutes(e)
    t.amount += e.amount
    if (e.isBilled) t.billedAmount += e.amount
    else if (isBillable(e)) {
      t.unbilledAmount += e.amount
      t.unbilledMin += billedMinutes(e)
    }
  }
  return t
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateReport {
  entries: number
  projects: number
}

/** Key that identifies the same piece of work regardless of which import or device created it. */
function entryIdentity(e: TimeEntry, projectName: (id?: number) => string): string {
  return (
    e.importKey ??
    [e.date, e.startTime, e.endTime, e.clientId, projectName(e.projectId), e.comments]
      .map((v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
      .join('|')
  )
}

/** Find duplicate entries (same identity) and duplicate projects (same client and name). */
export async function findDuplicates(database: TimeTrackingDB = db): Promise<DuplicateReport> {
  const [entries, projects] = await Promise.all([database.entries.toArray(), database.projects.toArray()])
  const projectName = new Map(projects.map((p) => [p.id!, p.name.toLowerCase()]))
  const seen = new Set<string>()
  let dupEntries = 0
  for (const e of [...entries].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
    const key = entryIdentity(e, (id) => (id == null ? '' : (projectName.get(id) ?? '')))
    if (seen.has(key)) dupEntries++
    else seen.add(key)
  }
  const projectKeys = new Set<string>()
  let dupProjects = 0
  for (const p of [...projects].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
    const key = `${p.clientId}:${p.name.toLowerCase().trim()}`
    if (projectKeys.has(key)) dupProjects++
    else projectKeys.add(key)
  }
  return { entries: dupEntries, projects: dupProjects }
}

/**
 * Remove duplicates, keeping the oldest copy (lowest local id). Entries of a duplicate project
 * are moved to the kept project first. Deletions go through tombstones, so the cloud and the other
 * devices follow on the next sync.
 */
export async function removeDuplicates(database: TimeTrackingDB = db): Promise<DuplicateReport> {
  const removed: DuplicateReport = { entries: 0, projects: 0 }
  await database.transaction('rw', [database.entries, database.projects, database.tombstones], async () => {
    // Projects first so that entry identities use the merged project names.
    const projects = (await database.projects.toArray()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    const keep = new Map<string, Project>()
    for (const p of projects) {
      const key = `${p.clientId}:${p.name.toLowerCase().trim()}`
      const kept = keep.get(key)
      if (!kept) {
        keep.set(key, p)
        continue
      }
      await database.entries.where('projectId').equals(p.id!).modify({ projectId: kept.id })
      await database.projects.delete(p.id!)
      if (p.uid) await database.tombstones.add({ table: 'projects', uid: p.uid })
      removed.projects++
    }
    const projectName = new Map((await database.projects.toArray()).map((p) => [p.id!, p.name.toLowerCase()]))
    const entries = (await database.entries.toArray()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    const seen = new Set<string>()
    for (const e of entries) {
      const key = entryIdentity(e, (id) => (id == null ? '' : (projectName.get(id) ?? '')))
      if (!seen.has(key)) {
        seen.add(key)
        continue
      }
      await database.entries.delete(e.id!)
      if (e.uid) await database.tombstones.add({ table: 'entries', uid: e.uid })
      removed.entries++
    }
  })
  return removed
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
