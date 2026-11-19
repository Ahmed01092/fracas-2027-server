// node tests/wallcheck.mjs — simulate every level with wandering wizards and report any actor whose body
// overlaps a wall or rock tile (they must only ever stand on open floor)
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/sim.js';
import { W, T } from '../src/game/constants.js';

const data = JSON.parse(readFileSync(new URL('../data/levels.json', import.meta.url)));
let bad = 0;
for (const l of [...data.normal, ...data.battle]) {
  const battle = l.world === 'Battle';
  const g = new Game(l, { players: [0, 1, 2, 3], mode: battle ? 'battle' : 'normal' });
  for (const p of g.players) p.invuln = 1e9;
  const startRock = new Set(g.monsters.map(m => m.id));       // monsters may start buried in a rock pocket
  const issues = [];
  for (let t = 0; t < 60 * 25; t++) {
    if (t % 37 === 0) for (const p of g.players) p.input.dir = Math.floor(Math.random() * 5) - 1;
    g.update(1 / 60);
    for (const e of [...g.players, ...g.monsters]) {
      if (!e.alive) continue;
      for (const [ox, oy] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
        const cx = Math.floor(e.x + ox), cy = Math.floor(e.y + oy), c = g.terrain[cy * W + cx];
        const rockOk = c === T.ROCK && startRock.has(e.id) && e.tx === e.nx && e.ty === e.ny;
        if ((c === T.WALL || (c === T.ROCK && !rockOk)) && issues.length < 3)
          issues.push(`${e.constructor.name} ${e.slot ?? e.type} at ${e.x.toFixed(2)},${e.y.toFixed(2)} in ${c === T.WALL ? 'wall' : 'rock'} t=${(t / 60).toFixed(1)}s`);
      }
    }
  }
  if (issues.length) { bad++; console.log(`${battle ? 'arena' : 'level'} ${l.id}:`, issues.join(' | ')); }
}
console.log('levels with actors inside walls/rocks:', bad);
