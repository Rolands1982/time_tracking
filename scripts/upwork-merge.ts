/**
 * Merge several Upwork pull files (JSON as produced from the Upwork MCP server) into one import file
 * for the app's Data → Upwork section. Later files win on equal keys.
 *
 *   node --import tsx scripts/upwork-merge.ts out.json pull-2024.json pull-2025.json …
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { isUpworkImportFile, mergeUpworkFiles, type UpworkImportFile } from '../src/lib/upwork/import'

const [out, ...inputs] = process.argv.slice(2)
if (!out || !inputs.length) {
  console.error('usage: upwork-merge.ts <out.json> <pull.json> [more pulls…]')
  process.exit(1)
}
const files: UpworkImportFile[] = inputs.map((p) => {
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
  if (!isUpworkImportFile(parsed)) throw new Error(`${p}: not an Upwork import file`)
  return parsed
})
const merged = mergeUpworkFiles(files)
writeFileSync(out, JSON.stringify(merged, null, 1))
console.log(`${out}: ${merged.contracts?.length ?? 0} contracts, ${merged.time?.length ?? 0} days, ${merged.transactions?.length ?? 0} transactions`)
