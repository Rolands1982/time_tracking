/**
 * Request validation for the send-mail Edge Function. Plain TypeScript without Deno or Node
 * APIs so the same file runs in the function and in the unit tests.
 */
export interface MailAttachmentPayload {
  filename: string
  contentType: string
  /** File content, base64 encoded. */
  base64: string
}

export interface SendMailRequest {
  to: string[]
  cc?: string[]
  /** Blind-copy the configured sender address so the mail shows up in the sender's own inbox. */
  copyToSender?: boolean
  subject: string
  text: string
  attachments?: MailAttachmentPayload[]
}

export const LIMITS = {
  recipients: 10,
  subject: 200,
  text: 20_000,
  attachments: 5,
  /** Total decoded attachment size in bytes. */
  attachmentBytes: 8 * 1024 * 1024,
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

export function isEmail(s: string): boolean {
  return EMAIL.test(s.trim())
}

/** Split "a@x.lv, b@y.lv; c@z.lv" into trimmed, lower-cased addresses. */
export function splitAddresses(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
}

export type Validation = { ok: true; value: SendMailRequest } | { ok: false; error: string }

function addressList(v: unknown, field: string, required: boolean): string[] | string {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? splitAddresses(v) : []
  if (!list.length) return required ? `${field}: at least one address is required` : []
  if (list.length > LIMITS.recipients) return `${field}: at most ${LIMITS.recipients} addresses`
  for (const a of list) if (typeof a !== 'string' || !isEmail(a)) return `${field}: "${String(a)}" is not an e-mail address`
  return (list as string[]).map((a) => a.trim())
}

export function validateSendMailRequest(input: unknown): Validation {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Body must be a JSON object' }
  const b = input as Record<string, unknown>
  const to = addressList(b.to, 'to', true)
  if (typeof to === 'string') return { ok: false, error: to }
  const cc = addressList(b.cc, 'cc', false)
  if (typeof cc === 'string') return { ok: false, error: cc }
  const subject = typeof b.subject === 'string' ? b.subject.trim() : ''
  if (!subject) return { ok: false, error: 'subject is required' }
  if (subject.length > LIMITS.subject) return { ok: false, error: `subject: at most ${LIMITS.subject} characters` }
  const text = typeof b.text === 'string' ? b.text : ''
  if (!text.trim()) return { ok: false, error: 'text is required' }
  if (text.length > LIMITS.text) return { ok: false, error: `text: at most ${LIMITS.text} characters` }

  const attachments: MailAttachmentPayload[] = []
  if (b.attachments != null) {
    if (!Array.isArray(b.attachments)) return { ok: false, error: 'attachments must be an array' }
    if (b.attachments.length > LIMITS.attachments) return { ok: false, error: `at most ${LIMITS.attachments} attachments` }
    let bytes = 0
    for (const a of b.attachments as Record<string, unknown>[]) {
      const filename = typeof a?.filename === 'string' ? a.filename.replace(/[\\/:*?"<>|]/g, '_').trim() : ''
      const contentType = typeof a?.contentType === 'string' ? a.contentType : ''
      const base64 = typeof a?.base64 === 'string' ? a.base64.replace(/\s+/g, '') : ''
      if (!filename || !contentType || !base64) return { ok: false, error: 'each attachment needs filename, contentType and base64' }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { ok: false, error: `attachment ${filename}: content is not base64` }
      bytes += Math.floor((base64.length * 3) / 4)
      if (bytes > LIMITS.attachmentBytes) return { ok: false, error: 'attachments are too large (8 MB limit)' }
      attachments.push({ filename, contentType, base64 })
    }
  }
  return {
    ok: true,
    value: { to, cc: cc.length ? cc : undefined, copyToSender: b.copyToSender === true, subject, text, attachments: attachments.length ? attachments : undefined },
  }
}
