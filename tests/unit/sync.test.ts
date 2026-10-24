import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB, getSettings } from '../../src/db/schema'
import { addEntry, deleteEntry, findOrCreateClient, findOrCreateProject, setBilled, updateEntry } from '../../src/db/repo'
import { SyncEngine } from '../../src/sync/engine'
import type { Remote, RemoteRow } from '../../src/sync/remote'
import type { SyncTable } from '../../src/db/types'
import { createBackup, restoreBackup } from '../../src/lib/backup'
import { findDuplicates, removeDuplicates } from '../../src/db/repo'

/** In-memory stand-in for the Supabase tables, including the server-side synced_at stamp. */
class MemoryRemote implements Remote {
  tables: Record<SyncTable, Map<string, RemoteRow>> = { clients: new Map(), projects: new Map(), entries: new Map() }
  clock = 0
  calls: string[] = []
  private stamp() {
    this.clock++
    return new Date(Date.UTC(2030, 0, 1, 0, 0, this.clock)).toISOString()
  }
  async upsert(table: SyncTable, rows: Record<string, unknown>[]) {
    this.calls.push(`upsert:${table}:${rows.length}`)
    for (const r of rows) {
      const existing = this.tables[table].get(String(r.id))
      this.tables[table].set(String(r.id), { ...existing, ...r, synced_at: this.stamp() } as RemoteRow)
    }
  }
  async markDeleted(table: SyncTable, ids: string[]) {
    this.calls.push(`delete:${table}:${ids.length}`)
    for (const id of ids) {
      const row = this.tables[table].get(id)
      if (row) this.tables[table].set(id, { ...row, deleted_at: this.stamp(), synced_at: this.stamp() })
    }
  }
  async pullSince(table: SyncTable, cursor: string | undefined) {
    return [...this.tables[table].values()].filter((r) => !cursor || r.synced_at > cursor).sort((a, b) => a.synced_at.localeCompare(b.synced_at))
  }
  /** Simulate an edit made on the server / by another device. */
  edit(table: SyncTable, id: string, patch: Record<string, unknown>) {
    const row = this.tables[table].get(id)!
    this.tables[table].set(id, { ...row, ...patch, synced_at: this.stamp() })
  }
}

let n = 0
let remote: MemoryRemote
let a: TimeTrackingDB
let b: TimeTrackingDB
beforeEach(() => {
  n++
  remote = new MemoryRemote()
  a = new TimeTrackingDB(`sync-a-${n}`)
  b = new TimeTrackingDB(`sync-b-${n}`)
})

async function seed(dbx: TimeTrackingDB) {
  const client = await findOrCreateClient('Acme', { defaultRate: 50 }, dbx)
  const project = await findOrCreateProject(client.id!, 'Web', {}, dbx)
  const id = await addEntry({ date: '2026-10-20', startTime: '09:00', endTime: '10:30', clientId: client.id!, projectId: project.id, hourlyRate: 50, comments: 'first', isBilled: false }, dbx)
  return { client, project, id }
}

describe('local change tracking', () => {
  it('assigns uids and marks new and edited rows dirty, but not rows written by sync', async () => {
    const { id } = await seed(a)
    const e = (await a.entries.get(id))!
    expect(e.uid).toMatch(/^[0-9a-f-]{36}$/)
    expect(e.dirty).toBe(1)
    expect((await a.clients.toArray())[0].dirty).toBe(1)

    await new SyncEngine(remote, a).run()
    expect((await a.entries.get(id))!.dirty).toBe(0)
    expect((await a.clients.toArray())[0].dirty).toBe(0)

    await setBilled([id], '2026-10-31', a)
    expect((await a.entries.get(id))!.dirty).toBe(1)
  })

  it('records deletions as tombstones', async () => {
    const { id } = await seed(a)
    await deleteEntry(id, a)
    expect(await a.tombstones.toArray()).toMatchObject([{ table: 'entries' }])
  })
})

