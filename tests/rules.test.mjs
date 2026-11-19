// node tests/rules.test.mjs — checks the rules engine and every exported level
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Game as Game0, Player, Monster, PLAYER_SPEED, canExchangeLives, exchangeLife, transferLives, shareLivesWithAll, giveLifeToSlot, takeLifeFromSlot } from '../src/game/sim.js';
import { WORLD_MUSIC } from '../src/audio.js';
import { Input, evalTouch4Way, evalSwipeStep } from '../src/input.js';
import { bakeLevel, makeBoulders } from '../src/render2d/realistic.js';
import { Renderer2D, PICK_INDEX, QUALITY } from '../src/render2d/renderer2d.js';
import { ClassicMenu } from '../src/ui/classic.js';
class Game extends Game0 { constructor(l, o = {}) { super(l, { freeze: 0, ...o }); } }
import { decide, scanLoS } from '../src/game/ai.js';
import { W, H, TICK, FUSE, T, TICK_HZ, BLAST_TIME, BLAST_TIMES, SPIKE_CYCLE, PICKUP_INFO, WALKWAY_SPEED, computeSpikeState, spikeVisualState } from '../src/game/constants.js';
import { serializeGame, createClientGame, applySnapshot } from '../src/net/protocol.js';

const data = JSON.parse(readFileSync(new URL('../data/levels.json', import.meta.url)));
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };

/** small level from ASCII: the map is padded to 21x15 with walls */
function lvl(rows, extra = {}) {
  const full = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => rows[y - 1]?.[x - 1] ?? '#').join(''));
  const starts = {}, vents = [], spikes = [], doors = [];
  full.forEach((r, y) => [...r].forEach((c, x) => {
    if ('1234'.includes(c)) starts[c] = [x, y];
    if (c === 'o') vents.push([x, y, 0]);
  }));
  return { id: 1, rows: full.map(r => r.replace(/[1234o]/g, '.').replace(/J/g, '.')), starts, vents, spikes, doors,
           monsters: [], pickups: {}, barriers: 0, ...extra };
}
const run = (g, s) => { for (let t = 0; t < s; t += 1 / 60) g.update(1 / 60); };

test('every level: 4 starts, pickups fit under rocks, monsters on floor, all floor reachable', () => {
  assert.equal(data.normal.length, 100);
  for (const l of data.normal) {
    assert.deepEqual(Object.keys(l.starts).sort(), ['1', '2', '3', '4'], 'starts ' + l.id);
    const rocks = l.rows.join('').split('%').length - 1;
    const picks = Object.values(l.pickups).reduce((a, b) => a + b, 0);
    assert.ok(picks <= rocks, 'pickups ' + l.id);
    assert.ok(l.monsters.length >= 1 && l.monsters.length <= 30, 'monsters ' + l.id);
    const g = new Game(l, { players: [0] });
    // every non-wall cell reachable from start 1 when rocks are treated as breakable
    const seen = new Set([l.starts['1'].join()]), q = [l.starts['1']];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (g.terrain[ny * W + nx] === T.WALL || seen.has(nx + ',' + ny)) continue;
        seen.add(nx + ',' + ny); q.push([nx, ny]);
      }
    }
    for (const [x, y] of l.monsters) assert.ok(seen.has(x + ',' + y), `level ${l.id} monster at ${x},${y} unreachable`);
  }
  assert.ok(data.battle.length >= 10);
});

test('cauldron blast: range, stops at wall, breaks first rock only, kills monster', () => {
  const g = new Game(lvl(['1......%%.', '.#######..']), { players: [0] });
  const p = g.players[0];
  p.range = 3;
  g.placeBomb(p);
  g.monsters.push(new Monster(4, 1, 3, 0, 0)); g.monsters[0].speed = 0;
  p.input.dir = 1; run(g, 0.5); p.input.dir = -1;                   // step out of the lane
  run(g, FUSE);
  assert.equal(g.monsters[0].alive, false, 'monster at range 3 dies');
  assert.equal(g.terrain[1 * W + 8], T.ROCK, 'rock beyond range 3 stays');
});

test('chain reaction and rock break', () => {
  const g = new Game(lvl(['1.....%%', '........']), { players: [0] });
  const p = g.players[0]; p.bombsMax = 2; p.range = 2;
  g.placeBomb(p);
  p.place(4, 1); g.placeBomb(p);                                     // second bomb inside first one's lane? (distance 3)
  p.range = 2; g.bombs[1].x = g.bombs[1].cx = 3;                     // put it at distance 2 -> chained
  p.place(1, 2);
  run(g, FUSE + 0.1);
  assert.equal(g.bombs.length, 0, 'both burst together');
  assert.equal(g.terrain[1 * W + 7], T.ROCK, 'rock beyond range stays');
});

test('vents: a cauldron on one vent fires every vent', () => {
  const g = new Game(lvl(['1o.......', '#########', '........o']), { players: [0] });
  g.monsters.push(new Monster(8, 3, 3, 0, 0)); g.monsters[0].speed = 0;
  const p = g.players[0]; p.place(2, 1); p.range = 1;
  p.place(2, 1); g.placeBomb(p); g.bombs[0].x = g.bombs[0].cx = 2;
  // put the bomb on the vent
  g.bombs[0].x = g.bombs[0].cx = 2; g.bombs[0].vent = 0;
  p.place(6, 1);
  run(g, FUSE + 0.1);
  assert.equal(g.monsters[0].alive, false, 'monster next to the far vent burns');
});

test('one-way tile blocks the wrong direction', () => {
  const l = lvl(['1.>..']);
  const g = new Game(l, { players: [0] });
  assert.equal(g.canStep(g.players[0], 2, 1, 0), true);
  assert.equal(g.canStep(g.players[0], 4, 1, 2), false);
  const p = g.players[0]; p.place(4, 1); p.invuln = 0; p.range = 4; g.placeBomb(p); p.input.dir = 2; run(g, FUSE + 0.2);
  assert.equal(p.cx, 3, 'touching the arrow tile'); assert.ok(p.fx > 3.85, 'stopped at entry edge'); assert.equal(p.alive, true, 'protected from bomb');
});

test('walkway carries an idle wizard', () => {
  const g = new Game(lvl(['1RRR....']), { players: [0] });
  g.players[0].place(2, 1);
  run(g, 2.0);
  assert.ok(g.players[0].tx >= 4, 'carried to the end of the belt, got ' + g.players[0].tx);
});

test('flip door only opens one way and flips on blast', () => {
  const l = lvl(['1.....', '##.###', '......']);
  l.doors = [[3, 2, 1]];                                             // enter moving south
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  assert.equal(g.canStep(p, 3, 1, 1), true);
  assert.equal(g.canStep(p, 3, 3, 3), false);
  g.flipDoor(2 * W + 3);
  assert.equal(g.canStep(p, 3, 3, 3), true);
});

test('walking through flip door flips it and allows walking back', () => {
  const l = lvl(['1.....', '##.###', '......']);
  l.doors = [[3, 2, 1]];                                             // allows south (1)
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  p.place(3, 1);
  p.input.dir = 1; // south
  run(g, 1);
  assert.equal(p.cy, 3);
  const f = g.feat[2 * W + 3];
  assert.equal(f.allow, 3);                                          // now allows north (3)
  // walk back north
  p.input.dir = 3;
  run(g, 1);
  assert.equal(p.cy, 1);
  assert.equal(f.allow, 1);                                          // flipped back to south
});

test('projectiles flip doors and pass through if fired in allowed direction', () => {
  const l = lvl(['1......', '##.####', '.......']);
  l.doors = [[3, 2, 1]];                                             // allows south (1)
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  p.place(3, 1);
  g.fire(p, 1, 'fire', 8);
  let reachedSouth = false;
  for (let t = 0; t < 60; t++) {
    g.update(1 / 60);
    if (g.projs.some(pr => pr.y > 3)) reachedSouth = true;
  }
  assert.ok(reachedSouth, 'fireball penetrated through door');
  const f = g.feat[2 * W + 3];
  assert.equal(f.allow, 3, 'door flipped to allow north');
});

test('bombs on door tiles or all explosion kinds flip doors', () => {
  for (const kind of ['fire', 'electric', 'magic']) {
    const l = lvl(['1.....', '##.###', '......']);
    l.doors = [[3, 2, 1]];
    const g = new Game(l, { players: [0] });
    const p = g.players[0];
    p.place(3, 2);                                                   // directly on door
    const placed = g.placeBomb(p, kind);
    assert.ok(placed, 'can place bomb on door tile');
    run(g, 5);
    const f = g.feat[2 * W + 3];
    assert.equal(f.allow, 3, kind + ' flipped door');
  }
});

test('every flip-door shape can be passed one way in both gap directions, and every level door is passable', () => {
  for (let o = 0; o < 4; o++) {
    const ns = lvl(['1.....', '##.###', '......']); ns.doors = [[3, 2, o]];
    const g = new Game(ns, { players: [0] }), p = g.players[0];
    const down = g.canStep(p, 3, 1, 1), up = g.canStep(p, 3, 3, 3);
    assert.equal(down, true, `N-S gap, shape ${o}: unflipped allows south`); assert.equal(up, false);
    const ew = lvl(['1#....', '......', '.#....']); ew.doors = [[2, 2, o]];
    const g2 = new Game(ew, { players: [0] });
    const east = g2.canStep(p, 1, 2, 0), west = g2.canStep(p, 3, 2, 2);
    assert.equal(east, true, `E-W gap, shape ${o}: unflipped allows east`); assert.equal(west, false);
    g2.flipDoor(2 * W + 2);
    assert.equal(g2.canStep(p, 3, 2, 2), true, `E-W gap, shape ${o}: flipped allows west`);
  }
  for (const l of data.normal) {
    const g = new Game(l, { players: [0] });
    for (const [x, y] of l.doors) {
      const f = g.feat[y * W + x];
      const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][f.allow];
      assert.ok(!g.solid(x - dx, y - dy) && !g.solid(x + dx, y + dy), `level ${l.id} door ${x},${y} leads into a wall`);
    }
  }
});

test('holding bomb button while moving places a new bomb on each tile entered', () => {
  const g = new Game(lvl(['1........']), { players: [0] });
  const p = g.players[0]; p.bombsMax = 3;
  p.input.dir = 0; p.input.bomb = true; p.input.bombHeld = true;
  run(g, 1.0);
  assert.equal(g.bombs.length, 3, 'placed 3 bombs in a line while holding bomb button');
  assert.deepEqual(g.bombs.map(b => b.x), [1, 2, 3]);
});

test('no monster type can walk through a cauldron', () => {
  for (let type = 2; type <= 20; type++) {
    const g = new Game(lvl(['1.....']), { players: [0] });
    const m = new Monster(5, 1, type, 0, 2); g.monsters.push(m);
    g.bombs.push({ id: 1, x: 4, y: 1, cx: 4, cy: 1, owner: 0, range: 1, fuse: 9, vent: -1 });
    assert.equal(g.canStep(m, 5, 1, 2), false, 'type ' + type);
  }
});

test('cauldrons block both monsters and players from stepping onto them from outside', () => {
  const l = lvl(['1......']);
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  const m = new Monster(5, 1, 2, 0, 2); g.monsters.push(m);
  g.bombs.push({ id: 1, x: 3, y: 1, cx: 3, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1 });
  assert.equal(g.canStep(m, 4, 1, 2), false, 'monster blocked by bomb');
  assert.equal(g.canStep(p, 4, 1, 2), false, 'player blocked by bomb from adjacent tile');
  p.place(4, 1);
  p.input.dir = 2; // West
  run(g, 1);
  assert.equal(p.cx, 4, 'player stopped at bomb: ' + p.cx);
});

test('player can place a bomb, step slightly into next tile, place another bomb, and step back smoothly', () => {
  const g = new Game(lvl(['1....', '.....', '.....', '.....', '.....']), { players: [0] });
  const p = g.players[0];
  p.place(3, 3);
  p.bombsMax = 2;

  // 1. Place first bomb
  assert.ok(g.placeBomb(p));
  assert.equal(p.cast, 0, 'no hand-raising cast pose when placing a bomb');
  assert.equal(g.bombs.length, 1);
  assert.equal(g.bombs[0].y, 3);

  // 2. Step north just into next tile
  p.input.dir = 3; // North
  for (let i = 0; i < 20; i++) {
    g.update(1 / 60);
    if (p.cy === 2) break;
  }
  assert.equal(p.cy, 2);

  // 3. Place second bomb
  assert.ok(g.placeBomb(p));
  assert.equal(g.bombs.length, 2);
  assert.equal(g.bombs[1].y, 2);

  // 4. Reverse south towards first bomb
  p.input.dir = 1; // South
  const startFy = p.fy;
  for (let i = 0; i < 15; i++) {
    g.update(1 / 60);
    assert.ok(p.moving, 'player keeps moving south, not stuck');
  }
  assert.ok(p.fy > startFy + 0.5, 'player successfully walked back south: fy=' + p.fy);
});

test('a killed wizard comes back where he fell, protected', () => {
  const g = new Game(lvl(['1........']), { players: [0] });
  const p = g.players[0]; g.demo = true;
  p.place(6, 1); p.invuln = 0; g.hurtPlayer(p, 'monster');
  assert.equal(p.alive, false);
  run(g, 5);
  assert.ok(p.alive && p.cx === 6 && p.cy === 1 && p.invuln > 0, 'respawned at 6,1: ' + p.cx + ',' + p.cy);
  assert.equal(p.lives, 2);
});

test('each level starts at 1 cauldron / range 1; pickups raise them to at most 5', () => {
  const l = lvl(['1........']);
  const g = new Game(l, { players: [0], carry: { 0: { bombsMax: 4, range: 5, lives: 2 } } });
  const p = g.players[0];
  assert.equal(p.bombsMax, 1); assert.equal(p.range, 1); assert.equal(p.lives, 2);
  for (let k = 0; k < 9; k++) { g.applyPickup(p, 'greenGem'); g.applyPickup(p, 'purpleGem'); }
  assert.equal(p.bombsMax, 5); assert.equal(p.range, 5);
  const q = new Game(l, { players: [0] }).players[0]; g.applyPickup(q, 'max');
  assert.equal(q.bombsMax, 5); assert.equal(q.range, 5);
});

test('spikes are deadly only when out', () => {
  const l = lvl(['1....']); l.spikes = [[3, 1, 1, 0]];
  const g = new Game(l, { players: [0] });
  const p = g.players[0]; p.invuln = 0; p.place(3, 1);
  g.time = 1.5; g.updateSpikes(); g.updatePlayer(p, 1 / 60);
  assert.equal(p.alive, true);
  g.time = 4.2; g.updateSpikes(); g.updatePlayer(p, 1 / 60);
  assert.equal(p.alive, false);
});

test('pickups: hidden under rocks, revealed by blast, applied on touch', () => {
  const l = lvl(['1..%.']); l.pickups = { greenGem: 1 };
  const g = new Game(l, { players: [0] });
  assert.equal(g.hidden.size, 1);
  g.breakRock(1 * W + 4);
  assert.equal(g.items.size, 1);
  const p = g.players[0]; p.place(4, 1); g.updatePlayer(p, 1 / 60);
  assert.equal(p.bombsMax, 2);
});

test('glass fire jar kills, electric jar stuns and marks electrocution, no hand-raising', () => {
  const g = new Game(lvl(['1........']), { players: [0] });
  const p = g.players[0]; p.dir = 0;
  const a = new Monster(6, 1, 9, 0, 0); a.speed = 0; g.monsters.push(a);
  p.power = 'glassElectric'; p.powerTime = 40; g.usePower(p); run(g, 1);
  assert.equal(p.cast, 0, 'no hand-raising when casting electric');
  assert.ok(a.alive && a.zapped > 0 && a.stun > 0, 'stunned + electrocuted');
  p.power = 'glassFire'; p.cooldown = 0; g.usePower(p); run(g, 1);
  assert.equal(p.cast, 0, 'no hand-raising when casting fire');
  assert.equal(a.alive, false);
});

test('fireball projectile passes through cauldrons; explosion rays stop at chain-reacted cauldrons', () => {
  // 1. Fireball projectile passes through cauldron and kills monster behind it
  const g1 = new Game(lvl(['1........']), { players: [0] });
  const p1 = g1.players[0];
  p1.place(1, 1);
  g1.bombs.push({ id: 88, x: 3, y: 1, cx: 3, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1 });
  const m1 = new Monster(5, 1, 2, 0, 0); m1.speed = 0;
  g1.monsters.push(m1);
  g1.fire(p1, 0, 'fire', 10);
  run(g1, 0.8);
  assert.equal(m1.alive, false, 'fireball passed through cauldron at (3, 1) to hit monster at (5, 1)');

  // 2. Cauldron explosion fire passes through cauldron to full range
  const g2 = new Game(lvl(['1........']), { players: [0] });
  const p2 = g2.players[0];
  p2.place(1, 1);
  p2.range = 4;
  g2.placeBomb(p2); // Bomb 1 at (1, 1), range 4
  g2.bombs.push({ id: 89, x: 2, y: 1, cx: 2, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1 });
  g2.bombs[0].fuse = 0;
  g2.update(1 / 60);
  assert.ok(g2.flames.has(1 * W + 3), 'chain-reacted bomb at (2, 1) with range 1 reaches (3, 1)');
  assert.equal(g2.flames.has(1 * W + 5), false, 'first bomb ray stopped at (2, 1) rather than passing through to (5, 1)');
});

test('AI bit0 hunts, bit4 avoids blast lanes', () => {
  const g = new Game(lvl(['1........', '.........']), { players: [0] });
  g.players[0].invuln = 0; g.roundTime = 10;                         // past the opening wander
  const m = new Monster(8, 1, 3, 6, 0); m.smart = true; g.monsters.push(m);           // Pathfinder 0x11 (hunt + cauldron)
  const mLos = new Monster(8, 1, 3, 1, 0); assert.equal(decide(g, mLos), 2, 'bit3 charges west toward wizard in LoS');
  assert.equal(decide(g, m), 2, 'moves west toward the wizard');
  g.bombs.push({ id: 99, x: 7, y: 1, cx: 7, cy: 1, owner: 0, range: 3, fuse: 0.5, vent: -1 });
  const d = decide(g, m);
  assert.notEqual(d, 2, 'does not step into the lane');
});

test('electric barriers only spawn between brick walls (never boulders) and emit barrierTouch sound on player contact', () => {
  const l = lvl(['1...%#', '....%#', '....%#'], { barriers: 2 });
  const g = new Game(l, { players: [0] });
  run(g, 30);
  for (const [i] of g.barriers) {
    const x = i % W, y = (i / W) | 0;
    const ew = g.terrain[(y - 1) * W + x] === T.WALL && g.terrain[(y + 1) * W + x] === T.WALL;
    const ns = g.terrain[y * W + (x - 1)] === T.WALL && g.terrain[y * W + (x + 1)] === T.WALL;
    assert.ok(ew || ns, `barrier at ${x},${y} must be between two T.WALL tiles`);
  }
  g.barriers.set(1 * W + 2, 3);
  g.drainEvents();
  const p = g.players[0]; p.place(1, 1); p.input.dir = 0;
  for (let k = 0; k < 20; k++) g.update(1 / 60);
  assert.ok(p.x > 1.9 && p.x < 2.0, 'wizard walks up to touch electric barrier without entering it');
  assert.ok(g.drainEvents().some(e => e.t === 'barrierTouch'), 'touching electric barrier emits barrierTouch sound');

  // Conveyor-carried cauldrons slide through electric barriers (0xe8e9) & barriers expire after 96 ticks
  const lSlide = lvl(['..#.....', '1RRRR.#.', '..#.....'], { barriers: 0, monsters: [[8, 2, 0, 0]] });
  const gSlide = new Game(lSlide, { players: [0] });
  gSlide.barriers.set(2 * W + 3, 96 / TICK_HZ);
  gSlide.bombs.push({ id: 901, x: 2, y: 2, cx: 2, cy: 2, owner: 0, range: 2, fuse: 5, age: 0, vent: -1, slide: { d: 0, n: 1, speed: 6, wind: false }, sp: 0 });
  run(gSlide, 0.8);
  assert.ok(gSlide.bombs[0].x >= 4, 'sliding cauldron passes across electric barrier (0xe8e9)');
  run(gSlide, 96 / TICK_HZ);
  assert.equal(gSlide.barriers.size, 0, 'electric barrier expires after 96 ticks');
});

test('player can walk over a bomb placed on a moving bridge (walkway) or in air (wind zone)', () => {
  const g1 = new Game(lvl(['1RRRR...']), { players: [0] });
  const p1 = g1.players[0]; p1.place(2, 1);
  g1.bombs.push({ id: 91, x: 3, y: 1, cx: 3, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1, slide: null, sp: 0 });
  assert.equal(g1.canStep(p1, 2, 1, 0), true, 'can step onto bomb on moving bridge');

  const g2 = new Game(lvl(['1.......']), { players: [0] });
  const p2 = g2.players[0]; p2.place(1, 1); p2.dir = 0;
  g2.applyPickup(p2, 'glassWind'); g2.usePower(p2);
  g2.bombs.push({ id: 92, x: 2, y: 1, cx: 2, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1, slide: null, sp: 0 });
  assert.equal(g2.canStep(p2, 1, 1, 0), true, 'can step onto bomb in air (wind zone)');
});

test('normal mode: killing all monsters opens the portal, entering wins', () => {
  const g = new Game(lvl(['1....']), { players: [0] });
  g.monsters.push(new Monster(5, 1, 3, 0, 0)); g.monsters[0].alive = false;
  g.update(1 / 60);
  assert.equal(g.state, 'clear');
  g.players[0].place(g.portal.x, g.portal.y); g.update(1 / 60);
  assert.equal(g.state, 'won');
});

test('battle mode: last wizard standing wins the round', () => {
  const g = new Game(data.battle[0], { mode: 'battle', players: [0, 1] });
  g.players[1].invuln = 0; g.hurtPlayer(g.players[1], 'test', 0); g.update(1 / 60);
  assert.equal(g.state, 'roundOver');
  assert.equal(g.players[0].wins, 1);
});

test('full levels simulate 20 s without errors', () => {
  for (const l of [...data.normal, ...data.battle.slice(0, 5)]) {
    const g = new Game(l, { players: [0, 1, 2, 3], mode: l.world === 'Battle' ? 'battle' : 'normal' });
    for (const p of g.players) p.input.dir = (p.slot + l.id) % 4;
    for (let t = 0; t < 20 * 60; t++) { if (t % 90 === 0) for (const p of g.players) p.input.bomb = true; g.update(1 / 60); }
  }
});

test('wizards move freely and stop the moment the key is released (original feel)', () => {
  const g = new Game(lvl(['1........', '.........']), { players: [0] });
  const p = g.players[0];
  p.input.dir = 0; for (let k = 0; k < 6; k++) g.update(1 / 60); p.input.dir = -1;
  const x = p.x; run(g, 0.3);
  assert.ok(Math.abs(x - (1.5 + 0.375)) < 0.03, 'moved 3.75 tiles/s, at ' + x);
  assert.equal(p.x, x, 'stops on release, mid-tile');
});

test('turning: keeps going until lined up with the grid, then turns', () => {
  const g = new Game(lvl(['1........', '.........']), { players: [0] });
  const p = g.players[0];
  p.input.dir = 0; run(g, 0.3);               // now between tiles, moving east
  const x0 = p.x; p.input.dir = 1; run(g, 0.5); p.input.dir = -1;
  assert.ok(Math.abs(p.x - (Math.floor(x0) + 1.5)) < 1e-6, 'lined up on the next column, x=' + p.x);
  assert.ok(p.y > 1.5, 'then went south, y=' + p.y);
});

