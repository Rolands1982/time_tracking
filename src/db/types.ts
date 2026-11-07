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
  /** Set when the client came from a platform; its hours and money are imported, not typed. */
  platform?: 'upwork'
  /** Upwork client organisation id, the join key for imports. */
  upworkClientId?: string
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
  /** Optional rate of this project; when set it overrides the client's rate for new entries (see suggestedRate()). */
  defaultRate?: number
  archived?: boolean
  /** Set when the project is an Upwork contract. */
  upwork?: { contractId: string; type: 'hourly' | 'fixed' }
}

export type EntrySource = 'manual' | 'timer' | 'import' | 'upwork'

/** Whether fee and exchange rate of an entry come from real platform rows or are still estimates. */
export type Settlement = 'actual' | 'estimated'

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
  /**
   * Money columns (see docs/plans/upwork-integration.md). `amount` is the gross in `currency`;
   * the rest let every report sum in EUR. Direct clients: fee 0, net = gross, rate 1.
   */
  currency?: string
  feeAmount?: number
  netAmount?: number
  fxRate?: number
  netAmountEur?: number
  settlement?: Settlement
  /** The platform payout (UpworkTransaction.txId) that paid this entry. */
  payoutId?: string
  /** Platform row identity for idempotent imports, e.g. "upwork:<contractId>:<date>:<memoId>". */
  externalId?: string
  /** True when the platform reports a duration only; startTime/endTime are then a convention. */
  timeless?: boolean
  /** Fixed-price work whose hours were estimated by the user. */
  estimatedHours?: boolean
  createdAt: string
  updatedAt: string
}

export type UpworkTxType = 'hourly' | 'fixed' | 'bonus' | 'fee' | 'vat' | 'withdrawal' | 'withdrawalFee' | 'refund' | 'membership' | 'other'

/** One row of the Upwork transaction history, stored raw; everything else is derived from these. */
export interface UpworkTransaction extends Synced {
  id?: number
  /** Upwork recordId. */
  txId: string
  /** YYYY-MM-DD */
  date: string
  type: UpworkTxType
  /** Upwork accountingSubtype as delivered. */
  subtype: string
  description: string
  /** Signed amount in `currency` (USD): earnings positive, fees and withdrawals negative/positive as Upwork reports them. */
  amount: number
  currency: string
  clientName?: string
  /** Contract id when it can be read from the row (hourly invoices carry it; fees carry the term id). */
  contractId?: string
  termId?: string
  /** Parsed from hourly invoice descriptions. */
  periodFrom?: string
  periodTo?: string
  hours?: number
  rate?: number
  /** Parsed from fee descriptions: fee = feeBase × feePercent / 100. */
  feeBase?: number
  feePercent?: number
  /** Withdrawals: what the bank received, typed in or imported from the bank statement. */
  eurAmount?: number
  eurDate?: string
  /** Upwork marked the row REVERSED (it and its reversal cancel out); allocation skips these. */
  reversed?: boolean
}

export type IncomeCategory = 'rent' | 'investment' | 'sale' | 'benefit' | 'other'

/**
 * Income that is not billed work: rent, investment returns, sales of goods, social benefits and the rest. Kept
 * next to the time entries so one screen shows the whole income of a week or a month. Amounts are in EUR.
 */
export interface OtherIncome extends Synced {
  id?: number
  /** "YYYY-MM-DD": the day the income is recorded as of (the end of the week by convention). */
  date: string
  category: IncomeCategory
  amount: number
  currency: string
  /** Where it came from: "Mintos", the tenant, the buyer… */
  source?: string
  notes: string
  /** Stable key of the spreadsheet cell the row came from, so an import can be repeated safely. */
  importKey?: string
  createdAt: string
  updatedAt: string
}

export type SyncTable = 'clients' | 'projects' | 'entries' | 'upworkTransactions' | 'otherIncome'

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
  /** Column choice for Upwork clients (gross, net and net EUR by default). */
  summaryColumnsPlatform?: string[]
  /** Reports: count non-billable entries in the hours (never in the amounts). */
  reportsIncludeNonBillable?: boolean
  /** E-mail preferences for documents sent from the app. */
  mail?: { signature?: string; copyToSender?: boolean }
  /** Upwork: fee percent to estimate with until the real fee row arrives (sorted by `from`), and cached ECB USD→EUR rates per day. */
  upwork?: { feeSchedule?: { from: string; percent: number }[]; fxRates?: Record<string, number> }
  /** Legacy setting from before the billing rules; ignored. */
  timerRoundingMin?: number
  sync?: SyncState
}
