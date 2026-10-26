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

/** An hourly rate valid from a date on (until the next period starts). */
export interface RatePeriod {
  /** YYYY-MM-DD */
  from: string
  rate: number
}

export interface Client extends Synced {
  id?: number
  /** Short name used in the app. */
  name: string
  /** Hourly rate for dates before the first rate period (and for clients without periods). */
  defaultRate: number
  /** Rate changes over time, sorted by `from`. Use rateFor() to resolve a date. */
  rates?: RatePeriod[]
  currency: string
  email?: string
  /** Invoice data. */
  businessName?: string
  registrationNumber?: string
  vatNumber?: string
  vatApplicable?: boolean
  address?: string
  /** Free text: invoicing notes, contacts, etc. */
  notes?: string
  archived?: boolean
}

export interface Project extends Synced {
  id?: number
  clientId: number
  name: string
  /** Legacy: rates are per client and period now; kept so old backups still load. */
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
  /**
   * Normalised values for billing (see src/lib/rounding.ts). Absent on records that predate the
   * billing rules or were saved with normalisation switched off; then the real minutes are billed.
   */
  billedStartTime?: string
  billedEndTime?: string
  billedMin?: number
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
  /** 'billing' (default): 10-minute start marks and 15-minute steps for new records; 'exact': minutes as typed. */
  roundingMode?: 'billing' | 'exact'
  /** Columns shown in customer summaries (keys from src/lib/statement.ts); unset = default set. */
  summaryColumns?: string[]
  /** E-mail preferences for documents sent from the app. */
  mail?: { signature?: string; copyToSender?: boolean }
  /** Legacy setting from before the billing rules; ignored. */
  timerRoundingMin?: number
  sync?: SyncState
}