test('blocked turn: moving down and pressing left beside a wall keeps going down, turns when open', () => {
  const g = new Game(lvl(['#1#', '#.#', '#.#', '#.#', '...']), { players: [0] });
  const p = g.players[0]; g.demo = true;          // no monsters here: skip the level-end check
  p.input.dir = 1; run(g, 0.3);
  const y0 = p.y;
  p.input.dir = 2; run(g, 0.3);                // only LEFT held now, wall on the left
  assert.ok(p.y > y0 + 0.5, 'kept moving down, y ' + y0 + ' -> ' + p.y);
  assert.equal(p.dir, 1, 'still faces down');
  run(g, 1.5);
  assert.ok(Math.abs(p.y - 5.5) < 1e-6 && p.x < 2.0, 'turned left at the opening: ' + p.x + ',' + p.y);
  // same going up
  const g2 = new Game(lvl(['...', '#.#', '#.#', '#.#', '#1#']), { players: [0] });
  const q = g2.players[0]; g2.demo = true;
  q.input.dir = 3; run(g2, 0.3); q.input.dir = 0; run(g2, 2);
  assert.ok(Math.abs(q.y - 1.5) < 1e-6 && q.x > 2.5, 'went up, then right at the top: ' + q.x + ',' + q.y);
});

test('passwords cover levels 1..96 every 5', () => {
  const v = Object.values(data.passwords).sort((a, b) => a - b);
  assert.deepEqual(v, Array.from({ length: 20 }, (_, i) => 1 + 5 * i));
});

test('original fidelity: vents erupt all variants at range 1, one-way blocks blasts/projectiles, Spark immune to electricity, electrocuted monster stuns player on touch', () => {
  // 1. Vents erupt across all variant codes (0..3) with range 1
  const lv = lvl(['1o.......', '#########', '........o']);
  lv.vents = [[2, 1, 0], [9, 3, 2]];
  const gv = new Game(lv, { players: [0] });
  const pv = gv.players[0]; pv.place(2, 1); pv.range = 4;
  gv.placeBomb(pv); pv.place(7, 1);
  run(gv, FUSE + 0.1);
  assert.ok(gv.flames.has(3 * W + 8), 'far vent with different sprite code (2) erupted');
  assert.equal(gv.flames.has(1 * W + 4), false, 'bomb on vent erupts at range 1, not player range 4');

  // 2. One-way arrows block wrong-way blasts and projectiles
  const gw = new Game(lvl(['1.<...']), { players: [0] });
  const pw = gw.players[0]; pw.place(2, 1); pw.range = 3;
  gw.placeBomb(pw); pw.place(1, 1);
  run(gw, FUSE + 0.1);
  assert.equal(gw.flames.has(1 * W + 3), false, 'eastward blast blocked by westward one-way arrow at (3, 1)');
  gw.fire(pw, 0, 'fire', 10);
  run(gw, 0.8);
  assert.equal(gw.projs.length, 0, 'eastward projectile stopped by westward one-way arrow');

  // 3. Spark (type 8) immune to electricity; touching an electrocuted monster stuns player; radiation does not kill monsters
  const ge = new Game(lvl(['1........']), { players: [0] });
  const pe = ge.players[0]; pe.invuln = 0;
  const spark = new Monster(4, 1, 8, 0, 0);
  const m = new Monster(2, 1, 3, 0, 0); m.speed = 0;
  ge.monsters.push(spark, m);
  ge.electrocute(spark);
  assert.equal(spark.stun, 0, 'Spark (type 8) is immune to electricity');
  ge.electrocute(m);
  assert.ok(m.zapped > 0, 'normal monster electrocuted');
  pe.place(2, 1);
  ge.checkContacts();
  assert.ok(pe.stun > 0 && pe.alive, 'touching electrocuted monster stuns player without killing');
  pe.stun = 0; pe.radiation = 5; m.zapped = 0; m.stun = 0;
  ge.checkContacts();
  assert.ok(m.alive && pe.alive, 'radiation shield protects player without killing monster on contact');
});

test('flip doors: monsters can enter open side, real-time push rotation, and closed gate shielding from blasts', () => {
  const l = lvl(['1.....', '##.###', '......']);
  l.doors = [[3, 2, 1]]; // allows south (1)
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  const mon = new Monster(3, 1, 0, 0, 0);

  // 1. Monster can enter flip door in allowed direction, blocked in reverse (0x0c48d)
  assert.equal(g.canStep(mon, 3, 1, 1), true, 'monster can enter open flip door in allowed direction');
  assert.equal(g.canStep(mon, 3, 3, 3), false, 'monster cannot step into door in blocked direction');
  assert.equal(g.canStep(p, 3, 1, 1), true, 'player can step into door');

  // 2. Real-time door rotation frame directly driven by player coordinate
  const df = g.feat[2 * W + 3];
  assert.equal(df.state, 0, 'initial door state is 0');
  p.fx = 3.5; p.fy = 2.5; p.input.dir = 1;
  g.movePlayer(p, 0.001);
  assert.equal(df.state, 2, 'halfway through door, state is 2 (45 deg open)');

  // 3. Touching closed gate from opposite direction stops at gate threshold without crossing into door
  g.flipDoor(2 * W + 3, 0, true);
  p.place(3, 3);
  p.input.dir = 3; // press north against closed door
  for (let i = 0; i < 15; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cy, 3, 'player remains in cell (3, 3)');
  assert.equal(p.fy, 3.02, 'player touches closed gate threshold at 3.02');

  // Reversing away smoothly returns to center and walks south
  p.input.dir = 1;
  for (let i = 0; i < 15; i++) g.movePlayer(p, 1 / 60);
  assert.ok(p.fy >= 3.5, 'player walks back away from closed gate');
  p.place(3, 3);
  p.input.dir = 3;
  for (let i = 0; i < 15; i++) g.movePlayer(p, 1 / 60);

  // 4. Bomb blast on the other side of the closed door is stopped by the door and does not hurt player
  p.input.dir = -1;
  p.invuln = 0;
  g.bombs.push({ id: 999, x: 3, y: 1, cx: 3, cy: 1, owner: 1, range: 5, fuse: 0.01, age: 0, kind: 'fire', vent: -1 });
  for (let t = 0; t < 10; t++) g.update(1 / 60);
  assert.ok(p.alive, 'player touching closed door is protected from blast on the other side');
});

test('monsters pass through open L-shaped flip gates and flip them on exit while blocked on closed side (FRACAS.EXE 0x0c48d)', () => {
  const l = lvl(['##.###', '##.###', '##.###', '##1###']);
  l.doors = [[3, 2, 1]]; // allows south (1)
  const g = new Game(l, { players: [0] });
  g.freeze = 0;
  const mon = new Monster(3, 1, 3, 2, 2); // beh=2 sees player South down corridor (3,1)->(3,4)
  g.monsters = [mon];
  const df = g.feat[2 * W + 3];
  assert.equal(g.canStep(mon, 3, 1, 1), true, 'monster can enter open door in allowed direction');
  assert.equal(g.canStep(mon, 3, 3, 3), false, 'monster cannot enter door in closed direction');
  for (let t = 0; t < 45 && mon.cy < 3; t++) g.update(1 / 31);
  assert.ok(mon.cy >= 3, 'monster walked south through the open flip door');
  assert.equal(df.flipped, true, 'monster flipped door shut behind itself upon exit');
  assert.equal(df.allow, 3, 'door now allows north (3) and blocks south (1)');
  assert.equal(g.canStep(mon, 3, 1, 1), false, 'door now blocks monster approaching south');
});

test('pickup locations are randomized across rocks when different seeds are provided', () => {
  const l = lvl(['1..%%%%%%%..']);
  l.pickups = { greenGem: 2, purpleGem: 2, foot: 1, heart: 1 };
  const g1 = new Game(l, { seed: 1001 });
  const g2 = new Game(l, { seed: 2002 });
  const map1 = [...g1.hidden.entries()].sort((a, b) => a[0] - b[0]);
  const map2 = [...g2.hidden.entries()].sort((a, b) => a[0] - b[0]);
  assert.notDeepEqual(map1, map2, 'different seeds place pickups under different rocks');
});

test('air supply vents: cauldron placement sets range 1 and detonation fires all vents on map', () => {
  const l = lvl([
    '1..o....o..',
    '...........',
  ]);
  const g = new Game(l, { players: [0] });
  const p = g.players[0];

  // In lvl(), rows start at x=1, y=1; so vents are at (4, 1) and (9, 1)
  assert.equal(g.vents.length, 2, 'two vents created');
  const [v1, v2] = g.vents;

  // 1. Placing bomb on vent sets range to 1 and flags vent marker
  p.place(v1[0], v1[1]);
  p.range = 5;
  const placed = g.placeBomb(p);
  assert.ok(placed, 'placed cauldron on vent');
  const b = g.bombs[0];
  assert.equal(b.range, 1, 'cauldron on vent has blast range 1');
  assert.ok(b.vent >= 0, 'cauldron is flagged as placed on a vent');

  // 2. Detonation triggers all vents on the map simultaneously
  g.drainEvents();
  b.fuse = 0.001;
  g.update(0.01);
  const evs = g.drainEvents();
  assert.ok(evs.some(e => e.t === 'vents'), 'vents event emitted on vent cauldron explosion');

  // Both vent locations have active flames
  assert.ok(g.flames.has(v1[1] * W + v1[0]), 'primary vent erupted');
  assert.ok(g.flames.has(v2[1] * W + v2[0]), 'secondary vent erupted simultaneously');
});

test('one-way arrows: allowed direction moves through, reverse is blocked, and cannot run on adjacent walls', () => {
  // Arrow pointing UP (3) at (2, 2). Left (1, 2) and right (3, 2) are walls.
  const l = lvl([
    '1.#..',
    '..#..',
    '#...#',
    '..#..',
  ]);
  // Place one-way arrow pointing UP (3) at (3, 3) (lvl offset +1)
  l.oneways = [[3, 3, 3]];
  const g = new Game(l, { players: [0] });
  g.feat[3 * W + 3] = { k: 'oneway', d: 3 };
  const p = g.players[0];

  // 1. Wizard approaches arrow from south (3, 4) going UP (3): passes through into arrow cell
  p.place(3, 4);
  p.input.dir = 3;
  for (let i = 0; i < 20; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 3, 'player is on column 3');
  assert.ok(p.cy <= 3, 'player passed into arrow cell (3, 3)');

  // 2. While on arrow, reversing to DOWN (1) is blocked by the arrow
  p.place(3, 3);
  p.input.dir = 1; // try to go down
  for (let i = 0; i < 20; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cy, 3, 'player on arrow cannot move against arrow');

  // 3. While on arrow, pressing LEFT (2) or RIGHT (0) into walls does NOT walk on walls
  p.input.dir = 2; // try to go left into wall
  for (let i = 0; i < 20; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 3, 'player cannot walk left into wall');
  assert.equal(p.fx, 3.5, 'player remains centered on corridor');

  p.input.dir = 0; // try to go right into wall
  for (let i = 0; i < 20; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 3, 'player cannot walk right into wall');
  assert.equal(p.fx, 3.5, 'player remains centered on corridor');
});

test('original FRACAS.EXE scoring (+4 bomb, +50 monster, +25 player, no clear bonus), walkway cauldron stopping, and backward casting', () => {
  // 1. Scoring: +4 cauldron burst, +50 monster kill, no artificial level-clear bonus
  const g = new Game(lvl(['1........']), { players: [0] });
  const p = g.players[0]; p.range = 3;
  const m = new Monster(3, 1, 3, 0, 0); m.speed = 0; g.monsters.push(m);
  g.placeBomb(p);
  p.place(8, 1);
  run(g, FUSE + 0.1);
  assert.equal(m.alive, false);
  assert.equal(p.score, 54, '+4 for cauldron + 50 for monster');
  g.update(1 / 60);
  assert.equal(g.state, 'clear');
  p.place(g.portal.x, g.portal.y);
  g.update(1 / 60);
  assert.equal(g.state, 'won');
  assert.equal(p.score, 54, 'no fake 1000+timeBonus added on level clear');

  // 2. Cauldron on walkway slides along belt and stops on the last walkway tile (0xf139..0xf336)
  const gw = new Game(lvl(['1RRR....']), { players: [0] });
  const pw = gw.players[0]; pw.place(2, 1);
  gw.placeBomb(pw); pw.place(1, 1);
  run(gw, 2.0);
  assert.equal(gw.bombs[0].x, 4, 'cauldron stopped on the last walkway tile (4, 1) instead of sliding onto normal floor');

  // 3. Holding bomb while pressing spell fires glass bolt backwards without dropping a cauldron (0xd22b, 0x101c5)
  const gb = new Game(lvl(['....1....']), { players: [0] });
  const pb = gb.players[0]; pb.dir = 0; // facing east
  gb.applyPickup(pb, 'glassFire');
  pb.input.bombHeld = true; pb.input.power = true;
  gb.updatePlayer(pb, 1 / 60);
  assert.equal(gb.bombs.length, 0, 'holding bomb + pressing spell did not drop a cauldron');
  assert.equal(gb.projs.length, 1, 'fired 1 fireball');
  assert.equal(gb.projs[0].d, 2, 'fireball fired west (backwards)');
});

test('L-shaped gate (0xc48d..0xc4ff): mid-gate reversal before and after center smoothly backs out and restores gate state', () => {
  const l = lvl(['#####', '1....', '#####']);
  l.doors = [[3, 2, 0]]; // horizontal door at (3, 2), state 0 allows East (0)
  const g = new Game(l, { players: [0] });
  const p = g.players[0];
  const df = g.feat[2 * W + 3];

  // 1. Step slightly into door from West (before center, fx ~ 3.2) and reverse West
  p.place(2, 2);
  p.input.dir = 0; // East
  for (let i = 0; i < 15; i++) {
    g.movePlayer(p, 1 / 60);
    if (p.fx > 3.15) break;
  }
  assert.equal(p.cx, 3, 'entered door cell');
  assert.ok(p.fx < 3.4, 'before center of door');
  const fxBeforeRev = p.fx;
  p.input.dir = 2; // Reverse West
  g.movePlayer(p, 1 / 60);
  assert.ok(p.fx < fxBeforeRev, 'immediately moves West without snapping forward to 3.5');
  for (let i = 0; i < 15; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 2, 'backed out to West cell (2, 2)');
  assert.equal(df.state, 0, 'door state restored to 0');
  assert.equal(df.allow, 0, 'door still allows East');

  // 2. Step past center of door (fx ~ 3.75, state 3..4) and reverse West back to (2, 2)
  p.place(2, 2);
  p.input.dir = 0; // East
  for (let i = 0; i < 20; i++) {
    g.movePlayer(p, 1 / 60);
    if (p.fx > 3.7) break;
  }
  assert.equal(p.cx, 3, 'still in door cell past center');
  assert.ok(df.state >= 3, 'door pushed open to state >= 3');
  p.input.dir = 2; // Reverse West
  for (let i = 0; i < 25; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 2, 'smoothly backed all the way out to (2, 2)');
  assert.equal(df.state, 0, 'door swung back to state 0');
  assert.equal(df.allow, 0, 'door still allows East');

  // 3. Walk all the way through to (4, 2), then step partway back West (fx ~ 3.3) and reverse East to (4, 2)
  p.input.dir = 0;
  for (let i = 0; i < 30; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 4, 'exited door to East cell (4, 2)');
  assert.equal(df.state, 4, 'door locked at state 4');
  assert.equal(df.allow, 2, 'door now allows West');

  p.input.dir = 2; // West into door
  for (let i = 0; i < 20; i++) {
    g.movePlayer(p, 1 / 60);
    if (p.fx < 3.35) break;
  }
  assert.equal(p.cx, 3, 'inside door moving West');
  p.input.dir = 0; // Reverse East back to (4, 2)
  for (let i = 0; i < 25; i++) g.movePlayer(p, 1 / 60);
  assert.equal(p.cx, 4, 'backed out to East cell (4, 2)');
  assert.equal(df.state, 4, 'door restored to state 4');
  assert.equal(df.allow, 2, 'door still allows West');
});

test('electric barriers (0xc577..0xc5ff): monsters cannot enter or pass through electric barriers even if spawned mid-step', () => {
  const l = lvl(['#####', '1....', '#####'], { monsters: [[1, 2, 0, 7]] });
  const g = new Game(l, { players: [0], freeze: 0 });
  const p = g.players[0]; p.place(4, 2);
  const m = g.monsters[0]; m.place(1, 2);

  // 1. Stationary monster blocked by barrier at (2, 2)
  g.barriers.set(2 * W + 2, 3.0);
  assert.equal(g.canStep(m, 1, 2, 0), false, 'monster cannot step East into electric barrier');
  for (let i = 0; i < 30; i++) g.updateMonster(m, 1 / 60);
  assert.equal(m.tx, 1, 'monster remains at (1, 2) behind barrier');

  // 2. Monster starts stepping East into (2, 2), then barrier appears at (2, 2) mid-step
  g.barriers.clear();
  g.updateMonster(m, 1 / 60); // starts moving East toward (2, 2)
  assert.equal(m.moving, true, 'monster started stepping East');
  assert.equal(m.nx, 2, 'target tile is (2, 2)');
  g.barriers.set(2 * W + 2, 3.0); // barrier spawns on target tile mid-step
  for (let i = 0; i < 30; i++) g.updateMonster(m, 1 / 60);
  assert.equal(m.tx, 1, 'monster immediately reversed back to (1, 2) and never passed through barrier');
  assert.ok(m.x < 2.0, 'monster never entered barrier cell');
});

test('FRACAS.EXE parity: conveyor corners/blocked keys/monsters, wind accel, proj 8-cap & 20t immunity, flame bomb block, spikes, speed boots & battle mode', () => {
  // 1. Conveyor corner ring surrounded by open floor keeps passive wizard strictly on the belt track
  const gRing = new Game(lvl([
    '1..........',
    '.RRRRRD....',
    '.U....D....',
    '.ULLLLL....',
    '...........',
  ]), { players: [0] });
  const pRing = gRing.players[0]; pRing.place(2, 2);
  for (let t = 0; t < 10; t += 1 / 60) {
    gRing.update(1 / 60);
    assert.equal(gRing.feat[pRing.cy * W + pRing.cx]?.k, 'walk', `wizard flung off belt at (${pRing.fx.toFixed(2)}, ${pRing.fy.toFixed(2)})`);
  }

  // 2. Holding blocked perpendicular key against a wall on a conveyor still carries along belt and exits at opening
  const gSlide = new Game(lvl([
    '1D.',
    '#D.',
    '#D.',
    '...',
  ]), { players: [0] });
  const pSlide = gSlide.players[0]; pSlide.place(2, 2); pSlide.input.dir = 2; // West into # walls at y=2,3 then open at y=4
  run(gSlide, 2.0);
  assert.ok(pSlide.cy >= 4 && pSlide.cx <= 1, `expected conveyor carry down to row 4 opening, got (${pSlide.cx},${pSlide.cy})`);

  // 3. Monsters ignore permanent conveyor belts (0x0c0c7: +0x01 == 0xff skips 0xc500)
  const gMon = new Game(lvl(['1RRRR...']), { players: [0] });
  const mon = new Monster(2, 1, 3, 0, 0); mon.speed = 0; gMon.monsters.push(mon);
  run(gMon, 2.0);
  assert.equal(mon.tx, 2, 'stationary monster ignores permanent conveyor belt and stays at 2');
  const mWalk = new Monster(5, 1, 3, 0, 1.875); mWalk.dir = 2;
  gMon.monsters.push(mWalk);
  for (let i = 0; i < 31; i++) {
    mWalk.dir = 2;
    if (!mWalk.moving) gMon.stepMover(mWalk, 1 / 31, () => 2);
    else gMon.stepMover(mWalk, 1 / 31, () => 2);
  }
  assert.equal(mWalk.cx, 3, 'monster walks against permanent R conveyor at normal speed without drag');

  // 4. Wind zones accelerate projectiles linearly rather than instant 90deg snap; conveyor belts do not bend bolts (0xff88)
  const gWind = new Game(lvl(['1RRRR...', '........', '........']), { players: [0] });
  const pWind = gWind.players[0]; pWind.dir = 0; pWind.place(1, 2);
  gWind.fire(pWind, 1, 'fire', 10); // South over conveyors? Wait put belt on (1,2) -> North/East test:
  pWind.place(1, 1);
  gWind.fire(pWind, 0, 'fire', 10, 2.5, 1.5); // firing East across RRRR conveyors (x=2..5, y=1)
  run(gWind, 0.3);
  assert.equal(gWind.projs[0]?.vy, 0, 'walk conveyor does not affect projectile velocity');
  const gWind2 = new Game(lvl(['1........', '.........', '.........']), { players: [0] });
  const pw2 = gWind2.players[0]; pw2.dir = 1; pw2.place(3, 1);
  gWind2.applyPickup(pw2, 'glassWind'); gWind2.usePower(pw2); // South wind below (3,1) at (3,2..7)
  gWind2.fire(pw2, 0, 'fire', 20, 2.8, 2.5); // shooting East into South wind at (3,2)
  run(gWind2, 0.25);
  assert.ok(gWind2.projs[0] && gWind2.projs[0].vy > 0 && gWind2.projs[0].vx > 0, 'wind curves projectile gradually diagonally instead of instant snap');

  // 5. Projectiles cap at 8 active per player (0x10182), stoneFire grid-snaps (0x1b42f), 20-tick owner immunity
  const gCap = new Game(lvl(['1.................']), { players: [0] });
  const pCap = gCap.players[0]; pCap.place(1, 1); pCap.invuln = 0;
  for (let i = 0; i < 10; i++) gCap.fire(pCap, 0, 'fire', 20, 1.5 + i * 0.5, 1.5);
  assert.equal(gCap.projs.length, 8, 'max 8 active projectiles per player');
  // Speed boots caster overtaking own fireball stays alive during 20t immunity window
  const gFast = new Game(lvl(['1.................']), { players: [0] });
  const pFast = gFast.players[0]; pFast.invuln = 0; pFast.dir = 0;
  gFast.applyPickup(pFast, 'foot'); gFast.usePower(pFast);
  gFast.applyPickup(pFast, 'glassFire'); pFast.sprint = true; // simulate boots still active while firing
  gFast.usePower(pFast);
  pFast.input.dir = 0;
  for (let k = 0; k < 25; k++) { pFast.input.dir = 0; gFast.update(1 / 31); }
  assert.equal(pFast.alive, true, '20-tick owner immunity protects fast caster overtaking bolt');
  // Inferno snaps cross axis to tile center (0x1b42f)
  const gInf = new Game(lvl(['...1...', '.......', '.......']), { players: [0] });
  const pInf = gInf.players[0]; pInf.place(4, 2); pInf.fx = 4.72; pInf.fy = 2.68;
  gInf.applyPickup(pInf, 'stoneFire'); gInf.usePower(pInf);
  assert.equal(gInf.projs.find(q => q.d === 1).x, 4.5, 'stoneFire N/S bolts snap X to tile center');
  assert.equal(gInf.projs.find(q => q.d === 0).y, 2.5, 'stoneFire E/W bolts snap Y to tile center');

  // 6. Cannot place bomb on active explosion flame (0x994c) & Speed Boots expire cleanly & Battle has no suddenDeath
  const gFlame = new Game(lvl(['1....']), { players: [0] });
  const pFl = gFlame.players[0]; pFl.place(1, 1); pFl.invuln = 5;
  gFlame.flames.set(1 * W + 1, { t: 0.4, owner: 0, kind: 'fire', hit: new Set() });
  assert.equal(gFlame.placeBomb(pFl), false, 'cannot place cauldron on active flame tile');

  const gBoot = new Game(lvl(['1....']), { players: [0] });
  const pBoot = gBoot.players[0];
  gBoot.applyPickup(pBoot, 'foot'); gBoot.usePower(pBoot);
  assert.equal(pBoot.speed, PLAYER_SPEED * 2);
  pBoot.powerTime = 0.01; run(gBoot, 0.05);
  assert.equal(pBoot.power, null); assert.equal(pBoot.speed, PLAYER_SPEED, 'Speed Boots reset when timer expires');

  const gBat = new Game(data.battle[0], { mode: 'battle', players: [0, 1] });
  gBat.roundTime = 200; gBat.update(1 / 60);
  assert.equal(Boolean(gBat.suddenDeath), false, 'no invented suddenDeath in battle mode');

  // 7. Exact spike phase/delay timing (delay+1 start, 15..36t out per 106t cycle)
  const lSp = lvl(['1....']); lSp.spikes = [[3, 1, 1, 10]]; // delay = 10 -> firstActive at 11/31s
  const gSp = new Game(lSp, { players: [0] });
  const pSp = gSp.players[0]; pSp.invuln = 0; pSp.place(3, 1);
  gSp.time = (11 + 10) / TICK_HZ; gSp.updateSpikes(); gSp.updatePlayer(pSp, 1 / 60);
  assert.equal(pSp.alive, true, 'before step 6 (15t) spikes are still thrusting out, not lethal yet');
  gSp.time = (11 + 20) / TICK_HZ; gSp.updateSpikes(); gSp.updatePlayer(pSp, 1 / 60);
  assert.equal(pSp.alive, false, 'inside steps 6..12 (15..36t after delay+1) spikes kill wizard');
  assert.ok(Math.abs(SPIKE_CYCLE - 106 / 31) < 1e-9);
});

