import { db, type TimeTrackingDB } from '../db/schema'
import type { Client, Project, Settings, TimeEntry } from '../db/types'

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
 * Replace all local data with the backup (ids are preserved so references stay intact).
 * Restored rows are marked as local changes, so they are pushed to the cloud on the next sync;
 * the sync cursors are reset so the cloud copy is pulled again afterwards.
 */
export async function restoreBackup(backup: Backup, database: TimeTrackingDB = db): Promise<void> {
  if (!isBackup(backup)) throw new Error('Not a time-tracking backup file')
  await database.transaction('rw', [database.clients, database.projects, database.entries, database.settings, database.tombstones], async () => {
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear(), database.tombstones.clear()])
    const fresh = <T extends { dirty?: 0 | 1 }>(rows: T[]) => rows.map((r) => ({ ...r, dirty: 1 as const }))
    await database.clients.bulkAdd(fresh(backup.clients))
    await database.projects.bulkAdd(fresh(backup.projects ?? []))
    await database.entries.bulkAdd(fresh(backup.entries))
    if (backup.settings) {
      await database.settings.put({ ...backup.settings, id: 'app', runningTimer: undefined, sync: undefined })
    }
  })
}

/** Wipe the local copy only; the cloud data (if any) is left untouched. */
export async function clearAllData(database: TimeTrackingDB = db): Promise<void> {
  await database.transaction('rw', [database.clients, database.projects, database.entries, database.settings, database.tombstones], async () => {
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear(), database.tombstones.clear()])
  })
}
