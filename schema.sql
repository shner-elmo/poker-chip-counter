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
  id          uuid        primary key default gen_random_uuid(),
  game_id     text        not null references games(id) on delete cascade,
  name        text        not null,
  created_at  timestamptz not null default now()
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
-- ============================================================

alter table games         enable row level security;
alter table denominations enable row level security;
alter table players       enable row level security;
alter table player_chips  enable row level security;
alter table buyins        enable row level security;
alter table chat_messages enable row level security;

create policy "public_games"         on games         for all to anon, authenticated using (true) with check (true);
create policy "public_denominations" on denominations for all to anon, authenticated using (true) with check (true);
create policy "public_players"       on players       for all to anon, authenticated using (true) with check (true);
create policy "public_player_chips"  on player_chips  for all to anon, authenticated using (true) with check (true);
create policy "public_buyins"        on buyins        for all to anon, authenticated using (true) with check (true);
create policy "public_chat"          on chat_messages for all to anon, authenticated using (true) with check (true);

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