test('breaking rocks & burning uncovered pickups award +7 score (0x5368 / 0xf6b2)', () => {
  const l = lvl(['1.%..', '.....', '.....']);
  const g = new Game(l, { players: [0] });
  const p = g.players[0]; p.place(2, 1); p.score = 0;
  g.placeBomb(p, 'fire'); p.place(2, 3);
  run(g, FUSE + 0.1);
  assert.equal(p.score, 4 + 7, 'cauldron (+4) + rock broken (+7)');

  const g2 = new Game(lvl(['1....', '.....', '.....']), { players: [0] });
  const p2 = g2.players[0]; p2.score = 0;
  g2.items.set(1 * W + 2, { name: 'greenGem', age: 1 });
  p2.place(1, 1); g2.placeBomb(p2, 'fire'); p2.place(1, 3);
  run(g2, FUSE + 0.1);
  assert.equal(p2.score, 4 + 7, 'cauldron (+4) + uncovered pickup burned (+7)');
});

test('LIFE EXCHANGE: multi-player heart sharing revives fallen players while keeping >=1 donor heart', () => {
  const l = lvl(['1.2.3']);
  assert.equal(canExchangeLives(new Game(l, { players: [0] })), false, 'ineligible in 1-player mode');
  const gBat = new Game(l, { mode: 'battle', players: [0, 1] });
  gBat.players[1].lives = 0;
  assert.equal(canExchangeLives(gBat), false, 'ineligible in battle mode');

  const g = new Game(l, { players: [0, 1, 2] });
  const [p0, p1, p2] = g.players;
  assert.equal(canExchangeLives(g), false, 'ineligible when nobody is out of hearts');
  p0.lives = 4; p1.lives = 0; p1.out = true; p1.alive = false; p2.lives = 1;
  assert.equal(canExchangeLives(g), true, 'eligible when a player is out and a survivor has >1 heart');
  assert.equal(exchangeLife(p2, p1), false, 'survivor with only 1 heart cannot donate');

  assert.equal(transferLives(p0, p1, 2), 2, 'donor shares chosen exact number of hearts');
  assert.equal(p0.lives, 2); assert.equal(p1.lives, 2);
  assert.equal(p1.out, false, 'recipient marked active for next level carry');
  assert.equal(p1.alive, false, 'fallen player does NOT spawn back onto the finished level map');
  const gNext = new Game(l, { players: [0, 1, 2], carry: Object.fromEntries(g.players.map(p => [p.slot, p.carry()])) });
  assert.equal(gNext.players[1].alive, true, 'revived player spawns alive in the next level');
  assert.equal(gNext.players[1].lives, 2, 'carried exchanged lives into next level');

  assert.equal(transferLives(p0, p1, 5), 1, 'clamps to donor.lives - 1 so donor always keeps >=1 heart');
  assert.equal(p0.lives, 1); assert.equal(p1.lives, 3);
  assert.equal(exchangeLife(p0, p1), false, 'donor with 1 heart remaining cannot give another');

  // Original DOS symmetrical Left <-> Right steps (0x08481 / 0x084a6):
  const gSym = new Game(l, { players: [0, 1] });
  const [L, R] = gSym.players; L.lives = 3; R.lives = 0; R.out = true; R.alive = false;
  assert.equal(exchangeLife(L, R), true, 'Right arrow transfers 1 Left -> Right (3->2, 0->1)');
  assert.equal(exchangeLife(R, L), false, 'Left arrow blocked once Right is at 1 (0x0848d jle)');
  assert.equal(exchangeLife(L, R), true, 'Right arrow transfers another Left -> Right (2->1, 1->2)');
  assert.equal(exchangeLife(R, L), true, 'Left arrow transfers Right -> Left when Right > 1 (1->2, 2->1)');
  assert.equal(L.lives, 2); assert.equal(R.lives, 1);
});

test('BLAST OVERHANG & ROCK FLAME: fire flames ignite breaking boulder & bakeLevel isolates overhanging brick faces', () => {
  // 1. Fire blast puts flame on the breaking boulder tile (FRACAS.EXE 0xf5cd) and stops there; electric/magic do not
  const gFire = new Game(lvl(['1..%%', '.....', '.....']), { players: [0] });
  const pf = gFire.players[0]; pf.range = 5; pf.place(1, 1);
  gFire.placeBomb(pf, 'fire'); pf.place(1, 3);
  run(gFire, FUSE + 0.05);
  assert.equal(gFire.terrain[1 * W + 4], T.FLOOR, 'first boulder breaks');
  assert.equal(gFire.terrain[1 * W + 5], T.ROCK, 'second boulder stays intact');
  assert.ok(gFire.flames.has(1 * W + 4), 'fire flame appears on breaking boulder tile');
  assert.equal(gFire.flames.has(1 * W + 5), false, 'flame does not pass past broken boulder');

  const gElec = new Game(lvl(['1..%.', '.....', '.....']), { players: [0] });
  const pe = gElec.players[0]; pe.place(1, 1);
  gElec.placeBomb(pe, 'electric'); pe.place(1, 3);
  run(gElec, FUSE + 0.05);
  assert.equal(gElec.terrain[1 * W + 4], T.ROCK, 'electric blast leaves boulder intact');
  assert.equal(gElec.flames.has(1 * W + 4), false, 'electric blast does not enter boulder tile');

  // 2. Realistic wall overhang buffer keeps wall caps + 12px front faces inside wall bounds so floor vents/corridors are never buried
  const mkMockCtx = () => {
    let stored = null;
    return {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: img => { stored = img; },
      alphaAt: (x, y) => stored.data[(y * stored.width + x) * 4 + 3]
    };
  };
  const texBuf = new Uint8Array(256 * 256 * 4).fill(180);
  const mockReal = { monastery_stone_floor: { d: texBuf, n: texBuf, ao: texBuf }, castle_brick_07: { d: texBuf, n: texBuf, ao: texBuf } };
  const bgCtx = mkMockCtx(), overhangCtx = mkMockCtx();
  const gRender = new Game(lvl(['1....']), { players: [0] });
  bakeLevel(bgCtx, gRender, mockReal, overhangCtx);
  assert.equal(overhangCtx.alphaAt(80, 32), 255, 'top border brick cap is opaque in overhang buffer');
  assert.equal(overhangCtx.alphaAt(80, 52), 255, 'top pixel of 12px brick front face inside wall (1,0) is opaque in overhang buffer');
  assert.equal(overhangCtx.alphaAt(80, 63), 255, 'bottom pixel (row 11) of 12px brick front face inside wall (1,0) is opaque in overhang buffer');
  assert.equal(overhangCtx.alphaAt(80, 64), 0, 'floor tile (1,1) immediately south of brick wall stays transparent so vents/floors show cleanly');
});

test('canGo off-center rejects non-steppable side tiles (barrier, door, oneway) and oneway placeBomb falls back before wall', () => {
  const lv = lvl(['#1#', '.#.', '.#.', '...', '###']);
  const g = new Game(lv, { players: [0] }); g.demo = true;
  const p = g.players[0];
  p.place(2, 1); p.fy = 1.25; p.lastDir = 1;
  g.barriers.set(1 * W + 1, 2); // electric barrier on (1, 1) to the West
  assert.equal(g.canGo(p, 2), false, 'off-center canGo refuses electric barrier until aligned');
  g.barriers.clear();
  g.feat[1 * W + 1] = { k: 'door', x: 1, y: 1, kind: 0, o: 0, d: 0, flipped: false, ns: false, isHoriz: true, allow: 0, state: 0 };
  assert.equal(g.canGo(p, 2), false, 'off-center canGo refuses closed flip-door until aligned');
  g.feat[1 * W + 1] = { k: 'oneway', d: 0 };
  assert.equal(g.canGo(p, 2), false, 'off-center canGo refuses wrong-way arrow until aligned');

  // Standing on a '>' oneway facing a wall at (3,1) places the cauldron at (2,1) instead of failing
  const gw = new Game(lvl(['.1>#']), { players: [0] });
  const pw = gw.players[0];
  pw.place(3, 1); pw.fx = 3.92;
  assert.equal(gw.placeBomb(pw), true, 'placeBomb falls back to current cell instead of placing into wall');
  assert.equal(gw.bombs[0].x, 3, 'cauldron lands on current oneway cell (3,1)');
});

test('portalSpot skips barriers and items; Player.carry keeps only persistent fields', () => {
  const g = new Game(lvl(['1..']), { players: [0] });
  g.barriers.set(1 * W + 1, 2);
  g.items.set(1 * W + 2, { name: 'heart', age: 0 });
  for (let k = 0; k < 10; k++) {
    const [px, py] = g.portalSpot();
    assert.deepEqual([px, py], [3, 1], 'portalSpot picks open cell (3,1) skipping barrier & pickup');
  }
  const p = g.players[0];
  p.bombsMax = 5; p.range = 4; p.lives = 2; p.score = 123; p.wins = 1;
  const c = p.carry();
  assert.deepEqual(c, { lives: 2, score: 123, wins: 1 });
  const next = new Game(lvl(['1..'], { startBombs: 1, startRange: 1 }), { players: [0], carry: { 0: c } });
  assert.equal(next.players[0].bombsMax, 1, 'FRACAS.EXE 0x1c04c resets bombsMax to level start');
  assert.equal(next.players[0].range, 1, 'FRACAS.EXE 0x1c04c resets range to level start');
});

test('WORLD_MUSIC covers all 10 story worlds & Battle; Input.menu reads stick X-axis and ignores Start as ok', () => {
  const worlds = new Set(data.normal.map(l => l.world));
  for (const w of worlds) assert.ok(WORLD_MUSIC[w], 'missing WORLD_MUSIC theme for world: ' + w);
  assert.ok(WORLD_MUSIC.Battle, 'missing WORLD_MUSIC theme for Battle');

  const inp = new Input();
  inp.pads = [{ axes: [-0.8, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) }];
  let m = inp.menu();
  assert.equal(m.dx, -1, 'analog left triggers menu dx=-1');
  assert.equal(m.ok, false);
  inp.pads = [{ axes: [0.8, 0], buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 9 })) }];
  m = inp.menu();
  assert.equal(m.dx, 1, 'analog right triggers menu dx=1');
  assert.equal(m.ok, false, 'Start button (button 9) must not fire menu ok');
});

test('interpolation snapshots (prx/pry on sliding bombs, px/py on projectiles) and reused BFS buffer in decide()', () => {
  // 1. Sliding bomb updates prx/pry before advancing rx/ry on conveyor
  const g1 = new Game(lvl(['1......']), { players: [0] });
  g1.freeze = 0;
  g1.feat[1 * W + 1] = { k: 'walk', d: 0 };
  g1.feat[1 * W + 2] = { k: 'walk', d: 0 };
  const p1 = g1.players[0];
  g1.placeBomb(p1);
  const b = g1.bombs[0];
  g1.update(1 / 60);
  g1.update(1 / 60);
  assert.ok(b.rx > b.prx, 'sliding bomb records previous prx before advancing rx');
  assert.equal(b.pry, b.ry, 'east-sliding bomb preserves pry === ry');

  // 2. Projectile records px/py before advancing x/y
  g1.fire(p1, 0, 'fire', 10);
  const pr = g1.projs[0];
  g1.update(1 / 60);
  assert.ok(pr.x > pr.px, 'eastward projectile records previous px before advancing x');
  assert.equal(pr.y, pr.py, 'eastward projectile preserves py === y');

  // 3. Reused BFS buffers (_dist/_q) in ai.js stay clean across consecutive decide() calls
  const g2 = new Game(lvl([
    '1#....',
    '.#.##.',
    '......',
  ]), { players: [0] });
  const m = new Monster(3, 1, 3, 6, 0);
  m.smart = true;
  g2.monsters.push(m);
  g2.players[0].place(1, 3);
  assert.equal(decide(g2, m), 1, 'first BFS call routes south around wall toward (1,3)');
  m.aiState = 'wander';
  g2.players[0].place(6, 2);
  assert.equal(decide(g2, m), 0, 'second BFS call cleanly reroutes east toward (6,2)');
  m.aiState = 'wander';
  g2.terrain[1 * W + 4] = T.WALL;
  assert.equal(decide(g2, m), 1, 'third BFS call routes south around newly blocked east corridor');
});

test('crash hardening: realistic texture null guards, Renderer2D surface-loss recovery & classic fallback, and 150-level sim stress', () => {
  // 1. bakeLevel / makeBoulders must not crash on missing or partial textures
  const g21 = new Game(data.normal[20], { players: [0], seed: 42 }); // Level 21 Verdant Ruins
  const mkFakeCtx = (w = 1344, h = 960) => {
    let lost = false;
    let lastPut = null;
    const ops = [];
    const grad = { addColorStop() {} };
    return {
      _ops: ops,
      _getLastPut() { return lastPut; },
      _setLost(v) { lost = v; },
      isContextLost() { return lost; },
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      fillRect(x, y, rw, rh) { ops.push(['fillRect', x, y, rw, rh]); },
      strokeRect() {}, beginPath() {}, rect() {}, roundRect() {}, clip() {}, arc() {}, ellipse() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, closePath() {}, setLineDash() {},
      strokeText() {},
      translate() {}, scale() {}, rotate() {}, fillText() {},
      measureText() { return { width: 10 }; },
      drawImage(...args) { ops.push(['drawImage', args[0]?.width || 0]); },
      createRadialGradient() { return grad; },
      createLinearGradient() { return grad; },
      createImageData(iw, ih) { return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }; },
      getImageData(gx, gy, gw, gh) { return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }; },
      putImageData(img) { lastPut = img; ops.push(['putImageData', img.width, img.height]); },
    };
  };
  assert.equal(bakeLevel(mkFakeCtx(), g21, {}), false, 'empty real texture map returns false safely');
  assert.equal(makeBoulders({}, { 'OBSTACLE/24': [0, 0, 16, 16, 0, 0] }, { rock_boulder_dry: null }), null, 'null boulder texture returns null cleanly');

  const dOnly = new Uint8ClampedArray(128 * 128 * 4).fill(180);
  const partialReal = { rock_boulder_dry: { d: dOnly, n: null, ao: null }, mossy_cobblestone: { d: dOnly, n: null, ao: null }, castle_wall_slates: { d: dOnly, n: null, ao: null } };
  assert.equal(bakeLevel(mkFakeCtx(), g21, partialReal, mkFakeCtx()), true, 'bakeLevel succeeds with missing normal/AO maps');

  // Verify pre-allocated buffer reuse in bakeLevel does not bleed walls/overhangs between levels
  const g1 = new Game(data.normal[0], { players: [0], seed: 1 });
  const ov1 = mkFakeCtx();
  bakeLevel(mkFakeCtx(), g21, partialReal, mkFakeCtx());
  bakeLevel(mkFakeCtx(), g1, partialReal, ov1);
  const ovImg = ov1._getLastPut();
  let openCheckIdx = -1;
  for (let cy = 1; cy < H - 1 && openCheckIdx < 0; cy++) {
    for (let cx = 1; cx < W - 1; cx++) {
      const i = cy * W + cx;
      if (g21.terrain[i] === T.WALL && g1.terrain[i] !== T.WALL && g1.terrain[(cy - 1) * W + cx] !== T.WALL) {
        openCheckIdx = i; break;
      }
    }
  }
  assert.ok(openCheckIdx >= 0, 'found test tile that is wall in L21 and open in L1');
  const pxIdx = (((openCheckIdx / W) | 0) * 64 + 32) * 1344 + ((openCheckIdx % W) * 64 + 32);
  assert.equal(ovImg.data[pxIdx * 4 + 3], 0, 'reused bakeLevel buffers reset wallMask/face so prior level walls do not bleed into open tiles');

  // Verify south-of-wall shut-off valves (e.g. Level 61 vents (5,3) & (15,3)) are never covered by wall overhang
  const g61 = new Game(data.normal[60], { players: [0], seed: 1 });
  const bg61 = mkFakeCtx(), ov61 = mkFakeCtx();
  assert.equal(bakeLevel(bg61, g61, partialReal, ov61), true, 'Level 61 realistic bake succeeds');
  const bgImg61 = bg61._getLastPut(), ovImg61 = ov61._getLastPut();
  for (const [vx, vy] of [[5, 3], [15, 3]]) {
    assert.equal(g61.terrain[(vy - 1) * W + vx], T.WALL, `Level 61 vent (${vx},${vy}) sits immediately south of a wall`);
    let maxOvAlpha = 0;
    for (let py = 0; py < 64; py++) for (let px = 0; px < 64; px++) {
      const a = ovImg61.data[((vy * 64 + py) * 1344 + (vx * 64 + px)) * 4 + 3];
      if (a > maxOvAlpha) maxOvAlpha = a;
    }
    assert.equal(maxOvAlpha, 0, `wallOverhang alpha is 0 across entire vent tile (${vx},${vy}) south of brick wall`);
    for (let py = 0; py < 64; py++) {
      const wallA = ovImg61.data[(((vy - 1) * 64 + py) * 1344 + (vx * 64 + 32)) * 4 + 3];
      assert.equal(wallA, 255, `wall tile (${vx},${vy - 1}) stays opaque in wallOverhang row ${py} to clip floor flames`);
    }
  }
  assert.ok(bgImg61.data[32 * 4] > 120, 'outer viewport top wall edge stays flush without dark picture-frame outline');

  // 2. Renderer2D surface-loss recovery, HTMLImageElement promotion, Blob cleanup & guards
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const pendingImgs = [], revokedUrls = [];
  let blobUid = 0;
  const mkCanvasEl = (w = 800, h = 600) => {
    const listeners = {}, ctx = mkFakeCtx(w, h);
    return {
      width: w, height: h, style: {},
      getContext() { return ctx; },
      toDataURL() { return 'data:image/png;base64,TEST'; },
      toBlob(cb) { cb({ size: 8 }); },
      addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
      dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); },
    };
  };
  const flushImgs = () => { while (pendingImgs.length) pendingImgs.shift()(); };
  try {
    globalThis.document = { createElement: () => mkCanvasEl(64, 64) };
    globalThis.Image = class {
      constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
      set src(v) {
        this._src = v;
        if (typeof v === 'string' && v.length > 0) {
          this.complete = true; this.naturalWidth = 64; this.naturalHeight = 64; this.width = 64; this.height = 64;
          pendingImgs.push(() => this.onload?.());
        }
      }
      get src() { return this._src || ''; }
    };
    URL.createObjectURL = () => `blob:fracas-test-${++blobUid}`;
    URL.revokeObjectURL = u => revokedUrls.push(u);
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1024; globalThis.innerHeight = 768; globalThis.devicePixelRatio = 1;

    const mainCanvas = mkCanvasEl(1024, 768);
    const fakeFrames = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.includes('/') ? [0, 0, 16, 16, 0, 0] : undefined) });
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));
    const atlasImg = new globalThis.Image();
    atlasImg.complete = true; atlasImg.naturalWidth = 256; atlasImg.naturalHeight = 256; atlasImg.width = 256; atlasImg.height = 256;
    const r = new Renderer2D(mainCanvas, 'high', { image: atlasImg, hdAtlas: null, frames: fakeFrames, monsters: mons, real: { rock_boulder_dry: null } });
    assert.ok(r.vig.width >= 1 && r.vig.width <= 320, 'vignette is shrunk <=320px to save GPU texture memory');
    r._fxCache.set('stale:flash', mkCanvasEl(16, 16));
    r.setGame(g21);
    assert.equal(r._fxCache.size, 0, '_fxCache clears on setGame to avoid unbounded memory growth across levels');
    assert.ok(r.bgx._ops.some(op => op[0] === 'drawImage'), 'falls back to classic tile drawImage instead of leaving black bg when bakeLevel returns false');

    // Also verify partial real textures (with boulders + missing normal/AO) bake and promote cleanly to HTMLImageElement
    r.real = partialReal;
    r._initSurfaces();
    r.buildBackground();
    assert.ok(r.bgx._ops.some(op => op[0] === 'putImageData'), 'bakes partial realistic textures when available');
    flushImgs();
    assert.ok('naturalWidth' in r.bgDrawable && r.bgDrawable.naturalWidth > 0, 'bgDrawable promotes to permanent HTMLImageElement');
    assert.ok('naturalWidth' in r.overhangDrawable && r.overhangDrawable.naturalWidth > 0, 'overhangDrawable promotes to permanent HTMLImageElement');
    assert.ok('naturalWidth' in r.airMist && r.airMist.naturalWidth > 0, 'airMist promotes to permanent HTMLImageElement');
    assert.ok(r.boulders.every(b => !b || ('naturalWidth' in b && b.naturalWidth > 0)), 'boulders promote to permanent HTMLImageElement');

    // Simulate GPU context loss & restore: promoted HTMLImageElements must survive intact without forcing slow re-bake
    const promotedBg = r.bgDrawable;
    const staleBgCanvas = r.bg;
    let prevented = false;
    mainCanvas.dispatchEvent({ type: 'contextlost', preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'contextlost prevents default so browser restores surface');
    assert.equal(r._surfacesLost, true, 'surface loss flags rebuild');
    mainCanvas.dispatchEvent({ type: 'contextrestored' });
    r.render(1 / 60, 0);
    assert.notEqual(r.bg, staleBgCanvas, 'recoverSurfaces rebuilds fresh offscreen bg canvas after restore');
    assert.equal(r.bgDrawable, promotedBg, 'promoted HTMLImageElement bgDrawable survives context recovery intact');
    assert.equal(r._surfacesLost, false, 'surface loss cleared after recovery');

    // Next level revokes prior Blob URLs cleanly
    const revokedBefore = revokedUrls.length;
    r.buildBackground();
    assert.ok(revokedUrls.length > revokedBefore, 'previous background Blob URLs revoked when next level builds');

    // Edge-case guards in render/drawFeatures/drawMonster/drawGlows
    g21.flames.set(22, { t: 0.2, kind: 'unknownKind' });
    g21.projs.push({ x: 3.5, y: 3.5, spell: 'unknownSpell', kind: 'fire', dir: 0 });
    g21.items.set(23, { name: 'unknownPickup', age: 0.1 });
    g21.feat[24] = { k: 'spike', wall: 9, out: true };
    r.activeFeat.push(24);
    r.render(1 / 60, 0);
    r.drawMonster({ x: 2.5, y: 2.5, dir: 0, type: 2, alive: true, boss: true, maxHp: 3, hp: 2, moving: false, stun: 0, zapped: 0, flash: 0, info: null }, 0, 1 / 60);

    // Verify bright stone boulder texture does not blow out top-left hemisphere to solid #ffffff
    const brightStone = new Uint8ClampedArray(128 * 128 * 4);
    for (let i = 0; i < 128 * 128; i++) {
      brightStone[i * 4] = 231; brightStone[i * 4 + 1] = 226; brightStone[i * 4 + 2] = 220; brightStone[i * 4 + 3] = 255;
    }
    let boulderImgOut = null;
    const savedCreate = globalThis.document.createElement;
    globalThis.document = {
      createElement: () => {
        const el = {
          width: 64, height: 64, style: {},
          getContext: () => ({
            clearRect() {}, drawImage() {},
            createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
            getImageData: (gx, gy, gw, gh) => {
              const d = new Uint8ClampedArray(gw * gh * 4);
              for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) {
                if (Math.hypot(xx - gw / 2, yy - gh / 2) < gw * 0.42) d[(yy * gw + xx) * 4 + 3] = 255;
              }
              return { width: gw, height: gh, data: d };
            },
            putImageData(img) { boulderImgOut = img; },
          }),
          toBlob(cb) { cb({ size: 8 }); },
        };
        return el;
      },
    };
    const testBoulders = makeBoulders(atlasImg, { 'OBSTACLE/24': [0, 0, 64, 64, 0, 0] }, { rock_boulder_dry: { d: brightStone, n: null, ao: null } });
    globalThis.document = { createElement: savedCreate };
    assert.ok(Array.isArray(testBoulders) && boulderImgOut, 'makeBoulders renders realistic boulder sprite');
    let clippedWhite = 0, litStone = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if (boulderImgOut.data[i * 4 + 3] === 255) {
        litStone++;
        if (boulderImgOut.data[i * 4] === 255 && boulderImgOut.data[i * 4 + 1] === 255 && boulderImgOut.data[i * 4 + 2] === 255) clippedWhite++;
      }
    }
    assert.ok(litStone > 500, 'boulder silhouette populated');
    assert.equal(clippedWhite, 0, 'brightest rock_boulder_dry areas retain texture without solid #ffffff blowout');

    // Simulate minimized 0x0 viewport resize without InvalidStateError
    globalThis.innerWidth = 0; globalThis.innerHeight = 0;
    r.resize();
    assert.ok(r.vig.width >= 1 && r.vig.height >= 1, 'vignette stays >=1px when viewport minimizes');
    r.render(1 / 60, 0);
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }

  // 3. Full 150-level simulation stress check
  for (const [mode, list] of [['normal', data.normal], ['battle', data.battle]]) {
    for (const lv of list) {
      const sim = new Game(lv, { mode, players: mode === 'battle' ? [{ slot: 0 }, { slot: 1 }] : [{ slot: 0 }], seed: 1337 });
      for (let tick = 0; tick < 120; tick++) {
        const inp = new Map();
        for (const p of sim.players) inp.set(p.slot, { dir: (tick + p.slot) % 4, bomb: tick % 25 === 0, power: tick % 19 === 0, bombHeld: tick % 11 === 0 });
        sim.update(1 / 31, inp);
      }
    }
  }
});

