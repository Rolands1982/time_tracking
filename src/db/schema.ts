import Dexie, { type EntityTable } from 'dexie'
import type { Client, Project, Settings, TimeEntry } from './types'

/**
 * Local database (IndexedDB) – the app works fully offline.
 * A later version can sync this to a backend; the schema is kept flat so that
 * every table maps 1:1 onto a SQL table.
 */
export class TimeTrackingDB extends Dexie {
  entries!: EntityTable<TimeEntry, 'id'>
  clients!: EntityTable<Client, 'id'>
  projects!: EntityTable<Project, 'id'>
  settings!: EntityTable<Settings, 'id'>

  constructor(name = 'time-tracking') {
    super(name)
    this.version(1).stores({
      entries: '++id, date, clientId, projectId, isBilled, invoiceDate, importKey, [clientId+isBilled]',
      clients: '++id, &name',
      projects: '++id, clientId, [clientId+name]',
      settings: 'id',
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
