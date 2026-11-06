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

Recommendation (updated after inspecting the MCP server): build the data model and the fee/FX logic once and feed
them from the MCP server from the start, because it already returns everything the CSV exports would, in a cleaner
shape. The CSV importer stays an optional fallback. The daily pull is a scheduled Claude task with the connector
attached: the model fetches, a tested script in the repository validates and writes to Supabase as the user, and
the app syncs. The API path (stage 4b) is kept only in case the daily sessions become a nuisance.

## What the Upwork MCP server actually returns (verified 2026-11-02)

The connector was added to claude.ai and inspected read-only from a Claude session. Findings that shape the design:

- **Accounts.** Two: the freelancer account (all contracts, time and money live here) and the agency "Actus BI"
  (no contracts, no transactions). Only the freelancer `org_uid` is needed.
- **Time report** (`get_freelancer_financials` / `list_contracts` action `timesheets`): one row per **contract and
  day** with `dateWorkedOn`, `weekWorkedOn` (Monday), `totalHoursWorked` (decimal hours, 10-minute granularity),
  `totalCharges` (USD), `memo` (often empty), online/offline split, `termId`. **No start and end times.** The
  effective rate is `totalCharges / totalHoursWorked` and it changes over time within a contract (70 USD/h in
  November 2025, 80 USD/h in October 2026 on the same contract), so the rate is taken per row, never from the
  contract. Pages hold at most 10 rows and a range may span at most 53 weeks: a year of two active contracts is
  roughly 50 calls, fine for a daily pull, slow but workable for the backfill.
- **Transactions** (`transactions`, up to 200 rows per call, 53-week range): a clean ledger with `recordId`,
  `accountingSubtype`, `type`, `transactionAmount` (USD, signed), `transactionCreationDate`, contract/client fields.
  Subtypes seen: `Hourly` (one weekly invoice per contract, description `(contractId) Client - 37:10 hrs @ $80.00/hr -
  10/12/2026 - 10/18/2026`), `Service Fee` (one per weekly invoice, description states `Amount x 10% = fee` and the
  contract id), `Withdrawal` ("Direct to Local Bank", USD), `Withdrawal Fee` (0.99 USD), `Membership Fee` and its
  `Payment` (Freelancer Plus). No VAT rows: nothing to allocate there. Fixed-price and bonus rows did not occur in
  the sampled period; their subtypes are to be mapped when they first appear.
- **Payouts are in USD only.** The withdrawal row has no EUR amount and no rate; Upwork converts for the "Direct
  to Local Bank" transfer, so the EUR received is known only from the bank statement or the withdrawal receipt
  e-mail. Hence the payouts list in the app, where the EUR amount is typed in or imported, with an ECB-based
  estimate until then.
- **Summary** (`summary`): per client and job, billed / fee / tax / earned for a period; a good cross-check for
  the allocation (fee equals exactly 10 % of billed in the sample) but not a source of rows.
- **Contracts** (`list_contracts` action `search` with `contract_statuses`): id, title, client organisation,
  start/end dates, status. Eight active contracts at the time of writing; several are long-running
  frameworks with sporadic hours. The contract id appears in every time row and in every fee description, so
  it is the join key everywhere.
- **Job search** (`find_jobs`): keyword and title search with filters (type, rate, experience, client history,
  payment verification, proposals so far), `smart_search` for Upwork's own recommendations with a real date
  filter, and `get` for full details including the client's hiring record. `manage_proposals` drafts a proposal
  as a preview that still needs an explicit confirmation, and submitting costs Connects. Everything needed for
  the job-scout idea, with the human kept on the submit step.

Still to settle with the user: how far back the backfill should go, and whether EUR amounts per payout come from
a bank CSV, the Upwork receipt e-mails, or are typed in.

## Data model

Additions, all synced (new columns via `alter table … add column if not exists`, new Dexie version 3 for the new
table and indexes):

**Client**: `platform?: 'upwork'` and `upworkClientId?`. Currency stays `USD` for Upwork clients; the EUR view is
derived.

**Project** (= Upwork contract): `upwork?: { contractId: string; type: 'hourly' | 'fixed'; rate?: number }`.
One Upwork contract maps to one project; the contract id makes re-imports idempotent.

**TimeEntry** (money columns on every entry, so reports sum in one currency):

