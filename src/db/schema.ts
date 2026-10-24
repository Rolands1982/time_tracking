import Dexie, { type EntityTable, type Transaction } from 'dexie'
import type { Client, Project, Settings, SyncTable, TimeEntry, Tombstone } from './types'

export const SYNC_TABLES: readonly SyncTable[] = ['clients', 'projects', 'entries']

export function newUid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // Fallback for very old browsers: RFC 4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Transactions started by the sync engine: their writes must not be marked as local changes. */
const REMOTE_TRANSACTIONS = new WeakSet<Transaction>()

/**
 * Local database (IndexedDB) – the app works fully offline.
 * Every synced record carries a stable `uid` and a `dirty` flag; hooks keep both
 * up to date so the sync engine can find what changed without diffing.
 */
export class TimeTrackingDB extends Dexie {
  entries!: EntityTable<TimeEntry, 'id'>
  clients!: EntityTable<Client, 'id'>
  projects!: EntityTable<Project, 'id'>
  settings!: EntityTable<Settings, 'id'>
  tombstones!: EntityTable<Tombstone, 'id'>

  constructor(name = 'time-tracking') {
    super(name)
    this.version(1).stores({
      entries: '++id, date, clientId, projectId, isBilled, invoiceDate, importKey, [clientId+isBilled]',
      clients: '++id, &name',
      projects: '++id, clientId, [clientId+name]',
      settings: 'id',
    })
    this.version(2)
      .stores({
        entries: '++id, &uid, dirty, date, clientId, projectId, isBilled, invoiceDate, importKey, [clientId+isBilled]',
        clients: '++id, &uid, dirty, &name',
        projects: '++id, &uid, dirty, clientId, [clientId+name]',
        settings: 'id',
        tombstones: '++id, table, uid',
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString()
        for (const table of SYNC_TABLES) {
          await tx
            .table(table)
            .toCollection()
            .modify((r: Client | Project | TimeEntry) => {
              r.uid ??= newUid()
              r.dirty = 1
              r.updatedAt ??= (r as TimeEntry).createdAt ?? now
            })
        }
      })

    for (const table of SYNC_TABLES) {
      const t = this.table(table)
      t.hook('creating', function (_key, obj: Client | Project | TimeEntry, tx) {
        if (!obj.uid) obj.uid = newUid()
        if (REMOTE_TRANSACTIONS.has(tx)) {
          obj.dirty ??= 0
        } else {
          obj.dirty = 1
          obj.updatedAt ??= new Date().toISOString()
        }
      })
      t.hook('updating', function (mods: Partial<Client | Project | TimeEntry>, _key, _obj, tx) {
        if (REMOTE_TRANSACTIONS.has(tx)) return undefined
        return { dirty: 1, updatedAt: mods.updatedAt ?? new Date().toISOString() }
      })
    }
  }

  /** Run `fn` in a read-write transaction whose writes are not marked as local changes. */
  async remoteTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.transaction('rw', [this.entries, this.clients, this.projects, this.settings, this.tombstones], async (tx) => {
      REMOTE_TRANSACTIONS.add(tx)
      return fn(tx)
    })
  }

  /** Delete a synced record and remember the deletion for the next push. */
  async deleteSynced(table: SyncTable, id: number): Promise<void> {
    await this.transaction('rw', [this.table(table), this.tombstones], async () => {
      const row = (await this.table(table).get(id)) as Client | Project | TimeEntry | undefined
      if (!row) return
      await this.table(table).delete(id)
      if (row.uid) await this.tombstones.add({ table, uid: row.uid })
    })
  }
}

export const db = new TimeTrackingDB()

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  defaultCurrency: 'EUR',
  timerRoundingMin: 0,
}

export async function getSettings(database: TimeTrackingDB = db): Promise<Settings> {
  const s = await database.settings.get('app')
  return s ?? DEFAULT_SETTINGS
}

export async function updateSettings(
  patch: Partial<Settings>,
  database: TimeTrackingDB = db,
): Promise<Settings> {
  const current = await getSettings(database)
  const next = { ...current, ...patch, id: 'app' as const }
  await database.settings.put(next)
  return next
}
