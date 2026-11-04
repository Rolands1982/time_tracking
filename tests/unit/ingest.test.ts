import { beforeEach, describe, expect, it } from 'vitest'
import { TimeTrackingDB } from '../../src/db/schema'
import type { SyncTable } from '../../src/db/types'
import { SyncEngine } from '../../src/sync/engine'
import type { Remote, RemoteRow } from '../../src/sync/remote'
import { assembleImportFile, collectContracts, collectTimeRows, collectTransactions, extractJson } from '../../src/lib/upwork/assemble'
import { importUpwork, type UpworkImportFile } from '../../src/lib/upwork/import'
import { ingestUpwork } from '../../src/lib/upwork/ingest'

/** In-memory cloud, as in sync.test.ts. */
class MemoryRemote implements Remote {
  tables: Record<SyncTable, Map<string, RemoteRow>> = { clients: new Map(), projects: new Map(), entries: new Map(), upworkTransactions: new Map() }
  clock = 0
  private stamp() {
    this.clock++
    return new Date(Date.UTC(2030, 0, 1, 0, 0, this.clock)).toISOString()
  }
  async upsert(table: SyncTable, rows: Record<string, unknown>[]) {
    for (const r of rows) this.tables[table].set(String(r.id), { ...this.tables[table].get(String(r.id)), ...r, synced_at: this.stamp() } as RemoteRow)
  }
  async markDeleted(table: SyncTable, ids: string[]) {
    for (const id of ids) {
      const row = this.tables[table].get(id)
      if (row) this.tables[table].set(id, { ...row, deleted_at: this.stamp(), synced_at: this.stamp() })
    }
  }
  async pullSince(table: SyncTable, cursor: string | undefined) {
    return [...this.tables[table].values()].filter((r) => !cursor || r.synced_at > cursor).sort((a, b) => a.synced_at.localeCompare(b.synced_at))
  }
}

const contractsRaw = `Result: {"data":{"contracts":[{"clientOrganization":{"id":"425281712378155008","name":"Northwind Supply"},"clientTeam":{"id":"1","name":"Ops"},"createDate":"2026-01-02T10:00:00.000Z","id":"36599829","offerId":"5","startDate":"2026-01-05T00:00:00.000Z","status":"ACTIVE","title":"RPA Developer"}],"pageInfo":{"hasNextPage":false}},"status":"ok"}`
const timeRaw = `{"data":{"contractTimeReport":{"edges":[{"cursor":"202610121446010756","node":{"contract":{"id":"36599829","title":"RPA Developer"},"dateWorkedOn":"2026-10-12","memo":"RDEV-46","task":"","termId":"42838462","totalCharges":520,"totalHoursWorked":6.5,"weekWorkedOn":"2026-10-12"}},{"cursor":"202610131446010756","node":{"contract":{"id":"36599829","title":"RPA Developer"},"dateWorkedOn":"2026-10-13","memo":"RDEV-46","task":"","termId":"42838462","totalCharges":480,"totalHoursWorked":6,"weekWorkedOn":"2026-10-12"}}],"pageInfo":{"endCursor":"202610131446010756","hasNextPage":false},"totalCount":2}},"status":"ok"}`
const txRaw = `{"data":{"transactionHistory":{"transactionDetail":{"transactionHistoryRow":[{"accountingSubtype":"Hourly","assignmentCompanyName":"Northwind Supply","description":"(36599829) Northwind Supply - 12:30 hrs @ $80.00/hr - 10/12/2026 - 10/18/2026","recordId":"960041226","transactionAmount":{"currency":"USD","displayValue":"1000.00","rawValue":"1000.00"},"transactionCreationDate":"2026-10-18T00:00:00+0000","type":"APInvoice"},{"accountingSubtype":"Service Fee","description":"Service Fee\\nContract ID: 42838462\\nContract title: RPA Developer\\nClient: Northwind Supply\\nAmount: \\n$1000.00 USD x 10% = $100.00 USD\\nNotes: n","recordId":"960041233","transactionAmount":{"currency":"USD","rawValue":"-100.00"},"transactionCreationDate":"2026-10-18T00:00:00+0000","type":"APAdjustment"},{"accountingSubtype":"Withdrawal","description":"Withdrawal - Direct to Local Bank Transfer: xxxx-9485","recordId":"961135619","transactionAmount":{"currency":"USD","rawValue":"899.01"},"transactionCreationDate":"2026-10-23T00:00:00+0000","type":"APPayment"},{"accountingSubtype":"Withdrawal Fee","description":"Withdrawal Fee - Direct to Local Bank","recordId":"961135620","transactionAmount":{"currency":"USD","rawValue":"-0.99"},"transactionCreationDate":"2026-10-23T00:00:00+0000","type":"APAdjustment"}]}},"total_count":4,"from_date":"2026-10-01","to_date":"2026-10-31"},"status":"ok"}`

