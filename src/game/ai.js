// Monster brains: the original 6-bit IQ mask from FRACAS.EXE (0x114de..0x1243d).
// bit0 (0x01): wavefront BFS pathfinder to a random wizard's tile (1/4 chance per walk segment)
// bit1 (0x02): follow player scent trail (0x1061a)
// bit2 (0x04): charge uncovered pickup in 4-way line of sight
// bit3 (0x08): charge wizard in 4-way line of sight
// bit4 (0x10): flee cauldron / blast flame in 4-way line of sight down longest safe corridor
// bit5 (0x20): dodge incoming projectile in 4-way line of sight down longest safe corridor
import { W, H, DIRS, T } from './constants.js';

const idx = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const PRIO_DIRS = [3, 0, 1, 2]; // FRACAS.EXE direction check order: Up, Right, Down, Left

const _bfsQ = new Int16Array(W * H * 2);

/** Wavefront BFS grid (0x7f = 127 at target, decreasing by 1 per walkable predecessor step; 0 = unreachable) */
function buildBfsGrid(game, m, targetX, targetY) {
  const grid = new Int16Array(W * H);
  if (!inside(targetX, targetY)) return grid;
  let head = 0, tail = 0;
  grid[idx(targetX, targetY)] = 127;
  _bfsQ[tail++] = targetX;
  _bfsQ[tail++] = targetY;
  while (head < tail) {
    const cx = _bfsQ[head++], cy = _bfsQ[head++];
    const nextVal = grid[idx(cx, cy)] - 1;
    if (nextVal <= 1) continue;
    for (let fromDir = 0; fromDir < 4; fromDir++) {
      const nx = cx + DIRS[fromDir][0], ny = cy + DIRS[fromDir][1];
      if (!inside(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (grid[ni] > 0) continue;
      if (game.terrain[ni] !== T.FLOOR || game.barriers.has(ni)) continue;
      const nf = game.feat[ni];
      if (nf?.k === 'door') continue; // 0x121ab: Wavefront BFS treats flip-doors as impassable walls
      const stepDir = (fromDir + 2) % 4;
      if (nf?.k === 'oneway' && nf.d !== stepDir) continue;
      // 0x1217e: wavefront BFS treats walls, rocks, barriers, doors & wrong-way arrows as solid (never bombs)
      const cf = game.feat[idx(cx, cy)];
      if (cf?.k === 'oneway' && cf.d !== stepDir) continue;
      grid[ni] = nextVal;
      _bfsQ[tail++] = nx;
      _bfsQ[tail++] = ny;
    }
  }
  return grid;
}

/** Pick highest-valued neighbor strictly closer to the BFS target along stored grid (0x121d9..0x1226a) */
function stepBfsGrid(m, grid, stepOpts, los, iq) {
  const curVal = grid[idx(m.tx, m.ty)];
  let best = -1, bestVal = curVal;
  for (const d of [0, 2, 1, 3]) {
    if (!stepOpts.includes(d)) continue;
    if ((iq & 0x10) && los[d].bomb) continue;
    const val = grid[idx(m.tx + DIRS[d][0], m.ty + DIRS[d][1])];
    if (val > 0 && val > bestVal) {
      bestVal = val;
      best = d;
    }
  }
  return { best, bestVal };
}

const _scratchLos = Array.from({ length: 4 }, () => ({
  dist: 0, bomb: false, bombDist: 0, player: false, playerDist: 0, item: false, itemDist: 0, proj: false,
}));

/** 4-direction cardinal line-of-sight scanner (0x11983 in FRACAS.EXE) */
export function scanLoS(game, mx, my, out = null) {
  const los = out || [null, null, null, null];
  const players = game.players, projs = game.projs, nPlayers = players.length, nProjs = projs.length;
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d], opp = (d + 2) % 4;
    let info = los[d];
    if (!info) {
      info = los[d] = { dist: 0, bomb: false, bombDist: 0, player: false, playerDist: 0, item: false, itemDist: 0, proj: false };
    } else {
      info.dist = 0; info.bomb = false; info.bombDist = 0;
      info.player = false; info.playerDist = 0;
      info.item = false; info.itemDist = 0; info.proj = false;
    }
    let blockedStep = false;
    for (let k = 1; k < 22; k++) {
      const nx = mx + dx * k, ny = my + dy * k;
      if (!inside(nx, ny)) break;
      const i = idx(nx, ny);
      if (game.terrain[i] === T.WALL || game.terrain[i] === T.ROCK || game.barriers.has(i)) break;
      if (!blockedStep && (game.flames.has(i) || game.anyBombAt(nx, ny))) {
        info.bomb = true;
        info.bombDist = k;
        break;
      }
      const f = game.feat[i];
      const doorClosed = f?.k === 'door' && ((d % 2 === 1) !== f.ns || (d <= 1 && f.state === 4) || (d >= 2 && f.state === 0));
      if (doorClosed || (f?.k === 'oneway' && f.d !== d)) blockedStep = true;
      if (!blockedStep) {
        let hitPlayer = false;
        for (let pi = 0; pi < nPlayers; pi++) {
          const p = players[pi];
          if (p.alive && p.ghost <= 0 && p.cx === nx && p.cy === ny) { hitPlayer = true; break; }
        }
        if (hitPlayer) {
          info.player = true;
          info.playerDist = k;
          break; // FRACAS.EXE 0x11a25/0x11ae9/0x11bad/0x11c71: player terminates LoS ray (bombs behind player are not seen)
        }
        info.dist = k;
        if (!info.item && game.items.has(i)) {
          info.item = true;
          info.itemDist = k;
        }
        if (nProjs) {
          for (let qi = 0; qi < nProjs; qi++) {
            const pr = projs[qi];
            if (pr.d === opp && Math.floor(pr.x) === nx && Math.floor(pr.y) === ny) { info.proj = true; break; }
          }
        }
      }
    }
  }
  return los;
}

