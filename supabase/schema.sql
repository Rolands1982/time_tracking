-- Time Tracking: cloud schema for Supabase (PostgreSQL).
-- Run this once in the Supabase SQL editor of a fresh project. It is idempotent.
--
-- Every row belongs to the signed-in user (user_id = auth.uid()); row level security
-- makes other users' rows invisible. Deletes are soft (deleted_at) so that other
-- devices can learn about them. synced_at is set by the server on every write and is
-- what devices use as their incremental pull cursor; updated_at is the device clock
-- and is used to resolve conflicts (last writer wins).

create extension if not exists pgcrypto;

create or replace function public.set_synced_at()
returns trigger language plpgsql as $$
begin
  new.synced_at := now();
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ clients
create table if not exists public.clients (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null,
  default_rate  numeric(12, 2) not null default 0,
  currency      text not null default 'EUR',
  email         text,
  notes         text,
  archived      boolean not null default false,
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists clients_user_synced on public.clients (user_id, synced_at);
drop trigger if exists clients_synced_at on public.clients;
create trigger clients_synced_at before insert or update on public.clients
  for each row execute function public.set_synced_at();

-- ------------------------------------------------------------------ projects
create table if not exists public.projects (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id     uuid not null references public.clients (id) on delete cascade,
  name          text not null,
  default_rate  numeric(12, 2),
  archived      boolean not null default false,
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists projects_user_synced on public.projects (user_id, synced_at);
create index if not exists projects_client on public.projects (client_id);
drop trigger if exists projects_synced_at on public.projects;
create trigger projects_synced_at before insert or update on public.projects
  for each row execute function public.set_synced_at();

-- ------------------------------------------------------------------ entries
create table if not exists public.entries (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date          date not null,
  start_time    time not null,
  end_time      time not null,
  duration_min  integer not null,
  client_id     uuid not null references public.clients (id) on delete cascade,
  project_id    uuid references public.projects (id) on delete set null,
  hourly_rate   numeric(12, 2) not null default 0,
  amount        numeric(12, 2) not null default 0,
  comments      text not null default '',
  is_billed     boolean not null default false,
  invoice_date  date,
  invoice_ref   text,
  billable      boolean not null default true,
  billed_start_time time,
  billed_end_time   time,
  billed_min    integer,
  category      text,
  source        text not null default 'manual',
  import_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  deleted_at    timestamptz
);
-- Columns added after the first release (no-ops on a fresh schema).
alter table public.entries add column if not exists billed_start_time time;
alter table public.entries add column if not exists billed_end_time time;
alter table public.entries add column if not exists billed_min integer;
create index if not exists entries_user_synced on public.entries (user_id, synced_at);
create index if not exists entries_user_date on public.entries (user_id, date);
create index if not exists entries_client on public.entries (client_id);
drop trigger if exists entries_synced_at on public.entries;
create trigger entries_synced_at before insert or update on public.entries
  for each row execute function public.set_synced_at();

-- ------------------------------------------------------------------ row level security
alter table public.clients  enable row level security;
alter table public.projects enable row level security;
alter table public.entries  enable row level security;

drop policy if exists "own clients"  on public.clients;
drop policy if exists "own projects" on public.projects;
drop policy if exists "own entries"  on public.entries;

create policy "own clients"  on public.clients  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own projects" on public.projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own entries"  on public.entries  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------ reporting view (Power BI, SQL)
create or replace view public.entries_report
with (security_invoker = true) as
select e.id,
       e.date,
       e.start_time,
       e.end_time,
       e.duration_min,
       round(e.duration_min / 60.0, 2) as hours,
       e.billed_start_time,
       e.billed_end_time,
       coalesce(e.billed_min, e.duration_min) as billed_min,
       round(coalesce(e.billed_min, e.duration_min) / 60.0, 2) as billed_hours,
       c.name  as client,
       p.name  as project,
       e.category,
       e.hourly_rate,
       e.amount,
       e.comments,
       e.is_billed,
       e.invoice_date,
       e.invoice_ref,
       e.billable,
       e.source,
       to_char(e.date, 'YYYY-MM') as month
from public.entries e
join public.clients c on c.id = e.client_id
left join public.projects p on p.id = e.project_id
where e.deleted_at is null;
