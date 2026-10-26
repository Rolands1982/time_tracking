import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB, getSettings, updateSettings } from '../../src/db/schema'
import {
  addEntry,
  effectiveRate,
  findOrCreateClient,
  findOrCreateProject,
  queryEntries,
  rateFor,
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

  it('resolves the hourly rate by date from the client rate periods', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 50 }, db)
    expect(rateFor(c, '2026-01-01')).toBe(50)
    await db.clients.put({ ...c, rates: [{ from: '2026-03-01', rate: 70 }, { from: '2025-01-01', rate: 60 }] })
    const updated = (await db.clients.get(c.id!))!
    expect(rateFor(updated, '2024-12-31')).toBe(50)
    expect(rateFor(updated, '2025-01-01')).toBe(60)
    expect(rateFor(updated, '2026-02-28')).toBe(60)
    expect(rateFor(updated, '2026-03-01')).toBe(70)
    expect(rateFor(updated, '2030-01-01')).toBe(70)
    expect(effectiveRate(updated, '2026-06-01')).toBe(70)
    expect(rateFor(undefined, '2026-06-01')).toBe(0)
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
  it('turns a running timer into an entry using the billing rules', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    await startTimer({ clientId: c.id!, comments: 'working' }, db)
    const started = new Date((await getSettings(db)).runningTimer!.startedAt)
    // 47 real minutes are kept; billed as 45 minutes from a start snapped to the nearest 10-minute mark.
    const id = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, new Date(started.getTime() + 47 * 60_000))
    const e = (await db.entries.get(id!))!
    expect(e).toMatchObject({ durationMin: 47, billedMin: 45, amount: 45, comments: 'working', source: 'timer' })
    expect(e.billable).not.toBe(false)
    expect(Number(e.billedStartTime!.slice(3)) % 10).toBe(0)
    expect((await getSettings(db)).runningTimer).toBeUndefined()
  })

  it('records short timers as actual, non-billable minutes', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    await startTimer({ clientId: c.id!, comments: '' }, db)
    const started = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, new Date(started.getTime() + 4 * 60_000))
    expect((await db.entries.get(id!))!).toMatchObject({ durationMin: 4, billedMin: 4, billable: false, amount: 4 })

    await startTimer({ clientId: c.id!, comments: '' }, db)
    const started2 = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id2 = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, started2)
    expect((await db.entries.get(id2!))!.durationMin).toBe(1)
  })

  it('derives no billed columns when normalisation is switched off', async () => {
    await updateSettings({ roundingMode: 'exact' }, db)
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    await startTimer({ clientId: c.id!, comments: '' }, db)
    const started = new Date((await getSettings(db)).runningTimer!.startedAt)
    const id = await stopTimer({ clientId: c.id!, hourlyRate: 60 }, db, new Date(started.getTime() + 16 * 60_000))
    expect((await db.entries.get(id!))!).toMatchObject({ durationMin: 16, amount: 16 })
    expect((await db.entries.get(id!))!.billedMin).toBeUndefined()
  })

  it('normalises manual entries by default but leaves old records alone when edited', async () => {
    const c = await findOrCreateClient('Acme', { defaultRate: 60 }, db)
    const id = await addEntry({ date: '2026-10-24', startTime: '14:07', endTime: '14:31', clientId: c.id!, hourlyRate: 60, comments: '', isBilled: false }, db)
    expect((await db.entries.get(id))!).toMatchObject({ durationMin: 24, billedStartTime: '14:10', billedEndTime: '14:40', billedMin: 30, amount: 30 })

    // A record from before the rules (no billed columns) keeps its real minutes even after an edit.
    const oldId = await addEntry({ date: '2020-03-02', startTime: '10:45', endTime: '11:17', clientId: c.id!, hourlyRate: 60, comments: 'old', isBilled: false, normalize: false }, db)
    const old = (await db.entries.get(oldId))!
    expect(old.billedMin).toBeUndefined()
    expect(old.amount).toBe(32)
    await updateEntry(oldId, { ...old, comments: 'old, edited' }, db)
    const edited = (await db.entries.get(oldId))!
    expect(edited.billedMin).toBeUndefined()
    expect(edited.amount).toBe(32)
    expect(totals([edited, (await db.entries.get(id))!])).toMatchObject({ durationMin: 56, billedMin: 62, amount: 62 })
  })
})

describe('import → database → master file → backup', () => {
  it('imports once, skips duplicates on re-import, exports and restores', async () => {
    const parsed = await parseWorkbook(await buildFixtureWorkbook(), { clientName: 'Polystylex', defaultRate: 0 })
    const first = await importEntries(parsed.entries, db)
    expect(first).toMatchObject({ added: 15, duplicates: 1, clients: ['Polystylex'] })
    expect(await db.projects.count()).toBe(5)
    expect((await db.clients.toArray())[0].defaultRate).toBe(60)

    const second = await importEntries(parsed.entries, db)
    expect(second).toMatchObject({ added: 0, duplicates: 16 })

    const data = { entries: await db.entries.toArray(), clients: await db.clients.toArray(), projects: await db.projects.toArray() }
    const wb = buildMasterWorkbook(data)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Entries', 'By month', 'By client', 'By client & project', 'By invoice', 'Clients'])
    const entriesSheet = wb.getWorksheet('Entries')!
    expect(entriesSheet.rowCount).toBe(1 + 15 + 1)
    // midnight entry: end stored as 1.0 (24:00) so (End-Start)*24 works in Excel
    const midnightRow = entriesSheet.getRow(4)
    expect(midnightRow.getCell(2).value).toBeCloseTo(21.5 / 24, 9)
    expect(midnightRow.getCell(3).value).toBe(1)

    // The master file can be imported back by the same importer (round trip).
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const again = await parseWorkbook(buf, { clientName: 'ignored', defaultRate: 0 })
    const entriesOnly = again.entries.filter((e) => e.sheet === 'Entries')
    expect(entriesOnly).toHaveLength(15)
    expect(entriesOnly.every((e) => e.client === 'Polystylex')).toBe(true)
    expect(entriesOnly.reduce((s, e) => s + e.durationMin, 0)).toBe(data.entries.reduce((s, e) => s + e.durationMin, 0))
    expect(entriesOnly.filter((e) => e.isBilled)).toHaveLength(3)
    expect(entriesOnly.filter((e) => e.billable === false)).toHaveLength(1)
    expect(entriesOnly.find((e) => e.invoiceRef === 'Jūnijs 2023')).toBeTruthy()
    expect(await importEntries(entriesOnly, db)).toMatchObject({ added: 0, duplicates: 15 })

    const backup = await createBackup(db)
    const db2 = new TimeTrackingDB('restore-target')
    await restoreBackup(backup, db2)
    expect(await db2.entries.count()).toBe(15)
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
    expect(row.getCell(5).value).toBe(1.5)
    expect((row.getCell(10).value as { formula: string }).formula).toBe('E2*I2')
    expect(row.getCell(12).value).toBe('Yes')
    const inv = read.getWorksheet('By invoice')!
    expect(inv.getRow(2).getCell(1).value).toBe('2026-02-01')
  })
})
