// High-IQ Deterministic AI Wizard Bot for Fracas 2027 (offline & online Rollback-safe).
// Features:
//  - Chain-reaction & vent-aware explosion timer map (seconds until every tile becomes lethal)
//  - Exact timed escape BFS accounting for wizard speed & sub-tile alignment
//  - Full-map Weighted Dijkstra through destructible rocks (%) so bots NEVER stare at walls
//  - Tactical enemy hunting, corridor trapping, rock-cluster farming, projectile dodging & proactive spell aiming
//  - Smooth sub-tile centering to prevent oscillation and corner-clipping
import { W, H, DIRS, T, FUSE, TICK_HZ, SPIKE_CYCLE } from './constants.js';

const N = W * H;
const idx = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

const INF = 999;

// Pre-allocated scratch buffers (zero per-frame GC churn, deterministic single-threaded use)
const _det = new Float32Array(N);        // seconds until tile is dangerous (INF = rest-safe, 0 = lethal NOW)
const _arr = new Float32Array(N);        // timed BFS earliest arrival time (seconds)
const _bfsDist = new Int16Array(N);      // timed BFS tile distance
const _bfsFirst = new Int8Array(N);      // timed BFS first move direction from start
const _qx = new Int16Array(N);
const _qy = new Int16Array(N);

// Full-map weighted Dijkstra buffers (sees through destructible rocks!)
const _wCost = new Int16Array(N);
const _wFirst = new Int8Array(N);        // first cardinal dir from start along weighted path
const _wPrev = new Int16Array(N);        // parent cell index
const _wUsed = new Uint8Array(N);

// Bomb chain-reaction scratch
const _bFuse = new Float32Array(64);

const SKILL = {
  easy: {
    escapeMargin: 0.55,
    bombCooldown: 1.15,
    spellChance: 0.45,
    aggroDist: 6,
    trapBonus: 0,
    minSafeExits: 1,
    rockFarm: 0.45,
    chaseWeight: 1.0,
  },
  normal: {
    escapeMargin: 0.42,
    bombCooldown: 0.42,
    spellChance: 0.85,
    aggroDist: 14,
    trapBonus: 25,
    minSafeExits: 1,
    rockFarm: 0.85,
    chaseWeight: 1.35,
  },
  master: {
    escapeMargin: 0.34,
    bombCooldown: 0.08,
    spellChance: 1.0,
    aggroDist: 30,
    trapBonus: 55,
    minSafeExits: 1,
    rockFarm: 1.0,
    chaseWeight: 1.75,
  },
};

function traceRayCells(game, bx, by, range, kind, fn, extraBomb = null) {
  fn(bx, by, idx(bx, by));
  const maxR = kind === 'electric' ? 22 : range;
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d];
    for (let r = 1; r <= maxR; r++) {
      const nx = bx + dx * r, ny = by + dy * r;
      if (!inside(nx, ny)) break;
      const ni = idx(nx, ny);
      if (game.terrain[ni] === T.WALL || game.barriers.has(ni)) break;
      if (game.terrain[ni] === T.ROCK) {
        if (kind === 'fire') fn(nx, ny, ni);
        break;
      }
      const f = game.feat[ni];
      if (f?.k === 'oneway' && f.d !== d) break;
      fn(nx, ny, ni);
      if (f?.k === 'door') break;
      if (extraBomb && nx === extraBomb[0] && ny === extraBomb[1]) break;
      if (game.anyBombAt(nx, ny)) break;
    }
  }
}

/**
 * Build exact time-to-danger map `_det[0..314]` in seconds.
 * Propagates bomb->bomb chain reactions and vent explosions!
 */
