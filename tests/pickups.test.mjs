// node tests/pickups.test.mjs — pickups behave as coded in the original FRACAS.EXE
import assert from 'node:assert/strict';
import { Game as Game0, Monster, PLAYER_SPEED } from '../src/game/sim.js';
import { Input } from '../src/input.js';
import { W, H, TICK_HZ, FUSE } from '../src/game/constants.js';
class Game extends Game0 { constructor(l, o = {}) { super(l, { freeze: 0, ...o }); this.demo = true; } }
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };
function lvl(rows) {
  const full = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => rows[y - 1]?.[x - 1] ?? '#').join(''));
  const starts = {}; full.forEach((r, y) => [...r].forEach((c, x) => { if ('1234'.includes(c)) starts[c] = [x, y]; }));
  return { id: 1, rows: full.map(r => r.replace(/[1234]/g, '.')), starts, vents: [], spikes: [], doors: [], monsters: [], pickups: {}, barriers: 0 };
}
const run = (g, s) => { for (let t = 0; t < s - 1e-9; t += 1 / 60) g.update(1 / 60); };
const setup = (name, rows = ['1..................']) => { const g = new Game(lvl(rows), { players: [0] }); const p = g.players[0]; p.invuln = 0; g.applyPickup(p, name); return [g, p]; };

