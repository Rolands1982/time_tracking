import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { addOtherIncome, adjustOtherIncome, countedAmount, countsNothing, defaultIncomeDate, deleteOtherIncome, incomeTotals, isFromFinanceApp, knownTypes, queryOtherIncome, typeResolver, updateOtherIncome } from '../../src/db/income'
import type { OtherIncome } from '../../src/db/types'
import type { SyncTable } from '../../src/db/types'
import { createBackup, restoreBackup } from '../../src/lib/backup'
import { SyncEngine } from '../../src/sync/engine'
import type { Remote, RemoteRow } from '../../src/sync/remote'

let db: TimeTrackingDB
let n = 0
beforeEach(() => {
  db = new TimeTrackingDB(`income-${++n}`)
})

describe('other income', () => {
  it('records income by hand and sums it by type', async () => {
    expect(defaultIncomeDate('2026-11-04')).toBe('2026-11-08')
    expect(defaultIncomeDate('2026-11-08')).toBe('2026-11-08')
    const id = await addOtherIncome({ date: '2026-11-08', type: 'Rent ', amount: 320, notes: ' November ' }, db)
    await addOtherIncome({ date: '2026-11-08', type: 'Investments', amount: 1.945, source: 'Mintos' }, db)
    await addOtherIncome({ date: '2026-10-31', amount: 60 }, db)
    const row = (await db.otherIncome.get(id))!
    expect(row).toMatchObject({ type: 'Rent', category: 'other', currency: 'EUR', notes: 'November', dirty: 1 })
    expect(row.uid).toMatch(/^[0-9a-f-]{36}$/)

    const november = await queryOtherIncome({ from: '2026-11-01', to: '2026-11-30' }, db)
    expect(november.map((r) => r.amount)).toEqual([1.95, 320])
    expect(incomeTotals(november)).toEqual({
      count: 2,
      total: 321.95,
      excluded: 0,
      zero: 0,
      byType: [
        { type: 'Rent', amount: 320, count: 1 },
        { type: 'Investments', amount: 1.95, count: 1 },
      ],
    })
    expect(incomeTotals(await queryOtherIncome({}, db)).byType.map((b) => b.type)).toEqual(['Rent', 'Other', 'Investments'])

    await updateOtherIncome(id, { date: '2026-11-08', type: 'Rent', amount: 330, notes: '' }, db)
    expect((await db.otherIncome.get(id))!.amount).toBe(330)
    await deleteOtherIncome(id, db)
    expect(await db.otherIncome.count()).toBe(2)
    expect(await db.tombstones.toArray()).toMatchObject([{ table: 'otherIncome', uid: row.uid }])
  })

  it('files finance-app rows under the owner\'s types and lets the owner adjust and exclude them', async () => {
    const pf = (id: number, extra: Partial<OtherIncome>): OtherIncome => ({
      date: '2026-10-05', category: 'rent', amount: 320, currency: 'EUR', notes: '', sourceCategory: 'Īres maksa', importKey: `pf:${id}`, createdAt: '', updatedAt: '', ...extra,
    })
    await db.otherIncome.bulkAdd([
      pf(1, { type: 'Īre' }),
      pf(2, { type: 'Īre', date: '2026-09-05' }),
      pf(3, { date: '2026-11-05' }), // arrived from the daily sync, no type yet
      pf(4, { category: 'other', sourceCategory: 'Citi ienākumi', amount: 13000, type: 'Apdrošināšana', excluded: true }),
      pf(5, { category: 'sale', sourceCategory: 'Citi ienākumi', amount: 25 }),
      pf(6, { category: 'other', sourceCategory: 'Citi ienākumi', amount: 50, type: 'Dāvanas' }),
    ])
    const all = await db.otherIncome.toArray()
    const typeOf = typeResolver(all)
    const byKey = (k: string) => all.find((r) => r.importKey === k)!
    expect(typeOf(byKey('pf:3'))).toBe('Īre') // learned from the earlier rent rows
    expect(typeOf(byKey('pf:5'))).toBe('Dāvanas') // same finance-app category, other kind: the category's most used type; the excluded payout does not teach
    expect(knownTypes(all, typeOf)).toEqual(['Apdrošināšana', 'Dāvanas', 'Īre'])

    const t = incomeTotals(all, typeOf)
    expect(t).toMatchObject({ count: 5, excluded: 1, total: 1035 })
    expect(t.byType).toEqual([
      { type: 'Īre', amount: 960, count: 3 },
      { type: 'Dāvanas', amount: 75, count: 2 },
    ])

    // The owner counts 300 of the rent payment and files the sale; the excluded payout comes back in.
    const rent = byKey('pf:3')
    await adjustOtherIncome(rent.id!, { type: 'Īre', amountOverride: 300 }, db)
    await adjustOtherIncome(byKey('pf:5').id!, { type: 'Pārdošana' }, db)
    await adjustOtherIncome(byKey('pf:4').id!, { type: 'Apdrošināšana', excluded: false }, db)
    const after = (await db.otherIncome.get(rent.id!))!
    expect(after).toMatchObject({ type: 'Īre', amountOverride: 300, amount: 320, dirty: 1, date: '2026-11-05' })
    expect(countedAmount(after)).toBe(300)
    expect((await db.otherIncome.get(byKey('pf:4').id!))!.excluded).toBeUndefined()

    // A line adjusted to 0 counts nothing: hidden by default, not in the row count or the type totals.
    await adjustOtherIncome(byKey('pf:6').id!, { type: 'Dāvanas', amountOverride: 0 }, db)
    const zeroed = (await db.otherIncome.get(byKey('pf:6').id!))!
    expect(countsNothing(zeroed)).toBe(true)
    expect(countsNothing({ amount: 10, excluded: true })).toBe(true)
    expect(countsNothing({ amount: 10 })).toBe(false)
    const now = incomeTotals(await db.otherIncome.toArray(), typeOf)
    expect(now).toMatchObject({ zero: 1, excluded: 0 })
    expect(now.byType.find((b) => b.type === 'Dāvanas')).toBeUndefined()

    // Clearing the adjustment (empty type, the booked amount again) returns to the defaults.
    await adjustOtherIncome(rent.id!, { type: '', amountOverride: 320 }, db)
    expect((await db.otherIncome.get(rent.id!))!).toMatchObject({ type: undefined, amountOverride: undefined })
  })

  it('syncs income rows, their deletions and the backup', async () => {
    const tables: Record<SyncTable, Map<string, RemoteRow>> = { clients: new Map(), projects: new Map(), entries: new Map(), upworkTransactions: new Map(), otherIncome: new Map() }
    let clock = 0
    const stamp = () => new Date(Date.UTC(2030, 0, 1, 0, 0, ++clock)).toISOString()
    const remote: Remote = {
      async upsert(table, rows) {
        for (const r of rows) tables[table].set(String(r.id), { ...tables[table].get(String(r.id)), ...r, synced_at: stamp() } as RemoteRow)
      },
      async markDeleted(table, ids) {
        for (const id of ids) tables[table].set(id, { ...tables[table].get(id)!, deleted_at: stamp(), synced_at: stamp() })
      },
      async pullSince(table, cursor) {
        return [...tables[table].values()].filter((r) => !cursor || r.synced_at > cursor).sort((a, b) => a.synced_at.localeCompare(b.synced_at))
      },
    }
    const other = new TimeTrackingDB(`income-b-${n}`)
    const id = await addOtherIncome({ date: '2026-11-08', type: 'Pabalsti', amount: 816, notes: 'VSAA' }, db)
    const a = new SyncEngine(remote, db)
    expect(await a.pendingCount()).toBe(1)
    expect((await a.run()).pushed).toBe(1)
    expect([...tables.otherIncome.values()][0]).toMatchObject({ date: '2026-11-08', category: 'other', type: 'Pabalsti', amount: 816, currency: 'EUR', notes: 'VSAA', source_category: null, import_key: null, amount_override: null, excluded: null })

    const b = new SyncEngine(remote, other)
    expect((await b.run()).pulled).toBe(1)
    expect(await other.otherIncome.toArray()).toMatchObject([{ date: '2026-11-08', type: 'Pabalsti', amount: 816, dirty: 0 }])

    // A row the personal finances app wrote straight into the cloud reaches the devices like any other.
    const pf = { id: '00000000-0000-4000-8000-000000000001', date: '2026-11-03', category: 'investment', amount: 12.5, currency: 'EUR', source: 'Broker', notes: 'Dividend',
      source_category: 'Dividendes', import_key: 'pf:4711', type: 'Investīcijas', amount_override: 10, excluded: null, created_at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T08:00:00Z', deleted_at: null }
    tables.otherIncome.set(pf.id, { ...pf, synced_at: stamp() } as RemoteRow)
    await b.run()
    const pulled = (await other.otherIncome.where('importKey').equals('pf:4711').first())!
    expect(pulled).toMatchObject({ category: 'investment', amount: 12.5, source: 'Broker', notes: 'Dividend', sourceCategory: 'Dividendes', type: 'Investīcijas', amountOverride: 10, dirty: 0 })
    expect(pulled.excluded).toBeUndefined()
    expect(isFromFinanceApp(pulled)).toBe(true)
    expect(isFromFinanceApp((await other.otherIncome.toArray()).find((o) => !o.importKey)!)).toBe(false)
    expect((await other.otherIncome.toArray()).map((o) => o.amount).sort()).toEqual([12.5, 816])

    const backup = await createBackup(other)
    expect(backup.otherIncome).toHaveLength(2)

    await deleteOtherIncome(id, db)
    expect((await a.run()).deleted).toBe(1)
    await b.run()
    expect(await other.otherIncome.count()).toBe(1)

    await restoreBackup(backup, other)
    expect(await other.otherIncome.count()).toBe(2)
    expect((await other.otherIncome.toArray())[0].dirty).toBe(1)
  })
})

describe('upgrade to schema v5', () => {
  it('pulls the income table again once, keeping the other cursors', async () => {
    const { default: Dexie } = await import('dexie')
    const name = `income-upgrade-${n}`
    // A device on the previous version: income rows pulled without the new columns, cursors past them.
    const old = new Dexie(name)
    old.version(4).stores({
      entries: '++id, &uid, dirty, date, clientId, projectId, isBilled, invoiceDate, importKey, externalId, source, [clientId+isBilled]',
      clients: '++id, &uid, dirty, &name',
      projects: '++id, &uid, dirty, clientId, [clientId+name]',
      settings: 'id',
      tombstones: '++id, table, uid',
      upworkTransactions: '++id, &uid, dirty, &txId, date, type, contractId',
      otherIncome: '++id, &uid, dirty, date, category, importKey',
    })
    await old.table('settings').put({ id: 'app', defaultCurrency: 'EUR', sync: { cursors: { entries: '2030-01-01T00:00:01Z', otherIncome: '2030-01-01T00:00:02Z' } } })
    old.close()

    const upgraded = new TimeTrackingDB(name)
    const settings = (await upgraded.settings.get('app'))!
    expect(settings.sync?.cursors).toEqual({ entries: '2030-01-01T00:00:01Z' })
    upgraded.close()
  })
})
