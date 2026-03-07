"""
Bloons Siege - FastAPI Backend  (WebSocket-only edition)
=========================================================
Two WebSocket endpoints:
  /ws          → browser (game display + master controls)
  /ws/device   → IoT devices (NodeMCU); send join/shoot, receive led

Dependencies:
    pip install fastapi uvicorn[standard]

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

# ──────────────────────────────────────────────
#  CONFIG
# ──────────────────────────────────────────────
GAME_DURATION      = 120     # seconds
MAX_LIVES          = 5
MAX_PLAYERS        = 10

# ── Coordinate model ──────────────────────────────────────────────────────────
# The server tracks balloon position in logical px relative to the TOP OF THE
# PIPE INNER (same origin the client uses for b.top in the rAF loop).
#
# Balloons start at -100 px (above the pipe entrance) and travel downward.
# REFERENCE_PIPE_H is the logical pipe height the speed values are tuned to.
#
# The crosshair sits at CROSSHAIR_PCT of the *pipe* measured from the pipe top,
# so in logical px:
#   crosshair_px = REFERENCE_PIPE_H * CROSSHAIR_PCT
#
# ZONE_HALF_PX is the +-tolerance in logical px (= ZONE_HALF_WIDTH * pipe height).
# Balloon centre = b.top + AVG_HALF_BODY_H (~30 px average across types).
# ─────────────────────────────────────────────────────────────────────────────
REFERENCE_PIPE_H   = 800.0          # logical px – speeds are tuned to this
CROSSHAIR_PCT      = 0.62           # fraction of pipe height (from pipe top)
CROSSHAIR_PX       = REFERENCE_PIPE_H * CROSSHAIR_PCT   # 496 px from pipe top
ZONE_HALF_WIDTH    = 0.064          # fraction of pipe height
ZONE_HALF_PX       = REFERENCE_PIPE_H * ZONE_HALF_WIDTH

BALLOON_SPAWN_TOP  = -100.0         # logical px – where balloons start (above pipe)
AVG_HALF_BODY_H    = 30.0           # logical px – approx half-height of balloon body

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bloons")

# ──────────────────────────────────────────────
#  BALLOON CATALOGUE
# ──────────────────────────────────────────────
@dataclass
class BalloonTemplate:
    type: str
    hp: int
    speed: float   # px/s – logical pipe height is 800 px
    points: int    # base points per hit

BALLOON_TYPES: List[BalloonTemplate] = [
    BalloonTemplate("red",    1,  55,  1),
    BalloonTemplate("blue",   2,  65,  2),
    BalloonTemplate("green",  3,  75,  3),
    BalloonTemplate("yellow", 4,  90,  4),
    BalloonTemplate("black",  6, 100,  5),
    BalloonTemplate("white",  6, 100,  5),
    BalloonTemplate("purple", 8, 110,  7),
    BalloonTemplate("moab",  20,  40, 20),
]

# Waves: list of (balloon_type, count, delay_between_spawns_seconds)
WAVES = [
    [("red",    8, 1.2)],
    [("blue",   6, 1.0), ("red",    4, 0.8)],
    [("green",  5, 1.1), ("blue",   3, 0.9)],
    [("yellow", 4, 1.3), ("green",  3, 1.0)],
    [("black",  3, 1.5), ("yellow", 4, 1.0)],
    [("purple", 4, 1.6), ("black",  2, 1.2)],
    [("moab",   1, 3.0), ("purple", 3, 1.4)],
    [("moab",   2, 4.0), ("black",  4, 1.0)],
]

# ──────────────────────────────────────────────
#  GAME STATE
# ──────────────────────────────────────────────
class Phase(str, Enum):
    LOBBY   = "lobby"
    GAME    = "game"
    SCORING = "scoring"

@dataclass
class Player:
    name: str
    score: int = 0

@dataclass
class ActiveBalloon:
    id: str
    template: BalloonTemplate
    hp: int
    spawn_time: float
    # Position tracked in logical px from TOP OF PIPE INNER, matching client b.top.
    # Balloons start at BALLOON_SPAWN_TOP (-100 px) and move downward at
    # template.speed px/s (tuned to REFERENCE_PIPE_H = 800 px).

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.spawn_time

    @property
    def top_px(self) -> float:
        """Logical px from pipe-inner top (same as client b.top)."""
        return BALLOON_SPAWN_TOP + self.elapsed * self.template.speed

    @property
    def center_px(self) -> float:
        """Balloon centre in logical px from pipe-inner top."""
        return self.top_px + AVG_HALF_BODY_H

    @property
    def in_zone(self) -> bool:
        """True when balloon centre is within the hit window:
        approaching from above (within ZONE_HALF_PX) up to just past the crosshair."""
        delta = self.center_px - CROSSHAIR_PX
        return (-ZONE_HALF_PX <= delta <= ZONE_HALF_PX * 1)

    @property
    def escaped(self) -> bool:
        return self.top_px > REFERENCE_PIPE_H


class GameState:
    def __init__(self):
        self.reset()

    def reset(self):
        self.phase: Phase                       = Phase.LOBBY
        self.players: Dict[str, Player]         = {}
        self.balloons: Dict[str, ActiveBalloon] = {}
        self.lives: int                         = MAX_LIVES
        self.wave: int                          = 0
        self.start_time: float                  = 0.0
        self._balloon_counter: int              = 0

    def new_balloon_id(self) -> str:
        self._balloon_counter += 1
        return f"b{self._balloon_counter}"

    @property
    def time_left(self) -> int:
        if self.phase != Phase.GAME:
            return GAME_DURATION
        return max(0, GAME_DURATION - int(time.monotonic() - self.start_time))

    @property
    def scores(self) -> List[dict]:
        return [{"name": p.name, "score": p.score}
                for p in sorted(self.players.values(), key=lambda p: -p.score)]


state = GameState()

# ──────────────────────────────────────────────
#  CONNECTION MANAGERS
# ──────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def send(self, ws: WebSocket, msg: dict):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            self.disconnect(ws)

    async def broadcast(self, msg: dict):
        data = json.dumps(msg)
        dead = []
        for ws in self.connections:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


# Separate managers: browser gets game events, devices get led commands
browser_mgr = ConnectionManager()
device_mgr  = ConnectionManager()

# Track which WebSocket belongs to which player name
device_names: Dict[WebSocket, str] = {}


async def notify_devices_led(on: bool):
    await device_mgr.broadcast({"type": "led", "on": on})

# ──────────────────────────────────────────────
#  GAME ACTIONS
# ──────────────────────────────────────────────
async def handle_join(name: str):
    if state.phase != Phase.LOBBY:
        return
    if name in state.players or len(state.players) >= MAX_PLAYERS:
        return
    state.players[name] = Player(name=name)
    log.info(f"Jogador {name} se juntou ao servidor")
    await browser_mgr.broadcast({"type": "player_joined", "name": name})


async def handle_shoot(shooter: str):
    log.info(f"{shooter} atirou!")
    if state.phase != Phase.GAME:
        return
    if shooter not in state.players:
        return

    in_zone = [b for b in state.balloons.values() if b.in_zone]
    if not in_zone:
        state.players[shooter].score -= 1
        await browser_mgr.broadcast({"type": "shoot_miss", "shooter": shooter})
        return

    target      = min(in_zone, key=lambda b: abs(b.center_px - CROSSHAIR_PX))
    pts_per_hit = target.template.points
    target.hp  -= 1
    state.players[shooter].score += pts_per_hit

    if target.hp <= 0:
        bonus = pts_per_hit * 2
        state.players[shooter].score += bonus
        del state.balloons[target.id]
        await browser_mgr.broadcast({
            "type":         "balloon_pop",
            "id":           target.id,
            "killer":       shooter,
            "bonus_points": bonus,
        })
    else:
        await browser_mgr.broadcast({
            "type":    "balloon_hit",
            "id":      target.id,
            "shooter": shooter,
            "hp_left": target.hp,
            "points":  pts_per_hit,
        })

    await _update_led()


async def _update_led():
    any_in_zone = any(b.in_zone for b in state.balloons.values())
    await notify_devices_led(any_in_zone)
    await browser_mgr.broadcast({"type": "zone_update", "balloon_in_zone": any_in_zone})

# ──────────────────────────────────────────────
#  GAME LOOP
# ──────────────────────────────────────────────
_game_task: Optional[asyncio.Task] = None


async def game_loop():
    log.info("Loop do jogo iniciado")
    state.start_time = time.monotonic()
    wave_idx         = 0
    prev_in_zone     = False

    async def spawn_wave(idx: int):
        state.wave = idx + 1
        await browser_mgr.broadcast({
            "type": "state_sync", "wave": state.wave,
            "lives": state.lives, "time_left": state.time_left,
        })
        for (btype, count, delay) in WAVES[idx % len(WAVES)]:
            tmpl = next((t for t in BALLOON_TYPES if t.type == btype), BALLOON_TYPES[0])
            for _ in range(count):
                if state.phase != Phase.GAME:
                    return
                bid     = state.new_balloon_id()
                balloon = ActiveBalloon(
                    id=bid, template=tmpl,
                    hp=tmpl.hp, spawn_time=time.monotonic(),
                )
                state.balloons[bid] = balloon
                await browser_mgr.broadcast({
                    "type":  "balloon_spawn",
                    "id":    bid,
                    "btype": tmpl.type,
                    "hp":    tmpl.hp,
                    "speed": tmpl.speed,
                })
                await asyncio.sleep(delay)

    asyncio.create_task(spawn_wave(wave_idx))
    next_wave_at = time.monotonic() + 18

    while state.phase == Phase.GAME:
        await asyncio.sleep(0.1)
        now = time.monotonic()

        # Escaped balloons
        escaped = [b for b in list(state.balloons.values()) if b.escaped]
        for b in escaped:
            state.lives -= 1
            del state.balloons[b.id]
            await browser_mgr.broadcast({
                "type": "balloon_escaped",
                "id":   b.id, "lives_left": state.lives,
            })
            if state.lives <= 0:
                await end_game("lives")
                return

        # LED update
        in_zone = any(b.in_zone for b in state.balloons.values())
        if in_zone != prev_in_zone:
            prev_in_zone = in_zone
            await _update_led()

        # Time up
        if state.time_left <= 0:
            await end_game("time")
            return

        # Next wave
        if now >= next_wave_at:
            wave_idx    += 1
            asyncio.create_task(spawn_wave(wave_idx))
            next_wave_at = now + max(12, 18 - wave_idx * 0.5)

        # Periodic sync every ~5 s
        if int(now * 10) % 50 == 0:
            await browser_mgr.broadcast({
                "type":      "state_sync",
                "lives":     state.lives,
                "time_left": state.time_left,
                "scores":    {n: p.score for n, p in state.players.items()},
                "wave":      state.wave,
            })

    log.info("Loop do jogo finalizado")


async def end_game(reason: str):
    state.phase = Phase.SCORING
    await notify_devices_led(False)
    log.info(f"Fim do jogo: {reason}")
    await browser_mgr.broadcast({
        "type":   "game_over",
        "reason": reason,
        "scores": state.scores,
    })

# ──────────────────────────────────────────────
#  FASTAPI APP
# ──────────────────────────────────────────────
app = FastAPI(title="Bloons Siege")


@app.get("/")
async def root():
    if Path("index.html").exists():
        return FileResponse("index.html")
    return {"error": "index.html not found – place it next to main.py"}


# ── Browser WebSocket ──────────────────────────
@app.websocket("/ws")
async def ws_browser(websocket: WebSocket):
    global _game_task
    await browser_mgr.connect(websocket)
    log.info("Navegador conectado")

    # Catch the browser up with current state
    await browser_mgr.send(websocket, {
        "type":   "state_sync",
        "phase":  state.phase.value,
        "lives":  state.lives,
        "scores": {n: p.score for n, p in state.players.items()},
    })
    for name in state.players:
        await browser_mgr.send(websocket, {"type": "player_joined", "name": name})

    try:
        while True:
            raw   = await websocket.receive_text()
            msg   = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "start_game" and state.phase == Phase.LOBBY:
                if len(state.players) < 1:
                    continue
                state.phase = Phase.GAME
                await browser_mgr.broadcast({"type": "game_start"})
                _game_task = asyncio.create_task(game_loop())

            elif mtype == "reset_game":
                if _game_task:
                    _game_task.cancel()
                    _game_task = None
                saved = {n: Player(name=n) for n in state.players}
                state.reset()
                state.players = saved
                log.info("Jogo reiniciado")

    except WebSocketDisconnect:
        browser_mgr.disconnect(websocket)
        log.info("Navegador desconectado")


# ── Device WebSocket ───────────────────────────
@app.websocket("/ws/device")
async def ws_device(websocket: WebSocket):
    await device_mgr.connect(websocket)

    try:
        while True:
            raw   = await websocket.receive_text()
            msg   = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "join":
                name = str(msg.get("name", ""))[:8]
                if name:
                    log.info(f"Dispositivo {name} conectado")
                    device_names[websocket] = name
                    await handle_join(name)

            elif mtype == "shoot":
                # Name can come from the message or from the earlier join
                name = str(msg.get("name", ""))[:8] or device_names.get(websocket, "")
                if name:
                    await handle_shoot(name)

    except WebSocketDisconnect:
        device_mgr.disconnect(websocket)
        device_names.pop(websocket, None)
        log.info("Dispositivo desconectado")


# ── Test helpers ───────────────────────────────
@app.post("/test/join/{name}")
async def test_join(name: str):
    await handle_join(name[:8])
    return {"ok": True}

@app.post("/test/shoot/{name}")
async def test_shoot(name: str):
    await handle_shoot(name[:8])
    return {"ok": True}