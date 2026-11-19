// Shared compact delta network snapshot serialization & client state hydration.
import { Game } from '../game/sim.js';
import { W, H, MONSTERS, computeSpikeState } from '../game/constants.js';

export const SNAP_TICKS = 2; // Server runs at 60 Hz; broadcast regular snapshots at 30 Hz (urgent events flush immediately) to avoid cellular/tunnel congestion.
const rnd = (v, k = 100) => Math.round((v || 0) * k) / k;

export function encodeTerrain(terrain) {
  let out = '';
  for (let i = 0; i < terrain.length; i++) out += String(terrain[i]);
  return out;
}

function makeClientMonster(sm) {
  const [id, type, x, y, dir, flags, hp, maxHp, flash, stun, zapped, tpPhase, tpTimer, tpDur] = sm;
  return {
    id,
    type,
    info: MONSTERS[type] || MONSTERS[3],
    x,
    y,
    px: x,
    py: y,
    get cx() { return Math.floor(this.x); },
    get cy() { return Math.floor(this.y); },
    dir,
    moving: !!(flags & 1),
    alive: !!(flags & 2),
    boss: !!(flags & 4),
    hp,
    maxHp,
    flash,
    stun,
    zapped,
    tpPhase,
    tpTimer,
    tpDur,
  };
}

/** Serialize authoritative server `Game` into a compact delta JSON snapshot. */
export function serializeGame(game, events = [], { full = false, cache = null } = {}) {
  const doors = [];
  const spikes = [];
  for (let i = 0; i < W * H; i++) {
    const f = game.feat[i];
    if (!f) continue;
    if (f.k === 'door') doors.push([i, f.state, f.flipped ? 1 : 0, f.o, f.allow]);
    else if (f.k === 'spike') spikes.push([i, f.out ? 1 : 0]);
  }

  const items = [...game.items.entries()].map(([i, it]) => [i, it.name, rnd(it.age, 20)]);
  const barriers = [...game.barriers.entries()].map(([i, life]) => [i, rnd(life, 50)]);
  const terrainStr = encodeTerrain(game.terrain);
  const doorsSig = JSON.stringify(doors);
  const spikesSig = JSON.stringify(spikes);
  const itemsSig = JSON.stringify(items);
  const barriersSig = JSON.stringify(barriers);

  const snap = {
    t: 'snap',
    seq: game._netSeq = (game._netSeq || 0) + 1,
    st: Math.round(game.time * 1000),
    bombs: game.bombs.map(b => [
      b.id, b.x, b.y, b.cx, b.cy, b.owner, b.range, rnd(b.fuse, 50), rnd(b.age, 50),
      b.kind, b.vent, rnd(b.rx ?? b.x, 1000), rnd(b.ry ?? b.y, 1000),
    ]),
    flames: [...game.flames.entries()].map(([i, f]) => [i, rnd(f.t, 50), f.kind || 'fire']),
    projs: game.projs.map(p => [
      p.id, rnd(p.x, 1000), rnd(p.y, 1000), p.d, p.spell, p.owner, rnd(p.life, 50), rnd(p.dist || 0),
    ]),
    winds: game.winds.map(w => [
      w.id, w.owner, w.x, w.y, w.arms, rnd(w.t, 50), rnd(w.max, 50),
      w.cells ? [...w.cells.entries()] : null,
    ]),
    players: game.players.map(p => {
      const flags = (p.moving ? 1 : 0) | (p.alive ? 2 : 0) | (p.out ? 4 : 0) | (p.exited ? 8 : 0) | (p.sprint ? 16 : 0);
      return [
        p.slot, p.id, rnd(p.x, 1000), rnd(p.y, 1000), p.dir, flags,
        p.lives, p.score, p.kills, p.wins, p.bombsMax, p.range,
        p.power || null, rnd(p.powerTime, 20), rnd(p.powerMax, 20),
        rnd(p.radiation, 20), rnd(p.ghost, 20), rnd(p.invuln, 20), rnd(p.stun, 20),
        p.tpPhase || null, rnd(p.tpTimer, 50), rnd(p.tpDur, 50),
        rnd(p.cast, 20), rnd(p.hit, 20), rnd(p.respawn, 20), p._netAck || 0,
      ];
    }),
    monsters: game.monsters.map(m => {
      const flags = (m.moving ? 1 : 0) | (m.alive ? 2 : 0) | (m.boss ? 4 : 0);
      return [
        m.id, m.type, rnd(m.x, 1000), rnd(m.y, 1000), m.dir, flags,
        m.hp, m.maxHp, rnd(m.flash, 20), rnd(m.stun, 20), rnd(m.zapped, 20),
        m.tpPhase || null, rnd(m.tpTimer, 50), rnd(m.tpDur, 50),
      ];
    }),
    portal: game.portal,
    freeze: rnd(game.freeze, 50),
    stasis: rnd(game.stasis, 50),
    roundTime: rnd(game.roundTime, 20),
    state: game.state,
    stateTime: rnd(game.stateTime, 50),
    time: rnd(game.time, 50),
    spikeTime: rnd(game.time - (game.stasisPaused || 0) - (game._freezeTime || 0), 50),
    danger: game.danger,
  };

  if (full || terrainStr !== cache?.terrain) snap.terrain = terrainStr;
  if (full || doorsSig !== cache?.doors) snap.doors = doors;
  if (full || spikesSig !== cache?.spikes) snap.spikes = spikes;
  if (full || itemsSig !== cache?.items) snap.items = items;
  if (full || barriersSig !== cache?.barriers) snap.barriers = barriers;
  if (events.length) snap.events = events;

  const nextCache = { terrain: terrainStr, doors: doorsSig, spikes: spikesSig, items: itemsSig, barriers: barriersSig };
  return { snap, cache: nextCache };
}