test('teleport reveal spawn safety: emerging worm does not kill overlapped player until separation', () => {
  // Only two free floor tiles exist: (1,1) and (2,1), so teleporting from (2,1) must emerge onto player at (1,1)
  const l = lvl(['1.']);
  const g = new Game(l, { players: [0], seed: 11 });
  g.freeze = 0;
  const p = g.players[0];
  p.invuln = 0;
  const mon = new Monster(2, 1, 3, 0, 0); // speed 0 so it stays overlapped after reveal ends
  g.monsters = [mon];

  g.teleport(mon);
  assert.equal(mon.tpPhase, 'hide');
  for (let t = 0; t < 120 && mon.tpPhase === 'hide'; t++) g.update(1 / 31);
  assert.equal(mon.tpPhase, 'reveal');
  assert.equal(mon.cx, p.cx, 'worm emerged right onto player tile');
  assert.equal(p.alive, true, 'player survives initial reveal overlap');

  // Survive entire reveal blink and several post-reveal ticks while still overlapping
  for (let t = 0; t < 120 && mon.tpPhase === 'reveal'; t++) g.update(1 / 31);
  assert.equal(mon.tpPhase, null, 'reveal finished');
  for (let t = 0; t < 10; t++) g.update(1 / 31);
  assert.equal(p.alive, true, 'player still safe right after reveal ends while overlapping');

  // Once separated (>= 0.62) and re-contacting normally, monster contact is lethal again
  p.place(2, 1);
  g.update(1 / 31);
  assert.equal(p.alive, true);
  p.fx = 1.5; p.fy = 1.5;
  g.update(1 / 31);
  assert.equal(p.alive, false, 'normal monster contact kills after separating from teleport reveal');
});

test('teleport reveal safety for player warping onto monster tile until separation', () => {
  const l = lvl(['1.']);
  const g = new Game(l, { players: [0], seed: 17 });
  g.freeze = 0;
  const p = g.players[0];
  p.invuln = 0;
  const mon = new Monster(2, 1, 3, 0, 0);
  g.monsters = [mon];

  g.teleport(p);
  assert.equal(p.tpPhase, 'hide');
  for (let t = 0; t < 120 && p.tpPhase === 'hide'; t++) g.update(1 / 31);
  assert.equal(p.tpPhase, 'reveal');
  assert.equal(p.cx, mon.cx, 'player emerged onto monster tile');
  for (let t = 0; t < 120 && p.tpPhase === 'reveal'; t++) g.update(1 / 31);
  assert.equal(p.tpPhase, null);
  for (let t = 0; t < 10; t++) g.update(1 / 31);
  assert.equal(p.alive, true, 'warped player stays safe while overlapped after reveal ends');
});

test('L-shaped portal cover protects player hugging closed gate from bombs on the other side', () => {
  for (const kind of ['fire', 'electric', 'magic']) {
    const l = lvl(['1.....', '##.###', '......']);
    l.doors = [[3, 2, 1]]; // allows south (1), closed north from (3,3)
    const g = new Game(l, { players: [0] });
    g.freeze = 0;
    const p = g.players[0];
    p.place(3, 3);
    p.invuln = 0;
    // Place bomb on opposite side (3,1) and hold North into closed portal as cover
    g.bombs.push({ id: 700, x: 3, y: 1, cx: 3, cy: 1, owner: 1, range: 5, fuse: 0.25, age: 0, kind, vent: -1 });
    for (let t = 0; t < 15; t++) {
      p.input.dir = 3; // hold North against closed gate throughout explosion
      g.update(1 / 31);
    }
    assert.ok(g.flames.has(2 * W + 3), `${kind}: doorway has active blast hazard`);
    assert.equal(p.cy, 3, `${kind}: player held safely outside burning doorway`);
    assert.equal(p.alive, true, `${kind}: portal cover keeps hugging player alive`);
    assert.equal(p.stun, 0, `${kind}: portal cover prevents electric stun`);
    assert.equal(p.tpPhase, null, `${kind}: portal cover prevents warp`);
    // Once hazard expires, holding North proceeds safely through the now-open portal
    for (let t = 0; t < 65; t++) {
      p.input.dir = 3;
      g.update(1 / 31);
    }
    assert.ok(p.alive && p.cy <= 2, `${kind}: player walks cleanly through after flame clears`);
  }
});

test('monsters step right up to wrong-way one-way arrows, stand by them, and receive arrow blast cover', () => {
  // Border adds +1 offset: (1,1) is player '1' isolated by walls, corridor col 3 is (3,1)..(3,5) with 'v' at (3,3)
  const l = lvl(['1#.##', '##.##', '##v##', '##.##', '##.##']);
  // Test with multiple seeds so at least one rolls touchWait > 0
  let sawPause = false, sawShielded = false;
  for (let seed = 1; seed <= 12; seed++) {
    const g = new Game(l, { players: [0], seed, freeze: 0 });
    const p = g.players[0];
    p.place(1, 1); p.invuln = 1e6; p.ghost = 1e6; // isolated in (1,1) wall pocket so monsters ignore player
    const mon = new Monster(3, 4, 2, 0, 1.875); // IQ 0 wanderer approaching North toward 'v' at (3, 3)
    mon.dir = 3; mon.walkLeft = 4;
    g.monsters = [mon];

    let minY = 99;
    let pausedTicks = 0;
    let reversedAt = -1;
    for (let t = 0; t < 160; t++) {
      g.update(1 / 31);
      minY = Math.min(minY, mon.y);
      assert.ok(mon.y >= 3.9, `never crossed wrong-way arrow into north cell (got y=${mon.y.toFixed(3)})`);
      if (mon.touching && mon.touchWait > 0) pausedTicks++;
      if (!mon.touching && mon.retreatingTouch && reversedAt < 0) reversedAt = t;
    }
    assert.ok(minY < 4.0, `seed ${seed}: monster stepped past (3,4) center right up to arrow threshold (minY=${minY.toFixed(3)})`);
    assert.ok(reversedAt >= 0, `seed ${seed}: monster cleanly reversed back after approaching arrow`);
    if (pausedTicks > 1) sawPause = true;

    // While monster stands pressed at y=3.94 (cy === 3), wrong-way blast from (3, 4) shields it; blast from (3, 2) kills it
    const gCov = new Game(l, { players: [0], seed: 2, freeze: 0 });
    gCov.players[0].place(1, 1); gCov.players[0].invuln = 1e6; gCov.players[0].ghost = 1e6;
    const mCov = new Monster(3, 4, 2, 0, 1.875);
    mCov.tx = 3; mCov.ty = 4; mCov.nx = 3; mCov.ny = 3; mCov.p = 0.56; mCov.dir = 3; mCov.stepDir = 3;
    mCov.moving = true; mCov.touching = true; mCov.touchWait = 2.0; mCov.stepSpeed = mCov.speed;
    gCov.monsters = [mCov];
    assert.equal(mCov.cy, 3, 'touching monster body cell matches 0xcd90 (arrow cell)');
    gCov.bombs.push({ id: 910, x: 3, y: 4, cx: 3, cy: 4, owner: 0, range: 4, fuse: 0.05, age: 0, kind: 'fire', vent: -1 });
    for (let t = 0; t < 10; t++) gCov.update(1 / 31);
    assert.equal(mCov.alive, true, 'wrong-way arrow shields touching monster from bomb behind it');
    sawShielded = true;
    gCov.flames.clear();
    gCov.bombs.push({ id: 911, x: 3, y: 2, cx: 3, cy: 2, owner: 0, range: 4, fuse: 0.05, age: 0, kind: 'fire', vent: -1 });
    for (let t = 0; t < 10; t++) gCov.update(1 / 31);
    assert.equal(mCov.alive, false, 'blast traveling WITH arrow hits monster touching arrow');
    if (sawPause && sawShielded) break;
  }
  assert.ok(sawPause, 'monster stands paused right beside one-way arrow before walking away');
  assert.ok(sawShielded, 'arrow cover verified for touching monster');
});

test('monsters with LoS charge step up to and stand pressed against one-way arrows and closed flip-doors facing wizard', () => {
  // Case 1: Wizard at (3, 2) across South-pointing 'v' arrow at (3, 3); monster with IQ bit3 at (3, 5)
  const lArrow = lvl(['1#.##', '##.##', '##v##', '##.##', '##.##']);
  const gA = new Game(lArrow, { players: [0], seed: 3, freeze: 0 });
  const pA = gA.players[0];
  pA.place(3, 2); pA.invuln = 1e6;
  const mA = new Monster(3, 5, 0, 7, 1.875); // beh 7 has iq & 0x08 (charge wizard in LoS)
  mA.dir = 1;
  gA.monsters = [mA];
  for (let t = 0; t < 90; t++) gA.update(1 / 31);
  assert.ok(mA.y <= 3.96 && mA.y >= 3.92, `charged up to arrow touch threshold (y=${mA.y.toFixed(3)})`);
  assert.equal(mA.dir, 3, 'facing wizard North across wrong-way arrow');
  assert.equal(mA.touching, true, 'standing pressed at arrow threshold while wizard stays in LoS');

  // Case 2: Wizard at (3, 2) across closed L-shaped door at (3, 3) (allows South 1, closed North 3)
  const lDoor = lvl(['1#.##', '##.##', '##.##', '##.##', '##.##']);
  lDoor.doors = [[3, 3, 1]];
  const gD = new Game(lDoor, { players: [0], seed: 5, freeze: 0 });
  const pD = gD.players[0];
  pD.place(3, 2); pD.invuln = 1e6;
  const mD = new Monster(3, 5, 0, 7, 1.875);
  mD.dir = 1;
  gD.monsters = [mD];
  for (let t = 0; t < 90; t++) gD.update(1 / 31);
  assert.ok(mD.y <= 4.04 && mD.y >= 4.00, `charged up to closed door touch threshold (y=${mD.y.toFixed(3)})`);
  assert.equal(mD.dir, 3, 'facing wizard North across closed door');
  assert.equal(mD.touching, true, 'standing pressed at closed door while wizard stays in LoS');

  // If a bomb threatens along corridor when IQ has flee bit (0x10), monster immediately breaks touch pause and flees
  const gFlee = new Game(lArrow, { players: [0], seed: 7, freeze: 0 });
  gFlee.players[0].place(1, 1); gFlee.players[0].invuln = 1e6; gFlee.players[0].ghost = 1e6;
  const mF = new Monster(3, 4, 8, 12, 1.875); // IQ[12] = 0x3b (includes flee bit4 0x10 + dodge bit5 0x20)
  mF.tx = 3; mF.ty = 4; mF.nx = 3; mF.ny = 3; mF.p = 0.56; mF.dir = 3; mF.stepDir = 3;
  mF.moving = true; mF.touching = true; mF.touchWait = 3.0; mF.stepSpeed = mF.speed;
  gFlee.monsters = [mF];
  gFlee.bombs.push({ id: 920, x: 3, y: 5, cx: 3, cy: 5, owner: 0, range: 3, fuse: 2.0, age: 0, kind: 'fire', vent: -1 });
  gFlee.update(1 / 31);
  assert.equal(mF.touching, false, 'touching monster immediately breaks off pause to react to bomb in LoS');
  assert.equal(mF.retreatingTouch, true, 'reverses back from threshold');
});

test('touching a wrong-way one-way arrow gate and pressing bomb places the cauldron directly on the arrow tile (FRACAS.EXE 0x09938)', () => {
  const cleanCases = [
    { name: 'v approached North', rows: ['.#.##', '##.##', '##v##', '##.##', '##1.#'], mon: [1, 1], start: [3, 4], arrow: [3, 3], approach: 3, escape: 1, escape2: 0, far: [3, 1] },
    { name: '^ approached South', rows: ['.#..#', '##.##', '##^##', '##.##', '##1.#'], mon: [1, 1], start: [3, 2], arrow: [3, 3], approach: 1, escape: 3, escape2: 0, far: [3, 5] },
    { name: '> approached West',  rows: ['#####', '#...#', '#.>.#', '#1..#', '.####'], mon: [1, 5], start: [4, 3], arrow: [3, 3], approach: 2, escape: 0, escape2: 1, far: [2, 3] },
    { name: '< approached East',  rows: ['#####', '#...#', '#.<.#', '#..1#', '.####'], mon: [1, 5], start: [2, 3], arrow: [3, 3], approach: 0, escape: 2, escape2: 1, far: [4, 3] },
  ];
  for (const c of cleanCases) {
    const g = new Game(lvl(c.rows), { players: [0], freeze: 0 });
    g.monsters.push(new Monster(c.mon[0], c.mon[1], 2, 0, 0)); // keep level in 'play' state
    const p = g.players[0];
    p.place(c.start[0], c.start[1]);
    p.invuln = 0; p.range = 4;
    // Walk up to touch the wrong-way arrow edge
    p.input.dir = c.approach;
    for (let t = 0; t < 20; t++) g.update(1 / 31);
    assert.deepEqual([p.cx, p.cy], c.arrow, `${c.name}: player stops touching arrow tile`);
    // Press bomb while touching arrow
    p.input.dir = c.approach;
    p.input.bomb = true;
    g.update(1 / 31);
    assert.equal(g.bombs.length, 1, `${c.name}: cauldron placed`);
    assert.deepEqual([g.bombs[0].x, g.bombs[0].y], c.arrow, `${c.name}: cauldron sits directly on arrow tile`);
    // Walk away to safety and wait for explosion
    p.input.dir = c.escape;
    for (let t = 0; t < 18; t++) g.update(1 / 31);
    p.input.dir = c.escape2;
    for (let t = 0; t < 15; t++) g.update(1 / 31);
    p.input.dir = -1;
    let sawFarFlame = false;
    for (let t = 0; t < 140; t++) {
      g.update(1 / 31);
      if (g.flames.has(c.far[1] * W + c.far[0])) sawFarFlame = true;
    }
    assert.equal(sawFarFlame, true, `${c.name}: explosion blasts past arrow into far corridor`);
    assert.equal(p.alive, true, `${c.name}: player escapes cleanly to safety`);
  }
});