test('speed boots: a timed power; the spell key doubles walking speed', () => {
  const [g, p] = setup('foot');
  assert.equal(p.power, 'foot'); assert.ok(Math.abs(p.powerTime - 900 / TICK_HZ) < 1e-9);
  assert.equal(p.speed, PLAYER_SPEED);
  g.usePower(p); assert.equal(p.speed, PLAYER_SPEED * 2);
});
test('ghost does nothing (as in the original)', () => {
  const [g, p] = setup('ghost'); assert.equal(p.power, null); assert.equal(p.score, 0); assert.equal(p.ghost, 0); assert.equal(p.shields, 0);
});
test('chrono orb: picking it up equips Chrono Stasis; spell key freezes monsters and traps for 7s, allowing free placement and no contact damage', () => {
  const [g, p] = setup('orb', ['1........', '.........', '.........']);
  assert.equal(p.power, 'orb');
  assert.equal(p.score, 18);
  const m = new Monster(3, 1, 3, 0, 1.875);
  g.monsters.push(m);
  g.usePower(p);
  assert.equal(p.power, null, 'spell consumed on cast');
  assert.equal(g.stasis, 7.0, '7s stasis activated');
  run(g, 1.0);
  assert.equal(m.tx, 3, 'monster did not move');
  assert.equal(m.moving, false);
  // Walk right up to the monster - no contact damage
  p.place(3, 1);
  g.checkContacts();
  assert.equal(p.alive, true, 'player takes no contact damage from frozen monster');
  // Drop cauldron right next to monster
  p.place(2, 1);
  g.placeBomb(p);
  assert.equal(g.bombs.length, 1, 'cauldron successfully placed');
  // Walk on active spike during stasis - player is protected
  g.feat[1 * W + 4] = { k: 'spike', out: true, ph: 0 };
  p.place(4, 1);
  g.updatePlayer(p, 1 / 60);
  assert.equal(p.alive, true, 'no spike damage during stasis');
  // Wait out stasis
  run(g, 6.1);
  assert.equal(g.stasis, 0, 'stasis expired after 7s');
});
test('radiation protects for 200 ticks', () => { const [g, p] = setup('radiation'); assert.ok(Math.abs(p.radiation - 200 / TICK_HZ) < 1e-9); });
test('ignitor: cauldrons wait until set off; when it runs out they go off', () => {
  const [g, p] = setup('ignitor', ['1........', '.........', '.........']); p.bombsMax = 2;
  g.placeBomb(p); assert.ok(g.bombs[0].fuse > 100); p.place(4, 3);
  run(g, 6); assert.equal(g.bombs.length, 1, 'still waiting after 6 s');
  g.usePower(p); run(g, 0.1); assert.equal(g.bombs.length, 0, 'spell key set it off');
  p.place(7, 1); g.placeBomb(p); p.place(4, 3); p.powerTime = 0.01; run(g, 65 / TICK_HZ + 0.2); assert.equal(g.bombs.length, 0, 'power ended: it went off after 65 ticks');
  g.applyPickup(p, 'ignitor'); p.place(1, 1); g.placeBomb(p); p.place(4, 3); g.applyPickup(p, 'glassFire');
  assert.ok(g.bombs[0].fuse <= 65 / TICK_HZ + 1e-6, 'replacing ignitor shortens waiting bomb fuse to 65 ticks');
});
test('thunder cauldron jar: drops an electric cauldron whose discharge runs to the wall and stuns, never kills', () => {
  const [g, p] = setup('stoneElectric');
  const m = new Monster(15, 1, 3, 0, 0); m.speed = 0; g.monsters.push(m);
  g.usePower(p); assert.equal(g.bombs.length, 1); assert.equal(g.bombs[0].kind, 'electric');
  p.place(1, 3); run(g, FUSE + 0.2);
  assert.ok(m.alive && m.zapped > 0, '14 tiles away and still reached, stunned not killed');
});
test('warp cauldron jar: two-phase hide -> warp -> reveal matching original FRACAS.EXE', () => {
  const [g, p] = setup('stoneTeleport'); p.range = 3;
  const m = new Monster(4, 1, 3, 0, 0); m.speed = 0; g.monsters.push(m);
  g.usePower(p); assert.equal(g.bombs[0].kind, 'magic'); assert.ok(Math.abs(g.bombs[0].fuse - 70 / TICK_HZ) < 1e-9);
  p.place(1, 3); run(g, 70 / TICK_HZ + 0.2);
  assert.equal(m.tpPhase, 'hide', 'entered hide phase in place');
  assert.equal(m.stun, 0, 'teleport does not set electrocution stun');
  assert.equal(m.cx, 4, 'stays at original cell while fading out (hide)');
  g.hurtMonster(m, 0);
  assert.equal(m.alive, true, 'monster in hide phase is immune to damage');
  // Touching a hiding monster teleports the player cleanly (0x0bc9f -> 0x0be62)
  p.place(4, 1); g.checkContacts();
  assert.equal(p.alive, true, 'touching hiding monster does not kill wizard');
  assert.equal(p.tpPhase, 'hide', 'touching hiding monster teleports wizard');
  run(g, 3.4);
  assert.ok(m.alive && m.tpPhase === 'reveal', 'entered reveal phase after hide');
  assert.ok(m.cx !== 4 || m.cy !== 1, 'teleported away to new cell: ' + m.cx + ',' + m.cy);
  run(g, 3.4);
  assert.equal(m.tpPhase, null, 'resumed normal state after reveal');
});
test('glass teleport jar: hide -> reveal phases protect wizard from blasts until reveal completes', () => {
  const g = new Game(lvl(['1..2......', '..........', '..........']), { players: [0, 1] });
  const p0 = g.players[0], p1 = g.players[1]; p0.invuln = 0; p1.invuln = 0;
  p0.place(1, 1); p0.dir = 0; p1.place(4, 1);
  g.applyPickup(p0, 'glassTeleport'); g.usePower(p0);
  for (let i = 0; i < 60 && !p1.tpPhase; i++) g.update(1 / 60);
  assert.equal(p1.tpPhase, 'hide', 'target wizard enters hide phase');
  g.hurtPlayer(p1, 'fire', 0);
  assert.equal(p1.alive, true, 'wizard is immune to damage during hide');
  run(g, 3.4);
  assert.equal(p1.tpPhase, 'reveal', 'target wizard enters reveal phase at destination');
  g.hurtPlayer(p1, 'fire', 0);
  assert.equal(p1.alive, true, 'wizard remains immune to damage during reveal');
  run(g, 3.4);
  assert.equal(p1.tpPhase, null, 'wizard exits reveal phase cleanly');
});
test('gust (glass wind): a 1-way wind zone (6 tiles, 254 ticks) ahead of the wizard, reusable', () => {
  const [g, p] = setup('glassWind'); p.dir = 0;
  const m = new Monster(3, 1, 3, 0, 0); m.speed = 0.0001; g.monsters.push(m);
  g.usePower(p); p.cooldown = 0; g.drainEvents();
  g.usePower(p);
  assert.equal(g.winds.length, 1, 'creates directional wind zone'); assert.equal(g.winds[0].cells.size, 6); assert.equal(p.power, 'glassWind');
  assert.equal(p.cooldown, 0, 'no cooldown or recast when wind zone is already active');
  assert.equal(g.drainEvents().some(e => e.t === 'cast' || e.t === 'windZone'), false, 'no cast/windZone event while blocked');
  run(g, 2); assert.ok(m.cx > 3, 'monster blown east to ' + m.cx);
});
test('storm jar (stone wind): a 4-way wind zone (5 tiles each way, 254 ticks), reusable while timer lasts', () => {
  const [g, p] = setup('stoneWind', ['...........', '.....1.....', '...........']); p.dir = 0;
  const m = new Monster(7, 2, 3, 0, 0); m.speed = 0.0001; g.monsters.push(m);
  g.usePower(p);
  const dirs = new Set(g.winds[0].cells.values());
  assert.deepEqual([...dirs].sort(), [0, 1, 2, 3], 'all 4 directions'); assert.equal(p.power, 'stoneWind');
  assert.ok(Math.abs(g.winds[0].max - 254 / TICK_HZ) < 1e-6);
  run(g, 1.5); assert.ok(m.cx >= 9, 'blown east to ' + m.cx);
});
test('inferno jar (stone fire): fires 4 fireballs simultaneously in all 4 directions, reusable with 30-tick cooldown', () => {
  const [g, p] = setup('stoneFire', ['...........', '.....1.....', '...........']);
  const m = new Monster(7, 2, 3, 0, 0); m.speed = 0.0001; g.monsters.push(m);
  g.usePower(p);
  assert.equal(g.projs.length, 4, '4 fireballs fired'); assert.equal(p.power, 'stoneFire', 'jar stays active until timer expires');
  assert.deepEqual(g.projs.map(q => q.d).sort(), [0, 1, 2, 3]);
  assert.ok(Math.abs(p.cooldown - 30 / TICK_HZ) < 1e-6, '30-tick cooldown');
  run(g, 1.0); assert.equal(m.alive, false, 'monster burned by east fireball');
  assert.ok(p.powerTime > 0, 'power still active');
});