function buildDetonationMap(game, selfSlot, extraBomb = null) {
  _det.fill(INF);

  // 1. Active flames
  for (const [i, fl] of game.flames) {
    _det[i] = fl.kind === 'fire' ? 0 : 0.06;
  }

  // 2. Spikes (active or popping within ~0.85s)
  if (game.stasis <= 0) {
    for (let i = 0; i < N; i++) {
      const f = game.feat[i];
      if (f?.k !== 'spike') continue;
      if (f.out) {
        _det[i] = 0;
      } else if (f.active) {
        const tick = (f.ph || 0) * 106;
        if (tick < 15) {
          const tUntil = (15 - tick) / TICK_HZ;
          if (tUntil < 0.9 && tUntil < _det[i]) _det[i] = tUntil;
        }
      }
    }
  }

  // 3. Incoming projectiles (project along travel direction!)
  for (const pr of game.projs) {
    if (pr.spell === 'wind') continue;
    if (pr.owner === selfSlot && pr.age < 15 / TICK_HZ) continue;
    const [dx, dy] = DIRS[pr.d];
    const spd = Math.max(3, pr.speed || 5.625);
    const px = Math.floor(pr.x), py = Math.floor(pr.y);
    for (let k = 0; k <= 7; k++) {
      const nx = px + dx * k, ny = py + dy * k;
      if (!inside(nx, ny)) break;
      const ni = idx(nx, ny);
      if (game.terrain[ni] !== T.FLOOR || game.barriers.has(ni)) break;
      const f = game.feat[ni];
      if (f?.k === 'oneway' && f.d !== pr.d) break;
      const tHit = Math.max(0, (k - 0.35) / spd);
      if (tHit < _det[ni]) _det[ni] = tHit;
      if (f?.k === 'door') break;
    }
  }

  // 4. Bombs + hypothetical extraBomb with full chain-reaction propagation
  const bombs = game.bombs;
  const nb = Math.min(60, bombs.length);
  const totalB = extraBomb ? nb + 1 : nb;
  for (let i = 0; i < nb; i++) {
    const b = bombs[i];
    // Enemy ignitor bomb (fuse > 20s): treat as imminent 0.75s hazard so we don't camp in their blast ray!
    let fz = b.fuse;
    if (fz > 20) fz = b.owner === selfSlot ? 3.5 : 0.75;
    _bFuse[i] = Math.max(0.04, fz);
  }
  if (extraBomb) {
    const [ex, ey, erange, efuse] = extraBomb;
    _bFuse[nb] = Math.max(0.05, efuse ?? FUSE * (game.mutators?.fuseScale || 1));
    // Check if an existing bomb already hits extraBomb, or vice versa
    for (let i = 0; i < nb; i++) {
      const b = bombs[i];
      if (b.cx === ex && b.cy === ey) _bFuse[nb] = Math.min(_bFuse[nb], _bFuse[i]);
    }
  }

  const getBombAt = bi => {
    if (bi < nb) {
      const b = bombs[bi];
      const kind = b.kind || 'fire';
      const range = b.vent >= 0 && kind === 'fire' ? 1 : b.range;
      return { cx: b.cx, cy: b.cy, range, kind, vent: b.vent };
    }
    const [ex, ey, erange] = extraBomb;
    const ef = game.feat[idx(ex, ey)];
    const onVent = ef?.k === 'vent';
    return { cx: ex, cy: ey, range: onVent ? 1 : erange, kind: 'fire', vent: onVent ? (ef.g ?? 0) : -1 };
  };

  // Iterative chain-reaction relaxation (propagates earliest fuse across chained bombs & vents)
  for (let pass = 0; pass < 4 && totalB > 1; pass++) {
    let changed = false;
    for (let a = 0; a < totalB; a++) {
      const ba = getBombAt(a);
      const fa = _bFuse[a];
      const propagate = (tx, ty) => {
        for (let b = 0; b < totalB; b++) {
          if (b === a) continue;
          const bb = getBombAt(b);
          if (bb.cx === tx && bb.cy === ty && fa < _bFuse[b] - 1e-4) {
            _bFuse[b] = fa;
            changed = true;
          }
        }
      };
      traceRayCells(game, ba.cx, ba.cy, ba.range, ba.kind, propagate, extraBomb);
      if (ba.vent >= 0 && ba.kind === 'fire') {
        for (const [vx, vy] of game.vents) traceRayCells(game, vx, vy, 1, 'fire', propagate, extraBomb);
      }
    }
    if (!changed) break;
  }

  // Stamp final detonation times into `_det`
  for (let a = 0; a < totalB; a++) {
    const ba = getBombAt(a);
    const fa = _bFuse[a];
    const stamp = (_x, _y, ni) => { if (fa < _det[ni]) _det[ni] = fa; };
    traceRayCells(game, ba.cx, ba.cy, ba.range, ba.kind, stamp, extraBomb);
    if (ba.vent >= 0 && ba.kind === 'fire') {
      for (const [vx, vy] of game.vents) traceRayCells(game, vx, vy, 1, 'fire', stamp, extraBomb);
    }
  }

  // 5. Monsters in Story mode (current tile + moving-toward tile = lethal now; front facing tile = short fuse so bot can flank!)
  if (game.mode === 'normal' && game.stasis <= 0) {
    for (const m of game.monsters) {
      if (!m.alive || m.tpPhase === 'hide' || m.stun > 0) continue;
      const mi = idx(m.cx, m.cy);
      _det[mi] = 0;
      if (m.moving && inside(m.nx, m.ny)) _det[idx(m.nx, m.ny)] = Math.min(_det[idx(m.nx, m.ny)], 0.08);
      if (m.dir >= 0 && m.dir < 4) {
        const fx = m.cx + DIRS[m.dir][0], fy = m.cy + DIRS[m.dir][1];
        if (inside(fx, fy) && game.terrain[idx(fx, fy)] === T.FLOOR && !game.blockedBetween(m.cx, m.cy, fx, fy)) {
          _det[idx(fx, fy)] = Math.min(_det[idx(fx, fy)], 0.25);
        }
      }
    }
  }
}

