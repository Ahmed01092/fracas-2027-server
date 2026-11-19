# Fracas 2027

A modern remake of Fracas (Geckosoft, 1997) that runs in the browser. It uses the game's own sprites, redrawn at
4× resolution, and adds dynamic lighting, glow, particles and screen shake. It runs at 60 fps on ordinary PCs.

## How to play

Double-click **`Play Fracas 2027.bat`**. It opens the game in your browser. Keep the black window open while you play.

To start it by hand, run this from the `FRACAS_2027` folder, then open http://localhost:8128:

```
python tools/serve.py
```

This server stops the browser keeping old copies of the game files, so updates always load.

Opening `index.html` directly does not work, because browsers block the level files when a page is opened that way.

## Controls (the original 1997 keys)

| | Player 1 | Player 2 | Gamepads (players 3 and 4) |
|---|---|---|---|
| Move | R (up), D (left), F (down), G (right) | Arrow keys | Stick or d-pad |
| Drop a cauldron | Q | Enter | A |
| Use spell / jar | Tab | ] | B or X |

- **Pause:** Esc or P.
- **Brightness:** Numpad + and −.
- **WASD layout:** under **Options → Keyboard layout**. You can also rebind any key.
- **Joining:** on the join screen each player presses their cauldron key, then anyone presses their spell key to start.

## Matches the original game

These values were measured by running the original in DOSBox:

| | Original value |
|---|---|
| Wizard speed | 3.75 tiles per second |
| Cauldron fuse | 4.2 seconds |
| Flames last | 0.55 seconds |
| Blast range | starts at 1 tile on normal levels (2–5 in battle arenas); purple gems add 1, up to 5 |
| Cauldrons at once | starts at 1 on normal levels (2–4 in battle arenas); green gems add 1, up to 5 (MAX gives 5 + 5 at once) |
| Lives | 3 |
| Monster speed | the original formula from FRACAS.EXE: about 2.4–3.7 tiles/s at level 1, rising to about 4.2–5.4 tiles/s by level 60 (faster than the wizards); levels 61–100 keep the level-60 speed; every monster type moves at the same speed |

- **Movement:** wizards move freely and stop the moment you release the key. They don't snap from tile to tile.
- **Turning:** a new direction is taken once the wizard lines up with the grid. Until then he keeps going the way he
  was moving, exactly as in the original.
- **Sounds:** all sound effects are the original samples. That includes the cauldron, the explosions, the pickups,
  each monster's own call, "get ready" and the menu sounds. The game program itself shows which sound belongs to
  which event, and recordings of the original game confirmed it.
  - Generated sounds are used only for the door flip, the portal, level won and game over. I couldn't identify the
    original sound for those.
- **Music:** the generated background music is not in the original, so it is off by default
  (**Options → Music**).

## Pickups (exactly as coded in the original FRACAS.EXE)

The game runs at about 31 ticks per second, so the tick counts in the program convert directly into seconds. The
spell key is Tab for player 1 and ] for player 2. Every pickup that does something is worth 18 points.

| Pickup | Effect |
|---|---|
| Green gem | One more cauldron at a time, up to 5 |
| Purple gem | Blast range +1, up to 5 |
| MAX | Range 5 and 5 cauldrons |
| Heart | Extra life |
| Radiation | Protected for about 6.5 s |
| Speed boots | Spell key: double walking speed for the timed power duration (about 29 s) |
| Ignitor (about 39 s) | Your cauldrons don't go off by themselves; the spell key sets off the one closest to going off. When the ignitor runs out, they all go off |
| Fireball jar (about 24 s) | Spell key throws a fireball that burns only monsters and wizards. It stops at boulders and closed doors (hold the cauldron key to throw backwards) |
| Lightning jar (about 29 s) | A bolt that stuns |
| Warp bolt jar (about 39 s) | A bolt that teleports what it hits |
| Gust jar (about 39 s) | Spell key makes a directional wind zone (6 tiles, ~8.2 s) ahead of you that blows monsters, wizards, cauldrons and spells along |
| Inferno jar (about 24 s) | Spell key fires 4 fireballs simultaneously in all 4 directions (30-tick cooldown, reusable while timer lasts) |
| Storm jar (about 29 s) | Spell key makes a 4-way wind zone around you (~8.2 s, up to 5 tiles in every direction), reusable while timer lasts |
| Thunder cauldron jar (about 29 s) | Spell key drops an **electric cauldron** (it uses one of your cauldron slots). Its discharge runs to the walls in four directions and stuns, but never kills or breaks boulders |
| Warp cauldron jar (about 48 s) | Spell key drops a **warp cauldron** with a short fuse (about 2.3 s). Its wave covers your blast range and teleports whatever it reaches |
| Yellow orb | Spell key: Chrono Stasis — freezes monsters, spikes, and electric barriers for 7 s |
| Ghost potion | Nothing, as in the original |

## What's in it

- **Story mode:** all 100 levels. That is the original 60 plus the 40 new ones, which form four worlds with bosses at
  levels 70, 80, 90 and 100.
- **Monsters:** all 19 monster types, including the 12 new ones, each with its own animations and electrocuted frames.
- **Monster brains:** the 16 behaviour profiles, from Wanderer to Hunter.
- **Battle mode:** 2–4 players on 50 arenas, first to 1–9 wins, with electric fences that appear during the round.
- **Pickups:** every pickup and spell jar (fire, lightning, teleport, wind), plus vents, spikes, conveyor belts,
  one-way tiles and flip doors.
- **Passwords:** all 20 work (MOON … OMEGA), as do the secret words RUDE and PSYCHO.
- **Look:** the Twilight wizards in the new colours (emerald, royal blue, orange, pink).

## Files

- `index.html`, `src/`: the game.
  - `src/game/` holds the rules and the AI.
  - `src/render2d/` holds the graphics.
  - `src/audio.js` plays the original sound samples (`assets/sounds`).
- `data/levels.json`: every level, exported from the game's level file `FRACGEC\TEST`.
- `assets/`: the sprite atlas and the monster animation tables, exported from the game files.
- `tools/`: the exporters (`export_sounds.py` copies the original samples).
  - `export_levels.py` writes the levels file.
  - `export_sprites.py` decodes the GEC graphics files, upscales them 4× and reads the animation tables from
    `FRACAS.EXE`.
  - Run them again after changing the DOS game.
- `tests/rules.test.mjs`: tests for the game rules. Run them with `node tests/rules.test.mjs`.
- `tests/pickups.test.mjs`: tests for pickup and spell behavior. Run them with `node tests/pickups.test.mjs`.
- `tests/wallcheck.mjs`: level collision verification across all 100 levels. Run it with `node tests/wallcheck.mjs`.

## Realistic textures
The stone floors, brick and slate walls and boulders use photo textures from [Poly Haven](https://polyhaven.com) (CC0, public domain), stored in `assets/real/`; `tools/fetch_textures.py` downloads them again. They are baked once per level with relief lighting and soft wall shadows (`src/render2d/realistic.js`). If the folder is missing, the game falls back to the original tiles.