test('modern HD procedural pickup sprites cover all 17 PICKUP_INFO / PICK_INDEX entries, map glow, HUD slot, and context recovery', () => {
  assert.equal(PICK_INDEX.length, 17);
  for (const name of Object.keys(PICKUP_INFO)) {
    assert.ok(PICK_INDEX.includes(name), `${name} is included in PICK_INDEX`);
  }

  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const mkCanvas = (w = 800, h = 600) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops,
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {},
      clip() {}, translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); },
      stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); },
      strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', t]); },
      strokeText(t) { ops.push(['strokeText', t]); },
      measureText: () => ({ width: 12 }),
      drawImage: img => { ops.push(['drawImage', img?.width || 0, img?.height || 0, img, ctx.globalAlpha]); },
      createRadialGradient: () => grad,
      createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }),
      putImageData() {},
    };
    return {
      width: w, height: h, style: {}, _ctx: ctx,
      getContext: () => ctx,
      toDataURL: () => '',
      toBlob: () => {},
      addEventListener() {},
    };
  };
  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class {
      constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
      set src(_) {}
    };
    URL.createObjectURL = () => 'blob:pickup-test';
    URL.revokeObjectURL = () => {};
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 960; globalThis.devicePixelRatio = 1;

    const mainCanvas = mkCanvas(1280, 960);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 256; atlas.naturalHeight = 256; atlas.width = 256; atlas.height = 256;
    const frames = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.includes('/') ? [0, 0, 16, 16, 0, 0] : undefined) });
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));

    const r = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas: null, frames, monsters: mons, real: null });
    assert.equal(r.getPickupSprite('unknownPickup'), null, 'unknown pickup name returns null safely');
    for (const name of PICK_INDEX) {
      const spr = r.getPickupSprite(name);
      assert.ok(spr && spr.canvas, `${name}: sprite created`);
      assert.equal(spr.size, 128, `${name}: supersampled 128x128 size`);
      assert.equal(spr.canvas.width, 128, `${name}: canvas width is 128`);
      assert.equal(spr.canvas.height, 128, `${name}: canvas height is 128`);
      const ops = spr.canvas._ctx._ops;
      assert.ok(ops.includes('fill') && ops.includes('stroke'), `${name}: vector shaded fill and contour stroke executed`);
    }

    // Verify 128x128 HD bomb and vent sprites + drawBombs rendering
    for (const kind of ['fire', 'electric', 'magic']) {
      for (let fi = 0; fi < 6; fi++) {
        const bSpr = r.getBombSprite(kind, fi);
        assert.ok(bSpr && bSpr.canvas, `bomb ${kind}/${fi}: sprite created`);
        assert.equal(bSpr.size, 128, `bomb ${kind}/${fi}: supersampled 128x128 size`);
        assert.equal(bSpr.canvas.width, 128, `bomb ${kind}/${fi}: canvas width is 128`);
        assert.equal(bSpr.canvas.height, 128, `bomb ${kind}/${fi}: canvas height is 128`);
        const ops = bSpr.canvas._ctx._ops;
        assert.ok(ops.includes('fill') && ops.includes('stroke'), `bomb ${kind}/${fi}: vector shaded fill and stroke executed`);
      }
    }
    for (let v = 0; v < 4; v++) {
      const vSpr = r.getVentSprite(v);
      assert.ok(vSpr && vSpr.canvas, `vent ${v}: sprite created`);
      assert.equal(vSpr.size, 128, `vent ${v}: supersampled 128x128 size`);
      assert.equal(vSpr.canvas.width, 128, `vent ${v}: canvas width is 128`);
      assert.equal(vSpr.canvas.height, 128, `vent ${v}: canvas height is 128`);
      const ops = vSpr.canvas._ctx._ops;
      assert.ok(ops.includes('fill') && ops.includes('stroke'), `vent ${v}: vector shaded fill and stroke executed`);
    }

    // Verify drawItems renders all 17 HD pickup sprites onto map + floor light glows, and drawHud uses HD icon
    const g = new Game(lvl(['1..................']), { players: [0], seed: 1 });
    PICK_INDEX.forEach((name, idx) => { g.items.set(W + 1 + idx, { name, age: 1 }); });
    g.bombs = [
      { id: 1, x: 2, y: 2, cx: 2, cy: 2, kind: 'fire', owner: 0, age: 1, fuse: 2 },
      { id: 2, x: 4, y: 2, cx: 4, cy: 2, kind: 'electric', owner: 0, age: 1, fuse: 2 },
      { id: 3, x: 6, y: 2, cx: 6, cy: 2, kind: 'magic', owner: 0, age: 1, fuse: 2 },
    ];
    r.setGame(g);
    mainCanvas._ctx._ops.length = 0;
    r.drawItems();
    const hdSet = new Set(PICK_INDEX.map(n => r.getPickupSprite(n).canvas));
    const hdDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && hdSet.has(op[3]));
    assert.equal(hdDraws.length, PICK_INDEX.length, 'drawItems renders all 17 pickups from 128x128 HD sprite cache');
    const glowDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && op[1] === 128 && op[2] === 128 && !hdSet.has(op[3]));
    assert.equal(glowDraws.length, PICK_INDEX.length * 3, 'drawItems adds 3 illumination glow layers (floor + colored rim + white halo) per pickup');

    mainCanvas._ctx._ops.length = 0;
    r.time = 0;
    r.drawBombs(1);
    const atlasBombs = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && op[3] === r.atlas);
    const fireBombCanvases = new Set(Array.from({ length: 6 }, (_, i) => r.getBombSprite('fire', i).canvas));
    const elecBombCanvases = new Set(Array.from({ length: 6 }, (_, i) => r.getBombSprite('electric', i).canvas));
    const magicBombCanvases = new Set(Array.from({ length: 6 }, (_, i) => r.getBombSprite('magic', i).canvas));
    const fireBombDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && fireBombCanvases.has(op[3]));
    const elecBombDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && elecBombCanvases.has(op[3]));
    const magicBombDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && magicBombCanvases.has(op[3]));
    assert.equal(atlasBombs.length, 0, 'drawBombs renders zero blurry atlas bomb sprites');
    assert.equal(fireBombDraws.length, 1, 'drawBombs renders fire cauldron from 128x128 vector sprite cache');
    assert.equal(elecBombDraws.length, 1, 'drawBombs renders electric cauldron from 128x128 vector sprite cache');
    assert.equal(magicBombDraws.length, 1, 'drawBombs renders invisibility/magic cauldron from 128x128 vector sprite cache');

    // Verify continuous vector detonation waves (fire, electric, magic), projectiles, vanish sparkles, shock arcs, arrow gates & L-shaped doors
    g.flames = new Map([
      [1 * W + 1, { t: 0.4, owner: 0, kind: 'fire' }],
      [1 * W + 2, { t: 0.4, owner: 0, kind: 'fire' }],
      [7 * W + 3, { t: 0.3, owner: 0, kind: 'fire' }],
      [2 * W + 2, { t: 0.4, owner: 0, kind: 'electric' }],
      [2 * W + 3, { t: 0.4, owner: 0, kind: 'electric' }],
      [3 * W + 2, { t: 0.4, owner: 0, kind: 'electric' }],
      [8 * W + 8, { t: 0.3, owner: 0, kind: 'electric' }],
      [5 * W + 10, { t: 0.4, owner: 0, kind: 'magic' }],
      [5 * W + 11, { t: 0.4, owner: 0, kind: 'magic' }],
      [5 * W + 12, { t: 0.4, owner: 0, kind: 'magic' }],
      [4 * W + 11, { t: 0.4, owner: 0, kind: 'magic' }],
      [6 * W + 11, { t: 0.4, owner: 0, kind: 'magic' }],
    ]);
    g.projs = [
      { id: 9, x: 2.5, y: 3.5, px: 2.4, py: 3.5, d: 1, spell: 'fire' },
      { id: 10, x: 3.5, y: 3.5, px: 3.4, py: 3.5, d: 0, spell: 'electric' },
      { id: 11, x: 7.5, y: 3.5, px: 7.4, py: 3.5, d: 2, spell: 'teleport' },
    ];
    r.onewayCells = []; r.activeFeat = [];
    for (let d = 0; d < 4; d++) {
      const oi = 9 * W + (2 + d), di = 10 * W + (2 + d);
      g.feat[oi] = { k: 'oneway', d };
      g.feat[di] = { k: 'door', x: 2 + d, y: 10, kind: d, state: d & 1 ? 4 : 0, ns: d % 2 === 1 };
      r.doorAnim.set(di, { from: 0, to: 4, t: 0.5 });
      r.onewayCells.push(oi);
      r.activeFeat.push(di);
    }
    r.fx.push({ k: 'magi', x: 5.5, y: 5.5, t: 0.1 });
    r.zapFx.set(g.players[0].id, 0.2);
    mainCanvas._ctx._ops.length = 0;
    r.drawFeatures(0.016);
    r.drawFlames();
    r.drawMagicStars(g.players[0], 4.5, 4.5, 1);
    r.shockArcs(6.5, 6.5);
    r.drawProjectiles(1);
    r.drawFx(0.05);
    assert.ok(mainCanvas._ctx._ops.includes('stroke') && mainCanvas._ctx._ops.includes('fill'),
      'vector fire/electric/magic flames, projectiles, arrow gates, L-doors, vanish sparkles, and shock arcs emit crisp fill/stroke draws');
    assert.equal(mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && op[3] === r.atlas).length, 0,
      'vector bombs, blasts, projectiles, arrow gates, L-doors, vanish sparkles, and shock arcs do not draw pixelated atlas chunks');

    // Verify dying monsters gradually fade away in opacity over 140/31s instead of popping off abruptly
    g.players.forEach(p => { p.alive = false; p.out = true; p.deadT = 9; });
    g.monsters.forEach(m => { m.alive = false; });
    r.dying = [{ x: 3.5, y: 4.5, key: `${mons[3].file}/0`, type: 3, t: 0, boss: false }];
    const deathAlphas = [];
    for (const stepDt of [0.1, 2.0, 1.5]) {
      mainCanvas._ctx._ops.length = 0;
      r.drawActors(stepDt, 1);
      const mdisSet = new Set([1, 2, 3, 4].map(n => r._fxCache.get(`${mons[3].file}/0:mdis${n}`)).filter(Boolean));
      const bodyDraw = mainCanvas._ctx._ops.find(op => op[0] === 'drawImage' && (op[3] === r.atlas || mdisSet.has(op[3])));
      deathAlphas.push(bodyDraw ? bodyDraw[4] : 0);
    }
    assert.ok(deathAlphas[0] > 0.9 && deathAlphas[1] > 0.25 && deathAlphas[1] < 0.75 && deathAlphas[2] > 0.02 && deathAlphas[2] < 0.40,
      `dying monster gradually fades away cleanly (observed alphas ${deathAlphas.map(a => a.toFixed(2)).join(' -> ')})`);
    mainCanvas._ctx._ops.length = 0;
    r.drawActors(1.0, 1);
    assert.equal(r.dying.length, 0, 'dying monster finishes fading and is removed after 140/31s');

    for (const pwr of ['glassElectric', 'orb', null]) {
      g.players[0].power = pwr;
      g.players[0].radiation = pwr ? 0 : 120;
      r._hudSig = '';
      r.drawHud();
      const hudCtx = r._hudBars[0].ctx;
      const expected = r.getPickupSprite(pwr || 'radiation').canvas;
      assert.ok(hudCtx._ops.some(op => op[0] === 'drawImage' && op[3] === expected),
        `drawHud uses 128x128 HD sprite for ${pwr || 'radiation'}`);
    }

    // Verify context recovery clears and repopulates pickup, bomb, and vent sprite caches
    const staleSprite = r.getPickupSprite('heart').canvas;
    const staleBomb = r.getBombSprite('fire', 0).canvas;
    const staleVent = r.getVentSprite(0).canvas;
    r.recoverSurfaces();
    assert.notEqual(r.getPickupSprite('heart').canvas, staleSprite, 'recoverSurfaces rebuilds pickup sprite cache');
    assert.notEqual(r.getBombSprite('fire', 0).canvas, staleBomb, 'recoverSurfaces rebuilds bomb sprite cache');
    assert.notEqual(r.getVentSprite(0).canvas, staleVent, 'recoverSurfaces rebuilds vent sprite cache');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('FRACAS.EXE parity: monsters in wind zones, 1-way gust origin tile, monster cx/cy pickup eating & teleported bomb belt/wind slide', () => {
  // 1a. Monster in active wind zone adds/subtracts WALKWAY_SPEED and reverses when slower (0x0c500)
  const gWind = new Game(lvl(['1........']), { players: [0] });
  const pw = gWind.players[0]; pw.dir = 0; pw.invuln = 10;
  gWind.applyPickup(pw, 'glassWind'); gWind.usePower(pw); // East wind at (1..6, 1)
  const mFast = new Monster(4, 1, 3, 1, 0); mFast.speed = 3.0; gWind.monsters.push(mFast); // Tracker spots pw West
  gWind.update(1 / 60);
  assert.equal(mFast.stepDir, 2, 'fast monster continues West against East wind');
  assert.ok(Math.abs(mFast.stepSpeed - (3.0 - WALKWAY_SPEED)) < 1e-6, 'against wind subtracts WALKWAY_SPEED');

  const gWindWith = new Game(lvl(['1........']), { players: [0] });
  const pwWith = gWindWith.players[0]; pwWith.dir = 0; pwWith.invuln = 10;
  gWindWith.applyPickup(pwWith, 'glassWind'); gWindWith.usePower(pwWith); // East wind at (1..6, 1)
  pwWith.place(8, 1);
  const mWith = new Monster(3, 1, 3, 1, 0); mWith.speed = 3.0; gWindWith.monsters.push(mWith); // Tracker spots pwWith East
  gWindWith.update(1 / 60);
  assert.equal(mWith.stepDir, 0, 'monster moves East with East wind');
  assert.ok(Math.abs(mWith.stepSpeed - (3.0 + WALKWAY_SPEED)) < 1e-6, 'with wind adds WALKWAY_SPEED');

  const gWindSlow = new Game(lvl(['1........']), { players: [0] });
  const pwSlow = gWindSlow.players[0]; pwSlow.dir = 0; pwSlow.invuln = 10;
  gWindSlow.applyPickup(pwSlow, 'glassWind'); gWindSlow.usePower(pwSlow);
  const mSlow = new Monster(4, 1, 3, 1, 0); mSlow.speed = 1.0; gWindSlow.monsters.push(mSlow);
  gWindSlow.update(1 / 60);
  assert.equal(mSlow.stepDir, 0, 'slow monster fighting wind is blown East');
  assert.ok(Math.abs(mSlow.stepSpeed - (WALKWAY_SPEED - 1.0)) < 1e-6, 'slow monster reverses at WALKWAY_SPEED - speed');

  // 1b. Wind activating mid-step does NOT snap a moving monster back to cell center
  const gMid = new Game(lvl(['1........']), { players: [0] });
  const pMid = gMid.players[0]; pMid.dir = 0; pMid.invuln = 10;
  const mMid = new Monster(3, 1, 3, 0, 0); mMid.speed = 2.0; gMid.monsters.push(mMid);
  gMid.stepMover(mMid, 0.2, () => 2); // p = 0.4 heading West -> mMid.x = 3.1
  const xBeforeWind = mMid.x;
  assert.ok(Math.abs(xBeforeWind - 3.1) < 1e-6 && mMid.moving, 'monster is mid-step at x = 3.1');
  gMid.applyPickup(pMid, 'glassWind'); gMid.usePower(pMid);
  gMid.update(1 / 60);
  assert.equal(mMid.stepDir, 2, 'faster monster continues West against newly started wind');
  assert.ok(Math.abs(mMid.stepSpeed - (2.0 - WALKWAY_SPEED)) < 1e-6, 'mid-step speed reduced by WALKWAY_SPEED');
  assert.ok(Math.abs(mMid.x - (xBeforeWind - (2.0 - WALKWAY_SPEED) / 60)) < 1e-6, 'no cell-center snap on mid-step wind');

  // 2. 1-way Gust (glassWind) covers caster's own tile (r = 0..5), whereas 4-way Storm (stoneWind) keeps r = 1..5
  const gGust = new Game(lvl(['1........']), { players: [0] });
  const pg = gGust.players[0]; pg.dir = 0;
  gGust.applyPickup(pg, 'glassWind'); gGust.usePower(pg);
  assert.equal(gGust.winds[0].cells.size, 6, 'glassWind covers 6 tiles');
  assert.equal(gGust.windDirAt(1, 1), 0, 'glassWind includes caster own tile (r = 0)');
  assert.equal(gGust.windDirAt(6, 1), 0, 'glassWind ends at r = 5');
  assert.equal(gGust.windDirAt(7, 1), -1, 'glassWind does not extend to r = 6');
  assert.equal(gGust.placeBomb(pg, 'fire'), true);
  gGust.update(1 / 60);
  assert.equal(gGust.bombs[0].slide?.d, 0, 'cauldron placed on caster own tile immediately slides in glassWind');

  const gStorm = new Game(lvl(Array(5).fill('...........').map((r, y) => y === 2 ? '.....1.....' : r)), { players: [0] });
  const ps = gStorm.players[0];
  gStorm.applyPickup(ps, 'stoneWind'); gStorm.usePower(ps);
  assert.equal(gStorm.windDirAt(ps.cx, ps.cy), -1, 'stoneWind leaves caster own tile out');
  assert.equal(gStorm.windDirAt(ps.cx + 1, ps.cy), 0, 'stoneWind starts at r = 1');

  // 3. Monsters eat uncovered pickups at m.cx, m.cy (p >= 0.5), including touching a wrong-way arrow at p = 0.56
  const gEat = new Game(lvl(['1....']), { players: [0] });
  const mEat = new Monster(2, 1, 3, 0, 0); mEat.speed = 2.0; gEat.monsters.push(mEat);
  gEat.items.set(1 * W + 3, { name: 'heart', age: 0 });
  gEat.stepMover(mEat, 0.15, () => 0); // p = 0.3 -> cx = 2
  assert.equal(gEat.items.size, 1, 'pickup untouched while monster cx is still on source cell');
  gEat.stepMover(mEat, 0.15, () => 0); // p = 0.6 -> cx = 3, still moving
  assert.equal(mEat.moving, true);
  assert.equal(gEat.items.size, 0, 'monster eats pickup mid-step as soon as cx crosses onto cell');
  assert.ok(gEat.drainEvents().some(e => e.t === 'eat' && e.x === 3 && e.y === 1 && e.name === 'heart'));

  const gArrowEat = new Game(lvl(['1.<']), { players: [0] });
  const mArrow = new Monster(2, 1, 3, 0, 0); mArrow.speed = 2.0; gArrowEat.monsters.push(mArrow);
  gArrowEat.items.set(1 * W + 3, { name: 'purpleGem', age: 0 }); // item sits on wrong-way < arrow cell (3,1)
  gArrowEat.stepMover(mArrow, 0.35, () => 0); // clamps at touch limit p = 0.56 -> cx = 3
  assert.equal(mArrow.cx, 3);
  assert.equal(gArrowEat.items.size, 0, 'monster touching wrong-way arrow eats pickup at (m.cx, m.cy)');
  assert.ok(gArrowEat.drainEvents().some(e => e.t === 'eat' && e.x === 3 && e.y === 1 && e.name === 'purpleGem'));

  // 4. Fireball / electric bolts pass over cauldrons; teleported cauldron re-checks wind, conveyor & vent
  const gProj = new Game(lvl(['>.#......'], { starts: { 1: [1, 1] } }), { players: [0] });
  const pp = gProj.players[0]; pp.invuln = 10; pp.dir = 0;
  pp.place(4, 1); gProj.applyPickup(pp, 'glassWind'); gProj.usePower(pp); // wind East covers all free tiles (4..9, 1)
  pp.place(2, 1); gProj.placeBomb(pp, 'fire');
  const bTarget = gProj.bombs[0];
  pp.place(1, 1); pp.dir = 0;
  gProj.applyPickup(pp, 'glassFire'); pp.cooldown = 0; gProj.usePower(pp);
  assert.equal(gProj.projs.length, 1, 'fireball fired'); run(gProj, 0.5);
  assert.equal(gProj.bombs.length, 1, 'fireball passes over cauldron without detonating it');
  gProj.applyPickup(pp, 'glassElectric'); pp.cooldown = 0; gProj.usePower(pp);
  assert.equal(gProj.projs.length, 1, 'electric bolt fired'); run(gProj, 0.5);
  assert.equal(gProj.bombs.length, 1, 'electric bolt passes over cauldron without detonating it');
  gProj.applyPickup(pp, 'glassTeleport'); pp.cooldown = 0; gProj.usePower(pp);
  assert.equal(gProj.projs.length, 1, 'teleport bolt fired'); run(gProj, 0.25);
  assert.ok(bTarget.cx >= 4, `teleport bolt warped cauldron into wind corridor, got cx=${bTarget.cx}`);
  assert.equal(bTarget.slide?.d, 0, 'teleported cauldron starts sliding East in landing wind zone');
  assert.equal(bTarget.slide?.wind, true);

  const gBeltTp = new Game(lvl(['1..Ro']), { players: [0] });
  const bBelt = { id: 951, x: 1, y: 1, cx: 1, cy: 1, owner: 0, range: 4, fuse: 5, age: 0, kind: 'fire', vent: -1, slide: null, sp: 0, rx: 1, ry: 1, prx: 1, pry: 1 };
  gBeltTp.bombs.push(bBelt);
  gBeltTp.freeCells = () => [[4, 1]]; // R conveyor tile
  gBeltTp.teleportBomb(bBelt);
  assert.equal(bBelt.slide?.d, 0, 'teleportBomb starts sliding on landing conveyor belt');
  assert.equal(bBelt.slide?.wind, false);
  gBeltTp.freeCells = () => [[5, 1]]; // o air supply vent tile
  gBeltTp.teleportBomb(bBelt);
  assert.ok(bBelt.vent >= 0 && bBelt.range === 1, 'teleportBomb landing on vent sets vent and range 1');
});

test('monster intelligence matches FRACAS.EXE: dead-end bomb survival, mid-step reversal, LoS scan past pickups/players, scent interrupt & snapshot BFS', () => {
  // 1. Dead-end bomb survival (bit 4, 0x11654): monster retreats to dead end and holds position safely until blast clears
  const gDead = new Game(lvl(['1###', '####', '....']), { players: [0], seed: 3, freeze: 0 });
  gDead.players[0].place(1, 1); gDead.players[0].invuln = 1e6; gDead.players[0].ghost = 1e6;
  const mDead = new Monster(2, 3, 3, 3, 1.875); // beh 3 -> iq 0x30 (bit4 + bit5)
  gDead.monsters = [mDead];
  gDead.bombs.push({ id: 960, x: 4, y: 3, cx: 4, cy: 3, owner: 0, range: 1, fuse: 1.5, age: 0, kind: 'fire', vent: -1 });
  run(gDead, 2.2);
  assert.equal(mDead.alive, true, 'monster retreats into dead end (1,3) and waits safely rather than wandering back into bomb');
  assert.equal(mDead.cx, 1);
  assert.equal(mDead.cy, 3);

  // 2a. Mid-step bomb reversal (0x11585 / 0x11d48): bomb placed ahead causes immediate 180° mid-tile reversal
  const gRevBomb = new Game(lvl(['1.....']), { players: [0], seed: 4, freeze: 0 });
  gRevBomb.players[0].place(1, 1); gRevBomb.players[0].invuln = 1e6; gRevBomb.players[0].ghost = 1e6;
  const mRevB = new Monster(2, 1, 3, 3, 1.875);
  mRevB.tx = 2; mRevB.ty = 1; mRevB.nx = 3; mRevB.ny = 1; mRevB.p = 0.4;
  mRevB.dir = 0; mRevB.stepDir = 0; mRevB.stepSpeed = mRevB.speed; mRevB.moving = true;
  gRevBomb.monsters = [mRevB];
  gRevBomb.bombs.push({ id: 961, x: 5, y: 1, cx: 5, cy: 1, owner: 0, range: 3, fuse: 2.0, age: 0, kind: 'fire', vent: -1 });
  gRevBomb.update(1 / 60);
  assert.equal(mRevB.stepDir, 2, 'mid-step monster reverses 180° West immediately when bomb threatens ahead East');

  // 2b. Mid-step projectile reversal (0x118bd / 0x11d48): incoming projectile triggers immediate mid-tile reversal
  const gRevProj = new Game(lvl(['1.....']), { players: [0], seed: 5, freeze: 0 });
  gRevProj.players[0].place(1, 1); gRevProj.players[0].invuln = 1e6; gRevProj.players[0].ghost = 1e6;
  const mRevP = new Monster(2, 1, 3, 3, 1.875);
  mRevP.tx = 2; mRevP.ty = 1; mRevP.nx = 3; mRevP.ny = 1; mRevP.p = 0.4;
  mRevP.dir = 0; mRevP.stepDir = 0; mRevP.stepSpeed = mRevP.speed; mRevP.moving = true;
  gRevProj.monsters = [mRevP];
  gRevProj.projs.push({ id: 962, x: 5.5, y: 1.5, px: 5.5, py: 1.5, d: 2, owner: 0, spell: 'fire', life: 2 });
  gRevProj.update(1 / 60);
  assert.equal(mRevP.stepDir, 2, 'mid-step monster reverses 180° West immediately against incoming projectile');

  // 3. scanLoS scans past adjacent pickup for full dist & bombs behind pickup, but terminates ray at a visible player (0x11a25..0x11c80)
  const gLoS = new Game(lvl(['#1####', '######', '......']), { players: [0], seed: 6, freeze: 0 });
  gLoS.players[0].place(2, 1); gLoS.players[0].invuln = 1e6; gLoS.players[0].ghost = 1e6;
  gLoS.items.set(3 * W + 2, { name: 'heart', age: 1 });     // adjacent pickup at k=1 from (1,3)
  const losPickup = scanLoS(gLoS, 1, 3);
  assert.equal(losPickup[0].item, true, 'sees adjacent pickup');
  assert.equal(losPickup[0].dist, 5, 'dist scans full corridor past adjacent pickup');

  gLoS.bombs.push({ id: 963, x: 5, y: 3, cx: 5, cy: 3, owner: 0, range: 2, fuse: 2.0, age: 0, kind: 'fire', vent: -1 });
  const mGreed = new Monster(1, 3, 3, 12, 1.875); // beh 12 -> iq 0x3d (has bit2 pickup + bit4 flee bomb)
  gLoS.monsters = [mGreed];
  assert.equal(decide(gLoS, mGreed), -1, 'does not charge uncovered pickup when a bomb sits behind it in the same corridor');

  gLoS.players[0].place(4, 3); gLoS.players[0].ghost = 0; // player at k=3 in front of bomb at k=4 (5,3)
  const losPlayer = scanLoS(gLoS, 1, 3);
  assert.equal(losPlayer[0].player, true, 'sees visible player past pickup');
  assert.equal(losPlayer[0].playerDist, 3);
  assert.equal(losPlayer[0].dist, 2, 'dist counts only tiles strictly before player');
  assert.equal(losPlayer[0].bomb, false, 'player terminates LoS ray so bombs behind player are not seen');

  // 3b. Level 16 screenshot repro: [1,7,2,6] (iq 0x11) behind player at (2,7) with bomb at (6,7) kills player instead of freezing
  const gL16 = new Game(data.normal[15], { players: [0], seed: 1, freeze: 0 });
  gL16.players[0].place(2, 7); gL16.players[0].invuln = 0;
  gL16.terrain[7 * W + 4] = T.FLOOR;
  const mSlug = gL16.monsters.find(m => m.tx === 1 && m.ty === 7);
  gL16.bombs.push({ id: 964, x: 6, y: 7, cx: 6, cy: 7, owner: 0, range: 2, fuse: 3.0, age: 0, kind: 'fire', vent: -1 });
  assert.equal(decide(gL16, mSlug), 0, 'monster at (1,7) steps East onto player (2,7) rather than freezing over bomb behind player');
  run(gL16, 1.0);
  assert.equal(gL16.players[0].alive, false, 'Level 16 monster moves East and kills wizard');

  // 3c. buildBfsGrid ignores bombs so dropping a bomb on the player tile does not disable BFS pathfinding (0x1217e)
  const gBfsBomb = new Game(lvl(['1.....', '####..', '......']), { players: [0], seed: 9, freeze: 0 });
  gBfsBomb.players[0].place(1, 1);
  gBfsBomb.bombs.push({ id: 965, x: 1, y: 1, cx: 1, cy: 1, owner: 0, range: 1, fuse: 3.0, age: 0, kind: 'fire', vent: -1 });
  const mHuntB = new Monster(1, 3, 3, 15, 1.875); // beh 15 -> iq 0x21 (bit0 BFS + bit5 dodge, no bit4 flee bomb)
  mHuntB.smart = true;
  gBfsBomb.monsters = [mHuntB];
  assert.equal(decide(gBfsBomb, mHuntB), 0, 'BFS still routes East around wall toward player even with bomb on target tile');

  // 4a. Scent interruption (bit 1, 0x11874): interrupts active walkLeft > 0 patrol as soon as scented tile is entered
  const gScent = new Game(lvl(['1#...', '.....', '##.##']), { players: [0], seed: 7, freeze: 0 });
  gScent.players[0].place(1, 1); gScent.players[0].invuln = 1e6; gScent.players[0].ghost = 1e6;
  const mScent = new Monster(3, 2, 2, 2, 1.875); // beh 2 -> iq 0x02 (bit1 scent)
  mScent.dir = 0; mScent.walkLeft = 4;
  gScent.scent[2 * W + 3] = 0.5; // current tile
  gScent.scent[3 * W + 3] = 0.9; // South branch has stronger scent
  gScent.monsters = [mScent];
  const dScent = decide(gScent, mScent);
  assert.equal(dScent, 1, 'interrupts active walkLeft patrol to follow stronger scent South');
  assert.equal(mScent.aiState, 4, 'entered scent state 4');

  // 4b. Snapshot BFS hunt (bit 0, 0x115f7): follows stored bfsGrid across multiple steps to target tile
  const gBfs = new Game(lvl(['1#....', '.#.##.', '......']), { players: [0], seed: 8, freeze: 0 });
  gBfs.players[0].place(1, 3);
  const mBfs = new Monster(3, 1, 3, 6, 1.875); // beh 6 -> iq 0x11
  mBfs.smart = true;
  gBfs.monsters = [mBfs];
  assert.equal(decide(gBfs, mBfs), 1, 'starts BFS hunt South from (3,1)');
  assert.equal(mBfs.aiState, 3, 'entered snapshot BFS hunt state 3');
  const savedGrid = mBfs.bfsGrid;
  assert.ok(savedGrid instanceof Int16Array, 'stores 21x15 bfsGrid snapshot');
  // Move player away while monster follows its snapshot grid down the corridor toward (1,3)
  gBfs.players[0].place(6, 2);
  mBfs.place(3, 2);
  assert.equal(decide(gBfs, mBfs), 1, 'continues down stored bfsGrid to (3,3)');
  assert.equal(mBfs.bfsGrid, savedGrid, 'reuses stored snapshot bfsGrid without re-locking every step');
  mBfs.place(3, 3);
  assert.equal(decide(gBfs, mBfs), 2, 'turns West at (3,3) along stored bfsGrid toward (1,3)');
  mBfs.place(2, 3);
  assert.equal(decide(gBfs, mBfs), 2, 'takes final BFS step into original target tile (1,3)');
  assert.equal(mBfs.aiState, 1, 'exits BFS hunt state upon stepping onto snapshot target');
});

