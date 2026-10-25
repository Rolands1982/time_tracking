/**
 * Send documents by e-mail through the `send-mail` Edge Function (see supabase/functions/README.md).
 * The function uses the cloud-sync sign-in, so the user must be signed in on the Data screen.
 */
import { getSupabase } from '../sync/remote'
import { isEmail, splitAddresses, type SendMailRequest } from '../../supabase/functions/send-mail/validate'

export { isEmail, splitAddresses }

export interface MailAttachment {
  filename: string
  contentType: string
  data: Blob | ArrayBuffer
}

export interface MailDraft {
  to: string
  cc?: string
  subject: string
  text: string
  copyToSender: boolean
  attachments: MailAttachment[]
}

export type SendOutcome = { ok: true; to: string[] } | { ok: false; code: 'invalid' | 'not-configured' | 'not-signed-in' | 'not-deployed' | 'rejected' | 'network'; error: string }

export async function toBase64(data: Blob | ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Validate the draft on the client and turn it into the function's request body. */
export async function buildSendMailBody(draft: MailDraft): Promise<{ ok: true; body: SendMailRequest } | { ok: false; error: string }> {
  const to = splitAddresses(draft.to)
  if (!to.length) return { ok: false, error: 'Enter a recipient address' }
  const bad = [...to, ...splitAddresses(draft.cc ?? '')].find((a) => !isEmail(a))
  if (bad) return { ok: false, error: `"${bad}" is not an e-mail address` }
  if (!draft.subject.trim()) return { ok: false, error: 'Enter a subject' }
  if (!draft.text.trim()) return { ok: false, error: 'Enter a message' }
  const attachments = []
  for (const a of draft.attachments) attachments.push({ filename: a.filename, contentType: a.contentType, base64: await toBase64(a.data) })
  const cc = splitAddresses(draft.cc ?? '')
  return { ok: true, body: { to, cc: cc.length ? cc : undefined, copyToSender: draft.copyToSender, subject: draft.subject.trim(), text: draft.text, attachments } }
}

export async function sendMail(draft: MailDraft): Promise<SendOutcome> {
  const built = await buildSendMailBody(draft)
  if (!built.ok) return { ok: false, code: 'invalid', error: built.error }
  const supabase = await getSupabase()
  if (!supabase) return { ok: false, code: 'not-configured', error: 'Cloud sync is not configured' }
  const { data } = await supabase.auth.getSession()
  if (!data.session) return { ok: false, code: 'not-signed-in', error: 'Sign in to cloud sync on the Data screen to send e-mail from the app' }
  const { data: result, error } = await supabase.functions.invoke<{ ok?: boolean; to?: string[]; error?: string }>('send-mail', { body: built.body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.status === 'number') {
      const detail = await ctx
        .clone()
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined)
      if (ctx.status === 404) return { ok: false, code: 'not-deployed', error: 'The send-mail function is not deployed yet (see supabase/functions/README.md)' }
      return { ok: false, code: 'rejected', error: detail ?? `${error.message} (HTTP ${ctx.status})` }
    }
    return { ok: false, code: 'network', error: error.message }
  }
  if (!result?.ok) return { ok: false, code: 'rejected', error: result?.error ?? 'Unknown error' }
  return { ok: true, to: result.to ?? built.body.to }
}
