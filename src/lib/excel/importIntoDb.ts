import { db, type TimeTrackingDB } from '../../db/schema'
import { findOrCreateClient, findOrCreateProject } from '../../db/repo'
import type { TimeEntry } from '../../db/types'
import type { ParsedEntry } from './importWorkbook'

export interface ImportSummary {
  added: number
  duplicates: number
  clients: string[]
}

/**
 * Store parsed entries, creating clients/projects on the fly and skipping rows
 * that were imported before (same import key).
 */
export async function importEntries(
  parsed: ParsedEntry[],
  database: TimeTrackingDB = db,
): Promise<ImportSummary> {
  const summary: ImportSummary = { added: 0, duplicates: 0, clients: [] }
  const existingKeys = new Set(
    (await database.entries.where('importKey').anyOf(parsed.map((p) => p.importKey)).toArray()).map(
      (e) => e.importKey,
    ),
  )
  const seenInBatch = new Set<string>()
  const clientIds = new Map<string, number>()
  const projectIds = new Map<string, number>()
  const now = new Date().toISOString()
  const rows: TimeEntry[] = []

  for (const p of parsed) {
    if (existingKeys.has(p.importKey) || seenInBatch.has(p.importKey)) {
      summary.duplicates++
      continue
    }
    seenInBatch.add(p.importKey)
    const clientKey = p.client.toLowerCase()
    let clientId = clientIds.get(clientKey)
    if (clientId == null) {
      const client = await findOrCreateClient(p.client, { defaultRate: p.hourlyRate }, database)
      clientId = client.id!
      clientIds.set(clientKey, clientId)
      summary.clients.push(client.name)
    }
    let projectId: number | undefined
    if (p.project) {
      const pk = `${clientId}:${p.project.toLowerCase()}`
      projectId = projectIds.get(pk)
      if (projectId == null) {
        projectId = (await findOrCreateProject(clientId, p.project, {}, database)).id!
        projectIds.set(pk, projectId)
      }
    }
    rows.push({
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      durationMin: p.durationMin,
      clientId,
      projectId,
      hourlyRate: p.hourlyRate,
      amount: p.amount,
      comments: p.comments,
      isBilled: p.isBilled,
      invoiceDate: p.invoiceDate,
      invoiceRef: p.invoiceRef,
      billable: p.billable === false ? false : undefined,
      billedMin: p.billedMin,
      category: p.category,
      source: 'import',
      importKey: p.importKey,
      createdAt: now,
      updatedAt: now,
    })
  }
  if (rows.length) await database.entries.bulkAdd(rows)
  summary.added = rows.length
  return summary
}
