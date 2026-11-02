import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB, updateSettings } from '../../src/db/schema'
import type { TimeEntry, UpworkTransaction } from '../../src/db/types'
import { fillGaps, ensureFxRates } from '../../src/lib/fx'
import { allocatePayouts, linkFees, payoutsOf, rateEstimator, recalculateUpwork, setPayoutEur, settle, settleEntry } from '../../src/lib/upwork/allocate'
import { importUpwork, parseTransaction, type UpworkImportFile } from '../../src/lib/upwork/import'

let n = 0
let db: TimeTrackingDB
beforeEach(() => {
  db = new TimeTrackingDB(`upwork-allocate-${++n}`)
})

const tx = (over: Partial<UpworkTransaction> & Pick<UpworkTransaction, 'txId' | 'date' | 'type' | 'amount'>): UpworkTransaction => ({
  subtype: '',
  description: '',
  currency: 'USD',
  ...over,
})

describe('fee linking', () => {
  it('ties each fee (and its VAT) to the invoice of the same contract and day', () => {
    const txs = [
      tx({ txId: '10', date: '2026-10-18', type: 'hourly', amount: 2973.33, contractId: '36599829', periodFrom: '2026-10-12', periodTo: '2026-10-18' }),
      tx({ txId: '11', date: '2026-10-18', type: 'fee', amount: -297.33, contractId: '36599829', feeBase: 2973.33, feePercent: 10 }),
      tx({ txId: '12', date: '2026-10-18', type: 'vat', amount: -31.22, description: 'VAT - Service Fee - Ref ID 13\nRelated invoice: 10' }),
      tx({ txId: '13', date: '2026-10-18', type: 'vat', amount: -31.22, description: 'VAT - Service Fee - Ref ID 14\nRelated invoice: 11' }),
      tx({ txId: '14', date: '2026-10-18', type: 'vat', amount: 2.1, description: 'VAT - Membership - Ref ID 15\nAmount: $10.00 USD x 21% = $2.10 USD' }),
      // Another contract, same day; its fee is dated a day later (happens).
      tx({ txId: '20', date: '2026-10-18', type: 'hourly', amount: 15, contractId: '33492237', periodFrom: '2026-10-12', periodTo: '2026-10-18' }),
      tx({ txId: '21', date: '2026-10-19', type: 'fee', amount: -1.5, contractId: '33492237', feeBase: 15, feePercent: 10 }),
    ]
    const { earnings, unallocatedFees } = linkFees(txs)
    expect(earnings.map((e) => [e.tx.txId, e.fee, e.net])).toEqual([
      ['10', 359.77, 2613.56],
      ['20', 1.5, 13.5],
    ])
    expect(unallocatedFees).toEqual([])
  })

  it('matches several fees on one day by base and leaves the fee of a missing invoice unallocated', () => {
    const txs = [
      tx({ txId: '1', date: '2026-10-18', type: 'hourly', amount: 1000, contractId: 'c', periodFrom: '2026-10-12', periodTo: '2026-10-18' }),
      tx({ txId: '2', date: '2026-10-18', type: 'bonus', amount: 200, contractId: 'c' }),
      tx({ txId: '3', date: '2026-10-18', type: 'fee', amount: -100, contractId: 'c', feeBase: 1000, feePercent: 10 }),
      tx({ txId: '4', date: '2026-10-18', type: 'fee', amount: -20, contractId: 'c', feeBase: 200, feePercent: 10 }),
      // A fee whose invoice is not in the ledger at all.
      tx({ txId: '5', date: '2026-10-18', type: 'fee', amount: -7, contractId: 'other', feeBase: 70, feePercent: 10 }),
      // A fee for a bonus that has no earning row yet; the hourly invoice carries only its own share.
      tx({ txId: '6', date: '2026-10-25', type: 'hourly', amount: 500, contractId: 'c', periodFrom: '2026-10-19', periodTo: '2026-10-25' }),
      tx({ txId: '7', date: '2026-10-25', type: 'fee', amount: -100, contractId: 'c', feeBase: 1000, feePercent: 10 }),
    ]
    const { earnings, unallocatedFees } = linkFees(txs)
    const fee = Object.fromEntries(earnings.map((e) => [e.tx.txId, e.fee]))
    expect(fee).toEqual({ '1': 100, '2': 20, '6': 50 })
    expect(unallocatedFees.map((f) => [f.tx.txId, f.amount])).toEqual([
      ['5', 7],
      ['7', 50],
    ])
  })

  it('nets a refunded fee against the fee it refunds', () => {
    const txs = [
      tx({ txId: '1', date: '2020-03-01', type: 'hourly', amount: 1000, contractId: 'c', periodFrom: '2020-02-24', periodTo: '2020-03-01' }),
      tx({ txId: '2', date: '2020-03-01', type: 'fee', amount: -100, contractId: 'c', feeBase: 1000 }),
      tx({ txId: '3', date: '2020-03-01', type: 'fee', amount: -5, contractId: 'c', feeBase: 50 }), // fee of a bonus later reversed
      tx({ txId: '4', date: '2020-03-01', type: 'fee', amount: 5, contractId: 'c', feeBase: 50 }), // its refund
    ]
    const { earnings, unallocatedFees } = linkFees(txs)
    expect(earnings[0].fee).toBe(100)
    expect(unallocatedFees).toEqual([])
  })

  it('drops reversed earnings and their reversals', () => {
    const txs = [
      tx({ txId: '1', date: '2020-03-01', type: 'bonus', amount: 50, contractId: 'c', reversed: true }),
      tx({ txId: '2', date: '2020-03-04', type: 'bonus', amount: -50, contractId: 'c', description: 'Reversed Bonus ref 1 - (c) Client - Bonus' }),
      tx({ txId: '3', date: '2020-03-01', type: 'bonus', amount: 425, contractId: 'c' }),
      tx({ txId: '4', date: '2020-04-01', type: 'bonus', amount: -425, contractId: 'c', description: 'Reversed Bonus ref 3 - (c) Client - Bonus' }),
      tx({ txId: '5', date: '2020-03-01', type: 'bonus', amount: 10, contractId: 'c' }),
    ]
    expect(linkFees(txs).earnings.map((e) => e.tx.txId)).toEqual(['5'])
  })

  it('reads a blended fee: base is the sum of the tiers, percent the blended rate', () => {
    const t = parseTransaction({
      recordId: '1',
      accountingSubtype: 'Service Fee',
      description: 'Service Fee\nContract ID: 31962279\nContract title: x\nClient: Click IT\nAmount: \n$43.33 USD x 20% = $8.67 USD\n$356.67 USD x 10% = $35.67 USD\n$0.00 USD x 5% = $0.00 USD\nTotal blended service fee: $44.34 USD\nNotes: n',
      transactionAmount: { currency: 'USD', rawValue: '-44.34' },
      transactionCreationDate: '2022-05-01T00:00:00+0000',
    })
    expect(t).toMatchObject({ type: 'fee', feeBase: 400, feePercent: 11.09, termId: '31962279' })
  })
})

