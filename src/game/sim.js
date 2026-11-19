// Fracas 2027 rules engine: a deterministic grid simulation with smooth tile-to-tile motion.
// No rendering here; the renderer and audio read state and the `events` queue every frame.
import {
  W, H, DIRS, DIR_OF, T, FUSE, BLAST_TIME, BLAST_TIMES, POWER_TIME, SPIKE_CYCLE, SPIKE_OUT, WALKWAY_SPEED,
  PROJ_SPEED, MAX_RANGE, MAX_BOMBS, IQ, MONSTERS, PICKUP_INFO, TICK_HZ, computeSpikeState,
} from './constants.js';
import { decide, decideLoS } from './ai.js';
import { thinkBot } from './bot.js';

export class RNG {
  constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296; }
  int(n) { return Math.floor(this.next() * n); }
  pick(a) { return a[this.int(a.length)]; }
  shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}

export const idx = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
// Flip doors are L-shaped: code 0 = ⌟ (arms on the east + south edges), 1 = ⌞ (west + south), 2 = ⌜ (west + north),
// 3 = ⌝ (east + north). You walk in through the open inside of the L and push through the arm on the far side, so
// the way through depends on the L *and* on which way the gap runs. A blast or spell flips the L (code + 2).
function doorAllow(flipped, nsGap) {
  if (nsGap) return flipped ? 3 : 1;     // north-south passage: unflipped allows south (1), flipped allows north (3)
  return flipped ? 2 : 0;                // east-west passage: unflipped allows east (0), flipped allows west (2)
}
function isDoorClosedTo(f, d) {
  if ((d % 2 === 1) !== f.ns) return true;
  return (d <= 1 && f.state === 4) || (d >= 2 && f.state === 0);
}
export function doorSync(f) {
  if (f.state === 0) f.flipped = false;
  else if (f.state === 4) f.flipped = true;
  f.o = (f.kind + (f.flipped ? 2 : 0)) % 4;
  f.allow = doorAllow(f.flipped, f.ns);
}
export function doorStateAt(f, ax, ay) {
  const frac = Math.max(0, Math.min(1, f.ns ? (ay - f.y) : (ax - f.x)));
  const v = Math.max(0, Math.min(15, Math.floor(frac * 16)));
  return Math.floor(((v & 0xe) * 64) / 180);
}

let NEXT_ID = 1;

class Mover {
  constructor(x, y) {
    this.tx = x; this.ty = y; this.nx = x; this.ny = y; this.p = 0;       // tile, next tile, progress 0..1
    this.dir = 1; this.moving = false; this.speed = 3;
    this.push = null;                                                      // forced slide {d, n, speed}
    this.stepForced = false;
    this.stepBelt = -1;
    this.stun = 0; this.id = NEXT_ID++;
    this.px = x + 0.5; this.py = y + 0.5;                                  // previous position (render lerp)
  }
  get x() { return this.tx + 0.5 + (this.nx - this.tx) * this.p; }
  get y() { return this.ty + 0.5 + (this.ny - this.ty) * this.p; }
  get cx() { return this.p < 0.5 ? this.tx : this.nx; }                    // cell the body is mostly in
  get cy() { return this.p < 0.5 ? this.ty : this.ny; }
  place(x, y) { this.tx = this.nx = x; this.ty = this.ny = y; this.p = 0; this.moving = false; this.push = null; this.stepForced = false; this.stepBelt = -1; this.px = x + 0.5; this.py = y + 0.5; }
}

export const PLAYER_SPEED = 3.75;   // tiles per second, measured in the original game

/** Wizards move freely (2-pixel steps in the original) and stop the moment the key is released. */
export class Player extends Mover {
  constructor(slot, x, y, carry, level) {
    super(x, y);
    this.fx = x + 0.5; this.fy = y + 0.5; this.lastDir = -1;
    this.slot = slot; this.start = [x, y]; this.dir = 1;
    const c = carry || {};
    this.lives = c.lives ?? 3; this.score = c.score ?? 0;
    this.bombsMax = level?.startBombs || 1; this.range = level?.startRange || 1;       // FRACAS.EXE 0x1c04c: reset from level header every level
    this.shields = 0;                                  // (no shield pickups in the original)
    this.power = null; this.powerTime = 0; this.cooldown = 0; this.slotLock = 0;
    this.radiation = 0; this.ghost = 0; this.invuln = 100 / TICK_HZ; this.sprint = false; this.powerMax = 1;
    this.tpPhase = null; this.tpTimer = 0; this.tpDur = 0;
    this.out = (c.lives !== undefined && c.lives <= 0);
    this.alive = !this.out; this.respawn = 0;
    this.input = { dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false };
    this.cast = 0; this.hit = 0; this.kills = 0; this.wins = c.wins ?? 0;
    this.selfKills = 0; this.spellsCast = 0; this.rocksBroken = 0;
    this.bot = null; this.botTimer = 0; this.botDir = -1; this.botGoal = -1;
    this._speedMul = 1;
  }
  get x() { return this.fx; }
  get y() { return this.fy; }
  get cx() { return Math.floor(this.fx); }
  get cy() { return Math.floor(this.fy); }
  get speed() { return PLAYER_SPEED * (this._speedMul || 1) * (this.sprint ? 2 : 1); }      // speed boots double it (original: 2 -> 4 px/tick)
  set speed(v) {}
  place(x, y) { super.place(x, y); this.fx = x + 0.5; this.fy = y + 0.5; this.px = this.fx; this.py = this.fy; this.lastDir = -1; this.beltAlign = null; }
  carry() { return { lives: this.lives, score: this.score, wins: this.wins }; }
}

export class Monster extends Mover {
  constructor(x, y, type, beh, levelSpeed) {
    super(x, y);
    this.type = type; this.beh = beh; this.iq = IQ[beh & 15];
    const info = MONSTERS[type] || MONSTERS[3];
    this.info = info; this.speed = levelSpeed;           // every type moves at the level's speed, as in the original
    this.hp = 1; this.maxHp = 1; this.boss = false; this.alive = true; this.flash = 0; this.dir = 0;
    this.zapped = 0; this.tpPhase = null; this.tpTimer = 0; this.tpDur = 0;
    this.tpGrace = new Set();
    this.walkLeft = 0; this.aiState = 1; this.bfsGrid = null; this.huntTarget = null;
    this.touching = false; this.touchWait = 0; this.retreatingTouch = false; this.lastTouchDir = -1;
  }
  place(x, y) {
    super.place(x, y);
    this.touching = false; this.touchWait = 0; this.retreatingTouch = false; this.lastTouchDir = -1;
  }
}

export class Game {
  /**
   * level: entry from data/levels.json; opts: {mode, players:[slots], seed, carry:{slot:stats}, cheats}
   */
  constructor(level, opts = {}) {
    this.level = level; this.mode = opts.mode || 'normal';
    this.rng = new RNG(opts.seed ?? (level.id * 7919 + 13));
    this.nextId = 1;
    this.time = 0; this.events = []; this.state = 'play'; this.stateTime = 0;
    this.terrain = new Uint8Array(W * H); this.feat = new Array(W * H).fill(null);
    this.hidden = new Map(); this.items = new Map(); this.bombs = []; this.flames = new Map();
    this.projs = []; this.barriers = new Map(); this.scent = new Float32Array(W * H);
    this.winds = [];                                     // Inferno-jar wind zones
    this.portal = null; this.roundTime = 0; this.danger = null; this.dangerTick = -1;
    this.freeze = opts.freeze ?? (62 / TICK_HZ); // FRACAS.EXE 0x13bb2: 0x3e = 62 ticks ('GET READY')
    this.vents = [];
    this.stasis = 0; this.stasisOwner = -1; this.stasisPaused = 0; this._freezeTime = 0;
    const rocks = [];
    level.rows.forEach((row, y) => [...row].forEach((c, x) => {
      const i = idx(x, y);
      if (c === '#') this.terrain[i] = T.WALL;
      else if (c === '%') { this.terrain[i] = T.ROCK; rocks.push(i); }
      else if (c in DIR_OF && '<>v^'.includes(c)) this.feat[i] = { k: 'oneway', d: DIR_OF[c] };
      else if ('UDLR'.includes(c)) this.feat[i] = { k: 'walk', d: DIR_OF[c] };
    }));
    for (const [x, y, g] of level.vents) { this.feat[idx(x, y)] = { k: 'vent', g }; this.vents.push([x, y, g]); }
    for (const [x, y, wall, phase] of level.spikes) this.feat[idx(x, y)] = { k: 'spike', wall, delay: phase || 0, phase: (phase || 0) / 106, ph: 0, active: false, out: false };
    for (const [x, y, o] of level.doors) this.feat[idx(x, y)] = { k: 'door', x, y, kind: o, o, d: o, flipped: false, state: 0 };
    for (const [x, y] of level.doors) {                // which way does the gap run? (walls left+right = north-south)
      const f = this.feat[idx(x, y)];
      const wallLR = this.solid(x - 1, y) && this.solid(x + 1, y);
      const wallUD = this.solid(x, y - 1) && this.solid(x, y + 1);
      f.ns = wallLR ? true : wallUD ? false : (f.kind % 2 === 1);
      f.isHoriz = !f.ns;
      f.allow = doorAllow(f.flipped, f.ns);
      f.state = f.flipped ? 4 : 0;
    }
    // hide the pickups under random rocks (randomized every run, like original Fracas)
    const pool = [];
    for (const [name, n] of Object.entries(level.pickups || {})) for (let k = 0; k < n; k++) pool.push(name);
    this.rng.shuffle(pool);
    this.rng.shuffle(rocks);
    pool.slice(0, rocks.length).forEach((name, k) => this.hidden.set(rocks[k], name));
    // actors
    const mut = this.mutators = {
      friendlyFire: opts.mutators?.friendlyFire !== false,
      fuseScale: Number(opts.mutators?.fuseScale) > 0 ? Math.max(0.35, Math.min(2, Number(opts.mutators.fuseScale))) : 1,
      speedScale: Number(opts.mutators?.speedScale) > 0 ? Math.max(0.75, Math.min(1.75, Number(opts.mutators.speedScale))) : 1,
      startMax: !!opts.mutators?.startMax,
      suddenDeath: opts.mutators?.suddenDeath === 'fast' ? 'fast' : 'normal',
    };
    const bots = opts.bots || {};
    const slots = opts.players || [0];
    this.players = [];
    for (const s of slots) {
      const st = level.starts[String(s + 1)];
      if (st) {
        const p = new Player(s, st[0], st[1], opts.carry?.[s], level);
        p.id = this.allocId();
        p._speedMul = mut.speedScale;
        if (mut.startMax) { p.bombsMax = MAX_BOMBS; p.range = MAX_RANGE; }
        if (bots[s]) p.bot = bots[s];
        this.players.push(p);
      }
    }
    this.monsters = [];
    // original formula (FRACAS.EXE): speed = 0.75 + (level-1)/60 + random 0..0.5 pixels per game tick,
    // levels past 60 keep the level-60 speed; 1 px/tick = 2.45 tiles/s (measured: level-1 blob, wizards 3.75)
    // the new levels 61-100 have hunting monsters, so they run slower: level 61 at the level-20 speed, level 100 at level-35
    const speedLevel = Math.min(60, level.id);
    const lvBase = 0.75 + (speedLevel - 1) / 60;
    const monsterSpeed = () => (lvBase + this.rng.next() * 0.5) * (PLAYER_SPEED / 2);
    if (this.mode === 'normal') {
      for (const [x, y, type, beh] of level.monsters) {
        const m = new Monster(x, y, type, beh, monsterSpeed());
        m.id = this.allocId();
        this.monsters.push(m);
      }
      if (level.boss) {
        const c = this.monsters.filter(m => m.beh === 7 && MONSTERS[m.type]?.family === 'humanoid')
          .sort((a, b) => Math.hypot(a.tx - 10, a.ty - 7) - Math.hypot(b.tx - 10, b.ty - 7))[0];
        // the world's guardian looks and dies like any other monster, but has the sharpest brain in the game
        if (c) { c.smart = true; c.iq = 0x3f; }
      }
    }
    this.cheats = opts.cheats || {};
  }

