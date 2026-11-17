/**
 * Supabase Edge Function: the app's link to the VID EDS API (https://eds.vid.gov.lv/api) for the monthly
 * employer's report. The browser can neither reach EDS (no cross-origin access) nor should it hold the API
 * key, so the key lives in this function's secrets and the app asks the function to act.
 *
 * Actions (JSON body, see validate.ts):
 *   send    create the document (POST /api/doc/ddzv5) unless documentId is given, start the check,
 *           wait for its result
 *   status  the document's state
 *   submit  submit the document when EDS allows it, wait until it shows as submitted
 *   delete  delete a document that is not submitted
 *
 * Secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
 *   EDS_API_KEY        an API key from EDS (IESTATĪJUMI / API atslēgas, scope "Dokumentu API"; up to 90 days)
 *   or, for an API certificate:
 *   EDS_CERT_ID        the certificate's id
 *   EDS_CERT_KEY       its private key: PKCS#8, base64 (a PEM body without the BEGIN/END lines works)
 *   EDS_TAXPAYER_NO    the company registration number the token is signed for
 *   EDS_ALLOWED_USERS  optional comma-separated list of app sign-in e-mails allowed to use this;
 *                      empty = every signed-in user of this Supabase project
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { canSubmit, isChecked, isSubmitted, tokenMessage, validateEdsRequest, type EdsDocument } from './validate.ts'

const EDS = 'https://eds.vid.gov.lv'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

class EdsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** The value after "Bearer ": the API key, or "<certificate id>:<token signed for today>". */
async function bearer(): Promise<string> {
  const key = Deno.env.get('EDS_API_KEY')?.trim()
  if (key) return key
  const id = Deno.env.get('EDS_CERT_ID')?.trim()
  const pkcs8 = Deno.env.get('EDS_CERT_KEY')?.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const taxpayer = Deno.env.get('EDS_TAXPAYER_NO')?.trim()
  if (!id || !pkcs8 || !taxpayer) throw new EdsError('Missing secret EDS_API_KEY (or EDS_CERT_ID, EDS_CERT_KEY and EDS_TAXPAYER_NO)', 500)
  const der = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0))
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(tokenMessage(taxpayer, new Date())))
  return `${id}:${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

const HINTS: Record<number, string> = {
  401: 'EDS did not accept the API key or certificate (expired, deleted, or without the "Dokumentu API" scope?)',
  403: 'EDS: no rights for this, or the document does not exist',
  409: 'EDS already has a document for this period created with this key; look at it in EDS',
  429: 'EDS: too many requests, wait a minute',
}

async function eds(method: string, path: string, body?: unknown): Promise<Response> {
  const r = await fetch(`${EDS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await bearer()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (r.status >= 400) {
    const text = (await r.text().catch(() => '')).trim().slice(0, 600)
    throw new EdsError(`${HINTS[r.status] ?? `EDS refused the request (${r.status})`}${text ? `: ${text}` : ''}`, r.status)
  }
  return r
}

const document = async (id: number): Promise<EdsDocument> => (await (await eds('GET', `/api/doc/${id}`)).json()) as EdsDocument

/** Poll the document until `done` holds; the checks run asynchronously in EDS. */
async function wait(id: number, done: (d: EdsDocument) => boolean, tries = 10, pauseMs = 2000): Promise<EdsDocument> {
  let doc = await document(id)
  for (let i = 1; i < tries && !done(doc); i++) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
    doc = await document(id)
  }
  return doc
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // 1. Who is calling? Only signed-in users of this project (same sign-in as cloud sync).
  const authorization = req.headers.get('Authorization') ?? ''
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } })
  const { data, error: authError } = await supabase.auth.getUser()
  const user = data?.user
  if (authError || !user) return json({ error: 'Sign in to cloud sync first' }, 401)
  const allowed = (Deno.env.get('EDS_ALLOWED_USERS') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length && !allowed.includes((user.email ?? '').toLowerCase())) return json({ error: `${user.email} is not allowed to use EDS` }, 403)

  // 2. What is asked?
  const parsed = validateEdsRequest(await req.json().catch(() => null))
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const request = parsed.value

  // 3. Ask EDS.
  try {
    if (request.action === 'send') {
      let id = request.documentId
      let created = false
      if (id == null) {
        const answer: unknown = await (await eds('POST', '/api/doc/ddzv5', request.model)).json()
        id = Number(typeof answer === 'object' && answer !== null ? ((answer as { Id?: number; id?: number }).Id ?? (answer as { id?: number }).id) : answer)
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'EDS created the document but returned no number; look at it in EDS' }, 502)
        created = true
        console.log(`eds: ${user.email} created document ${id}`)
      }
      // From here on the document exists: always report its number, also when a later step fails.
      try {
        await eds('GET', `/api/doc/${id}/validate`)
        return json({ ok: true, documentId: id, created, document: await wait(id, isChecked) })
      } catch (err) {
        return json({ ok: true, documentId: id, created, document: null, warning: (err as Error).message })
      }
    }
    if (request.action === 'status') return json({ ok: true, documentId: request.documentId, document: await document(request.documentId) })
    if (request.action === 'delete') {
      await eds('DELETE', `/api/doc/${request.documentId}`)
      console.log(`eds: ${user.email} deleted document ${request.documentId}`)
      return json({ ok: true, documentId: request.documentId, deleted: true })
    }
    // submit
    const before = await document(request.documentId)
    if (isSubmitted(before)) return json({ ok: true, documentId: request.documentId, document: before, alreadySubmitted: true })
    if (!canSubmit(before)) return json({ error: 'EDS does not allow submitting this document (errors, or not checked yet)', document: before }, 409)
    await eds('GET', `/api/doc/${request.documentId}/submit`)
    console.log(`eds: ${user.email} submitted document ${request.documentId}`)
    return json({ ok: true, documentId: request.documentId, document: await wait(request.documentId, (d) => isSubmitted(d) || !d.VarIesniegt) })
  } catch (err) {
    if (err instanceof EdsError) return json({ error: err.message, edsStatus: err.status }, err.status === 500 ? 500 : 502)
    console.error('eds failed', err)
    return json({ error: `Could not reach EDS: ${(err as Error).message}` }, 502)
  }
})
