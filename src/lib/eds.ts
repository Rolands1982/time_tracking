/**
 * The app's side of the `eds` Edge Function (see supabase/functions/README.md): send the month's employer's
 * report to VID EDS, read its state, submit it. The function uses the cloud-sync sign-in and holds the EDS
 * API key, so the user must be signed in on the Data screen.
 */
import { getSupabase } from '../sync/remote'
import { canSubmit, isSubmitted, messagesOf, type EdsDocument, type EdsRequest } from '../../supabase/functions/eds/validate'

export { canSubmit, isSubmitted, messagesOf }
export type { EdsDocument }

export interface EdsAnswer {
  documentId: number
  document: EdsDocument | null
  created?: boolean
  deleted?: boolean
  alreadySubmitted?: boolean
  /** The document exists but a later step (the check) failed. */
  warning?: string
}

export type EdsOutcome = ({ ok: true } & EdsAnswer) | { ok: false; code: 'not-configured' | 'not-signed-in' | 'not-deployed' | 'rejected' | 'network'; error: string; document?: EdsDocument }

export async function callEds(request: EdsRequest): Promise<EdsOutcome> {
  const supabase = await getSupabase()
  if (!supabase) return { ok: false, code: 'not-configured', error: 'Cloud sync is not configured' }
  const { data } = await supabase.auth.getSession()
  if (!data.session) return { ok: false, code: 'not-signed-in', error: 'Sign in to cloud sync on the Data screen to reach EDS from the app' }
  const { data: result, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string } & Partial<EdsAnswer>>('eds', { body: request })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.status === 'number') {
      const detail = await ctx
        .clone()
        .json()
        .then((j: { error?: string; document?: EdsDocument }) => j)
        .catch(() => undefined)
      if (ctx.status === 404) return { ok: false, code: 'not-deployed', error: 'The eds function is not deployed yet (see supabase/functions/README.md)' }
      return { ok: false, code: 'rejected', error: detail?.error ?? `${error.message} (HTTP ${ctx.status})`, document: detail?.document }
    }
    return { ok: false, code: 'network', error: error.message }
  }
  if (!result?.ok || result.documentId == null) return { ok: false, code: 'rejected', error: result?.error ?? 'Unknown error' }
  return { ok: true, documentId: result.documentId, document: result.document ?? null, created: result.created, deleted: result.deleted, alreadySubmitted: result.alreadySubmitted, warning: result.warning }
}
