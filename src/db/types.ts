/**
 * Core data model for the time tracking app.
 *
 * Dates are stored as ISO strings ("YYYY-MM-DD") and times as "HH:mm" so that
 * they are human readable, sortable, and timezone-agnostic (a work session is
 * always expressed in the local wall-clock time it was entered in).
 */

/** Fields shared by every synced record. */
export interface Synced {
  /** Stable identifier shared with the cloud database (UUID). */
  uid?: string
  /** 1 when the record has local changes not yet pushed to the cloud. */
  dirty?: 0 | 1
  updatedAt?: string
}

export interface Client extends Synced {
  id?: number
  name: string
  /** Default hourly rate applied to new entries for this client. */
  defaultRate: number
  currency: string
  email?: string
  /** Free text: address, VAT number, invoicing notes, etc. */
  notes?: string
  archived?: boolean
}

export interface Project extends Synced {
  id?: number
  clientId: number
  name: string
  /** Overrides the client default rate when set. */
  defaultRate?: number
  archived?: boolean
}

export type EntrySource = 'manual' | 'timer' | 'import'

export interface TimeEntry extends Synced {
  id?: number
  /** "YYYY-MM-DD" – the calendar day the work started on. */
  date: string
  /** "HH:mm" */
  startTime: string
  /** "HH:mm". When endTime <= startTime the entry is treated as ending the next day. */
  endTime: string
  /** Derived from start/end, cached for fast reporting. */
  durationMin: number
  clientId: number
  projectId?: number
  hourlyRate: number
  /** Derived: durationMin / 60 * hourlyRate, cached for fast reporting. */
  amount: number
  comments: string
  isBilled: boolean
  /** "YYYY-MM-DD" of the invoice this entry was billed on. */
  invoiceDate?: string
  /** Free text identifying the invoice, e.g. an invoice number or "Aprīlis 2024". */
  invoiceRef?: string
  /** False for work that will never be invoiced (internal, goodwill). Undefined means billable. */
  billable?: boolean
  /** Optional free classification, e.g. "Support" / "Development". */
  category?: string
  source: EntrySource
  /** Stable key used to avoid importing the same spreadsheet row twice. */
  importKey?: string
  createdAt: string
  updatedAt: string
}

export type SyncTable = 'clients' | 'projects' | 'entries'

/** A record deleted locally whose deletion still has to be pushed to the cloud. */
export interface Tombstone {
  id?: number
  table: SyncTable
  uid: string
}

export interface SyncState {
  /** Per table: the highest server `synced_at` already pulled. */
  cursors: Partial<Record<SyncTable, string>>
  lastSyncAt?: string
  lastError?: string
}

export interface RunningTimer {
  startedAt: string // ISO datetime
  clientId?: number
  projectId?: number
  comments: string
  category?: string
}

export interface Settings {
  /** Fixed key so the table only ever has one row. */
  id: 'app'
  runningTimer?: RunningTimer
  defaultCurrency: string
  /** Last used client, pre-selected in forms and the timer. */
  lastClientId?: number
  lastProjectId?: number
  /** Timer rounding in minutes (0 = exact). */
  timerRoundingMin: number
  sync?: SyncState
}