test('EXP_FIRE connected flame segments have seamless opaque edges in atlas_hd.png and composite via flameBuf', () => {
  // 1. Decode atlas_hd.png (RGBA 8-bit) and check connected tile boundaries of EXP_FIRE/5, EXP_FIRE/10, EXP_FIRE/15
  const atlasMeta = JSON.parse(readFileSync(new URL('../assets/atlas.json', import.meta.url))).frames;
  const png = readFileSync(new URL('../assets/atlas_hd.png', import.meta.url));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const idat = [];
  for (let off = 8; off < png.length;) {
    const len = png.readUInt32BE(off), tag = png.toString('ascii', off + 4, off + 8);
    if (tag === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0, pos = 0; y < height; y++) {
    const ft = raw[pos++], rowOff = y * stride, prevOff = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[rowOff + i - 4] : 0;
      const b = y > 0 ? rgba[prevOff + i] : 0;
      const c = y > 0 && i >= 4 ? rgba[prevOff + i - 4] : 0;
      let p = 0;
      if (ft === 1) p = a;
      else if (ft === 2) p = b;
      else if (ft === 3) p = (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      rgba[rowOff + i] = (raw[pos++] + p) & 0xff;
    }
  }
  const alphaAt = (fx, fy, dx, dy) => rgba[((fy + dy) * width + (fx + dx)) * 4 + 3];

  const [f5x, f5y, f5w, f5h] = atlasMeta['EXP_FIRE/5'];
  assert.equal(alphaAt(f5x, f5y, f5w >> 1, 0), 255, 'EXP_FIRE/5 top connected edge is fully opaque');
  assert.equal(alphaAt(f5x, f5y, f5w >> 1, f5h - 1), 255, 'EXP_FIRE/5 bottom connected edge is fully opaque');
  for (let py = 0; py < f5h; py++) {
    assert.equal(alphaAt(f5x, f5y, f5w >> 1, py), 255, `EXP_FIRE/5 center column y=${py} is opaque`);
  }

  const [f10x, f10y, f10w, f10h] = atlasMeta['EXP_FIRE/10'];
  assert.equal(alphaAt(f10x, f10y, 0, f10h >> 1), 255, 'EXP_FIRE/10 left connected edge is fully opaque');
  assert.equal(alphaAt(f10x, f10y, f10w - 1, f10h >> 1), 255, 'EXP_FIRE/10 right connected edge is fully opaque');
  for (let px = 0; px < f10w; px++) {
    assert.equal(alphaAt(f10x, f10y, px, f10h >> 1), 255, `EXP_FIRE/10 center row x=${px} is opaque`);
  }

  const [f15x, f15y, f15w, f15h] = atlasMeta['EXP_FIRE/15'];
  assert.equal(alphaAt(f15x, f15y, f15w >> 1, 0), 255, 'EXP_FIRE/15 North edge is opaque');
  assert.equal(alphaAt(f15x, f15y, f15w - 1, f15h >> 1), 255, 'EXP_FIRE/15 East edge is opaque');
  assert.equal(alphaAt(f15x, f15y, f15w >> 1, f15h - 1), 255, 'EXP_FIRE/15 South edge is opaque');
  assert.equal(alphaAt(f15x, f15y, 0, f15h >> 1), 255, 'EXP_FIRE/15 West edge is opaque');

  // Verify HD wizard electrocution skeletons WIZ0..3/21 retain black skull details, white bones & blue X-ray aura
  for (let slot = 0; slot < 4; slot++) {
    const [wx, wy, ww, wh] = atlasMeta[`WIZ${slot}/21`];
    let black = 0, white = 0, blue = 0;
    for (let dy = 0; dy < wh; dy++) for (let dx = 0; dx < ww; dx++) {
      const p = ((wy + dy) * width + (wx + dx)) * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
      if (a >= 200 && r < 20 && g < 20 && b < 20) black++;
      if (a >= 240 && r >= 220 && g >= 220 && b >= 220) white++;
      if (a >= 80 && b > r + 40) blue++;
    }
    assert.ok(black >= 50, `WIZ${slot}/21 skull eye/mouth black pixels missing (${black})`);
    assert.ok(white >= 800, `WIZ${slot}/21 white skeleton bone pixels missing (${white})`);
    assert.ok(blue >= 1000, `WIZ${slot}/21 electric blue X-ray aura missing (${blue})`);
  }

  // 2. Verify Renderer2D composites flames via flameBuf at 1:1 with smoothing disabled
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const mkCanvas = (cw = 800, ch = 600) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops, imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {},
      clip() {}, translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push(['fill', ctx.imageSmoothingEnabled]); },
      stroke() { ops.push(['stroke', ctx.imageSmoothingEnabled]); },
      fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
      measureText: () => ({ width: 12 }),
      drawImage: (img, ...args) => { ops.push(['drawImage', img, ctx.imageSmoothingEnabled, ...args]); },
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }),
      putImageData() {},
    };
    return { width: cw, height: ch, style: {}, _ctx: ctx, getContext: () => ctx, toDataURL: () => '', toBlob: () => {}, addEventListener() {} };
  };
  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    URL.createObjectURL = () => 'blob:flame-test'; URL.revokeObjectURL = () => {};
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 960; globalThis.devicePixelRatio = 1;

    const mainCanvas = mkCanvas(1280, 960);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 256; atlas.naturalHeight = 256; atlas.width = 256; atlas.height = 256;
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));
    const r = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas: null, frames: atlasMeta, monsters: mons, real: null });
    const g = new Game(lvl(['1....', '.....', '.....']), { players: [0], seed: 1 });
    g.flames.set(2 * W + 2, { t: BLAST_TIME, kind: 'fire' });
    g.flames.set(2 * W + 3, { t: BLAST_TIME, kind: 'fire' });
    r.setGame(g);
    mainCanvas._ctx._ops.length = 0;
    r.flameCtx._ops.length = 0;
    r.render(1 / 60, 1);

    const flameVecInBuf = r.flameCtx._ops.filter(op => op[0] === 'stroke' || op[0] === 'fill');
    assert.ok(flameVecInBuf.length >= 6, 'render() draws continuous vector fire waves into flameBuf even in classic mode');
    assert.ok(flameVecInBuf.every(op => op[1] === false), 'flameCtx keeps 1:1 buffer state cleanly during flameBuf assembly');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === r.flameBuf), 'render() composites flameBuf onto main canvas');

    // 3. Verify electrocuted drawWizard alternates between shocked (20) and skeleton (21) per FRACAS.EXE 0xca93
    const pStun = g.players[0];
    pStun.invuln = 0; pStun.stun = 188 / TICK_HZ; // ticks & 15 == 12 (> 7 -> frame 21 skeleton)
    mainCanvas._ctx._ops.length = 0;
    r.render(1 / 60, 1);
    const [s21x, s21y] = atlasMeta['WIZ0/21'];
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === r.atlas && op[3] === s21x && op[4] === s21y),
      'electrocuted wizard draws WIZ0/21 skeleton on odd 8-tick half-cycle');
    pStun.stun = 180 / TICK_HZ; // ticks & 15 == 4 (<= 7 -> frame 20 shocked wizard)
    mainCanvas._ctx._ops.length = 0;
    r.render(1 / 60, 1);
    const [s20x, s20y] = atlasMeta['WIZ0/20'];
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === r.atlas && op[3] === s20x && op[4] === s20y),
      'electrocuted wizard draws WIZ0/20 shocked frame on even 8-tick half-cycle');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('conveyor rules, alignment, bomb subpixel occupancy & 0x0bf96 step parity with FRACAS.EXE', () => {
  const keepAlive = g => { const m = new Monster(20, 14, 0, 0, 0); m.speed = 0; g.monsters.push(m); };

  // 1. Holding perpendicular key crosses open perpendicular exit via FRACAS.EXE 1px snap (0xd2f9..0xd4b8);
  // releasing input on the belt lane rides the belt forward instead
  const gCross = new Game(lvl([
    '1....',
    '#RRRR',
    '#....',
  ]), { players: [0] });
  keepAlive(gCross);
  const pCross = gCross.players[0]; pCross.place(2, 1); pCross.input.dir = 1; // walk South straight through R at (2,2)
  for (let i = 0; i < 45; i++) gCross.update(1 / 31);
  assert.ok(pCross.cx === 2 && pCross.cy === 3, `expected perpendicular hold to exit South at x=2, got (${pCross.cx},${pCross.cy})`);

  // Level 17 (image 1): (9,1) D fed by (10,1) L allows West exit onto cleared (8,1) and Down entry along D's lane
  const gL17a = new Game(data.normal[16], { players: [0] });
  gL17a.monsters.length = 0; keepAlive(gL17a);
  gL17a.terrain[1 * W + 8] = T.FLOOR; // cleared boulder at (8,1) as in screenshot 1
  const pL17a = gL17a.players[0];
  pL17a.place(11, 1); // ride L westward onto (9,1) D corner
  for (let i = 0; i < 80; i++) gL17a.update(1 / 31);
  assert.equal(pL17a.cx, 9); assert.equal(pL17a.cy, 1);
  pL17a.input.dir = 2; // press West from (9,1) D corner -> exits cleanly onto (8,1) without being pulled down D
  for (let i = 0; i < 40; i++) gL17a.update(1 / 31);
  assert.ok(pL17a.cx <= 8 && pL17a.cy === 1, `expected West exit from Level 17 (9,1)D to (8,1), got (${pL17a.cx},${pL17a.cy})`);

  pL17a.place(11, 1); pL17a.input.dir = -1; // ride L onto (9,1) D corner, then press Down to ride D South
  for (let i = 0; i < 80; i++) gL17a.update(1 / 31);
  pL17a.input.dir = 1;
  for (let i = 0; i < 40; i++) gL17a.update(1 / 31);
  assert.ok(pL17a.cx === 9 && pL17a.cy >= 2, `expected Down on (9,1)D corner to enter D lane, got (${pL17a.cx},${pL17a.cy})`);

  // Centered on (9,1) D with open West (8,1): holding West exits instead of getting sucked South down D
  pL17a.place(9, 1); pL17a.input.dir = 2;
  for (let i = 0; i < 20; i++) gL17a.update(1 / 31);
  assert.ok(pL17a.cx <= 8 && pL17a.cy === 1, `expected centered (9,1)D West exit to (8,1), got (${pL17a.cx},${pL17a.cy})`);

  // Level 17 (image 2): (19,7) U -> (19,6) L corner allows pressing Left to enter L, or Up if (19,5) is cleared
  const gL17b = new Game(data.normal[16], { players: [0] });
  gL17b.monsters.length = 0; keepAlive(gL17b);
  const pL17b = gL17b.players[0];
  pL17b.place(19, 8); pL17b.input.dir = -1; // ride U up onto (19,6) L corner ((19,5) has boulder '%')
  for (let i = 0; i < 90; i++) gL17b.update(1 / 31);
  assert.equal(pL17b.cx, 19); assert.equal(pL17b.cy, 6);
  pL17b.input.dir = 2; // press Left on (19,6) L corner -> glides onto L axis and moves West onto (17,6)
  for (let i = 0; i < 25; i++) gL17b.update(1 / 31);
  assert.ok(pL17b.cx <= 17 && pL17b.cy === 6, `expected Left on Level 17 (19,6)L corner to ride L, got (${pL17b.cx},${pL17b.cy})`);

  gL17b.terrain[5 * W + 19] = T.FLOOR; // clear (19,5) boulder as in screenshot 2 -> holding Up exits North cleanly
  pL17b.place(19, 8); pL17b.input.dir = -1;
  for (let i = 0; i < 90; i++) gL17b.update(1 / 31);
  pL17b.input.dir = 3;
  for (let i = 0; i < 40; i++) gL17b.update(1 / 31);
  assert.ok(pL17b.cx === 19 && pL17b.cy <= 5, `expected Up exit from (19,6)L to cleared (19,5), got (${pL17b.cx},${pL17b.cy})`);

  // Exception: if belt cannot push forward (blocked by wall), wizard exits straight across
  const gBlockedBelt = new Game(lvl([
    '1..',
    '#R#',
    '#.#',
  ]), { players: [0] });
  keepAlive(gBlockedBelt);
  const pBlocked = gBlockedBelt.players[0]; pBlocked.place(2, 1); pBlocked.input.dir = 1;
  for (let i = 0; i < 40; i++) gBlockedBelt.update(1 / 31);
  assert.equal(pBlocked.cx, 2);
  assert.equal(pBlocked.cy, 3, 'crosses straight South when forward belt direction is blocked by wall');

  // 2. Off-axis on belt: idle has NO backward suction & parallel key cannot corner-round ([0xc48b] = -1)
  const gOff = new Game(lvl(['1RRRR']), { players: [0] });
  keepAlive(gOff);
  const pOff = gOff.players[0]; pOff.fx = 2.5; pOff.fy = 1.65;
  for (let i = 0; i < 31; i++) gOff.update(1 / 31);
  assert.ok(Math.abs(pOff.fx - 2.5) < 1e-6 && Math.abs(pOff.fy - 1.65) < 1e-6, `off-axis idle must stay put, got (${pOff.fx},${pOff.fy})`);
  pOff.input.dir = 0; // parallel East while off-axis
  for (let i = 0; i < 15; i++) gOff.update(1 / 31);
  assert.ok(Math.abs(pOff.fx - 2.5) < 1e-6 && Math.abs(pOff.fy - 1.65) < 1e-6, `off-axis parallel key must not corner-round back to 1.5, got (${pOff.fx},${pOff.fy})`);

  // 3. Reliable perpendicular exit at corridor opening (both normal & Speed Boots at 31 Hz)
  for (const spd of [PLAYER_SPEED, PLAYER_SPEED * 2]) {
    const gExit = new Game(lvl([
      '1RRRR',
      '##.##',
    ]), { players: [0] });
    keepAlive(gExit);
    const pExit = gExit.players[0]; pExit.speed = spd; pExit.place(1, 1);
    pExit.input.dir = 0;
    for (let i = 0; i < 10; i++) gExit.update(1 / 31); // ride/run onto belt
    pExit.input.dir = 1; // hold Down waiting for opening at x=3
    for (let i = 0; i < 80; i++) gExit.update(1 / 31);
    assert.equal(pExit.cx, 3, `speed=${spd} failed to turn out at x=3 corridor (at x=${pExit.cx}, fx=${pExit.fx.toFixed(3)})`);
    assert.equal(pExit.cy, 2);
  }

  // 4. Corner conveyor (0x0c538): passive idle stops at D corner entry; pressing R centers onto D to ride South
  const gCorner = new Game(lvl([
    '1RRD',
    '...D',
    '...D',
  ]), { players: [0] });
  keepAlive(gCorner);
  const pCor = gCorner.players[0]; pCor.place(2, 1);
  for (let i = 0; i < 120; i++) gCorner.update(1 / 31);
  assert.equal(pCor.cx, 4, 'passive wizard reaches D corner tile x=4');
  assert.equal(pCor.cy, 1, 'passive wizard stops at D corner off-axis without auto-turning South');
  pCor.input.dir = 0; // nudge East onto D's vertical centerline
  for (let i = 0; i < 60; i++) gCorner.update(1 / 31);
  assert.ok(pCor.cy >= 2 && pCor.cx === 4, `manual R enters D axis and rides South, got (${pCor.cx},${pCor.cy})`);

  // 5. Holding oppBelt against blocked wall stays planted at centerB with zero oscillation
  const gOpp = new Game(lvl([
    '####',
    '#..1',
  ]), { players: [0] });
  keepAlive(gOpp);
  gOpp.feat[2 * W + 2] = { k: 'walk', d: 0 }; // (2,2) R right next to wall # at (1,2)
  const pOpp = gOpp.players[0]; pOpp.place(2, 2); pOpp.input.dir = 2;
  let maxFx = 0;
  for (let i = 0; i < 40; i++) {
    gOpp.update(1 / 31);
    maxFx = Math.max(maxFx, pOpp.fx);
    assert.ok(Math.abs(pOpp.fx - 2.5) < 1e-6, `holding oppBelt against wall oscillated to fx=${pOpp.fx}`);
  }
  assert.equal(maxFx, 2.5);
  assert.equal(pOpp.dir, 2);

  // 6. 0x0bf96 adjacent bomb check: plain floor blocks entry onto bomb on walk; standing ON walk allows stepping over bomb
  const gBombStep = new Game(lvl(['1.RR']), { players: [0] });
  const pB = gBombStep.players[0]; pB.place(2, 1); // plain floor at (2,1), adjacent to R at (3,1)
  gBombStep.bombs.push({ id: 990, x: 3, y: 1, cx: 3, cy: 1, owner: 0, range: 2, fuse: 5, age: 0, kind: 'fire', vent: -1, slide: null, sp: 0, rx: 3, ry: 1, prx: 3, pry: 1 });
  assert.equal(gBombStep.canStep(pB, 2, 1, 0), false, 'plain floor blocks stepping onto adjacent bomb on walk tile');
  pB.place(3, 1); // standing ON R walk tile
  gBombStep.bombs[0] = { id: 991, x: 4, y: 1, cx: 4, cy: 1, owner: 0, range: 2, fuse: 5, age: 0, kind: 'fire', vent: -1, slide: null, sp: 0, rx: 4, ry: 1, prx: 4, pry: 1 };
  assert.equal(gBombStep.canStep(pB, 3, 1, 0), true, 'standing ON walk tile allows stepping onto bomb');

  // 7. Sliding bomb keeps logical (b.cx, b.cy) on (b.x, b.y) until sp >= 1, prevents second bomb overlap & carries fractional sp cleanly
  const gBS = new Game(lvl([
    '1#####',
    'RRRRR.',
  ]), { players: [0] });
  keepAlive(gBS);
  const b1 = { id: 992, x: 1, y: 2, cx: 1, cy: 2, owner: 0, range: 1, fuse: 5, age: 0, kind: 'fire', vent: -1, slide: null, sp: 0, rx: 1, ry: 2, prx: 1, pry: 2 };
  gBS.bombs.push(b1);
  for (let i = 0; i < 12; i++) gBS.update(1 / 31); // ~0.726 tiles (< 1.0, > 0.5)
  assert.ok(b1.sp > 0.5 && b1.sp < 1, `expected 0.5 < sp < 1, got ${b1.sp}`);
  assert.equal(b1.cx, 1, 'mid-slide bomb (>0.5sp) still logically occupies origin tile x=1');
  assert.equal(b1.cy, 2);
  assert.ok(b1.rx > 1.5, 'visual rx interpolates smoothly past 1.5');
  assert.ok(gBS.anyBombAt(1, 2) === b1 && !gBS.anyBombAt(2, 2), 'anyBombAt matches origin tile (1,2) until sp >= 1');
  for (let i = 0; i < 65; i++) gBS.update(1 / 31); // slides all the way to (5,2) and stops before plain floor (6,2)
  assert.equal(b1.x, 5);
  assert.equal(b1.sp, 0, 'stops flush at sp=0 at belt end without floor overhang');
  assert.equal(b1.rx, 5);
});

test('Renderer2D unified visual mode, unified player & monster burning dissolve, portal descent, teleport split, status auras, and Life Exchange portraits', () => {
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const mkCanvas = (cw = 800, ch = 600) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops, imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {},
      ellipse(...a) { ops.push(['ellipse', ...a]); },
      rect(...a) { ops.push(['rect', ...a]); },
      roundRect() {}, clip() { ops.push('clip'); },
      translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', t]); }, strokeText(t) { ops.push(['strokeText', t]); },
      measureText: () => ({ width: 20 }),
      drawImage: (img, ...args) => { ops.push(['drawImage', img, ctx.globalAlpha, ...args]); },
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }),
      putImageData() {},
    };
    return { width: cw, height: ch, style: {}, _ctx: ctx, getContext: () => ctx, toDataURL: () => '', toBlob: () => {}, addEventListener() {} };
  };
  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    URL.createObjectURL = () => 'blob:render-fx-test'; URL.revokeObjectURL = () => {};
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 960; globalThis.devicePixelRatio = 1;

    const mainCanvas = mkCanvas(1280, 960);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 2048; atlas.naturalHeight = 2598; atlas.width = 2048; atlas.height = 2598;
    const hdAtlas = new globalThis.Image();
    hdAtlas.complete = true; hdAtlas.naturalWidth = 2048; hdAtlas.naturalHeight = 2598; hdAtlas.width = 2048; hdAtlas.height = 2598;
    const atlasMeta = JSON.parse(readFileSync(new URL('../assets/atlas.json', import.meta.url))).frames;
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));

    const rFallback = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas: null, frames: atlasMeta, monsters: mons, real: null });
    assert.equal(rFallback.atlas, atlas, 'Renderer2D falls back to image when hdAtlas is absent');

    const r = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas, frames: atlasMeta, monsters: mons, real: null });
    assert.equal(r.atlas, hdAtlas, 'Renderer2D uses unified hdAtlas when available');
    assert.equal(r.useHD, undefined, 'Renderer2D no longer keeps split useHD mode');

    const g = new Game(lvl(['1...2', '.....', '.....']), { players: [0, 1], seed: 1 });
    g.players[1] = Object.assign(Object.create(Object.getPrototypeOf(g.players[0])), g.players[0], { slot: 1, id: 99, lives: 0, out: true });
    r.setGame(g);

    // 1. hitPose uses unified hdAtlas
    const p0 = g.players[0];
    const [c22x, c22y] = atlasMeta['WIZ0/22'];
    r.render(1 / 60, 1);
    mainCanvas._ctx._ops.length = 0;
    r.hitPose(mainCanvas._ctx, p0, 100, 100);
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && op[3] === c22x && op[4] === c22y), 'hitPose draws WIZ0/22 from unified atlas');

    // 2. Unified player fire death executes shudder -> thermal dissolve WIZ0/22:mdis* + WIZ0/23..27 flames and finishes after 140/31s
    const fireYs = new Set(Array.from({ length: 5 }, (_, i) => atlasMeta[`WIZ0/${23 + i}`][1]));
    r.deaths.set(0, { t: 0, fire: true, x: 1.5, y: 1.5 });
    mainCanvas._ctx._ops.length = 0;
    r.drawDeath(p0, 100, 100, 0.05);
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && op[3] === c22x && op[4] === c22y), 'early player fire death draws WIZ0/22 reeling pose');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && fireYs.has(op[4])), 'early player fire death overlays WIZ0/23..27 flames');
    mainCanvas._ctx._ops.length = 0;
    r.drawDeath(p0, 100, 100, 2.0);
    assert.ok(r._fxCache.has('WIZ0/22:mdis2') || r._fxCache.has('WIZ0/22:mdis1'), 'mid player fire death generates cached thermal dissolve WIZ0/22:mdis* sprite');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && fireYs.has(op[4])), 'mid player fire death renders WIZ0/23..27 fire overlay');
    mainCanvas._ctx._ops.length = 0;
    r.drawDeath(p0, 100, 100, 2.6);
    assert.equal(mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage').length, 0, 'player fire death finishes cleanly after 140/31s');

    // 3. Unified monster death executes the same thermal dissolve mdis1..4 + WIZ0/23..27 flames and finishes cleanly after 140/31s
    p0.alive = false; p0.out = true; p0.deadT = 9;
    g.monsters.forEach(m => { m.alive = false; });
    r.dying = [{ x: 3.5, y: 4.5, key: `${mons[3].file}/0`, type: 3, t: 0, boss: false }];
    mainCanvas._ctx._ops.length = 0;
    r.drawActors(2.0, 1);
    assert.ok(r._fxCache.has(`${mons[3].file}/0:mdis2`) || r._fxCache.has(`${mons[3].file}/0:mdis1`), 'monster death generates cached thermal dissolve mdis* sprite');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && fireYs.has(op[4])), 'monster death renders WIZ0/23..27 fire overlay');
    r.drawActors(2.6, 1);
    assert.equal(r.dying.length, 0, 'dying monster finishes dissolve after 140/31s');

    // 4. Portal rift descent uses curved elliptical clip + WIZ0 walk sprite + portal silhouette rim
    g.portal = { x: 4, y: 2 };
    p0.alive = true; p0.out = false; p0.exited = true;
    r.portalEntries.set(0, { x: 3.5, y: 2.5, t: 0, dur: 1.06, dir: 0 });
    mainCanvas._ctx._ops.length = 0;
    r.drawPortalSink(p0, 0.45);
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas), 'portal descent draws wizard sprite from atlas');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'ellipse'), 'portal descent clips and ripples along elliptical well curve');
    assert.ok([...r._fxCache.keys()].some(k => k.startsWith('WIZ0/') && k.endsWith(':portal')), 'portal descent generates teal-emerald rim silhouette wash');
    r.portalEntries.clear();

    // 5. Teleport holographic split, radiation sigil/dome & invulnerability sanctuary aura
    p0.exited = false; p0.tpPhase = 'hide'; p0.tpTimer = 1.5; p0.tpDur = 3.0;
    mainCanvas._ctx._ops.length = 0;
    r.drawWizard(p0, 2.5, 2.5, 0.016);
    assert.ok([...r._fxCache.keys()].some(k => k.endsWith(':tpCyan')) && [...r._fxCache.keys()].some(k => k.endsWith(':tpMag')),
      'teleport hide phase renders chromatic tpCyan/tpMag holographic echoes');
    p0.tpPhase = null; p0.radiation = 4.0; p0.invuln = 2.0;
    mainCanvas._ctx._ops.length = 0;
    r.drawWizard(p0, 2.5, 2.5, 0.016);
    assert.ok(mainCanvas._ctx._ops.filter(op => op[0] === 'ellipse').length >= 6,
      'radiation & invulnerability render layered ground sigils, Fresnel shells, and orbital arcs');

    // 6. Life Exchange portraits draw WIZ0/0 & WIZ1/0 from unified atlas + flying heart transfer
    r.lifeEx = { leftSlot: 0, rightSlot: 1, hover: null, flashL: 0, flashR: 0.16 };
    p0.lives = 3;
    mainCanvas._ctx._ops.length = 0;
    r.drawLifeExchange();
    const [w0x, w0y] = atlasMeta['WIZ0/0'];
    const [w1x, w1y] = atlasMeta['WIZ1/0'];
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && op[3] === w0x && op[4] === w0y),
      'Life Exchange left pod renders WIZ0/0 portrait');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === hdAtlas && op[3] === w1x && op[4] === w1y),
      'Life Exchange right pod renders WIZ1/0 portrait');
    assert.ok(mainCanvas._ctx._ops.some(op => op[0] === 'fillText' && op[1] === '♥'),
      'Life Exchange renders flying ♥ transfer animation on flash spike');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('ClassicMenu drawSelect draws sel_wiz0..3 & sel_cage and options has no Characters toggle', () => {
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const mkCanvas = (cw = 1920, ch = 1080) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops, imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {}, clip() {},
      translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', t]); }, strokeText(t) { ops.push(['strokeText', t]); },
      measureText: () => ({ width: 80 }),
      drawImage: (img, ...args) => { ops.push(['drawImage', img, ...args]); },
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      putImageData() {},
    };
    return {
      width: cw, height: ch, style: {}, _ctx: ctx,
      getContext: () => ctx, toDataURL: () => '', addEventListener() {},
    };
  };
  try {
    const classicCanvas = mkCanvas(1920, 1080);
    globalThis.document = {
      getElementById: id => (id === 'classic' ? classicCanvas : null),
      createElement: () => mkCanvas(128, 72),
    };
    globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1;

    const mkClassicSpr = (w, h) => Object.assign(new globalThis.Image(), { width: w, height: h, naturalWidth: w, naturalHeight: h });
    const classicArt = {
      logo_hd: mkClassicSpr(400, 150),
      sel_cage: mkClassicSpr(176, 276),
      sel_wiz0: mkClassicSpr(92, 240), sel_wiz1: mkClassicSpr(92, 240),
      sel_wiz2: mkClassicSpr(92, 240), sel_wiz3: mkClassicSpr(92, 240),
      sel_btn0: mkClassicSpr(116, 64), sel_btn1: mkClassicSpr(116, 64),
      sel_btn2: mkClassicSpr(116, 64), sel_btn3: mkClassicSpr(116, 64),
    };
    const app = {
      save: { quality: 'high', sfx: 0.8, music: 0, bright: 1, preset: 'classic', dark: false },
      art: {},
      data,
      input: new Input(),
      audio: { init() {}, play() {} },
      renderers: {},
    };
    const menu = new ClassicMenu(app, classicArt);
    menu.open('options');
    assert.equal(menu.items().some(it => it.label === 'Characters'), false, 'Options menu has no Characters toggle in unified mode');

    menu.open('select', { mode: 'story', level: 1 });
    menu.devices = ['kb0', 'kb1', null, null];
    menu.joinT = [0.85, 0.20, 0, 0];

    classicCanvas._ctx._ops.length = 0;
    menu.draw();
    for (let k = 0; k < 4; k++) {
      assert.ok(classicCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === classicArt[`sel_wiz${k}`]),
        `player-select draws sel_wiz${k}`);
    }
    assert.ok(classicCanvas._ctx._ops.some(op => op[0] === 'drawImage' && op[1] === classicArt.sel_cage),
      'player-select draws sel_cage');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
  }
});