describe('payouts', () => {
  const ledger = [
    tx({ txId: 'e1', date: '2026-10-04', type: 'hourly', amount: 1000, contractId: 'c', periodFrom: '2026-09-28', periodTo: '2026-10-04' }),
    tx({ txId: 'f1', date: '2026-10-04', type: 'fee', amount: -100, contractId: 'c', feeBase: 1000 }),
    tx({ txId: 'e2', date: '2026-10-11', type: 'hourly', amount: 2000, contractId: 'c', periodFrom: '2026-10-05', periodTo: '2026-10-11' }),
    tx({ txId: 'f2', date: '2026-10-11', type: 'fee', amount: -200, contractId: 'c', feeBase: 2000 }),
    tx({ txId: 'e3', date: '2026-10-18', type: 'hourly', amount: 500, contractId: 'c', periodFrom: '2026-10-12', periodTo: '2026-10-18' }),
    tx({ txId: 'f3', date: '2026-10-18', type: 'fee', amount: -50, contractId: 'c', feeBase: 500 }),
    tx({ txId: 'w1', date: '2026-10-09', type: 'withdrawal', amount: 899.01, eurAmount: 810 }),
    tx({ txId: 'wf1', date: '2026-10-09', type: 'withdrawalFee', amount: -0.99 }),
    tx({ txId: 'w2', date: '2026-10-16', type: 'withdrawal', amount: 1499.01, eurAmount: 1290 }),
    tx({ txId: 'wf2', date: '2026-10-16', type: 'withdrawalFee', amount: -0.99 }),
    tx({ txId: 'adj', date: '2026-10-20', type: 'other', amount: -50, description: 'Adjustment to Payout Transaction w2 due to the the utilization of an inaccurate Foreign Exchange rate' }),
  ]

  it('pairs withdrawals with their fee and adjustments and prices them in EUR per USD', () => {
    const payouts = payoutsOf(ledger)
    expect(payouts.map((p) => [p.tx.txId, p.usd, p.fee, p.adjustments, p.rate])).toEqual([
      ['w1', 900, 0.99, 0, 0.9],
      ['w2', 1550, 0.99, 50, 0.832258],
    ])
  })

  it('pays the oldest earnings first and never earnings booked after the payout', () => {
    const { earnings } = linkFees(ledger)
    const payouts = payoutsOf(ledger)
    allocatePayouts(earnings, payouts)
    expect(earnings[0].payouts).toEqual([{ payoutId: 'w1', amount: 900 }])
    // e2 (net 1800) is paid by w2 (1550) only; its remaining 250 and e3 wait for the next payout.
    expect(earnings[1].payouts).toEqual([{ payoutId: 'w2', amount: 1550 }])
    expect(earnings[2].payouts).toEqual([])
    expect(payouts.map((p) => [p.covered, p.from, p.to])).toEqual([
      [900, '2026-10-04', '2026-10-04'],
      [1550, '2026-10-11', '2026-10-11'],
    ])
  })

  it('settles an entry: actual when fee and rate are known, estimated otherwise', () => {
    const { earnings } = linkFees(ledger)
    const payouts = payoutsOf(ledger)
    allocatePayouts(earnings, payouts)
    const byId = new Map(payouts.map((p) => [p.tx.txId, p]))
    const entry = (date: string, amount: number): TimeEntry =>
      ({ id: 1, date, startTime: '00:00', endTime: '01:00', durationMin: 60, clientId: 1, hourlyRate: amount, amount, comments: '', isBilled: true, source: 'upwork', createdAt: '', updatedAt: '' }) as TimeEntry
    const estimate = (d: string) => (d === '2026-10-14' ? 0.85 : undefined)
    // Day in the first week: 40 % of the invoice; fully paid by w1 at 0.9.
    expect(settleEntry(entry('2026-10-01', 400), earnings[0], byId, 10, estimate)).toEqual({ feeAmount: 40, netAmount: 360, fxRate: 0.9, netAmountEur: 324, settlement: 'actual', payoutId: 'w1' })
    // Second week: fee actual, but the invoice is only partly paid, so the rate is an estimate.
    expect(settleEntry(entry('2026-10-14', 200), earnings[2], byId, 10, estimate)).toEqual({ feeAmount: 20, netAmount: 180, fxRate: 0.85, netAmountEur: 153, settlement: 'estimated', payoutId: undefined })
    // No invoice yet: fee from the schedule, no rate known at all.
    expect(settleEntry(entry('2026-10-20', 100), undefined, byId, 20, () => undefined)).toEqual({ feeAmount: 20, netAmount: 80, fxRate: undefined, netAmountEur: undefined, settlement: 'estimated', payoutId: undefined })
    // Unpaid hours carry no money and are never "estimated".
    expect(settleEntry(entry('2026-10-20', 0), undefined, byId, 10, () => undefined)).toMatchObject({ feeAmount: 0, netAmount: 0, netAmountEur: 0, settlement: 'actual' })
  })

  it('averages the rate when an invoice spans two payouts', () => {
    const txs = [
      tx({ txId: 'e', date: '2026-10-04', type: 'hourly', amount: 1000, contractId: 'c', periodFrom: '2026-09-28', periodTo: '2026-10-04' }),
      tx({ txId: 'w1', date: '2026-10-05', type: 'withdrawal', amount: 600, eurAmount: 540 }),
      tx({ txId: 'w2', date: '2026-10-12', type: 'withdrawal', amount: 400, eurAmount: 320 }),
    ]
    const { earnings } = linkFees(txs)
    const payouts = payoutsOf(txs)
    allocatePayouts(earnings, payouts)
    const byId = new Map(payouts.map((p) => [p.tx.txId, p]))
    const entry = { id: 1, date: '2026-10-01', amount: 100 } as TimeEntry
    // 60 % at 0.9 and 40 % at 0.8 → 0.86; the payout that covered most is recorded.
    expect(settleEntry(entry, earnings[0], byId, 10, () => undefined)).toMatchObject({ feeAmount: 0, netAmount: 100, fxRate: 0.86, netAmountEur: 86, settlement: 'actual', payoutId: 'w1' })
  })

  it('estimates from the cached ECB rate of the day, the fixing before it, or the latest payout rate', () => {
    const payouts = payoutsOf([tx({ txId: 'w', date: '2026-10-09', type: 'withdrawal', amount: 1000, eurAmount: 850 })])
    const estimate = rateEstimator({ '2026-10-02': 0.9, '2026-10-30': 0.95 }, payouts)
    expect(estimate('2026-10-02')).toBe(0.9)
    expect(estimate('2026-10-04')).toBe(0.9) // Saturday: Friday's fixing
    expect(estimate('2026-10-20')).toBe(0.85) // too far from any fixing: payout rate
    expect(rateEstimator(undefined, [])('2026-10-20')).toBeUndefined()
  })
})