  allocId() { return this.nextId++; }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // ---------------------------------------------------------------- terrain queries
  solid(x, y) { return !inside(x, y) || this.terrain[idx(x, y)] !== T.FLOOR; }
  bombAt(x, y) { return this.bombs.find(b => b.x === x && b.y === y && !b.sliding); }
  anyBombAt(x, y) { return this.bombs.find(b => b.cx === x && b.cy === y); }
  inWind(x, y) { const i = idx(x, y); return this.winds.some(w => w.cells?.has(i) || (w.x === x && w.y === y)); }
  windDirAt(x, y) { const i = idx(x, y); for (const w of this.winds) if (w.cells?.has(i)) return w.cells.get(i); return -1; }
  blockedBetween(x1, y1, x2, y2) {
    if (x1 === x2 && y1 === y2) return false;
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      if (this.solid(x1, y1) || this.solid(x2, y2)) return true;
      if (this.barriers.has(idx(x1, y1)) || this.barriers.has(idx(x2, y2))) return true;
      const d = dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
      const opp = (d + 2) % 4;
      const f1 = this.feat[idx(x1, y1)], f2 = this.feat[idx(x2, y2)];
      const can1to2 = !(f1?.k === 'door' && f1.allow !== d) && !(f2?.k === 'door' && f2.allow !== d);
      const can2to1 = !(f2?.k === 'door' && f2.allow !== opp) && !(f1?.k === 'door' && f1.allow !== opp);
      if (f1?.k === 'door' && (f1.state === 0 || f1.state === 4) && (!can1to2 || !can2to1)) return true;
      if (f2?.k === 'door' && (f2.state === 0 || f2.state === 4) && (!can1to2 || !can2to1)) return true;
      if (f1?.k === 'oneway' && f1.d !== d && f1.d !== opp) return true;
      if (f2?.k === 'oneway' && f2.d !== d && f2.d !== opp) return true;
      return !can1to2 && !can2to1;
    }
    if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
      return this.blockedBetween(x1, y1, x2, y1) && this.blockedBetween(x1, y1, x1, y2);
    }
    return true;
  }
  canTouch(who, x, y, d) {
    const [dx, dy] = DIRS[d], nx = x + dx, ny = y + dy;
    if (!inside(nx, ny) || this.terrain[idx(nx, ny)] !== T.FLOOR) return false;
    if (this.anyBombAt(nx, ny) && (!(who instanceof Player) || Math.abs(who.fx - (nx + 0.5)) >= 0.85 || Math.abs(who.fy - (ny + 0.5)) >= 0.85)) return false;
    const here = this.feat[idx(x, y)], there = this.feat[idx(nx, ny)];
    if (here?.k === 'oneway' && here.d !== d) return false;
    if (here?.k === 'door' && (d % 2 === 1) !== here.ns) return false;
    if (this.barriers.has(idx(nx, ny))) return true;
    if (there?.k === 'door' && (d % 2 === 1) === there.ns && (isDoorClosedTo(there, d) || ((who instanceof Player || who?.touching) && this.flames.has(idx(nx, ny))))) return true;
    if (there?.k === 'oneway' && there.d !== d) return true;
    return false;
  }

  touchLimit(x, y, d) {
    const [dx, dy] = DIRS[d], nx = x + dx, ny = y + dy;
    if (!inside(nx, ny)) return 0.48;
    const i = idx(nx, ny), there = this.feat[i];
    return (!this.barriers.has(i) && there?.k === 'oneway' && there.d !== d) ? 0.56 : 0.48;
  }

  /** can `who` step from (x,y) in direction d? */
  canStep(who, x, y, d) {
    const [dx, dy] = DIRS[d], nx = x + dx, ny = y + dy;
    if (!inside(nx, ny) || this.terrain[idx(nx, ny)] !== T.FLOOR) return false;
    if (this.barriers.has(idx(nx, ny))) return false;
    const here = this.feat[idx(x, y)], there = this.feat[idx(nx, ny)];
    if (here?.k === 'oneway' && here.d !== d) return false;
    // FRACAS.EXE 0xc48d..0xc4ff: inside a door cell, actors can move either way along the corridor (push through or back out)
    if (here?.k === 'door' && (d % 2 === 1) !== here.ns) return false;
    // a wizard may step onto an arrow from the wrong side (he can only leave it the way it points, i.e. back out),
    // and while he stands on it a blast coming against the arrow can't reach him (blastLine stops before the arrow cell)
    if (there?.k === 'oneway' && there.d !== d) return false;
    if (there?.k === 'door' && isDoorClosedTo(there, d)) return false;
    // Hold touching actor on cover threshold if doorway is actively burning right after a blast
    if ((who instanceof Player || who?.touching) && there?.k === 'door' && this.flames.has(idx(nx, ny))) return false;
    if (this.anyBombAt(nx, ny)) {
      const onBeltOrWind = here?.k === 'walk' || this.windDirAt(x, y) >= 0;
      if (!onBeltOrWind && (!(who instanceof Player) || Math.abs(who.fx - (nx + 0.5)) >= 0.85 || Math.abs(who.fy - (ny + 0.5)) >= 0.85)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- main update
  update(dt) {

    this.time += dt; this.stateTime += dt;
    for (const p of this.players) { p.px = p.x; p.py = p.y; }
    for (const m of this.monsters) { m.px = m.x; m.py = m.y; }
    for (const pr of this.projs) { pr.px = pr.x; pr.py = pr.y; }
    for (const b of this.bombs) {
      const [dx, dy] = b.slide ? DIRS[b.slide.d] : [0, 0];
      b.prx = b.rx ?? (b.x + dx * b.sp); b.pry = b.ry ?? (b.y + dy * b.sp);
    }
    if (this.state !== 'play' && this.state !== 'clear') return;
    if (this.freeze > 0) { this.freeze -= dt; this._freezeTime += dt; for (const p of this.players) { p.input.bomb = p.input.power = false; } return; }
    this.roundTime += dt;
    if (this.stasis > 0) {
      this.stasis = Math.max(0, this.stasis - dt);
      this.stasisPaused += dt;
      if (this.stasis === 0) this.emit({ t: 'stasisEnd' });
    }
    if (this.stasis <= 0) {
      this.updateSpikes();
      this.updateBarriers(dt);
    }
    for (const p of this.players) this.updatePlayer(p, dt);
    for (const m of this.monsters) if (m.alive && this.stasis <= 0) this.updateMonster(m, dt);
    this.updateBombs(dt);
    this.updateProjectiles(dt);
    this.updateFlames(dt);
    this.updateWinds(dt);
    this.updateItems(dt);
    if (this.stasis <= 0) this.updateScent(dt);
    this.checkContacts();
    this.checkEnd();
  }

  // ---------------------------------------------------------------- movement
  stepMover(e, dt, chooseDir) {
    let budget = dt;
    for (let guard = 0; guard < 4 && budget > 0; guard++) {
      if (!e.moving) {
        let d = -1, speed = e.speed, forced = false, stepBelt = -1;
        const f = this.feat[idx(e.tx, e.ty)];
        // FRACAS.EXE 0x0c0c7: monsters ignore permanent conveyors (+0x01 == 0xff); only timed winds push them
        const beltD = !(e instanceof Monster) && f?.k === 'walk' ? f.d : this.windDirAt(e.tx, e.ty);
        if (e.push) {
          if (e.push.n > 0 && this.canStep(e, e.tx, e.ty, e.push.d)) { d = e.push.d; speed = e.push.speed; forced = true; e.push.n--; }
          else e.push = null;
        }
        if (d < 0) {
          d = e.stun > 0 ? -1 : chooseDir();
          const canFullStep = d >= 0 && this.canStep(e, e.tx, e.ty, d);
          const canTouchStep = d >= 0 && !canFullStep && (e instanceof Monster) && this.canTouch(e, e.tx, e.ty, d);
          if (d >= 0 && !canFullStep && !canTouchStep) d = -1;
          if (d >= 0 && e instanceof Monster) {
            if (canFullStep) e.lastTouchDir = -1;
            e.touching = canTouchStep; e.touchWait = 0; e.retreatingTouch = false;
          }
          if (beltD >= 0) {
            stepBelt = beltD;
            if (d < 0 && this.canStep(e, e.tx, e.ty, beltD)) { d = beltD; speed = WALKWAY_SPEED; forced = true; }
            else if (d === beltD) speed += WALKWAY_SPEED;
            else if (d === (beltD + 2) % 4) {
              if (speed < WALKWAY_SPEED - 1e-6) {
                if (this.canStep(e, e.tx, e.ty, beltD)) { d = beltD; speed = WALKWAY_SPEED - speed; forced = true; }
                else d = -1;
              } else if (speed > WALKWAY_SPEED + 1e-6) {
                speed -= WALKWAY_SPEED;
              } else {
                d = -1;
              }
            } else if (d >= 0 && speed < WALKWAY_SPEED - 1e-6 && this.canStep(e, e.tx, e.ty, beltD)) {
              d = beltD; speed = WALKWAY_SPEED; forced = true;
            }
            if (d >= 0 && e instanceof Monster && forced) {
              e.touching = false; e.touchWait = 0; e.retreatingTouch = false; e.lastTouchDir = -1;
            }
          }
        }
        if (d < 0) return;
        e.dir = forced && e instanceof Player ? e.dir : d;
        if (!forced) e.dir = d;
        e.nx = e.tx + DIRS[d][0]; e.ny = e.ty + DIRS[d][1]; e.p = 0; e.moving = true; e.stepSpeed = speed;
        e.stepDir = d; e.stepForced = forced; e.stepBelt = stepBelt;
      }
      // FRACAS.EXE 0xbb6c: stunned/electrocuted actors freeze immediately at their current position (unless forced by conveyor/gust)
      if (e.stun > 0 && !e.stepForced && !e.push) return;
      if (e.moving && (e.stepBelt ?? -1) < 0 && !e.stepForced && !e.push) {
        const wDir = this.windDirAt(e.cx, e.cy);
        if (wDir >= 0) {
          e.stepBelt = wDir;
          if (e.stepDir === wDir) e.stepSpeed += WALKWAY_SPEED;
          else if (e.stepDir === (wDir + 2) % 4) {
            if (e.stepSpeed < WALKWAY_SPEED - 1e-6) {
              if (e.p > 1e-6 && this.canStep(e, e.nx, e.ny, wDir)) {
                [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty]; e.p = 1 - e.p;
                e.stepDir = wDir; e.stepSpeed = WALKWAY_SPEED - e.stepSpeed; e.stepForced = true;
                if (e instanceof Monster) { e.touching = false; e.touchWait = 0; e.retreatingTouch = true; }
              } else if (this.canStep(e, e.tx, e.ty, wDir)) {
                e.nx = e.tx + DIRS[wDir][0]; e.ny = e.ty + DIRS[wDir][1];
                e.stepDir = wDir; e.stepSpeed = WALKWAY_SPEED - e.stepSpeed; e.stepForced = true;
                if (e instanceof Monster) { e.touching = false; e.touchWait = 0; e.retreatingTouch = false; }
              }
            } else if (e.stepSpeed > WALKWAY_SPEED + 1e-6) {
              e.stepSpeed -= WALKWAY_SPEED;
            } else {
              e.stepSpeed = 0;
            }
          }
        }
      } else if (e.moving && e.stepSpeed <= 1e-9 && (e.stepBelt ?? -1) >= 0 && ((e instanceof Monster) || this.feat[idx(e.cx, e.cy)]?.k !== 'walk') && this.windDirAt(e.cx, e.cy) < 0) {
        e.stepSpeed = e.speed; e.stepBelt = -1;
      }
      // reversal mid-step for players feels responsive
      if (e instanceof Player && !e.push && e.input.dir >= 0 && e.input.dir === (e.stepDir + 2) % 4 && e.stun <= 0) {
        [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty]; e.p = 1 - e.p; e.stepDir = e.input.dir; e.dir = e.input.dir;
      }
      // FRACAS.EXE 0x11585 / 0x11d48: monsters react every tick along corridors (mid-step 180° reversal on LoS hazards/targets)
      if (e instanceof Monster && e.moving && !e.stepForced && !e.push && !e.retreatingTouch && !e.touching && e.stun <= 0 && (e.iq & 0x3c) !== 0 && e.p > 1e-6 && e.p < 1 - 1e-6) {
        const rev = (e.stepDir + 2) % 4;
        const stepOpts = this._midStepOpts || (this._midStepOpts = []), opts = this._midOpts || (this._midOpts = []);
        stepOpts.length = 0; opts.length = 0;
        for (let d = 0; d < 4; d++) {
          if (this.canStep(e, e.cx, e.cy, d)) { stepOpts.push(d); opts.push(d); }
          else if (this.canTouch(e, e.cx, e.cy, d) && e.lastTouchDir !== d) opts.push(d);
        }
        const { d: losDir, los } = decideLoS(this, e, e.cx, e.cy, opts, stepOpts, false);
        const revSafe = !this.solid(e.tx, e.ty) && !this.barriers.has(idx(e.tx, e.ty)) && !this.anyBombAt(e.tx, e.ty) && !this.flames.has(idx(e.tx, e.ty)) &&
          !((e.iq & 0x10) && los[rev].bomb) && !((e.iq & 0x20) && los[rev].proj);
        const aheadDanger = ((e.iq & 0x10) && (los[e.stepDir].bomb || this.anyBombAt(e.nx, e.ny) || this.flames.has(idx(e.nx, e.ny)))) ||
          ((e.iq & 0x20) && los[e.stepDir].proj);
        if (revSafe && (losDir === rev || (aheadDanger && losDir !== null && losDir !== e.stepDir))) {
          [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty]; e.p = 1 - e.p; e.stepDir = rev; e.dir = rev;
          e.aiState = 1; e.bfsGrid = null;
          e.walkLeft = losDir === rev ? Math.max(1, los[rev].dist + 1) : 0;
        }
      }
      // FRACAS.EXE 0xc577..0xc5ff: monsters step up to wrong-way arrows, closed doors & electric barriers, stand by them, or block/reverse
      if (e.moving && e.retreatingTouch) {
        const retBlocked = !inside(e.nx, e.ny) || this.terrain[idx(e.nx, e.ny)] !== T.FLOOR || this.barriers.has(idx(e.nx, e.ny));
        if (retBlocked) {
          if (this.barriers.has(idx(e.nx, e.ny)) && (e.barrierSoundT || 0) <= 0) {
            e.barrierSoundT = 0.055;
            this.emit({ t: 'barrierTouch', x: e.x, y: e.y });
          }
          e.touching = false; e.retreatingTouch = false; e.touchWait = 0;
          if (e.p > 1e-6) {
            [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty]; e.p = 1 - e.p;
            e.stepDir = (e.stepDir + 2) % 4; e.dir = e.stepDir;
          } else {
            e.nx = e.tx; e.ny = e.ty; e.p = 0; e.moving = false; e.stepForced = false; e.stepBelt = -1; continue;
          }
        }
      } else if (e.moving && !this.canStep(e, e.tx, e.ty, e.stepDir)) {
        const limit = this.touchLimit(e.tx, e.ty, e.stepDir);
        if ((e instanceof Monster) && !e.stepForced && !e.push && this.canTouch(e, e.tx, e.ty, e.stepDir) && e.p <= limit + 1e-6) {
          e.touching = true;
          if (e.p < limit - 1e-6) {
            const needTouch = (limit - e.p) / e.stepSpeed;
            if (budget >= needTouch) {
              budget -= needTouch;
              e.p = limit;
              this.checkMonsterEat(e);
              if (this.barriers.has(idx(e.nx, e.ny)) && (e.barrierSoundT || 0) <= 0) {
                e.barrierSoundT = 0.055;
                this.emit({ t: 'barrierTouch', x: e.x, y: e.y });
              }
              // FRACAS.EXE 0x11555 -> 0x11de2: roll random direction 0..3 & walk counter ((rng >> 4) & 0x7c) pixels
              const holdCharge = this.monsterChargeTouch(e, e.stepDir);
              if (!holdCharge && this.rng.int(4) === 0) {
                e.touchWait = 0;
              } else {
                const px = (this.rng.int(32) * 4) || 24;
                e.touchWait = (px / 16) / Math.max(e.speed, 1);
              }
            } else {
              e.p += budget * e.stepSpeed;
              budget = 0;
              this.checkMonsterEat(e);
              continue;
            }
          }
          if (this.monsterUrgentFlee(e)) {
            e.touchWait = 0;
          } else if (this.monsterChargeTouch(e, e.stepDir)) {
            e.touchWait = Math.max(e.touchWait, 0.25);
          }
          if (e.touchWait > 1e-6 && budget > 0) {
            const wait = Math.min(budget, e.touchWait);
            e.touchWait -= wait;
            budget -= wait;
            if (e.touchWait > 1e-6) continue;
          }
          e.lastTouchDir = e.stepDir;
          e.touching = false; e.retreatingTouch = true; e.touchWait = 0; e.walkLeft = 0;
          [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty];
          e.p = 1 - e.p;
          e.stepDir = (e.stepDir + 2) % 4; e.dir = e.stepDir;
          continue;
        }
        if (this.barriers.has(idx(e.nx, e.ny)) && (e.barrierSoundT || 0) <= 0) {
          e.barrierSoundT = 0.055;
          this.emit({ t: 'barrierTouch', x: e.x, y: e.y });
        }
        e.push = null; e.walkLeft = 0;
        if (e instanceof Monster) { e.touching = false; e.touchWait = 0; }
        if (e.p > 1e-6) {
          [e.tx, e.nx] = [e.nx, e.tx]; [e.ty, e.ny] = [e.ny, e.ty]; e.p = 1 - e.p;
          e.stepDir = (e.stepDir + 2) % 4; e.dir = e.stepDir;
          if (e instanceof Monster) e.retreatingTouch = true;
        } else {
          e.nx = e.tx; e.ny = e.ty; e.p = 0; e.moving = false; e.stepForced = false; e.stepBelt = -1;
          if (e instanceof Monster) e.retreatingTouch = false;
          continue;
        }
      }
      const prevCx = e.cx, prevCy = e.cy;
      const need = (1 - e.p) / e.stepSpeed;
      if (budget >= need) {
        budget -= need;
        e.tx = e.nx; e.ty = e.ny; e.p = 0; e.moving = false; e.stepForced = false; e.stepBelt = -1;
        if (e instanceof Monster) { e.touching = false; e.retreatingTouch = false; e.touchWait = 0; }
        const curCx = e.cx, curCy = e.cy;
        if (curCx !== prevCx || curCy !== prevCy) {
          const df = this.feat[idx(prevCx, prevCy)];
          if (df?.k === 'door') {
            const ed = curCx > prevCx ? 0 : curCy > prevCy ? 1 : curCx < prevCx ? 2 : 3;
            if ((ed % 2 === 1) === df.ns) this.flipDoor(idx(prevCx, prevCy), ed <= 1 ? 4 : 0, true);
          }
        }
        const curDoor = this.feat[idx(curCx, curCy)];
        if (e.stepSpeed > 1e-6 && curDoor?.k === 'door') { curDoor.state = doorStateAt(curDoor, e.x, e.y); doorSync(curDoor); }
        if (e.arrive) e.arrive();
        this.onArrive(e);
      } else {
        const dp = budget * e.stepSpeed;
        e.p += dp; budget = 0;
        this.checkMonsterEat(e);
        const curCx = e.cx, curCy = e.cy;
        if (curCx !== prevCx || curCy !== prevCy) {
          const df = this.feat[idx(prevCx, prevCy)];
          if (df?.k === 'door') {
            const ed = curCx > prevCx ? 0 : curCy > prevCy ? 1 : curCx < prevCx ? 2 : 3;
            if ((ed % 2 === 1) === df.ns) this.flipDoor(idx(prevCx, prevCy), ed <= 1 ? 4 : 0, true);
          }
        }
        const curDoor = this.feat[idx(curCx, curCy)];
        if (dp > 1e-6 && curDoor?.k === 'door') { curDoor.state = doorStateAt(curDoor, e.x, e.y); doorSync(curDoor); }
      }
    }
  }

  checkMonsterEat(m) {
    if (!(m instanceof Monster) || !m.alive || m.tpPhase === 'hide') return;
    const i = idx(m.cx, m.cy);
    if (this.items.has(i)) { const it = this.items.get(i); this.items.delete(i); this.emit({ t: 'eat', x: m.cx, y: m.cy, name: it.name }); }
  }

  onArrive(e) {
    this.checkMonsterEat(e);
  }

  /** True if a bomb/flame or incoming projectile along any line of sight requires a touching monster to break off and flee */
  monsterUrgentFlee(m) {
    if ((m.iq & 0x30) === 0) return false;
    if ((m.iq & 0x10) && (this.anyBombAt(m.tx, m.ty) || this.flames.has(idx(m.tx, m.ty)) || this.anyBombAt(m.cx, m.cy) || this.flames.has(idx(m.cx, m.cy)))) {
      return true;
    }
    for (let cd = 0; cd < 4; cd++) {
      const [dx, dy] = DIRS[cd], opp = (cd + 2) % 4;
      for (let k = 1; k < 22; k++) {
        const nx = m.tx + dx * k, ny = m.ty + dy * k;
        if (!inside(nx, ny)) break;
        const i = idx(nx, ny);
        if ((m.iq & 0x10) && (this.flames.has(i) || this.anyBombAt(nx, ny))) return true;
        if (this.terrain[i] === T.WALL || this.terrain[i] === T.ROCK || this.barriers.has(i)) break;
        if ((m.iq & 0x20) && this.projs.some(pr => pr.d === opp && Math.floor(pr.x) === nx && Math.floor(pr.y) === ny)) return true;
      }
    }
    return false;
  }

  /** True if a monster at a portal/door threshold sees a wizard (bit3) or pickup (bit2) straight ahead */
  monsterChargeTouch(m, d) {
    if ((m.iq & 0x0c) === 0) return false;
    const [dx, dy] = DIRS[d];
    for (let k = 1; k < 22; k++) {
      const nx = m.tx + dx * k, ny = m.ty + dy * k;
      if (!inside(nx, ny)) break;
      const i = idx(nx, ny);
      if (this.flames.has(i) || this.anyBombAt(nx, ny)) break;
      if (this.terrain[i] === T.WALL || this.terrain[i] === T.ROCK || this.barriers.has(i)) break;
      if ((m.iq & 0x08) && this.players.some(p => p.alive && p.ghost <= 0 && p.cx === nx && p.cy === ny)) return true;
      if ((m.iq & 0x04) && this.items.has(i)) return true;
    }
    return false;
  }

  updatePlayer(p, dt) {
    if (p.out) return;
    if (p.power) {
      const before = p.powerTime; p.powerTime -= dt;
      for (const t of [300, 120, 90, 60, 30]) {
        const w = t / TICK_HZ;
        if (before > w && p.powerTime <= w) { this.emit({ t: 'powerLow', p: p.slot, x: p.x }); break; }
      }
      if (p.powerTime <= 0) {
        this.releaseIgnitor(p);
        p.power = null; p.sprint = false; this.emit({ t: 'powerEnd', p: p.slot });
      }
    }
    if (!p.alive) {
      if (this.mode === 'normal' && p.lives > 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) {
          const [rx, ry] = p.deathCell || p.start;
          p.alive = true; p.place(rx, ry); p.invuln = 100 / TICK_HZ; p.stun = 0;
          this.emit({ t: 'respawn', p: p.slot, x: p.tx, y: p.ty });
        }
      }
      return;
    }
    p.invuln = Math.max(0, p.invuln - dt); p.radiation = Math.max(0, p.radiation - dt);
    p.ghost = Math.max(0, p.ghost - dt); p.stun = Math.max(0, p.stun - dt);
    p.cooldown = Math.max(0, p.cooldown - dt); p.slotLock = Math.max(0, p.slotLock - dt);
    p.cast = Math.max(0, p.cast - dt); p.hit = Math.max(0, p.hit - dt); p.barrierSoundT = Math.max(0, (p.barrierSoundT || 0) - dt);
    if (p.tpPhase) {
      this.stepTeleportPhase(p, dt);
      p.moving = false; p.input.bomb = false; p.input.power = false;
      return;
    }
    if (p.bot) thinkBot(this, p, dt);
    const inp = p.input;
    if (p._clientMoved) {
      p._clientMoved = false;
    } else {
      this.movePlayer(p, dt);
    }
    p.tx = p.cx; p.ty = p.cy;
    const bombActive = !!(inp.bomb || inp.bombHeld);
    const powerActive = !!(inp.power || inp.powerHeld);
    inp.bomb = false;
    inp.power = false;
    const suppressBomb = powerActive && p.power && p.power !== 'foot';
    if (bombActive && !suppressBomb && p.stun <= 0) {
      this.placeBomb(p, 'fire');
    }
    if (powerActive && p.stun <= 0) {
      this.usePower(p, bombActive);
    }
    // scent for bloodhounds
    if (p.ghost <= 0) this.scent[idx(p.cx, p.cy)] = 1;
    // pick up
    const i = idx(p.cx, p.cy);
    if (this.items.has(i)) { const it = this.items.get(i); this.items.delete(i); this.applyPickup(p, it.name); }
    // spikes
    const f = this.feat[i];
    if (f?.k === 'spike' && f.out && this.stasis <= 0) this.hurtPlayer(p, 'spike');
  }

  /**
   * Original Fracas movement: free movement along corridors; a new direction across the current axis is taken
   * only once the wizard is lined up with the grid - until then he keeps going the way he was moving.
   */
  movePlayer(p, dt, predict = false) {
    const EPS = 1e-6;
    p.moving = false;
    let remDt = dt, moved = 0, faced = -1, anyForced = true;
    let curCx = p.cx, curCy = p.cy;
    for (let guard = 0; guard < 8 && remDt > 1e-7; guard++) {
      let want = p.stun > 0 ? -1 : p.input.dir, speed = p.speed, forced = false;
      const here = this.feat[idx(p.cx, p.cy)];
      const beltD = p.push ? -1 : (here?.k === 'walk' ? here.d : this.windDirAt(p.cx, p.cy));
      if (beltD < 0 || (p.beltAlign && (p.beltAlign.cx !== p.cx || p.beltAlign.cy !== p.cy || p.beltAlign.d !== beltD || want !== beltD))) {
        p.beltAlign = null;
      }

      if (p.push) {
        want = p.push.d; speed = p.push.speed; forced = true; p.beltAlign = null;
      } else if (beltD >= 0) {
        const oppBelt = (beltD + 2) % 4;
        const beltH = beltD % 2 === 0;
        const posW = beltH ? p.fy : p.fx, centerW = Math.floor(posW) + 0.5;
        const onBeltAxis = Math.abs(posW - centerW) <= EPS;
        const posB = beltH ? p.fx : p.fy, centerB = Math.floor(posB) + 0.5;
        const atBeltCenter = Math.abs(posB - centerB) <= EPS;
        if (!onBeltAxis) {
          // FRACAS.EXE 0xc522/0xc538 + 0xc48b=-1: belts only push when aligned on the belt lane axis;
          // idle stays put (no backward vacuum pull) and partial off-axis parallel keys cannot corner-round.
          // After a perpendicular belt drops the wizard near a corner edge (|posW - centerW| > 0.25),
          // pressing beltD aligns onto centerW to enter the corner belt instead of stalling.
          const canCornerEnterBelt = want === beltD && (Math.abs(posW - centerW) > 0.25 || p.beltAlign) && this.canStep(p, p.cx, p.cy, beltD);
          if (canCornerEnterBelt) p.beltAlign = { cx: p.cx, cy: p.cy, d: beltD };
          else if (want < 0 || want === beltD || want === oppBelt) break;
        } else {
          p.beltAlign = null;
          if (want < 0) {
            want = beltD; speed = WALKWAY_SPEED; forced = true;
          } else if (want === beltD) {
            speed += WALKWAY_SPEED;
          } else if (want === oppBelt) {
            if (speed > WALKWAY_SPEED + EPS) speed -= WALKWAY_SPEED;
            else if (speed >= WALKWAY_SPEED - EPS) { anyForced = false; faced = oppBelt; break; }
            else { want = beltD; speed = WALKWAY_SPEED - speed; forced = true; }
          } else {
            // FRACAS.EXE 0x0d2f9..0x0d4b8: 1px cross-axis snap lets open perpendicular input at centerB exit immediately.
            const canTurnNow = atBeltCenter && this.canGo(p, want);
            if (!canTurnNow) {
              want = beltD; speed = WALKWAY_SPEED; forced = true;
            }
          }
        }
      }
      if (want < 0) { if (!forced && beltD < 0) p.lastDir = -1; break; }
      if (!forced) anyForced = false;
      const budget = speed * remDt;
      // original rule: a new direction is taken only when it is open; until then the wizard keeps
      // going the way he was moving (disabled on belts/wind where FRACAS.EXE sets [0xc48b]=-1)
      let d = want;
      if (!forced && beltD < 0 && !this.canGo(p, want)) {
        const secWant = p.stun > 0 ? -1 : (p.input.secDir ?? -1);
        if (secWant >= 0 && secWant % 2 !== want % 2 && this.canGo(p, secWant)) {
          d = secWant;
        } else {
          const hf0 = this.feat[idx(p.cx, p.cy)];
          const horizWant = want % 2 === 0;
          const crossDirs0 = horizWant ? [1, 3] : [0, 2];
          const crossPos = horizWant ? p.fy : p.fx;
          const crossCenter = Math.floor(crossPos) + 0.5;
          const off = crossPos - crossCenter;
          const towardDir = off > 0 ? crossDirs0[0] : crossDirs0[1];
          const adjCx = p.cx + DIRS[towardDir][0], adjCy = p.cy + DIRS[towardDir][1];
          const canSlideToward = hf0?.k !== 'oneway' &&
            this.canStep(p, p.cx, p.cy, towardDir) && this.canStep(p, adjCx, adjCy, want);
          if (canSlideToward && secWant < 0 && Math.abs(off) > 0.20) {
            d = towardDir;
          } else if (canSlideToward && Math.abs(off) > 0.08 && (p.lastDir < 0 || p.lastDir === towardDir)) {
            d = towardDir;
          } else if (p.lastDir >= 0 && p.lastDir % 2 !== want % 2 && this.canGo(p, p.lastDir)) {
            d = p.lastDir;
          }
        }
      }
      const horiz = d % 2 === 0;
      const cross = horiz ? p.fy : p.fx, crossC = Math.floor(cross) + 0.5;
      if (Math.abs(cross - crossC) > EPS) {
        if (beltD >= 0 && !(p.beltAlign && d === beltD)) break;
        // line up first: continue along cross axis if open (NEVER corner-assist across belt/wind tiles, [0xc48b]=-1), else nearest centre
        const hf = this.feat[idx(p.cx, p.cy)];
        if (hf?.k === 'oneway' && Math.abs(cross - crossC) > 0.35 && !this.canStep(p, p.cx, p.cy, d)) break;
        const crossDirs = horiz ? [1, 3] : [0, 2];
        const ad = hf?.k === 'oneway' && crossDirs.includes(hf.d) ? hf.d : crossDirs.includes(p.lastDir) ? p.lastDir : (cross > crossC ? crossDirs[1] : crossDirs[0]);
        const sgn = ad === 0 || ad === 1 ? 1 : -1;
        const canContinue = beltD < 0 && !forced && this.canStep(p, p.cx, p.cy, ad) &&
          (this.canStep(p, p.cx + DIRS[ad][0], p.cy + DIRS[ad][1], d) || Math.abs(cross - crossC) > 0.30);
        const target = canContinue ? (sgn > 0 ? (cross <= crossC ? crossC : crossC + 1) : (cross >= crossC ? crossC : crossC - 1)) : crossC;
        const step = Math.min(budget, Math.abs(target - cross));
        const moveDir = target > cross ? 1 : -1;
        if (horiz) p.fy += moveDir * step; else p.fx += moveDir * step;
        if (Math.abs(target - (horiz ? p.fy : p.fx)) < EPS) { if (horiz) p.fy = target; else p.fx = target; }
        remDt -= step / speed; moved += step; p.lastDir = ad; if (!forced) faced = p.beltAlign ? d : ad;
        const ncx1 = p.cx, ncy1 = p.cy;
        if (ncx1 !== curCx || ncy1 !== curCy) {
          const ed = ncx1 > curCx ? 0 : ncy1 > curCy ? 1 : ncx1 < curCx ? 2 : 3;
          const df = this.feat[idx(curCx, curCy)];
          if (!predict && df?.k === 'door' && (ed % 2 === 1) === df.ns) {
            this.flipDoor(idx(curCx, curCy), ed <= 1 ? 4 : 0, true);
          }
          curCx = ncx1; curCy = ncy1;
        }
        continue;
      }
      if (cross !== crossC) { if (horiz) p.fy = crossC; else p.fx = crossC; }
      const [dx, dy] = DIRS[d], sgn = dx + dy;
      const pos = horiz ? p.fx : p.fy, center = Math.floor(pos) + 0.5;
      const beforeCenter = sgn > 0 ? pos < center - EPS : pos > center + EPS;
      const hf = this.feat[idx(p.cx, p.cy)];
      if (hf?.k === 'oneway' && hf.d !== d) break;
      let target;
      const nbIdx = inside(p.cx + dx, p.cy + dy) ? idx(p.cx + dx, p.cy + dy) : -1;
      const hasBarrier = nbIdx >= 0 && this.barriers.has(nbIdx);
      if (beforeCenter) target = center;
      else if (this.canStep(p, p.cx, p.cy, d)) target = center + sgn;
      else if (this.canTouch(p, p.cx, p.cy, d)) {
        const there = this.feat[nbIdx];
        target = center + sgn * (hasBarrier || there?.k === 'door' ? 0.48 : 0.56);
        if (hasBarrier && Math.abs(target - pos) <= EPS) {
          if (!predict && (p.barrierSoundT || 0) <= 0) {
            p.barrierSoundT = 0.055;
            this.emit({ t: 'barrierTouch', p: p.slot, x: p.x + dx * 0.3, y: p.y + dy * 0.3 });
          }
          break;
        }
      }
      else { if (!predict && hasBarrier && (p.barrierSoundT || 0) <= 0) { p.barrierSoundT = 0.055; this.emit({ t: 'barrierTouch', p: p.slot, x: p.x + dx * 0.3, y: p.y + dy * 0.3 }); } break; }
      const step = Math.min(budget, Math.abs(target - pos)), dirSign = target > pos ? 1 : -1;
      if (horiz) p.fx += dirSign * step; else p.fy += dirSign * step;
      if (Math.abs(target - (horiz ? p.fx : p.fy)) < EPS) { if (horiz) p.fx = target; else p.fy = target; }
      remDt -= step / speed; moved += step; p.lastDir = d; if (!forced) faced = d;
      const ncx2 = p.cx, ncy2 = p.cy;
      if (ncx2 !== curCx || ncy2 !== curCy) {
        const ed = ncx2 > curCx ? 0 : ncy2 > curCy ? 1 : ncx2 < curCx ? 2 : 3;
        const df = this.feat[idx(curCx, curCy)];
        if (!predict && df?.k === 'door' && (ed % 2 === 1) === df.ns) {
          this.flipDoor(idx(curCx, curCy), ed <= 1 ? 4 : 0, true);
        }
        curCx = ncx2; curCy = ncy2;
      }
      if (step <= 1e-9) break;
    }
    if (!anyForced) p.dir = faced >= 0 ? faced : (p.input.dir >= 0 ? p.input.dir : p.dir);
    if (p.push) { p.push.left = (p.push.left ?? p.push.n) - moved; if (p.push.left <= 0 || moved < 1e-6) p.push = null; }
    p.moving = moved > 1e-6;
    if (!predict && moved > 1e-6) {
      const curFeat = this.feat[idx(p.cx, p.cy)];
      if (curFeat?.k === 'door') {
        curFeat.state = doorStateAt(curFeat, p.fx, p.fy);
        doorSync(curFeat);
      }
    }
  }

  /** can the wizard make progress in direction d right now (lining up counts as progress)? */
  canGo(p, d) {
    const [dx, dy] = DIRS[d], nx = p.cx + dx, ny = p.cy + dy;
    const hf = this.feat[idx(p.cx, p.cy)];
    if (hf?.k === 'oneway' && hf.d !== d) return false;
    if (hf?.k === 'door' && (d % 2 === 1) !== hf.ns) return false;
    const horiz = d % 2 === 0, cross = horiz ? p.fy : p.fx, crossC = Math.floor(cross) + 0.5;
    if (Math.abs(cross - crossC) > 1e-6) {
      return this.canStep(p, p.cx, p.cy, d);
    }
    const sgn = dx + dy, pos = horiz ? p.fx : p.fy, center = Math.floor(pos) + 0.5;
    if (sgn > 0 ? pos < center - 1e-6 : pos > center + 1e-6) return true;
    return this.canStep(p, p.cx, p.cy, d) || this.canTouch(p, p.cx, p.cy, d);
  }

  updateMonster(m, dt) {
    m.stun = Math.max(0, m.stun - dt); m.zapped = Math.max(0, m.zapped - dt); m.flash = Math.max(0, m.flash - dt);
    m.barrierSoundT = Math.max(0, (m.barrierSoundT || 0) - dt);
    if (m.tpPhase) { this.stepTeleportPhase(m, dt); m.moving = false; return; }
    this.stepMover(m, dt, () => decide(this, m));
    this.checkMonsterEat(m);
  }

  // ---------------------------------------------------------------- bombs & blasts
  /** kind: 'fire' (normal), 'electric' or 'magic' (dropped by the stone thunder / warp jars) */
  placeBomb(p, kind = 'fire') {
    const x = p.cx, y = p.cy;
    const mine = this.bombs.filter(b => b.owner === p.slot).length;
    if (mine >= p.bombsMax || this.anyBombAt(x, y) || this.solid(x, y) || this.flames.has(idx(x, y))) return false;
    const f = this.feat[idx(x, y)];
    const onVent = f?.k === 'vent';
    // fuse from FRACAS.EXE: 130 ticks; 70 for a warp cauldron; 3600 (waits for the ignitor) while the ignitor is held
    const fuseScale = this.mutators?.fuseScale || 1;
    const fuse = kind === 'magic' ? (70 / TICK_HZ) * fuseScale : p.power === 'ignitor' && kind === 'fire' ? 3600 / TICK_HZ : FUSE * fuseScale;
    const range = onVent ? 1 : p.range;
    const b = { id: this.allocId(), x, y, cx: x, cy: y, owner: p.slot, range, fuse, age: 0, kind,
                vent: onVent ? (f.g ?? 0) : -1, slide: null, sx: x, sy: y, sp: 0, rx: x, ry: y, prx: x, pry: y };
    this.bombs.push(b);
    this.emit({ t: 'bomb', x, y, p: p.slot, id: b.id, vent: onVent, kind });
    return true;
  }

  updateBombs(dt) {
    if (!this.bombs.length) return;
    const snap = this._tmpBombs || (this._tmpBombs = []);
    snap.length = 0;
    for (let bi = 0; bi < this.bombs.length; bi++) snap.push(this.bombs[bi]);
    for (let bi = 0; bi < snap.length; bi++) {
      const b = snap[bi];
      if (!this.bombs.includes(b)) continue;
      b.age += dt; b.fuse -= dt;
      // conveyor or wind push (FRACAS.EXE 0xf139..0xf336): bombs slide at 1 px/tick onto adjacent walkway/wind cells
      const f = this.feat[idx(b.x, b.y)], wDir = this.windDirAt(b.x, b.y);
      const beltDir = f?.k === 'walk' ? f.d : wDir;
      if (b.slide?.wind && beltDir < 0) { b.slide = null; b.sp = 0; b.cx = b.x; b.cy = b.y; }
      if (!b.slide && beltDir >= 0) b.slide = { d: beltDir, n: 1, speed: WALKWAY_SPEED, wind: wDir >= 0 };
      let added = false;
      for (let g = 0; g < 4 && b.slide; g++) {
        const [dx, dy] = DIRS[b.slide.d], nx = b.x + dx, ny = b.y + dy;
        const nextFeat = inside(nx, ny) ? this.feat[idx(nx, ny)] : null;
        const nextHasBelt = nextFeat?.k === 'walk' || this.windDirAt(nx, ny) >= 0;
        const doorBlocks = nextFeat?.k === 'door';
        const blocked = this.solid(nx, ny) || !nextHasBelt || (this.anyBombAt(nx, ny) && this.anyBombAt(nx, ny) !== b) ||
          this.flames.has(idx(nx, ny)) || doorBlocks;
        if (blocked) { b.slide = null; b.sp = 0; b.cx = b.x; b.cy = b.y; break; }
        if (!added) { b.sp += dt * b.slide.speed; added = true; }
        // FRACAS.EXE 0xf139..0xf336: keep bomb cell occupancy on (b.x, b.y) until slide finishes full tile (sp >= 1)
        b.cx = b.x; b.cy = b.y;
        if (b.sp < 1) break;
        const carry = b.sp - 1;
        b.x = nx; b.y = ny; b.cx = nx; b.cy = ny; b.slide.n--;
        const gf = this.feat[idx(b.x, b.y)], nw = this.windDirAt(b.x, b.y);
        const nextDir = gf?.k === 'walk' ? gf.d : nw;
        b.vent = gf?.k === 'vent' ? (gf.g ?? 0) : -1;
        if (b.vent >= 0) b.range = 1;
        if (b.slide.n <= 0) b.slide = nextDir >= 0 ? { d: nextDir, n: 1, speed: WALKWAY_SPEED, wind: nw >= 0 } : null;
        b.sp = b.slide ? carry : 0;
      }
      const [sdx, sdy] = b.slide ? DIRS[b.slide.d] : [0, 0];
      b.rx = b.x + sdx * b.sp; b.ry = b.y + sdy * b.sp;
      if (b.fuse <= 0) this.explode(b);
    }
  }

  blastLine(x, y, range, cells, chain, kind = 'fire') {
    cells.add(idx(x, y));
    const origF = this.feat[idx(x, y)];
    if (origF?.k === 'door' && !chain.doors.has(idx(x, y))) chain.doors.set(idx(x, y), undefined);
    for (let d = 0; d < 4; d++) {
      for (let r = 1; r <= range; r++) {
        const nx = x + DIRS[d][0] * r, ny = y + DIRS[d][1] * r;
        if (!inside(nx, ny)) break;
        const i = idx(nx, ny);
        if (this.terrain[i] === T.WALL || this.barriers.has(i)) break;
        if (this.terrain[i] === T.ROCK) { if (kind === 'fire') { chain.rocks.add(i); cells.add(i); } break; }
        const f = this.feat[i];
        if (f?.k === 'oneway' && f.d !== d) break;
        if (f?.k === 'door') {
          if ((d % 2 === 1) === f.ns) chain.doors.set(i, d <= 1 ? 4 : 0);
          cells.add(i); break;
        }
        const ef = this.flames.get(i);
        if (ef && (ef.kind || 'fire') !== kind) break;
        cells.add(i);
        const ob = this.bombs.find(o => o.cx === nx && o.cy === ny);
        if (ob) {
          chain.bombs.add(ob); break;
        }
      }
    }
  }

  explode(b) {
    const chain = { rocks: new Set(), doors: new Map(), bombs: new Set() };
    const byKind = { fire: new Set(), electric: new Set(), magic: new Set() };
    const queue = [b], done = new Set();
    while (queue.length) {                               // whole chain reaction resolves in one frame
      const c = queue.pop();
      if (done.has(c)) continue;
      done.add(c);
      this.bombs.splice(this.bombs.indexOf(c), 1);
      const kind = c.kind || 'fire';
      // electric discharges run until they hit a wall; warp waves use the normal blast range
      const owner = this.players.find(q => q.slot === c.owner); if (owner) owner.score += 4;
      this.blastLine(c.cx, c.cy, kind === 'electric' ? 99 : (c.vent >= 0 && kind === 'fire' ? 1 : c.range), byKind[kind], chain, kind);
      if (c.vent >= 0 && kind === 'fire') {
        for (const [vx, vy] of this.vents) this.blastLine(vx, vy, 1, byKind.fire, chain);
        this.emit({ t: 'vents', x: c.cx, y: c.cy, g: c.vent });
      }
      for (const ob of chain.bombs) if (!done.has(ob)) queue.push(ob);
      this.emit({ t: 'boom', x: c.cx, y: c.cy, owner: c.owner, range: c.range, kind });
    }
    const hit = new Set();                               // each wizard / monster is zapped or warped once per blast
    const initiator = this.players.find(q => q.slot === b.owner);
    for (const [kind, cells] of Object.entries(byKind)) for (const i of cells) {
      const it = this.items.get(i);
      if (it && it.age > 0) {
        this.items.delete(i);
        if (initiator) initiator.score += 7;
        this.emit({ t: 'burn', x: i % W, y: (i / W) | 0 });
      }
      const dur = BLAST_TIMES[kind] || BLAST_TIME;
      this.flames.set(i, { t: dur, maxT: dur, owner: b.owner, kind, hit });
    }
    for (const i of chain.rocks) this.breakRock(i, b.owner);
    for (const [i, st] of chain.doors) this.flipDoor(i, st);
    for (const [kind, cells] of Object.entries(byKind)) if (cells.size)
      this.emit({ t: 'blast', cells: [...cells], owner: b.owner, x: b.cx, y: b.cy, kind });
  }

  breakRock(i, by) {
    if (this.terrain[i] !== T.ROCK) return;
    this.terrain[i] = T.FLOOR;
    if (by !== undefined) { const k = this.players.find(q => q.slot === by); if (k) { k.score += 7; k.rocksBroken = (k.rocksBroken || 0) + 1; } }
    const x = i % W, y = (i / W) | 0;
    this.emit({ t: 'rock', x, y });
    const name = this.hidden.get(i);
    if (name) { this.hidden.delete(i); this.items.set(i, { name, age: 0 }); this.emit({ t: 'reveal', x, y, name }); }
  }

  flipDoor(i, forceState, byPlayer = false) {
    const f = this.feat[i];
    if (!f || f.k !== 'door') return;
    const prevState = f.state, prevFlipped = f.flipped;
    if (forceState !== undefined) {
      f.state = forceState;
    } else {
      f.state = f.flipped ? 0 : 4;
    }
    doorSync(f);
    if (byPlayer || f.state !== prevState || f.flipped !== prevFlipped) {
      this.emit({ t: 'door', x: i % W, y: (i / W) | 0, o: f.o, flipped: f.flipped, state: f.state, byPlayer });
    }
  }


  updateFlames(dt) {
    if (!this.flames.size) return;
    for (const [i, f] of this.flames) { f.t -= dt; if (f.t <= 1e-9) this.flames.delete(i); }
    if (!this.flames.size) return;
    const checkList = (arr, isPlayer) => {
      for (let ei = 0; ei < arr.length; ei++) {
        const e = arr[ei];
        if (!e.alive) continue;
        if (isPlayer ? e.tpPhase : e.tpPhase === 'hide') continue;
        const f = this.flames.get(idx(e.cx, e.cy)); if (!f) continue;
        if (f.kind === 'fire') { if (isPlayer) this.hurtPlayer(e, 'blast', f.owner); else this.hurtMonster(e, f.owner); }
        else if (!f.hit.has(e.id)) {
          if (isPlayer && this.mode === 'normal' && this.mutators?.friendlyFire === false && f.owner !== undefined && f.owner !== e.slot) continue;
          f.hit.add(e.id);
          if (f.kind === 'electric') this.electrocute(e);
          else this.teleport(e);
        }
      }
    };
    checkList(this.players, true);
    checkList(this.monsters, false);
  }

  electrocute(e, dur = 195 / TICK_HZ) {
    if (e instanceof Monster && (e.type === 8 || e.tpPhase === 'hide')) return;
    if (e instanceof Player) { if (e.radiation > 0 || e.invuln > 0 || e.tpPhase) return; e.stun = dur; this.emit({ t: 'stun', p: e.slot, x: e.x }); }
    else { e.stun = dur; e.zapped = dur; }
    this.emit({ t: 'zap', id: e.id, x: e.x, y: e.y });
  }

  // ---------------------------------------------------------------- powers & projectiles
  releaseIgnitor(p) { if (p.power === 'ignitor') for (const b of this.bombs) if (b.owner === p.slot) b.fuse = Math.min(b.fuse, 65 / TICK_HZ); }
  applyPickup(p, name) {
    const info = PICKUP_INFO[name];
    if (info.kind !== 'none') p.score += 18;             // every working pickup is worth 18 points
    switch (name) {
      case 'greenGem': p.bombsMax = Math.min(MAX_BOMBS, p.bombsMax + 1); break;
      case 'purpleGem': p.range = Math.min(MAX_RANGE, p.range + 1); break;
      case 'max': p.range = MAX_RANGE; p.bombsMax = MAX_BOMBS; break;
      case 'heart': p.lives++; break;
      case 'radiation': p.radiation = info.ticks / TICK_HZ; break;
      case 'ghost': break;                                // empty bottle does nothing
      default: if (name !== 'ignitor') this.releaseIgnitor(p); if (name !== 'foot') p.sprint = false; p.power = name; p.powerTime = p.powerMax = info.ticks / TICK_HZ;   // jars, ignitor, boots
    }
    this.emit({ t: 'pickup', p: p.slot, name, x: p.cx, y: p.cy, rude: !!this.cheats.rude });
  }

  /** the spell key, per FRACAS.EXE's power table */
  usePower(p, reverse = false) {
    if (!p.power || p.cooldown > 0) return;
    const info = PICKUP_INFO[p.power], cool = 10 / TICK_HZ;
    const rev = reverse || p.input.bombHeld || p.input.bomb;
    const cast = (spell, area) => { p.cast = 0; p.spellsCast = (p.spellsCast || 0) + 1; this.emit({ t: 'cast', p: p.slot, spell, area, x: p.x, y: p.y, dir: p.dir }); };
    switch (p.power) {
      case 'orb': {
        this.stasis = info.dur || 7;
        this.stasisOwner = p.slot;
        p.power = null;
        p.powerTime = 0;
        cast('stasis', true);
        this.emit({ t: 'stasis', p: p.slot, dur: this.stasis, x: p.x, y: p.y });
        return;
      }
      case 'foot': if (!p.sprint) { p.sprint = true; cast('speed', false); } return;
      case 'ignitor': {                                  // set off the cauldron closest to going off
        const mine = this.bombs.filter(b => b.owner === p.slot && b.fuse > 0).sort((a, b) => a.fuse - b.fuse);
        if (mine.length) { mine[0].fuse = 0; p.cooldown = cool; this.emit({ t: 'ignite', p: p.slot }); }
        return;
      }
      case 'stoneElectric': if (this.placeBomb(p, 'electric')) cast('electric', true); return;   // uses a cauldron slot
      case 'stoneTeleport': if (this.placeBomb(p, 'magic')) cast('teleport', true); return;
      case 'stoneFire': {
        const rx = Math.round(p.fx - 0.5), ry = Math.round(p.fy - 0.5);
        const sx = (!this.solid(rx, p.cy) ? rx : p.cx) + 0.5;
        const sy = (!this.solid(p.cx, ry) ? ry : p.cy) + 0.5;
        for (const d of [0, 1, 2, 3]) this.fire(p, d, 'fire', 99, d % 2 === 1 ? sx : p.fx, d % 2 === 0 ? sy : p.fy);
        p.cooldown = 30 / TICK_HZ; cast('fire', true); return;
      }
      case 'stoneWind': if (this.makeWindZone(p, info, [0, 1, 2, 3])) { p.cooldown = cool; cast('windzone', true); } return;
      case 'glassWind': {
        const d = rev ? (p.dir + 2) % 4 : p.dir;
        if (this.makeWindZone(p, info, [d])) { p.cooldown = cool; cast('windzone', false); } return;
      }
      default: {                                         // glass fire / electric / teleport: one bolt (20-tick cooldown at 0x1b317)
        this.fire(p, rev ? (p.dir + 2) % 4 : p.dir, info.spell, 99);
        p.cooldown = 20 / TICK_HZ; cast(info.spell, false);
      }
    }
  }

  /** Inferno jar: a wind zone centred on the wizard, up to `reach` tiles in each direction (stopped by walls,
   *  boulders and doors). For `zone` seconds it blows everything in its arms outward. */
  makeWindZone(p, info, dirs) {
    // FRACAS.EXE 0xe792 / 0xe821: cannot replace an active wind zone until its 254 ticks expire
    if (this.winds.some(w => w.owner === p.slot)) return false;
    const cells = new Map(), x = p.cx, y = p.cy, arms = [0, 0, 0, 0];
    const rStart = dirs.length === 1 ? 0 : 1;
    const rEnd = dirs.length === 1 ? info.reach - 1 : info.reach;
    for (const d of dirs) for (let r = rStart; r <= rEnd; r++) {
      const nx = x + DIRS[d][0] * r, ny = y + DIRS[d][1] * r;
      if (this.solid(nx, ny) || this.feat[idx(nx, ny)]?.k === 'door') break;
      if (r > 0) arms[d]++;                            // 0xe8f2: arm length counts every open cell outward (even belts)
      if (this.feat[idx(nx, ny)]?.k === 'walk' || this.windDirAt(nx, ny) >= 0) continue;
      cells.set(idx(nx, ny), d);
    }
    this.winds.push({ owner: p.slot, x, y, cells, arms, t: info.zone, max: info.zone, id: this.allocId() });
    this.emit({ t: 'windZone', p: p.slot, x, y, all: dirs.length > 1 });
    return true;
  }

  updateWinds(dt) {
    for (const w of this.winds) {
      w.t -= dt;
      for (const b of this.bombs) {
        const d = w.cells.get(idx(b.cx, b.cy));
        if (d !== undefined && !b.slide) b.slide = { d, n: 1, speed: WALKWAY_SPEED, wind: true };
      }
      for (const q of this.projs) {
        const d = w.cells.get(idx(Math.floor(q.x), Math.floor(q.y)));
        if (d !== undefined) {
          // FRACAS.EXE 0xff5e: wind accelerates projectiles linearly (+-0x2400 / 0x30000 per tick = 93/64 * PROJ_SPEED/s), clamped to +-maxSpd
          const maxSpd = q.speed || PROJ_SPEED;
          const accel = maxSpd * (93 / 64) * dt;
          if (q.vx === undefined) { q.vx = DIRS[q.d][0] * maxSpd; q.vy = DIRS[q.d][1] * maxSpd; }
          if (DIRS[d][0] !== 0) q.vx = Math.max(-maxSpd, Math.min(maxSpd, q.vx + DIRS[d][0] * accel));
          if (DIRS[d][1] !== 0) q.vy = Math.max(-maxSpd, Math.min(maxSpd, q.vy + DIRS[d][1] * accel));
          if (Math.abs(q.vx) >= Math.abs(q.vy)) q.d = q.vx >= 0 ? 0 : 2; else q.d = q.vy >= 0 ? 1 : 3;
        }
      }
    }
    const ended = this.winds.filter(w => w.t <= 0);
    if (ended.length) { this.winds = this.winds.filter(w => w.t > 0); for (const w of ended) this.emit({ t: 'windEnd', x: w.x, y: w.y }); }
  }

  fire(p, d, spell, reach, x = p.fx, y = p.fy) {
    if (this.projs.filter(q => q.owner === p.slot).length >= 8) return; // FRACAS.EXE 0x10182: max 8 active bolts per player
    const speed = spell === 'wind' ? 12 : PROJ_SPEED;
    this.projs.push({ id: this.allocId(), x, y, px: x, py: y, d, vx: DIRS[d][0] * speed, vy: DIRS[d][1] * speed, spell, owner: p.slot, life: reach,
                      age: 0, speed });
  }

  updateProjectiles(dt) {
    if (!this.projs.length) return;
    const snap = this._tmpProjs || (this._tmpProjs = []);
    snap.length = 0;
    for (let pi = 0; pi < this.projs.length; pi++) snap.push(this.projs[pi]);
    for (let pi = 0; pi < snap.length; pi++) {
      const pr = snap[pi];
      const prevCx = Math.floor(pr.x), prevCy = Math.floor(pr.y);
      const prevI = inside(prevCx, prevCy) ? idx(prevCx, prevCy) : -1;
      const vx = pr.vx ?? (DIRS[pr.d][0] * pr.speed);
      const vy = pr.vy ?? (DIRS[pr.d][1] * pr.speed);
      const step = Math.hypot(vx, vy) * dt;
      pr.x += vx * dt; pr.y += vy * dt; pr.age += dt; pr.life -= step;
      const cx = Math.floor(pr.x), cy = Math.floor(pr.y), i = idx(cx, cy);
      if (prevI >= 0 && prevI !== i && pr.passingDoor === prevI) {
        this.flipDoor(prevI, pr.d <= 1 ? 4 : 0, true);
        pr.passingDoor = -1;
      }
      let end = pr.life <= 0, hitActor = false;
      if (!inside(cx, cy) || this.terrain[i] === T.WALL || this.barriers.has(i)) end = true;
      else if (this.terrain[i] === T.ROCK || (this.feat[i]?.k === 'oneway' && this.feat[i].d !== pr.d)) end = true;                       // bolts stop at boulders and wrong-way arrows
      else if (this.feat[i]?.k === 'door') {
        const df = this.feat[i];
        if (!pr.flippedDoors) pr.flippedDoors = new Set();
        if (pr.passingDoor === i) {
          if ((pr.d % 2 === 1) !== df.ns) end = true;
          else { df.state = doorStateAt(df, pr.x, pr.y); doorSync(df); }
        } else if (!pr.flippedDoors.has(i)) {
          const open = (pr.d % 2 === 1) === df.ns && !((pr.d <= 1 && df.state === 4) || (pr.d >= 2 && df.state === 0));
          if (open) {
            pr.flippedDoors.add(i);
            pr.passingDoor = i;
            df.state = doorStateAt(df, pr.x, pr.y);
            doorSync(df);
          } else end = true;
        }
      }
      if (!end && inside(cx, cy)) {
        const b = this.bombs.find(o => o.cx === cx && o.cy === cy);
        if (b) {
          if (pr.spell === 'wind') b.slide = { d: pr.d, n: Math.max(1, Math.round(pr.life)), speed: 8 };
          else if (pr.spell === 'teleport') { this.teleportBomb(b); end = true; }
        }
        if (pr.spell === 'wind') for (const q of this.projs)                 // gusts blow other spells along
          if (q !== pr && q.spell !== 'wind' && Math.floor(q.x) === cx && Math.floor(q.y) === cy) {
            q.d = pr.d;
            const qs = q.speed || PROJ_SPEED;
            q.vx = DIRS[pr.d][0] * qs; q.vy = DIRS[pr.d][1] * qs;
          }
        const hitActors = (arr, isPlayer) => {
          for (let ei = 0; ei < arr.length; ei++) {
            const e = arr[ei];
            if (!e.alive || end) continue;
            if (isPlayer) {
              if (e.tpPhase) continue;
              if (e.slot === pr.owner && pr.age < 20 / TICK_HZ) continue; // FRACAS.EXE 0x1019e -> 0xfcc0: 20-tick owner immunity
            } else if (e.tpPhase === 'hide') continue;
            if (Math.abs(e.x - pr.x) < 0.55 && Math.abs(e.y - pr.y) < 0.55) {
              if (pr.spell === 'wind') {
                if (!e.push) {
                  if (!isPlayer && e.moving) e.place(e.cx, e.cy);      // caught mid-step: the gust takes him from here
                  e.push = { d: pr.d, n: Math.max(1, Math.round(pr.life)), speed: 8 };
                }
              }
              else { this.spellHit(e, pr); hitActor = true; end = true; }
            }
          }
        };
        hitActors(this.players, true);
        hitActors(this.monsters, false);
      }
      if (end) {
        if (pr.passingDoor >= 0) {
          this.flipDoor(pr.passingDoor, pr.d <= 1 ? 4 : 0, true);
          pr.passingDoor = -1;
        }
        this.projs.splice(this.projs.indexOf(pr), 1); this.emit({ t: 'projEnd', id: pr.id, spell: pr.spell, x: pr.x, y: pr.y, hitActor });
      }
    }
  }

  spellHit(e, pr) {
    if (e instanceof Player && this.mode === 'normal' && this.mutators?.friendlyFire === false && pr.owner !== undefined && pr.owner !== e.slot) return;
    if (pr.spell === 'fire') {
      if (e instanceof Player) this.hurtPlayer(e, 'fire', pr.owner); else this.hurtMonster(e, pr.owner);
    } else if (pr.spell === 'electric') this.electrocute(e);
    else if (pr.spell === 'teleport') this.teleport(e);
  }

  freeCells(excludeCell) {
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (this.solid(x, y) || this.anyBombAt(x, y) || this.feat[idx(x, y)] || this.barriers.has(idx(x, y))) continue;
      if (excludeCell && x === excludeCell[0] && y === excludeCell[1]) continue;
      out.push([x, y]);
    }
    return out;
  }

  teleport(e) {
    if (!e.alive || e.tpPhase === 'hide') return;
    if (this.freeCells([e.cx, e.cy]).length === 0) return;
    const dur = (100 - this.rng.int(16)) / TICK_HZ;
    e.tpPhase = 'hide'; e.tpTimer = dur; e.tpDur = dur;
    e.moving = false; e.push = null; e.stepForced = false; e.stepBelt = -1;
    e.stun = 0; if (e instanceof Monster) { e.zapped = 0; e.tpGrace.clear(); }
    this.emit({ t: 'teleport', id: e.id, phase: 'hide', x0: e.x, y0: e.y, x1: e.x, y1: e.y });
  }

  /** FRACAS.EXE 0x0b931: state 3 (hide) vanishes in place -> warps to random free cell -> state 4 (reveal). */
  stepTeleportPhase(e, dt) {
    e.tpTimer -= dt;
    if (e.tpTimer > 0) return;
    if (e.tpPhase === 'hide') {
      const from = [e.x, e.y];
      const c = this.rng.pick(this.freeCells([e.cx, e.cy]));
      if (c) {
        e.place(c[0], c[1]);
        if (e instanceof Player) { e.fx = e.x; e.fy = e.y; e.lastDir = -1; }
        e.px = e.x; e.py = e.y;
      }
      const dur = (100 - this.rng.int(8)) / TICK_HZ;
      e.tpPhase = 'reveal'; e.tpTimer = dur; e.tpDur = dur;
      if (e instanceof Monster) {
        e.tpGrace.clear();
        for (const p of this.players) {
          if (p.alive && Math.abs(e.x - p.x) < 0.62 && Math.abs(e.y - p.y) < 0.62) e.tpGrace.add(p.slot);
        }
      }
      this.emit({ t: 'teleport', id: e.id, phase: 'reveal', x0: from[0], y0: from[1], x1: e.x, y1: e.y });
      return;
    }
    e.tpPhase = null; e.tpTimer = 0; e.tpDur = 0;
    if (e instanceof Monster) {
      for (const p of this.players) {
        if (p.alive && Math.abs(e.x - p.x) < 0.62 && Math.abs(e.y - p.y) < 0.62) e.tpGrace.add(p.slot);
      }
    } else if (e instanceof Player) {
      for (const m of this.monsters) {
        if (m.alive && Math.abs(m.x - e.x) < 0.62 && Math.abs(m.y - e.y) < 0.62) m.tpGrace.add(e.slot);
      }
    }
  }

  teleportBomb(b) {
    const c = this.rng.pick(this.freeCells([b.cx, b.cy]));
    if (!c) return;
    this.emit({ t: 'teleport', id: b.id, x0: b.cx + 0.5, y0: b.cy + 0.5, x1: c[0] + 0.5, y1: c[1] + 0.5 });
    b.x = b.cx = b.rx = b.prx = c[0]; b.y = b.cy = b.ry = b.pry = c[1]; b.sp = 0;
    const g = this.feat[idx(b.x, b.y)], wDir = this.windDirAt(b.x, b.y);
    b.vent = g?.k === 'vent' ? (g.g ?? 0) : -1;
    if (b.vent >= 0) b.range = 1;
    const beltDir = g?.k === 'walk' ? g.d : wDir;
    b.slide = beltDir >= 0 ? { d: beltDir, n: 1, speed: WALKWAY_SPEED, wind: wDir >= 0 } : null;
  }

  // ---------------------------------------------------------------- damage
  hurtPlayer(p, cause, by) {
    if (!p.alive || p.invuln > 0 || p.radiation > 0 || p.tpPhase || this.cheats.god) return;
    if (this.mode === 'normal' && this.mutators?.friendlyFire === false && by !== undefined && by !== p.slot) return;
    if (p.shields > 0) { p.shields--; p.invuln = 1.5; this.emit({ t: 'shield', p: p.slot }); return; }
    p.alive = false; p.moving = false; p.push = null; p.sprint = false; p.respawn = 140 / TICK_HZ; p.hit = 1;
    p.tpPhase = null; p.tpTimer = 0; p.tpDur = 0;
    p.deathCell = [p.cx, p.cy];                       // he comes back where he fell (after 140 ticks: 0x8c)
    this.releaseIgnitor(p);
    if (this.mode === 'normal') { p.lives--; if (p.lives <= 0) p.out = true; }
    else p.out = true;
    if (by !== undefined && by !== p.slot) { const k = this.players.find(q => q.slot === by); if (k) { k.kills++; k.score += 25; } }
    else if (by === p.slot) { p.selfKills = (p.selfKills || 0) + 1; }
    this.emit({ t: 'die', p: p.slot, x: p.x, y: p.y, cause, by: by ?? -1 });
  }

  hurtMonster(m, by) {
    if (!m.alive || m.flash > 0 || m.tpPhase === 'hide') return;
    m.hp--; m.flash = 0.9;
    if (m.hp > 0) { this.emit({ t: 'bossHit', id: m.id, hp: m.hp, x: m.x, y: m.y }); return; }
    m.alive = false; m.tpPhase = null; m.tpTimer = 0; m.tpDur = 0;
    const killer = this.players.find(q => q.slot === by);
    if (killer) { killer.score += 50; killer.kills++; }
    this.emit({ t: 'mdie', id: m.id, x: m.x, y: m.y, type: m.type, boss: m.boss });

  }

  checkContacts() {
    for (const m of this.monsters) {
      if (!m.alive) continue;
      for (const p of this.players) {
        if (!p.alive) { m.tpGrace.delete(p.slot); continue; }
        const touch = Math.abs(m.x - p.x) < 0.62 && Math.abs(m.y - p.y) < 0.62;   // the bodies visibly touch
        if (!touch) { m.tpGrace.delete(p.slot); continue; }
        if (p.tpPhase) { m.tpGrace.add(p.slot); continue; }
        if (this.blockedBetween(p.cx, p.cy, m.cx, m.cy)) continue;
        if (m.tpPhase === 'hide') { this.teleport(p); continue; }
        // Emerging (reveal) worms don't kill players on overlap; grant grace until separation
        if (m.tpPhase === 'reveal') { m.tpGrace.add(p.slot); continue; }
        if (m.tpGrace.has(p.slot)) continue;
        if (m.zapped > 0) { p.fx = p.px; p.fy = p.py; this.electrocute(p, Math.max(1 / TICK_HZ, m.stun - 10 / TICK_HZ)); }
        else if (m.stun <= 0 && this.stasis <= 0) this.hurtPlayer(p, 'monster');
      }
    }
  }

  // ---------------------------------------------------------------- hazards
  updateSpikes() {
    const st = this.time - (this.stasisPaused || 0) - (this._freezeTime || 0);
    for (let i = 0; i < W * H; i++) {
      const f = this.feat[i];
      if (f?.k !== 'spike') continue;
      // FRACAS.EXE 0xed0c..0xed65 & 0xbcef: delay byte decrements by 1 each tick to -1, then 55 active + 51 retracted = 106t; lethal steps 6..12 (15..36t)
      const s = computeSpikeState(st, f.delay);
      if (s.out && !f.out) this.emit({ t: 'spike', x: i % W, y: (i / W) | 0 });
      f.out = s.out; f.ph = s.ph; f.active = s.active;
    }
  }

  updateBarriers(dt) {
    if (this.stasis > 0) return;
    for (const [i, t] of this.barriers) { if (t - dt <= 0) this.barriers.delete(i); else this.barriers.set(i, t - dt); }
    let want = this.level.barriers || 0;
    if (this.mode === 'battle' && this.mutators?.suddenDeath === 'fast') {
      want = Math.max(want * 2, want + (this.roundTime > 15 ? 8 : 4));
    }
    if (want <= 0) return;
    const thresh = Math.min(120, want * 8);
    if (this.rng.next() < (dt * TICK_HZ) * ((thresh + 1) / 128)) {
      // a short electric fence across a straight corridor (0xec1d..0xeccc)
      for (let tries = 0; tries < 1; tries++) {
        const x = 1 + this.rng.int(W - 2), y = 1 + this.rng.int(H - 2), i = idx(x, y);
        if (this.solid(x, y) || this.feat[i] || this.barriers.has(i) || this.anyBombAt(x, y)) continue;
        if (this.portal && this.portal.x === x && this.portal.y === y) continue;
        if (this.players.some(p => p.alive && p.cx === x && p.cy === y)) continue;
        if (this.monsters.some(m => m.alive && ((m.cx === x && m.cy === y) || (m.tx === x && m.ty === y) || (m.moving && m.nx === x && m.ny === y)))) continue;
        const coin = this.rng.int(2), ew = coin === 0 && this.terrain[idx(x, y - 1)] === T.WALL && this.terrain[idx(x, y + 1)] === T.WALL, ns = coin === 1 && this.terrain[idx(x - 1, y)] === T.WALL && this.terrain[idx(x + 1, y)] === T.WALL;
        if (!ew && !ns) continue;
        this.barriers.set(i, 96 / TICK_HZ); this.emit({ t: 'barrier', x, y, ns, horiz: ns }); break;
      }
    }
  }

  updateItems(dt) { for (const it of this.items.values()) it.age += dt; }

  updateScent(dt) { const step = dt * (TICK_HZ / 253); for (let i = 0; i < this.scent.length; i++) if (this.scent[i] > 0) this.scent[i] = Math.max(0, this.scent[i] - step); }

  // ---------------------------------------------------------------- level flow
  checkEnd() {
    if (this.demo) return;                               // title-screen attract mode
    const alive = this.players.filter(p => !p.out || p.exited);
    if (this.mode === 'battle') {
      const standing = this.players.filter(p => p.alive);
      if (standing.length <= 1 && this.players.length > 1) {
        this.state = 'roundOver'; this.stateTime = 0;
        const w = standing[0];
        if (w) w.wins++;
        this.emit({ t: 'roundOver', winner: w ? w.slot : -1 });
      }
      return;
    }
    if (!alive.length) { this.state = 'lost'; this.stateTime = 0; this.emit({ t: 'gameOver' }); return; }
    if (this.state === 'play' && this.monsters.every(m => !m.alive)) {
      this.state = 'clear';
      const spot = this.portalSpot();
      this.portal = { x: spot[0], y: spot[1] };
      this.emit({ t: 'portal', x: spot[0], y: spot[1] });
    }
    if (this.state === 'clear' && this.portal) {
      for (const p of this.players) if (p.alive && p.cx === this.portal.x && p.cy === this.portal.y) {
        this.releaseIgnitor(p); p.alive = false; p.out = true; p.exited = true; p.moving = false;
        this.emit({ t: 'portalEnter', p: p.slot, x: p.x, y: p.y });
      }
      if (this.state === 'clear' && !this.players.some(q => !q.out)) {
        this.state = 'won'; this.stateTime = 0;
        this.emit({ t: 'levelWon', p: 0 });
      }
    }
  }

  portalSpot() {
    const spots = [], fallback = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y);
      if (this.solid(x, y) || this.feat[i] || this.anyBombAt(x, y)) continue;
      if (this.barriers.has(i) || this.items.has(i)) { fallback.push([x, y]); continue; }
      spots.push([x, y]);
    }
    return this.rng.pick(spots) || this.rng.pick(fallback) || [10, 7];
  }

  /** Capture a full deterministic snapshot of simulation state for instant Rollback restoration. */
  saveState(reuse = null) {
    const doors = [];
    const spikes = [];
    for (let i = 0; i < this.feat.length; i++) {
      const f = this.feat[i];
      if (!f) continue;
      if (f.k === 'door') doors.push([i, f.state, f.flipped, f.o, f.allow]);
      else if (f.k === 'spike') spikes.push([i, f.out, f.ph, f.active]);
    }
    const items = [];
    for (const [i, it] of this.items) items.push([i, it.name, it.age]);
    const hitIdxs = new Map();
    const hitSets = [];
    const flames = [];
    for (const [i, f] of this.flames) {
      let hi = -1;
      if (f.hit) {
        hi = hitIdxs.get(f.hit);
        if (hi === undefined) { hi = hitSets.length; hitIdxs.set(f.hit, hi); hitSets.push([...f.hit]); }
      }
      flames.push([i, f.t, f.maxT, f.owner, f.kind, hi]);
    }
    const terrainBuf = reuse?.terrain?.length === this.terrain.length ? reuse.terrain : new Uint8Array(this.terrain.length);
    terrainBuf.set(this.terrain);
    const scentBuf = reuse?.scent?.length === this.scent.length ? reuse.scent : new Float32Array(this.scent.length);
    scentBuf.set(this.scent);
    const out = reuse || {};
    out.rngS = this.rng.s; out.nextId = this.nextId;
    out.time = this.time; out.state = this.state; out.stateTime = this.stateTime;
    out.roundTime = this.roundTime; out.danger = this.danger ? { ...this.danger } : null; out.dangerTick = this.dangerTick;
    out.freeze = this.freeze; out.stasis = this.stasis; out.stasisOwner = this.stasisOwner;
    out.stasisPaused = this.stasisPaused; out._freezeTime = this._freezeTime;
    out.portal = this.portal ? { x: this.portal.x, y: this.portal.y } : null;
    out.terrain = terrainBuf;
    out.scent = scentBuf;
    out.doors = doors; out.spikes = spikes;
    out.hidden = new Map(this.hidden);
    out.items = items;
    out.barriers = new Map(this.barriers);
    out.bombs = this.bombs.map(b => ({ ...b, slide: b.slide ? { ...b.slide } : null }));
    out.hitSets = hitSets; out.flames = flames;
    out.projs = this.projs.map(pr => ({ ...pr, flippedDoors: pr.flippedDoors ? new Set(pr.flippedDoors) : null }));
    out.winds = this.winds.map(w => ({ ...w, cells: new Map(w.cells), arms: [...w.arms] }));
    out.players = this.players.map(p => ({
      tx: p.tx, ty: p.ty, nx: p.nx, ny: p.ny, p: p.p, dir: p.dir, moving: p.moving,
      stepSpeed: p.stepSpeed, stepDir: p.stepDir, stepForced: p.stepForced, stepBelt: p.stepBelt,
      stun: p.stun, id: p.id, px: p.px, py: p.py, fx: p.fx, fy: p.fy, lastDir: p.lastDir,
      push: p.push ? { ...p.push } : null,
      beltAlign: p.beltAlign ? { ...p.beltAlign } : null,
      lives: p.lives, score: p.score, bombsMax: p.bombsMax, range: p.range, shields: p.shields,
      power: p.power, powerTime: p.powerTime, cooldown: p.cooldown, slotLock: p.slotLock,
      radiation: p.radiation, ghost: p.ghost, invuln: p.invuln, sprint: p.sprint, powerMax: p.powerMax,
      tpPhase: p.tpPhase, tpTimer: p.tpTimer, tpDur: p.tpDur,
      out: p.out, alive: p.alive, respawn: p.respawn, exited: !!p.exited,
      cast: p.cast, hit: p.hit, kills: p.kills, wins: p.wins, barrierSoundT: p.barrierSoundT || 0,
      selfKills: p.selfKills || 0, spellsCast: p.spellsCast || 0, rocksBroken: p.rocksBroken || 0,
      botTimer: p.botTimer || 0, botDir: p.botDir ?? -1, botGoal: p.botGoal ?? -1,
      deathCell: p.deathCell ? [p.deathCell[0], p.deathCell[1]] : null,
      input: { ...p.input },
    }));
    out.monsters = this.monsters.map(m => ({
      tx: m.tx, ty: m.ty, nx: m.nx, ny: m.ny, p: m.p, dir: m.dir, moving: m.moving,
      stepSpeed: m.stepSpeed, stepDir: m.stepDir, stepForced: m.stepForced, stepBelt: m.stepBelt,
      stun: m.stun, id: m.id, px: m.px, py: m.py, speed: m.speed,
      push: m.push ? { ...m.push } : null,
      hp: m.hp, maxHp: m.maxHp, boss: m.boss, smart: m.smart, alive: m.alive,
      flash: m.flash, zapped: m.zapped, tpPhase: m.tpPhase, tpTimer: m.tpTimer, tpDur: m.tpDur,
      tpGrace: new Set(m.tpGrace), walkLeft: m.walkLeft, aiState: m.aiState,
      bfsGrid: m.bfsGrid,
      huntTarget: m.huntTarget ? [m.huntTarget[0], m.huntTarget[1]] : null,
      touching: m.touching, touchWait: m.touchWait, retreatingTouch: m.retreatingTouch,
      lastTouchDir: m.lastTouchDir, barrierSoundT: m.barrierSoundT || 0,
    }));
    return out;
  }

  /** Restore simulation state from a snapshot captured by saveState(). */
  loadState(st) {
    this.rng.s = st.rngS; this.nextId = st.nextId;
    this.time = st.time; this.state = st.state; this.stateTime = st.stateTime;
    this.roundTime = st.roundTime; this.danger = st.danger ? { ...st.danger } : null; this.dangerTick = st.dangerTick;
    this.freeze = st.freeze; this.stasis = st.stasis; this.stasisOwner = st.stasisOwner;
    this.stasisPaused = st.stasisPaused; this._freezeTime = st._freezeTime;
    this.portal = st.portal ? { x: st.portal.x, y: st.portal.y } : null;
    this.events.length = 0;
    this.terrain.set(st.terrain);
    this.scent.set(st.scent);
    for (const [i, state, flipped, o, allow] of st.doors) {
      const f = this.feat[i];
      if (f) { f.state = state; f.flipped = flipped; f.o = o; f.allow = allow; }
    }
    for (const [i, out, ph, active] of st.spikes) {
      const f = this.feat[i];
      if (f) { f.out = out; f.ph = ph; f.active = active; }
    }
    this.hidden.clear();
    for (const [k, v] of st.hidden) this.hidden.set(k, v);
    this.items.clear();
    for (const [i, name, age] of st.items) this.items.set(i, { name, age });
    this.barriers.clear();
    for (const [k, v] of st.barriers) this.barriers.set(k, v);
    this.bombs = st.bombs.map(b => ({ ...b, slide: b.slide ? { ...b.slide } : null }));
    const sets = st.hitSets.map(arr => new Set(arr));
    this.flames.clear();
    for (const [i, t, maxT, owner, kind, hi] of st.flames) {
      this.flames.set(i, { t, maxT, owner, kind, hit: hi >= 0 ? sets[hi] : new Set() });
    }
    this.projs = st.projs.map(pr => ({ ...pr, flippedDoors: pr.flippedDoors ? new Set(pr.flippedDoors) : null }));
    this.winds = st.winds.map(w => ({ ...w, cells: new Map(w.cells), arms: [...w.arms] }));
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i], s = st.players[i];
      if (!s) continue;
      p.tx = s.tx; p.ty = s.ty; p.nx = s.nx; p.ny = s.ny; p.p = s.p; p.dir = s.dir; p.moving = s.moving;
      p.stepSpeed = s.stepSpeed; p.stepDir = s.stepDir; p.stepForced = s.stepForced; p.stepBelt = s.stepBelt;
      p.stun = s.stun; p.id = s.id; p.px = s.px; p.py = s.py; p.fx = s.fx; p.fy = s.fy; p.lastDir = s.lastDir;
      p.push = s.push ? { ...s.push } : null;
      p.beltAlign = s.beltAlign ? { ...s.beltAlign } : null;
      p.lives = s.lives; p.score = s.score; p.bombsMax = s.bombsMax; p.range = s.range; p.shields = s.shields;
      p.power = s.power; p.powerTime = s.powerTime; p.cooldown = s.cooldown; p.slotLock = s.slotLock;
      p.radiation = s.radiation; p.ghost = s.ghost; p.invuln = s.invuln; p.sprint = s.sprint; p.powerMax = s.powerMax;
      p.tpPhase = s.tpPhase; p.tpTimer = s.tpTimer; p.tpDur = s.tpDur;
      p.out = s.out; p.alive = s.alive; p.respawn = s.respawn; p.exited = s.exited;
      p.cast = s.cast; p.hit = s.hit; p.kills = s.kills; p.wins = s.wins; p.barrierSoundT = s.barrierSoundT;
      p.selfKills = s.selfKills || 0; p.spellsCast = s.spellsCast || 0; p.rocksBroken = s.rocksBroken || 0;
      p.botTimer = s.botTimer || 0; p.botDir = s.botDir ?? -1; p.botGoal = s.botGoal ?? -1;
      p.deathCell = s.deathCell ? [s.deathCell[0], s.deathCell[1]] : null;
      p.input = { ...s.input };
      p._clientMoved = false;
    }
    for (let i = 0; i < this.monsters.length; i++) {
      const m = this.monsters[i], s = st.monsters[i];
      if (!s) continue;
      m.tx = s.tx; m.ty = s.ty; m.nx = s.nx; m.ny = s.ny; m.p = s.p; m.dir = s.dir; m.moving = s.moving;
      m.stepSpeed = s.stepSpeed; m.stepDir = s.stepDir; m.stepForced = s.stepForced; m.stepBelt = s.stepBelt;
      m.stun = s.stun; m.id = s.id; m.px = s.px; m.py = s.py; m.speed = s.speed;
      m.push = s.push ? { ...s.push } : null;
      m.hp = s.hp; m.maxHp = s.maxHp; m.boss = s.boss; m.smart = s.smart; m.alive = s.alive;
      m.flash = s.flash; m.zapped = s.zapped; m.tpPhase = s.tpPhase; m.tpTimer = s.tpTimer; m.tpDur = s.tpDur;
      m.tpGrace = new Set(s.tpGrace); m.walkLeft = s.walkLeft; m.aiState = s.aiState;
      m.bfsGrid = s.bfsGrid;
      m.huntTarget = s.huntTarget ? [s.huntTarget[0], s.huntTarget[1]] : null;
      m.touching = s.touching; m.touchWait = s.touchWait; m.retreatingTouch = s.retreatingTouch;
      m.lastTouchDir = s.lastTouchDir; m.barrierSoundT = s.barrierSoundT;
    }
  }

  /** Export a JSON-serializable state snapshot for P2P rejoin / desync recovery. */
  exportState() {
    const s = this.saveState();
    return {
      ...s,
      terrain: [...s.terrain],
      scent: [...s.scent],
      hidden: [...s.hidden],
      barriers: [...s.barriers],
      projs: s.projs.map(pr => ({ ...pr, flippedDoors: pr.flippedDoors ? [...pr.flippedDoors] : null })),
      winds: s.winds.map(w => ({ ...w, cells: [...w.cells] })),
      monsters: s.monsters.map(m => ({ ...m, tpGrace: [...m.tpGrace], bfsGrid: null })),
    };
  }

  /** Restore simulation state from exportState(). */
  importState(data) {
    this.loadState({
      ...data,
      terrain: Uint8Array.from(data.terrain),
      scent: Float32Array.from(data.scent),
      hidden: new Map(data.hidden),
      barriers: new Map(data.barriers),
      projs: data.projs.map(pr => ({ ...pr, flippedDoors: pr.flippedDoors ? new Set(pr.flippedDoors) : null })),
      winds: data.winds.map(w => ({ ...w, cells: new Map(w.cells) })),
      monsters: data.monsters.map(m => ({ ...m, tpGrace: new Set(m.tpGrace), bfsGrid: null })),
    });
  }

  /** Fast 32-bit FNV-1a checksum over authoritative simulation fields for desync detection. */
  stateChecksum() {
    let h = 2166136261 >>> 0;
    const mix = v => { h ^= (v | 0); h = Math.imul(h, 16777619) >>> 0; };
    mix(this.rng.s); mix(this.nextId); mix(Math.round(this.time * 1000));
    mix(this.state.charCodeAt(0)); mix(this.bombs.length); mix(this.flames.size); mix(this.items.size);
    for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] !== T.FLOOR) { mix(i); mix(this.terrain[i]); }
    for (const p of this.players) {
      mix(p.slot); mix(p.alive ? 1 : 0); mix(p.out ? 1 : 0); mix(p.lives); mix(p.score);
      mix(Math.round(p.fx * 1024)); mix(Math.round(p.fy * 1024)); mix(p.bombsMax); mix(p.range);
    }
    for (const m of this.monsters) {
      mix(m.id); mix(m.alive ? 1 : 0); mix(m.tx); mix(m.ty); mix(Math.round(m.p * 256)); mix(m.hp);
    }
    for (const b of this.bombs) { mix(b.id); mix(b.cx); mix(b.cy); mix(Math.round(b.fuse * 1000)); }
    return h >>> 0;
  }
}

