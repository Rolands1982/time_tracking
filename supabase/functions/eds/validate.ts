/**
 * Request validation and document helpers for the eds Edge Function. Plain TypeScript without Deno or Node
 * APIs so the same file runs in the function, in the app and in the unit tests.
 */

/** What the app may ask the function to do with the month's employer's report (DokDDZv5). */
export type EdsRequest =
  | { action: 'send'; model: Record<string, unknown>; documentId?: number }
  | { action: 'status' | 'submit' | 'delete'; documentId: number }
  | { action: 'diagnose' }

/** What the function reports about its EDS credentials: shapes and lengths only, never the secrets. */
export interface EdsDiagnosis {
  mode: 'key' | 'certificate' | 'none'
  /** Findings in plain words, e.g. "certificate id: 12…89 (9 digits)". */
  facts: string[]
  /** Things that look wrong before EDS is even asked. */
  problems: string[]
  /** What EDS answered to a harmless authenticated request (the list of documents, one row). */
  probe?: { status: number; ok: boolean; message: string }
}

/** "12…89 (9 digits)": enough to recognise a value, not enough to use it. */
export function shapeOf(value: string): string {
  const kind = /^\d+$/.test(value) ? 'digits' : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? 'characters, a GUID' : 'characters'
  const shown = value.length > 6 ? `${value.slice(0, 2)}…${value.slice(-2)}` : '…'
  return `${shown} (${value.length} ${kind})`
}

/** Dokumenta pamatdati of the EDS API (GET /api/doc/{id}); only the fields the app reads. */
export interface EdsDocument {
  Id?: number
  Statuss?: string
  StatussId?: number
  Iesniegts?: string | null
  VarIesniegt?: boolean
  VarDzest?: boolean
  IrBridinajumi?: boolean
  ParbaudesRezultats?: { Kluda?: string[]; Bridinajums?: string[]; Informacija?: string[]; Apstiprinajums?: string[] } | null
  SanemtasAtbildes?: { Tips?: string; Datums?: string; Teksts?: string }[] | null
}

export type Validation = { ok: true; value: EdsRequest } | { ok: false; error: string }

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

export function validateEdsRequest(input: unknown): Validation {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Body must be a JSON object' }
  const b = input as Record<string, unknown>
  if (b.action === 'status' || b.action === 'submit' || b.action === 'delete') {
    if (!isId(b.documentId)) return { ok: false, error: 'documentId: a document number is required' }
    return { ok: true, value: { action: b.action, documentId: b.documentId } }
  }
  if (b.action === 'diagnose') return { ok: true, value: { action: 'diagnose' } }
  if (b.action !== 'send') return { ok: false, error: 'action: one of send, status, submit, delete, diagnose' }
  if (b.documentId != null && !isId(b.documentId)) return { ok: false, error: 'documentId: not a document number' }
  const m = b.model
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return { ok: false, error: 'model: the document is required' }
  const model = m as Record<string, unknown>
  if (!Number.isInteger(model.ParskGads) || (model.ParskGads as number) < 2020 || (model.ParskGads as number) > 2100) return { ok: false, error: 'model.ParskGads: a year is required' }
  if (typeof model.ParskMen !== 'string' || !/^(0[1-9]|1[0-2])$/.test(model.ParskMen)) return { ok: false, error: 'model.ParskMen: a month 01–12 is required' }
  if (typeof model.NmrKods !== 'string' || !model.NmrKods.trim()) return { ok: false, error: 'model.NmrKods: the taxpayer number is required' }
  const rows = model.Tabula1
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 50) return { ok: false, error: 'model.Tabula1: one to 50 employees' }
  for (const r of rows) {
    const row = r as Record<string, unknown> | null
    if (typeof row !== 'object' || row === null || typeof row.PersonasKods !== 'string' || !row.PersonasKods.trim()) return { ok: false, error: 'model.Tabula1: every row needs PersonasKods' }
    if (!Number.isInteger(row.Stundas) || (row.Stundas as number) < 0 || (row.Stundas as number) > 744) return { ok: false, error: 'model.Tabula1: Stundas must be whole hours of a month' }
  }
  return { ok: true, value: { action: 'send', model, documentId: b.documentId as number | undefined } }
}

export interface EdsMessages {
  errors: string[]
  warnings: string[]
  info: string[]
}

/** The check result of a document. */
export function messagesOf(doc: EdsDocument | undefined | null): EdsMessages {
  const r = doc?.ParbaudesRezultats ?? {}
  return { errors: [...(r.Kluda ?? [])], warnings: [...(r.Bridinajums ?? [])], info: [...(r.Informacija ?? []), ...(r.Apstiprinajums ?? [])] }
}

/** The check has come back: there is a result, or EDS already allows the submission. */
export function isChecked(doc: EdsDocument): boolean {
  const m = messagesOf(doc)
  return Boolean(doc.VarIesniegt) || m.errors.length + m.warnings.length + m.info.length > 0
}

export function isSubmitted(doc: EdsDocument | undefined | null): boolean {
  return Boolean(doc?.Iesniegts)
}

/** May be submitted: EDS allows it and the check found no errors. */
export function canSubmit(doc: EdsDocument | undefined | null): boolean {
  return Boolean(doc?.VarIesniegt) && !isSubmitted(doc) && messagesOf(doc).errors.length === 0
}

/** The text an API certificate signs for the day's token: "<taxpayer number>:<yyyy.MM.dd>" (date in Latvia). */
export function tokenMessage(taxpayerNo: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Riga', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${taxpayerNo}:${get('year')}.${get('month')}.${get('day')}`
}