/**
 * Timed BFS from wizard `p`'s position `(sx, sy)`:
 * Computes real arrival times `_arr[i]` and only steps through tiles that won't explode before we pass!
 */
function runTimedBfs(game, p, sx, sy, maxSteps, margin, extraBlockedCell = null) {
  _arr.fill(INF);
  _bfsDist.fill(-1);
  _bfsFirst.fill(-1);

  const spd = Math.max(2.0, p.speed || 3.75);
  const si = idx(sx, sy);
  _arr[si] = 0;
  _bfsDist[si] = 0;
  let head = 0, tail = 0;
  _qx[tail] = sx;
  _qy[tail] = sy;
  tail++;

  // Sub-tile alignment overhead for the very first step in each direction
  const offX = p.fx - (sx + 0.5);
  const offY = p.fy - (sy + 0.5);

  while (head < tail) {
    const cx = _qx[head], cy = _qy[head];
    head++;
    const ci = idx(cx, cy);
    const cd = _bfsDist[ci];
    const ct = _arr[ci];
    if (cd >= maxSteps) continue;

    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!inside(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (extraBlockedCell && nx === extraBlockedCell[0] && ny === extraBlockedCell[1]) continue;
      if ((nx !== sx || ny !== sy) && game.anyBombAt(nx, ny)) continue;
      if (!game.canStep(p, cx, cy, d)) continue;

      let stepDist = 1.0;
      if (cd === 0) {
        const horiz = d % 2 === 0;
        const alignCost = horiz ? Math.abs(offY) : Math.abs(offX);
        const alongOff = horiz ? offX * DIRS[d][0] : offY * DIRS[d][1];
        stepDist = Math.max(0.45, 1.0 - alongOff + alignCost);
      }
      const nextArr = ct + stepDist / spd;

      // Must survive passing through tile `ni` (we occupy it roughly from nextArr - 0.12 to nextArr + margin)
      if (_det[ni] <= nextArr + margin) continue;
      if (nextArr >= _arr[ni] - 1e-4) continue;

      _arr[ni] = nextArr;
      _bfsDist[ni] = cd + 1;
      _bfsFirst[ni] = cd === 0 ? d : _bfsFirst[ci];
      _qx[tail] = nx;
      _qy[tail] = ny;
      tail++;
    }
  }
  return tail;
}

/** Count open safe exits around cell (x, y) to prefer roomy intersections over 1-exit dead ends. */
function countOpenExits(game, p, x, y) {
  let c = 0;
  for (let d = 0; d < 4; d++) {
    if (game.canStep(p, x, y, d)) c++;
  }
  return c;
}

/**
 * Verify that dropping a bomb at `(bx, by)` leaves a guaranteed, timely escape route to a REST-SAFE tile (`_det >= 900`).
 * Restores `_det` for current state before returning if `restore` is true.
 */
function evaluateBombSafety(game, p, tier) {
  const bx = p.cx, by = p.cy;
  const fuseScale = game.mutators?.fuseScale || 1;
  const myFuse = p.power === 'ignitor' ? 3.5 : FUSE * fuseScale;
  buildDetonationMap(game, p.slot, [bx, by, p.range, myFuse]);
  const count = runTimedBfs(game, p, bx, by, Math.min(12, p.range + 6), tier.escapeMargin, [bx, by]);
  let safeTiles = 0;
  let bestSafeTime = INF;
  for (let k = 1; k < count; k++) {
    const ti = idx(_qx[k], _qy[k]);
    if (_det[ti] >= 900) {
      safeTiles++;
      if (_arr[ti] < bestSafeTime) bestSafeTime = _arr[ti];
    }
  }
  // Restore live detonation map (without hypothetical bomb)
  buildDetonationMap(game, p.slot, null);
  return {
    safe: safeTiles >= tier.minSafeExits && bestSafeTime < myFuse - tier.escapeMargin,
    safeTiles,
    bestSafeTime,
  };
}

