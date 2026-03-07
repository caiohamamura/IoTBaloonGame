// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const WS_URL = `ws://10.134.76.100:8000/ws`;
const CROSSHAIR_OFFSET_PERCENT = 0.62; // 62% down the pipe
const GAME_DURATION = 120;             // seconds
const MAX_LIVES = 5;

// Reference pipe height the server's speed values were tuned for (logical px)
const REFERENCE_PIPE_H = 800;

// Balloon definitions (client-side display only; server drives the data)
const BALLOON_COLORS = {
  red: '#cc0000', blue: '#0044cc', green: '#00aa33',
  yellow: '#cc9900', black: '#222', white: '#ccc',
  purple: '#6600aa', moab: '#334'
};

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let ws = null;
let players = {};            // { name: { score, avatar, side } }
let balloons = {};           // { id: { el, type, hp, maxHp, top, speed } }
let crosshairY = 0;          // pixels from arena top (center of crosshair)
let pipeOffsetY = 48;        // pixels from arena top to pipe inner top (= HUD height)
let zoneTolerance = 55;      // pixels – recalculated on resize
let lives = MAX_LIVES;
let timeLeft = GAME_DURATION;
let timerInterval = null;
let phase = 'lobby';         // lobby | game | scoring
let balloonInZone = false;
let pipeScaleFactor = 1;     // actual pipeH / REFERENCE_PIPE_H

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
const $ = id => document.getElementById(id);

const AVATARS = ['🐸', '🐙', '🦊', '🐼', '🐯', '🦁', '🐻', '🐮', '🐷', '🐝'];
let avatarIdx = 0;

function getAvatar() {
  return AVATARS[avatarIdx++ % AVATARS.length];
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

// ══════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    $('wsDot').className = 'ws-dot connected';
    $('wsLabel').textContent = 'Conectado';
    $('connOverlay').classList.add('hidden');
  };

  ws.onclose = () => {
    $('wsDot').className = 'ws-dot error';
    $('wsLabel').textContent = 'Disconnected';
    $('connOverlay').classList.remove('hidden');
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    $('wsDot').className = 'ws-dot error';
  };

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error('WS parse error', err);
    }
  };
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ══════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════
function handleMessage(msg) {
  console.debug(msg);
  switch (msg.type) {
    case 'player_joined':   onPlayerJoined(msg);   break;
    case 'player_left':     onPlayerLeft(msg);     break;
    case 'game_start':      onGameStart(msg);      break;
    case 'balloon_spawn':   onBalloonSpawn(msg);   break;
    case 'balloon_hit':     onBalloonHit(msg);     break;
    case 'balloon_pop':     onBalloonPop(msg);     break;
    case 'balloon_escaped': onBalloonEscaped(msg); break;
    case 'shoot_miss':      onShootMiss(msg);      break;
    case 'game_over':       onGameOver(msg);       break;
    case 'state_sync':      onStateSync(msg);      break;
    case 'zone_update':     onZoneUpdate(msg);     break;
  }
}

// ══════════════════════════════════════════════
//  LOBBY
// ══════════════════════════════════════════════
function onPlayerJoined(msg) {
  if (players[msg.name]) return;
  const side = Object.keys(players).length % 2 === 0 ? 'left' : 'right';
  players[msg.name] = { score: 0, avatar: getAvatar(), side };
  renderPlayerList();
  if (phase === 'game') renderSidePanels();
}

function onPlayerLeft(msg) {
  delete players[msg.name];
  renderPlayerList();
  if (phase === 'game') renderSidePanels();
}

function renderPlayerList() {
  const ul = $('playerList');
  ul.innerHTML = '';
  const names = Object.keys(players);
  names.forEach(n => {
    const li = document.createElement('li');
    li.textContent = `${players[n].avatar} ${n}`;
    ul.appendChild(li);
  });
  $('lobbyStatus').textContent = names.length === 0
    ? 'Esperando jogadores se conectar...'
    : `${names.length} jogador${names.length > 1 ? 's' : ''} pronto`;
  $('btnStart').disabled = names.length < 1;
}

// ══════════════════════════════════════════════
//  GAME START
// ══════════════════════════════════════════════
function onGameStart(msg) {
  phase = 'game';
  lives = MAX_LIVES;
  timeLeft = GAME_DURATION;
  balloons = {};
  Object.keys(players).forEach(n => players[n].score = 0);

  showScreen('game');
  setupArena();
  renderSidePanels();
  startTimer();
}

