/**
 * Turn raw Upwork MCP server responses (saved verbatim, one per file) into one import file. The daily
 * session pastes what the connector returned; the shapes are found wherever they sit in the JSON:
 *   list_contracts        → objects with id, title and clientOrganization
 *   timesheets            → contractTimeReport.edges[] of { cursor, node }
 *   transactions          → transactionHistory…transactionHistoryRow[]
 * Later rows win on equal keys, so pulls may overlap.
 */
import type { UpworkContractRow, UpworkImportFile, UpworkTimeRow, UpworkTxRow } from './import'
import { timeRowKey } from './import'

type Json = Record<string, unknown>

/** The first JSON value in a text that may carry a prefix or suffix (tool result wrappers, prose). */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error('No JSON found')
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  return JSON.parse(text.slice(start, end + 1))
}

function walk(value: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit))
  else if (value && typeof value === 'object') {
    visit(value as Json)
    for (const v of Object.values(value as Json)) walk(v, visit)
  }
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export function collectContracts(json: unknown): UpworkContractRow[] {
  const out: UpworkContractRow[] = []
  walk(json, (n) => {
    if (typeof n.id !== 'string' && typeof n.id !== 'number') return
    if (typeof n.title !== 'string' || !isObj(n.clientOrganization)) return
    const org = n.clientOrganization
    out.push({
      id: String(n.id),
      title: n.title,
      status: typeof n.status === 'string' ? n.status : undefined,
      startDate: typeof n.startDate === 'string' ? n.startDate.slice(0, 10) : undefined,
      endDate: typeof n.endDate === 'string' ? n.endDate.slice(0, 10) : undefined,
      clientOrganization: { id: org.id != null ? String(org.id) : undefined, name: typeof org.name === 'string' ? org.name : undefined },
    })
  })
  return out
}

export function collectTimeRows(json: unknown): UpworkTimeRow[] {
  const out: UpworkTimeRow[] = []
  walk(json, (n) => {
    if (!Array.isArray(n.edges) || !('contractTimeReport' in n || 'edges' in n)) return
    for (const e of n.edges as unknown[]) {
      if (!isObj(e) || !isObj(e.node)) continue
      const node = e.node
      if (!isObj(node.contract) || typeof node.dateWorkedOn !== 'string') continue
      out.push({
        cursor: typeof e.cursor === 'string' ? e.cursor : undefined,
        contract: { id: String(node.contract.id), title: typeof node.contract.title === 'string' ? node.contract.title : undefined },
        dateWorkedOn: node.dateWorkedOn,
        weekWorkedOn: typeof node.weekWorkedOn === 'string' ? node.weekWorkedOn : undefined,
        totalHoursWorked: Number(node.totalHoursWorked ?? 0),
        totalCharges: Number(node.totalCharges ?? 0),
        memo: typeof node.memo === 'string' ? node.memo : undefined,
        termId: node.termId != null ? String(node.termId) : undefined,
      })
    }
  })
  return out
}

export function collectTransactions(json: unknown): UpworkTxRow[] {
  const out: UpworkTxRow[] = []
  walk(json, (n) => {
    if (!Array.isArray(n.transactionHistoryRow)) return
    for (const r of n.transactionHistoryRow as unknown[]) {
      if (!isObj(r) || r.recordId == null || typeof r.transactionCreationDate !== 'string') continue
      out.push({ ...(r as unknown as UpworkTxRow), recordId: String(r.recordId) })
    }
  })
  return out
}

/** Merge any number of raw responses into one import file. */
export function assembleImportFile(rawTexts: string[], account?: { orgUid?: string; name?: string }): UpworkImportFile & { counts: { contracts: number; time: number; transactions: number; files: number } } {
  const contracts = new Map<string, UpworkContractRow>()
  const time = new Map<string, UpworkTimeRow>()
  const transactions = new Map<string, UpworkTxRow>()
  for (const text of rawTexts) {
    const json = extractJson(text)
    for (const c of collectContracts(json)) contracts.set(c.id, c)
    for (const t of collectTimeRows(json)) time.set(timeRowKey(t), t)
    for (const t of collectTransactions(json)) transactions.set(t.recordId, t)
  }
  return {
    app: 'time-tracking-upwork',
    version: 1,
    exportedAt: new Date().toISOString(),
    account,
    contracts: [...contracts.values()],
    time: [...time.values()].sort((a, b) => (a.cursor ?? '').localeCompare(b.cursor ?? '')),
    transactions: [...transactions.values()].sort((a, b) => a.transactionCreationDate.localeCompare(b.transactionCreationDate)),
    counts: { contracts: contracts.size, time: time.size, transactions: transactions.size, files: rawTexts.length },
  }
}
