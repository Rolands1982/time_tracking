import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { addOtherIncome, defaultIncomeDate, deleteOtherIncome, incomeTotals, isFromFinanceApp, queryOtherIncome, updateOtherIncome } from '../../src/db/income'
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
  it('records income as of the end of the week and sums it by kind', async () => {
    expect(defaultIncomeDate('2026-11-04')).toBe('2026-11-08')
    expect(defaultIncomeDate('2026-11-08')).toBe('2026-11-08')
    const id = await addOtherIncome({ date: '2026-11-08', category: 'rent', amount: 320, notes: ' November ' }, db)
    await addOtherIncome({ date: '2026-11-08', category: 'investment', amount: 1.945, source: 'Mintos' }, db)
    await addOtherIncome({ date: '2026-10-31', category: 'other', amount: 60 }, db)
    const row = (await db.otherIncome.get(id))!
    expect(row).toMatchObject({ currency: 'EUR', notes: 'November', dirty: 1 })
    expect(row.uid).toMatch(/^[0-9a-f-]{36}$/)

    const november = await queryOtherIncome({ from: '2026-11-01', to: '2026-11-30' }, db)
    expect(november.map((r) => r.amount)).toEqual([1.95, 320])
    expect(incomeTotals(november)).toEqual({ count: 2, total: 321.95, byCategory: { rent: 320, investment: 1.95, sale: 0, benefit: 0, other: 0 } })
    expect(incomeTotals(await queryOtherIncome({}, db)).total).toBe(381.95)

    await updateOtherIncome(id, { date: '2026-11-08', category: 'rent', amount: 330, notes: '' }, db)
    expect((await db.otherIncome.get(id))!.amount).toBe(330)
    await deleteOtherIncome(id, db)
    expect(await db.otherIncome.count()).toBe(2)
    expect(await db.tombstones.toArray()).toMatchObject([{ table: 'otherIncome', uid: row.uid }])
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
    const id = await addOtherIncome({ date: '2026-11-08', category: 'benefit', amount: 816, notes: 'VSAA' }, db)
    const a = new SyncEngine(remote, db)
    expect(await a.pendingCount()).toBe(1)
    expect((await a.run()).pushed).toBe(1)
    expect([...tables.otherIncome.values()][0]).toMatchObject({ date: '2026-11-08', category: 'benefit', amount: 816, currency: 'EUR', notes: 'VSAA', source_category: null, import_key: null })

    const b = new SyncEngine(remote, other)
    expect((await b.run()).pulled).toBe(1)
    expect(await other.otherIncome.toArray()).toMatchObject([{ date: '2026-11-08', category: 'benefit', amount: 816, dirty: 0 }])

    // A row the personal finances app wrote straight into the cloud reaches the devices like any other.
    const pf = { id: '00000000-0000-4000-8000-000000000001', date: '2026-11-03', category: 'investment', amount: 12.5, currency: 'EUR', source: 'Broker', notes: 'Dividend',
      source_category: 'Dividendes', import_key: 'pf:4711', created_at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T08:00:00Z', deleted_at: null }
    tables.otherIncome.set(pf.id, { ...pf, synced_at: stamp() } as RemoteRow)
    await b.run()
    const pulled = (await other.otherIncome.where('importKey').equals('pf:4711').first())!
    expect(pulled).toMatchObject({ category: 'investment', amount: 12.5, source: 'Broker', notes: 'Dividend', sourceCategory: 'Dividendes', dirty: 0 })
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
