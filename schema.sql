-- ============================================================
-- Poker Chip Counter — Supabase Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Games table
--    Stores the entire game state as a JSON blob.
--    Each row is one poker session, keyed by a 6-char game ID.
create table if not exists games (
  id          text        primary key,
  state       jsonb       not null default '{"denominations":[],"players":{}}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. Chat messages table
--    Separate table so messages can be appended without
--    touching the main game state blob.
create table if not exists chat_messages (
  id           uuid        primary key default gen_random_uuid(),
  game_id      text        not null references games(id) on delete cascade,
  player_name  text        not null,
  message      text        not null,
  created_at   timestamptz not null default now()
);

create index if not exists chat_messages_game_id_idx on chat_messages(game_id);

-- ============================================================
-- Row Level Security
-- The anon key is public, so RLS is the only guard against
-- abuse.  These policies are intentionally permissive for a
-- demo app; tighten them once you add authentication.
-- ============================================================

alter table games         enable row level security;
alter table chat_messages enable row level security;

-- Anyone can read / write games (game IDs are hard to guess —
-- 6 chars from a 32-symbol alphabet = ~1 billion combinations).
create policy "public_games"
  on games for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "public_chat"
  on chat_messages for all
  to anon, authenticated
  using (true)
  with check (true);

-- ============================================================
-- Realtime
-- Enable realtime for both tables so that connected clients
-- receive live updates via WebSocket.
-- You can also enable this in:
--   Dashboard → Database → Replication → supabase_realtime
-- ============================================================

alter publication supabase_realtime add table games;
alter publication supabase_realtime add table chat_messages;

-- ============================================================
-- Optional: auto-delete games older than 7 days
-- Requires the pg_cron extension (Supabase Pro plan).
-- Uncomment if you want automatic cleanup.
-- ============================================================
-- select cron.schedule(
--   'delete-old-games',
--   '0 3 * * *',
--   $$delete from games where created_at < now() - interval '7 days'$$
-- );
