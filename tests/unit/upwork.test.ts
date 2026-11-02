import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { classifyTransaction, feePercentFor, importUpwork, mergeUpworkFiles, parseTransaction, timeRowKey, upworkClientName, type UpworkImportFile } from '../../src/lib/upwork/import'

let db: TimeTrackingDB
let n = 0
beforeEach(() => {
  db = new TimeTrackingDB(`upwork-${++n}`)
})

const file: UpworkImportFile = {
  app: 'time-tracking-upwork',
  version: 1,
  contracts: [
    { id: '36599829', title: 'RPA Developer', status: 'ACTIVE', clientOrganization: { id: '425281712378155008', name: 'Northwind Supply' } },
    { id: '19144597', title: 'Old job', status: 'CLOSED', clientOrganization: { id: '916328897771520000', name: 'DELETED' } },
  ],
  time: [
    { cursor: '202610121446010756', contract: { id: '36599829', title: 'RPA Developer' }, dateWorkedOn: '2026-10-12', weekWorkedOn: '2026-10-12', totalHoursWorked: 6.5, totalCharges: 520, memo: 'RDEV-46', termId: '42838462' },
    { cursor: '202610141446010756', contract: { id: '36599829', title: 'RPA Developer' }, dateWorkedOn: '2026-10-14', weekWorkedOn: '2026-10-12', totalHoursWorked: 1.5, totalCharges: 120, memo: 'RDEV-46', termId: '42838462' },
    { cursor: '202610140211637669', contract: { id: '36599829', title: 'RPA Developer' }, dateWorkedOn: '2026-10-14', weekWorkedOn: '2026-10-12', totalHoursWorked: 5.166666666666667, totalCharges: 413.333333, memo: '', termId: '42838462' },
    { cursor: '202610140411808151', contract: { id: '33492237', title: 'Automation of Processes' }, dateWorkedOn: '2026-10-14', weekWorkedOn: '2026-10-12', totalHoursWorked: 0.16666666666666666, totalCharges: 15, memo: '', termId: '34739385' },
    // Unpaid hours: a contract that reports time but charges nothing.
    { cursor: '202610150000000001', contract: { id: '19450271', title: 'Free help' }, dateWorkedOn: '2026-10-15', weekWorkedOn: '2026-10-12', totalHoursWorked: 2, totalCharges: 0, memo: 'Favour', termId: '19450271' },
  ],
  transactions: [
    { recordId: '960041226', accountingSubtype: 'Hourly', type: 'APInvoice', description: '(36599829) Northwind Supply - 37:10 hrs @ $80.00/hr - 10/12/2026 - 10/18/2026', transactionAmount: { currency: 'USD', rawValue: '2973.33' }, transactionCreationDate: '2026-10-18T00:00:00+0000', assignmentCompanyName: 'Northwind Supply' },
    { recordId: '960041233', accountingSubtype: 'Service Fee', type: 'APAdjustment', description: 'Service Fee\nContract ID: 42838462\nContract title: RPA Developer\nClient: Northwind Supply\nAmount: \n$2973.33 USD x 10% = $297.33 USD\nNotes: Invoice from Upwork for T960041135', transactionAmount: { currency: 'USD', rawValue: '-297.33' }, transactionCreationDate: '2026-10-18T00:00:00+0000', assignmentCompanyName: 'Northwind Supply' },
    { recordId: '961135619', accountingSubtype: 'Withdrawal', type: 'APPayment', description: 'Withdrawal - Direct to Local Bank Transfer: xxxx-9485', transactionAmount: { currency: 'USD', rawValue: '2688.51' }, transactionCreationDate: '2026-10-23T00:00:00+0000' },
    { recordId: '961135620', accountingSubtype: 'Withdrawal Fee', type: 'APAdjustment', description: 'Withdrawal Fee - Direct to Local Bank', transactionAmount: { currency: 'USD', rawValue: '-0.99' }, transactionCreationDate: '2026-10-23T00:00:00+0000' },
    { recordId: '952591265', accountingSubtype: 'Membership Fee', type: 'ARInvoice', description: 'Subscription Renewal Charges', transactionAmount: { currency: 'USD', rawValue: '19.99' }, transactionCreationDate: '2026-09-20T00:00:00+0000' },
  ],
}