/** Evaluate 4-way LoS reflexes (bits 5..2). Returns { d: 0..3 | -1 | null, los } (-1 = hold position in dead end) */
export function decideLoS(game, m, mx = m.tx, my = m.ty, opts = null, stepOpts = null, mutate = true) {
  const iq = m.iq;
  if (stepOpts === null || opts === null) {
    const s = [];
    const t = [];
    for (let d = 0; d < 4; d++) {
      if (game.canStep(m, mx, my, d)) s.push(d);
      else if (game.canTouch(m, mx, my, d) && !m.retreatingTouch && m.lastTouchDir !== d) t.push(d);
    }
    if (stepOpts === null) stepOpts = s;
    if (opts === null) opts = [...s, ...t];
  }
  const los = scanLoS(game, mx, my, mutate ? null : _scratchLos);

  // bit5 (0x20, 0x118bd): dodge incoming projectile down longest safe corridor, or hold at dead-end wall
  if ((iq & 0x20) && los.some(x => x.proj)) {
    let best = -1, bestLen = -1;
    for (const d of PRIO_DIRS) {
      if (!stepOpts.includes(d) || los[d].proj) continue;
      if ((iq & 0x10) && los[d].bomb) continue;
      if (los[d].dist > bestLen) { bestLen = los[d].dist; best = d; }
    }
    if (best < 0) {
      for (const d of PRIO_DIRS) {
        if (!stepOpts.includes(d) || los[d].proj) continue;
        if (los[d].dist > bestLen) { bestLen = los[d].dist; best = d; }
      }
    }
    if (best >= 0) {
      if (mutate) { m.walkLeft = los[best].dist + 1; m.dir = best; }
      return { d: best, los };
    }
    if (mutate) m.walkLeft = 0;
    return { d: -1, los };
  }

  // bit4 (0x10, 0x11654): flee cauldron or flame down longest safe corridor, or hold safely in dead end
  const onBomb = !!(game.anyBombAt(mx, my) || game.flames.has(idx(mx, my)));
  if ((iq & 0x10) && (onBomb || los.some(x => x.bomb))) {
    let best = -1, bestLen = -1;
    for (const d of PRIO_DIRS) {
      if (!stepOpts.includes(d) || los[d].bomb) continue;
      if (los[d].dist > bestLen) { bestLen = los[d].dist; best = d; }
    }
    if (best >= 0) {
      if (mutate) { m.walkLeft = los[best].dist + 1; m.dir = best; }
      return { d: best, los };
    }
    if (onBomb && stepOpts.length) {
      let esc = -1, escVal = -1;
      for (const d of PRIO_DIRS) {
        if (!stepOpts.includes(d)) continue;
        const v = Math.max(los[d].dist, los[d].bombDist || 0);
        if (v > escVal) { escVal = v; esc = d; }
      }
      if (esc >= 0) {
        if (mutate) { m.walkLeft = 1; m.dir = esc; }
        return { d: esc, los };
      }
    }
    if (mutate) m.walkLeft = 0;
    return { d: -1, los };
  }

  // bit3 (0x08, 0x11707): charge closest wizard seen in cardinal line of sight
  if (iq & 0x08) {
    let best = -1, bestDist = 99;
    for (const d of PRIO_DIRS) {
      if (!opts.includes(d) || !los[d].player) continue;
      if (((iq & 0x10) && los[d].bomb) || ((iq & 0x20) && los[d].proj)) continue;
      if (los[d].playerDist < bestDist) { bestDist = los[d].playerDist; best = d; }
    }
    if (best >= 0) {
      if (mutate) { m.walkLeft = Math.max(1, los[best].dist + 1); m.dir = best; }
      return { d: best, los };
    }
  }

  // bit2 (0x04, 0x117e2): charge closest uncovered pickup seen in cardinal line of sight
  if (iq & 0x04) {
    let best = -1, bestDist = 99;
    for (const d of PRIO_DIRS) {
      if (!opts.includes(d) || !los[d].item) continue;
      if (((iq & 0x10) && los[d].bomb) || ((iq & 0x20) && los[d].proj)) continue;
      if (los[d].itemDist < bestDist) { bestDist = los[d].itemDist; best = d; }
    }
    if (best >= 0) {
      if (mutate) { m.walkLeft = Math.max(1, los[best].dist + 1); m.dir = best; }
      return { d: best, los };
    }
  }

  return { d: null, los };
}