function setupArena() {
  const arena = $('arena');
  const pipeInner = $('pipeInner');

  // Compute scale synchronously so balloons spawned immediately get correct values
  {
    const arenaH = arena.clientHeight || window.innerHeight;
    const HUD_H  = 48;
    const pipeH  = arenaH - HUD_H;
    pipeScaleFactor = pipeH / REFERENCE_PIPE_H;
    pipeOffsetY     = HUD_H;
    crosshairY      = HUD_H + pipeH * CROSSHAIR_OFFSET_PERCENT;
    zoneTolerance   = REFERENCE_PIPE_H * 0.065 * pipeScaleFactor;
  }

  // Wait one frame for layout to settle, then finalize visual positioning
  requestAnimationFrame(() => {
    const arenaH  = arena.clientHeight;
    const HUD_H   = 48;                        // fixed HUD height (px)
    const pipeH   = arenaH - HUD_H;            // visible pipe height in real px
    pipeScaleFactor = pipeH / REFERENCE_PIPE_H;
    pipeOffsetY = HUD_H;                       // arena-relative Y where pipeInner starts

    // Cross-hair center sits at CROSSHAIR_OFFSET_PERCENT of the pipe (arena-relative)
    crosshairY = HUD_H + pipeH * CROSSHAIR_OFFSET_PERCENT;

    // Zone tolerance scales with pipe height
    zoneTolerance = REFERENCE_PIPE_H * 0.064 * pipeScaleFactor; // ~55px at reference

    // Position crosshair so its visual CENTER lands exactly on crosshairY
    const CROSSHAIR_HALF = 45; // half of 90px crosshair
    const ch = $('crosshair');
    ch.style.top = (crosshairY - CROSSHAIR_HALF) + 'px';

    const zl = $('zoneLight');
    zl.style.top = (crosshairY - CROSSHAIR_HALF) + 'px';

    // Decorative clouds
    arena.querySelectorAll('.arena-cloud').forEach(c => c.remove());
    for (let i = 0; i < 5; i++) {
      const c = document.createElement('div');
      c.className = 'arena-cloud';
      c.style.cssText = `
        width: ${60 + Math.random()*80}px;
        height: ${20 + Math.random()*20}px;
        top: ${10 + Math.random()*30}%;
        left: ${Math.random()*80}%;
        opacity: ${0.4 + Math.random()*0.4};
      `;
      arena.appendChild(c);
    }

    $('waveDisplay').textContent = '1';
    updateHealthBar();
  });
}

function startTimer() {
  clearInterval(timerInterval);
  $('timerDisplay').textContent = formatTime(timeLeft);
  timerInterval = setInterval(() => {
    timeLeft--;
    $('timerDisplay').textContent = formatTime(timeLeft);
    if (timeLeft <= 20) $('timerDisplay').classList.add('urgent');
    if (timeLeft <= 0) clearInterval(timerInterval);
  }, 1000);
}

// ══════════════════════════════════════════════
//  SIDE PANELS
// ══════════════════════════════════════════════
function renderSidePanels() {
  const left  = $('leftPanel');
  const right = $('rightPanel');
  left.innerHTML  = '';
  right.innerHTML = '';

  Object.keys(players).forEach((name, i) => {
    const p = players[name];
    const card = document.createElement('div');
    card.className = 'player-card';
    card.id = `card-${name}`;
    card.innerHTML = `
      <div class="shoot-indicator" id="si-${name}"></div>
      <div class="avatar">${p.avatar}</div>
      <div class="player-name">${name}</div>
      <div class="player-score" id="score-${name}">${p.score}</div>
    `;
    if (i % 2 === 0) left.appendChild(card);
    else             right.appendChild(card);
  });
}

function updatePlayerScore(name) {
  const el = $(`score-${name}`);
  if (el) el.textContent = players[name]?.score ?? 0;
}

// ══════════════════════════════════════════════
//  BALLOONS
// ══════════════════════════════════════════════
function onBalloonSpawn(msg) {
  const pipeInner  = $('pipeInner');
  const pipeInnerH = pipeInner.clientHeight;

  // Scale speed from reference pipe height to actual pipe height
  const scaledSpeed = msg.speed * pipeScaleFactor;

  // Visual scale factor for balloon body (so they look right at any screen size)
  const bs = Math.max(0.55, Math.min(1.4, pipeScaleFactor));

  // Body height lookup (matches CSS definitions) — used for accurate zone detection
  const BODY_HEIGHTS = {
    red: 52, blue: 58, green: 64, yellow: 60,
    black: 70, white: 70, purple: 76, moab: 52
  };
  const bodyH = BODY_HEIGHTS[msg.btype] ?? 52;

  const el = document.createElement('div');
  el.className    = 'balloon';
  el.dataset.type = msg.btype;
  el.dataset.id   = msg.id;
  el.style.top    = '-100px';
  el.style.setProperty('--bs', bs);

  const label = msg.btype === 'moab' ? 'M.O.A.B' : '';
  el.innerHTML = `
    <div class="balloon-body">
      <span class="balloon-hp" id="bhp-${msg.id}">${msg.hp}❤</span>
      ${label}
    </div>
    <div class="balloon-string"></div>
  `;

  // Assign z-index so newer balloons render on top of older ones
  const spawnOrder = Object.keys(balloons).length;
  el.style.zIndex = 10 + spawnOrder;

  pipeInner.appendChild(el);

  balloons[msg.id] = {
    el,
    type:   msg.btype,
    hp:     msg.hp,
    maxHp:  msg.hp,
    top:    -100,
    speed:  scaledSpeed,
    pipeH:  pipeInnerH,
    bodyH,
    bs,
  };

  animateBalloon(msg.id);
}

