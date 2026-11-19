// Keyboards (two schemes on one keyboard) + up to four gamepads. Devices join a player slot.
const PRESETS = {
  modern: [
    { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', bomb: 'Space', power: 'KeyE' },
    { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', bomb: 'Enter', power: 'ShiftRight' },
  ],
  classic: [   // the original 1997 keys
    { up: 'KeyR', down: 'KeyF', left: 'KeyD', right: 'KeyG', bomb: 'KeyQ', power: 'Tab' },
    { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', bomb: 'Enter', power: 'BracketRight' },
  ],
};
const ACTIONS = ['up', 'down', 'left', 'right', 'bomb', 'power'];

/** Evaluate a crisp 4-way D-Pad direction from (dx, dy) with 1.25x angular hysteresis around 45° diagonals. */
export function evalTouch4Way(dx, dy, prevDir = -1, dead = 9) {
  if (Math.hypot(dx, dy) < dead) return -1;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const hDir = dx > 0 ? 0 : 2, vDir = dy > 0 ? 1 : 3;
  let horiz;
  if (prevDir === 0 || prevDir === 2) horiz = ay <= ax * 1.25;
  else if (prevDir === 1 || prevDir === 3) horiz = ax > ay * 1.25;
  else horiz = ax >= ay;
  return horiz ? hDir : vDir;
}

/**
 * Evaluate Swipe-and-Hold direction from a spatial touch trail `pts` (`[{x, y}, ...]`) and point `(x, y)`.
 * Starts moving after `startDead` px; switches direction on any >= `turnDist` px segment with angular hysteresis,
 * ignoring gentle thumb arcs along the active axis. Returns `{ dir, reset }`.
 */
export function evalSwipeStep(pts, x, y, prevDir = -1, startDead = 9, turnDist = 13) {
  if (!pts.length) return { dir: prevDir, reset: false };
  if (prevDir < 0) {
    const p0 = pts[0];
    const dir = evalTouch4Way(x - p0.x, y - p0.y, -1, startDead);
    return { dir, reset: dir >= 0 };
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    const dx = x - p.x, dy = y - p.y;
    if (Math.hypot(dx, dy) < turnDist) continue;
    const cand = evalTouch4Way(dx, dy, prevDir, turnDist);
    if (cand >= 0 && cand !== prevDir) return { dir: cand, reset: true };
    return { dir: prevDir, reset: false };
  }
  return { dir: prevDir, reset: false };
}

export class Input {
  constructor() {
    this.down = new Set(); this.pressed = new Set(); this.typedChars = [];
    this.preset = 'classic';
    this.keys = structuredClone(PRESETS.classic);
    this.pads = []; this.padPrev = [];
    this.devices = [null, null, null, null];        // slot -> device id: 'kb0', 'kb1', 'pad0'...
    this.listeners = [];
    this.lastDir = {};                               // device -> stack of held directions (last wins)
    this.capture = null;                             // key rebinding callback
    if (typeof addEventListener === 'function') {
      addEventListener('keydown', e => {
        if (this.capture) { e.preventDefault(); const cb = this.capture; this.capture = null; cb(e.code); return; }
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) e.preventDefault();
        if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) this.typedChars.push(e.key.toUpperCase());
        if (!this.down.has(e.code)) this.pressed.add(e.code);
        this.down.add(e.code);
        this.listeners.forEach(f => f(e.code));
      });
      addEventListener('keyup', e => {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        this.down.delete(e.code);
      });
      addEventListener('blur', () => this.down.clear());
    }
  }

  setPreset(name) { this.preset = name; this.keys = structuredClone(PRESETS[name] || PRESETS.classic); }
  rebind(scheme, action, cb) {
    this.capture = code => {
      if (code === 'Escape') { cb?.(null); return; }
      this.keys[scheme][action] = code;
      cb?.(code);
    };
  }
  onKey(f) { this.listeners.push(f); return () => this.listeners.splice(this.listeners.indexOf(f), 1); }

  poll() {
    let pads = [];
    try { pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : []; } catch {}
    this.padPrev = this.pads.map(p => p && { buttons: p.buttons.map(b => b.pressed) });
    this.pads = pads.filter(Boolean).slice(0, 4).map(p => ({ index: p.index, axes: [...(p.axes || [])],
      buttons: (p.buttons || []).map(b => ({ pressed: !!b?.pressed })) }));
  }
  endFrame() { this.pressed.clear(); this.typedChars.length = 0; }

  /** list of device ids currently present */
  get deviceList() { return ['kb0', 'kb1', ...this.pads.map((_, i) => 'pad' + i)]; }

  padButton(i, b, edge) {
    const p = this.pads[i]; if (!p) return false;
    const now = p.buttons[b]?.pressed;
    if (!edge) return !!now;
    return now && !this.padPrev[i]?.buttons?.[b];
  }

  /** read one device: {dir, secDir, bomb (edge), power (edge), bombHeld, powerHeld, start (edge), any (edge)} */
  read(dev) {
    if (!dev) return { dir: -1, secDir: -1 };
    if (dev.startsWith('kb')) {
      const k = this.keys[+dev[2]];
      if (!k) return { dir: -1, secDir: -1 };
      const held = ['right', 'down', 'left', 'up'].map(a => this.down.has(k[a]));
      const st = this.lastDir[dev] || (this.lastDir[dev] = []);
      ['right', 'down', 'left', 'up'].forEach((a, d) => {
        if (this.pressed.has(k[a])) { st.splice(st.indexOf(d) >>> 0, st.includes(d) ? 1 : 0); st.push(d); }
      });
      for (let i = st.length - 1; i >= 0; i--) if (!held[st[i]]) st.splice(i, 1);
      let dir = st.length ? st[st.length - 1] : held.indexOf(true);
      let secDir = -1;
      for (let i = st.length - 2; i >= 0; i--) {
        if (st[i] % 2 !== dir % 2) { secDir = st[i]; break; }
      }
      if (secDir < 0 && dir >= 0) {
        for (let d = 0; d < 4; d++) if (held[d] && d % 2 !== dir % 2) { secDir = d; break; }
      }
      return { dir, secDir, bomb: this.pressed.has(k.bomb), power: this.pressed.has(k.power), bombHeld: this.down.has(k.bomb),
               powerHeld: this.down.has(k.power),
               start: this.pressed.has('Escape') || this.pressed.has('KeyP'),
               any: ACTIONS.some(a => this.pressed.has(k[a])) };
    }
    const i = +dev.slice(3), p = this.pads[i];
    if (!p) return { dir: -1, secDir: -1 };
    const [ax = 0, ay = 0] = p.axes || []; let dir = -1, secDir = -1;
    if (p.buttons[15]?.pressed) dir = 0; else if (p.buttons[13]?.pressed) dir = 1;
    else if (p.buttons[14]?.pressed) dir = 2; else if (p.buttons[12]?.pressed) dir = 3;
    else if (Math.hypot(ax, ay) > 0.45) {
      if (Math.abs(ax) > Math.abs(ay)) {
        dir = ax > 0 ? 0 : 2;
        if (Math.abs(ay) > 0.28) secDir = ay > 0 ? 1 : 3;
      } else {
        dir = ay > 0 ? 1 : 3;
        if (Math.abs(ax) > 0.28) secDir = ax > 0 ? 0 : 2;
      }
    }
    const bomb = this.padButton(i, 0, true), power = this.padButton(i, 1, true) || this.padButton(i, 2, true);
    return { dir, secDir, bomb, power, bombHeld: this.padButton(i, 0), powerHeld: this.padButton(i, 1) || this.padButton(i, 2),
             start: this.padButton(i, 9, true), any: bomb || power || this.padButton(i, 9, true) };
  }

  /** menu navigation from any device: {dx, dy, ok, back} with key repeat */
  menu() {
    const out = { dx: 0, dy: 0, ok: false, back: false };
    const P = this.pressed;
    const k = this.keys[0];                         // player 1's own keys also drive the menus
    if (P.has('ArrowUp') || P.has(k.up)) out.dy = -1;
    if (P.has('ArrowDown') || P.has(k.down)) out.dy = 1;
    if (P.has('ArrowLeft') || P.has(k.left)) out.dx = -1;
    if (P.has('ArrowRight') || P.has(k.right)) out.dx = 1;
    if (P.has('Enter') || P.has('Space') || P.has(k.bomb)) out.ok = true;
    if (P.has('Escape') || P.has('Backspace')) out.back = true;
    this.pads.forEach((p, i) => {
      if (this.padButton(i, 12, true)) out.dy = -1; if (this.padButton(i, 13, true)) out.dy = 1;
      if (this.padButton(i, 14, true)) out.dx = -1; if (this.padButton(i, 15, true)) out.dx = 1;
      if (this.padButton(i, 0, true)) out.ok = true;
      if (this.padButton(i, 1, true)) out.back = true;
      const ax = p.axes?.[0] || 0, prevX = this.stickPrevX?.[i] || 0;
      if (ax < -0.6 && prevX >= -0.6) out.dx = -1; if (ax > 0.6 && prevX <= 0.6) out.dx = 1;
      const ay = p.axes?.[1] || 0, prevY = this.stickPrev?.[i] || 0;
      if (ay < -0.6 && prevY >= -0.6) out.dy = -1; if (ay > 0.6 && prevY <= 0.6) out.dy = 1;
    });
    this.stickPrev = this.pads.map(p => p.axes?.[1] || 0);
    this.stickPrevX = this.pads.map(p => p.axes?.[0] || 0);
    return out;
  }

  keyName(code) {
    const MAP = {
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', Backquote: '`', Minus: '-', Equal: '=',
      ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
      AltLeft: 'L-Alt', AltRight: 'R-Alt', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
      NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadEnter: 'Num Enter', NumpadDecimal: 'Num .',
      PageUp: 'PgUp', PageDown: 'PgDn', CapsLock: 'Caps', Backspace: 'Bksp', Delete: 'Del',
    };
    if (MAP[code]) return MAP[code];
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '');
  }
}
