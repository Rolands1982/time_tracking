import { db, SYNC_TABLES, type TimeTrackingDB } from '../db/schema'
import type { Client, Project, Settings, SyncTable, TimeEntry, Tombstone } from '../db/types'

export interface Backup {
  app: 'time-tracking'
  version: 1
  exportedAt: string
  clients: Client[]
  projects: Project[]
  entries: TimeEntry[]
  settings?: Settings
}

export async function createBackup(database: TimeTrackingDB = db): Promise<Backup> {
  const [clients, projects, entries, settings] = await Promise.all([
    database.clients.toArray(),
    database.projects.toArray(),
    database.entries.toArray(),
    database.settings.get('app'),
  ])
  return { app: 'time-tracking', version: 1, exportedAt: new Date().toISOString(), clients, projects, entries, settings }
}

export function isBackup(x: unknown): x is Backup {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as Backup).app === 'time-tracking' &&
    Array.isArray((x as Backup).entries) &&
    Array.isArray((x as Backup).clients)
  )
}

/**
 * Remember every synced row that is about to be wiped, so the next sync removes it from the
 * cloud as well. Without this a restore would leave the old copy in the cloud, and it would come
 * back next to the restored data as a duplicate.
 */
async function tombstoneEverything(database: TimeTrackingDB): Promise<void> {
  const tombstones: Tombstone[] = []
  for (const table of SYNC_TABLES as readonly SyncTable[]) {
    const rows = (await database.table(table).toArray()) as { uid?: string }[]
    for (const r of rows) if (r.uid) tombstones.push({ table, uid: r.uid })
  }
  if (tombstones.length) await database.tombstones.bulkAdd(tombstones)
}

/**
 * Replace all data with the backup (ids are preserved so references stay intact). The previous
 * rows are tombstoned and the restored rows marked as local changes, so the next sync replaces
 * the cloud copy too instead of merging the two. The sync cursors are reset.
 */
export async function restoreBackup(backup: Backup, database: TimeTrackingDB = db): Promise<void> {
  if (!isBackup(backup)) throw new Error('Not a time-tracking backup file')
  await database.transaction('rw', [database.clients, database.projects, database.entries, database.settings, database.tombstones], async () => {
    await tombstoneEverything(database)
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear()])
    // Rows of this very backup may already live in the cloud under their uid: never tombstone those.
    const restoredUids = new Set([...backup.clients, ...(backup.projects ?? []), ...backup.entries].map((r) => r.uid).filter(Boolean))
    if (restoredUids.size) {
      const stale = (await database.tombstones.toArray()).filter((t) => restoredUids.has(t.uid))
      if (stale.length) await database.tombstones.bulkDelete(stale.map((t) => t.id!))
    }
    const fresh = <T extends { dirty?: 0 | 1 }>(rows: T[]) => rows.map((r) => ({ ...r, dirty: 1 as const }))
    await database.clients.bulkAdd(fresh(backup.clients))
    await database.projects.bulkAdd(fresh(backup.projects ?? []))
    await database.entries.bulkAdd(fresh(backup.entries))
    if (backup.settings) {
      await database.settings.put({ ...backup.settings, id: 'app', runningTimer: undefined, sync: undefined })
    }
  })
}

/** Wipe all data; with cloud sync on, the next sync removes it from the cloud as well. */
export async function clearAllData(database: TimeTrackingDB = db): Promise<void> {
  await database.transaction('rw', [database.clients, database.projects, database.entries, database.settings, database.tombstones], async () => {
    await tombstoneEverything(database)
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear()])
  })
}
