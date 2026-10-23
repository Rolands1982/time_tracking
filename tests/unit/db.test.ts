import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB, getSettings, updateSettings } from '../../src/db/schema'
import {
  addEntry,
  findOrCreateClient,
  findOrCreateProject,
  queryEntries,
  setBilled,
  startTimer,
  stopTimer,
  totals,
  updateEntry,
} from '../../src/db/repo'
import { importEntries } from '../../src/lib/excel/importIntoDb'
import { parseWorkbook } from '../../src/lib/excel/importWorkbook'
import { buildMasterWorkbook } from '../../src/lib/excel/exportMaster'
import { createBackup, restoreBackup } from '../../src/lib/backup'
import { buildFixtureWorkbook } from './fixtures'

let db: TimeTrackingDB
let n = 0
beforeEach(() => {
  db = new TimeTrackingDB(`test-${++n}`)
})

describe('entries', () => {
  it('computes duration and amount, and remembers the last client', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 50 }, db)
    const id = await addEntry(
      { date: '2026-10-23', startTime: '22:00', endTime: '00:30', clientId: c.id!, hourlyRate: 50, comments: 'late', isBilled: false },
      db,
    )
    const e = (await db.entries.get(id))!
    expect(e).toMatchObject({ durationMin: 150, amount: 125, source: 'manual', isBilled: false })
    expect((await getSettings(db)).lastClientId).toBe(c.id)

    await updateEntry(id, { ...e, endTime: '23:00', isBilled: true, invoiceDate: '2026-11-01' }, db)
    const u = (await db.entries.get(id))!
    expect(u).toMatchObject({ durationMin: 60, amount: 50, isBilled: true, invoiceDate: '2026-11-01' })
    expect(u.createdAt).toBe(e.createdAt)
  })

  it('marks entries billed and filters them', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 40 }, db)
    const ids = []
    for (const day of ['2026-09-01', '2026-09-02', '2026-10-01']) {
      ids.push(await addEntry({ date: day, startTime: '09:00', endTime: '10:00', clientId: c.id!, hourlyRate: 40, comments: '', isBilled: false }, db))
    }
    await setBilled(ids.slice(0, 2), '2026-10-01', db)
    const open = await queryEntries({ billed: false }, db)
    expect(open.map((e) => e.date)).toEqual(['2026-10-01'])
    const sept = await queryEntries({ from: '2026-09-01', to: '2026-09-30' }, db)
    expect(sept).toHaveLength(2)
    expect(totals(await queryEntries({}, db))).toMatchObject({ count: 3, durationMin: 180, amount: 120, billedAmount: 80, unbilledAmount: 40 })
  })

  it('finds clients case-insensitively and projects per client', async () => {
    const a = await findOrCreateClient('Acme', {}, db)
    const b = await findOrCreateClient('acme ', {}, db)
    expect(b.id).toBe(a.id)
    const p1 = await findOrCreateProject(a.id!, 'Web', {}, db)
    const p2 = await findOrCreateProject(a.id!, 'web', {}, db)
    expect(p2.id).toBe(p1.id)
  })
})

describe('timer', () => {
  it('turns a running timer into an entry', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    await startTimer({ clientId: c.id!, comments: 'working' }, db)
    const started = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, new Date(started.getTime() + 47 * 60_000))
    const e = (await db.entries.get(id!))!
    expect(e).toMatchObject({ durationMin: 47, amount: 47, comments: 'working', source: 'timer' })
    expect((await getSettings(db)).runningTimer).toBeUndefined()
  })

  it('rounds up when rounding is configured and never saves zero minutes', async () => {
    await updateSettings({ timerRoundingMin: 15 }, db)
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    await startTimer({ clientId: c.id!, comments: '' }, db)
    const started = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, new Date(started.getTime() + 16 * 60_000))
    expect((await db.entries.get(id!))!.durationMin).toBe(30)

    await updateSettings({ timerRoundingMin: 0 }, db)
    await startTimer({ clientId: c.id!, comments: '' }, db)
    const started2 = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id2 = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, started2)
    expect((await db.entries.get(id2!))!.durationMin).toBe(1)
  })
})

describe('import → database → master file → backup', () => {
  it('imports once, skips duplicates on re-import, exports and restores', async () => {
    const parsed = await parseWorkbook(await buildFixtureWorkbook(), { clientName: 'Polystylex', defaultRate: 0 })
    const first = await importEntries(parsed.entries, db)
    expect(first).toMatchObject({ added: 14, duplicates: 1, clients: ['Polystylex'] })
    expect(await db.projects.count()).toBe(4)
    expect((await db.clients.toArray())[0].defaultRate).toBe(60)

    const second = await importEntries(parsed.entries, db)
    expect(second).toMatchObject({ added: 0, duplicates: 15 })

    const data = { entries: await db.entries.toArray(), clients: await db.clients.toArray(), projects: await db.projects.toArray() }
    const wb = buildMasterWorkbook(data)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Entries', 'By month', 'By client', 'By client & project', 'By invoice', 'Clients'])
    const entriesSheet = wb.getWorksheet('Entries')!
    expect(entriesSheet.rowCount).toBe(1 + 14 + 1)
    // midnight entry: end stored as 1.0 (24:00) so (End-Start)*24 works in Excel
    const midnightRow = entriesSheet.getRow(4)
    expect(midnightRow.getCell(2).value).toBeCloseTo(21.5 / 24, 9)
    expect(midnightRow.getCell(3).value).toBe(1)

    // The master file can be imported back by the same importer (round trip).
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const again = await parseWorkbook(buf, { clientName: 'ignored', defaultRate: 0 })
    const entriesOnly = again.entries.filter((e) => e.sheet === 'Entries')
    expect(entriesOnly).toHaveLength(14)
    expect(entriesOnly.every((e) => e.client === 'Polystylex')).toBe(true)
    expect(entriesOnly.reduce((s, e) => s + e.durationMin, 0)).toBe(data.entries.reduce((s, e) => s + e.durationMin, 0))
    expect(entriesOnly.filter((e) => e.isBilled)).toHaveLength(3)
    expect(entriesOnly.filter((e) => e.billable === false)).toHaveLength(1)
    expect(entriesOnly.find((e) => e.invoiceRef === 'Jūnijs 2023')).toBeTruthy()
    expect(await importEntries(entriesOnly, db)).toMatchObject({ added: 0, duplicates: 14 })

    const backup = await createBackup(db)
    const db2 = new TimeTrackingDB('restore-target')
    await restoreBackup(backup, db2)
    expect(await db2.entries.count()).toBe(14)
    expect(await db2.clients.count()).toBe(1)
  })

  it('writes a valid xlsx that ExcelJS can read back with formulas', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 100 }, db)
    await addEntry({ date: '2026-01-05', startTime: '09:00', endTime: '10:30', clientId: c.id!, hourlyRate: 100, comments: 'x', isBilled: true, invoiceDate: '2026-02-01' }, db)
    const wb = buildMasterWorkbook({ entries: await db.entries.toArray(), clients: await db.clients.toArray(), projects: [] })
    const buf = await wb.xlsx.writeBuffer()
    const read = new ExcelJS.Workbook()
    await read.xlsx.load(buf as never)
    const row = read.getWorksheet('Entries')!.getRow(2)
    expect((row.getCell(4).value as { formula: string }).formula).toBe('(C2-B2)*24')
    expect((row.getCell(9).value as { formula: string }).formula).toBe('D2*H2')
    expect(row.getCell(11).value).toBe('Yes')
    const inv = read.getWorksheet('By invoice')!
    expect(inv.getRow(2).getCell(1).value).toBe('2026-02-01')
  })
})