describe('Upwork transactions', () => {
  it('classifies subtypes and parses the facts in the descriptions', () => {
    expect(classifyTransaction('Hourly')).toBe('hourly')
    expect(classifyTransaction('Fixed Price')).toBe('fixed')
    expect(classifyTransaction('Something Fee')).toBe('fee')
    expect(classifyTransaction('Expense')).toBe('bonus')
    expect(classifyTransaction(undefined)).toBe('other')
    const hourly = parseTransaction(file.transactions![0])
    expect(hourly).toMatchObject({ txId: '960041226', date: '2026-10-18', type: 'hourly', amount: 2973.33, currency: 'USD', contractId: '36599829', hours: 37 + 10 / 60, rate: 80, periodFrom: '2026-10-12', periodTo: '2026-10-18', clientName: 'Northwind Supply' })
    const fee = parseTransaction(file.transactions![1])
    expect(fee).toMatchObject({ type: 'fee', amount: -297.33, termId: '42838462', feeBase: 2973.33, feePercent: 10, clientName: 'Northwind Supply' })
    expect(fee.contractId).toBeUndefined()
    expect(parseTransaction(file.transactions![2])).toMatchObject({ type: 'withdrawal', amount: 2688.51 })
    expect(parseTransaction(file.transactions![3])).toMatchObject({ type: 'withdrawalFee', amount: -0.99 })
    expect(parseTransaction(file.transactions![4])).toMatchObject({ type: 'membership', amount: 19.99 })
    // Fixed-price work appears as "Fixed Price" invoices or "Milestone" adjustments; reversed rows are flagged.
    expect(classifyTransaction('Milestone')).toBe('fixed')
    const reversed = parseTransaction({ recordId: '293952361', accountingSubtype: 'Bonus', type: 'APAdjustment', description: '(23962678) Some Client - Bonus', transactionAmount: { currency: 'USD', rawValue: '425.00' }, transactionCreationDate: '2020-04-01T00:00:00+0000', paymentStatus: 'REVERSED' })
    expect(reversed).toMatchObject({ type: 'bonus', contractId: '23962678', reversed: true })
    const tenPointZero = parseTransaction({ recordId: '1', accountingSubtype: 'Service Fee', type: 'APAdjustment', description: 'Service Fee\nContract ID: 24883962\nContract title: x\nClient: y\nAmount: $100.00 USD x 10.0% = $10.00 USD\nNotes: n', transactionAmount: { currency: 'USD', rawValue: '-10.00' }, transactionCreationDate: '2020-08-19T00:00:00+0000' })
    expect(tenPointZero).toMatchObject({ type: 'fee', termId: '24883962', feeBase: 100, feePercent: 10 })
    const fivePercent = parseTransaction({ recordId: '2', accountingSubtype: 'Service Fee', type: 'APAdjustment', description: 'Service Fee\nContract ID: 21331187\nContract title: x\nClient: Rekvisitt AS\nAmount: $433.33 USD x 5% = $21.67 USD\nNotes: n', transactionAmount: { currency: 'USD', rawValue: '-21.67' }, transactionCreationDate: '2020-10-18T00:00:00+0000' })
    expect(fivePercent).toMatchObject({ feeBase: 433.33, feePercent: 5, clientName: 'Rekvisitt AS' })
  })

  it('estimates the fee from the schedule, defaulting to 10 %', () => {
    expect(feePercentFor('2026-01-01')).toBe(10)
    expect(feePercentFor('2020-01-01', [{ from: '2016-05-03', percent: 20 }, { from: '2023-05-03', percent: 10 }])).toBe(20)
    expect(feePercentFor('2024-01-01', [{ from: '2016-05-03', percent: 20 }, { from: '2023-05-03', percent: 10 }])).toBe(10)
  })

  it('keys time rows by contract, day and memo id', () => {
    expect(timeRowKey(file.time![0])).toBe('36599829:2026-10-12:1446010756')
    expect(timeRowKey({ contract: { id: '1' }, dateWorkedOn: '2026-01-02', totalHoursWorked: 1, totalCharges: 10, memo: ' Skype ' })).toBe('1:2026-01-02:Skype')
    expect(timeRowKey({ contract: { id: '1' }, dateWorkedOn: '2026-01-02', totalHoursWorked: 1, totalCharges: 10 })).toBe('1:2026-01-02:-')
  })

  it('names anonymous client organisations by id', () => {
    expect(upworkClientName({ id: '916328897771520000', name: 'DELETED' }, '19144597')).toBe('Upwork client 520000')
    expect(upworkClientName({ id: '1', name: 'Private' }, '7')).toBe('Upwork client 1')
    expect(upworkClientName({ id: '1', name: ' Northwind ' }, '7')).toBe('Northwind')
    expect(upworkClientName(undefined, '33492237')).toBe('Upwork contract 33492237')
  })
})

