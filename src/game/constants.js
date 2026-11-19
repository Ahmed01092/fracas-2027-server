// Shared rules data for Fracas 2027. Pure data, no rendering.

export const W = 21, H = 15;
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];          // 0 east, 1 south, 2 west, 3 north
export const DIR_OF = { '>': 0, 'v': 1, '<': 2, '^': 3, R: 0, D: 1, L: 2, U: 3 };

export const T = { FLOOR: 0, WALL: 1, ROCK: 2 };                   // static terrain; features sit on floor

export const TICK = 1 / 60;
export const FUSE = 130 / 31;         // FRACAS.EXE 0x998a: 0x82 = 130 ticks at 31 Hz
export const BLAST_TIME = 16 / 31;    // FRACAS.EXE 0x9078: 8 frames * 2 ticks = 16 ticks
export const BLAST_TIMES = { fire: 16 / 31, electric: 64 / 31, magic: 54 / 31 };
export const POWER_TIME = 40;         // ignitor / jars last ~40 s like the original
export const SPIKE_CYCLE = 106 / 31, SPIKE_OUT = 21 / 31; // FRACAS.EXE: 55t active (18x3t + 1t reset) + 51t retracted = 106t; lethal steps 6..12 (15..36t = 21t)
export const WALKWAY_SPEED = 1.875;   // 1 px/tick at 31 Hz (half of PLAYER_SPEED = 3.75)
export const PROJ_SPEED = 5.625;      // 3 px/tick at 31 Hz (1.5x PLAYER_SPEED)
export const MAX_RANGE = 5, MAX_BOMBS = 5;   // as in the original game

// original 8 behaviour profiles + the 8 added by the 100-level patch
// bit0 shortest path, bit1 state reaction, bit2 grab pickups, bit3 scent, bit4 cauldron aware, bit5 dodge
export const IQ = [0x00, 0x08, 0x02, 0x30, 0x28, 0x0c, 0x11, 0x3f, 0x09, 0x05, 0x31, 0x35, 0x3d, 0x1d, 0x2b, 0x21];
export const BEHAVIOUR_NAMES = ['Wanderer', 'Tracker', 'Reactor', 'Wary', 'Tracker-Dodger', 'Collector', 'Pathfinder',
  'Genius', 'Bloodhound', 'Scavenger', 'Duelist', 'Thief', 'Stalker', 'Prowler', 'Phantom', 'Hunter'];

// family drives the 3D model; colours are body gradient dark->light + accent (eyes / glow)
export const MONSTERS = {
  2: { name: 'Blue Slug', family: 'slug', speed: 0.85, colors: ['#1d2f8a', '#3f63d6', '#8fb0ff'], accent: '#ffffff' },
  3: { name: 'Blue Blob', family: 'blob', speed: 1.0, colors: ['#1e3a9a', '#4a74e0', '#a9c4ff'], accent: '#ffffff' },
  4: { name: 'Green Ghoul', family: 'humanoid', speed: 0.95, colors: ['#1f4a1c', '#3f8a35', '#8ad07a'], accent: '#ff4030' },
  5: { name: 'Swamp Spider', family: 'spectre', speed: 1.1, colors: ['#23431c', '#4f7d3a', '#9cc879'], accent: '#ffe040' },
  6: { name: 'Mud Golem', family: 'humanoid', speed: 0.9, colors: ['#3f3218', '#6e5a2c', '#a89058'], accent: '#ff9020' },
  7: { name: 'Phantom', family: 'ghost', speed: 1.05, colors: ['#3a4a66', '#8ea4c8', '#e8f0ff'], accent: '#40e0ff' },
  8: { name: 'Gold Crown', family: 'king', speed: 0.9, colors: ['#7a5200', '#c99a10', '#ffe070'], accent: '#ff2040' },
  9: { name: 'Fire Imp', family: 'blob', speed: 1.15, colors: ['#5a0800', '#c42a08', '#ff8a3a'], accent: '#fff050' },
  10: { name: 'Frost Wraith', family: 'blob', speed: 1.1, colors: ['#3a6aa0', '#a8d4f4', '#ffffff'], accent: '#1830d0' },
  11: { name: 'Void Beast', family: 'spectre', speed: 1.2, colors: ['#200034', '#6a1aa8', '#d090ff'], accent: '#ff2828' },
  12: { name: 'Magma Slug', family: 'slug', speed: 0.9, colors: ['#4a1406', '#b04008', '#ffc040'], accent: '#ffffd0' },
  13: { name: 'Horned Demon', family: 'blob', speed: 1.2, colors: ['#140a0a', '#3c1e22', '#7a3a44'], accent: '#ffe000', horns: true },
  14: { name: 'Crown King', family: 'king', speed: 1.0, colors: ['#7a5000', '#d0a000', '#fff2a0'], accent: '#ff1e1e' },
  15: { name: 'Toxic Slime', family: 'slug', speed: 1.0, colors: ['#0a3404', '#2aa010', '#c8ff50'], accent: '#ff20ff' },
  16: { name: 'Shadow Spectre', family: 'spectre', speed: 1.25, colors: ['#101010', '#2c2c30', '#5a5a64'], accent: '#ff2020' },
  17: { name: 'Lava Golem', family: 'humanoid', speed: 0.95, colors: ['#0e0b0b', '#2a2222', '#4a3c38'], accent: '#ff7800', cracks: true },
  18: { name: 'Skeleton Warrior', family: 'humanoid', speed: 1.1, colors: ['#9a9482', '#d6d0b8', '#fffbea'], accent: '#ff2a1a', bones: true },
  19: { name: 'Stone Titan', family: 'humanoid', speed: 0.85, colors: ['#2c2c32', '#6a6a72', '#b4b4bc'], accent: '#00f0ff', bulky: true },
  20: { name: 'Mummy', family: 'humanoid', speed: 0.9, colors: ['#6e5a30', '#b09a66', '#f0e4c0'], accent: '#ff1414', wraps: true },
};