function animateBalloon(id) {
  const b = balloons[id];
  if (!b) return;

  let lastTime = null;

  function frame(ts) {
    if (!balloons[id]) return;
    if (lastTime === null) { lastTime = ts; requestAnimationFrame(frame); return; }
    const dt = Math.min((ts - lastTime) / 1000, 0.05); // cap at 50ms to prevent jumps
    lastTime = ts;

    b.top += b.speed * dt;
    b.el.style.top = b.top + 'px';

    // Zone check: balloon center in arena coords = pipeOffsetY + b.top + halfBodyH
    // halfBodyH is half the scaled body height (body heights vary by type, ~52px avg * --bs)
    const halfBodyH = (b.bodyH || 52) * (b.bs || 1) * 0.5;
    const balloonCenterY = pipeOffsetY + b.top + halfBodyH;
    // Hit window: balloon centre must be within zoneTolerance ABOVE the crosshair,
    // and no more than a tiny margin BELOW it — so the zone is centred on approach
    // and ends right as the balloon centre passes the crosshair line.
    b.inZone = (balloonCenterY >= crosshairY - zoneTolerance) &&
               (balloonCenterY <= crosshairY + zoneTolerance * 1);

    // Don't interfere with the pop animation
    if (b.popping) return;

    if (b.top > b.pipeH + 100) {
      delete balloons[id];
      return;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function onZoneUpdate(msg) {
  balloonInZone = msg.balloon_in_zone;
  const zl = $('zoneLight');
  if (balloonInZone) zl.classList.add('active');
  else               zl.classList.remove('active');
}

function onBalloonHit(msg) {
  const b = balloons[msg.id];
  if (!b) return;

  b.el.classList.remove('hit');
  void b.el.offsetWidth;
  b.el.classList.add('hit');
  b.hp = msg.hp_left;

  const hpEl = $(`bhp-${msg.id}`);
  if (hpEl) hpEl.textContent = `${msg.hp_left}❤`;

  showScorePopup(msg.points, false);
  flashShooter(msg.shooter);

  if (players[msg.shooter]) {
    players[msg.shooter].score += msg.points;
    updatePlayerScore(msg.shooter);
  }

  spawnBurst();
}

function onBalloonPop(msg) {
  const b = balloons[msg.id];

  if (b) {
    // Mark as popping so the rAF loop stops moving/deleting it
    b.popping = true;
    b.el.classList.add('popping');
    setTimeout(() => {
      b.el.remove();
      delete balloons[msg.id];
    }, 500);
  } else {
    // Balloon was already removed client-side (escaped past pipe bottom).
    // Still show the effects since server confirmed the pop.
  }

  showScorePopup(msg.bonus_points, true);
  flashShooter(msg.killer);

  if (players[msg.killer]) {
    players[msg.killer].score += msg.bonus_points;
    updatePlayerScore(msg.killer);
  }

  spawnBurst();
}

function onBalloonEscaped(msg) {
  const b = balloons[msg.id];
  if (b) { b.el.remove(); delete balloons[msg.id]; }

  lives = msg.lives_left;
  updateHealthBar();

  const arena = $('arena');
  arena.classList.add('escaped');
  setTimeout(() => arena.classList.remove('escaped'), 500);
}

function onShootMiss(msg) {
  const miss = document.createElement('div');
  miss.className  = 'miss-text';
  miss.style.top  = (crosshairY - 50) + 'px';
  miss.textContent = 'MISS!';

  $('arena').appendChild(miss);
  showScorePopup(-1, false);
  flashShooter(msg.shooter);

  if (players[msg.shooter]) {
    players[msg.shooter].score -= 1;
    updatePlayerScore(msg.shooter);
  }
  setTimeout(() => miss.remove(), 800);
}

function onStateSync(msg) {
  if (msg.scores) {
    Object.entries(msg.scores).forEach(([name, score]) => {
      if (players[name]) {
        players[name].score = score;
        updatePlayerScore(name);
      }
    });
  }
  if (msg.lives !== undefined) { lives = msg.lives; updateHealthBar(); }
  if (msg.time_left !== undefined) timeLeft = msg.time_left;
  if (msg.wave !== undefined) $('waveDisplay').textContent = msg.wave;
}

// ══════════════════════════════════════════════
//  GAME OVER
// ══════════════════════════════════════════════
function onGameOver(msg) {
  phase = 'scoring';
  clearInterval(timerInterval);

  Object.values(balloons).forEach(b => b.el?.remove());
  balloons = {};

  $('endReason').textContent = msg.reason === 'time'
    ? "⏱ Time's up!" : '💔 Too many balloons escaped!';

  const table = $('scoreTable');
  table.innerHTML = '';

  const sorted = (msg.scores || []).sort((a, b) => b.score - a.score);
  sorted.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.style.animationDelay = `${i * 0.1}s`;
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
    row.innerHTML = `
      <span class="rank-badge ${rankClass}">${medal}</span>
      <span class="avatar" style="width:30px;height:30px;font-size:1rem;">${players[s.name]?.avatar ?? '🎈'}</span>
      <span class="name">${s.name}</span>
      <span class="pts">${s.score} pts</span>
    `;
    table.appendChild(row);
  });

  showScreen('scoring');
}

// ══════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name).classList.add('active');
}

