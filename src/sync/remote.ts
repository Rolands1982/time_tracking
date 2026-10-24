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

export class SupabaseRemote implements Remote {
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async upsert(table: SyncTable, rows: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.client.from(table).upsert(rows.slice(i, i + 500), { onConflict: 'id' })
      if (error) throw new Error(`${table}: ${error.message}`)
    }
  }

  async markDeleted(table: SyncTable, ids: string[]): Promise<void> {
    if (!ids.length) return
    const now = new Date().toISOString()
    const { error } = await this.client.from(table).update({ deleted_at: now, updated_at: now }).in('id', ids)
    if (error) throw new Error(`${table}: ${error.message}`)
  }

  async pullSince(table: SyncTable, cursor: string | undefined): Promise<RemoteRow[]> {
    const all: RemoteRow[] = []
    let from = cursor
    for (;;) {
      let q = this.client.from(table).select('*').order('synced_at', { ascending: true }).order('id').limit(PAGE)
      if (from) q = q.gt('synced_at', from)
      const { data, error } = await q
      if (error) throw new Error(`${table}: ${error.message}`)
      const rows = (data ?? []) as RemoteRow[]
      all.push(...rows)
      if (rows.length < PAGE) break
      from = rows[rows.length - 1].synced_at
    }
    return all
  }
}