// Pickups as coded in FRACAS.EXE (pickup table at 0xc25a, power-key table at 0x1b25b). The game runs at ~31 ticks/s
// (a cauldron's 130-tick fuse = 4.2 s measured), so `ticks` converts exactly to seconds.
export const TICK_HZ = 31;

/** Authoritative Fracas wall-spike cycle evaluation from active simulation time `st` and per-spike `delay`. */
export function computeSpikeState(st, delay = 0) {
  const firstActive = ((delay ?? 0) + 1) / TICK_HZ;
  if (!Number.isFinite(st) || st < firstActive) return { out: false, ph: 0, active: false };
  const el = (st - firstActive) % SPIKE_CYCLE;
  return {
    out: el >= 15 / TICK_HZ && el < 36 / TICK_HZ,
    ph: el / SPIKE_CYCLE,
    active: true,
  };
}

/**
 * Map authoritative spike phase `ph` (0..1 across 106 ticks) and `out` flag to continuous visual extension & warning cues.
 * Guarantees full extension (ext = 1) throughout the entire lethal window [15t, 36t) and whenever `out` is true.
 */
export function spikeVisualState(ph, out = false, active = true) {
  if (!active || typeof ph !== 'number' || !Number.isFinite(ph)) {
    return out ? { ext: 1, warn: 1 } : { ext: 0, warn: 0 };
  }
  const t = Math.max(0, Math.min(106, ph * 106));
  let ext = 0;
  let warn = 0;
  if (t < 9) {
    const u = t / 9;
    ext = 0.42 * (1 - (1 - u) * (1 - u));
    warn = Math.min(1, u * 1.45);
  } else if (t < 15) {
    const u = (t - 9) / 6;
    ext = 0.42 + 0.58 * (u * u);
    warn = 1;
  } else if (t < 36) {
    ext = 1;
    warn = 1;
  } else if (t < 55) {
    const r = (t - 36) / 19;
    const ease = r < 0.5 ? 2 * r * r : 1 - Math.pow(-2 * r + 2, 2) / 2;
    ext = 1 - ease;
    warn = Math.max(0, 1 - r * 2.4);
  }
  if (out) { ext = 1; warn = 1; }
  return { ext, warn };
}
export const PICKUP_INFO = {
  foot: { label: 'Speed Boots', color: '#f4b4a0', kind: 'power', ticks: 900, hint: 'press spell: double speed' },
  purpleGem: { label: 'Blast Range +1', color: '#b040ff', kind: 'stat' },
  greenGem: { label: 'Extra Cauldron', color: '#30e060', kind: 'stat' },
  max: { label: 'MAX Power (5 + 5)', color: '#ffe020', kind: 'stat' },
  heart: { label: 'Extra Life', color: '#ff2040', kind: 'stat' },
  radiation: { label: 'Radiation Shield', color: '#ffd400', kind: 'timed', ticks: 200 },
  ghost: { label: 'Empty Bottle', color: '#7aa0a0', kind: 'none' },             // does nothing in the original
  orb: { label: 'Chrono Stasis', color: '#ffd040', kind: 'power', ticks: 1200, dur: 7, hint: 'spell key: freeze time for 7s' },
  ignitor: { label: 'Ignitor', color: '#a0a0a8', kind: 'power', ticks: 1200, hint: 'cauldrons wait; spell sets one off' },
  stoneWind: { label: 'Storm Jar', color: '#6a90ff', kind: 'power', spell: 'windzone', area: true, ticks: 900, reach: 5,
               zone: 254 / TICK_HZ, hint: 'spell key: 4-way wind zone' },
  stoneTeleport: { label: 'Warp Cauldron Jar', color: '#d040e0', kind: 'power', spell: 'teleport', area: true, ticks: 1500 },
  stoneElectric: { label: 'Thunder Cauldron Jar', color: '#e8f4ff', kind: 'power', spell: 'electric', area: true, ticks: 900 },
  stoneFire: { label: 'Inferno Jar', color: '#ffc020', kind: 'power', spell: 'fire', area: true, ticks: 750,
               hint: 'spell key: fireballs in all 4 directions' },
  glassFire: { label: 'Fireball', color: '#ff6a10', kind: 'power', spell: 'fire', ticks: 750 },
  glassWind: { label: 'Gust', color: '#6aa8ff', kind: 'power', spell: 'windzone', ticks: 1200, reach: 6, zone: 254 / TICK_HZ },
  glassElectric: { label: 'Lightning Bolt', color: '#ffffff', kind: 'power', spell: 'electric', ticks: 900 },
  glassTeleport: { label: 'Warp Bolt', color: '#8a8a98', kind: 'power', spell: 'teleport', ticks: 1200 },
};

export const TEAM = [
  { name: 'Emerald', color: '#1fbf5a', dark: '#0b3a1a', light: '#7dffaa' },
  { name: 'Royal', color: '#2f5cff', dark: '#0d1a55', light: '#9db4ff' },
  { name: 'Ember', color: '#ff7a14', dark: '#4a1e04', light: '#ffc27a' },
  { name: 'Rose', color: '#ff3aa8', dark: '#4a0a2e', light: '#ffa0d8' },
];