function updateHealthBar() {
  const pct = Math.max(0, (lives / MAX_LIVES) * 100);
  $('healthBar').style.width = pct + '%';
}

function flashShooter(name) {
  const card = $(`card-${name}`);
  const si   = $(`si-${name}`);
  if (card) {
    // Force re-trigger animation even if fired rapidly
    card.classList.remove('shot-flash');
    void card.offsetWidth;
    card.classList.add('shot-flash');
    setTimeout(() => card.classList.remove('shot-flash'), 450);
  }
  if (si) {
    si.classList.add('active');
    setTimeout(() => si.classList.remove('active'), 450);
  }
}

function showScorePopup(pts, isDouble) {
  const pop = document.createElement('div');
  pop.className   = 'score-popup' + (isDouble ? ' double' : '');
  pop.style.top   = (crosshairY - 30) + 'px';
  pop.textContent = isDouble ? `🎉 +${pts}!` : pts < 0 ? `${pts}` : `+${pts}`;
  $('arena').appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
}

function spawnBurst() {
  const burst    = document.createElement('div');
  burst.className = 'shoot-burst';
  const pipeRect  = $('pipe').getBoundingClientRect();
  const arenaRect = $('arena').getBoundingClientRect();
  const cx        = pipeRect.left + pipeRect.width / 2 - arenaRect.left;
  burst.style.left = cx + 'px';
  burst.style.top  = crosshairY + 'px';
  $('arena').appendChild(burst);
  setTimeout(() => burst.remove(), 400);
}

// ══════════════════════════════════════════════
//  LOBBY CLOUDS (decorative)
// ══════════════════════════════════════════════
function spawnLobbyClouds() {
  const bg = $('lobbyBg');
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div');
    c.className = 'cloud';
    const size = 60 + Math.random() * 120;
    c.style.cssText = `
      width: ${size}px; height: ${size * 0.4}px;
      top: ${Math.random() * 90}%;
      left: ${-200}px;
      animation-duration: ${12 + Math.random() * 18}s;
      animation-delay: ${-Math.random() * 30}s;
      opacity: ${0.3 + Math.random() * 0.4};
    `;
    bg.appendChild(c);
  }
}

// ══════════════════════════════════════════════
//  BUTTON HANDLERS
// ══════════════════════════════════════════════
$('btnStart').addEventListener('click', () => sendWS({ type: 'start_game' }));

$('btnRestart').addEventListener('click', () => {
  balloons = {};
  phase    = 'lobby';
  Object.keys(players).forEach(n => players[n].score = 0);
  renderPlayerList();
  showScreen('lobby');
  sendWS({ type: 'reset_game' });
});

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
spawnLobbyClouds();
showScreen('lobby');
connect();

// Resize: recalculate crosshair & scale, then rescale running balloons
window.addEventListener('resize', () => {
  if (phase !== 'game') return;
  setupArena();

  // Re-scale speeds and visual size of all live balloons
  requestAnimationFrame(() => {
    const pipeInner  = $('pipeInner');
    const pipeInnerH = pipeInner.clientHeight;
    const bs = Math.max(0.55, Math.min(1.4, pipeScaleFactor));

    Object.values(balloons).forEach(b => {
      // Recompute speed relative to new pipe height
      const baseSpeed = b.speed / (b._prevScale || pipeScaleFactor);
      b.speed  = baseSpeed * pipeScaleFactor;
      b.pipeH  = pipeInnerH;
      b.bs     = Math.max(0.55, Math.min(1.4, pipeScaleFactor));
      b.el.style.setProperty('--bs', b.bs);
    });
  });
});