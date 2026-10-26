import type { ReactNode } from 'react'
import { SyncContext } from './syncContext'
import { useSyncController } from './useSync'

/** Mount once at the app root: keeps cloud sync running on every screen. */
export default function SyncProvider({ children }: { children: ReactNode }) {
  const api = useSyncController()
  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>
}