/**
 * Full-Map Weighted Dijkstra across the ENTIRE 21×15 map!
 * Open floor costs 1; destructible rocks (%) cost 6; doors cost 2 (open) or 7 (closed).
 * Gives bots complete spatial awareness through walls of destructible rocks!
 */
function runFullMapDijkstra(game, p, sx, sy) {
  _wCost.fill(30000);
  _wFirst.fill(-1);
  _wPrev.fill(-1);
  _wUsed.fill(0);

  const si = idx(sx, sy);
  _wCost[si] = 0;

  for (let iter = 0; iter < N; iter++) {
    let bestI = -1, bestC = 30000;
    for (let i = 0; i < N; i++) {
      if (!_wUsed[i] && _wCost[i] < bestC) {
        bestC = _wCost[i];
        bestI = i;
      }
    }
    if (bestI < 0) break;
    _wUsed[bestI] = 1;

    const cx = bestI % W, cy = (bestI / W) | 0;
    const cf = game.feat[bestI];
    const fromRock = game.terrain[bestI] === T.ROCK;

    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!inside(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (_wUsed[ni]) continue;
      const ter = game.terrain[ni];
      if (ter === T.WALL || game.barriers.has(ni)) continue;
      if (!fromRock && cf?.k === 'oneway' && cf.d !== d) continue;
      if (!fromRock && cf?.k === 'door' && (d % 2 === 1) !== cf.ns) continue;

      const nf = game.feat[ni];
      if (nf?.k === 'oneway' && nf.d !== d) continue;

      let stepCost = 1;
      if (ter === T.ROCK) {
        stepCost = 6;
      } else if (nf?.k === 'door') {
        const closed = (d % 2 === 1) !== nf.ns || (d <= 1 && nf.state === 4) || (d >= 2 && nf.state === 0);
        if ((d % 2 === 1) !== nf.ns) continue;
        stepCost = closed ? 7 : 2;
      } else if (game.anyBombAt(nx, ny)) {
        stepCost = 8;
      } else if (_det[ni] < 1.2) {
        stepCost = 5;
      }

      const nc = bestC + stepCost;
      if (nc < _wCost[ni]) {
        _wCost[ni] = nc;
        _wPrev[ni] = bestI;
        _wFirst[ni] = bestI === si ? d : _wFirst[bestI];
      }
    }
  }
}

/** Trace back from target cell `ti` to find the immediate next cell after start `si` along Dijkstra path. */
function firstCellToward(si, ti) {
  if (ti < 0 || _wCost[ti] >= 30000 || ti === si) return -1;
  let cur = ti;
  let guard = 0;
  while (_wPrev[cur] !== si && _wPrev[cur] >= 0 && guard++ < N) {
    cur = _wPrev[cur];
  }
  return _wPrev[cur] === si ? cur : -1;
}

/** Clear cardinal line-of-sight check between two grid cells (returns dir 0..3 or -1). */
function losDirTo(game, sx, sy, tx, ty, maxRange = 18) {
  if (sx !== tx && sy !== ty) return -1;
  const dx = Math.sign(tx - sx), dy = Math.sign(ty - sy);
  const dist = Math.abs(tx - sx) + Math.abs(ty - sy);
  if (dist === 0 || dist > maxRange) return -1;
  const d = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
  for (let r = 1; r < dist; r++) {
    const nx = sx + dx * r, ny = sy + dy * r;
    const i = idx(nx, ny);
    if (game.terrain[i] !== T.FLOOR || game.barriers.has(i)) return -1;
    const f = game.feat[i];
    if (f?.k === 'door' || (f?.k === 'oneway' && f.d !== d)) return -1;
  }
  return d;
}

/** Count how many destructible rocks a fire bomb placed at (bx, by) with `range` would destroy! */
function countRocksHitByBomb(game, bx, by, range) {
  let hits = 0;
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d];
    for (let r = 1; r <= range; r++) {
      const nx = bx + dx * r, ny = by + dy * r;
      if (!inside(nx, ny)) break;
      const ni = idx(nx, ny);
      if (game.terrain[ni] === T.WALL || game.barriers.has(ni)) break;
      if (game.terrain[ni] === T.ROCK) { hits++; break; }
      const f = game.feat[ni];
      if (f?.k === 'door' || (f?.k === 'oneway' && f.d !== d)) break;
    }
  }
  return hits;
}

