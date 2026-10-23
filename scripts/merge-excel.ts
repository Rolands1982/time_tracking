#!/usr/bin/env node
/**
 * Merge one or more of the old "sheet per month" workbooks into a single master file,
 * without going through the app. Useful for the one-off consolidation of historical files.
 *
 *   npm run merge-excel -- --out Master.xlsx "Working_schedule_Polystylex.xlsx" "Other client.xlsx=Other Client:45"
 *
 * Each input is "path[=client name[:default rate]]". When the client name is omitted it is
 * guessed from the file name; the default rate is only used for rows where the sheet gives none.
 * Add --json out.json to also write a backup file the app can restore.
 * Add --billed-before 2023-06-01 to mark rows older than that date as billed when their sheet has no billing column.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { applyBilledBefore, guessClientName, parseWorkbook, type ParsedEntry } from '../src/lib/excel/importWorkbook'
import { buildMasterWorkbook } from '../src/lib/excel/exportMaster'
import type { Backup } from '../src/lib/backup'
import type { Client, Project, TimeEntry } from '../src/db/types'

interface Input {
  path: string
  client: string
  rate: number
}

function parseArgs(argv: string[]) {
  const inputs: Input[] = []
  let out = 'Master_time_tracking.xlsx'
  let json: string | undefined
  let defaultRate = 0
  let billedBefore: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out = argv[++i]
    else if (a === '--json') json = argv[++i]
    else if (a === '--rate') defaultRate = Number(argv[++i])
    else if (a === '--billed-before') billedBefore = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('usage: merge-excel [--out Master.xlsx] [--json backup.json] [--rate 50] [--billed-before YYYY-MM-DD] file.xlsx[=Client[:rate]] ...')
      process.exit(0)
    } else {
      const [path, spec = ''] = a.split('=')
      const [client, rate] = spec.split(':')
      inputs.push({ path, client: client || guessClientName(basename(path)), rate: rate ? Number(rate) : defaultRate })
    }
  }
  if (!inputs.length) throw new Error('no input files given (use --help)')
  if (billedBefore && !/^\d{4}-\d{2}-\d{2}$/.test(billedBefore)) throw new Error('--billed-before expects YYYY-MM-DD')
  return { inputs, out, json, billedBefore }
}

export function toMasterData(parsed: ParsedEntry[]): { entries: TimeEntry[]; clients: Client[]; projects: Project[] } {
  const clients: Client[] = []
  const projects: Project[] = []
  const entries: TimeEntry[] = []
  const seen = new Set<string>()
  const now = new Date().toISOString()
  for (const p of parsed) {
    if (seen.has(p.importKey)) continue
    seen.add(p.importKey)
    let client = clients.find((c) => c.name.toLowerCase() === p.client.toLowerCase())
    if (!client) {
      client = { id: clients.length + 1, name: p.client, defaultRate: p.hourlyRate, currency: 'EUR' }
      clients.push(client)
    }
    let project: Project | undefined
    if (p.project) {
      project = projects.find((x) => x.clientId === client!.id && x.name.toLowerCase() === p.project!.toLowerCase())
      if (!project) {
        project = { id: projects.length + 1, clientId: client.id!, name: p.project }
        projects.push(project)
      }
    }
    entries.push({
      id: entries.length + 1,
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      durationMin: p.durationMin,
      clientId: client.id!,
      projectId: project?.id,
      hourlyRate: p.hourlyRate,
      amount: p.amount,
      comments: p.comments,
      isBilled: p.isBilled,
      invoiceDate: p.invoiceDate,
      invoiceRef: p.invoiceRef,
      billable: p.billable === false ? false : undefined,
      category: p.category,
      source: 'import',
      importKey: p.importKey,
      createdAt: now,
      updatedAt: now,
    })
  }
  // Latest rate seen for a client becomes its default.
  for (const c of clients) {
    const latest = [...entries].filter((e) => e.clientId === c.id).sort((a, b) => b.date.localeCompare(a.date))[0]
    if (latest) c.defaultRate = latest.hourlyRate
  }
  return { entries, clients, projects }
}

async function main() {
  const { inputs, out, json, billedBefore } = parseArgs(process.argv.slice(2))
  const all: ParsedEntry[] = []
  for (const input of inputs) {
    const buf = await readFile(input.path)
    const result = await parseWorkbook(new Uint8Array(buf), { clientName: input.client, defaultRate: input.rate })
    console.log(`${input.path} → client "${input.client}": ${result.entries.length} entries from ${result.sheets.filter((s) => s.imported).length} sheets`)
    for (const s of result.sheets) if (s.reason && s.reason !== 'skipped by user') console.log(`  - sheet "${s.name}" ignored: ${s.reason}`)
    for (const w of result.warnings) console.log(`  ! ${w}`)
    if (billedBefore) {
      const n = applyBilledBefore(result.entries, billedBefore)
      if (n) console.log(`  marked ${n} rows before ${billedBefore} as billed (sheets without a billing column)`)
    }
    all.push(...result.entries)
  }
  const data = toMasterData(all)
  const wb = buildMasterWorkbook(data)
  await wb.xlsx.writeFile(out)
  const hours = data.entries.reduce((s, e) => s + e.durationMin, 0) / 60
  const amount = data.entries.reduce((s, e) => s + e.amount, 0)
  console.log(`\nWrote ${out}: ${data.entries.length} entries, ${hours.toFixed(2)} h, ${amount.toFixed(2)} total, ${data.clients.length} client(s), ${data.projects.length} project(s)`)
  if (json) {
    const backup: Backup = { app: 'time-tracking', version: 1, exportedAt: new Date().toISOString(), ...data }
    await writeFile(json, JSON.stringify(backup, null, 1))
    console.log(`Wrote ${json} (restore it from the app's Data screen)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
