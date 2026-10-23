/** Writes the synthetic "old format" workbook to the path given as the first argument. */
import { writeFile } from 'node:fs/promises'
import { buildFixtureWorkbook } from '../unit/fixtures'

const out = process.argv[2]
if (!out) throw new Error('usage: make-fixture <out.xlsx>')
await writeFile(out, await buildFixtureWorkbook())