/** Check if dropping a fire bomb here would hit a living teammate in Co-op when friendlyFire is on. */
function endangersTeammate(game, p) {
  if (game.mode !== 'normal' || game.mutators?.friendlyFire === false) return false;
  for (const o of game.players) {
    if (o === p || !o.alive) continue;
    if (o.cx === p.cx && o.cy === p.cy) return true;
    if (losDirTo(game, p.cx, p.cy, o.cx, o.cy, p.range) >= 0) return true;
  }
  return false;
}

function itemValue(name, p) {
  switch (name) {
    case 'max': return 140;
    case 'heart': return 130;
    case 'greenGem': return p.bombsMax < 5 ? 95 : 10;
    case 'purpleGem': return p.range < 5 ? 95 : 10;
    case 'orb': return 85;
    case 'stoneFire': return 85;
    case 'ignitor': return 80;
    case 'foot': return 78;
    case 'radiation': return 75;
    case 'glassFire': return 72;
    case 'glassElectric': return 68;
    case 'stoneElectric': return 62;
    case 'stoneWind': return 55;
    case 'glassTeleport': return 50;
    case 'stoneTeleport': return 45;
    case 'glassWind': return 35;
    case 'ghost': return 0;
    default: return 25;
  }
}

/** Smoothly center wizard on its current safe tile when holding position so perpendicular blasts/corners never clip it. */
function centerDirIfOffAxis(p) {
  const dx = (p.cx + 0.5) - p.fx;
  const dy = (p.cy + 0.5) - p.fy;
  if (Math.abs(dx) > 0.14) return dx > 0 ? 0 : 2;
  if (Math.abs(dy) > 0.14) return dy > 0 ? 1 : 3;
  return -1;
}

/**
 * Main deterministic AI Wizard decision loop.
 * Called every fixed simulation tick for bot-controlled players.
 */