test('FRACAS.EXE fuse, explosion durations (16t/64t/54t), cross-kind flame blocking, spell+bomb placement, and GET READY freeze parity', () => {
  assert.equal(FUSE, 130 / TICK_HZ, 'fuse matches 130 ticks at 31 Hz');
  assert.equal(BLAST_TIME, 16 / TICK_HZ, 'fire blast lasts 16 ticks');
  assert.equal(BLAST_TIMES.electric, 64 / TICK_HZ, 'electric blast lasts 64 ticks');
  assert.equal(BLAST_TIMES.magic, 54 / TICK_HZ, 'magic blast lasts 54 ticks');

  // Default level-start GET READY freeze duration is 62 / 31 (2.0s)
  const gFreeze = new Game0(lvl(['1....']), { players: [0] });
  assert.equal(gFreeze.freeze, 62 / TICK_HZ, 'GET READY freeze matches 62 ticks (0x13bb2)');

  // Fire, electric, and magic cauldron explosions last 16, 64, and 54 ticks respectively
  for (const [kind, ticks] of [['fire', 16], ['electric', 64], ['magic', 54]]) {
    const g = new Game(lvl(['1........']), { players: [0] });
    const p = g.players[0]; p.place(1, 1); p.range = 3;
    g.placeBomb(p, kind);
    p.place(8, 1);
    g.bombs[0].fuse = 1 / TICK_HZ;
    g.update(1 / TICK_HZ); // explodes and ticks 1st flame tick
    assert.ok(g.flames.has(1 * W + 1), `${kind}: flame active on burst tick`);
    for (let t = 1; t < ticks - 1; t++) g.update(1 / TICK_HZ);
    assert.ok(g.flames.has(1 * W + 1), `${kind}: flame still active at tick ${ticks - 1}`);
    g.update(1 / TICK_HZ);
    assert.equal(g.flames.has(1 * W + 1), false, `${kind}: flame ends after ${ticks} ticks`);
  }

  // Cross-kind rays stop at active flames of a different kind (0xf8ba)
  const gCross = new Game(lvl(['1........']), { players: [0] });
  gCross.flames.set(1 * W + 3, { t: 1.0, maxT: 2.0, owner: 0, kind: 'electric', hit: new Set() });
  const pCross = gCross.players[0]; pCross.place(1, 1); pCross.range = 5;
  gCross.placeBomb(pCross, 'fire');
  gCross.bombs[0].fuse = 0;
  gCross.update(1 / 60);
  assert.ok(gCross.flames.has(1 * W + 2), 'fire reaches tile before electric flame');
  assert.equal(gCross.flames.get(1 * W + 3)?.kind, 'electric', 'fire ray stops before entering active electric flame');
  assert.equal(gCross.flames.has(1 * W + 4), false, 'fire ray does not pass beyond electric flame');

  // Holding/pressing Spell key when p.power === null or 'foot' does not block Bomb placement
  const gKey = new Game(lvl(['1........']), { players: [0] });
  const pKey = gKey.players[0]; pKey.bombsMax = 2;
  pKey.input.bomb = true; pKey.input.power = true; pKey.input.powerHeld = true;
  gKey.updatePlayer(pKey, 1 / 60);
  assert.equal(gKey.bombs.length, 1, 'bomb placed when Spell key held with no power');
  gKey.bombs.length = 0;
  gKey.applyPickup(pKey, 'foot');
  pKey.input.bomb = true; pKey.input.power = true; pKey.input.powerHeld = true;
  gKey.updatePlayer(pKey, 1 / 60);
  assert.equal(gKey.bombs.length, 1, 'bomb placed when Spell key held with Speed Boots (foot)');
});

test('wall spikes: phase-locked telegraph/extension, GET READY & stasis freeze, network sync, and 2x-SSAA vector sprites', () => {
  // 1. computeSpikeState & spikeVisualState: smooth telegraph 0..15t, full ext===1 across lethal [15t,36t), retraction 36..55t, and out override
  const sPre = computeSpikeState(10 / TICK_HZ, 20);
  assert.equal(sPre.active, false);
  assert.equal(sPre.out, false);
  assert.deepEqual(spikeVisualState(sPre.ph, sPre.out, sPre.active), { ext: 0, warn: 0 });

  const sWarn = computeSpikeState((21 + 9) / TICK_HZ, 20);
  assert.equal(sWarn.active, true);
  assert.equal(sWarn.out, false);
  const vWarn = spikeVisualState(sWarn.ph, sWarn.out, sWarn.active);
  assert.ok(vWarn.ext > 0.35 && vWarn.ext < 0.5 && vWarn.warn === 1, 'telegraph partially extends with full warning cue before lethal frame');

  for (const tk of [15, 22, 35.5]) {
    const sOut = computeSpikeState((21 + tk) / TICK_HZ, 20);
    assert.equal(sOut.out, true);
    const vOut = spikeVisualState(sOut.ph, sOut.out, sOut.active);
    assert.equal(vOut.ext, 1, `spike fully extended at tick ${tk}`);
    assert.equal(vOut.warn, 1);
  }

  const sRet = computeSpikeState((21 + 45) / TICK_HZ, 20);
  assert.equal(sRet.out, false);
  const vRet = spikeVisualState(sRet.ph, sRet.out, sRet.active);
  assert.ok(vRet.ext > 0.1 && vRet.ext < 0.9, 'retraction smoothly eases back from 1 -> 0');

  // Out flag always guarantees full extension even if ph is missing/stale
  assert.deepEqual(spikeVisualState(undefined, true, false), { ext: 1, warn: 1 });
  assert.deepEqual(spikeVisualState(0, true, true), { ext: 1, warn: 1 });

  // 2. GET READY freeze does not burn spike initial delay; Chrono Stasis pauses spike clock cleanly
  const lFreeze = lvl(['1....']);
  lFreeze.spikes = [[3, 1, 0, 40]]; // firstActive = 41/31s = 1.32s
  const gFr = new Game0(lFreeze, { players: [0], freeze: 2.0 });
  for (let k = 0; k < 121; k++) gFr.update(1 / 60); // 2.0s GET READY (with IEEE-754 margin)
  assert.ok(gFr.freeze <= 0);
  gFr.update(1 / 60); // 1st active frame after freeze
  const fFr = gFr.feat[1 * W + 3];
  assert.equal(fFr.out, false, 'spike respects delay after GET READY instead of jumping straight into lethal state');
  assert.equal(fFr.active, false);

  // Advance until lethal, then trigger stasis and confirm phase freezes cleanly
  for (let k = 0; k < 120; k++) {
    gFr.update(1 / 60);
    if (fFr.out) break;
  }
  assert.equal(fFr.out, true, 'spike enters lethal phase after delay + telegraph');
  const frozenPh = fFr.ph;
  gFr.stasis = 2.0;
  for (let k = 0; k < 30; k++) gFr.update(1 / 60);
  assert.equal(fFr.ph, frozenPh, 'Chrono Stasis freezes spike phase cleanly');

  // 3. Online snapshot serialization & hydration syncs spikeTime, f.ph, f.active, and server-authoritative f.out
  const lNet = lvl(['1.....']);
  lNet.spikes = [[3, 1, 1, 0], [4, 1, 3, 20]];
  const gSrv = new Game(lNet, { players: [0] });
  gSrv.time = 0.6;
  gSrv.stasisPaused = 0.1;
  gSrv.updateSpikes();
  const { snap } = serializeGame(gSrv, [], { full: true });
  assert.ok(typeof snap.spikeTime === 'number' && Math.abs(snap.spikeTime - 0.5) < 0.03);

  const gCli = createClientGame(lNet, { players: [0] });
  applySnapshot(gCli, snap, 1);
  assert.equal(gCli.feat[1 * W + 3].out, gSrv.feat[1 * W + 3].out);
  assert.ok(Math.abs(gCli.feat[1 * W + 3].ph - gSrv.feat[1 * W + 3].ph) < 0.02, 'client spike phase synced from snapshot');
  assert.equal(gCli.feat[1 * W + 3].active, gSrv.feat[1 * W + 3].active);
  assert.equal(gCli.feat[1 * W + 4].active, false, 'delayed spike still inactive before firstActive on client');

  // 4. Renderer2D 2x-SSAA wall spike sprites (0..3), invalid wall fallback, zero atlas draws, and surface recovery
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const mkCanvas = (w = 800, h = 600) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops,
      imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {},
      clip() {}, translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); },
      stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); },
      strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', t]); },
      strokeText(t) { ops.push(['strokeText', t]); },
      measureText: () => ({ width: 12 }),
      drawImage: img => { ops.push(['drawImage', img?.width || 0, img?.height || 0, img]); },
      createRadialGradient: () => grad,
      createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }),
      putImageData() {},
    };
    return {
      width: w, height: h, style: {}, _ctx: ctx,
      getContext: () => ctx, toDataURL: () => '', toBlob: () => {}, addEventListener() {},
    };
  };
  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class {
      constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
      set src(_) {}
    };
    URL.createObjectURL = () => 'blob:spike-test';
    URL.revokeObjectURL = () => {};
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 960; globalThis.devicePixelRatio = 1;

    const mainCanvas = mkCanvas(1280, 960);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 256; atlas.naturalHeight = 256; atlas.width = 256; atlas.height = 256;
    const frames = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.includes('/') ? [0, 0, 16, 16, 0, 0] : undefined) });
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));

    const r = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas: null, frames, monsters: mons, real: null });
    for (let w = 0; w < 4; w++) {
      const sock = r.getSpikeSocketSprite(w);
      const blade = r.getSpikeBladeSprite(w);
      assert.equal(sock.size, 256, `wall ${w} socket sprite is 256x256 (2x SSAA)`);
      assert.equal(blade.size, 256, `wall ${w} blade sprite is 256x256 (2x SSAA)`);
      assert.ok(sock.canvas._ctx._ops.includes('fill') && sock.canvas._ctx._ops.includes('stroke'));
      assert.ok(blade.canvas._ctx._ops.includes('fill') && blade.canvas._ctx._ops.includes('stroke'));
    }

    const gRen = new Game(lvl(['1.....', '......']), { players: [0] });
    r.setGame(gRen);
    r.activeFeat = [];
    for (let w = 0; w < 5; w++) {
      const idxCell = 1 * W + (2 + w);
      gRen.feat[idxCell] = { k: 'spike', wall: w === 4 ? 99 : w, delay: 0, ph: 0.2, active: true, out: w % 2 === 0 };
      r.activeFeat.push(idxCell);
    }
    mainCanvas._ctx._ops.length = 0;
    r.drawFeatures(1 / 60);
    assert.equal(mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && op[3] === r.atlas).length, 0,
      'rebuilt wall spikes draw zero blurry atlas sprites');
    const spikeCanvasSet = new Set([0, 1, 2, 3].flatMap(w => [r.getSpikeSocketSprite(w).canvas, r.getSpikeBladeSprite(w).canvas]));
    const spikeDraws = mainCanvas._ctx._ops.filter(op => op[0] === 'drawImage' && spikeCanvasSet.has(op[3]));
    assert.equal(spikeDraws.length, 10, '5 wall spikes each draw cached 2x-SSAA blade + socket');

    const staleSock = r.getSpikeSocketSprite(0).canvas;
    const staleBlade = r.getSpikeBladeSprite(0).canvas;
    r.recoverSurfaces();
    assert.notEqual(r.getSpikeSocketSprite(0).canvas, staleSock, 'recoverSurfaces rebuilds spike socket cache');
    assert.notEqual(r.getSpikeBladeSprite(0).canvas, staleBlade, 'recoverSurfaces rebuilds spike blade cache');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('L-shaped door, one-way arrow, and wind gate parity with FRACAS.EXE (0xc48d, 0xf856, 0x100c8, 0xc13c)', () => {
  // 1. Blast ray hitting already-closed door side keeps state and emits no spurious door event (0xf856 / 0xf987)
  const lDoor = lvl(['1.....', '##.###', '......']);
  lDoor.doors = [[3, 2, 1]]; // allows South (1), state 0
  const g1 = new Game(lDoor, { players: [0] });
  const df1 = g1.feat[2 * W + 3];
  g1.drainEvents();
  g1.bombs.push({ id: 801, x: 3, y: 3, cx: 3, cy: 3, owner: 0, range: 3, fuse: 0.01, age: 0, kind: 'fire', vent: -1 });
  run(g1, 0.05);
  assert.equal(df1.state, 0, 'blast from closed South side keeps door at state 0');
  assert.equal(df1.allow, 1, 'door still allows South');
  assert.equal(g1.drainEvents().some(e => e.t === 'door'), false, 'no phantom door flip event emitted when state unchanged');

  // Blast from open North side flips door to state 4 and emits door event
  g1.flames.clear();
  g1.bombs.push({ id: 802, x: 3, y: 1, cx: 3, cy: 1, owner: 0, range: 3, fuse: 0.01, age: 0, kind: 'fire', vent: -1 });
  run(g1, 0.05);
  assert.equal(df1.state, 4, 'blast from open North side flips door to state 4');
  assert.equal(df1.allow, 3, 'door now allows North');
  assert.equal(g1.drainEvents().some(e => e.t === 'door'), true, 'door flip event emitted when state changes');

  // 2. Half-open door (state 1..3) allows passage from both ends (0xc4d6..0xc4f9) and stationary/stunned player does not overwrite blast flip
  const g2 = new Game(lDoor, { players: [0] });
  const p2 = g2.players[0];
  const df2 = g2.feat[2 * W + 3];
  df2.state = 2; // half-open state, while df2.flipped is still false
  assert.equal(g2.canStep(p2, 3, 1, 1), true, 'half-open door allows entry South');
  assert.equal(g2.canStep(p2, 3, 3, 3), true, 'half-open door allows entry North');
  assert.equal(g2.canStep(p2, 2, 2, 0), false, 'half-open N-S door still blocks perpendicular East');

  p2.place(3, 2);
  p2.stun = 1.0; // stationary & stunned inside door cell
  g2.flipDoor(2 * W + 3, 4);
  g2.updatePlayer(p2, 1 / 60);
  assert.equal(df2.state, 4, 'stationary/stunned player inside door does not overwrite blast flip state');
  assert.equal(df2.allow, 3);

  // 3. Projectile hitting target inside open door cell still completes the door flip (0x100c8..0x10130)
  const g3 = new Game(lDoor, { players: [0] });
  const p3 = g3.players[0];
  const df3 = g3.feat[2 * W + 3];
  const mDoor = new Monster(3, 2, 3, 0, 0);
  mDoor.ty = 2; mDoor.ny = 3; mDoor.p = 0.2; mDoor.stepDir = 1; mDoor.stepSpeed = 0; mDoor.moving = true;
  g3.monsters.push(mDoor);
  p3.place(3, 1);
  g3.fire(p3, 1, 'fire', 8);
  run(g3, 0.3);
  assert.equal(mDoor.alive, false, 'projectile hit monster inside door cell');
  assert.equal(df3.state, 4, 'projectile terminating inside door cell completes flip to state 4');
  assert.equal(df3.allow, 3, 'door now allows North');

  // 4. Wind zone opposing one-way arrow gate cannot push a mid-step monster backwards through wrong-way arrow (0xc13c..0xc17a)
  const lWind = lvl(['1#..>.', '######']);
  const g4 = new Game(lWind, { players: [0] });
  g4.players[0].invuln = 10;
  // Wind blowing West (d=2) at (6, 1) where monster is finishing East step from '>' (5, 1) -> (6, 1)
  g4.winds.push({ owner: 0, x: 6, y: 1, cells: new Map([[1 * W + 6, 2]]), arms: [0, 0, 0, 0], t: 5, max: 5, id: 99 });
  const mWind = new Monster(5, 1, 3, 0, 1.0); // slower than WALKWAY_SPEED (1.875)
  mWind.tx = 5; mWind.ty = 1; mWind.nx = 6; mWind.ny = 1; mWind.p = 0.6;
  mWind.dir = 0; mWind.stepDir = 0; mWind.stepSpeed = 1.0; mWind.moving = true;
  g4.monsters.push(mWind);
  g4.stepMover(mWind, 1 / 31, () => 0);
  assert.notEqual(mWind.stepDir, 2, 'wind did not reverse monster backwards across wrong-way > arrow');
  assert.ok(mWind.cx >= 6, 'monster did not get pushed back onto > arrow tile (5,1)');
});

test('diagonal secDir corridor turning, pillar alignment (fx=2.75), late-turn snap-back, and Input secDir', () => {
  // 1. Input.read exposes secDir for simultaneous perpendicular keys
  const inp = new Input();
  inp.down.add('KeyG'); inp.pressed.add('KeyG'); // Right (dir=0)
  let r = inp.read('kb0');
  assert.equal(r.dir, 0);
  assert.equal(r.secDir, -1);
  inp.endFrame();
  inp.down.add('KeyF'); inp.pressed.add('KeyF'); // Down (dir=1) while Right still held
  r = inp.read('kb0');
  assert.equal(r.dir, 1);
  assert.equal(r.secDir, 0);

  // 2. Diagonal secDir movement along a walled corridor turns automatically at intersection
  const g1 = new Game(lvl([
    '1......',
    '###.###',
    '###.###',
  ]), { players: [0] });
  g1.demo = true;
  const p1 = g1.players[0];
  p1.input.dir = 1; // Down (blocked until x=4)
  p1.input.secDir = 0; // East along corridor
  run(g1, 1.3);
  assert.equal(p1.cx, 4, 'walked east via secDir until intersection at x=4');
  assert.ok(p1.cy >= 2, 'turned south automatically into intersection: cy=' + p1.cy);

  // 3. Pillar intersection alignment: at fx=2.75 with wall at (3,2), pressing Down aligns back to x=2.5 and enters (2,2)
  const g2 = new Game(lvl([
    '1....',
    '#.#.#',
    '#.#.#',
  ]), { players: [0] });
  g2.demo = true;
  const p2 = g2.players[0];
  p2.place(2, 1); p2.fx = 2.75; p2.fy = 1.5; p2.lastDir = 0;
  p2.input.dir = 1; p2.input.secDir = -1;
  run(g2, 0.35);
  assert.equal(p2.cx, 2, 'aligned back into column 2 instead of overshooting into pillar');
  assert.ok(p2.cy >= 2, 'entered south corridor (2,2): cy=' + p2.cy);

  // 4. Late-turn snap-back: slightly inside (3,1) at fx=3.12 with wall at (3,2), pressing Down snaps back into (2,2)
  const g3 = new Game(lvl([
    '1....',
    '#.#.#',
    '#.#.#',
  ]), { players: [0] });
  g3.demo = true;
  const p3 = g3.players[0];
  p3.place(3, 1); p3.fx = 3.12; p3.fy = 1.5; p3.lastDir = 0;
  p3.input.dir = 1; p3.input.secDir = -1;
  run(g3, 0.4);
  assert.equal(p3.cx, 2, 'late-turn snap-back returned from 3.12 into open column 2');
  assert.ok(p3.cy >= 2, 'late-turn entered south corridor (2,2): cy=' + p3.cy);

  // 5. Fixed 4-way D-Pad touch evaluation: deadzone, clear arms, and 1.25x angular hysteresis
  assert.equal(evalTouch4Way(3, 4, -1, 9), -1, 'inside center deadzone stays neutral');
  assert.equal(evalTouch4Way(40, 0, -1, 9), 0, 'right arm selects East');
  assert.equal(evalTouch4Way(0, 40, -1, 9), 1, 'bottom arm selects South');
  assert.equal(evalTouch4Way(-40, 0, -1, 9), 2, 'left arm selects West');
  assert.equal(evalTouch4Way(0, -40, -1, 9), 3, 'top arm selects North');
  assert.equal(evalTouch4Way(20, 22, 0, 9), 0, '1.25x hysteresis prevents jitter at 48 deg when holding East');
  assert.equal(evalTouch4Way(20, 26, 0, 9), 1, 'deliberate cross past 1.25x switches cleanly to South');

  // 6. Spatial-trail Swipe-and-Hold controller: starts on 9px swipe, holds across thumb arcs, turns/reverses on 13px stroke
  let pts = [{ x: 100, y: 300 }];
  let sw = evalSwipeStep(pts, 105, 300, -1, 9, 13);
  assert.equal(sw.dir, -1, 'tiny 5px tap does not start moving');
  sw = evalSwipeStep(pts, 111, 300, -1, 9, 13);
  assert.equal(sw.dir, 0, '11px right swipe immediately starts East');
  assert.equal(sw.reset, true);

  // Gentle thumb arc while sweeping 60px right stays locked East
  pts = [{ x: 111, y: 300 }, { x: 125, y: 302 }, { x: 140, y: 305 }, { x: 155, y: 308 }];
  sw = evalSwipeStep(pts, 170, 311, 0, 9, 13);
  assert.equal(sw.dir, 0, 'gentle vertical thumb arc stays locked East');
  assert.equal(sw.reset, false);

  // Short 15px downward flick from current end turns immediately South
  pts.push({ x: 170, y: 311 }, { x: 171, y: 318 });
  sw = evalSwipeStep(pts, 171, 326, 0, 9, 13);
  assert.equal(sw.dir, 1, '15px downward flick immediately turns South');
  assert.equal(sw.reset, true);

  // Short 15px upward flick reverses immediately North
  pts = [{ x: 171, y: 326 }, { x: 171, y: 340 }, { x: 171, y: 355 }, { x: 171, y: 348 }];
  sw = evalSwipeStep(pts, 171, 340, 1, 9, 13);
  assert.equal(sw.dir, 3, '15px upward reversal immediately turns North');
  assert.equal(sw.reset, true);
});

