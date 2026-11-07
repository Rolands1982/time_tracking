import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { addOtherIncome, defaultIncomeDate, deleteOtherIncome, importOtherIncome, incomeTotals, queryOtherIncome, updateOtherIncome } from '../../src/db/income'
import type { SyncTable } from '../../src/db/types'
import { incomeCategoryOf, parseOtherIncomeWorkbook } from '../../src/lib/excel/importOtherIncome'
import { createBackup, restoreBackup } from '../../src/lib/backup'
import { SyncEngine } from '../../src/sync/engine'
import type { Remote, RemoteRow } from '../../src/sync/remote'

let db: TimeTrackingDB
let n = 0
beforeEach(() => {
  db = new TimeTrackingDB(`income-${++n}`)
})

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day))

/** A month sheet of the weekly income workbook: dates in row 1, month-to-date figures, the other income below the clients' Total. */
async function buildIncomeWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Oktobris 2026')
  ws.addRow([null, d(2026, 10, 4), d(2026, 10, 11), d(2026, 10, 18), 'Total'])
  ws.addRow(['Polystylex', 191.67, 216.67, 266.67, 266.67])
  ws.addRow(['Cascade Orthopedic', 699.49, 3027.6, 5367.47, 5367.47])
  ws.addRow(['Total', 891.16, 3244.27, 5634.14, 5634.14])
  ws.addRow([])
  ws.addRow(['Īre', null, 320, 320, 320])
  ws.addRow(['Mintos', 4.58, 6.52, 6.52, 6.52])
  ws.addRow(['Citi', null, 25, 43.03, 43.03])
  ws.getCell('C8').note = 'Rolands:\n25 EUR - pārdoti zābaki'
  ws.getCell('D8').note = 'Rolands:\n25 EUR - pārdoti zābaki\n18.03 Delfin Group dividendes'
  ws.addRow(['Terje (potential future work)', null, null, 200, 200])
  ws.addRow(['Total', 895.74, 3595.79, 6003.69, 6003.69])
  const notes = wb.addWorksheet('Notes')
  notes.addRow(['Just notes'])
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

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

  it('reads the weekly income workbook: increments per column, notes from the cell comments', async () => {
    expect(incomeCategoryOf('Īre')).toBe('rent')
    expect(incomeCategoryOf('Pabalsti')).toBe('benefit')
    expect(incomeCategoryOf('Sale of bike')).toBe('sale')
    expect(incomeCategoryOf('Terje (potential future work)')).toBeUndefined()

    const r = await parseOtherIncomeWorkbook(await buildIncomeWorkbook())
    expect(r.sheets).toEqual([
      { name: 'Oktobris 2026', rows: 5 },
      { name: 'Notes', rows: 0, reason: 'no dates in row 1' },
    ])
    expect(r.warnings).toEqual(['Oktobris 2026: "Terje (potential future work)" is not a known kind of income (200 as of 2026-10-18); add it by hand if it is income.'])
    expect(r.rows.map((x) => [x.date, x.category, x.amount, x.source, x.notes, x.importKey])).toEqual([
      ['2026-10-11', 'rent', 320, undefined, '', 'income:2026-10-11:ire'],
      ['2026-10-04', 'investment', 4.58, 'Mintos', '', 'income:2026-10-04:mintos'],
      ['2026-10-11', 'investment', 1.94, 'Mintos', '', 'income:2026-10-11:mintos'],
      ['2026-10-11', 'other', 25, undefined, '25 EUR - pārdoti zābaki', 'income:2026-10-11:citi'],
      ['2026-10-18', 'other', 18.03, undefined, '18.03 Delfin Group dividendes', 'income:2026-10-18:citi'],
    ])

    expect(await importOtherIncome(r.rows, db)).toEqual({ added: 5, duplicates: 0 })
    expect(await importOtherIncome(r.rows, db)).toEqual({ added: 0, duplicates: 5 })
    expect(incomeTotals(await db.otherIncome.toArray())).toMatchObject({ count: 5, total: 369.55, byCategory: { rent: 320, investment: 6.52, other: 43.03 } })
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
    expect([...tables.otherIncome.values()][0]).toMatchObject({ date: '2026-11-08', category: 'benefit', amount: 816, currency: 'EUR', notes: 'VSAA', import_key: null })

    const b = new SyncEngine(remote, other)
    expect((await b.run()).pulled).toBe(1)
    expect(await other.otherIncome.toArray()).toMatchObject([{ date: '2026-11-08', category: 'benefit', amount: 816, dirty: 0 }])

    const backup = await createBackup(other)
    expect(backup.otherIncome).toHaveLength(1)

    await deleteOtherIncome(id, db)
    expect((await a.run()).deleted).toBe(1)
    await b.run()
    expect(await other.otherIncome.count()).toBe(0)

    await restoreBackup(backup, other)
    expect(await other.otherIncome.count()).toBe(1)
    expect((await other.otherIncome.toArray())[0].dirty).toBe(1)
  })
})
