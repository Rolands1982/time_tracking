import { describe, expect, it } from 'vitest'
import { LIMITS, splitAddresses, validateSendMailRequest } from '../../supabase/functions/send-mail/validate'
import { buildSendMailBody, toBase64 } from '../../src/lib/mail'

describe('send-mail request validation (shared with the Edge Function)', () => {
  it('accepts a complete request and normalises it', () => {
    const r = validateSendMailRequest({
      to: 'Client@Example.lv; second@example.com',
      cc: [],
      copyToSender: true,
      subject: '  Time summary  ',
      text: 'Hello',
      attachments: [{ filename: 'Summary: Acme/2026.pdf', contentType: 'application/pdf', base64: 'JVBERi0x' }],
    })
    expect(r).toEqual({
      ok: true,
      value: {
        to: ['client@example.lv', 'second@example.com'],
        cc: undefined,
        copyToSender: true,
        subject: 'Time summary',
        text: 'Hello',
        attachments: [{ filename: 'Summary_ Acme_2026.pdf', contentType: 'application/pdf', base64: 'JVBERi0x' }],
      },
    })
  })

  it('rejects bad input with a readable reason', () => {
    const err = (input: unknown) => (validateSendMailRequest(input) as { error: string }).error
    expect(err(null)).toMatch(/JSON object/)
    expect(err({ subject: 'x', text: 'y' })).toMatch(/to: at least one/)
    expect(err({ to: 'nope', subject: 'x', text: 'y' })).toMatch(/"nope" is not an e-mail/)
    expect(err({ to: 'a@b.lv', text: 'y' })).toMatch(/subject is required/)
    expect(err({ to: 'a@b.lv', subject: 'x', text: ' ' })).toMatch(/text is required/)
    expect(err({ to: 'a@b.lv', subject: 'x'.repeat(LIMITS.subject + 1), text: 'y' })).toMatch(/subject: at most/)
    expect(err({ to: Array.from({ length: LIMITS.recipients + 1 }, (_, i) => `u${i}@b.lv`), subject: 'x', text: 'y' })).toMatch(/at most 10 addresses/)
    expect(err({ to: 'a@b.lv', subject: 'x', text: 'y', attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', base64: 'not base64!' }] })).toMatch(/not base64/)
    expect(err({ to: 'a@b.lv', subject: 'x', text: 'y', attachments: [{ filename: 'f.pdf' }] })).toMatch(/needs filename, contentType and base64/)
    const huge = 'A'.repeat(Math.ceil((LIMITS.attachmentBytes + 1024) / 3) * 4)
    expect(err({ to: 'a@b.lv', subject: 'x', text: 'y', attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', base64: huge }] })).toMatch(/too large/)
  })

  it('splits address lists on commas, semicolons and whitespace', () => {
    expect(splitAddresses(' A@x.lv, b@y.lv;c@z.lv\n')).toEqual(['a@x.lv', 'b@y.lv', 'c@z.lv'])
    expect(splitAddresses('')).toEqual([])
  })
})

describe('mail client', () => {
  it('builds the request body with base64 attachments', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer // "%PDF-1"
    expect(await toBase64(pdf)).toBe('JVBERi0x')
    const built = await buildSendMailBody({
      to: 'client@example.lv',
      cc: 'boss@example.lv',
      subject: 'Summary',
      text: 'Hi',
      copyToSender: false,
      attachments: [{ filename: 'Summary.pdf', contentType: 'application/pdf', data: pdf }],
    })
    expect(built).toEqual({
      ok: true,
      body: { to: ['client@example.lv'], cc: ['boss@example.lv'], copyToSender: false, subject: 'Summary', text: 'Hi', attachments: [{ filename: 'Summary.pdf', contentType: 'application/pdf', base64: 'JVBERi0x' }] },
    })
    // The body the client builds is what the function accepts.
    expect(validateSendMailRequest((built as { body: unknown }).body).ok).toBe(true)
  })

  it('stops before contacting the server when the draft is incomplete', async () => {
    const base = { subject: 'S', text: 'T', copyToSender: true, attachments: [] }
    expect(await buildSendMailBody({ ...base, to: '' })).toEqual({ ok: false, error: 'Enter a recipient address' })
    expect(await buildSendMailBody({ ...base, to: 'x@y.lv', cc: 'bad' })).toEqual({ ok: false, error: '"bad" is not an e-mail address' })
    expect(await buildSendMailBody({ ...base, to: 'x@y.lv', subject: ' ' })).toEqual({ ok: false, error: 'Enter a subject' })
  })
})