/**
 * FRACAS.EXE 0x00643 -> 0x08386 (LIFE EXCHANGE):
 * At level clear in multi-player Normal Mode, a living player with >1 heart can share
 * hearts (always keeping >=1 heart) with permanently fallen players (lives <= 0).
 */
export function canExchangeLives(game) {
  if (!game || game.mode !== 'normal' || game.players.length < 2) return false;
  return game.players.some(p => p.lives <= 0) && game.players.some(p => p.lives > 1);
}

/** Transfer up to `amount` hearts from donor to recipient, keeping donor >= 1 heart. */
export function transferLives(donor, recipient, amount = 1) {
  if (!donor || !recipient || donor === recipient || donor.lives <= 1) return 0;
  const want = Math.max(0, Math.floor(amount));
  const give = Math.min(want, donor.lives - 1);
  if (give <= 0) return 0;
  donor.lives -= give;
  recipient.lives = Math.max(0, recipient.lives) + give;
  if (recipient.lives > 0) recipient.out = false;
  return give;
}

/** Single-heart convenience wrapper matching original Left/Right life exchange steps. */
export function exchangeLife(donor, recipient) {
  return transferLives(donor, recipient, 1) === 1;
}

/**
 * Distribute spare hearts (donor.lives > 1) round-robin to all fallen players (lives <= 0)
 * until every fallen player has >= 1 heart or no donor has spare hearts left.
 */
