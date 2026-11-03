import { describe, expect, it } from 'vitest'
import type { UpworkTransaction } from '../../src/db/types'
import { payoutsOf } from '../../src/lib/upwork/allocate'
import { matchBankCredits, parseBankCredits, parseBankDate } from '../../src/lib/upwork/bankCredits'

const tx = (over: Partial<UpworkTransaction> & Pick<UpworkTransaction, 'txId' | 'date' | 'type' | 'amount'>): UpworkTransaction => ({ subtype: '', description: '', currency: 'USD', ...over })

describe('bank credits file', () => {
  it('reads a finance-app export (comma, ISO dates) and keeps the Upwork rows', () => {
    const text = 'Date,Amount,Party,Description,Channel\n2026-10-23,2345.10,UPWORK,"PAYMENT ESCROW INC DOB-1900-Jan-01",Actus - Swedbank\n2026-10-24,15.00,RIMI,groceries,Swedbank\n'
    expect(parseBankCredits(text)).toEqual([{ date: '2026-10-23', amount: 2345.1, description: 'UPWORK · PAYMENT ESCROW INC DOB-1900-Jan-01' }])
  })

  it('reads a Swedbank statement (semicolon, DD.MM.YYYY, comma decimals, D/K column)', () => {
    const text =
      '"Klienta konts";"Ieraksta tips";"Datums";"Saņēmējs/Maksātājs";"Informācija saņēmējam";"Summa";"Valūta";"Debets/Kredīts"\n' +
      '"LV00";"20";"23.10.2026";"UPWORK ESCROW INC";"Upwork/ ROC/1";"2 345,10";"EUR";"K"\n' +
      '"LV00";"20";"24.10.2026";"UPWORK";"refund";"10,00";"EUR";"D"\n' +
      '"LV00";"20";"25.10.2026";"Some shop";"x";"99,00";"EUR";"K"\n'
    expect(parseBankCredits(text)).toEqual([{ date: '2026-10-23', amount: 2345.1, description: 'UPWORK ESCROW INC · Upwork/ ROC/1' }])
  })

  it('keeps every credit when no row names Upwork, and rejects files without the columns', () => {
    expect(parseBankCredits('Date,Amount\n2026-10-23,100\n2026-10-30,200\n')).toHaveLength(2)
    expect(() => parseBankCredits('Foo,Bar\n1,2\n')).toThrow(/date and amount/i)
    expect(parseBankDate('23/10/2026')).toBe('2026-10-23')
    expect(parseBankDate('2026-10-23T00:00:00')).toBe('2026-10-23')
    expect(parseBankDate('October')).toBeUndefined()
  })
})

describe('matching credits to payouts', () => {
  const ledger = [
    tx({ txId: 'w1', date: '2026-10-09', type: 'withdrawal', amount: 2675.01 }),
    tx({ txId: 'f1', date: '2026-10-09', type: 'withdrawalFee', amount: -0.99 }),
    tx({ txId: 'w2', date: '2026-10-16', type: 'withdrawal', amount: 2688.51 }),
    tx({ txId: 'f2', date: '2026-10-16', type: 'withdrawalFee', amount: -0.99 }),
    tx({ txId: 'w3', date: '2026-10-23', type: 'withdrawal', amount: 2061.76 }),
    tx({ txId: 'a3', date: '2026-10-30', type: 'other', amount: -235.97, description: 'Adjustment to Payout Transaction w3 due to the the utilization of an inaccurate Foreign Exchange rate' }),
    tx({ txId: 'w4', date: '2026-10-30', type: 'withdrawal', amount: 166.84 }),
  ]

  it('pairs each credit with the withdrawal booked a few days earlier and prices it', () => {
    const credits = [
      { date: '2026-10-13', amount: 2408.4 }, // w1: 2676 USD → 0.9
      { date: '2026-10-19', amount: 2420.55 }, // w2: 2689.5 USD → 0.9
      { date: '2026-10-27', amount: 2061.76 }, // w3: Upwork paid 1:1 and later booked the FX adjustment → 2297.73 USD → 0.897
    ]
    const r = matchBankCredits(credits, payoutsOf(ledger))
    expect(r.unmatched).toEqual([])
    expect(r.matches.map((m) => [m.payout.tx.txId, m.credit.amount, m.rate, m.already])).toEqual([
      ['w1', 2408.4, 0.9, false],
      ['w2', 2420.55, 0.9, false],
      ['w3', 2061.76, 0.897303, false],
    ])
  })

  it('prefers the candidate whose rate is closest to the reference rate of the day', () => {
    // Two payouts a week apart, both within the window of one credit: the reference rate decides.
    const credits = [{ date: '2026-10-19', amount: 2420.55 }]
    const r = matchBankCredits(credits, payoutsOf(ledger), () => 0.9)
    expect(r.matches[0].payout.tx.txId).toBe('w2')
    const r2 = matchBankCredits(credits, payoutsOf(ledger), () => 0.905)
    expect(r2.matches[0].payout.tx.txId).toBe('w1') // 2420.55 / 2676 = 0.9045
  })

  it('leaves implausible credits unmatched with a hint, and recognises amounts already entered', () => {
    const credits = [
      { date: '2026-11-02', amount: 121.4 }, // w4 at 0.728: a correspondent fee ate part of it
      { date: '2026-10-13', amount: 2408.4 },
    ]
    const priced = ledger.map((t) => (t.txId === 'w1' ? { ...t, eurAmount: 2408.4 } : t))
    const r = matchBankCredits(credits, payoutsOf(priced))
    expect(r.matches.map((m) => [m.payout.tx.txId, m.already])).toEqual([['w1', true]])
    expect(r.unmatched).toHaveLength(1)
    expect(r.unmatched[0]).toMatchObject({ credit: { amount: 121.4 }, rate: 0.7276 })
    expect(r.unmatched[0].nearest!.tx.txId).toBe('w4')
    // A payout priced with a different amount is not offered to another credit.
    const other = matchBankCredits([{ date: '2026-10-13', amount: 2400 }], payoutsOf(priced))
    expect(other.matches).toEqual([])
    expect(other.unmatched[0].nearest!.tx.txId).toBe('w1')
  })

  it('never matches a credit booked before the withdrawal or more than two weeks after it', () => {
    const r = matchBankCredits(
      [
        { date: '2026-10-08', amount: 2408.4 }, // the day before w1 was withdrawn
        { date: '2026-10-30', amount: 2420.55 }, // 14 days after w2, 21 after w1
      ],
      payoutsOf(ledger),
    )
    expect(r.matches.map((m) => m.payout.tx.txId)).toEqual(['w2'])
    expect(r.unmatched.map((u) => u.credit.date)).toEqual(['2026-10-08'])
  })
})
