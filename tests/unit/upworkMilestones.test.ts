import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { recalculateUpwork } from '../../src/lib/upwork/allocate'
import { importUpwork, type UpworkImportFile } from '../../src/lib/upwork/import'
import { addMilestoneEntry, milestoneKey, milestonesWithoutHours, milestoneTitle, milestoneTxId, suggestedMilestoneHours } from '../../src/lib/upwork/milestones'

let n = 0
let db: TimeTrackingDB
beforeEach(() => {
  db = new TimeTrackingDB(`upwork-milestones-${++n}`)
})

const file: UpworkImportFile = {
  app: 'time-tracking-upwork',
  version: 1,
  contracts: [
    { id: '19503263', title: 'Power BI', clientOrganization: { id: '7', name: 'Lakeside Analytics' } },
    { id: '36599829', title: 'RPA Developer', clientOrganization: { id: '4', name: 'Northwind Supply' } },
  ],
  time: [{ cursor: '202610121446010756', contract: { id: '36599829' }, dateWorkedOn: '2026-10-12', weekWorkedOn: '2026-10-12', totalHoursWorked: 5, totalCharges: 400, memo: 'a', termId: '42838462' }],
  transactions: [
    { recordId: '1', accountingSubtype: 'Fixed Price', description: 'Invoice for Power BI: Milestone 30 - Formatting help', transactionAmount: { currency: 'USD', rawValue: '100.00' }, transactionCreationDate: '2026-10-26T00:00:00+0000', assignmentCompanyName: 'Lakeside Analytics' },
    { recordId: '2', accountingSubtype: 'Service Fee', description: 'Service Fee\nContract ID: 19503263\nContract title: Power BI\nClient: Lakeside Analytics\nAmount: \n$100.00 USD x 10% = $10.00 USD\nNotes: n', transactionAmount: { currency: 'USD', rawValue: '-10.00' }, transactionCreationDate: '2026-10-26T00:00:00+0000' },
    { recordId: '3', accountingSubtype: 'Bonus', description: '(36599829) Northwind Supply - Bonus', transactionAmount: { currency: 'USD', rawValue: '50.00' }, transactionCreationDate: '2026-10-20T00:00:00+0000', assignmentCompanyName: 'Northwind Supply' },
    { recordId: '4', accountingSubtype: 'Bonus', description: 'Reversed Bonus ref 3 - (36599829) Northwind Supply - Bonus', transactionAmount: { currency: 'USD', rawValue: '-50.00' }, transactionCreationDate: '2026-10-21T00:00:00+0000', paymentStatus: 'REVERSED' },
    { recordId: '7', accountingSubtype: 'Bonus', description: '(36599829) Northwind Supply - Bonus', transactionAmount: { currency: 'USD', rawValue: '50.00' }, transactionCreationDate: '2026-10-22T00:00:00+0000', assignmentCompanyName: 'Northwind Supply' },
    { recordId: '5', accountingSubtype: 'Withdrawal', description: 'Withdrawal - Direct to Local Bank Transfer: xxxx-9485', transactionAmount: { currency: 'USD', rawValue: '89.01' }, transactionCreationDate: '2026-10-28T00:00:00+0000' },
    { recordId: '6', accountingSubtype: 'Withdrawal Fee', description: 'Withdrawal Fee - Direct to Local Bank', transactionAmount: { currency: 'USD', rawValue: '-0.99' }, transactionCreationDate: '2026-10-28T00:00:00+0000' },
  ],
}