describe('push and pull between two devices', () => {
  it('replicates clients, projects and entries with relations intact', async () => {
    const { id } = await seed(a)
    const r1 = await new SyncEngine(remote, a).run()
    expect(r1).toMatchObject({ pushed: 3, deleted: 0 })
    expect(remote.calls.slice(0, 3)).toEqual(['upsert:clients:1', 'upsert:projects:1', 'upsert:entries:1'])

    const r2 = await new SyncEngine(remote, b).run()
    expect(r2).toMatchObject({ pushed: 0, pulled: 3 })
    const entryB = (await b.entries.toArray())[0]
    const clientB = (await b.clients.get(entryB.clientId))!
    const projectB = (await b.projects.get(entryB.projectId!))!
    expect(clientB.name).toBe('Acme')
    expect(projectB.name).toBe('Web')
    expect(entryB).toMatchObject({ date: '2026-10-20', startTime: '09:00', endTime: '10:30', durationMin: 90, billedStartTime: '09:00', billedEndTime: '10:30', billedMin: 90, amount: 75, comments: 'first', dirty: 0 })
    expect(entryB.uid).toBe((await a.entries.get(id))!.uid)
    expect(entryB.id).not.toBe(id + 1000) // ids are local, only uids are shared

    // Second run with nothing new pulls nothing (cursor advanced).
    expect(await new SyncEngine(remote, b).run()).toMatchObject({ pushed: 0, pulled: 0 })
    expect((await getSettings(b)).sync?.cursors?.entries).toBeTruthy()
  })

  it('propagates edits, billing and deletions in both directions', async () => {
    const { id } = await seed(a)
    await new SyncEngine(remote, a).run()
    await new SyncEngine(remote, b).run()

    // B bills the entry and adds another one; A deletes nothing yet.
    const entryB = (await b.entries.toArray())[0]
    await setBilled([entryB.id!], '2026-10-31', b)
    await addEntry({ date: '2026-10-21', startTime: '12:00', endTime: '13:00', clientId: entryB.clientId, hourlyRate: 50, comments: 'from B', isBilled: false }, b)
    await new SyncEngine(remote, b).run()

    await new SyncEngine(remote, a).run()
    expect(await a.entries.count()).toBe(2)
    expect((await a.entries.get(id))!).toMatchObject({ isBilled: true, invoiceDate: '2026-10-31', dirty: 0 })

    // A deletes the original entry; B learns about it.
    await deleteEntry(id, a)
    expect(await new SyncEngine(remote, a).run()).toMatchObject({ deleted: 1 })
    expect(await a.tombstones.count()).toBe(0)
    await new SyncEngine(remote, b).run()
    expect(await b.entries.count()).toBe(1)
    expect((await b.entries.toArray())[0].comments).toBe('from B')
  })

  it('keeps the newer side on a conflict', async () => {
    const { id } = await seed(a)
    await new SyncEngine(remote, a).run()
    const uid = (await a.entries.get(id))!.uid!

    // Server copy edited later than the local one: server wins and the local edit is not pushed.
    const local = (await a.entries.get(id))!
    await updateEntry(id, { ...local, comments: 'older local edit' }, a)
    await a.remoteTransaction(() => a.entries.update(id, { updatedAt: '2030-01-01T00:00:00.000Z' }))
    remote.edit('entries', uid, { comments: 'server edit', updated_at: '2040-01-01T00:00:00.000Z' })
    await new SyncEngine(remote, a).run()
    expect((await a.entries.get(id))!).toMatchObject({ comments: 'server edit', dirty: 0 })
    expect(remote.tables.entries.get(uid)!.comments).toBe('server edit')

    // Local copy edited later than the server one: local wins and gets pushed.
    remote.edit('entries', uid, { comments: 'server edit 2', updated_at: '2041-01-01T00:00:00.000Z' })
    await a.remoteTransaction(() => a.entries.update(id, { comments: 'newest local', updatedAt: '2042-01-01T00:00:00.000Z', dirty: 1 }))
    await new SyncEngine(remote, a).run()
    expect((await a.entries.get(id))!.comments).toBe('newest local')
    expect(remote.tables.entries.get(uid)!.comments).toBe('newest local')
  })

  it('merges a client created with the same name on two devices', async () => {
    await findOrCreateClient('Acme', { defaultRate: 50 }, a)
    const mine = await findOrCreateClient('acme', { defaultRate: 60 }, b)
    await addEntry({ date: '2026-10-22', startTime: '08:00', endTime: '09:00', clientId: mine.id!, hourlyRate: 60, comments: 'b', isBilled: false }, b)
    await new SyncEngine(remote, a).run()
    await new SyncEngine(remote, b).run()
    expect(await b.clients.count()).toBe(1)
    expect(remote.tables.clients.size).toBe(1)
    const merged = (await b.clients.toArray())[0]
    expect(merged.defaultRate).toBe(50) // the copy already in the cloud wins
    expect((await b.entries.toArray())[0].clientId).toBe(merged.id) // B's entry still points at the merged client
    expect(remote.tables.entries.get((await b.entries.toArray())[0].uid!)!.client_id).toBe(merged.uid)
  })

  it('does not resurrect a row deleted locally while it changed on the server', async () => {
    const { id } = await seed(a)
    await new SyncEngine(remote, a).run()
    const uid = (await a.entries.get(id))!.uid!
    remote.edit('entries', uid, { comments: 'server edit', updated_at: '2040-01-01T00:00:00.000Z' })
    await deleteEntry(id, a)
    await new SyncEngine(remote, a).run()
    expect(await a.entries.count()).toBe(0)
    expect(remote.tables.entries.get(uid)!.deleted_at).toBeTruthy()
  })

  it('restored backups are pushed and cloud data is re-pulled afterwards', async () => {
    await seed(a)
    const backup = await createBackup(a)
    await restoreBackup(backup, b)
    expect((await b.entries.toArray()).every((e) => e.dirty === 1)).toBe(true)
    expect(await new SyncEngine(remote, b).run()).toMatchObject({ pushed: 3 })
    expect(remote.tables.entries.size).toBe(1)
  })

  it('a restore replaces the cloud copy instead of duplicating it', async () => {
    // Device A restores a backup without uids (as produced by the merge script) and syncs.
    const seedDb = new TimeTrackingDB(`seed-${n}`)
    await seed(seedDb)
    const backup = await createBackup(seedDb)
    const stripUids = <T extends { uid?: string; dirty?: 0 | 1 }>(rows: T[]) => rows.map(({ uid: _u, dirty: _d, ...r }) => r as T)
    const noUids = { ...backup, clients: stripUids(backup.clients), projects: stripUids(backup.projects), entries: stripUids(backup.entries) }
    await restoreBackup(noUids, a)
    await new SyncEngine(remote, a).run()
    await new SyncEngine(remote, b).run()
    expect(await b.entries.count()).toBe(1)

    // The same backup is restored again on A (new uids): the old cloud rows must be removed, not duplicated.
    await restoreBackup(noUids, a)
    expect(await a.tombstones.count()).toBe(3)
    await new SyncEngine(remote, a).run()
    expect([...remote.tables.entries.values()].filter((r) => !r.deleted_at)).toHaveLength(1)
    await new SyncEngine(remote, b).run()
    expect(await b.entries.count()).toBe(1)
    expect(await b.clients.count()).toBe(1)
    expect(await b.projects.count()).toBe(1)
  })

  it('removes duplicates and propagates the removal', async () => {
    const seedDb = new TimeTrackingDB(`seed2-${n}`)
    await seed(seedDb)
    const backup = await createBackup(seedDb)
    const stripUids = <T extends { uid?: string; dirty?: 0 | 1 }>(rows: T[]) => rows.map(({ uid: _u, dirty: _d, ...r }) => r as T)
    const noUids = { ...backup, clients: stripUids(backup.clients), projects: stripUids(backup.projects), entries: stripUids(backup.entries) }
    // Simulate the old behaviour: two devices restored the same backup independently and both pushed.
    await restoreBackup(noUids, a)
    await new SyncEngine(remote, a).run()
    await restoreBackup(noUids, b)
    await b.tombstones.clear() // pretend B restored with the old code that did not tombstone
    await new SyncEngine(remote, b).run()
    await new SyncEngine(remote, a).run()
    expect(await a.entries.count()).toBe(2)
    expect(await a.projects.count()).toBe(2)
    expect(await findDuplicates(a)).toEqual({ entries: 1, projects: 1 })

    expect(await removeDuplicates(a)).toEqual({ entries: 1, projects: 1 })
    expect(await a.entries.count()).toBe(1)
    expect(await a.projects.count()).toBe(1)
    expect((await a.entries.toArray())[0].projectId).toBe((await a.projects.toArray())[0].id)
    await new SyncEngine(remote, a).run()
    await new SyncEngine(remote, b).run()
    expect(await b.entries.count()).toBe(1)
    expect(await b.projects.count()).toBe(1)
    expect(await findDuplicates(b)).toEqual({ entries: 0, projects: 0 })
  })
})
