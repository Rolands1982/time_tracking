# Upwork integration plan

Status: proposal, 2026-11-02. Nothing in this document is built yet.

## Goal

Every hour worked ends up in the app, including Upwork work, so reports, customer summaries, analysis and the
monthly hours report for the tax authority cover everything. For Upwork work the app must show, per entry and
in totals:

| Figure            | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| Gross (USD)       | what the client was charged: hours × contract rate, or the milestone sum |
| Upwork fee (USD)  | the service fee Upwork deducted for that work (weekly, usually 10 %)     |
| Net (USD)         | gross − fee                                                              |
| Net (EUR)         | net converted at the rate of the payout that actually paid for the work  |

Fixed-price contracts have no logged hours, so the user enters an estimate of hours worked per milestone and the
app treats the milestone like a block of hours.

## What Upwork offers, and what each path is good for

1. **Official Upwork MCP server** (remote, `mcp.upwork.com/mcp`, OAuth 2.1, launched August 2026). Built for AI
   assistants: for freelancers it covers contracts, logged time, earnings and balance. It is **not** callable from
   the PWA in the browser; it is callable by Claude once the user adds it as a connector in claude.ai. That makes it
   the right tool for *assistant-driven* updates: Claude pulls the week's time and transactions and hands the app an
   import file, exactly like the Excel merge was done.
2. **Upwork GraphQL API** (`api.upwork.com/graphql`, OAuth 2.0 authorization code, scopes such as earnings and time
   reports). Needs a registered API application (client id + secret, approval by Upwork) and a server to hold the
   secret and refresh tokens. We already have that shape: a Supabase Edge Function, like `send-mail`. This is the
   path for *automatic* weekly sync without Claude in the loop.
3. **CSV exports** from Upwork → Reports: *Transaction history* (rows such as Hourly, Fixed Price, Service Fee,
   VAT for Service Fee, Withdrawal, Withdrawal Fee; filter by date, type, contract; up to about five years back)
   and the weekly *time report / work diary*. No credentials, no server, works offline, and it is the same
   header-driven import pattern the app already uses for Excel. This is the path for the **historical backfill**
   and the safe first version.

Recommendation: build the data model and the fee/FX logic once, feed it first from CSV (stage 1–3), then add
automation (stage 4) on top of the same import path. The MCP connector can be used from stage 1 on for
convenience; the API automation comes last because it has the most moving parts outside our control.

## Facts to confirm before building (stage 0)

These could not be verified from the development container (upwork.com is not reachable from it). The user can
settle them in ten minutes with one sample export and a look at their account:

- Exact column names of the Transaction history CSV and of the weekly time report CSV. The importer is header
  driven, so this only shapes the alias table, but we need one real file of each (a short date range is enough).
- Where the currency conversion happens: does Upwork pay out to a EUR bank account (Upwork sets the rate, and the
  Withdrawal row shows USD while the bank statement shows EUR), or does the user withdraw USD to Wise/Payoneer and
  convert there? The EUR amount per payout has to come from somewhere: the bank/Wise statement, typed in by hand,
  or an exchange-rate feed as an estimate.
- Whether "VAT for Service Fee" rows appear (they do when no EU VAT number is on file). If they do, they are a cost
  like the fee and are allocated the same way.
- Fee history relevant to the user's contracts. Public record: flat 10 % before 3 May 2016; sliding scale per client
  from 3 May 2016 (20 % on the first 500 USD lifetime billings per client, 10 % up to 10 000 USD, 5 % above);
  flat 10 % for everyone again from 3 May 2023 with a transition for existing contracts. Because the actual fee is a
  row in the transaction history, the fee schedule is only needed to *estimate* the fee of the current, not yet
  settled week.
- Whether Upwork hours were tracked with the desktop tracker (10-minute segments, already "billing-normalised") or
  logged manually. Either way Upwork hours are taken as billed exactly as Upwork shows them: the app's own 15-minute
  rounding does not apply to them.
- How far back the history should go, and the list of Upwork clients and contracts so they can be mapped to the
  app's clients and projects (most will be new clients; some may be existing ones who also hired through Upwork).

## Data model

Additions, all synced (new columns via `alter table … add column if not exists`, new Dexie version 3 for the new
table and indexes):

**Client**: `platform?: 'upwork'` and `upworkClientId?`. Currency stays `USD` for Upwork clients; the EUR view is
derived.

**Project** (= Upwork contract): `upwork?: { contractId: string; type: 'hourly' | 'fixed'; rate?: number }`.
One Upwork contract maps to one project; the contract id makes re-imports idempotent.

**TimeEntry**: `source: 'upwork'` (new value), `externalId` (contract id + date, or milestone id) for idempotency,
`grossAmount` (= `amount`, USD), and the derived, cached settlement fields `fee`, `net`, `payoutId`, `fxRate`,
`netEur`, plus `settlement: 'actual' | 'estimated'`. Fixed-price entries carry `estimatedHours: true`.

