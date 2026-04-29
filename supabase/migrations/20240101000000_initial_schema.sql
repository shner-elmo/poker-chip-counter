-- ============================================================
-- Poker Chip Counter — Initial Schema
-- Applied automatically via: supabase db push
-- ============================================================

-- 1. Games
create table if not exists games (
  id          text        primary key,
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
  auth_user_id uuid        not null references auth.users(id),
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
  id           uuid        primary key default gen_random_uuid(),
  game_id      text        not null references games(id) on delete cascade,
  player_name  text        not null,
  auth_user_id uuid        not null references auth.users(id),
  message      text        not null,
  created_at   timestamptz not null default now()
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

-- ── games ────────────────────────────────────────────────────────────
do $$ begin
  create policy "games_select" on games
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "games_insert" on games
    for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;

-- ── players ──────────────────────────────────────────────────────────
do $$ begin
  create policy "players_select" on players
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "players_insert" on players
    for insert to authenticated
    with check (auth_user_id = auth.uid());
exception when duplicate_object then null; end $$;

-- ── denominations ────────────────────────────────────────────────────
do $$ begin
  create policy "denoms_select" on denominations
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "denoms_insert" on denominations
    for insert to authenticated
    with check (
      exists (
        select 1 from players
        where players.game_id = denominations.game_id
          and players.auth_user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "denoms_delete" on denominations
    for delete to authenticated
    using (
      exists (
        select 1 from players
        where players.game_id = denominations.game_id
          and players.auth_user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

-- ── player_chips ─────────────────────────────────────────────────────
do $$ begin
  create policy "chips_select" on player_chips
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
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
exception when duplicate_object then null; end $$;

-- ── buyins ────────────────────────────────────────────────────────────
do $$ begin
  create policy "buyins_select" on buyins
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "buyins_insert" on buyins
    for insert to authenticated
    with check (
      exists (
        select 1 from players
        where players.game_id = buyins.game_id
          and players.auth_user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

-- ── chat_messages ─────────────────────────────────────────────────────
do $$ begin
  create policy "chat_select" on chat_messages
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "chat_insert" on chat_messages
    for insert to authenticated
    with check (
      auth_user_id = auth.uid()
      AND exists (
        select 1 from players
        where players.game_id = chat_messages.game_id
          and players.auth_user_id = auth.uid()
          and players.name = chat_messages.player_name
      )
      AND NOT EXISTS (
        select 1 from chat_messages recent
        where recent.game_id = chat_messages.game_id
          and recent.auth_user_id = auth.uid()
          and recent.created_at > now() - interval '3 seconds'
      )
    );
exception when duplicate_object then null; end $$;

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