export function thinkBot(game, p, dt) {
  const out = { dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false };
  if (!p.alive || p.out || p.tpPhase || p.stun > 0 || game.freeze > 0) {
    p.input = out;
    return out;
  }

  const tier = SKILL[p.bot] || SKILL.normal;
  p.botTimer = Math.max(0, (p.botTimer || 0) - dt);

  const sx = p.cx, sy = p.cy, si = idx(sx, sy);

  // Build accurate chain-reaction detonation timer map
  buildDetonationMap(game, p.slot, null);

  // Instant utility spells (Speed Boots, Ignitor lethal trigger, Chrono Stasis panic)
  if (p.power && p.cooldown <= 0) {
    if (p.power === 'foot' && !p.sprint) {
      out.power = true;
    } else if (p.power === 'ignitor') {
      const myBombs = game.bombs.filter(b => b.owner === p.slot && b.fuse > 0);
      for (const b of myBombs) {
        const selfSafe = !(b.cx === sx && b.cy === sy) && losDirTo(game, b.cx, b.cy, sx, sy, b.range) < 0;
        if (!selfSafe) continue;
        const enemies = game.mode === 'battle'
          ? game.players.filter(o => o !== p && o.alive && !o.tpPhase)
          : game.monsters.filter(m => m.alive && m.tpPhase !== 'hide');
        const hitsTarget = enemies.some(e => (e.cx === b.cx && e.cy === b.cy) || losDirTo(game, b.cx, b.cy, e.cx, e.cy, b.range) >= 0);
        const hitsRock = countRocksHitByBomb(game, b.cx, b.cy, b.range) > 0 && b.age > 0.6;
        if (hitsTarget || hitsRock) {
          out.power = true;
          break;
        }
      }
    } else if (p.power === 'orb' && game.mode === 'normal' && game.stasis <= 0) {
      const nearThreat = game.monsters.some(m => m.alive && Math.hypot(m.x - p.x, m.y - p.y) < 2.8);
      if (nearThreat) out.power = true;
    }
  }

  // ==================================================================
  // PHASE 1: SURVIVAL & EVASION (if standing in ANY bomb ray, flame, spike, projectile, or monster zone)
  // ==================================================================
  const hereDet = _det[si];
  if (hereDet < 900) {
    const count = runTimedBfs(game, p, sx, sy, 14, Math.min(tier.escapeMargin, Math.max(0.12, hereDet * 0.45)));
    let bestDir = -1, bestScore = -1e9;
    for (let k = 1; k < count; k++) {
      const tx = _qx[k], ty = _qy[k], ti = idx(tx, ty);
      const d = _det[ti];
      const exits = countOpenExits(game, p, tx, ty);
      // Strongly prefer REST-SAFE tiles (d >= 900), quickest arrival, and roomy tiles with >= 2 exits
      const safeBonus = d >= 900 ? 1000 : d * 90;
      const sc = safeBonus - _arr[ti] * 180 + Math.min(3, exits) * 28;
      if (sc > bestScore) {
        bestScore = sc;
        bestDir = _bfsFirst[ti];
      }
    }
    // Last-resort fallback if boxed in tight: step toward highest detonation time neighbor
    if (bestDir < 0) {
      let bestN = -1, bestD = hereDet;
      for (let d = 0; d < 4; d++) {
        if (!game.canStep(p, sx, sy, d)) continue;
        const ni = idx(sx + DIRS[d][0], sy + DIRS[d][1]);
        if (_det[ni] > bestD) { bestD = _det[ni]; bestN = d; }
      }
      bestDir = bestN;
    }
    out.dir = bestDir;
    p.botDir = bestDir;
    p.input = out;
    return out;
  }

  // ==================================================================
  // PHASE 2: OFFENSIVE SPELL SNIPING (turn toward enemy in LoS and fire!)
  // ==================================================================
  const enemies = game.mode === 'battle'
    ? game.players.filter(o => o !== p && o.alive && !o.tpPhase)
    : game.monsters.filter(m => m.alive && m.tpPhase !== 'hide');
  const vulnEnemies = game.mode === 'battle'
    ? enemies.filter(o => o.invuln <= 0.35)
    : enemies;

  if (!out.power && p.power && p.cooldown <= 0) {
    const isLineSpell = p.power === 'glassFire' || p.power === 'glassElectric' || p.power === 'glassTeleport' || p.power === 'glassWind';
    const isAreaSpell = p.power === 'stoneFire' || p.power === 'stoneWind';
    const isSpecBomb = p.power === 'stoneElectric' || p.power === 'stoneTeleport';

    if (isLineSpell || isAreaSpell) {
      const reach = p.power === 'glassWind' ? 6 : (p.power === 'stoneWind' ? 5 : 14);
      for (const e of vulnEnemies) {
        const ld = losDirTo(game, sx, sy, e.cx, e.cy, reach);
        if (ld < 0) continue;
        // Avoid shooting teammates in Co-op when friendly fire is on
        if (game.mode === 'normal' && game.mutators?.friendlyFire !== false) {
          const teamBlocked = game.players.some(o => o !== p && o.alive && losDirTo(game, sx, sy, o.cx, o.cy, Math.abs(e.cx - sx) + Math.abs(e.cy - sy)) === ld);
          if (teamBlocked) continue;
        }
        if (isAreaSpell) {
          if (game.rng.next() < tier.spellChance) { out.power = true; break; }
        } else if (ld === p.dir) {
          if (game.rng.next() < tier.spellChance) { out.power = true; break; }
        } else if (ld === (p.dir + 2) % 4) {
          // Reverse-cast pro move! Hold bomb + cast fires backward in Fracas!
          if (p.bot === 'master') { out.power = true; out.bombHeld = true; break; }
        } else if (game.canStep(p, sx, sy, ld) && _det[idx(sx + DIRS[ld][0], sy + DIRS[ld][1])] >= 900) {
          // Turn quickly toward enemy so next tick fires cleanly!
          out.dir = ld;
          p.botDir = ld;
          p.input = out;
          return out;
        }
      }
    } else if (isSpecBomb && p.botTimer <= 0 && !game.anyBombAt(sx, sy)) {
      const hitEnemy = vulnEnemies.some(e => losDirTo(game, sx, sy, e.cx, e.cy, p.power === 'stoneElectric' ? 12 : p.range) >= 0);
      if (hitEnemy && evaluateBombSafety(game, p, tier).safe) {
        out.dir = -1;
        out.power = true;
        p.botTimer = 0.4;
        p.input = out;
        return out;
      }
    }
  }

  // ==================================================================
  // PHASE 3: REACHABLE SAFE BFS + FULL-MAP WEIGHTED DIJKSTRA VISION
  // ==================================================================
  const safeReachCount = runTimedBfs(game, p, sx, sy, 22, tier.escapeMargin);
  runFullMapDijkstra(game, p, sx, sy);

  // Pick our primary strategic goal across the ENTIRE map
  let goalCell = -1;
  let goalKind = 'none';

  // 3A. Story Clear -> Enter Portal immediately!
  if (game.mode === 'normal' && game.state === 'clear' && game.portal) {
    goalCell = idx(game.portal.x, game.portal.y);
    goalKind = 'portal';
  }

  // 3B. High-value safely reachable pickup (prioritize MAX, heart, gems, spells!)
  if (goalCell < 0 && game.items.size > 0) {
    let bestPickScore = 15;
    for (const [ii, it] of game.items) {
      if (_bfsDist[ii] <= 0 || _det[ii] < 900) continue;
      const val = itemValue(it.name, p);
      if (val <= 0) continue;
      const sc = val - _bfsDist[ii] * 9;
      if (sc > bestPickScore) {
        bestPickScore = sc;
        goalCell = ii;
        goalKind = 'pickup';
      }
    }
  }

  // 3C. Attack / Bomb Decision RIGHT HERE against enemy or tactical rock
  const myBombs = game.bombs.filter(b => b.owner === p.slot).length;
  const centeredEnough = Math.abs(p.fx - (sx + 0.5)) <= 0.34 && Math.abs(p.fy - (sy + 0.5)) <= 0.34;
  const canPlaceBomb = myBombs < p.bombsMax && !game.anyBombAt(sx, sy) && !endangersTeammate(game, p) && p.botTimer <= 0;

  // Helper: place bomb safely on exact current tile (sx, sy) — dir=-1 for 1 tick guarantees movePlayer() never shifts cx/cy before placeBomb()!
  const dropBombHere = (cd) => {
    if (!centeredEnough) {
      out.dir = centerDirIfOffAxis(p);
      p.botDir = out.dir;
      p.input = out;
      return out;
    }
    out.dir = -1;
    out.bomb = true;
    p.botTimer = cd;
    p.input = out;
    return out;
  };

  // Check if dropping a bomb RIGHT HERE hits an enemy or traps/ambushes them in a corridor
  if (canPlaceBomb && goalKind !== 'portal') {
    let enemyBlastHit = false;
    let enemyPressure = false;
    for (const e of vulnEnemies) {
      const md = Math.abs(e.cx - sx) + Math.abs(e.cy - sy);
      if (losDirTo(game, sx, sy, e.cx, e.cy, Math.max(p.range, game.mode === 'normal' ? 3 : p.range)) >= 0) {
        enemyBlastHit = true;
        break;
      }
      if (md <= (p.bot === 'master' ? 4 : 2)) enemyPressure = true;
    }

    if (enemyBlastHit || (enemyPressure && p.bot !== 'easy')) {
      const safety = evaluateBombSafety(game, p, tier);
      if (safety.safe && (enemyBlastHit || safety.safeTiles >= 2)) {
        return dropBombHere(tier.bombCooldown);
      }
    }
  }

  // 3D. Full-Map Strategic Target Selection (uses Weighted Dijkstra through destructible rocks + goal hysteresis!)
  if (goalCell < 0) {
    let bestEnemyScore = -1e9;
    for (const e of enemies) {
      const ei = idx(e.cx, e.cy);
      const wc = _wCost[ei];
      if (wc >= 30000) continue;
      // Prefer enemies with lower full-map weighted cost (even through rocks!)
      let sc = 500 - wc * 14 * tier.chaseWeight;
      // Strong continuity bonus if this enemy is near our committed goal (eliminates boundary flip-flop!)
      if (p.botGoal >= 0) {
        const gx = p.botGoal % W, gy = (p.botGoal / W) | 0;
        if (Math.abs(e.cx - gx) + Math.abs(e.cy - gy) <= 2) sc += 55;
      }
      // Bonus for cornered / low-exit rival wizards in Battle
      if (game.mode === 'battle') {
        const eExits = countOpenExits(game, e, e.cx, e.cy);
        if (eExits <= 2) sc += tier.trapBonus;
      }
      if (sc > bestEnemyScore) {
        bestEnemyScore = sc;
        goalCell = ei;
        goalKind = 'enemy';
      }
    }
  }
  p.botGoal = goalCell;

  // Check if our full-map path to `goalCell` is currently blocked by an adjacent destructible rock or closed door!
  if (goalCell >= 0 && goalCell !== si) {
    const nextStepCell = firstCellToward(si, goalCell);
    if (nextStepCell >= 0) {
      const nTer = game.terrain[nextStepCell];
      const nFeat = game.feat[nextStepCell];
      const needBlastNext = nTer === T.ROCK || (nFeat?.k === 'door' && !game.canStep(p, sx, sy, _wFirst[goalCell]));
      if (needBlastNext && canPlaceBomb) {
        const safety = evaluateBombSafety(game, p, tier);
        if (safety.safe) {
          return dropBombHere(Math.max(0.35, tier.bombCooldown));
        }
      }
    }
  }

  // 3E. Opportunistic Rock-Cluster Farming (when safely next to rocks for upgrades/openings)
  if (canPlaceBomb && myBombs === 0 && goalKind !== 'portal' && goalKind !== 'pickup') {
    const rockHits = countRocksHitByBomb(game, sx, sy, p.range);
    const wantUpgrades = p.bombsMax < 3 || p.range < 3 || !p.power;
    if (rockHits >= (wantUpgrades ? 1 : 2) && game.rng.next() < tier.rockFarm) {
      const safety = evaluateBombSafety(game, p, tier);
      if (safety.safe) {
        return dropBombHere(Math.max(0.4, tier.bombCooldown));
      }
    }
  }

  // ==================================================================
  // PHASE 4: EXECUTE SAFE MOVEMENT ALONG BEST PATH
  // ==================================================================
  let moveDir = -1;

  if (goalCell >= 0 && goalCell !== si) {
    // If directly reachable safely right now via timed BFS, take the exact safe BFS step!
    if (_bfsDist[goalCell] > 0 && _bfsFirst[goalCell] >= 0) {
      moveDir = _bfsFirst[goalCell];
    } else {
      // Follow full-map Dijkstra path toward the tile right before the rock/enemy!
      const dDir = _wFirst[goalCell];
      if (dDir >= 0 && game.canStep(p, sx, sy, dDir)) {
        const nx = sx + DIRS[dDir][0], ny = sy + DIRS[dDir][1];
        const ni = idx(nx, ny);
        // Only step onto `ni` if it is REST-SAFE (never casually step into a ticking bomb ray!)
        if (_det[ni] >= 900) {
          moveDir = dDir;
        }
      }
      // If Dijkstra's immediate step is blocked by a bomb/danger, pick the safely reachable tile closest to goalCell!
      if (moveDir < 0) {
        const gx = goalCell % W, gy = (goalCell / W) | 0;
        let bestTileDir = -1, bestScore = -1e9;
        for (let k = 1; k < safeReachCount; k++) {
          const tx = _qx[k], ty = _qy[k], ti = idx(tx, ty);
          if (_det[ti] < 900) continue;
          const rocksHere = countRocksHitByBomb(game, tx, ty, p.range);
          const md = Math.abs(tx - gx) + Math.abs(ty - gy);
          const sc = -md * 12 - _bfsDist[ti] * 3 + (rocksHere > 0 ? 18 : 0);
          if (sc > bestScore) {
            bestScore = sc;
            bestTileDir = _bfsFirst[ti];
          }
        }
        moveDir = bestTileDir;
      }
    }
  }

  // Verify chosen move doesn't step directly into danger
  if (moveDir >= 0) {
    const nx = sx + DIRS[moveDir][0], ny = sy + DIRS[moveDir][1];
    if (!inside(nx, ny) || !game.canStep(p, sx, sy, moveDir) || _det[idx(nx, ny)] < 900) {
      moveDir = -1;
    }
  }

  // Anti-oscillation at tile edges: if we JUST crossed a tile edge (within 0.28 of edge) and non-emergency
  // movement tries to reverse 180° back across the boundary, keep moving cleanly into the tile first!
  if (moveDir >= 0 && p.botDir >= 0 && moveDir === (p.botDir + 2) % 4) {
    const horiz = p.botDir % 2 === 0;
    const off = horiz ? (p.fx - (sx + 0.5)) * DIRS[p.botDir][0] : (p.fy - (sy + 0.5)) * DIRS[p.botDir][1];
    if (off < -0.15) {
      const fnx = sx + DIRS[p.botDir][0], fny = sy + DIRS[p.botDir][1];
      if (inside(fnx, fny) && game.canStep(p, sx, sy, p.botDir) && _det[idx(fnx, fny)] >= 900) {
        moveDir = p.botDir;
      } else {
        moveDir = centerDirIfOffAxis(p);
      }
    }
  }

  // If holding safely (e.g., waiting for our bomb to shatter a rock), finish centering on the tile!
  if (moveDir < 0) {
    moveDir = centerDirIfOffAxis(p);
    if (moveDir >= 0) {
      const nx = sx + DIRS[moveDir][0], ny = sy + DIRS[moveDir][1];
      if (inside(nx, ny) && _det[idx(nx, ny)] < 1.5 && Math.hypot(p.fx - (sx + 0.5), p.fy - (sy + 0.5)) < 0.2) {
        moveDir = -1;
      }
    }
  }

  out.dir = moveDir;
  p.botDir = moveDir;
  p.input = out;
  return out;
}