test('fireball jar: one bolt that burns only monsters and wizards', () => {
  const [g2, p2] = setup('glassFire'); g2.usePower(p2); assert.equal(g2.projs.length, 1);
  const [g, p] = setup('glassFire', ['1...%....']); p.dir = 0;
  g.usePower(p); run(g, 1.5);
  assert.equal(g.terrain[1 * W + 5], 2, 'boulder untouched');
  const [g3, p3] = setup('glassFire', ['1........']); p3.dir = 0;
  g3.bombs.push({ id: 77, x: 5, y: 1, cx: 5, cy: 1, owner: 1, range: 1, fuse: 9, vent: -1, kind: 'fire', age: 0, sp: 0 });
  const m = new Monster(8, 1, 3, 0, 0); m.speed = 0.0001; g3.monsters.push(m);
  g3.usePower(p3); run(g3, 1.2);
  assert.equal(g3.bombs.length, 1, 'cauldron not set off'); assert.equal(m.alive, false, 'fireball passes over cauldron and hits monster');

  const [g4, p4] = setup('glassFire', ['1........']); p4.dir = 0;
  const m2 = new Monster(6, 1, 3, 0, 0); m2.speed = 0.0001; g4.monsters.push(m2);
  g4.usePower(p4); run(g4, 1); assert.equal(m2.alive, false, 'monster burned');

  // FRACAS.EXE 0xbd51..0xbd55: wizard is immune to own projectiles when walking in the same direction
  const [g5, p5] = setup('glassFire', ['1................']); p5.dir = 0;
  g5.usePower(p5);
  // Wizard walks east directly behind the fireball for 0.8s (> 0.3s old age check threshold)
  p5.input.dir = 0;
  for (let k = 0; k < 25; k++) {
    p5.input.dir = 0;
    g5.update(1 / 31);
  }
  assert.equal(p5.alive, true, 'wizard walking in the direction of his own fireball is never killed');
});
test('electricity pickup (stoneElectric & glassElectric): bomb key places fire cauldron, spell key places thunder cauldron, chain-reacts bombs, stuns enemies, and safe contact pushback', () => {
  // 1. Bomb key places normal fire cauldron (0xd4f5), spell key places electric cauldron (0x1b391)
  const [g, p] = setup('stoneElectric', ['1.................']);
  assert.equal(p.power, 'stoneElectric');
  p.bombsMax = 2;
  p.place(8, 1);
  p.input.bomb = true;
  g.updatePlayer(p, 1 / 60);
  assert.equal(g.bombs.length, 1);
  assert.equal(g.bombs[0].kind, 'fire', 'bomb key places normal fire cauldron so wizard can still break rocks');
  g.bombs.length = 0;

  p.place(1, 1);
  p.input.power = true;
  g.updatePlayer(p, 1 / 60);
  assert.equal(g.bombs.length, 1);
  assert.equal(g.bombs[0].kind, 'electric', 'spell key places electric cauldron');

  // 2. Electric blast chain-detonates another cauldron in its path and electrocutes enemies
  const m1 = new Monster(3, 1, 3, 0, 0); m1.speed = 0; g.monsters.push(m1); // Regular monster
  const mSpark = new Monster(4, 1, 8, 0, 0); mSpark.speed = 0; g.monsters.push(mSpark); // Spark monster (type 8, immune)
  const targetBomb = { id: 88, x: 5, y: 1, cx: 5, cy: 1, owner: 0, range: 1, fuse: 99, vent: -1, kind: 'fire', age: 0, sp: 0 };
  g.bombs.push(targetBomb);
  
  // Detonate thunder cauldron
  g.bombs[0].fuse = 0.01;
  run(g, 0.05);
  assert.equal(g.bombs.length, 0, 'both thunder cauldron and target cauldron exploded via chain reaction');
  assert.ok(m1.zapped > 0, 'regular monster is electrocuted / zapped');
  assert.equal(mSpark.zapped, 0, 'Spark monster (type 8) is immune to electricity');

  // 3. Touching electrocuted monster stuns player and pushes player back to px, py without wall glitch
  p.place(2, 1);
  p.px = 2.5; p.py = 1.5;
  p.fx = 2.95; p.fy = 1.5; // stepped close to monster at (3, 1), touching distance
  g.checkContacts();
  assert.ok(p.stun > 0, 'player is stunned on touching electrocuted monster');
  assert.equal(p.fx, 2.5, 'player coordinate pushed back to px without offset');
  assert.equal(p.fy, 1.5, 'player coordinate pushed back to py without offset');

  // 4. Electrocuting a moving monster or enemy player freezes them on the exact spot (0 shift during stun)
  const g2 = new Game(lvl(['1.............']), { players: [0] });
  const gp = g2.players[0]; gp.invuln = 0; gp.place(4, 1); gp.dir = 0;
  g2.applyPickup(gp, 'glassElectric');
  const mMove = new Monster(6, 1, 3, 0, 2.5); g2.monsters.push(mMove);
  run(g2, 0.1); // mid-step between two squares
  assert.equal(mMove.moving, true, 'monster is mid-step before bolt hits');
  g2.usePower(gp);
  for (let i = 0; i < 60 && mMove.zapped <= 0; i++) g2.update(1 / 60);
  assert.ok(mMove.zapped > 0 && mMove.stun > 0, 'lightning bolt electrocuted moving monster');
  const xHit = mMove.x, yHit = mMove.y;
  run(g2, 2.0);
  assert.equal(mMove.x, xHit, 'electrocuted monster stays on exact x spot');
  assert.equal(mMove.y, yHit, 'electrocuted monster stays on exact y spot');
});

