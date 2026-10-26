/**
 * Supabase Edge Function: send an e-mail with attachments through a plain SMTP mailbox
 * (e.g. mail.online.lv) on behalf of the signed-in app user.
 *
 * Secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
 *   SMTP_HOST          mail.online.lv
 *   SMTP_PORT          465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_TLS           "true" for port 465, "false" for 587
 *   SMTP_USER          mailbox user name, usually the full address
 *   SMTP_PASS          mailbox password
 *   MAIL_FROM          "Rolands <rolands@actusbi.lv>"
 *   MAIL_ALLOWED_USERS optional comma-separated list of app sign-in e-mails allowed to send;
 *                      empty = every signed-in user of this Supabase project
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { validateSendMailRequest } from './validate.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback
  if (v == null || v === '') throw new Error(`Missing secret ${name}`)
  return v
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // 1. Who is calling? Only signed-in users of this project (same sign-in as cloud sync).
  const authorization = req.headers.get('Authorization') ?? ''
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authorization } } })
  const { data, error: authError } = await supabase.auth.getUser()
  const user = data?.user
  if (authError || !user) return json({ error: 'Sign in to cloud sync first' }, 401)
  const allowed = (Deno.env.get('MAIL_ALLOWED_USERS') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length && !allowed.includes((user.email ?? '').toLowerCase())) return json({ error: `${user.email} is not allowed to send mail` }, 403)

  // 2. What should be sent?
  const parsed = validateSendMailRequest(await req.json().catch(() => null))
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const mail = parsed.value

  // 3. Send through the mailbox.
  let from: string
  let client: SMTPClient
  try {
    from = env('MAIL_FROM')
    client = new SMTPClient({
      connection: {
        hostname: env('SMTP_HOST'),
        port: Number(env('SMTP_PORT', '465')),
        tls: env('SMTP_TLS', 'true') === 'true',
        auth: { username: env('SMTP_USER'), password: env('SMTP_PASS') },
      },
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
  const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from
  try {
    await client.send({
      from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.copyToSender ? [fromAddress] : undefined,
      replyTo: fromAddress,
      subject: mail.subject,
      content: mail.text,
      attachments: mail.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, encoding: 'base64' as const, content: a.base64 })),
    })
  } catch (err) {
    console.error('send-mail failed', err)
    return json({ error: `Mail server refused the message: ${(err as Error).message}` }, 502)
  } finally {
    await client.close().catch(() => {})
  }
  console.log(`send-mail: ${user.email} → ${mail.to.join(', ')} (${mail.attachments?.length ?? 0} attachments)`)
  return json({ ok: true, to: mail.to })
})
