import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings, updateSettings } from '../db/schema'
import { useSettings } from '../db/hooks'
import { SyncEngine, type SyncResult } from './engine'
import { getSupabase, getSyncConfig, isBuiltInConfig, resetSupabaseClient, saveSyncConfig, SupabaseRemote, type SyncConfig } from './remote'
import { SyncContext } from './syncContext'

export interface SyncUser {
  email: string
}

export interface SyncStatus {
  configured: boolean
  builtIn: boolean
  config: SyncConfig | null
  user: SyncUser | null
  ready: boolean
  syncing: boolean
  pending: number
  online: boolean
  lastSyncAt?: string
  lastError?: string
}

let inFlight: Promise<SyncResult | null> | null = null

/** Run one sync cycle if the app is configured and signed in; concurrent calls share one run. */
export async function syncNow(): Promise<SyncResult | null> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const supabase = await getSupabase()
    if (!supabase) return null
    const { data } = await supabase.auth.getSession()
    if (!data.session) return null
    try {
      const engine = new SyncEngine(new SupabaseRemote(supabase), db)
      return await engine.run()
    } catch (err) {
      const settings = await getSettings()
      await updateSettings({ sync: { ...settings.sync, cursors: settings.sync?.cursors ?? {}, lastError: (err as Error).message } })
      throw err
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function pendingCount(): Promise<number> {
  const [a, b, c, t] = await Promise.all([
    db.clients.where('dirty').equals(1).count(),
    db.projects.where('dirty').equals(1).count(),
    db.entries.where('dirty').equals(1).count(),
    db.tombstones.count(),
  ])
  return a + b + c + t
}

const AUTO_SYNC_DEBOUNCE_MS = 4000
const PERIODIC_SYNC_MS = 5 * 60_000
/** Do not hammer the server when the user flips between apps quickly. */
const FOREGROUND_SYNC_MIN_GAP_MS = 15_000

/**
 * The single sync controller. Mounted once by <SyncProvider> at the app root so automatic sync
 * (after sign-in, after local changes, when back online, when the app comes to the foreground,
 * and periodically) runs on every screen, not only while the Data screen is open.
 */
export function useSyncController() {
  const settings = useSettings()
  const [config, setConfig] = useState<SyncConfig | null>(() => getSyncConfig())
  const [user, setUser] = useState<SyncUser | null>(null)
  const [ready, setReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const pending = useLiveQuery(pendingCount, [], 0)
  const syncedForUser = useRef<string | null>(null)

  // Track the auth session.
  useEffect(() => {
    let unsubscribe = () => {}
    let cancelled = false
    ;(async () => {
      const supabase = await getSupabase()
      if (!supabase || cancelled) {
        setReady(true)
        return
      }
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      setUser(data.session?.user.email ? { email: data.session.user.email } : null)
      setReady(true)
      const sub = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user.email ? { email: session.user.email } : null)
      })
      unsubscribe = () => sub.data.subscription.unsubscribe()
    })()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [config])

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  const run = useCallback(async () => {
    setSyncing(true)
    try {
      return await syncNow()
    } finally {
      setSyncing(false)
    }
  }, [])

  // Auto sync: once right after sign-in (or app start), and whenever local changes appear (debounced).
  useEffect(() => {
    if (!user || !online) return
    const first = syncedForUser.current !== user.email
    if (!first && pending === 0) return
    const t = setTimeout(() => {
      syncedForUser.current = user.email
      void run().catch(() => {})
    }, first ? 500 : AUTO_SYNC_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [user, online, pending, run])

  // Periodic pull so that changes made on other devices show up while the app stays open.
  useEffect(() => {
    if (!user || !online) return
    const interval = setInterval(() => void run().catch(() => {}), PERIODIC_SYNC_MS)
    return () => clearInterval(interval)
  }, [user, online, run])

  // Pull when the app returns to the foreground (phone unlocked, tab switched back).
  useEffect(() => {
    if (!user || !online) return
    let last = Date.now()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - last < FOREGROUND_SYNC_MIN_GAP_MS) return
      last = Date.now()
      void run().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [user, online, run])

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = await getSupabase()
    if (!supabase) throw new Error('Cloud sync is not configured')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message)
  }, [])

  const signUp = useCallback(async (email: string, password: string) => {
    const supabase = await getSupabase()
    if (!supabase) throw new Error('Cloud sync is not configured')
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw new Error(error.message)
    return Boolean(data.session) // false when e-mail confirmation is required first
  }, [])

  const signOut = useCallback(async () => {
    const supabase = await getSupabase()
    await supabase?.auth.signOut()
    setUser(null)
  }, [])

  const configure = useCallback((next: SyncConfig | null) => {
    saveSyncConfig(next)
    resetSupabaseClient()
    setUser(null)
    setConfig(getSyncConfig())
  }, [])

  const status: SyncStatus = {
    configured: config != null,
    builtIn: isBuiltInConfig(),
    config,
    user,
    ready,
    syncing,
    pending,
    online,
    lastSyncAt: settings.sync?.lastSyncAt,
    lastError: settings.sync?.lastError,
  }
  return { ...status, syncNow: run, signIn, signUp, signOut, configure }
}

export type SyncApi = ReturnType<typeof useSyncController>

/** Read the app-wide sync state and actions provided by <SyncProvider>. */
export function useSync(): SyncApi {
  const api = useContext(SyncContext)
  if (!api) throw new Error('useSync must be used inside <SyncProvider>')
  return api
}
