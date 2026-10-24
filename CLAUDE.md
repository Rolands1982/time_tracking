# CLAUDE.md

Guidance for Claude (and people) working in this repository. Read `README.md` for the feature overview.

## What this is

A mobile-first, offline-capable time tracking PWA for a freelancer: entries per client/project with hourly rates,
billing status and invoice data; a timer; reports; Excel import of historical sheets; master-file export; optional
cloud sync to a Supabase (PostgreSQL) project. Published to GitHub Pages from `main`.

Planned next: customer summaries, invoice generation (PDF / e-mail / ERP export), analysis, and the monthly hours
report for the tax authority.

## Workflow rules

- **Never push to `main`.** Every push to `main` deploys the live app. Work on a branch, open a pull request, let CI
  pass, and the repository owner merges.
- Before pushing, run what CI runs: `npm run lint`, `npm test`, `npm run build`. Run `npm run e2e` when UI flows
  change (Playwright, Chromium; in the cloud container set `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium`).
- Keep pull requests focused: one feature or fix per PR, with tests for new logic.
- Commit messages: short imperative subject, body explaining why when it is not obvious.
- A follow-up after a merged PR starts from a fresh `main`; never stack commits on merged history.

## Privacy rules

- The repository is **public**. Never commit client data: no Excel sheets, no backups, no exports, no screenshots
  with client names. `backups/`, `data/`, `Master*.xlsx` and `time-tracking-backup*.json` are git-ignored on
  purpose; keep it that way.
- Test fixtures are synthetic (`tests/unit/fixtures.ts` builds workbooks in memory). Do not add real files as
  fixtures.
- The Supabase publishable key in `.env` is meant to be public; the service-role key and database password are
  not and must never appear in the repository.

## Architecture

```
src/db        Dexie (IndexedDB) schema v2, types, repository functions (entries, timer, billing, reporting)
src/sync      cloud sync: engine (pull then push), remote interface + Supabase implementation, React hook
src/lib       pure helpers: time/money, Excel import & master export (ExcelJS, lazy-loaded), JSON backup
src/pages     Timer, Entries, Entry form, Reports, Clients, Data (import/export/backup/cloud sync/settings)
src/components Bottom navigation, client/project picker, toast, cloud sync card
scripts       merge-excel.ts: consolidate historical workbooks from the command line (same importer as the app)
supabase      schema.sql: cloud tables, row level security, synced_at trigger, entries_report view
tests/unit    vitest (fake-indexeddb); tests/e2e: Playwright smoke test on a phone viewport
```

Conventions that matter:

- Dates are `YYYY-MM-DD` strings, times `HH:mm`; an end time ≤ start time means the entry crosses midnight.
  Use helpers in `src/lib/time.ts`; do not hand-roll date math.
- `durationMin` and `amount` are derived and cached; always create/update entries through `src/db/repo.ts`
  (`addEntry`, `updateEntry`, `setBilled`, `deleteEntry`) so derived fields, sync flags and tombstones stay right.
- `billable === false` marks work never to be invoiced; `undefined` means billable. Use `isBillable()`.
- **Billing normalisation** (`src/lib/rounding.ts`): records keep real `startTime`/`endTime`/`durationMin`. New
  records also get `billedStartTime`/`billedEndTime`/`billedMin`: start snapped to the nearest 10 minutes, minutes
  in 15-minute steps counting a step once 5 minutes into it (7–19 → 15, 20–34 → 30, …); under 7 minutes stays as
  is and is marked non-billable. `amount`, open balances, statements and the master file use `billedMinutes(e)`
  (= `billedMin ?? durationMin`), so records from before the rules are billed at their real minutes and are never
  rewritten. `settings.roundingMode = 'exact'` stops deriving the columns for new records.
- Every synced record has `uid` (UUID shared with the cloud) and `dirty`; local numeric `id`s never leave the
  device. Dexie hooks set these; writes made by the sync engine go through `db.remoteTransaction()` to bypass them.
- Deleting a synced record must go through `db.deleteSynced()` so a tombstone is recorded.
- Excel import is header-driven (English and Latvian aliases in `importWorkbook.ts`) and idempotent via
  `importKey`. New sheet layouts get an alias and a fixture sheet plus a test, not a special case in the UI.
- Heavy libraries (ExcelJS, Supabase client) are imported dynamically; keep the main bundle small.

## Changing the data model

1. Add the field to `src/db/types.ts`, the repo functions, the Excel export/import and the backup if relevant.
2. If it must sync: add the column to `supabase/schema.sql` (idempotent `alter table … add column if not exists`),
   map it in `src/sync/engine.ts` both directions, and extend `tests/unit/sync.test.ts`.
3. Note in the PR description that the SQL has to be run in the Supabase SQL editor **before** the merge deploys.
4. Local Dexie index changes need a new `this.version(n)` in `src/db/schema.ts`; never edit a released version.

## Deployment facts

- CI (`.github/workflows/ci.yml`): lint, unit tests, build, Playwright e2e, then Pages deploy on `main`.
- The app lives at `https://rolands1982.github.io/time_tracking/` (base path `/time_tracking/`).
- Pages must be enabled with source "GitHub Actions" (done). The `configure-pages` step is non-fatal.
- The Supabase project URL and publishable key come from `.env`; the schema is applied manually from
  `supabase/schema.sql`.
