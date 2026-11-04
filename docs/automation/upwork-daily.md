# Daily Upwork ingest

A scheduled Claude task pulls the latest Upwork data every morning and writes it into the cloud database,
using the same importer, bank matcher and settlement as the app. Devices pick the rows up through sync;
nothing is uploaded by hand.

## Pieces

- `scripts/upwork-assemble.ts out.json raw/*.json` – merges raw connector responses (saved verbatim, one per
  file: `list_contracts`, `timesheets` pages, `transactions`) into one import file. Overlaps are fine.
- `scripts/upwork-ingest.ts import.json [--bank credits.csv] [--dry-run] [--no-rates]` – signs in to
  Supabase as the user, pulls the cloud copy into an in-memory database, imports, matches bank credits,
  settles (ECB rates fetched for days still estimated), pushes back, prints a one-line summary.
- `src/lib/upwork/ingest.ts` – the logic behind the script, unit-tested against an in-memory cloud.

## One-time setup (owner)

1. Cloud environment → Edit → **Secrets**: `SUPABASE_EMAIL`, `SUPABASE_PASSWORD` (the app login). The
   project URL and publishable key come from `.env`; `SUPABASE_URL` / `SUPABASE_ANON_KEY` override them.
2. Cloud environment → **Network access**: allow the Supabase project host (`*.supabase.co`) and
   `api.frankfurter.dev` (ECB rates; optional, the fallback rate is used when it is unreachable).
3. The scheduled task runs in this environment with the **Upwork** connector attached (added in the claude.ai
   scheduled tasks list; a session started by the task has no connectors otherwise). Sessions it starts come up
   without the repository, so the prompt clones it. Its prompt is below.

First supervised run (4 Nov 2026, from a fresh session with the secrets): signed in, pulled 9,013 rows, imported
5 new time rows and rekeyed 8, pushed 13 rows, nothing duplicated.

## Scheduled task prompt

```
Daily Upwork ingest for the time tracking app (repository Rolands1982/time_tracking). Read docs/automation/upwork-daily.md first once the repository is cloned.

1. If /home/user/time_tracking does not exist: `git clone --depth 50 https://github.com/Rolands1982/time_tracking /home/user/time_tracking`. Then `cd /home/user/time_tracking && npm ci`. Create a folder `raw/` in the scratchpad directory.
2. With the Upwork connector (org_uid 788474464916398081; find it with list_accounts if it fails), fetch:
   a) get_freelancer_financials action "timesheets", params {from_date: <today minus 10 days>, to_date: <today>, limit: 10},
      then follow pageInfo.endCursor with params.cursor until hasNextPage is false. Save EVERY response verbatim,
      one file per call, as raw/time-<n>.json (copy the tool result text exactly, do not retype numbers).
   b) get_freelancer_financials action "transactions", params {from_date: <today minus 21 days>, to_date: <today>, limit: 200}.
      Save as raw/tx.json. If the result was written to a file by the tool, copy that file instead.
   c) list_contracts action "search", params {limit: 25}, following pagination; save each page as raw/contracts-<n>.json.
3. Run: node --import tsx scripts/upwork-assemble.ts <scratchpad>/import.json <scratchpad>/raw/*.json
   It prints the counts; stop and report if it finds 0 time rows AND 0 transactions.
4. Run: node --import tsx scripts/upwork-ingest.ts <scratchpad>/import.json
   SUPABASE_EMAIL and SUPABASE_PASSWORD are environment secrets; never print them. A line "ECB rates: …" with an error is not a failure.
5. Report the script's last line (pulled / new rows / settled / pushed) in one sentence. If any step failed,
   say which and quote the error. Do not commit, push or change the repository; do not retry more than once.
```

Bank credits reach the cloud separately (see `docs/plans/upwork-integration.md`, stage 4); until then, the
`--bank credits.csv` option prices payouts from a statement export.

## Checking on it

- Data → Upwork card: the date range and "N estimated" move forward daily; Payouts: "payouts without EUR".
- The task's run history in the scheduled tasks list shows the one-line summary or the error.
- Consent and rate limits: the Upwork connector is OAuth-authorised once; the daily pull is about ten calls.