describe('recalculation', () => {
  const file: UpworkImportFile = {
    app: 'time-tracking-upwork',
    version: 1,
    contracts: [{ id: '36599829', title: 'RPA Developer', clientOrganization: { id: '4', name: 'Northwind Supply' } }],
    time: [
      { cursor: '202610121446010756', contract: { id: '36599829' }, dateWorkedOn: '2026-10-12', weekWorkedOn: '2026-10-12', totalHoursWorked: 5, totalCharges: 400, memo: 'a', termId: '42838462' },
      { cursor: '202610131446010756', contract: { id: '36599829' }, dateWorkedOn: '2026-10-13', weekWorkedOn: '2026-10-12', totalHoursWorked: 7.5, totalCharges: 600, memo: 'a', termId: '42838462' },
      { cursor: '202610201446010756', contract: { id: '36599829' }, dateWorkedOn: '2026-10-20', weekWorkedOn: '2026-10-19', totalHoursWorked: 2, totalCharges: 160, memo: 'a', termId: '42838462' },
    ],
    transactions: [
      { recordId: '1', accountingSubtype: 'Hourly', description: '(36599829) Northwind Supply - 12:30 hrs @ $80.00/hr - 10/12/2026 - 10/18/2026', transactionAmount: { currency: 'USD', rawValue: '1000.00' }, transactionCreationDate: '2026-10-18T00:00:00+0000' },
      { recordId: '2', accountingSubtype: 'Service Fee', description: 'Service Fee\nContract ID: 42838462\nContract title: RPA Developer\nClient: Northwind Supply\nAmount: \n$1000.00 USD x 10% = $100.00 USD\nNotes: n', transactionAmount: { currency: 'USD', rawValue: '-100.00' }, transactionCreationDate: '2026-10-18T00:00:00+0000' },
      { recordId: '3', accountingSubtype: 'Withdrawal', description: 'Withdrawal - Direct to Local Bank Transfer: xxxx-9485', transactionAmount: { currency: 'USD', rawValue: '899.01' }, transactionCreationDate: '2026-10-23T00:00:00+0000' },
      { recordId: '4', accountingSubtype: 'Withdrawal Fee', description: 'Withdrawal Fee - Direct to Local Bank', transactionAmount: { currency: 'USD', rawValue: '-0.99' }, transactionCreationDate: '2026-10-23T00:00:00+0000' },
    ],
  }

  it('rewrites only the settlement columns, and again when a payout gets its EUR amount', async () => {
    await updateSettings({ upwork: { feeSchedule: [{ from: '2016-01-01', percent: 20 }], fxRates: { '2026-10-20': 0.85 } } }, db)
    await importUpwork(file, db)
    const before = await db.entries.orderBy('date').toArray()
    expect(before.map((e) => e.feeAmount)).toEqual([80, 120, 32]) // schedule estimate at import time
    const first = await recalculateUpwork(db)
    expect(first).toEqual({ entries: 3, updated: 3, estimated: 3, unallocatedFees: 0, unpaidNet: 0, payoutsWithoutEur: 1 })
    let entries = await db.entries.orderBy('date').toArray()
    // Week 1 has its fee row (10 %), the rate is unknown; week 2 has neither, the ECB cache gives the rate.
    expect(entries.map((e) => [e.feeAmount, e.netAmount, e.fxRate, e.netAmountEur, e.settlement])).toEqual([
      [40, 360, undefined, undefined, 'estimated'],
      [60, 540, undefined, undefined, 'estimated'],
      [32, 128, 0.85, 108.8, 'estimated'],
    ])
    expect(entries.map((e) => e.dirty)).toEqual([1, 1, 1])
    expect(entries[0].uid).toBe(before[0].uid)

    // Unchanged ledger: nothing is rewritten.
    expect((await recalculateUpwork(db)).updated).toBe(0)

    // The bank received 810 EUR for the payout: week 1 becomes actual at 0.9.
    await setPayoutEur('3', 810, '2026-10-24', db)
    const second = await recalculateUpwork(db)
    expect(second).toMatchObject({ updated: 2, estimated: 1, unpaidNet: 0, payoutsWithoutEur: 0 })
    entries = await db.entries.orderBy('date').toArray()
    expect(entries.map((e) => [e.fxRate, e.netAmountEur, e.settlement, e.payoutId])).toEqual([
      [0.9, 324, 'actual', '3'],
      [0.9, 486, 'actual', '3'],
      [0.85, 108.8, 'estimated', undefined],
    ])
    expect((await db.upworkTransactions.where('txId').equals('3').first())!).toMatchObject({ eurAmount: 810, eurDate: '2026-10-24', dirty: 1 })
  })

  it('settle() reports fees that matched no invoice', () => {
    const txs = [tx({ txId: 'f', date: '2026-10-18', type: 'fee', amount: -10, contractId: 'c', feeBase: 100 })]
    const r = settle({ entries: [], transactions: txs, projects: [], estimate: () => undefined })
    expect(r.unallocatedFees.map((f) => f.amount)).toEqual([10])
    expect(r.unpaidNet).toBe(0)
  })
})

