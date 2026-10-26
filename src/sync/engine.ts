/**
 * Two-way sync between the local Dexie database and the cloud.
 *
 * Pull first: rows whose server synced_at is newer than the stored cursor are applied
 * locally; a row that is also dirty locally keeps whichever side has the newer
 * updated_at (last writer wins). Then push: tombstones are soft-deleted remotely and
 * rows still flagged dirty are upserted (clients → projects → entries). Pulling first
 * guarantees a stale local edit can never overwrite a newer server copy. Local numeric
 * ids never leave the device; relations are carried by the UUID `uid`.
 */
import { db, getSettings, SYNC_TABLES, updateSettings, type TimeTrackingDB } from '../db/schema'
import type { Client, Project, SyncTable, TimeEntry, RatePeriod } from '../db/types'
import type { Remote, RemoteRow } from './remote'

export interface SyncResult {
  pushed: number
  deleted: number
  pulled: number
  at: string
}

const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v))
const num = (v: unknown): number => (v == null ? 0 : Number(v))
const hm = (v: unknown): string => String(v ?? '00:00').slice(0, 5)

// ---------------------------------------------------------------- local → remote

function clientToRemote(c: Client) {
  return {
    id: c.uid!,
    name: c.name,
    default_rate: c.defaultRate,
    rates: c.rates && c.rates.length ? c.rates : null,
    currency: c.currency,
    email: c.email ?? null,
    business_name: c.businessName ?? null,
    registration_number: c.registrationNumber ?? null,
    vat_number: c.vatNumber ?? null,
    vat_applicable: c.vatApplicable ?? null,
    address: c.address ?? null,
    notes: c.notes ?? null,
    archived: Boolean(c.archived),
    updated_at: c.updatedAt ?? new Date().toISOString(),
    deleted_at: null,
  }
}

function projectToRemote(p: Project, clientUid: string) {
  return {
    id: p.uid!,
    client_id: clientUid,
    name: p.name,
    archived: Boolean(p.archived),
    updated_at: p.updatedAt ?? new Date().toISOString(),
    deleted_at: null,
  }
}

function entryToRemote(e: TimeEntry, clientUid: string, projectUid: string | null) {
  return {
    id: e.uid!,
    date: e.date,
    start_time: e.startTime,
    end_time: e.endTime,
    duration_min: e.durationMin,
    client_id: clientUid,
    project_id: projectUid,
    hourly_rate: e.hourlyRate,
    amount: e.amount,
    comments: e.comments ?? '',
    is_billed: e.isBilled,
    invoice_date: e.invoiceDate ?? null,
    invoice_ref: e.invoiceRef ?? null,
    billable: e.billable !== false,
    billed_start_time: e.billedStartTime ?? null,
    billed_end_time: e.billedEndTime ?? null,
    billed_min: e.billedMin ?? null,
    category: e.category ?? null,
    source: e.source,
    import_key: e.importKey ?? null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted_at: null,
  }
}

// ---------------------------------------------------------------- remote → local

function clientFromRemote(r: RemoteRow): Omit<Client, 'id'> {
  return {
    uid: r.id,
    name: String(r.name),
    defaultRate: num(r.default_rate),
    rates: ratePeriods(r.rates),
    currency: String(r.currency ?? 'EUR'),
    email: str(r.email),
    businessName: str(r.business_name),
    registrationNumber: str(r.registration_number),
    vatNumber: str(r.vat_number),
    vatApplicable: r.vat_applicable == null ? undefined : Boolean(r.vat_applicable),
    address: str(r.address),
    notes: str(r.notes),
    archived: Boolean(r.archived),
    updatedAt: r.updated_at,
    dirty: 0,
  }
}

/** Rate periods come back as JSON; keep only well-formed ones, sorted. */
function ratePeriods(v: unknown): RatePeriod[] | undefined {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v
  if (!Array.isArray(raw)) return undefined
  const list = raw
    .filter((p): p is { from: string; rate: unknown } => typeof p === 'object' && p !== null && typeof (p as { from?: unknown }).from === 'string')
    .map((p) => ({ from: p.from, rate: Number(p.rate) || 0 }))
    .sort((a, b) => a.from.localeCompare(b.from))
  return list.length ? list : undefined
}

