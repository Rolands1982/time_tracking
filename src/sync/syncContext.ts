import { createContext } from 'react'
import type { SyncApi } from './useSync'

export const SyncContext = createContext<SyncApi | null>(null)