export function shareLivesWithAll(game) {
  if (!game || game.mode !== 'normal' || game.players.length < 2) return [];
  const transfers = [];
  const fallen = game.players.filter(p => p.lives <= 0).sort((a, b) => a.slot - b.slot);
  if (!fallen.length) return transfers;
  let progress = true;
  while (progress) {
    progress = false;
    for (const rec of fallen) {
      if (rec.lives > 0) continue;
      const donors = game.players.filter(p => p !== rec && p.lives > 1).sort((a, b) => b.lives - a.lives || a.slot - b.slot);
      if (!donors.length) break;
      const donor = donors[0];
      if (exchangeLife(donor, rec)) {
        transfers.push({ from: donor.slot, to: rec.slot });
        progress = true;
      }
    }
  }
  return transfers;
}

/** Give 1 heart to `targetSlot` using `lx.leftSlot` (if able) or the richest living donor (`lives > 1`). */
export function giveLifeToSlot(game, lx, targetSlot) {
  if (!game || !lx) return null;
  const target = game.players.find(q => q.slot === targetSlot);
  if (!target) return null;
  const curLeft = game.players.find(q => q.slot === lx.leftSlot);
  const donor = (curLeft && curLeft !== target && curLeft.lives > 1)
    ? curLeft
    : game.players.filter(q => q !== target && q.lives > 1).sort((a, b) => b.lives - a.lives || a.slot - b.slot)[0];
  if (!donor || !exchangeLife(donor, target)) return null;
  lx.leftSlot = donor.slot;
  lx.rightSlot = target.slot;
  return { from: donor.slot, to: target.slot };
}

/** Take 1 spare heart from `donorSlot` (`lives > 1`) and give it to `lx.rightSlot` (preferring fallen teammates). */
export function takeLifeFromSlot(game, lx, donorSlot) {
  if (!game || !lx) return null;
  const donor = game.players.find(q => q.slot === donorSlot && q.lives > 1);
  if (!donor) return null;
  const curRight = game.players.find(q => q.slot === lx.rightSlot);
  const hasFallenOther = game.players.some(q => q !== donor && q.lives <= 0);
  const recipient = (curRight && curRight !== donor && (curRight.lives <= 0 || !hasFallenOther))
    ? curRight
    : game.players.filter(q => q !== donor).sort((a, b) => a.lives - b.lives || a.slot - b.slot)[0];
  if (!recipient || !exchangeLife(donor, recipient)) return null;
  lx.leftSlot = donor.slot;
  lx.rightSlot = recipient.slot;
  return { from: donor.slot, to: recipient.slot };
}
