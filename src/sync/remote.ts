/**
 * The cloud side of sync, kept behind a tiny interface so the engine can be tested
 * against an in-memory implementation and so another backend could replace Supabase.
 */
import type { SyncTable } from '../db/types'

export type RemoteRow = Record<string, unknown> & {
  id: string
  updated_at: string
  synced_at: string
  deleted_at: string | null
}

export interface Remote {
  /** Insert or replace rows by id. */
  upsert(table: SyncTable, rows: Record<string, unknown>[]): Promise<void>
  /** Soft-delete rows by id. */
  markDeleted(table: SyncTable, ids: string[]): Promise<void>
  /** Rows changed on the server after `cursor` (a synced_at value), oldest first. */
  pullSince(table: SyncTable, cursor: string | undefined): Promise<RemoteRow[]>
}

// ---------------------------------------------------------------- configuration

export interface SyncConfig {
  url: string
  anonKey: string
}

const CONFIG_KEY = 'time-tracking.supabase'

/** Build-time configuration (GitHub variables) can be overridden by values typed into the app. */
export function getSyncConfig(): SyncConfig | null {
  try {
    const stored = localStorage.getItem(CONFIG_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SyncConfig>
      if (parsed.url && parsed.anonKey) return { url: parsed.url, anonKey: parsed.anonKey }
    }
  } catch {
    /* ignore */
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return url && anonKey ? { url, anonKey } : null
}

export function saveSyncConfig(config: SyncConfig | null): void {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
    else localStorage.removeItem(CONFIG_KEY)
  } catch {
    /* ignore */
  }
}

export function isBuiltInConfig(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)
}

// ---------------------------------------------------------------- Supabase implementation

type SupabaseClient = import('@supabase/supabase-js').SupabaseClient

let clientPromise: Promise<SupabaseClient> | null = null
let clientConfig: string | null = null

/** Lazily create (and cache) the Supabase client; the library is loaded on demand. */
export async function getSupabase(): Promise<SupabaseClient | null> {
  const config = getSyncConfig()
  if (!config) return null
  const key = `${config.url}|${config.anonKey}`
  if (!clientPromise || clientConfig !== key) {
    clientConfig = key
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true } }),
    )
  }
  return clientPromise
}

export function resetSupabaseClient(): void {
  clientPromise = null
  clientConfig = null
}

const PAGE = 1000

/** Cloud table name for a local sync table. */
export function remoteTable(table: SyncTable): string {
  return table === 'upworkTransactions' ? 'upwork_transactions' : table === 'otherIncome' ? 'other_income' : table
}
/** UUIDs per delete request: 100 ids are about 4 KB of URL. */
const DELETE_BATCH = 100

export class SupabaseRemote implements Remote {
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async upsert(table: SyncTable, rows: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.client.from(remoteTable(table)).upsert(rows.slice(i, i + 500), { onConflict: 'id' })
      if (error) throw new Error(`${table}: ${error.message}`)
    }
  }

  async markDeleted(table: SyncTable, ids: string[]): Promise<void> {
    const now = new Date().toISOString()
    // The ids travel in the URL (`id=in.(…)`), so a restore that tombstones thousands of rows
    // must be split into requests that stay well under the URL length limit.
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const { error } = await this.client.from(remoteTable(table)).update({ deleted_at: now, updated_at: now }).in('id', ids.slice(i, i + DELETE_BATCH))
      if (error) throw new Error(`${table}: ${error.message}`)
    }
  }

  /**
   * Rows changed after `cursor`, oldest first. Every row written by one request shares one synced_at
   * (the trigger stamps the statement time), so a page may end inside such a group; the rest of that
   * group is fetched explicitly before the cursor moves past it, otherwise those rows would never
   * reach the device.
   */
  async pullSince(table: SyncTable, cursor: string | undefined): Promise<RemoteRow[]> {
    const byId = new Map<string, RemoteRow>()
    const name = remoteTable(table)
    let from = cursor
    for (;;) {
      let q = this.client.from(name).select('*').order('synced_at', { ascending: true }).order('id').limit(PAGE)
      if (from) q = q.gt('synced_at', from)
      const { data, error } = await q
      if (error) throw new Error(`${table}: ${error.message}`)
      const rows = (data ?? []) as RemoteRow[]
      for (const r of rows) byId.set(r.id, r)
      if (rows.length < PAGE) break
      const last = rows[rows.length - 1].synced_at
      let afterId = rows[rows.length - 1].id
      for (;;) {
        const { data: tail, error: tailError } = await this.client.from(name).select('*').eq('synced_at', last).order('id').gt('id', afterId).limit(PAGE)
        if (tailError) throw new Error(`${table}: ${tailError.message}`)
        const more = (tail ?? []) as RemoteRow[]
        for (const r of more) byId.set(r.id, r)
        if (more.length < PAGE) break
        afterId = more[more.length - 1].id
      }
      from = last
    }
    return [...byId.values()].sort((a, b) => a.synced_at.localeCompare(b.synced_at) || a.id.localeCompare(b.id))
  }
}