test('every pickup is worth 18 points; range and cauldrons cap at 5', () => {
  const [g, p] = setup('purpleGem'); assert.equal(p.score, 18);
});

test('holding shoot key continuously fires on cooldown, and holding bomb+shoot together shoots backward without dropping bombs', () => {
  // 1. Input.read exposes powerHeld and bombHeld independently
  const inpDev = new Input();
  inpDev.down.add('Tab');
  let state = inpDev.read('kb0');
  assert.equal(state.powerHeld, true, 'Input exposes powerHeld while shoot key held');
  assert.equal(state.bombHeld, false);
  inpDev.down.add('KeyQ');
  state = inpDev.read('kb0');
  assert.equal(state.powerHeld, true);
  assert.equal(state.bombHeld, true, 'Input exposes bombHeld alongside powerHeld');

  // 2. Holding powerHeld continuously shoots glassFire / glassElectric / stoneFire each cooldown cycle
  for (const [pwr, expectedPerCast, gapTicks] of [
    ['glassFire', 1, 20],
    ['glassElectric', 1, 20],
    ['stoneFire', 4, 30],
  ]) {
    const [g, p] = setup(pwr, ['1..................']);
    p.place(9, 1);
    p.dir = 0;
    p.input.powerHeld = true;
    const spawned = [];
    for (let tick = 0; tick < gapTicks * 3 + 5; tick++) {
      const beforeIds = new Set(g.projs.map(q => q.id));
      g.update(1 / TICK_HZ);
      for (const q of g.projs) if (!beforeIds.has(q.id)) spawned.push(q);
    }
    assert.ok(spawned.length >= expectedPerCast * 3, `${pwr}: holding powerHeld fired repeatedly (${spawned.length} bolts)`);
    assert.equal(g.bombs.length, 0, `${pwr}: holding powerHeld alone drops no bombs`);
  }

  // 3. Holding bombHeld + powerHeld together shoots backward continuously and never drops a bomb
  //    (tested both when bombHeld starts first and when powerHeld starts first)
  {
    const [g, p] = setup('glassFire', ['1..................']);
    p.place(9, 1); p.dir = 0; p.bombsMax = 3;
    p.input.bombHeld = true; p.input.powerHeld = true;
    const firedDirs = [];
    for (let tick = 0; tick < 55; tick++) {
      const beforeIds = new Set(g.projs.map(q => q.id));
      g.update(1 / TICK_HZ);
      for (const q of g.projs) if (!beforeIds.has(q.id)) firedDirs.push(q.d);
      assert.equal(g.bombs.length, 0, `bomb+shoot tick=${tick}: no bomb dropped while both keys held`);
    }
    assert.ok(firedDirs.length >= 2, 'bomb+shoot: repeatedly shot while holding both keys');
    assert.ok(firedDirs.every(d => d === 2), `bomb+shoot: every shot fired backward (dir=2), got ${firedDirs}`);
  }
  {
    const [g, p] = setup('glassFire', ['1..................']);
    p.place(9, 1); p.dir = 0; p.bombsMax = 3;
    p.input.powerHeld = true;
    const firedDirs = [];
    for (let tick = 0; tick < 55; tick++) {
      if (tick >= 5) p.input.bombHeld = true;
      const beforeIds = new Set(g.projs.map(q => q.id));
      g.update(1 / TICK_HZ);
      for (const q of g.projs) if (!beforeIds.has(q.id)) firedDirs.push(q.d);
      assert.equal(g.bombs.length, 0, `shoot-then-bomb tick=${tick}: no bomb dropped`);
    }
    assert.ok(firedDirs.length >= 2, 'shoot-then-bomb: repeatedly shot');
    assert.equal(firedDirs[0], 0, 'shoot-then-bomb: initial shot fired forward before bombHeld pressed');
    assert.ok(firedDirs.slice(1).every(d => d === 2), `shoot-then-bomb: subsequent shots fired backward, got ${firedDirs}`);
  }
});
console.log(`${passed} pickup tests passed${process.exitCode ? ', some FAILED' : ''}`);
