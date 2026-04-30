-- ============================================================
-- Idempotently (re)create all RLS policies.
-- Needed because the initial migration was present before the
-- db-migrate workflow existed, so supabase db push had never run.
-- DROP IF EXISTS + CREATE guarantees the correct policy is applied
-- regardless of whether a stale or missing policy exists.
-- ============================================================

-- ── games ────────────────────────────────────────────────────
drop policy if exists "games_select" on games;
create policy "games_select" on games
  for select to authenticated using (true);

drop policy if exists "games_insert" on games;
create policy "games_insert" on games
  for insert to authenticated with check (true);

-- ── players ──────────────────────────────────────────────────
drop policy if exists "players_select" on players;
create policy "players_select" on players
  for select to authenticated using (true);

drop policy if exists "players_insert" on players;
create policy "players_insert" on players
  for insert to authenticated
  with check (auth_user_id = auth.uid());

-- ── denominations ────────────────────────────────────────────
drop policy if exists "denoms_select" on denominations;
create policy "denoms_select" on denominations
  for select to authenticated using (true);

drop policy if exists "denoms_insert" on denominations;
create policy "denoms_insert" on denominations
  for insert to authenticated
  with check (
    exists (
      select 1 from players
      where players.game_id = denominations.game_id
        and players.auth_user_id = auth.uid()
    )
  );

drop policy if exists "denoms_delete" on denominations;
create policy "denoms_delete" on denominations
  for delete to authenticated
  using (
    exists (
      select 1 from players
      where players.game_id = denominations.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ── player_chips ─────────────────────────────────────────────
drop policy if exists "chips_select" on player_chips;
create policy "chips_select" on player_chips
  for select to authenticated using (true);

drop policy if exists "chips_write" on player_chips;
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

-- ── buyins ────────────────────────────────────────────────────
drop policy if exists "buyins_select" on buyins;
create policy "buyins_select" on buyins
  for select to authenticated using (true);

drop policy if exists "buyins_insert" on buyins;
create policy "buyins_insert" on buyins
  for insert to authenticated
  with check (
    exists (
      select 1 from players
      where players.game_id = buyins.game_id
        and players.auth_user_id = auth.uid()
    )
  );

-- ── chat_messages ─────────────────────────────────────────────
drop policy if exists "chat_select" on chat_messages;
create policy "chat_select" on chat_messages
  for select to authenticated using (true);

drop policy if exists "chat_insert" on chat_messages;
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
