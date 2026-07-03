-- ASD Project Hub — Supabase schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor > New query).

create table if not exists app_data (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security
alter table app_data enable row level security;

-- This app has no server-side auth (login is a simple PIN picker for identity,
-- not a security boundary) — so we allow the anon key full read/write access.
-- Anyone with the deployed URL can read/write data. That's an accepted tradeoff
-- for a small internal team tool. If you need real access control later, add
-- Supabase Auth and tighten these policies to check auth.uid().
create policy "Allow anon read" on app_data
  for select using (true);

create policy "Allow anon write" on app_data
  for insert with check (true);

create policy "Allow anon update" on app_data
  for update using (true);

-- Enable Realtime so all team members see live updates
alter publication supabase_realtime add table app_data;