describe('Upwork import', () => {
  it('creates clients and projects, daily timeless entries and raw transactions, idempotently', async () => {
    const first = await importUpwork(file, db)
    expect(first.clients).toEqual({ created: 4, matched: 0 })
    expect(first.projects).toEqual({ created: 4, matched: 0 })
    expect(first.entries).toEqual({ added: 5, updated: 0, unchanged: 0, removed: 0 })
    expect(first.transactions).toEqual({ added: 5, updated: 0, unchanged: 0 })

    const clients = await db.clients.toArray()
    expect(clients.map((c) => c.name).sort()).toEqual(['Northwind Supply', 'Upwork client 520000', 'Upwork contract 19450271', 'Upwork contract 33492237'])
    expect(clients.find((c) => c.name === 'Northwind Supply')).toMatchObject({ platform: 'upwork', upworkClientId: '425281712378155008', currency: 'USD' })
    const projects = await db.projects.toArray()
    expect(projects.find((p) => p.upwork?.contractId === '36599829')).toMatchObject({ name: 'RPA Developer', upwork: { contractId: '36599829', type: 'hourly' } })

    const entries = (await db.entries.toArray()).sort((a, b) => a.externalId!.localeCompare(b.externalId!))
    expect(entries.map((e) => e.externalId)).toEqual([
      'upwork:19450271:2026-10-15:0000000001',
      'upwork:33492237:2026-10-14:0411808151',
      'upwork:36599829:2026-10-12:1446010756',
      'upwork:36599829:2026-10-14:0211637669',
      'upwork:36599829:2026-10-14:1446010756',
    ])
    const first12 = entries[2]
    expect(first12).toMatchObject({
      date: '2026-10-12',
      startTime: '00:00',
      endTime: '06:30',
      durationMin: 390,
      hourlyRate: 80,
      amount: 520,
      currency: 'USD',
      feeAmount: 52,
      netAmount: 468,
      settlement: 'estimated',
      comments: 'RDEV-46',
      isBilled: true,
      invoiceDate: '2026-10-18',
      invoiceRef: 'Upwork week 2026-10-12',
      source: 'upwork',
      timeless: true,
    })
    expect(first12.billedMin).toBeUndefined()
    expect(first12.fxRate).toBeUndefined()
    // Two memos on the same day stay two entries.
    expect(entries[3]).toMatchObject({ durationMin: 310, amount: 413.33, hourlyRate: 80, comments: '' })
    expect(entries[4]).toMatchObject({ durationMin: 90, amount: 120, hourlyRate: 80, comments: 'RDEV-46' })
    expect(entries[1]).toMatchObject({ durationMin: 10, amount: 15, hourlyRate: 90 })
    // Unpaid hours are kept but never billed.
    expect(entries[0]).toMatchObject({ durationMin: 120, amount: 0, hourlyRate: 0, billable: false, feeAmount: 0, netAmount: 0 })

    const txs = await db.upworkTransactions.toArray()
    expect(txs).toHaveLength(5)
    // The fee row only knows the term id; the time rows map the term to the contract.
    expect(txs.find((t) => t.type === 'fee')).toMatchObject({ termId: '42838462', contractId: '36599829' })

    // Same file again: nothing changes.
    const second = await importUpwork(file, db)
    expect(second.clients).toEqual({ created: 0, matched: 0 })
    expect(second.projects).toEqual({ created: 0, matched: 4 })
    expect(second.entries).toEqual({ added: 0, updated: 0, unchanged: 5, removed: 0 })
    expect(second.transactions).toEqual({ added: 0, updated: 0, unchanged: 5 })

    // A corrected row (more hours) updates the entry in place and keeps its identity; other days are untouched.
    const corrected: UpworkImportFile = { ...file, time: [{ ...file.time![0], totalHoursWorked: 7, totalCharges: 560 }] }
    const third = await importUpwork(corrected, db)
    expect(third.entries).toEqual({ added: 0, updated: 1, unchanged: 0, removed: 0 })
    const updated = (await db.entries.where('externalId').equals('upwork:36599829:2026-10-12:1446010756').first())!
    expect(updated).toMatchObject({ id: first12.id, uid: first12.uid, durationMin: 420, amount: 560, feeAmount: 52 })

    // A memo edited on Upwork gets a new id: the old row disappears from the day, so its entry goes (with a tombstone).
    const renamed: UpworkImportFile = { ...file, time: [{ ...file.time![1], cursor: '202610149999999999', memo: 'RDEV-46 renamed' }, file.time![2]] }
    const fourth = await importUpwork(renamed, db)
    expect(fourth.entries).toEqual({ added: 1, updated: 0, unchanged: 1, removed: 1 })
    const day14 = await db.entries.where('date').equals('2026-10-14').toArray()
    expect(day14.map((e) => e.externalId).sort()).toEqual(['upwork:33492237:2026-10-14:0411808151', 'upwork:36599829:2026-10-14:0211637669', 'upwork:36599829:2026-10-14:9999999999'])
    expect(await db.tombstones.count()).toBe(1)
    expect(await db.entries.count()).toBe(5)
  })

  it('matches an existing client by name and marks it as an Upwork client', async () => {
    await db.clients.add({ name: 'Northwind Supply', defaultRate: 60, currency: 'EUR' })
    const report = await importUpwork({ ...file, contracts: [file.contracts![0]], time: [file.time![0]], transactions: [] }, db)
    expect(report.clients).toEqual({ created: 0, matched: 1 })
    const c = (await db.clients.toArray())[0]
    expect(c).toMatchObject({ name: 'Northwind Supply', platform: 'upwork', upworkClientId: '425281712378155008', currency: 'EUR' })
    // The entry still carries USD: the client's currency is not what Upwork paid in.
    expect((await db.entries.toArray())[0].currency).toBe('USD')
  })

  it('merges several pulls by key', () => {
    const merged = mergeUpworkFiles([file, { app: 'time-tracking-upwork', version: 1, time: [{ ...file.time![0], totalHoursWorked: 8, totalCharges: 640 }], transactions: [file.transactions![0]] }])
    expect(merged.time).toHaveLength(5)
    expect(merged.time!.find((t) => t.dateWorkedOn === '2026-10-12')!.totalHoursWorked).toBe(8)
    expect(merged.transactions).toHaveLength(5)
    expect(merged.contracts).toHaveLength(2)
  })
})