function projectFromRemote(r: RemoteRow, clientId: number): Omit<Project, 'id'> {
  return {
    uid: r.id,
    clientId,
    name: String(r.name),
    archived: Boolean(r.archived),
    updatedAt: r.updated_at,
    dirty: 0,
  }
}

function entryFromRemote(r: RemoteRow, clientId: number, projectId: number | undefined): Omit<TimeEntry, 'id'> {
  return {
    uid: r.id,
    date: String(r.date),
    startTime: hm(r.start_time),
    endTime: hm(r.end_time),
    durationMin: num(r.duration_min),
    clientId,
    projectId,
    hourlyRate: num(r.hourly_rate),
    amount: num(r.amount),
    comments: String(r.comments ?? ''),
    isBilled: Boolean(r.is_billed),
    invoiceDate: str(r.invoice_date),
    invoiceRef: str(r.invoice_ref),
    billable: r.billable === false ? false : undefined,
    billedStartTime: r.billed_start_time == null ? undefined : hm(r.billed_start_time),
    billedEndTime: r.billed_end_time == null ? undefined : hm(r.billed_end_time),
    billedMin: r.billed_min == null ? undefined : num(r.billed_min),
    category: str(r.category),
    source: (str(r.source) as TimeEntry['source']) ?? 'manual',
    importKey: str(r.import_key),
    createdAt: String(r.created_at ?? r.updated_at),
    updatedAt: r.updated_at,
    dirty: 0,
  }
}

// ---------------------------------------------------------------- engine

export class SyncEngine {
  private readonly remote: Remote
  private readonly database: TimeTrackingDB

  constructor(remote: Remote, database: TimeTrackingDB = db) {
    this.remote = remote
    this.database = database
  }