export function decide(game, m) {
  const iq = m.iq;
  const mx = m.tx, my = m.ty;
  const stepOpts = [];
  const touchOpts = [];
  for (let d = 0; d < 4; d++) {
    if (game.canStep(m, mx, my, d)) stepOpts.push(d);
    else if (game.canTouch(m, mx, my, d) && !m.retreatingTouch && m.lastTouchDir !== d) touchOpts.push(d);
  }
  const opts = [...stepOpts, ...touchOpts];

  const { d: losDir, los } = decideLoS(game, m, mx, my, opts, stepOpts, true);
  if (losDir !== null) {
    m.aiState = 1;
    m.bfsGrid = null;
    if (losDir >= 0) m.dir = losDir;
    return losDir;
  }

  if (!opts.length) return -1;

  let state = m.aiState === 3 || m.aiState === 'hunt' ? 3 : m.aiState === 4 || m.aiState === 'scent' ? 4 : 1;
  const opp = (m.dir + 2) % 4;
  const hereIdx = idx(mx, my);

  // bit1 (0x02, 0x11874..0x118bc & 0x11eff): scent trail interrupts wander/hunt immediately when stepping on scented tile
  if (iq & 0x02) {
    const here = game.scent[hereIdx];
    if (here <= 0 && state === 4) { state = 1; m.aiState = 1; }
    if (here > 0 || (state < 2 && m.walkLeft <= 0)) {
      let best = -1, bestScent = here;
      for (const d of stepOpts) {
        if (d === opp) continue;
        if ((iq & 0x10) && los[d].bomb) continue;
        const s = game.scent[idx(mx + DIRS[d][0], my + DIRS[d][1])];
        if (s > bestScent) { bestScent = s; best = d; }
      }
      if (best < 0 && stepOpts.includes(opp) && !((iq & 0x10) && los[opp].bomb)) {
        const s = game.scent[idx(mx + DIRS[opp][0], my + DIRS[opp][1])];
        if (s > here) { bestScent = s; best = opp; }
      }
      if (best >= 0) {
        m.aiState = 4;
        m.bfsGrid = null;
        m.walkLeft = 0;
        m.dir = best;
        return best;
      }
    }
  }

  // Continue current committed walk segment when not actively BFS-hunting (0x11d13)
  if (m.walkLeft > 0 && state !== 3) {
    if (opts.includes(m.dir) && !((iq & 0x10) && los[m.dir].bomb)) {
      m.walkLeft--;
      return m.dir;
    }
    m.walkLeft = 0;
  }

  // bit0 (0x01, 0x115f7..0x11653 & 0x1217e..0x1243d): Wavefront BFS hunt
  if (iq & 0x01) {
    if (state === 3 && m.bfsGrid) {
      const { best, bestVal } = stepBfsGrid(m, m.bfsGrid, stepOpts, los, iq);
      if (best < 0) {
        m.aiState = 1;
        m.bfsGrid = null;
        m.walkLeft = 0;
        state = 1;
      } else {
        if (bestVal >= 127) { m.aiState = 1; m.bfsGrid = null; }
        m.walkLeft = 0;
        m.dir = best;
        return best;
      }
    }
    if (state < 2 && m.walkLeft <= 0 && (m.smart || game.rng.int(4) === 0)) {
      const living = game.players.filter(p => p.alive && p.ghost <= 0);
      if (living.length) {
        const target = living[game.rng.int(living.length)];
        const grid = buildBfsGrid(game, m, target.cx, target.cy);
        if (grid[hereIdx] > 0) {
          const { best, bestVal } = stepBfsGrid(m, grid, stepOpts, los, iq);
          if (best >= 0) {
            m.aiState = bestVal >= 127 ? 1 : 3;
            m.bfsGrid = bestVal >= 127 ? null : grid;
            m.walkLeft = 0;
            m.dir = best;
            return best;
          }
        }
      }
    }
  }

  // Wander (0x11de2..0x11e33): random open/touchable non-reversing direction, segment 1..7 tiles
  const noBomb = (iq & 0x10) ? opts.filter(d => !los[d].bomb) : opts;
  const safeOpts = noBomb.length ? noBomb : opts;
  const noBack = safeOpts.filter(d => d !== opp);
  const pool = noBack.length ? noBack : safeOpts;
  const d = game.rng.pick(pool);
  m.aiState = 1;
  m.bfsGrid = null;
  m.walkLeft = 1 + game.rng.int(7);
  m.dir = d;
  return d;
}
