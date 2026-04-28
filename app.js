// ─────────────────────────────────────────────────────────────
//  CONFIGURATION  —  paste your Supabase project credentials below
//  Find them at: https://supabase.com/dashboard → your project → Settings → API
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';       // e.g. https://xxxxxxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';  // safe to expose — security via RLS
// ─────────────────────────────────────────────────────────────

const DEFAULT_DENOMS = [
  { label: 'White', color: '#f0f0f0', value: 1   },
  { label: 'Red',   color: '#e74c3c', value: 5   },
  { label: 'Blue',  color: '#3498db', value: 10  },
  { label: 'Green', color: '#2ecc71', value: 25  },
  { label: 'Black', color: '#2c2c2c', value: 100 },
];

// ── Init ───────────────────────────────────────────────────
const configured = SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
if (!configured) {
  document.getElementById('config-error').classList.remove('hidden');
}

const { createClient } = window.supabase;
const db = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ── App state ──────────────────────────────────────────────
let gameId    = null;
let gameState = null; // { denominations: [{id,label,color,value}], players: {id: {id,name,chips,buyins}} }
let myName    = sessionStorage.getItem('playerName') || '';
let myAuthUid = null;

// ── Utilities ──────────────────────────────────────────────
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function genGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n) {
  return '$' + Number(n).toFixed(2);
}

function chipValue(player, denoms) {
  return denoms.reduce((sum, d) => sum + ((player.chips || {})[d.id] || 0) * d.value, 0);
}

function totalBuyin(player) {
  return (player.buyins || []).reduce((s, b) => s + b, 0);
}

// ── Settlement algorithm ───────────────────────────────────
function calcSettlements(players, denoms) {
  const nets = players.map(p => ({
    name: p.name,
    net:  chipValue(p, denoms) - totalBuyin(p),
  }));

  const creditors = nets.filter(p => p.net >  0.005).sort((a, b) => b.net - a.net);
  const debtors   = nets.filter(p => p.net < -0.005).sort((a, b) => a.net - b.net);
  const txns = [];
  let ci = 0, di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].net, -debtors[di].net);
    txns.push({ from: debtors[di].name, to: creditors[ci].name, amount });
    creditors[ci].net -= amount;
    debtors[di].net   += amount;
    if (creditors[ci].net < 0.005) ci++;
    if (Math.abs(debtors[di].net) < 0.005) di++;
  }

  return txns;
}

// ── Auth ───────────────────────────────────────────────────

// Signs in anonymously if there is no active session.
// Every browser gets a real JWT, which RLS policies require.
// Prerequisite: enable "Anonymous sign-ins" in Supabase Dashboard → Auth → Providers.
async function ensureAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    const { error } = await db.auth.signInAnonymously();
    if (error) throw error;
  }
  const { data: { user } } = await db.auth.getUser();
  myAuthUid = user.id;
}

// ── Database helpers ───────────────────────────────────────

// Fetches all 5 tables in parallel and assembles the gameState shape
// that the render functions consume. No JSON blobs — each entity is its own row.
async function loadGameState() {
  const [
    { data: playerRows, error: e1 },
    { data: denomRows,  error: e2 },
    { data: chipRows,   error: e3 },
    { data: buyinRows,  error: e4 },
  ] = await Promise.all([
    db.from('players')      .select('*').eq('game_id', gameId).order('created_at'),
    db.from('denominations').select('*').eq('game_id', gameId).order('sort_order'),
    db.from('player_chips') .select('*').eq('game_id', gameId),
    db.from('buyins')       .select('*').eq('game_id', gameId).order('created_at'),
  ]);

  if (e1 || e2 || e3 || e4) throw e1 || e2 || e3 || e4;

  const state = { denominations: denomRows || [], players: {} };

  (playerRows || []).forEach(p => {
    state.players[p.id] = { ...p, chips: {}, buyins: [] };
  });
  (chipRows || []).forEach(c => {
    if (state.players[c.player_id]) {
      state.players[c.player_id].chips[c.denomination_id] = c.count;
    }
  });
  (buyinRows || []).forEach(b => {
    if (state.players[b.player_id]) {
      state.players[b.player_id].buyins.push(b.amount);
    }
  });

  return state;
}