test('Game deterministic replay + saveState/loadState/exportState/importState parity', () => {
  const level = data.normal[9];
  const makeInputs = f => ({
    0: { dir: (f >> 4) % 4, secDir: -1, bomb: f === 5 || f === 120, power: f === 12 || f === 80, bombHeld: false, powerHeld: false },
    1: { dir: ((f + 16) >> 4) % 4, secDir: -1, bomb: f === 20, power: false, bombHeld: false, powerHeld: false },
  });
  const gA = new Game(level, { mode: 'normal', players: [0, 1], seed: 987654321 });
  const gB = new Game(level, { mode: 'normal', players: [0, 1], seed: 987654321 });
  gA.players[0].power = 'stoneElectric'; gA.players[0].powerTime = 10;
  gB.players[0].power = 'stoneElectric'; gB.players[0].powerTime = 10;

  let snapSaved = null, snapExported = null;
  for (let f = 0; f < 240; f++) {
    const inp = makeInputs(f);
    for (const g of [gA, gB]) {
      g.players[0].input = { ...inp[0] };
      g.players[1].input = { ...inp[1] };
      g.update(TICK);
    }
    if (f === 85) {
      snapSaved = gA.saveState();
      snapExported = gA.exportState();
    }
  }
  assert.equal(gA.stateChecksum(), gB.stateChecksum(), 'two instances with identical seed & inputs stay 100% deterministic');
  const endChecksum = gA.stateChecksum();

  // Roll back gA to frame 85 via saveState/loadState and diverge first to prove restoration actually rewinds everything
  gA.players[0].fx += 3; gA.bombs.length = 0;
  assert.notEqual(gA.stateChecksum(), endChecksum);
  gA.loadState(snapSaved);
  for (let f = 86; f < 240; f++) {
    const inp = makeInputs(f);
    gA.players[0].input = { ...inp[0] };
    gA.players[1].input = { ...inp[1] };
    gA.update(TICK);
  }
  assert.equal(gA.stateChecksum(), endChecksum, 'loadState rollback reproduces exact checksum');

  // Verify JSON exportState/importState recovery reproduces identical stateChecksum too
  const gC = new Game(level, { mode: 'normal', players: [0, 1], seed: 111 });
  gC.importState(JSON.parse(JSON.stringify(snapExported)));
  for (let f = 86; f < 240; f++) {
    const inp = makeInputs(f);
    gC.players[0].input = { ...inp[0] };
    gC.players[1].input = { ...inp[1] };
    gC.update(TICK);
  }
  assert.equal(gC.stateChecksum(), endChecksum, 'JSON exportState/importState produces identical checksum');
});

test('Renderer2D low quality fastFx mode avoids heavy surfaces/clipping and handles quality switches cleanly', () => {
  assert.equal(QUALITY.low.fastFx, true);
  assert.equal(QUALITY.low.glows, false);
  assert.equal(QUALITY.low.realBake, false);
  assert.equal(QUALITY.low.dpr, 1);

  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevMatch = globalThis.matchMedia;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;

  const mkCanvas = (w = 64, h = 64) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops,
      imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      globalCompositeOperation: 'source-over', globalAlpha: 1, shadowBlur: 0,
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {},
      clip() { ops.push('clip'); }, translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
      fillText() {}, strokeText() {}, measureText: () => ({ width: 12 }),
      drawImage() { ops.push('drawImage'); },
      createRadialGradient: () => { ops.push('createRadialGradient'); return grad; },
      createLinearGradient: () => { ops.push('createLinearGradient'); return grad; },
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => { ops.push('getImageData'); return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }; },
      putImageData() {},
    };
    return { width: w, height: h, style: {}, _ctx: ctx, getContext: () => ctx, toDataURL: () => '', toBlob: () => {}, addEventListener() {} };
  };

  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    globalThis.addEventListener = () => {};
    globalThis.matchMedia = () => ({ matches: true });
    URL.createObjectURL = () => 'blob:low-test';
    URL.revokeObjectURL = () => {};
    globalThis.innerWidth = 800; globalThis.innerHeight = 450; globalThis.devicePixelRatio = 3;

    const mainCanvas = mkCanvas(800, 450);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 256; atlas.naturalHeight = 256; atlas.width = 256; atlas.height = 256;
    const drawnKeys = new Set();
    const frames = new Proxy({}, {
      get: (_, k) => {
        if (typeof k === 'string' && k.includes('/')) { drawnKeys.add(k); return [0, 0, 16, 16, 0, 0]; }
        return undefined;
      },
    });
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));

    const r = new Renderer2D(mainCanvas, 'low', { image: atlas, hdAtlas: null, frames, monsters: mons, real: null });
    assert.equal(mainCanvas.width, 800, 'low quality caps canvas DPR at 1 even when devicePixelRatio=3');
    assert.equal(r.flameBuf, null, 'low quality skips offscreen flameBuf');
    assert.equal(r.wallOverhang, null, 'low quality skips wallOverhang');
    assert.equal(r.vig, null, 'low quality skips vig canvas');
    assert.equal(r.boulders, null, 'low quality skips boulder bakes');
    assert.equal(r.light, null, 'low quality skips lighting canvas when dark=false');

    const lv = lvl(['1>....', '......']);
    lv.vents = [[2, 1, 0]];
    lv.spikes = [[4, 1, 0, 0], [5, 1, 2, 0]];
    const gRen = new Game(lv, { players: [0] });
    gRen.players[0].invuln = 3; gRen.players[0].radiation = 2; gRen.players[0].stun = 1;
    gRen.flames.set(1 * W + 2, { kind: 'fire', t: 0.4, maxT: 0.6, owner: 0 });
    gRen.flames.set(1 * W + 3, { kind: 'electric', t: 0.4, maxT: 0.6, owner: 0, hit: new Set() });
    gRen.flames.set(2 * W + 2, { kind: 'magic', t: 0.4, maxT: 0.6, owner: 0, hit: new Set() });
    gRen.feat[1 * W + 4] = { k: 'spike', wall: 0, delay: 0, ph: 0.3, active: true, out: true };
    gRen.feat[1 * W + 5] = { k: 'spike', wall: 2, delay: 0, ph: 0, active: false, out: false };
    gRen.fire(gRen.players[0], 0, 'fire', 99);
    gRen.fire(gRen.players[0], 1, 'electric', 99);
    gRen.fire(gRen.players[0], 2, 'teleport', 99);
    gRen.makeWindZone(gRen.players[0], PICKUP_INFO.glassWind, [0]);
    gRen.portal = { x: 4, y: 2 };
    r.setGame(gRen);
    r.handle([
      { t: 'boom', x: 2, y: 1, kind: 'fire', cells: [[2, 1], [3, 1]] },
      { t: 'mdie', id: 99, x: 3, y: 2, type: 3 },
      { t: 'die', p: 0, x: 1.5, y: 1.5 },
      { t: 'portal', x: 4, y: 2 },
    ]);
    r.burst(3, 2, '#ff8020', 2000);
    assert.ok(r.particles.length <= 350, 'low quality caps active particles at 350');

    mainCanvas._ctx._ops.length = 0;
    drawnKeys.clear();
    r.render(1 / 60, 0.5);
    const ops = mainCanvas._ctx._ops;
    assert.equal(ops.filter(o => o === 'clip').length, 0, 'low quality renders gameplay with zero main-canvas ctx.clip() calls');
    assert.equal(ops.filter(o => o === 'createRadialGradient' || o === 'createLinearGradient').length, 0,
      'low quality creates zero per-frame gradients on main canvas');
    assert.equal(ops.filter(o => o === 'getImageData').length, 0, 'low quality never runs CPU getImageData dissolve');
    for (const prefix of ['EXP_FIRE/', 'EXP_ELEC/', 'EXP_MAGI/', 'TH_FIRE/', 'TH_ELEC/', 'TH_MAGI/']) {
      assert.ok([...drawnKeys].some(k => k.startsWith(prefix)), `low quality draws original atlas ${prefix}* sprites`);
    }

    r.setQuality('high');
    assert.ok(r.flameBuf !== null && r.vig !== null, 'switching low -> high restores flameBuf and vig');
    r.setQuality('low');
    assert.equal(r.flameBuf, null, 'switching high -> low releases flameBuf');
    assert.equal(r.vig, null, 'switching high -> low releases vig');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    globalThis.matchMedia = prevMatch;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('ClassicMenu clears #ui on open, prevents double-fire update, supports dynamic select keycaps & battle hold guard', () => {
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const mkCanvas = (cw = 1920, ch = 1080) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops, imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {}, clip() {},
      translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', t]); }, strokeText(t) { ops.push(['strokeText', t]); },
      measureText: () => ({ width: 80 }),
      drawImage: (img, ...args) => { ops.push(['drawImage', img, ...args]); },
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      putImageData() {},
    };
    return {
      width: cw, height: ch, style: {}, classList: { add() {}, remove() {}, toggle() {} }, _ctx: ctx,
      getContext: () => ctx, toDataURL: () => '', addEventListener() {},
    };
  };
  try {
    const classicCanvas = mkCanvas(1920, 1080);
    const uiEl = { innerHTML: '<div>stale rebind overlay</div>' };
    globalThis.document = {
      getElementById: id => (id === 'classic' ? classicCanvas : id === 'ui' ? uiEl : null),
      createElement: () => mkCanvas(128, 72),
    };
    globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1;

    const inp = new Input();
    inp.setPreset('modern');
    inp.pads = [{ index: 0, axes: [0, 0], buttons: [] }];
    const app = {
      save: { quality: 'high', sfx: 0.8, music: 0, bright: 1, preset: 'modern', dark: false, best: 1 },
      art: {}, data, input: inp,
      audio: { init() {}, play() {} },
      renderers: {},
      startBattleCalls: 0,
      startBattle() { this.startBattleCalls++; },
      startStoryCalls: 0,
      startStory() { this.startStoryCalls++; },
    };
    const menu = new ClassicMenu(app, { logo_hd: null });

    // 1. ClassicMenu.open clears stale #ui overlay (fixes Rebind -> Back soft-lock)
    menu.open('options');
    assert.equal(uiEl.innerHTML, '', 'ClassicMenu.open clears stale #ui HTML overlay');

    // 2. Main menu exposes Controls directly
    menu.open('main');
    assert.ok(menu.items().some(it => it.label === 'Controls'), 'Main menu exposes Controls');

    // 3. ClassicMenu.update does not double-fire Left + Ok in the same frame
    let leftCount = 0, okCount = 0;
    menu.screen = 'battle';
    menu.items = () => [{ label: 'Test', value: () => '1', left: () => { leftCount++; }, ok: () => { okCount++; } }];
    menu.sel = 0;
    inp.pressed.add('ArrowLeft');
    inp.pressed.add('Enter');
    menu.update(1 / 60);
    assert.equal(leftCount, 1, 'left executes once');
    assert.equal(okCount, 0, 'ok does not double-fire on same frame as left');
    inp.endFrame();

    // 4. Password screen creates Confirm + Back hit boxes
    const realItems = ClassicMenu.prototype.items;
    menu.items = realItems;
    menu.open('password');
    menu.draw();
    assert.ok(menu.boxes.some(b => b.id === 'pw-back') && menu.boxes.some(b => b.id === 'pw-ok'),
      'Password screen exposes clickable Back and Confirm buttons');

    // 5. Select screen shows dynamic WASD keys, supports gamepad clickCard, and guards Battle 1-player hold
    menu.open('select', { mode: 'battle', level: 1 });
    menu.devices = [null, null, null, null];
    menu.clickCard(0); // assigns kb0
    menu.clickCard(1); // assigns kb1
    menu.clickCard(2); // assigns pad0
    assert.deepEqual(menu.devices, ['kb0', 'kb1', 'pad0', null], 'clickCard assigns connected gamepad to 3rd slot');

    // Guard Battle hold when only 1 player joined
    menu.devices = ['kb0', null, null, null];
    menu.joinT = [1.0, 0, 0, 0];
    inp.down.add(inp.keys[0].bomb);
    menu.updateSelect(0.05);
    assert.equal(menu.holding, false, 'holding is disabled in Battle when fewer than 2 players joined');
    inp.down.clear();

    // Story mode draws live WASD labels instead of outdated 1997 key labels
    menu.open('select', { mode: 'story', level: 1 });
    classicCanvas._ctx._ops.length = 0;
    menu.draw();
    const texts = classicCanvas._ctx._ops.filter(o => o[0] === 'fillText').map(o => String(o[1]));
    assert.ok(texts.some(t => t.includes('W/A/S/D')), 'Select screen displays active WASD movement keys');
    assert.ok(texts.some(t => t.includes('BREW SPACE')), 'Select screen displays active WASD brew key');
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
  }
});

function withMockRenderer(fn) {
  const prevDoc = globalThis.document, prevImg = globalThis.Image, prevAddEvt = globalThis.addEventListener;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight, prevDpr = globalThis.devicePixelRatio;
  const prevCreateUrl = URL.createObjectURL, prevRevokeUrl = URL.revokeObjectURL;
  const mkCanvas = (cw = 1280, ch = 960) => {
    const ops = [], grad = { addColorStop() {} };
    const ctx = {
      _ops: ops, imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      isContextLost: () => false,
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {}, clip() {},
      translate() {}, scale() {}, rotate() {}, setLineDash() {},
      fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
      fillText(t) { ops.push(['fillText', String(t)]); }, strokeText(t) { ops.push(['strokeText', String(t)]); },
      measureText: () => ({ width: 50 }),
      drawImage: (img, ...args) => { ops.push(['drawImage', img, ...args]); },
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
      getImageData: (gx, gy, gw, gh) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }),
      putImageData() {},
    };
    return {
      width: cw, height: ch, style: {}, _ctx: ctx,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: cw, height: ch }),
      getContext: () => ctx, toDataURL: () => '', toBlob: () => {}, addEventListener() {},
    };
  };
  try {
    globalThis.document = { createElement: () => mkCanvas(64, 64) };
    globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; } set src(_) {} };
    URL.createObjectURL = () => 'blob:mock'; URL.revokeObjectURL = () => {};
    globalThis.addEventListener = () => {};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 960; globalThis.devicePixelRatio = 1;
    const mainCanvas = mkCanvas(1280, 960);
    const atlas = new globalThis.Image();
    atlas.complete = true; atlas.naturalWidth = 2048; atlas.naturalHeight = 2598; atlas.width = 2048; atlas.height = 2598;
    const atlasMeta = JSON.parse(readFileSync(new URL('../assets/atlas.json', import.meta.url))).frames;
    const mons = JSON.parse(readFileSync(new URL('../assets/monsters.json', import.meta.url)));
    const r = new Renderer2D(mainCanvas, 'high', { image: atlas, hdAtlas: atlas, frames: atlasMeta, monsters: mons, real: null });
    fn(r, mainCanvas);
  } finally {
    globalThis.document = prevDoc; globalThis.Image = prevImg; globalThis.addEventListener = prevAddEvt;
    globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; globalThis.devicePixelRatio = prevDpr;
    URL.createObjectURL = prevCreateUrl; URL.revokeObjectURL = prevRevokeUrl;
  }
}

test('Renderer2D packs HUD into 1 top bar for 1-2 players (incl. solo P3/P4) and 2 bars only for 3-4 players', () => {
  withMockRenderer(r => {
    // Solo P3 (Ember) uses only 1 top HUD bar and never renders ghost PLAYER 1/2/4 slots
    r.setGame(new Game(lvl(['..3..', '.....', '.....']), { players: [2], seed: 1 }));
    assert.equal(r.bars, 1, 'solo P3 renders 1 top HUD bar instead of top + bottom bars');
    r.drawHud();
    const p3Texts = r._hudBars[0].ctx._ops.filter(o => o[0] === 'fillText').map(o => o[1]);
    assert.ok(p3Texts.some(t => t.includes('EMBER') && t.includes('P3')), 'solo P3 label renders on top bar');
    assert.ok(!p3Texts.some(t => t.startsWith('PLAYER ')), 'solo P3 hides empty PLAYER N ghost labels');
    assert.equal(r._hudBars[1], null, 'no second HUD bar allocated for 1 player');

    // Solo P4 and 2-player P3+P4 also fit on 1 top bar
    r.setGame(new Game(lvl(['...4.', '.....', '.....']), { players: [3], seed: 1 }));
    assert.equal(r.bars, 1, 'solo P4 uses 1 HUD bar');
    r.setGame(new Game(lvl(['..34.', '.....', '.....']), { players: [2, 3], seed: 1 }));
    assert.equal(r.bars, 1, '2-player P3+P4 packs into 1 HUD bar');

    // 3 players (P1, P3, P4) use 2 HUD bars cleanly
    r.setGame(new Game(lvl(['1.34.', '.....', '.....']), { players: [0, 2, 3], seed: 1 }));
    assert.equal(r.bars, 2, '3 players use 2 HUD bars');
    r.drawHud();
    const topTexts = r._hudBars[0].ctx._ops.filter(o => o[0] === 'fillText').map(o => o[1]);
    const botTexts = r._hudBars[1].ctx._ops.filter(o => o[0] === 'fillText').map(o => o[1]);
    assert.ok(topTexts.some(t => t.includes('P1')) && topTexts.some(t => t.includes('P3')), '3P packs P1 and P3 onto top bar');
    assert.ok(botTexts.some(t => t.includes('P4')) && botTexts.some(t => t.includes('3P')), '3P puts P4 and team summary on bottom bar');
  });
});

test('shareLivesWithAll, giveLifeToSlot, takeLifeFromSlot and 3-4P Life Exchange UI support sharing hearts with all fallen players', () => {
  // 1. shareLivesWithAll revives all fallen players evenly without starving donors (< 1 heart)
  const g4 = new Game(lvl(['1234.', '.....', '.....']), { players: [0, 1, 2, 3], seed: 1 });
  g4.players[0].lives = 4;
  g4.players[1].lives = 0; g4.players[1].out = true;
  g4.players[2].lives = 0; g4.players[2].out = true;
  g4.players[3].lives = 0; g4.players[3].out = true;
  const revAll = shareLivesWithAll(g4);
  assert.deepEqual(revAll, [{ from: 0, to: 1 }, { from: 0, to: 2 }, { from: 0, to: 3 }], 'revives all 3 fallen players from 4-heart donor');
  assert.deepEqual(g4.players.map(p => p.lives), [1, 1, 1, 1], 'everyone ends with 1 life and donor keeps >= 1');
  assert.ok(g4.players.every(p => !p.out), 'all revived players have out=false');

  // When donor only has 1 spare heart, only 1 fallen teammate is revived and donor stays at 1
  const gLimited = new Game(lvl(['123..', '.....', '.....']), { players: [0, 1, 2], seed: 1 });
  gLimited.players[0].lives = 2;
  gLimited.players[1].lives = 0; gLimited.players[1].out = true;
  gLimited.players[2].lives = 0; gLimited.players[2].out = true;
  const partial = shareLivesWithAll(gLimited);
  assert.equal(partial.length, 1, 'stops once donor has only 1 life left');
  assert.equal(gLimited.players[0].lives, 1, 'donor always keeps 1 life');

  // 2. Per-player giveLifeToSlot / takeLifeFromSlot helpers
  const gManual = new Game(lvl(['1234.', '.....', '.....']), { players: [0, 1, 2, 3], seed: 1 });
  gManual.players[0].lives = 4;
  gManual.players[1].lives = 0; gManual.players[1].out = true;
  gManual.players[2].lives = 0; gManual.players[2].out = true;
  gManual.players[3].lives = 0; gManual.players[3].out = true;
  const lxState = { leftSlot: 0, rightSlot: 1, hover: null, flashL: 0, flashR: 0, transfers: [] };
  assert.deepEqual(giveLifeToSlot(gManual, lxState, 3), { from: 0, to: 3 }, 'giveLifeToSlot sends 1 heart directly to P4');
  assert.equal(gManual.players[3].lives, 1);
  // takeLifeFromSlot moves rightSlot away from already-revived P4 toward remaining fallen players (P2/P3)
  assert.deepEqual(takeLifeFromSlot(gManual, lxState, 0), { from: 0, to: 1 }, 'takeLifeFromSlot prioritizes remaining fallen P2');
  assert.deepEqual(takeLifeFromSlot(gManual, lxState, 0), { from: 0, to: 2 }, 'next takeLifeFromSlot prioritizes remaining fallen P3');
  assert.equal(takeLifeFromSlot(gManual, lxState, 0), null, 'donor with 1 heart left cannot give more');

  // 3. Renderer2D 4-player Life Exchange exposes per-card +1 / -1 + Revive All hit targets & draws all pods
  withMockRenderer((r, mainCanvas) => {
    const gUi = new Game(lvl(['1234.', '.....', '.....']), { players: [0, 1, 2, 3], seed: 1 });
    gUi.players[0].lives = 4;
    gUi.players[1].lives = 0; gUi.players[2].lives = 0; gUi.players[3].lives = 0;
    r.setGame(gUi);
    r.lifeEx = { leftSlot: 0, rightSlot: 1, hover: null, flashL: 0, flashR: 0, transfers: [{ from: 0, to: 2, seq: 1 }] };

    const lay = r.lifeExchangeLayout();
    assert.equal(lay.multi, true, '4P uses multi-player Life Exchange layout');
    assert.equal(lay.pods.length, 4, '4P layout displays all 4 player pods simultaneously');
    assert.ok(lay.shareAll, '4P layout exposes REVIVE ALL FALLEN button when fallen players can be helped');

    const toClient = b => [(b.x + b.w / 2) * r.scale + r.ox, (b.y + b.h / 2) * r.scale + r.oy];
    assert.deepEqual(r.lifeExchangeHit(...toClient(lay.pods[2].giveBtn)), { kind: 'giveTo', slot: 2 });
    assert.deepEqual(r.lifeExchangeHit(...toClient(lay.pods[0].takeBtn)), { kind: 'takeFrom', slot: 0 });
    assert.deepEqual(r.lifeExchangeHit(...toClient(lay.shareAll)), { kind: 'shareAll' });
    assert.deepEqual(r.lifeExchangeHit(...toClient(lay.confirm)), { kind: 'confirm' });

    mainCanvas._ctx._ops.length = 0;
    r.drawLifeExchange();
    const lxTexts = mainCanvas._ctx._ops.filter(o => o[0] === 'fillText').map(o => o[1]);
    assert.ok(lxTexts.includes('REVIVE ALL FALLEN ♥'), 'renders REVIVE ALL FALLEN CTA');
    assert.ok(lxTexts.includes('♥'), 'renders flying heart animation from lx.transfers');
  });
});

console.log(`${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
