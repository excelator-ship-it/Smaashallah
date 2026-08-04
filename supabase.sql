-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- One tiny key/value table holds the whole app's shared state.

create table if not exists public.kv (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

alter table public.kv enable row level security;

-- Small private group tool: allow anyone with the site to read & write.
-- (See the README "Security" note for locking this down further.)
create policy "kv read"   on public.kv for select using (true);
create policy "kv insert" on public.kv for insert with check (true);
create policy "kv update" on public.kv for update using (true) with check (true);
