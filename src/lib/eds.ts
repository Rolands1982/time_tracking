/**
 * The app's side of the `eds` Edge Function (see supabase/functions/README.md): send the month's employer's
 * report to VID EDS, read its state, submit it. The function uses the cloud-sync sign-in and holds the EDS
 * API key, so the user must be signed in on the Data screen.
 */
import { getSupabase } from '../sync/remote'
import { canSubmit, isSubmitted, messagesOf, type EdsDiagnosis, type EdsDocument, type EdsRequest } from '../../supabase/functions/eds/validate'

export { canSubmit, isSubmitted, messagesOf }
export type { EdsDiagnosis, EdsDocument }

export interface EdsAnswer {
  documentId: number
  document: EdsDocument | null
  created?: boolean
  deleted?: boolean
  alreadySubmitted?: boolean
  /** The document exists but a later step (the check) failed. */
  warning?: string
}

export interface EdsFailure {
  ok: false
  code: 'not-configured' | 'not-signed-in' | 'not-deployed' | 'rejected' | 'network'
  error: string
  document?: EdsDocument
}

export type EdsOutcome = ({ ok: true } & EdsAnswer) | EdsFailure

type Reply = { ok?: boolean; error?: string; diagnosis?: EdsDiagnosis } & Partial<EdsAnswer>

async function invoke(request: EdsRequest): Promise<{ ok: true; result: Reply } | EdsFailure> {
  const supabase = await getSupabase()
  if (!supabase) return { ok: false, code: 'not-configured', error: 'Cloud sync is not configured' }
  const { data } = await supabase.auth.getSession()
  if (!data.session) return { ok: false, code: 'not-signed-in', error: 'Sign in to cloud sync on the Data screen to reach EDS from the app' }
  const { data: result, error } = await supabase.functions.invoke<Reply>('eds', { body: request })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.status === 'number') {
      const detail = await ctx
        .clone()
        .json()
        .then((j: { error?: string; document?: EdsDocument }) => j)
        .catch(() => undefined)
      if (ctx.status === 404) return { ok: false, code: 'not-deployed', error: 'The eds function is not deployed yet (see supabase/functions/README.md)' }
      // The device still holds a sign-in the server has ended (signed out elsewhere, or expired).
      if (ctx.status === 401) return { ok: false, code: 'not-signed-in', error: 'The cloud sign-in on this device has ended: sign out and in again on the Data screen, then retry' }
      return { ok: false, code: 'rejected', error: detail?.error ?? `${error.message} (HTTP ${ctx.status})`, document: detail?.document }
    }
    return { ok: false, code: 'network', error: error.message }
  }
  if (!result?.ok) return { ok: false, code: 'rejected', error: result?.error ?? 'Unknown error' }
  return { ok: true, result }
}

export async function callEds(request: Exclude<EdsRequest, { action: 'diagnose' }>): Promise<EdsOutcome> {
  const out = await invoke(request)
  if (!out.ok) return out
  const { result } = out
  if (result.documentId == null) return { ok: false, code: 'rejected', error: 'Unknown error' }
  return { ok: true, documentId: result.documentId, document: result.document ?? null, created: result.created, deleted: result.deleted, alreadySubmitted: result.alreadySubmitted, warning: result.warning }
}

/**
 * Why does EDS refuse? The function describes its credentials (shapes and lengths, never the secrets) and what EDS
 * answers to listing one document. A function deployed before this existed answers with its list of actions.
 */
export async function diagnoseEds(): Promise<{ ok: true; diagnosis: EdsDiagnosis } | EdsFailure> {
  const out = await invoke({ action: 'diagnose' })
  if (!out.ok) {
    return /one of send, status, submit, delete$/.test(out.error)
      ? { ...out, error: 'The deployed eds function is older than this check: deploy it again from supabase/functions/eds' }
      : out
  }
  if (!out.result.diagnosis) return { ok: false, code: 'rejected', error: 'The eds function sent no diagnosis' }
  return { ok: true, diagnosis: out.result.diagnosis }
}