  async run(): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, deleted: 0, pulled: 0, at: new Date().toISOString() }
    result.pulled = await this.pull()
    result.deleted = await this.pushDeletes()
    result.pushed = await this.pushChanges()
    const settings = await getSettings(this.database)
    await updateSettings({ sync: { ...settings.sync, cursors: settings.sync?.cursors ?? {}, lastSyncAt: result.at, lastError: undefined } }, this.database)
    return result
  }

  async pendingCount(): Promise<number> {
    const d = this.database
    const [a, b, c, t] = await Promise.all([
      d.clients.where('dirty').equals(1).count(),
      d.projects.where('dirty').equals(1).count(),
      d.entries.where('dirty').equals(1).count(),
      d.tombstones.count(),
    ])
    return a + b + c + t
  }

  private async pushDeletes(): Promise<number> {
    const tombstones = await this.database.tombstones.toArray()
    if (!tombstones.length) return 0
    // Children first so the server never sees a dangling reference window.
    for (const table of ['entries', 'projects', 'clients'] as SyncTable[]) {
      const ids = tombstones.filter((t) => t.table === table).map((t) => t.uid)
      if (ids.length) await this.remote.markDeleted(table, ids)
    }
    await this.database.tombstones.bulkDelete(tombstones.map((t) => t.id!))
    return tombstones.length
  }

  private async pushChanges(): Promise<number> {
    const d = this.database
    let pushed = 0
    const clients = await d.clients.where('dirty').equals(1).toArray()
    if (clients.length) {
      await this.remote.upsert('clients', clients.map(clientToRemote))
      await this.clearDirty('clients', clients.map((c) => c.id!))
      pushed += clients.length
    }
    const clientUid = new Map((await d.clients.toArray()).map((c) => [c.id!, c.uid!]))

    const projects = (await d.projects.where('dirty').equals(1).toArray()).filter((p) => clientUid.has(p.clientId))
    if (projects.length) {
      await this.remote.upsert('projects', projects.map((p) => projectToRemote(p, clientUid.get(p.clientId)!)))
      await this.clearDirty('projects', projects.map((p) => p.id!))
      pushed += projects.length
    }
    const projectUid = new Map((await d.projects.toArray()).map((p) => [p.id!, p.uid!]))

    const entries = (await d.entries.where('dirty').equals(1).toArray()).filter((e) => clientUid.has(e.clientId))
    if (entries.length) {
      await this.remote.upsert(
        'entries',
        entries.map((e) => entryToRemote(e, clientUid.get(e.clientId)!, e.projectId != null ? (projectUid.get(e.projectId) ?? null) : null)),
      )
      await this.clearDirty('entries', entries.map((e) => e.id!))
      pushed += entries.length
    }
    return pushed
  }

  private async clearDirty(table: SyncTable, ids: number[]): Promise<void> {
    await this.database.remoteTransaction(async () => {
      for (const id of ids) await this.database.table(table).update(id, { dirty: 0 })
    })
  }

  private async pull(): Promise<number> {
    let applied = 0
    for (const table of SYNC_TABLES) {
      const cursor = (await getSettings(this.database)).sync?.cursors?.[table]
      const rows = await this.remote.pullSince(table, cursor)
      if (!rows.length) continue
      applied += await this.apply(table, rows)
      const settings = await getSettings(this.database)
      const newest = rows.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), cursor ?? '')
      await updateSettings({ sync: { ...settings.sync, cursors: { ...settings.sync?.cursors, [table]: newest } } }, this.database)
    }
    return applied
  }

  /** Apply pulled rows inside one transaction that bypasses the dirty-tracking hooks. */
  private apply(table: SyncTable, rows: RemoteRow[]): Promise<number> {
    const d = this.database
    return d.remoteTransaction(async () => {
      let n = 0
      const clientIdByUid = new Map((await d.clients.toArray()).map((c) => [c.uid!, c.id!]))
      const projectIdByUid = new Map((await d.projects.toArray()).map((p) => [p.uid!, p.id!]))
      // Rows deleted locally but not yet pushed must not be resurrected by the pull.
      const deletedLocally = new Set((await d.tombstones.where('table').equals(table).toArray()).map((t) => t.uid))
      for (const row of rows) {
        if (deletedLocally.has(row.id)) continue
        const existing = (await d.table(table).where('uid').equals(row.id).first()) as (Client | Project | TimeEntry) | undefined
        if (row.deleted_at) {
          if (existing) {
            await d.table(table).delete(existing.id!)
            n++
          }
          continue
        }
        // Local unsynced edit that is newer than the server copy wins; it will be pushed next time.
        if (existing?.dirty === 1 && (existing.updatedAt ?? '') > row.updated_at) continue

        let mapped: Omit<Client, 'id'> | Omit<Project, 'id'> | Omit<TimeEntry, 'id'>
        if (table === 'clients') {
          mapped = clientFromRemote(row)
        } else if (table === 'projects') {
          const clientId = clientIdByUid.get(String(row.client_id))
          if (clientId == null) continue
          mapped = projectFromRemote(row, clientId)
        } else {
          const clientId = clientIdByUid.get(String(row.client_id))
          if (clientId == null) continue
          const projectId = row.project_id ? projectIdByUid.get(String(row.project_id)) : undefined
          mapped = entryFromRemote(row, clientId, projectId)
        }

        if (existing) {
          await d.table(table).put({ ...mapped, id: existing.id })
        } else if (table === 'clients' && 'name' in mapped) {
          // Same client created on two devices before syncing: merge by name instead of failing on the unique index.
          const sameName = await d.clients.where('name').equalsIgnoreCase(mapped.name).first()
          if (sameName) {
            await d.clients.put({ ...sameName, ...mapped, id: sameName.id })
            clientIdByUid.set(row.id, sameName.id!)
          } else {
            const id = (await d.clients.add(mapped as Client)) as number
            clientIdByUid.set(row.id, id)
          }
        } else {
          const id = (await d.table(table).add(mapped)) as number
          if (table === 'projects') projectIdByUid.set(row.id, id)
        }
        n++
      }
      return n
    })
  }
}