| Column         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `currency`     | ISO code of the amounts below, copied from the client when the entry is saved; existing rows get EUR |
| `amount`       | gross in `currency` (unchanged name, so nothing existing breaks)                             |
| `feeAmount`    | platform fee in `currency`; 0 for direct clients                                             |
| `netAmount`    | `amount − feeAmount` in `currency`                                                           |
| `fxRate`       | rate from `currency` to EUR used for this entry; 1 for EUR entries                           |
| `netAmountEur` | `netAmount × fxRate`: the figure analysis and the tax report sum                             |
| `settlement`   | `actual` when fee and rate come from real Upwork rows, `estimated` until then                 |
| `payoutId`     | the withdrawal that paid this entry, for traceability                                        |

Gross in EUR is not stored (`amount × fxRate`, display only). Direct clients get the trivial values: fee 0, net =
gross, rate 1, settlement actual. Reports gain a currency switch: gross in the client's currency, net in the
client's currency, net in EUR across all clients. The customer summary stays gross in the client's currency.

Upwork-specific: `source: 'upwork'` (new value), `externalId` (contract id + date + memo id, or milestone id) for
idempotency. Upwork rows have no clock times: such entries get `timeless: true`, `startTime`/`endTime` are left
as a convention (`00:00` plus the duration) and every screen shows the duration only. `hourlyRate` is the row's
`totalCharges / totalHoursWorked`; `billedMin` equals the real minutes (Upwork has already billed them).
Fixed-price entries carry `estimatedHours: true`.

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
   cached settlement fields (`feeAmount`, `netAmount`, `fxRate`, `netAmountEur`, `settlement`, `payoutId`) of Upwork entries. Reports read the cached fields, so they stay fast.

## Stages

**Stage 0 — Samples and decisions (user, ~10 min).** Export one Transaction history CSV (a month with a payout) and
one weekly time report CSV; answer the questions above. Output: the alias tables and test fixtures are written from
real headers (synthetic values, as always).

**Stage 1 — Model and Upwork import (1 session).** Types, Dexie v3, `supabase/schema.sql`, sync mapping both ways,
backup/restore and master export covering the new table and fields. An import format (`upwork-import.json`:
contracts, daily time rows, transactions as the MCP server returns them) with idempotent keys, a mapping step
(Upwork client → app client, contract → project, created on first import), and an "Upwork" section on the Data
screen that accepts the file. The scripted writer for Supabase (`scripts/upwork-ingest.ts`) uses the same import
code. Backfill: Claude pulls the history through the connector into import files, year by year. Upwork entries
appear everywhere with gross USD; reports show them in USD. Tests: unit tests on synthetic fixtures shaped like
the real rows, sync tests for the new table, e2e import.

**Stage 2 — Fees and FX (1 session; done except the bank-statement import, which waits for a sample).** Fee allocation, payout FIFO allocation, EUR amounts per payout (typed in
on a payouts list, with import from a bank/Wise CSV if a sample is available), ECB estimate for unpaid work,
recalculation, "estimated" badges. Reports and Entries gain a currency switch (USD gross / USD net / EUR net) and
a fee total; the customer summary stays gross, as Upwork clients see it.

**Stage 3 — Fixed-price milestones (built).** `src/lib/upwork/milestones.ts` and the Upwork milestones screen (Data →
"Milestones and bonuses without hours"): one entry per row with the hours suggested from the amount at the client's
rate (else 60 USD/h) and corrected by the user, keyed
`upwork:milestone:<txId>`, settled from its own invoice row; the entry form edits the hours of timeless rows;
Entries and Reports mark estimated hours.

**Stage 4 — Daily automation (½ session, plus secrets on the user's side; built, see `docs/automation/upwork-daily.md`: (a) plus bank credits forwarded by the personal finances app into the `bank_credits` table).**
a) *Scheduled Claude task:* fires daily with the Upwork connector attached, pulls yesterday's time rows and the
   new transactions, runs `scripts/upwork-ingest.ts`, which validates and writes to Supabase signed in as the
   user (e-mail and password from environment secrets, never from the repository), and reports a one-line
   summary. The app picks the rows up through sync.
b) *Fallback without Claude:* Edge Function `upwork-sync` on Upwork's API with a weekly schedule. Only if (a)
   proves too costly or unreliable; it needs an approved API application.

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