describe('ECB rates', () => {
  it('fills weekends and holidays with the fixing before them', () => {
    expect(fillGaps({ '2026-10-02': 0.9, '2026-10-06': 0.91 }, '2026-10-03', '2026-10-07')).toEqual({
      '2026-10-02': 0.9,
      '2026-10-03': 0.9,
      '2026-10-04': 0.9,
      '2026-10-05': 0.9,
      '2026-10-06': 0.91,
      '2026-10-07': 0.91,
    })
  })

  it('caches only the missing days and survives a failed fetch', async () => {
    await updateSettings({ upwork: { fxRates: { '2026-10-01': 0.88 } } }, db)
    const calls: [string, string][] = []
    const fetcher = async (from: string, to: string) => {
      calls.push([from, to])
      return { '2026-10-02': 0.9, '2026-10-06': 0.91 }
    }
    const r = await ensureFxRates(['2026-10-01', '2026-10-04', '2026-10-06'], db, fetcher)
    expect(r).toEqual({ fetched: 2 })
    expect(calls).toEqual([['2026-09-27', '2026-10-06']])
    expect((await db.settings.get('app'))!.upwork!.fxRates).toEqual({ '2026-10-01': 0.88, '2026-10-04': 0.9, '2026-10-06': 0.91 })
    const failed = await ensureFxRates(['2026-11-01'], db, async () => {
      throw new Error('offline')
    })
    expect(failed).toEqual({ fetched: 0, error: 'offline' })
  })
})