// ── Game actions ───────────────────────────────────────────

async function createGame(hostName, denoms) {
  const { data: { user } } = await db.auth.getUser();
  const id = genGameId();

  const { error: ge } = await db.from('games').insert({ id });
  if (ge) throw ge;

  // Player is inserted before denominations so the membership RLS check
  // on denominations_insert passes (it looks for a players row with auth_user_id = auth.uid()).
  const { data: [host], error: pe } = await db
    .from('players').insert({ game_id: id, name: hostName, auth_user_id: user.id }).select();
  if (pe) throw pe;

  const denomRows = denoms.map((d, i) => ({
    id: uuid(), game_id: id, label: d.label, color: d.color, value: d.value, sort_order: i,
  }));
  const { error: de } = await db.from('denominations').insert(denomRows);
  if (de) throw de;

  return { id, hostPlayerId: host.id };
}

async function addPlayer(name) {
  const { data: { user } } = await db.auth.getUser();
  const { error } = await db.from('players').insert({ game_id: gameId, name, auth_user_id: user.id });
  if (error) throw error;
}

async function addBuyin(playerId, amount) {
  const { error } = await db
    .from('buyins').insert({ game_id: gameId, player_id: playerId, amount });
  if (error) throw error;
}

async function setChips(playerId, denomId, count) {
  const { error } = await db.from('player_chips').upsert(
    { player_id: playerId, denomination_id: denomId, game_id: gameId, count },
    { onConflict: 'player_id,denomination_id' }
  );
  if (error) throw error;
}

async function addDenom(label, color, value) {
  const sortOrder = gameState?.denominations?.length || 0;
  const { error } = await db.from('denominations').insert({
    id: uuid(), game_id: gameId, label, color, value, sort_order: sortOrder,
  });
  if (error) throw error;
}

async function removeDenom(denomId) {
  const { error } = await db.from('denominations').delete().eq('id', denomId);
  if (error) throw error;
  // player_chips rows for this denomination cascade-delete via FK
}

async function postChat(playerName, message) {
  const { error } = await db
    .from('chat_messages').insert({ game_id: gameId, player_name: playerName, auth_user_id: myAuthUid, message });
  if (error) throw error;
}

