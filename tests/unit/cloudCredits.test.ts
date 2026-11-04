import { describe, expect, it } from 'vitest'
import { creditsFromRows, loadCloudBankCredits, type CloudBankCreditRow, type CreditsClient } from '../../src/lib/upwork/cloudCredits'

function client(data: CloudBankCreditRow[] | null, error: { message: string } | null = null): CreditsClient {
  return { from: () => ({ select: () => ({ order: () => Promise.resolve({ data, error }) }) }) }
}

describe('bank credits from the cloud table', () => {
  it('keeps EUR credits once per date and amount, with the party and text as description', async () => {
    const rows: CloudBankCreditRow[] = [
      { booked: '2026-10-27', amount: '810.00', currency: 'EUR', party: 'UPWORK', description: 'Upwork payout', reference: 'A1' },
      { booked: '2026-10-27', amount: 810, currency: 'EUR', party: 'UPWORK', description: null, reference: 'NOREF:dup' },
      { booked: '2026-10-20', amount: 1000, currency: 'USD', party: 'UPWORK', description: null, reference: 'A2' },
      { booked: '2026-10-13', amount: 0, currency: 'EUR', party: 'UPWORK', description: null, reference: 'A3' },
      { booked: '2026-10-06T00:00:00', amount: 500.5, currency: null, party: null, description: 'Upwork', reference: 'A4' },
    ]
    expect(creditsFromRows(rows)).toEqual([
      { date: '2026-10-27', amount: 810, description: 'UPWORK Upwork payout' },
      { date: '2026-10-06', amount: 500.5, description: 'Upwork' },
    ])
    expect(await loadCloudBankCredits(client(rows))).toHaveLength(2)
    expect(await loadCloudBankCredits(client(null))).toEqual([])
  })

  it('reports a missing table instead of matching nothing silently', async () => {
    await expect(loadCloudBankCredits(client(null, { message: 'relation "public.bank_credits" does not exist' }))).rejects.toThrow(/bank_credits/)
  })
})