**New table `upworkTransactions`**: the raw transaction history, one row per Upwork transaction: `txId`, `date`,
`type` (hourly, fixed, bonus, fee, vat, withdrawal, withdrawalFee, refund, other), `description`, `contractId`,
`clientName`, `amount` (USD, signed), optional `eurAmount` (for payouts, typed in or imported from a bank/Wise
statement), `importKey`. Raw rows are never edited by the allocation; everything else is computed from them, so
a re-import or a corrected payout amount just triggers a recalculation.

**Settings**: `upwork: { feeSchedule: { from: string; percent: number }[]; fxEstimateSource: 'ecb' | 'manual' }`.

## Allocation rules (pure functions, unit-tested, in `src/lib/upwork/`)

1. **Fee allocation.** Upwork charges the fee once per contract and billing week (Monday–Sunday) on the week's
   gross. Each fee row is matched to the entries of the same contract in that week and spread over them in
   proportion to their gross. If a week has entries but no fee row yet (current week), the fee is *estimated* from
   the fee schedule and marked as such; the next import replaces the estimate with the actual row. VAT rows on the
   fee, if present, are allocated the same way.
2. **Payout / FX allocation.** A payout (withdrawal) pays for the oldest unpaid net earnings first (FIFO over net
   amounts by date, across contracts). Each entry gets the `fxRate` of the payout that covered it (`eurAmount /
   amount` of that payout, after the withdrawal fee), so `netEur = net × fxRate`. Earnings not yet covered by a
   payout get an *estimated* rate (ECB reference rate of the entry date, cached per day; or the last known payout
   rate when offline) and are marked estimated. Because allocation is FIFO over the raw rows, a late or partial
   payout simply shifts the boundary; nothing is edited by hand.
3. **Fixed-price milestones.** A fixed-price transaction with no hours shows up on an "Upwork milestones without
   hours" list. The user enters the hours (and optionally a date range to spread them over). The app creates one
   entry per milestone (or per day of the range) with `durationMin` from the estimate, `amount` = milestone gross,
   `hourlyRate` = gross ÷ hours (effective rate), `estimatedHours: true`. Fee and FX allocation then treat it like
   hourly work. Bonuses are handled the same way with zero hours allowed.
4. **Recalculation.** `recalculateUpwork()` runs after every import or edit of a payout amount; it rewrites only the
   cached settlement fields of Upwork entries. Reports read the cached fields, so they stay fast.

## Stages

**Stage 0 — Samples and decisions (user, ~10 min).** Export one Transaction history CSV (a month with a payout) and
one weekly time report CSV; answer the questions above. Output: the alias tables and test fixtures are written from
real headers (synthetic values, as always).

**Stage 1 — Model and CSV import (1 session).** Types, Dexie v3, `supabase/schema.sql`, sync mapping both ways,
backup/restore and master export covering the new table and fields. Importer for both CSV shapes with idempotent
keys, a mapping step (Upwork client → app client, contract → project, created on first import), and an "Upwork"
section on the Data screen. Upwork entries appear everywhere with gross USD; reports show them in USD. Tests: unit
tests on synthetic fixtures, sync tests for the new table, e2e import.

**Stage 2 — Fees and FX (1 session).** Fee allocation, payout FIFO allocation, EUR amounts per payout (typed in
on a payouts list, with import from a bank/Wise CSV if a sample is available), ECB estimate for unpaid work,
recalculation, "estimated" badges. Reports and Entries gain a currency switch (USD gross / USD net / EUR net) and
a fee total; the customer summary stays gross, as Upwork clients see it.

**Stage 3 — Fixed-price milestones (½ session).** The "milestones without hours" list and the entry creation
flow above; estimated-hours badge; the hours report counts them.

**Stage 4 — Automation (1–2 sessions, depends on Upwork approving an API application).**
a) *Assistant path, available immediately:* the user adds the official Upwork MCP server as a connector; Claude
   pulls the week's time report and transactions and produces the import JSON the app already understands.
b) *Automatic path:* Edge Function `upwork-sync` holding the API client secret and the user's refresh token (in a
   Supabase table with row level security), an OAuth callback to connect the account once, and a weekly scheduled
   run (Supabase cron) that pulls time reports and transactions into the cloud tables; the app receives them
   through the existing sync. Manual CSV import stays as the fallback.

**Stage 5 — Analysis and tax report.** Both planned features read the same entries; Upwork rows contribute net EUR
and hours, flagged where estimated.

## Risks and choices made

- FX per payout is an approximation of reality (Upwork does not say which earnings a payout contains). FIFO is
  the standard accounting convention and is explainable; the "estimated" flag makes it clear which figures may
  still move.
- Upwork's fee transition in 2023 and sliding tiers before that only matter for estimating the current week; the
  historical fee is always taken from the actual fee rows.
- The API path depends on Upwork approving an application and on scopes staying available; the CSV path does not,
  which is why it comes first.
- Keeping raw transactions as the source of truth and deriving everything else keeps re-imports safe and lets the
  user correct a payout amount without touching entries.