describe('milestones without hours', () => {
  it('names and keys them', () => {
    expect(milestoneTitle({ type: 'fixed', subtype: 'Fixed Price', description: 'Invoice for Power BI: Milestone 30 - Formatting help' })).toBe('Milestone 30 - Formatting help')
    expect(milestoneTitle({ type: 'bonus', subtype: 'Bonus', description: '(36599829) Northwind Supply - Bonus' })).toBe('Bonus')
    expect(milestoneTitle({ type: 'fixed', subtype: 'Fixed Price', description: 'Invoice for Dashboard' })).toBe('Dashboard')
    expect(milestoneTxId(milestoneKey('960041226'))).toBe('960041226')
    expect(milestoneTxId('upwork:36599829:2026-10-12:1446010756')).toBeUndefined()
  })

  it('suggests the hours from the amount at the client rate, else 60 USD/h; bonuses get none', () => {
    const fixed = { type: 'fixed' as const, amount: 150, date: '2026-10-26' }
    expect(suggestedMilestoneHours(fixed, undefined)).toEqual({ hours: 2.5, rate: 60, clientRate: false })
    expect(suggestedMilestoneHours(fixed, { defaultRate: 0 })).toEqual({ hours: 2.5, rate: 60, clientRate: false })
    expect(suggestedMilestoneHours(fixed, { defaultRate: 75 })).toEqual({ hours: 2, rate: 75, clientRate: true })
    expect(suggestedMilestoneHours(fixed, { defaultRate: 50, rates: [{ from: '2026-10-01', rate: 100 }] })).toEqual({ hours: 1.5, rate: 100, clientRate: true })
    expect(suggestedMilestoneHours({ type: 'bonus', amount: 150, date: '2026-10-26' }, { defaultRate: 75 })).toEqual({ hours: 0, rate: 0, clientRate: false })
  })

  it('lists fixed-price and bonus rows that have no entry, skipping the reversed bonus and its reversal', async () => {
    await importUpwork(file, db)
    const list = milestonesWithoutHours(await db.upworkTransactions.toArray(), await db.entries.toArray(), await db.projects.toArray())
    expect(list.map((m) => [m.tx.txId, m.title, m.project?.name])).toEqual([
      ['1', 'Milestone 30 - Formatting help', 'Power BI'],
      ['7', 'Bonus', 'RPA Developer'],
    ])
  })

  it('makes an entry of a milestone and settles it from its own invoice row', async () => {
    await importUpwork(file, db)
    const txs = await db.upworkTransactions.toArray()
    const projects = await db.projects.toArray()
    const [milestone, bonus] = milestonesWithoutHours(txs, await db.entries.toArray(), projects)

    const id = await addMilestoneEntry({ tx: milestone.tx, clientId: milestone.project!.clientId, projectId: milestone.project!.id, hours: 2.5 }, db)
    let entry = (await db.entries.get(id))!
    expect(entry).toMatchObject({ date: '2026-10-26', durationMin: 150, amount: 100, hourlyRate: 40, timeless: true, estimatedHours: true, source: 'upwork', externalId: 'upwork:milestone:1', comments: 'Milestone 30 - Formatting help', isBilled: false })

    // The fee row of the milestone is its fee; the payout of 90 USD covers it, so the rate is actual once the bank amount is known.
    const r = await recalculateUpwork(db)
    expect(r.unallocatedFees).toBe(0)
    entry = (await db.entries.get(id))!
    expect(entry).toMatchObject({ feeAmount: 10, netAmount: 90, isBilled: true, invoiceDate: '2026-10-26', invoiceRef: 'Upwork milestone', payoutId: undefined, settlement: 'estimated' })

    // A bonus with no hours keeps its money and gets no rate.
    const bonusId = await addMilestoneEntry({ tx: bonus.tx, clientId: bonus.project!.clientId, projectId: bonus.project!.id, hours: 0, date: '2026-10-19' }, db)
    await recalculateUpwork(db)
    expect((await db.entries.get(bonusId))!).toMatchObject({ date: '2026-10-19', durationMin: 0, amount: 50, hourlyRate: 0, invoiceRef: 'Upwork bonus', invoiceDate: '2026-10-22', isBilled: true, feeAmount: 0, netAmount: 50 })

    // Both are off the list now, and a later import of the same file leaves them alone.
    expect(milestonesWithoutHours(txs, await db.entries.toArray(), projects)).toEqual([])
    const again = await importUpwork(file, db)
    expect(again.entries.removed).toBe(0)
    expect(await db.entries.where('externalId').startsWith('upwork:milestone:').count()).toBe(2)
  })
})
