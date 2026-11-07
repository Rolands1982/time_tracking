import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import { addOtherIncome, defaultIncomeDate, deleteOtherIncome, importOtherIncome, incomeTotals, queryOtherIncome, updateOtherIncome } from '../../src/db/income'
import type { SyncTable } from '../../src/db/types'
import { incomeCategoryOf, incomeCategoryOfText, newNoteLines, parseNoteLine, parseOtherIncomeWorkbook, splitWeek } from '../../src/lib/excel/importOtherIncome'
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
  // The last date has a slip in the year; the helper figure in row 1 is not a date.
  ws.addRow([null, d(2026, 10, 4), d(2026, 10, 11), d(2025, 10, 18), 'Total', 1756.53])
  ws.addRow(['Acme', 100, 200, 300, 300])
  ws.addRow(['Northwind', 500, 1000, 1500, 1500])
  ws.addRow(['Total', 891.16, 3244.27, 5634.14, 5634.14])
  ws.addRow([])
  ws.addRow(['Īre', null, 320, 320, 320])
  ws.addRow(['Mintos', 4.58, 6.52, 6.52, 6.52])
  ws.addRow(['Citi', null, 265, 300.03, 300.03])
  ws.getCell('C8').note = 'Author:\n25 EUR - pārdoti zābaki\nĢimenes pabalsts'
  ws.getCell('D8').note = 'Author:\n25 EUR - pārdoti zābaki\nĢimenes pabalsts - 240\n18.03 Akciju dividendes\nViensviens.lv - 15 + 2'
  ws.addRow(['Possible future job', null, null, 200, 200])
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
    expect(incomeCategoryOf('Possible future job')).toBeUndefined()

    const r = await parseOtherIncomeWorkbook(await buildIncomeWorkbook())
    expect(r.sheets).toEqual([
      { name: 'Oktobris 2026', rows: 7 },
      { name: 'Notes', rows: 0, reason: 'no dates in row 1' },
    ])
    expect(r.warnings).toEqual([
      'Oktobris 2026: the date 2025-10-18 in row 1 is read as 2026-10-18 (the sheet\'s other dates are around 2026-10-04).',
      'Oktobris 2026: "Possible future job" is not a known kind of income (200 as of 2026-10-18); add it by hand if it is income.',
    ])
    // Citi: week 2 = 25 boots + the benefit without an amount (gets the rest, 240); week 3 = dividends + 15 + 2 sold.
    expect(r.rows.map((x) => [x.date, x.category, x.amount, x.source, x.notes, x.importKey])).toEqual([
      ['2026-10-11', 'rent', 320, undefined, '', 'income:Oktobris 2026!C6'],
      ['2026-10-04', 'investment', 4.58, 'Mintos', '', 'income:Oktobris 2026!B7'],
      ['2026-10-11', 'investment', 1.94, 'Mintos', '', 'income:Oktobris 2026!C7'],
      ['2026-10-11', 'sale', 25, undefined, '25 EUR - pārdoti zābaki', 'income:Oktobris 2026!C8#1'],
      ['2026-10-11', 'benefit', 240, undefined, 'Ģimenes pabalsts', 'income:Oktobris 2026!C8#2'],
      ['2026-10-18', 'investment', 18.03, undefined, '18.03 Akciju dividendes', 'income:Oktobris 2026!D8#1'],
      ['2026-10-18', 'sale', 17, undefined, 'Viensviens.lv - 15 + 2', 'income:Oktobris 2026!D8#2'],
    ])

    expect(await importOtherIncome(r.rows, db)).toEqual({ added: 7, duplicates: 0 })
    expect(await importOtherIncome(r.rows, db)).toEqual({ added: 0, duplicates: 7 })
    expect(incomeTotals(await db.otherIncome.toArray())).toMatchObject({ count: 7, total: 626.55, byCategory: { rent: 320, investment: 24.55, sale: 42, benefit: 240, other: 0 } })
  })

  it('reads amounts from note lines and splits a week by its new lines', () => {
    expect(parseNoteLine('120 - Novada pabalsts')).toMatchObject({ amount: 120 })
    expect(parseNoteLine('25 EUR - pārdoti zābaki')).toMatchObject({ amount: 25 })
    expect(parseNoteLine('18.03 Akciju dividendes')).toMatchObject({ amount: 18.03 })
    expect(parseNoteLine('Noguldījuma procenti -15,15')).toMatchObject({ amount: 15.15 })
    expect(parseNoteLine('Nodokļu ietaupījums (3 dienas) - 41.5 EUR')).toMatchObject({ amount: 41.5 })
    expect(parseNoteLine('Kredīta procentu kompensācija - 100.5 + 20.25')).toMatchObject({ amount: 120.75 })
    expect(parseNoteLine('Pabalsts (3 dienas) - ~30 EUR/dienā').amount).toBeUndefined()
    expect(parseNoteLine('22.lv').amount).toBeUndefined()

    expect(incomeCategoryOfText('Kredīta procentu kompensācija', 'other')).toBe('benefit')
    expect(incomeCategoryOfText('Noguldījuma procenti', 'other')).toBe('investment')
    expect(incomeCategoryOfText('Nodokļu ietaupījums (slimības lapa)', 'other')).toBe('other')
    expect(incomeCategoryOfText('Slimības pabalsts', 'other')).toBe('benefit')
    expect(incomeCategoryOfText('20 - par bērnu zābakiem', 'other')).toBe('sale')
    expect(incomeCategoryOfText('Atgriezta pārmaksa par bērnudārzu', 'other')).toBe('other')
    expect(incomeCategoryOfText('Laimests', 'other')).toBe('other')

    // Same text is old; a grown amount adds the difference; a line without an amount carries its earlier share.
    const week1 = ['Viensviens.lv - 50', 'Slimības pabalsts (3 dienas) - ~30 EUR/dienā'].map(parseNoteLine)
    const fresh1 = newNoteLines([], week1)
    expect(splitWeek(140, fresh1, 'other', true).parts).toEqual([
      { category: 'sale', amount: 50, notes: 'Viensviens.lv - 50' },
      { category: 'benefit', amount: 90, notes: 'Slimības pabalsts (3 dienas) - ~30 EUR/dienā' },
    ])
    const week2 = ['Viensviens.lv - 70', 'Slimības pabalsts (3 dienas) - 91.5 EUR', 'Nodokļa atmaksa - 100'].map(parseNoteLine)
    expect(splitWeek(121.5, newNoteLines(week1, week2), 'other', true)).toEqual({
      parts: [
        { category: 'sale', amount: 20, notes: 'Viensviens.lv - 70' },
        { category: 'benefit', amount: 1.5, notes: 'Slimības pabalsts (3 dienas) - 91.5 EUR' },
        { category: 'other', amount: 100, notes: 'Nodokļa atmaksa - 100' },
      ],
    })

    // Cents of rounding go to the largest line; an unexplained rest is kept without a note and reported.
    expect(splitWeek(49.9, [parseNoteLine('50 EUR - vecais telefons')], 'other', true).parts[0].amount).toBe(49.9)
    const short = splitWeek(30, [parseNoteLine('Bērnu buči - 10')], 'other', true)
    expect(short.parts).toEqual([
      { category: 'sale', amount: 10, notes: 'Bērnu buči - 10' },
      { category: 'other', amount: 20, notes: '' },
    ])
    expect(short.problem).toMatch(/explains 10 of 30/)
    // No note at all: the whole increase, under the row's kind.
    expect(splitWeek(500, [], 'other', true)).toEqual({ parts: [{ category: 'other', amount: 500, notes: '' }] })
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