/** Create a client-side `Game` shell ready to receive server snapshots. */
export function createClientGame(level, opts = {}) {
  const game = new Game(level, {
    mode: opts.mode || 'normal',
    players: opts.players || [0],
    carry: opts.carry || {},
    cheats: opts.cheats || {},
    seed: 1,
  });
  game.hidden.clear();
  game.items.clear();
  game.monsters = [];
  game._netMonById = new Map();
  game._netInitialized = false;
  return game;
}

/** Patch a client-side `Game` with an incoming server snapshot, preserving smooth render interpolation. */
export function applySnapshot(game, snap, prevAlpha = 1) {
  if (!game || !snap) return;
  const a = Math.max(0, Math.min(1, prevAlpha));

  if (snap.terrain) {
    for (let i = 0; i < game.terrain.length && i < snap.terrain.length; i++) {
      game.terrain[i] = snap.terrain.charCodeAt(i) - 48;
    }
  }

  if (snap.doors) {
    for (const [i, state, flipped, o, allow] of snap.doors) {
      const f = game.feat[i];
      if (f) { f.state = state; f.flipped = !!flipped; f.o = o; f.allow = allow; }
    }
  }
  const spikeT = typeof snap.spikeTime === 'number'
    ? snap.spikeTime
    : Math.max(0, (snap.time || 0) - (game.stasisPaused || 0) - (game._freezeTime || 0));
  game._spikeTime = spikeT;
  for (let i = 0; i < game.feat.length; i++) {
    const f = game.feat[i];
    if (f?.k !== 'spike') continue;
    const s = computeSpikeState(spikeT, f.delay);
    f.ph = s.ph;
    f.active = s.active;
  }
  if (snap.spikes) {
    for (const [i, out] of snap.spikes) {
      const f = game.feat[i];
      if (f) f.out = !!out;
    }
  }

  if (snap.items) {
    game.items.clear();
    for (const [i, name, age] of snap.items) game.items.set(i, { name, age });
  }

  const prevBombs = new Map();
  const prevPredBombs = [];
  for (const b of game.bombs) {
    if (b._pred) prevPredBombs.push(b);
    else prevBombs.set(b.id, b);
  }
  const matchedPred = new Set();
  game.bombs = (snap.bombs || []).map(sb => {
    const [id, x, y, cx, cy, owner, range, fuse, age, kind, vent, rx, ry] = sb;
    let old = prevBombs.get(id);
    if (!old && prevPredBombs.length) {
      const pi = prevPredBombs.findIndex(pb =>
        !matchedPred.has(pb) && pb.owner === owner &&
        ((pb.x === x && pb.y === y) || Math.hypot(rx - pb.rx, ry - pb.ry) <= 1.1)
      );
      if (pi >= 0) {
        old = prevPredBombs[pi];
        matchedPred.add(old);
      }
    }
    const prevRx = old ? old.prx + (old.rx - old.prx) * a : rx;
    const prevRy = old ? old.pry + (old.ry - old.pry) * a : ry;
    const jump = !old || Math.hypot(rx - prevRx, ry - prevRy) > 1.5;
    const stationary = old && Math.hypot(rx - prevRx, ry - prevRy) < 1e-4;
    return {
      id, x, y, cx, cy, owner, range, fuse, age, kind, vent, rx, ry,
      prx: (jump || stationary) ? rx : prevRx,
      pry: (jump || stationary) ? ry : prevRy,
    };
  });

  game.flames.clear();
  for (const [i, t, kind] of snap.flames || []) game.flames.set(i, { t, kind });

  const prevProjs = new Map(game.projs.map(p => [p.id, p]));
  game.projs = (snap.projs || []).map(sp => {
    const [id, x, y, d, spell, owner, life, dist] = sp;
    const old = prevProjs.get(id);
    const prevX = old ? old.px + (old.x - old.px) * a : x;
    const prevY = old ? old.py + (old.y - old.py) * a : y;
    const jump = !old || Math.hypot(x - prevX, y - prevY) > 1.5;
    return { id, x, y, d, spell, owner, life, dist, px: jump ? x : prevX, py: jump ? y : prevY };
  });

  const prevWinds = new Map(game.winds.map(w => [w.id, w]));
  game.winds = (snap.winds || []).map(sw => {
    const [id, owner, x, y, arms, t, max, cells] = sw;
    const obj = { id, owner, x, y, arms, t, max, cells: new Map(cells || []) };
    const old = prevWinds.get(id);
    return old ? Object.assign(old, obj) : obj;
  });

  if (snap.barriers) {
    game.barriers.clear();
    for (const [i, life] of snap.barriers) game.barriers.set(i, life);
  }

  const bySlot = new Map(game.players.map(p => [p.slot, p]));
  for (const sp of snap.players || []) {
    const [
      slot, id, x, y, dir, flags,
      lives, score, kills, wins, bombsMax, range,
      power, powerTime, powerMax, rad, ghost, inv, stun,
      tpPhase, tpTimer, tpDur, cast, hit, respawn, ack,
    ] = sp;
    const p = bySlot.get(slot);
    if (!p) continue;

    const moving = !!(flags & 1), alive = !!(flags & 2), out = !!(flags & 4), exited = !!(flags & 8), sprint = !!(flags & 16);
    const prevRenderX = p.px + (p.x - p.px) * a;
    const prevRenderY = p.py + (p.y - p.py) * a;
    const wasAlive = p.alive;
    const wasTp = p.tpPhase;
    const stationary = Math.hypot(x - prevRenderX, y - prevRenderY) < 1e-4;
    const jump = !game._netInitialized || (!wasAlive && alive) ||
      (wasTp === 'hide' && tpPhase === 'reveal') ||
      Math.hypot(x - p.x, y - p.y) > 1.5;

    p.id = id;
    p.fx = x;
    p.fy = y;
    p.px = (jump || stationary) ? x : prevRenderX;
    p.py = (jump || stationary) ? y : prevRenderY;
    p.dir = dir;
    p.moving = moving;
    p.alive = alive;
    p.out = out;
    p.exited = exited;
    p.sprint = sprint;
    p.lives = lives;
    p.score = score;
    p.kills = kills;
    p.wins = wins;
    p.bombsMax = bombsMax;
    p.range = range;
    p.power = power;
    p.powerTime = powerTime;
    p.powerMax = powerMax;
    p.radiation = rad;
    p.ghost = ghost;
    p.invuln = inv;
    p.stun = stun;
    p.tpPhase = tpPhase;
    p.tpTimer = tpTimer;
    p.tpDur = tpDur;
    p.cast = cast;
    p.hit = hit;
    p.respawn = respawn;
    p._netAck = ack;
  }

  const nextMonById = new Map();
  const nextMonsters = [];
  for (const sm of snap.monsters || []) {
    const [id, type, x, y, dir, flags, hp, maxHp, flash, stun, zapped, tpPhase, tpTimer, tpDur] = sm;
    const moving = !!(flags & 1), alive = !!(flags & 2), boss = !!(flags & 4);
    let m = game._netMonById?.get(id);
    if (!m) {
      m = makeClientMonster(sm);
    } else {
      const prevRenderX = m.px + (m.x - m.px) * a;
      const prevRenderY = m.py + (m.y - m.py) * a;
      const stationary = Math.hypot(x - prevRenderX, y - prevRenderY) < 1e-4;
      const jump = (m.tpPhase === 'hide' && tpPhase === 'reveal') ||
        Math.hypot(x - m.x, y - m.y) > 1.5;
      m.type = type;
      m.info = MONSTERS[type] || MONSTERS[3];
      m.x = x;
      m.y = y;
      m.px = (jump || stationary) ? x : prevRenderX;
      m.py = (jump || stationary) ? y : prevRenderY;
      m.dir = dir;
      m.moving = moving;
      m.alive = alive;
      m.boss = boss;
      m.hp = hp;
      m.maxHp = maxHp;
      m.flash = flash;
      m.stun = stun;
      m.zapped = zapped;
      m.tpPhase = tpPhase;
      m.tpTimer = tpTimer;
      m.tpDur = tpDur;
    }
    nextMonById.set(id, m);
    nextMonsters.push(m);
  }
  game._netMonById = nextMonById;
  game.monsters = nextMonsters;

  if (prevPredBombs.length) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const pb of prevPredBombs) {
      if (matchedPred.has(pb)) continue;
      const ownerP = bySlot.get(pb.owner);
      const acked = ownerP && typeof pb._predSeq === 'number' && (ownerP._netAck || 0) >= pb._predSeq;
      if (!acked && pb._predUntil > nowMs && !game.flames.has(pb.cy * W + pb.cx)) {
        game.bombs.push(pb);
      }
    }
  }

  game.portal = snap.portal;
  game.freeze = snap.freeze;
  game.stasis = snap.stasis;
  game.roundTime = snap.roundTime;
  game.state = snap.state;
  game.stateTime = snap.stateTime;
  game.time = snap.time;
  game.danger = snap.danger;
  game._netInitialized = true;
}
