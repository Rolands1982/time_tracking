/**
 * Bank credits kept in the cloud (table bank_credits): the personal finances app forwards every EUR credit
 * from Upwork there on each bank sync, and the daily ingest reads them to price payouts. Devices do not sync
 * the table; this loader is for the unattended script, signed in as the user.
 */
import type { BankCredit } from './bankCredits'

/** One row of bank_credits as PostgREST returns it. */
export interface CloudBankCreditRow {
  booked: string
  amount: number | string
  currency?: string | null
  party?: string | null
  description?: string | null
  reference: string
}

/** The sliver of the Supabase client the loader uses, so tests need no SDK. */
export interface CreditsClient {
  from(table: string): {
    select(columns: string): {
      order(column: string, options?: { ascending?: boolean }): PromiseLike<{ data: CloudBankCreditRow[] | null; error: { message: string } | null }>
    }
  }
}

/** Rows → credits the matcher understands; EUR only, one per booking date and amount (a credit forwarded under two references counts once). */
export function creditsFromRows(rows: CloudBankCreditRow[]): BankCredit[] {
  const seen = new Set<string>()
  const out: BankCredit[] = []
  for (const r of rows) {
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount)
    const date = r.booked.slice(0, 10)
    if ((r.currency ?? 'EUR') !== 'EUR' || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const key = `${date}|${amount.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ date, amount, description: [r.party, r.description].filter(Boolean).join(' ').trim() || undefined })
  }
  return out
}

export async function loadCloudBankCredits(client: CreditsClient): Promise<BankCredit[]> {
  const { data, error } = await client.from('bank_credits').select('booked, amount, currency, party, description, reference').order('booked', { ascending: true })
  if (error) throw new Error(`bank_credits: ${error.message}`)
  return creditsFromRows(data ?? [])
}
