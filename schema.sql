-- ============================================================
-- Poker Chip Counter — Supabase Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Games
create table if not exists games (
  id          text        primary key,   -- 6-char code e.g. "AB3X7K"
  created_at  timestamptz not null default now()
);

-- 2. Chip denominations
create table if not exists denominations (
  id          uuid        primary key default gen_random_uuid(),
  game_id     text        not null references games(id) on delete cascade,
  label       text        not null,
  color       text        not null default '#ffffff',
  value       numeric     not null,
  sort_order  int         not null default 0
);

create index if not exists denominations_game_id_idx on denominations(game_id);

-- 3. Players
create table if not exists players (
  id           uuid        primary key default gen_random_uuid(),
  game_id      text        not null references games(id) on delete cascade,
  name         text        not null,
  auth_user_id uuid        not null references auth.users(id),  -- ties row to the browser session
  created_at   timestamptz not null default now()
);

create index if not exists players_game_id_idx on players(game_id);

-- 4. Chip counts (one row per player × denomination)
--    game_id is denormalized here so realtime filters can use it directly.
create table if not exists player_chips (
  player_id       uuid    not null references players(id)       on delete cascade,
  denomination_id uuid    not null references denominations(id) on delete cascade,
  game_id         text    not null references games(id)         on delete cascade,
  count           int     not null default 0,
  primary key (player_id, denomination_id)
);

create index if not exists player_chips_game_id_idx on player_chips(game_id);

-- 5. Buy-ins (one row per buy-in event)
create table if not exists buyins (
  id          uuid        primary key default gen_random_uuid(),
  player_id   uuid        not null references players(id) on delete cascade,
  game_id     text        not null references games(id)   on delete cascade,
  amount      numeric     not null,
  created_at  timestamptz not null default now()
);

create index if not exists buyins_game_id_idx on buyins(game_id);

-- 6. Chat messages
create table if not exists chat_messages (
  id          uuid        primary key default gen_random_uuid(),
  game_id     text        not null references games(id) on delete cascade,
  player_name text        not null,
  message     text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_game_id_idx on chat_messages(game_id);

-- ============================================================
-- Row Level Security
--
-- All users sign in anonymously on page load (app.js: ensureAuth).
-- This gives every browser session a real JWT and an auth.uid(),
-- so every policy targets the `authenticated` role only.
--
-- Write rules:
--   games       → any authenticated user can create a game
--   players     → any authenticated user can join, but auth_user_id must equal their own uid
--   everything  → only game members (players rows with matching auth_user_id) can write
-- ============================================================

alter table games         enable row level security;
alter table denominations enable row level security;
alter table players       enable row level security;
alter table player_chips  enable row level security;
alter table buyins        enable row level security;
alter table chat_messages enable row level security;

-- ── games ────────────────────────────────────────────────────────────
create policy "games_select" on games
  for select to authenticated using (true);

create policy "games_insert" on games
  for insert to authenticated with check (true);

-- ── players ──────────────────────────────────────────────────────────
create policy "players_select" on players
  for select to authenticated using (true);

-- Users can only insert a player row tied to their own auth uid.
create policy "players_insert" on players
  for insert to authenticated
  with check (auth_user_id = auth.uid());

-- ── Helper: is the current user a member of a given game? ─────────────
-- Used inline in the policies below.

-- ── denominations ────────────────────────────────────────────────────
create policy "denoms_select" on denominations
  for select to authenticated using (true);

create policy "denoms_insert" on denominations
  for insert to authenticated
  with check (
    exists (
      select 1 from players
      where players.game_id = denominations.game_id
        and players.auth_user_id = auth.uid()
    )
  );

create policy "denoms_delete" on denominations
  for delete to authenticated
  using (
    exists (
      select 1 from players
      where players.game_id = denominations.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ── player_chips ─────────────────────────────────────────────────────
create policy "chips_select" on player_chips
  for select to authenticated using (true);

-- Covers both INSERT and the UPDATE half of upsert.
create policy "chips_write" on player_chips
  for all to authenticated
  using (
    exists (
      select 1 from players
      where players.game_id = player_chips.game_id
        and players.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from players
      where players.game_id = player_chips.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ── buyins ────────────────────────────────────────────────────────────
create policy "buyins_select" on buyins
  for select to authenticated using (true);

create policy "buyins_insert" on buyins
  for insert to authenticated
  with check (
    exists (
      select 1 from players
      where players.game_id = buyins.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ── chat_messages ─────────────────────────────────────────────────────
create policy "chat_select" on chat_messages
  for select to authenticated using (true);

create policy "chat_insert" on chat_messages
  for insert to authenticated
  with check (
    exists (
      select 1 from players
      where players.game_id = chat_messages.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ============================================================
-- Realtime
-- ============================================================

alter publication supabase_realtime add table games;
alter publication supabase_realtime add table denominations;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table player_chips;
alter publication supabase_realtime add table buyins;
alter publication supabase_realtime add table chat_messages;

-- ============================================================
-- Optional: auto-delete games older than 7 days
-- Requires the pg_cron extension (Supabase Pro plan).
-- ============================================================
-- select cron.schedule(
--   'delete-old-games',
--   '0 3 * * *',
--   $$delete from games where created_at < now() - interval '7 days'$$
-- );
