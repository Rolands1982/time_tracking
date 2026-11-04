/**
 * Unattended ingest into the cloud database: sign in to Supabase as the user, pull everything into an
 * in-memory copy of the app database, apply an Upwork import file and/or a bank credits CSV with the
 * app's own importer, matcher and settlement, and push the changes back. Devices pick them up by sync.
 *
 *   SUPABASE_EMAIL=… SUPABASE_PASSWORD=… node --import tsx scripts/upwork-ingest.ts [import.json] [--bank credits.csv] [--dry-run] [--no-rates]
 *
 * SUPABASE_URL / SUPABASE_ANON_KEY default to the VITE_ values in .env. The password is read from the
 * environment only: never put it in a file inside the repository.
 */
import 'fake-indexeddb/auto'
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { TimeTrackingDB } from '../src/db/schema'
import { SupabaseRemote } from '../src/sync/remote'
import { parseBankCredits } from '../src/lib/upwork/bankCredits'
import { isUpworkImportFile } from '../src/lib/upwork/import'
import { ingestUpwork } from '../src/lib/upwork/ingest'

function dotenv(): Record<string, string> {
  if (!existsSync('.env')) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args.splice(i, 1).length > 0 : false
  }
  const option = (name: string) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const [, value] = args.splice(i, 2)
    return value
  }
  const dryRun = flag('--dry-run')
  const fetchRates = !flag('--no-rates')
  const bankPath = option('--bank')
  const [filePath] = args
  if (!filePath && !bankPath) {
    console.error('usage: upwork-ingest.ts [import.json] [--bank credits.csv] [--dry-run] [--no-rates]')
    process.exit(1)
  }

  const env = { ...dotenv(), ...process.env }
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY
  const email = env.SUPABASE_EMAIL
  const password = env.SUPABASE_PASSWORD
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY missing (or VITE_ values in .env)')
  if (!email || !password) throw new Error('SUPABASE_EMAIL and SUPABASE_PASSWORD must be set in the environment')

  let file
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (!isUpworkImportFile(parsed)) throw new Error(`${filePath}: not an Upwork import file`)
    file = parsed
  }
  const bankCredits = bankPath ? parseBankCredits(readFileSync(bankPath, 'utf8')) : undefined

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Sign-in failed: ${error.message}`)
  try {
    const db = new TimeTrackingDB(`ingest-${Date.now()}`)
    const summary = await ingestUpwork({ db, remote: new SupabaseRemote(client), file, bankCredits, fetchRates, dryRun })
    console.log(JSON.stringify(summary))
    const i = summary.import
    console.log(
      [
        `pulled ${summary.pulled}`,
        i ? `time rows ${i.entries.added} new / ${i.entries.updated} updated / ${i.entries.removed} removed${i.entries.rekeyed ? ` / ${i.entries.rekeyed} rekeyed` : ''}, transactions ${i.transactions.added} new` : null,
        summary.bank ? `bank credits ${summary.bank.matched} matched (${summary.bank.alreadyPriced} already), ${summary.bank.unmatched} unmatched` : null,
        `settled ${summary.settlement.updated}, ${summary.settlement.estimated} estimated, ${summary.settlement.payoutsWithoutEur} payouts without EUR`,
        summary.rates?.error ? `ECB rates: ${summary.rates.error}` : summary.rates ? `ECB rates ${summary.rates.fetched} new` : null,
        dryRun ? 'dry run, nothing pushed' : `pushed ${summary.pushed}`,
      ]
        .filter(Boolean)
        .join(' · '),
    )
  } finally {
    await client.auth.signOut()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
