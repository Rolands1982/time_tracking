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

/** Replace all local data with the backup (ids are preserved so references stay intact). */
export async function restoreBackup(backup: Backup, database: TimeTrackingDB = db): Promise<void> {
  if (!isBackup(backup)) throw new Error('Not a time-tracking backup file')
  await database.transaction('rw', database.clients, database.projects, database.entries, database.settings, async () => {
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear()])
    await database.clients.bulkAdd(backup.clients)
    await database.projects.bulkAdd(backup.projects ?? [])
    await database.entries.bulkAdd(backup.entries)
    if (backup.settings) await database.settings.put({ ...backup.settings, id: 'app', runningTimer: undefined })
  })
}

export async function clearAllData(database: TimeTrackingDB = db): Promise<void> {
  await database.transaction('rw', database.clients, database.projects, database.entries, database.settings, async () => {
    await Promise.all([database.clients.clear(), database.projects.clear(), database.entries.clear(), database.settings.clear()])
  })
}
