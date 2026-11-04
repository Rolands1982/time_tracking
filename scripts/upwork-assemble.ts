/**
 * Build an Upwork import file from raw MCP server responses saved verbatim, one response per file
 * (list_contracts, timesheets pages, transactions). Overlapping pulls are fine: later rows win.
 *
 *   node --import tsx scripts/upwork-assemble.ts out.json raw/*.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { assembleImportFile } from '../src/lib/upwork/assemble'

const [out, ...inputs] = process.argv.slice(2)
if (!out || !inputs.length) {
  console.error('usage: upwork-assemble.ts <out.json> <raw response files…>')
  process.exit(1)
}
const { counts, ...file } = assembleImportFile(inputs.map((p) => readFileSync(p, 'utf8')))
writeFileSync(out, JSON.stringify(file))
console.log(`${out}: ${counts.contracts} contracts, ${counts.time} time rows, ${counts.transactions} transactions from ${counts.files} responses`)
