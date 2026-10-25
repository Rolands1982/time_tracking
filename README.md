# Time Tracking

A mobile-first, offline-capable time tracking app that replaces the "one Excel sheet per month" workbooks with a
single master data set. It is a Progressive Web App (PWA): open the URL on your phone, choose *Add to Home Screen*,
and it behaves like a native app, including offline.

## What it does today

- **Entries** with all required fields: date, start time, end time, client, hourly rate, project, comments,
  *is billed*, invoice date, plus an invoice reference, a *billable* flag for work that will never be invoiced,
  and an optional category (e.g. Support / Development, or the project stage).
- **Timer**: tap *Start*, work, tap *Stop & save*. The timer survives closing the app.
- **Billing normalisation**: every record keeps its real minutes, and new records also carry a billed version:
  the start snapped to the nearest 10 minutes and the time in 15-minute steps (a step counts once 5 minutes into
  it: 7–19 min → 15, 20–34 → 30, …). Under 7 minutes stays as real minutes and is marked non-billable. Amounts,
  open balances, statements and the master file use the billed minutes; internal views show both. Historical
  records are never changed. The entry form offers duration choices and shows what will be billed. Switch the
  derivation off under *Data → Settings*.
- **Clients & projects** with default hourly rates (project rate overrides client rate).
- **Entries screen**: month by month, grouped by day, filter by client / billed status, search in comments.
- **Reports**: month / quarter / year / custom range, totals per client, project and month, open (not yet billed)
  amounts per client with a one-tap *Mark billed* that stamps an invoice date. Export an Excel statement for a
  client and period.
- **Customer summary**: pick a client, a period (month / quarter / year / all / custom range) and which entries to
  include (all, not yet billed, billed); the app shows total hours, amount and every entry and exports the same as
  an Excel sheet or a PDF (pdfmake with the Roboto font, loaded on demand), ready to send to the customer:
  download, share from the phone, or e-mail it straight from the app through your own mailbox
  (`supabase/functions/send-mail`, a small Edge Function that talks SMTP; see `supabase/functions/README.md`).
- **Excel import** of the existing workbooks, in English or Latvian (Date / From / Till / Total hours / Earned /
  Project / What is done? / Category / When billed?, or Datums / No / Līdz / Stundas kopā / Summa / Projekts /
  Projekta stadija / Rēķins). Handles dates carried down from the row above, `24:00` end times, the hourly rate
  taken from the *Earned* formula (also when it hides under the hours header), hours typed over the formula,
  `Billed dd/mm/yyyy` and `Aprīlis 2024` style invoice labels, and `Nepiestādāmas` (non-billable) rows.
  Re-importing a file never duplicates rows.
- **Master file export**: one `.xlsx` with every entry and summary sheets (by month, client, client & project,
  invoice, clients).
- **Backup / restore** as JSON. Data is stored on the device (IndexedDB) and works offline.
- **Cloud sync (optional)** to a Supabase (PostgreSQL) project: sign in with e-mail and password, and every device
  shares the same clients, projects and entries. Changes made offline are pushed when back online; deletions and
  conflicts (last writer wins) are handled. The database doubles as the source for Power BI, invoicing and other
  reports (`entries_report` view).

## Planned next

Summaries sent to customers, invoice generation (PDF / e-mail / ERP export), analysis dashboards, and the monthly
worker-hours summary for the tax authority. These build on the same data model; a sync backend will be added when
multi-device or multi-user use is needed.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (vitest)
npm run e2e          # Playwright end-to-end test (builds the app first)
npm run build        # production build in dist/ (PWA assets included)
```

### Merging the old Excel files from the command line

```bash
npm run merge-excel -- --out Master.xlsx --json backup.json \
  "Working_schedule_Polystylex.xlsx" "Other client.xlsx=Other Client:45"
```

Each input is `path[=client name[:default rate]]`. The client name defaults to a guess from the file name; the
rate is only used for rows where the sheet does not reveal one. The JSON file can be restored from the app's
*Data* screen, so historical data can be loaded onto the phone in one step. Importing the `.xlsx` files directly
in the app works too.

## Cloud sync setup (Supabase)

1. Create a free project at <https://supabase.com> (choose a region close to you).
2. In the project open *SQL editor*, paste the contents of `supabase/schema.sql` and run it. This creates the
   `clients`, `projects` and `entries` tables with row level security, plus the `entries_report` view.
3. *Authentication → Providers*: keep *Email* enabled. Optionally turn off *Confirm email* for a single-user setup.
4. Copy the *Project URL* and the *anon public* key from *Project settings → API*.
5. Put both into `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) so the published app has them built in. The
   publishable key is safe to commit: it only identifies the project, access is governed by sign-in and row level
   security. A different project can still be entered per device under *Data → Cloud sync*.
6. In the app create the account (e-mail + password), sign in, and press *Sync now*. Restore the historical backup on
   one device before or after; it is pushed on the next sync.

Power BI, Excel or any SQL tool can connect with the *Session pooler* connection string from
*Project settings → Database* and read `entries_report`.

## Deployment

`.github/workflows/ci.yml` runs the tests and publishes the app to GitHub Pages on every push to `main`
(enable *Settings → Pages → Source: GitHub Actions* once). The build sets `BASE_PATH=/time_tracking/`; set it
to `/` when hosting at a domain root.

## Project layout

```
src/db        Dexie (IndexedDB) schema, types, repository functions (entries, timer, billing, reporting)
src/lib       pure helpers: time/money, Excel import & master-file export, JSON backup
src/pages     Timer, Entries, Entry form, Reports, Customer summary, Clients, Data (import/export/settings)
scripts       merge-excel.ts command-line consolidation of old workbooks
tests/unit    vitest tests (importer against a synthetic workbook in the old format, DB logic, export round trip)
tests/e2e     Playwright smoke test on a phone-sized viewport
```
