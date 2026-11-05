-- Run this once in Supabase: SQL Editor > New query > paste > Run.

create table if not exists public.sessions (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  seconds     integer not null check (seconds > 0),
  category    text not null,
  note        text not null default '',
  preset      text not null default '',
  completed   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_started on public.sessions (user_id, started_at desc);

create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  goal_hours  numeric not null default 3.5,
  categories  jsonb,
  presets     jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.sessions enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