// ── Realtime subscriptions ─────────────────────────────────
function subscribe() {
  // Re-fetch and re-render whenever any game data row changes
  ['players', 'denominations', 'player_chips', 'buyins'].forEach(table => {
    db.channel(`${table}:${gameId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table, filter: `game_id=eq.${gameId}`,
      }, async () => {
        gameState = await loadGameState();
        renderGame();
      })
      .subscribe();
  });

  // Chat gets its own channel — just append, no full re-render needed
  db.channel(`chat:${gameId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'chat_messages',
      filter: `game_id=eq.${gameId}`,
    }, payload => appendChatMsg(payload.new))
    .subscribe();
}

// ── Rendering ──────────────────────────────────────────────
function updateChatNameDisplay() {
  const player = Object.values(gameState?.players || {}).find(p => p.auth_user_id === myAuthUid);
  const el     = document.getElementById('chat-name-display');
  if (el) el.textContent = player?.name || myName || '';
}

function renderGame() {
  if (!gameState) return;
  const denoms  = gameState.denominations || [];
  const players = Object.values(gameState.players || {});
  renderPlayers(players, denoms);
  renderDenoms(denoms);
  renderSettle(players, denoms);
  updateChatNameDisplay();
}

function renderPlayers(players, denoms) {
  const grid = document.getElementById('players-grid');

  if (!players.length) {
    grid.innerHTML = '<p class="empty-state">No players yet — add the first one!</p>';
    return;
  }

  grid.innerHTML = '';
  players.forEach(p => {
    const cv  = chipValue(p, denoms);
    const tb  = totalBuyin(p);
    const net = cv - tb;

    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="player-header">
        <h3>${esc(p.name)}</h3>
        <button class="btn btn-sm btn-gold" data-pid="${p.id}" data-action="buyin">+ Buy-in</button>
      </div>
      <div class="player-stats">
        <div class="stat">
          <span class="stat-label">Chips</span>
          <span class="stat-value">${fmt(cv)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Bought in</span>
          <span class="stat-value">${fmt(tb)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Net</span>
          <span class="stat-value ${net >= 0 ? 'positive' : 'negative'}">${net >= 0 ? '+' : ''}${fmt(net)}</span>
        </div>
      </div>
      <div class="chip-inputs">
        ${denoms.map(d => `
          <div class="chip-row">
            <span class="chip-dot" style="background:${d.color}"></span>
            <span class="chip-label">${esc(d.label)} (${fmt(d.value)})</span>
            <input
              class="chip-count-input"
              type="number" min="0"
              data-pid="${p.id}" data-did="${d.id}"
              value="${(p.chips || {})[d.id] || 0}"
            >
          </div>
        `).join('')}
        ${denoms.length === 0 ? '<p style="font-size:0.8rem;color:var(--muted)">Add chips in the Chips tab first.</p>' : ''}
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('[data-action="buyin"]').forEach(btn =>
    btn.addEventListener('click', () => openBuyinModal(btn.dataset.pid))
  );

  grid.querySelectorAll('.chip-count-input').forEach(input =>
    input.addEventListener('change', e => {
      const count = Math.max(0, parseInt(e.target.value) || 0);
      e.target.value = count;
      setChips(e.target.dataset.pid, e.target.dataset.did, count);
    })
  );
}

function renderDenoms(denoms) {
  const list = document.getElementById('denoms-list');

  if (!denoms.length) {
    list.innerHTML = '<p class="empty-state">No chip denominations set.</p>';
    return;
  }

  list.innerHTML = '';
  denoms.forEach(d => {
    const row = document.createElement('div');
    row.className = 'denom-row';
    row.innerHTML = `
      <span class="chip-dot chip-dot-lg" style="background:${d.color}"></span>
      <span class="denom-label">${esc(d.label)}</span>
      <span class="denom-value">${fmt(d.value)}</span>
      <button class="btn btn-sm btn-danger" data-did="${d.id}" data-action="rm-denom">Remove</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('[data-action="rm-denom"]').forEach(btn =>
    btn.addEventListener('click', () => removeDenom(btn.dataset.did))
  );
}

function renderSettle(players, denoms) {
  const el = document.getElementById('settle-content');

  if (!players.length) {
    el.innerHTML = '<p class="empty-state">Add players to see settlements.</p>';
    return;
  }

  const rows = players.map(p => ({
    name:  p.name,
    chips: chipValue(p, denoms),
    buyin: totalBuyin(p),
    net:   chipValue(p, denoms) - totalBuyin(p),
  }));

  const txns = calcSettlements(players, denoms);

  el.innerHTML = `
    <table class="settle-table">
      <thead>
        <tr>
          <th>Player</th><th>Chips</th><th>Bought In</th><th>Net</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.name)}</td>
            <td>${fmt(r.chips)}</td>
            <td>${fmt(r.buyin)}</td>
            <td class="${r.net >= 0 ? 'positive' : 'negative'}">${r.net >= 0 ? '+' : ''}${fmt(r.net)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${txns.length === 0
      ? '<p class="empty-state" style="margin-top:1.25rem">Everyone is even — no transfers needed!</p>'
      : `<h3 style="margin:1.25rem 0 0.6rem;font-size:1rem;color:var(--muted)">Who pays whom</h3>
         <div class="transactions">
           ${txns.map(t => `
             <div class="transaction">
               <span class="t-payer">${esc(t.from)}</span>
               <span class="t-arrow">pays</span>
               <span class="t-payee">${esc(t.to)}</span>
               <span class="t-amount">${fmt(t.amount)}</span>
             </div>
           `).join('')}
         </div>`
    }
  `;
}

function appendChatMsg(msg) {
  const feed = document.getElementById('chat-messages');
  const div  = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <span class="chat-name">${esc(msg.player_name)}</span>
    <span class="chat-time">${time}</span>
    <p>${esc(msg.message)}</p>
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// ── Modal helpers ──────────────────────────────────────────
function openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
}

function closeModals() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

let pendingBuyinPid = null;

function openBuyinModal(pid) {
  pendingBuyinPid = pid;
  const playerName = (gameState?.players || {})[pid]?.name || '';
  document.getElementById('bi-player-name').textContent = playerName;
  document.getElementById('bi-amount').value = '';
  openModal('modal-buyin');
  setTimeout(() => document.getElementById('bi-amount').focus(), 50);
}

function buildDenomRow(container, d = {}) {
  const row = document.createElement('div');
  row.className = 'denom-input-row';
  row.innerHTML = `
    <input type="color"  class="color-input" value="${d.color || '#ffffff'}">
    <input type="text"   class="input denom-name-input" placeholder="Label"  value="${esc(d.label || '')}" maxlength="20">
    <input type="number" class="input denom-val-input"  placeholder="Value"  value="${d.value || ''}" min="0.01" step="0.01">
    <button class="btn btn-sm btn-danger rm-denom-row">✕</button>
  `;
  row.querySelector('.rm-denom-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// ── Tab switching ──────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
}

// ── Screen switching ───────────────────────────────────────
function showLanding() {
  document.getElementById('landing').classList.remove('hidden');
  document.getElementById('game').classList.add('hidden');
}

function showGame() {
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('game-id-display').textContent = `Game: ${gameId}`;
  renderGame();
}

// ── Bootstrap ──────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  gameId = params.get('game');

  if (!configured) { showLanding(); return; }

  await ensureAuth();

  if (!gameId) { showLanding(); return; }

  try {
    gameState = await loadGameState();
  } catch {
    alert('Game not found. The link may be invalid.');
    history.replaceState(null, '', location.pathname);
    showLanding();
    return;
  }

  showGame();
  subscribe();

  // Load existing chat history
  const { data: msgs } = await db
    .from('chat_messages')
    .select('*')
    .eq('game_id', gameId)
    .order('created_at', { ascending: true });
  (msgs || []).forEach(appendChatMsg);
}

// ── Event listeners ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // ── Landing ────────────────────────────────────────────
  document.getElementById('btn-new-game').addEventListener('click', () => {
    const container = document.getElementById('ng-denoms');
    container.innerHTML = '';
    DEFAULT_DENOMS.forEach(d => buildDenomRow(container, d));
    document.getElementById('ng-host-name').value = '';
    openModal('modal-new-game');
    setTimeout(() => document.getElementById('ng-host-name').focus(), 50);
  });

  // ── New game modal ─────────────────────────────────────
  document.getElementById('ng-add-denom').addEventListener('click', () =>
    buildDenomRow(document.getElementById('ng-denoms'))
  );

  document.getElementById('ng-cancel').addEventListener('click', closeModals);

  document.getElementById('ng-create').addEventListener('click', async () => {
    if (!configured) { alert('Fill in your Supabase credentials in app.js first.'); return; }

    const hostName = document.getElementById('ng-host-name').value.trim();
    if (!hostName) { alert('Please enter your name.'); return; }

    const rows   = document.querySelectorAll('#ng-denoms .denom-input-row');
    const denoms = [];
    for (const row of rows) {
      const label = row.querySelector('.denom-name-input').value.trim();
      const color = row.querySelector('.color-input').value;
      const value = parseFloat(row.querySelector('.denom-val-input').value);
      if (!label || isNaN(value) || value <= 0) continue;
      denoms.push({ label, color, value });
    }
    if (!denoms.length) { alert('Add at least one chip denomination.'); return; }

    try {
      const { id } = await createGame(hostName, denoms);
      gameId    = id;
      gameState = await loadGameState();
      closeModals();
      history.pushState(null, '', `?game=${gameId}`);
      document.getElementById('game-id-display').textContent = `Game: ${gameId}`;
      showGame();
      subscribe();
      myName = hostName;
      sessionStorage.setItem('playerName', hostName);
    } catch (e) {
      alert('Could not create game: ' + e.message);
    }
  });

  // ── Join game modal ────────────────────────────────────
  document.getElementById('btn-join-game').addEventListener('click', () => {
    document.getElementById('jg-code').value = '';
    openModal('modal-join-game');
    setTimeout(() => document.getElementById('jg-code').focus(), 50);
  });

  document.getElementById('jg-cancel').addEventListener('click', closeModals);

  async function joinGame() {
    const code = document.getElementById('jg-code').value.trim().toUpperCase();
    if (!code) { alert('Please enter a game code.'); return; }

    if (!configured) { alert('Fill in your Supabase credentials in app.js first.'); return; }

    await ensureAuth();

    const { data, error } = await db.from('games').select('id').eq('id', code).maybeSingle();
    if (error || !data) { alert('Game not found. Check the code and try again.'); return; }

    location.search = `?game=${code}`;
  }

  document.getElementById('jg-join').addEventListener('click', joinGame);
  document.getElementById('jg-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinGame();
  });
  document.getElementById('jg-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });

  // ── Add player modal ───────────────────────────────────
  document.getElementById('btn-add-player').addEventListener('click', () => {
    document.getElementById('ap-name').value = myName;
    openModal('modal-add-player');
    setTimeout(() => document.getElementById('ap-name').focus(), 50);
  });

  document.getElementById('ap-cancel').addEventListener('click', closeModals);

  document.getElementById('ap-confirm').addEventListener('click', async () => {
    const name = document.getElementById('ap-name').value.trim();
    if (!name) { alert('Please enter a name.'); return; }
    myName = name;
    sessionStorage.setItem('playerName', name);
    try {
      await addPlayer(name);
      closeModals();
    } catch (e) {
      alert('Could not add player: ' + e.message);
    }
  });

  // ── Buy-in modal ───────────────────────────────────────
  document.getElementById('bi-cancel').addEventListener('click', closeModals);

  document.getElementById('bi-confirm').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('bi-amount').value);
    if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
    try {
      await addBuyin(pendingBuyinPid, amount);
      closeModals();
    } catch (e) {
      alert('Could not record buy-in: ' + e.message);
    }
  });

  document.getElementById('bi-amount').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('bi-confirm').click();
  });

  // ── Add denom modal (in-game) ──────────────────────────
  document.getElementById('btn-add-denom').addEventListener('click', () => {
    document.getElementById('ad-label').value = '';
    document.getElementById('ad-value').value = '';
    openModal('modal-add-denom');
    setTimeout(() => document.getElementById('ad-label').focus(), 50);
  });

  document.getElementById('ad-cancel').addEventListener('click', closeModals);

  document.getElementById('ad-confirm').addEventListener('click', async () => {
    const label = document.getElementById('ad-label').value.trim();
    const color = document.getElementById('ad-color').value;
    const value = parseFloat(document.getElementById('ad-value').value);
    if (!label)                      { alert('Enter a label.');          return; }
    if (isNaN(value) || value <= 0)  { alert('Enter a valid value.');    return; }
    try {
      await addDenom(label, color, value);
      closeModals();
    } catch (e) {
      alert('Could not add denomination: ' + e.message);
    }
  });

  // ── Copy link ──────────────────────────────────────────
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).catch(() => {});
    const btn = document.getElementById('btn-copy-link');
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy Link'), 2000);
  });

  // ── Tabs ───────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  );

  // ── Chat ───────────────────────────────────────────────
  async function sendChat() {
    const msgEl = document.getElementById('chat-message');
    const msg   = msgEl.value.trim();
    if (!msg) return;

    const player = Object.values(gameState?.players || {}).find(p => p.auth_user_id === myAuthUid);
    const name   = player?.name || myName || 'Anonymous';

    msgEl.value = '';
    const btn = document.getElementById('btn-send-chat');
    btn.disabled = true;
    setTimeout(() => (btn.disabled = false), 3000);

    try { await postChat(name, msg); } catch (e) { console.error(e); }
  }

  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('chat-message').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });

  // ── Close modal on overlay click ───────────────────────
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModals();
  });
});