describe('assembling raw connector responses', () => {
  it('finds contracts, time rows and transactions wherever they sit, and merges overlapping pulls', () => {
    expect(() => extractJson('nothing here')).toThrow()
    expect(collectContracts(extractJson(contractsRaw))).toEqual([
      { id: '36599829', title: 'RPA Developer', status: 'ACTIVE', startDate: '2026-01-05', endDate: undefined, clientOrganization: { id: '425281712378155008', name: 'Northwind Supply' } },
    ])
    expect(collectTimeRows(extractJson(timeRaw))).toHaveLength(2)
    expect(collectTimeRows(extractJson(timeRaw))[0]).toEqual({ cursor: '202610121446010756', contract: { id: '36599829', title: 'RPA Developer' }, dateWorkedOn: '2026-10-12', weekWorkedOn: '2026-10-12', totalHoursWorked: 6.5, totalCharges: 520, memo: 'RDEV-46', termId: '42838462' })
    expect(collectTransactions(extractJson(txRaw)).map((t) => t.recordId)).toEqual(['960041226', '960041233', '961135619', '961135620'])
    // The same time page twice, with a corrected row, counts once with the later value.
    const corrected = timeRaw.replace('"totalCharges":480,"totalHoursWorked":6', '"totalCharges":560,"totalHoursWorked":7')
    const file = assembleImportFile([contractsRaw, timeRaw, corrected, txRaw])
    expect(file.counts).toEqual({ contracts: 1, time: 2, transactions: 4, files: 4 })
    expect(file.time!.find((t) => t.dateWorkedOn === '2026-10-13')!.totalHoursWorked).toBe(7)
    expect(file.app).toBe('time-tracking-upwork')
  })
})

describe('unattended ingest', () => {
  let n = 0
  let remote: MemoryRemote
  beforeEach(() => {
    n++
    remote = new MemoryRemote()
  })

  it('pulls the cloud copy, imports, settles, pushes; a device then sees the new rows', async () => {
    // Device A already holds an imported week in the cloud.
    const device = new TimeTrackingDB(`ingest-device-${n}`)
    const base = assembleImportFile([contractsRaw, timeRaw, txRaw])
    const { counts: _c, ...baseFile } = base
    await importUpwork(baseFile as UpworkImportFile, device)
    await new SyncEngine(remote, device).run()
    expect(remote.tables.entries.size).toBe(2)

    // The daily task: a fresh database, a pull with one new day and the bank credit for the payout.
    const nextDay = timeRaw.replace(/"edges":\[.*\],"pageInfo"/, '"edges":[{"cursor":"202610141446010756","node":{"contract":{"id":"36599829","title":"RPA Developer"},"dateWorkedOn":"2026-10-14","memo":"RDEV-46","termId":"42838462","totalCharges":80,"totalHoursWorked":1,"weekWorkedOn":"2026-10-12"}}],"pageInfo"')
    const { counts: _d, ...dailyFile } = assembleImportFile([nextDay, txRaw])
    const task = new TimeTrackingDB(`ingest-task-${n}`)
    const summary = await ingestUpwork({ db: task, remote, file: dailyFile as UpworkImportFile, bankCredits: [{ date: '2026-10-27', amount: 810 }], fetchRates: false })
    expect(summary.pulled).toBe(1 + 1 + 2 + 4) // client, project, 2 entries, 4 transactions
    expect(summary.import!.entries).toEqual({ added: 1, updated: 0, unchanged: 0, removed: 0, rekeyed: 0 })
    expect(summary.import!.transactions.unchanged).toBe(4)
    expect(summary.bank).toEqual({ matched: 1, alreadyPriced: 0, unmatched: 0 })
    // All three days fall inside the invoiced week, which the priced payout covers: nothing stays estimated.
    expect(summary.settlement).toMatchObject({ estimated: 0, payoutsWithoutEur: 0 })
    expect(summary.pushed).toBeGreaterThanOrEqual(4) // 3 entries + the priced payout

    // Device A pulls: the new day arrives, the week is priced in EUR.
    await new SyncEngine(remote, device).run()
    const entries = (await device.entries.toArray()).sort((a, b) => a.date.localeCompare(b.date))
    expect(entries.map((e) => [e.date, e.settlement, e.fxRate])).toEqual([
      ['2026-10-12', 'actual', 0.9],
      ['2026-10-13', 'actual', 0.9],
      ['2026-10-14', 'actual', 0.9],
    ])
    expect((await device.upworkTransactions.where('txId').equals('961135619').first())!.eurAmount).toBe(810)

    // Second run with the same inputs changes nothing.
    const again = await ingestUpwork({ db: new TimeTrackingDB(`ingest-task2-${n}`), remote, file: dailyFile as UpworkImportFile, bankCredits: [{ date: '2026-10-27', amount: 810 }], fetchRates: false })
    expect(again.import!.entries.added).toBe(0)
    expect(again.bank).toEqual({ matched: 0, alreadyPriced: 1, unmatched: 0 })
    expect(again.settlement.updated).toBe(0)
    expect(again.pushed).toBe(0)
  })

  it('dry run pushes nothing', async () => {
    const { counts: _c, ...file } = assembleImportFile([contractsRaw, timeRaw, txRaw])
    const summary = await ingestUpwork({ db: new TimeTrackingDB(`ingest-dry-${n}`), remote, file: file as UpworkImportFile, fetchRates: false, dryRun: true })
    expect(summary.import!.entries.added).toBe(2)
    expect(summary.pushed).toBe(0)
    expect(remote.tables.entries.size).toBe(0)
  })
})
