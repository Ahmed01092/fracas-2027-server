// Unified modern dark-glass front-end screens over a live procedural fire, arcane-grid & embers backdrop.
// Works cleanly with keyboard, gamepad, mouse (exact CSS-to-canvas hit testing, draggable sliders) and touch.
import { TEAM } from '../game/constants.js';

const VW = 1920, VH = 1080;                         // virtual layout space, letterboxed into the window
const FW = 128, FH = 72;                            // smooth low-res fire plasma canvas (GPU-upscaled)
const FIRE_LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const k = i / 255;
  FIRE_LUT[i * 3] = 8 + k * 218;
  FIRE_LUT[i * 3 + 1] = 10 + Math.pow(k, 2.25) * 108;
  FIRE_LUT[i * 3 + 2] = 20 + Math.pow(k, 3.0) * 52;
}
const HYPOT_LUT = new Float32Array(FW * FH);
for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) HYPOT_LUT[y * FW + x] = Math.hypot(x - 64, y - 80) * 0.12;
const Y_FADE = new Float32Array(FH);
for (let y = 0; y < FH; y++) Y_FADE[y] = 0.28 + 0.72 * (y / FH);
const X_SIN = new Float32Array(FW);
const DISPLAY = "'Space Grotesk', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
const SANS = "'Plus Jakarta Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'Cascadia Code', ui-monospace, SFMono-Regular, Consolas, monospace";

const load = (src, retries = 2) => new Promise((ok, fail) => {
  const attempt = left => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => left > 0 ? setTimeout(() => attempt(left - 1), 500) : fail(new Error(`Failed to load ${src}`));
    i.src = src;
  };
  attempt(retries);
});

/** Scale2x applied twice: crisp 4x pixel art without blocky stair-steps */
function epx4(img) {
  if (!img?.width || !img?.height) return img;
  let w = img.width, h = img.height;
  const c0 = document.createElement('canvas'); c0.width = w; c0.height = h;
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  if (!x0) return img;
  x0.drawImage(img, 0, 0);
  let px = new Uint32Array(x0.getImageData(0, 0, w, h).data.buffer.slice(0));
  for (let pass = 0; pass < 2; pass++) {
    const W2 = w * 2, out = new Uint32Array(W2 * h * 2), at = (x, y) => px[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const P = at(x, y), A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
      const o = y * 2 * W2 + x * 2;
      out[o] = C === A && C !== D && A !== B ? A : P;
      out[o + 1] = A === B && A !== C && B !== D ? B : P;
      out[o + W2] = D === C && D !== B && C !== A ? C : P;
      out[o + W2 + 1] = B === D && B !== A && D !== C ? D : P;
    }
    px = out; w *= 2; h *= 2;
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d');
  if (!cx) return img;
  cx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
  return c;
}

export async function loadClassicArt() {
  const names = ['logo_hd', 'sel_cage', 'sel_wiz0', 'sel_wiz1', 'sel_wiz2', 'sel_wiz3',
                 'sel_btn0', 'sel_btn1', 'sel_btn2', 'sel_btn3'];
  const imgs = await Promise.all(names.map(n => load(`assets/menus/${n}.png`)));
  const art = {};
  await Promise.all(names.map(async (n, i) => {
    if (n === 'logo_hd') { art[n] = imgs[i]; return; }
    const c = epx4(imgs[i]);
    if (c && typeof Image !== 'undefined') {
      if (typeof c.toBlob === 'function' && typeof URL?.createObjectURL === 'function') {
        try {
          const im = await new Promise(ok => {
            c.toBlob(blob => {
              if (!blob) { ok(null); return; }
              const url = URL.createObjectURL(blob);
              const img = new Image();
              img.onload = () => { try { URL.revokeObjectURL(url); } catch {} ok(img); };
              img.onerror = () => { try { URL.revokeObjectURL(url); } catch {} ok(null); };
              img.src = url;
            }, 'image/png');
          });
          if (im?.naturalWidth > 0) { art[n] = im; return; }
        } catch {}
      }
      if (typeof c.toDataURL === 'function') {
        try {
          const im = new Image();
          await new Promise(ok => {
            im.onload = () => ok();
            im.onerror = () => ok();
            im.src = c.toDataURL('image/png');
          });
          if (im.naturalWidth > 0) { art[n] = im; return; }
        } catch {}
      }
    }
    art[n] = c;
  }));
  return art;
}

const TITLES = { start: 'Play', options: 'Options', battle: 'Battle Setup', password: 'Password', exit: 'Goodbye' };

export class ClassicMenu {
  constructor(app, art) {
    this.app = app; this.art = art;
    this.canvas = document.getElementById('classic');
    this.ctx = this.canvas?.getContext?.('2d') || null;
    this._initFire();
    this.embers = []; this.hover = []; this.toggleAnim = []; this.boxes = []; this.logoH = 320;
    this.t = 0; this.dt = 1 / 60; this.screen = null; this.dragBox = null; this.hoverBox = null;
    this._dragMoved = false; this._suppressClick = false;
    this.vig = null; this.glowLogo = null; this._vigGen = 0; this._pwProxy = null;
    this.selectNote = ''; this.selectNoteT = 0;
    if (this.canvas?.addEventListener) {
      this.canvas.addEventListener('contextlost', e => { e.preventDefault?.(); this.vig = null; this.glowLogo = null; });
      this.canvas.addEventListener('contextrestored', () => { this._recoverSurfaces(); });
    }
    if (typeof addEventListener === 'function') addEventListener('resize', () => this.resize());
    this.resize();

    const pos = e => {
      const r = this.canvas?.getBoundingClientRect?.();
      if (r && r.width > 0 && r.height > 0) {
        const lx = (e.clientX - r.left) * (this.canvas.width / r.width);
        const ly = (e.clientY - r.top) * (this.canvas.height / r.height);
        return [(lx - this.ox) / this.k, (ly - this.oy) / this.k];
      }
      return [(e.clientX * this.dpr - this.ox) / this.k, (e.clientY * this.dpr - this.oy) / this.k];
    };
    const hit = e => {
      const [x, y] = pos(e);
      for (let i = this.boxes.length - 1; i >= 0; i--) {
        const b = this.boxes[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
      }
      return null;
    };
    const scrub = (b, x) => {
      if (!b?.set) return;
      const f = Math.max(0, Math.min(1, (x - b.bx) / Math.max(1, b.bw)));
      b.set(f);
    };

    this.canvas?.addEventListener?.('mousedown', e => {
      if (!this.active || e.button !== 0) return;
      this.app.unlockAudio ? this.app.unlockAudio() : this.app.audio.init();
      const b = hit(e); if (!b) return;
      if (b.item != null) this.sel = b.item;
      if (b.set) {
        this.dragBox = b;
        this._dragMoved = false;
        this._dragStartX = pos(e)[0];
        scrub(b, this._dragStartX);
        this.app.audio.play('ui');
      }
    });
    if (typeof addEventListener === 'function') {
      addEventListener('mousemove', e => {
        if (!this.active) return;
        if (this.dragBox) {
          const px = pos(e)[0];
          if (Math.abs(px - (this._dragStartX ?? px)) > 2) this._dragMoved = true;
          scrub(this.dragBox, px);
          return;
        }
        const b = hit(e);
        this.hoverBox = b?.id || null;
        if (this.canvas?.style) this.canvas.style.cursor = b ? (b.set ? 'ew-resize' : 'pointer') : 'default';
        if (b && b.item != null && b.item !== this.sel) {
          this.sel = b.item;
          this.app.audio.play('ui');
        }
      });
      addEventListener('mouseup', () => {
        if (this.dragBox) {
          this._suppressClick = true;
          this.dragBox = null;
          setTimeout(() => { this._suppressClick = false; }, 0);
        }
      });
    }
    this.canvas?.addEventListener?.('click', e => {
      if (!this.active || e.button !== 0) return;
      if (this._suppressClick) { this._suppressClick = false; return; }
      const b = hit(e); if (!b) return;
      if (b.set) { scrub(b, pos(e)[0]); return; }
      if (b.action) { this.app.audio.play('ui'); b.action(); return; }
      const it = this.items()[b.item]; if (!it) return;
      if (b.dir === -1 && it.left) { it.left(); this.app.audio.play('ui'); return; }
      if (b.dir === 1 && (it.right || it.ok)) { (it.right || it.ok)(); this.app.audio.play('ui'); return; }
      this.app.audio.play(it.value ? 'ui' : 'select');
      it.ok?.();
    });
  }

  get active() { return !!this.screen; }
  show(on) { if (this.canvas?.style) this.canvas.style.display = on ? 'block' : 'none'; }

  _initFire() {
    this.fire = document.createElement('canvas'); this.fire.width = FW; this.fire.height = FH;
    this.fctx = this.fire.getContext('2d');
    this.fireImg = this.fctx ? this.fctx.createImageData(FW, FH) : null;
  }

  _recoverSurfaces() {
    this.vig = null; this.glowLogo = null;
    this._panelCache?.clear(); this._cardCache?.clear(); this._selTitleCache = null;
    this._fireLastT = -1;
    this._initFire();
    this.resize();
    if (this.screen === 'select' && this.level) this.miniMap();
  }

  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min((typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, 2);
    const W = this.canvas.width = Math.max(1, Math.round(((typeof innerWidth === 'number' && innerWidth) || 1) * this.dpr));
    const H = this.canvas.height = Math.max(1, Math.round(((typeof innerHeight === 'number' && innerHeight) || 1) * this.dpr));
    this.k = Math.min(W / VW, H / VH);
    this.ox = (W - VW * this.k) / 2; this.oy = (H - VH * this.k) / 2;
    const vw = Math.max(1, Math.min(W, 320)), vh = Math.max(1, Math.round(vw * H / W));
    const v = document.createElement('canvas'); v.width = vw; v.height = vh;
    const vx = v.getContext('2d');
    if (vx) {
      const g = vx.createRadialGradient(vw / 2, vh * 0.42, Math.min(vw, vh) * 0.15, vw / 2, vh * 0.5, Math.max(vw, vh) * 0.78);
      g.addColorStop(0, 'rgba(6, 9, 18, 0.22)'); g.addColorStop(1, 'rgba(3, 5, 11, 0.92)');
      vx.fillStyle = g; vx.fillRect(0, 0, vw, vh);
    }
    this.vig = v;
    const vGen = ++this._vigGen;
    if (typeof v.toDataURL === 'function' && typeof Image !== 'undefined') {
      try {
        const im = new Image();
        im.onload = () => { if (this._vigGen === vGen && im.naturalWidth > 0) this.vig = im; };
        im.onerror = () => {};
        im.src = v.toDataURL('image/png');
      } catch {}
    }
    if (this.active && !this._resizing && this.isMobile() !== !!this._mobileHtml) {
      this._resizing = true;
      try { this.open(this.screen, { ...this.opts, sel: this.sel }); } finally { this._resizing = false; }
    }
  }

  isMobile() {
    if (typeof document === 'undefined') return false;
    const smallW = typeof innerWidth === 'number' && innerWidth > 0 && innerWidth < 760;
    const smallH = typeof innerHeight === 'number' && innerHeight > 0 && innerHeight < 500;
    if (smallW || smallH) return true;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
    return !!coarse && typeof innerWidth === 'number' && innerWidth < 960;
  }

  _mountPwProxy() {
    this._unmountPwProxy();
    if (typeof document === 'undefined' || !document.body?.appendChild) return;
    const inp = document.createElement('input');
    inp.id = 'pw-proxy';
    inp.type = 'text';
    inp.maxLength = 10;
    inp.autocomplete = 'off';
    inp.autocapitalize = 'characters';
    inp.spellcheck = false;
    inp.value = this.typed || '';
    inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
    inp.addEventListener('input', () => {
      const clean = inp.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
      if (clean !== inp.value) inp.value = clean;
      if (clean !== this.typed) {
        this.typed = clean;
        this.note = '';
        this.app.audio.play('ui');
      }
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.submitPassword(); inp.value = this.typed; }
      else if (e.key === 'Escape') { e.preventDefault(); this.back(); }
    });
    document.body.appendChild(inp);
    this._pwProxy = inp;
  }

  _unmountPwProxy() {
    if (this._pwProxy) {
      try { this._pwProxy.remove(); } catch {}
      this._pwProxy = null;
    }
  }

  // ---------------------------------------------------------------- screens
  open(name, opts = {}) {
    if (this.isMobile() && this.openMobileHtml(name, opts)) return;
    this._mobileHtml = false;
    this._unmountPwProxy();
    const ui = typeof document !== 'undefined' ? document.getElementById?.('ui') : null;
    if (ui) ui.innerHTML = '';
    this.canvas?.classList?.remove?.('bg-only');
    if (!this.vig) this.resize();
    this.screen = name; this.sel = opts.sel ?? 0; this.opts = opts; this.t = 0; this.typed = ''; this.note = '';
    this.hover = []; this.toggleAnim = []; this.hoverBox = null; this.dragBox = null; this._suppressClick = false;
    this.selectNote = ''; this.selectNoteT = 0;
    const its = this.items();
    if (its.length) this.sel = Math.max(0, Math.min(its.length - 1, this.sel));
    this.show(true); this.app.state = 'classic';
    this.app.menuUpdate = dt => this.update(dt);
    if (name === 'select') this.startSelect(opts);
    if (name === 'password') this._mountPwProxy();
  }

  openMobileHtml(name, opts = {}) {
    const a = this.app;
    if (!a || typeof a.menu !== 'function' || typeof a.show !== 'function') return false;
    this.screen = name; this.opts = opts; this._mobileHtml = true;
    this._unmountPwProxy();
    this.show(true);
    this.canvas?.classList?.add?.('bg-only');
    a.menuUpdate = null;

    if (name === 'options') {
      a.options(() => this.open('main'));
      return true;
    }
    if (name === 'main') {
      a.menu('classic', 'FRACAS', this.items(), { logo: true });
      return true;
    }
    if (name === 'start') {
      a.menu('classic', 'Play', this.items(), { back: () => this.open('main') });
      return true;
    }
    if (name === 'battle') {
      a.menu('classic', 'Battle Setup', this.items(), { back: () => this.open('start') });
      return true;
    }
    if (name === 'exit') {
      a.menu('classic', 'Goodbye', this.items(), { sub: 'Thanks for playing Fracas 2027.', back: () => this.open('main') });
      return true;
    }
    if (name === 'password') {
      a.show(`<div class="screen"><div class="card">
        <div class="brand-pill"><span class="dot"></span>FRACAS 2027</div>
        <div class="heading"><h2>Password</h2></div>
        <p class="hint">Enter a level password (e.g. EARTH, FIRE, OMEGA) or secret code.</p>
        <input class="pw" id="mob-pw" maxlength="10" placeholder="PASSWORD" autocomplete="off" autocapitalize="characters">
        <div class="net-err" id="mob-pw-msg"></div>
        <div class="net-row">
          <button class="net-btn" id="mob-pw-back" type="button" style="flex:1">Back</button>
          <button class="net-btn pri" id="mob-pw-ok" type="button" style="flex:1">Confirm</button>
        </div>
      </div></div>`, 'classic');
      const ui = document.getElementById('ui');
      const inp = ui?.querySelector('#mob-pw');
      const msg = ui?.querySelector('#mob-pw-msg');
      const submit = () => {
        const w = (inp?.value || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
        if (!w) return;
        if (w === 'RUDE') { a.cheats.rude = !a.cheats.rude; a.audio.rude = a.cheats.rude; if (msg) { msg.style.color = '#5eead4'; msg.textContent = 'Rude mode ' + (a.cheats.rude ? 'on' : 'off'); } inp.value = ''; return; }
        if (w === 'PSYCHO') { a.cheats.psycho = !a.cheats.psycho; a.renderer.psycho = a.cheats.psycho; if (msg) { msg.style.color = '#5eead4'; msg.textContent = 'Psycho mode ' + (a.cheats.psycho ? 'on' : 'off'); } inp.value = ''; return; }
        const lv = a.data.passwords?.[w];
        if (lv) { a.audio.play('select'); this.open('select', { mode: 'story', level: lv }); }
        else { a.audio.play('lose'); if (msg) { msg.style.color = '#ff5c77'; msg.textContent = 'Wrong password'; } inp.value = ''; }
      };
      ui?.querySelector('#mob-pw-ok')?.addEventListener('click', submit);
      ui?.querySelector('#mob-pw-back')?.addEventListener('click', () => { a.audio.play('ui'); this.open('start'); });
      inp?.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') { a.audio.play('ui'); this.open('start'); }
      });
      a.menuUpdate = () => { if (a.input.pressed.has('Escape')) { a.audio.play('ui'); this.open('start'); } };
      return true;
    }
    if (name === 'select') {
      const battle = opts.mode === 'battle';
      const lvNum = opts.level || 1;
      const lv = battle ? a.data.battle[lvNum - 1] : a.data.normal[lvNum - 1];
      const bCfg = a.battleCfg || {};
      const botDiff = bCfg.botDiff || 'normal';
      const nBots = battle ? Math.min(3, Math.max(0, bCfg.bots || 0)) : 0;
      const slots = ['touch', null, null, null];
      if (battle) {
        if (nBots > 0) {
          for (let i = 0; i < nBots; i++) slots[i + 1] = `bot:${botDiff}`;
        } else {
          slots[1] = 'kb1';
        }
      }
      const renderMobSelect = () => {
        const cards = [0, 1, 2, 3].map(k => {
          const on = !!slots[k], tm = TEAM[k], isBot = typeof slots[k] === 'string' && slots[k].startsWith('bot:');
          const label = isBot ? `🤖 Bot (${slots[k].slice(4)})` : (on ? (slots[k] === 'touch' ? 'Touch' : slots[k] === 'kb0' ? 'KB 1' : slots[k] === 'kb1' ? 'KB 2' : 'Pad') : 'Tap to Join / Bot');
          return `<div class="net-slot ${isBot ? 'bot' : on ? 'on' : 'open'}" data-k="${k}" style="--c:${tm.color};cursor:pointer">
            <div class="orb" style="width:36px;height:36px;${on ? '' : 'opacity:.32;box-shadow:none'}"></div>
            <div class="wnm">${tm.name}</div>
            <div class="meta">${label}</div>
          </div>`;
        }).join('');
        const joined = slots.map((d, i) => d ? i : -1).filter(i => i >= 0);
        const need = battle ? 2 : 1;
        a.show(`<div class="screen wide"><div class="card">
          <div class="brand-pill"><span class="dot"></span>${battle ? `BATTLE · ARENA ${lv?.id || lvNum}` : `STORY · LEVEL ${lv?.id || lvNum}`}</div>
          <div class="heading"><h2>Choose Wizard</h2></div>
          <div class="net-slots">${cards}</div>
          <p class="hint" style="font-size:12px">Tap empty slots to add AI Bots or switch wizard. Use Play Online to play with friends on separate devices.</p>
          <div class="net-row">
            <button class="net-btn" id="mob-sel-back" type="button" style="flex:1">Back</button>
            <button class="net-btn pri" id="mob-sel-go" type="button" style="flex:1" ${joined.length >= need ? '' : 'disabled'}>Launch Match</button>
          </div>
        </div></div>`, 'classic');
        const ui = document.getElementById('ui');
        ui?.querySelectorAll('[data-k]').forEach(el => {
          el.addEventListener('click', () => {
            const k = +el.dataset.k;
            a.audio.play('ui');
            if (slots[k]) {
              if (slots[k].startsWith('bot:')) slots[k] = null;
              else slots[k] = `bot:${botDiff}`;
            } else {
              const pool = ['touch', 'kb0', 'kb1'];
              const d = pool.find(x => !slots.includes(x));
              slots[k] = d || `bot:${botDiff}`;
            }
            renderMobSelect();
          });
        });
        ui?.querySelector('#mob-sel-back')?.addEventListener('click', () => { a.audio.play('ui'); this.open(battle ? 'battle' : 'start'); });
        ui?.querySelector('#mob-sel-go')?.addEventListener('click', () => {
          const readySlots = slots.map((d, i) => d ? i : -1).filter(i => i >= 0);
          if (readySlots.length < need) return;
          a.audio.play('select');
          a.devices = slots.slice();
          this.close();
          if (battle) a.startBattle(readySlots);
          else a.startStory(lvNum, readySlots);
        });
        a.menuUpdate = () => { if (a.input.pressed.has('Escape')) { a.audio.play('ui'); this.open(battle ? 'battle' : 'start'); } };
      };
      renderMobSelect();
      return true;
    }
    return false;
  }

  close() {
    this.screen = null; this.dragBox = null; this.hoverBox = null; this._suppressClick = false;
    this._unmountPwProxy();
    this.canvas?.classList?.remove?.('bg-only');
    this.show(false);
    if (this._mobileHtml) {
      this._mobileHtml = false;
      const ui = typeof document !== 'undefined' ? document.getElementById?.('ui') : null;
      if (ui && this.app.state === 'classic') ui.innerHTML = '';
    }
    this.app.menuUpdate = null;
    if (this.canvas?.style) this.canvas.style.cursor = 'default';
    this.glowLogo = null; this.vig = null; this.mini = null;
    this._panelCache?.clear(); this._cardCache?.clear(); this._selTitleCache = null;
  }

  drawBackdropOnly(dt = 1 / 60) {
    if (!this.ctx || this.ctx.isContextLost?.() || !this.canvas?.width || !this.canvas?.height) return;
    if (!this.vig) this.resize();
    this.t += dt; this.dt = dt;
    this.show(true);
    this.canvas?.classList?.add?.('bg-only');
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if ('filter' in ctx && ctx.filter !== 'none') ctx.filter = 'none';
    ctx.fillStyle = '#060810'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawBackdrop();
  }

  items() {
    const s = this.app.save, a = this.app;
    switch (this.screen) {
      case 'main': return [
        { label: 'Start', sub: 'Story campaign & local battle', icon: 'play', ok: () => this.open('start') },
        { label: 'Play Online', sub: 'Co-op & battle rooms · Rollback P2P', icon: 'online', ok: () => { this.close(); a.openOnlineMenu(); } },
        { label: 'Controls', sub: 'Keyboard layouts & gamepad guide', icon: 'keys', ok: () => { this.close(); a.controls(() => a.classic.open('main', { sel: 2 })); } },
        { label: 'Options', sub: 'Graphics, audio, brightness & keybinds', icon: 'sliders', ok: () => this.open('options') },
        { label: 'Exit', sub: 'Leave menu', icon: 'exit', ok: () => this.open('exit') }];
      case 'start': {
        const list = [
          { label: 'Start Normal Game', sub: 'Begin from Level 1 · Stone Halls', icon: 'play', ok: () => this.open('select', { mode: 'story', level: 1 }) },
        ];
        const cp = a.checkpoint ? a.checkpoint(s.best || 1) : 1;
        if ((s.best || 1) > 1 && cp > 1) {
          list.push({ label: `Continue Checkpoint`, sub: `Resume at Level ${cp} (Best: Lv ${s.best})`, icon: 'spark', ok: () => this.open('select', { mode: 'story', level: cp }) });
        }
        list.push(
          { label: 'Normal Game Password', sub: 'Jump to any world or toggle cheats', icon: 'key', ok: () => this.open('password') },
          { label: 'Start Battle Game', sub: '2–4 player local arena clash', icon: 'battle', ok: () => this.open('battle') },
          { label: 'Back', icon: 'back', ok: () => this.open('main') }
        );
        return list;
      }
      case 'battle': {
        const b = a.battleCfg || (a.battleCfg = { arena: 0, wins: 3, random: false, bots: 1, botDiff: 'normal', startMax: false, fuseScale: 1, suddenDeath: 'normal' }), N = a.data.battle.length;
        if (b.bots === undefined) b.bots = 1;
        if (!b.botDiff) b.botDiff = 'normal';
        if (!b.fuseScale) b.fuseScale = 1;
        if (!b.suddenDeath) b.suddenDeath = 'normal';
        const incArena = () => { b.arena = (b.arena + 1) % N; };
        const decArena = () => { b.arena = (b.arena + N - 1) % N; };
        const incWins = () => { b.wins = b.wins % 9 + 1; };
        const decWins = () => { b.wins = (b.wins + 7) % 9 + 1; };
        const togRand = () => { b.random = !b.random; };
        const incBots = () => { b.bots = (b.bots + 1) % 4; };
        const decBots = () => { b.bots = (b.bots + 3) % 4; };
        const diffs = ['easy', 'normal', 'master'];
        const incDiff = () => { b.botDiff = diffs[(diffs.indexOf(b.botDiff) + 1) % 3]; };
        const decDiff = () => { b.botDiff = diffs[(diffs.indexOf(b.botDiff) + 2) % 3]; };
        const fuses = [1, 0.65, 0.45];
        const incFuse = () => { b.fuseScale = fuses[(fuses.indexOf(b.fuseScale) + 1) % 3]; };
        const decFuse = () => { b.fuseScale = fuses[(fuses.indexOf(b.fuseScale) + 2) % 3]; };
        const togMax = () => { b.startMax = !b.startMax; };
        const togSd = () => { b.suddenDeath = b.suddenDeath === 'fast' ? 'normal' : 'fast'; };
        return [
          { label: 'Arena', value: () => String(b.arena + 1).padStart(2, '0') + ' / ' + N, ok: incArena, right: incArena, left: decArena },
          { label: 'Wins Needed', value: () => String(b.wins), bar: () => (b.wins - 1) / 8, set: f => { b.wins = 1 + Math.round(f * 8); }, ok: incWins, right: incWins, left: decWins },
          { label: 'Random Arena', value: () => b.random ? 'On' : 'Off', toggle: () => b.random, ok: togRand, right: togRand, left: togRand },
          { label: 'AI Bots', value: () => b.bots ? `${b.bots} (${b.botDiff[0].toUpperCase() + b.botDiff.slice(1)})` : 'Off', ok: incBots, right: incBots, left: decBots },
          { label: 'Bot Difficulty', value: () => b.botDiff[0].toUpperCase() + b.botDiff.slice(1), ok: incDiff, right: incDiff, left: decDiff },
          { label: 'Start MAX (5+5)', value: () => b.startMax ? 'On' : 'Off', toggle: () => b.startMax, ok: togMax, right: togMax, left: togMax },
          { label: 'Fuse Speed', value: () => b.fuseScale <= 0.5 ? 'Chaos' : b.fuseScale < 0.9 ? 'Quick' : 'Classic', ok: incFuse, right: incFuse, left: decFuse },
          { label: 'Sudden Death', value: () => b.suddenDeath === 'fast' ? 'Fast' : 'Normal', toggle: () => b.suddenDeath === 'fast', ok: togSd, right: togSd, left: togSd },
          { label: 'Choose Players', icon: 'play', ok: () => this.open('select', { mode: 'battle', level: b.arena + 1 }) },
          { label: 'Back', icon: 'back', ok: () => this.open('start') }];
      }
      case 'options': {
        const qs = ['low', 'medium', 'high', 'ultra'], pct = v => Math.round(v * 100) + '%';
        const vol = (k, d) => () => { s[k] = Math.max(0, Math.min(1, Math.round((s[k] + d) * 10) / 10)); a.audio.setVolumes(s.sfx, s.music); a.persist(); if (k === 'music') a.syncMusic?.(); };
        const setVol = k => f => { s[k] = Math.max(0, Math.min(1, Math.round(f * 10) / 10)); a.audio.setVolumes(s.sfx, s.music); a.persist(); if (k === 'music') a.syncMusic?.(); };
        const q = d => () => { s.quality = qs[(qs.indexOf(s.quality) + d + 4) % 4]; a.renderer.setQuality(s.quality); a.persist(); };
        const togTouch = () => { s.touchMode = s.touchMode === 'dpad' ? 'swipe' : 'dpad'; a.persist(); a.syncTouchMode?.(); };
        const opts = [
          { label: 'Graphics', value: () => s.quality[0].toUpperCase() + s.quality.slice(1), ok: q(1), right: q(1), left: q(-1) },
          { label: 'Sound', value: () => pct(s.sfx), bar: () => s.sfx, set: setVol('sfx'), ok: vol('sfx', 0.1), right: vol('sfx', 0.1), left: vol('sfx', -0.1) },
          { label: 'Music', value: () => s.music ? pct(s.music) : 'Off', bar: () => s.music, set: setVol('music'), ok: vol('music', 0.1), right: vol('music', 0.1), left: vol('music', -0.1) },
          { label: 'Brightness', value: () => pct(s.bright), bar: () => (s.bright - 0.5) / 1.1, set: f => a.setBright(Math.round((0.5 + f * 1.1) * 10) / 10), ok: () => a.setBright(s.bright + 0.1), right: () => a.setBright(s.bright + 0.1), left: () => a.setBright(s.bright - 0.1) },
          { label: 'Key Layout', value: () => s.preset === 'modern' ? 'WASD' : 'Original', ok: () => a.togglePreset(), right: () => a.togglePreset(), left: () => a.togglePreset() },
          { label: 'Dungeon Darkness', value: () => s.dark ? 'On' : 'Off', toggle: () => s.dark, ok: () => { s.dark = !s.dark; a.renderer.dark = s.dark; a.persist(); }, right: () => { s.dark = !s.dark; a.renderer.dark = s.dark; a.persist(); }, left: () => { s.dark = !s.dark; a.renderer.dark = s.dark; a.persist(); } },
          { label: 'Blast Preview', value: () => s.blastPreview ? 'On' : 'Off', toggle: () => s.blastPreview, ok: () => { s.blastPreview = !s.blastPreview; a.renderer.blastPreview = s.blastPreview; a.persist(); }, right: () => { s.blastPreview = !s.blastPreview; a.renderer.blastPreview = s.blastPreview; a.persist(); }, left: () => { s.blastPreview = !s.blastPreview; a.renderer.blastPreview = s.blastPreview; a.persist(); } },
          { label: 'Rebind Keys', icon: 'keys', ok: () => { this.close(); a.rebind(() => a.classic.open('options', { sel: 7 })); } },
        ];
        if (typeof document !== 'undefined' && document.body?.classList?.contains('touch')) {
          opts.push({ label: 'Touch Controls', value: () => s.touchMode === 'dpad' ? '4-Way D-Pad' : 'Swipe Screen', ok: togTouch, right: togTouch, left: togTouch });
        }
        if (typeof window !== 'undefined' && window.fracasDesktop?.isDesktop) {
          const togFs = () => {
            window.fracasDesktop.toggleFullscreen().then(v => { this._isFs = !!v; }).catch(() => {});
            this._isFs = !this._isFs;
          };
          opts.push({ label: 'Fullscreen (F11)', value: () => this._isFs ? 'On' : 'Off', toggle: () => !!this._isFs, ok: togFs, right: togFs, left: togFs });
        }
        opts.push({ label: 'Back', icon: 'back', ok: () => this.open('main') });
        return opts;
      }
      case 'exit': {
        const list = [];
        if (typeof window !== 'undefined' && window.fracasDesktop?.isDesktop) {
          list.push({ label: 'Quit to Desktop', icon: 'exit', ok: () => window.fracasDesktop.quit() });
        }
        list.push({ label: 'Back to Menu', icon: 'back', ok: () => this.open('main') });
        return list;
      }
      default: return [];
    }
  }

  back() {
    const up = { start: 'main', options: 'main', battle: 'start', password: 'start', select: this.opts.mode === 'battle' ? 'battle' : 'start', exit: 'main' };
    if (up[this.screen]) { this.app.audio.play('ui'); this.open(up[this.screen]); }
  }

  update(dt) {
    this.t += dt; this.dt = dt;
    if (this.selectNoteT > 0) this.selectNoteT = Math.max(0, this.selectNoteT - dt);
    const inp = this.app.input, m = inp.menu();
    if (this.screen === 'select') { this.updateSelect(dt); this.draw(); return; }
    if (this.screen === 'password') { this.updatePassword(); this.draw(); return; }
    const its = this.items();
    if (!its.length) {
      if (m.back) this.back();
      this.draw();
      return;
    }
    this.sel = Math.max(0, Math.min(its.length - 1, this.sel));
    if (m.dy) { this.sel = (this.sel + m.dy + its.length) % its.length; this.app.audio.play('ui'); }
    const cur = its[this.sel];
    if (m.dx < 0 && cur.left) { cur.left(); this.app.audio.play('ui'); }
    else if (m.dx > 0 && (cur.right || cur.value)) { (cur.right || cur.ok)?.(); this.app.audio.play('ui'); }
    else if (m.ok) { this.app.audio.play(cur.value ? 'ui' : 'select'); cur.ok?.(); }
    if (m.back) this.back();
    this.draw();
  }

  submitPassword() {
    const w = (this.typed || '').trim().toUpperCase(), a = this.app;
    if (!w) { this.note = 'Type a password first'; this.good = false; this.shakeT = 0.25; return; }
    if (w === 'RUDE') { a.cheats.rude = !a.cheats.rude; a.audio.rude = a.cheats.rude; this.note = 'Rude mode ' + (a.cheats.rude ? 'on' : 'off'); this.good = true; this.typed = ''; if (this._pwProxy) this._pwProxy.value = ''; return; }
    if (w === 'PSYCHO') { a.cheats.psycho = !a.cheats.psycho; a.renderer.psycho = a.cheats.psycho; this.note = 'Psycho mode ' + (a.cheats.psycho ? 'on' : 'off'); this.good = true; this.typed = ''; if (this._pwProxy) this._pwProxy.value = ''; return; }
    const lv = a.data.passwords[w];
    if (lv) { a.audio.play('select'); this.open('select', { mode: 'story', level: lv }); }
    else { a.audio.play('lose'); this.note = 'Wrong password'; this.good = false; this.typed = ''; if (this._pwProxy) this._pwProxy.value = ''; this.shakeT = 0.4; }
  }

  focusPasswordInput() {
    if (this._pwProxy && typeof this._pwProxy.focus === 'function') {
      try { this._pwProxy.focus({ preventScroll: true }); } catch { this._pwProxy.focus(); }
    }
  }

  updatePassword() {
    const inp = this.app.input;
    for (const ch of inp.typedChars || []) {
      if (this.typed.length < 10) {
        this.typed += ch;
        if (this._pwProxy) this._pwProxy.value = this.typed;
        this.note = '';
        this.app.audio.play('ui');
      }
    }
    for (const code of inp.pressed) {
      if (code === 'Backspace') {
        this.typed = this.typed.slice(0, -1);
        if (this._pwProxy) this._pwProxy.value = this.typed;
        this.note = '';
      }
      if (code === 'Escape') { this.back(); return; }
      if (code === 'Enter') { this.submitPassword(); return; }
    }
  }

  // ---------------------------------------------------------------- player select
  startSelect(o) {
    this.devices = [null, null, null, null]; this.joinT = [0, 0, 0, 0];
    if (o.mode === 'battle') {
      const b = this.app.battleCfg || {};
      const nBots = Math.min(3, Math.max(0, b.bots || 0));
      const diff = b.botDiff || 'normal';
      for (let i = 0; i < nBots; i++) this.devices[3 - i] = `bot:${diff}`;
    }
    this.timer = 20; this.lastTick = 20;
    this.level = o.mode === 'battle' ? this.app.data.battle[o.level - 1] : this.app.data.normal[o.level - 1];
    this.miniMap();
  }

  get sets() { return ['kb0', 'kb1', 'pad0', 'pad1', 'pad2', 'pad3']; }
  held(dev) {
    if (!dev || dev.startsWith('bot:')) return false;
    if (dev === 'touch') return !!this.app.touch?.held;
    const inp = this.app.input;
    if (dev.startsWith('kb')) { const k = inp.keys[+dev[2]]; return inp.down.has(k.bomb) || inp.down.has(k.power); }
    const pi = +dev.slice(3);
    return inp.padButton(pi, 0) || inp.padButton(pi, 1) || inp.padButton(pi, 2);
  }

  clickCard(k) {
    const cur = this.devices[k];
    if (cur) {
      if (cur.startsWith('bot:')) {
        const diff = cur.slice(4);
        const next = diff === 'normal' ? 'master' : diff === 'master' ? 'easy' : null;
        this.devices[k] = next ? `bot:${next}` : null;
        if (!next) this.joinT[k] = 0;
        this.app.audio.play('ui');
        return;
      }
      this.devices[k] = null; this.joinT[k] = 0; this.app.audio.play('ui'); return;
    }
    const pads = (this.app.input?.pads || []).map((_, i) => 'pad' + i);
    const hasTouch = typeof document !== 'undefined' && document.body?.classList?.contains('touch');
    const pool = [...(hasTouch ? ['touch'] : []), 'kb0', 'kb1', ...pads];
    const dev = pool.find(d => !this.devices.includes(d));
    if (dev) {
      this.devices[k] = dev;
      this.app.audio.play('join');
    } else {
      const diff = this.app.battleCfg?.botDiff || 'normal';
      this.devices[k] = `bot:${diff}`;
      this.app.audio.play('join');
    }
  }

  toggleCardBot(k) {
    const cur = this.devices[k];
    if (cur && cur.startsWith('bot:')) {
      const diff = cur.slice(4);
      const next = diff === 'normal' ? 'master' : diff === 'master' ? 'easy' : null;
      this.devices[k] = next ? `bot:${next}` : null;
      if (!next) this.joinT[k] = 0;
      this.app.audio.play('ui');
    } else if (!cur) {
      const diff = this.app.battleCfg?.botDiff || 'normal';
      this.devices[k] = `bot:${diff}`;
      this.app.audio.play('join');
    }
  }

  updateSelect(dt) {
    const a = this.app, inp = a.input;
    for (let slot = 0; slot < 4; slot++) if (this.devices[slot]) this.joinT[slot] += dt;
    for (const dev of this.sets) {
      if (this.devices.includes(dev)) continue;
      const r = inp.read(dev);
      if (r.bomb || r.power) {
        const free = this.devices.indexOf(null);
        if (free >= 0) { this.devices[free] = dev; a.audio.play('join'); }
      }
    }
    if (a.touch?.bomb && !this.devices.includes('touch')) {
      const free = this.devices.indexOf(null);
      if (free >= 0) { this.devices[free] = 'touch'; a.audio.play('join'); }
      a.touch.bomb = false; a.touch.power = false;
    }
    if (inp.pressed.has('KeyB')) {
      const free = this.devices.indexOf(null);
      const diff = a.battleCfg?.botDiff || 'normal';
      if (free >= 0) { this.devices[free] = `bot:${diff}`; a.audio.play('join'); }
      else {
        const lastBot = this.devices.map((d, i) => (d && d.startsWith('bot:')) ? i : -1).filter(i => i >= 0).pop();
        if (lastBot !== undefined) { this.devices[lastBot] = null; this.joinT[lastBot] = 0; a.audio.play('ui'); }
      }
    }
    if (inp.pressed.has('Escape')) { this.back(); return; }
    const joined = this.devices.map((d, i) => d ? i : -1).filter(i => i >= 0);
    const need = this.opts.mode === 'battle' ? 2 : 1;

    // README: once joined, pressing spell key launches immediately when enough players are ready
    if (joined.length >= need) {
      for (const slot of joined) {
        const dev = this.devices[slot];
        if (!dev || dev === 'touch' || dev.startsWith('bot:') || this.joinT[slot] <= 0.35) continue;
        if (inp.read(dev).power) {
          this.timer = 0;
          break;
        }
      }
    }

    this.holding = joined.length >= need && this.devices.some((dev, slot) => dev && this.joinT[slot] > 0.25 && this.held(dev));
    this.timer -= dt * (this.holding ? 14 : 1);
    if (Math.ceil(this.timer) < this.lastTick) { this.lastTick = Math.ceil(this.timer); if (this.lastTick > 0) a.audio.play('tick'); }
    if (this.timer <= 0) {
      if (joined.length >= need) {
        a.devices = this.devices.slice();
        this.close();
        if (this.opts.mode === 'battle') a.startBattle(joined); else a.startStory(this.opts.level, joined);
      } else if (joined.length === 0) this.back();
      else { this.timer = 20; this.lastTick = 20; }
    }
  }

  miniMap(lvOverride = null) {
    const lv = lvOverride || this.level;
    if (!lv?.rows) { if (!lvOverride) this.mini = null; return null; }
    const cs = 18, c = document.createElement('canvas'); c.width = 21 * cs; c.height = 15 * cs;
    const x = c.getContext('2d');
    if (!x) { if (!lvOverride) this.mini = null; return null; }
    x.fillStyle = '#0e1320'; x.fillRect(0, 0, c.width, c.height);
    lv.rows.forEach((row, ry) => [...row].forEach((k, rx) => {
      if (k === '#') {
        x.fillStyle = '#47363a'; x.fillRect(rx * cs, ry * cs, cs, cs);
        x.fillStyle = '#7c5750'; x.fillRect(rx * cs, ry * cs, cs, 3);
      } else if (k === '%') {
        x.fillStyle = '#626f8a'; x.beginPath(); x.arc(rx * cs + cs / 2, ry * cs + cs / 2, cs * 0.34, 0, 7); x.fill();
      } else if (k === 'o') {
        x.fillStyle = '#5eead4'; x.fillRect(rx * cs + 5, ry * cs + 5, cs - 10, cs - 10);
      }
    }));
    const cols = ['#1fbf5a', '#2f5cff', '#ff7a14', '#e83e98'];
    for (const [k, [sx, sy]] of Object.entries(lv.starts || {})) {
      x.fillStyle = cols[(+k - 1) & 3] || '#ffcf5a';
      x.beginPath(); x.arc(sx * cs + cs / 2, sy * cs + cs / 2, cs * 0.36, 0, 7); x.fill();
    }
    if (!lvOverride) this.mini = c;
    return c;
  }

  // ---------------------------------------------------------------- drawing helpers
  font(size, weight = 600, family = DISPLAY, spacing = 0) {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${family}`;
    if ('letterSpacing' in c) c.letterSpacing = spacing ? spacing + 'px' : '0px';
  }
  rr(x, y, w, h, r) { const c = this.ctx; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }

  drawIcon(kind, cx, cy, col, alpha = 1) {
    if (!kind) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (kind) {
      case 'play':
        ctx.beginPath();
        ctx.moveTo(cx - 5, cy - 7); ctx.lineTo(cx + 8, cy); ctx.lineTo(cx - 5, cy + 7);
        ctx.closePath(); ctx.fill();
        break;
      case 'online':
        ctx.beginPath(); ctx.arc(cx, cy, 8.5, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx, cy, 4, 8.5, 0, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
        break;
      case 'keys':
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(cx - 10, cy - 6, 20, 12, 3) : ctx.rect(cx - 10, cy - 6, 20, 12);
        ctx.stroke();
        for (const ox of [-5, 0, 5]) { ctx.fillRect(cx + ox - 1, cy - 2, 2, 2); }
        ctx.fillRect(cx - 4, cy + 2, 8, 1.8);
        break;
      case 'sliders':
        for (const [oy, dx] of [[-5, 3], [0, -4], [5, 2]]) {
          ctx.beginPath(); ctx.moveTo(cx - 8, cy + oy); ctx.lineTo(cx + 8, cy + oy); ctx.stroke();
          ctx.beginPath(); ctx.arc(cx + dx, cy + oy, 2.3, 0, 7); ctx.fill();
        }
        break;
      case 'exit':
        ctx.beginPath();
        ctx.moveTo(cx + 2, cy - 8); ctx.lineTo(cx - 7, cy - 8); ctx.lineTo(cx - 7, cy + 8); ctx.lineTo(cx + 2, cy + 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 1, cy); ctx.lineTo(cx + 8, cy);
        ctx.moveTo(cx + 5, cy - 3.5); ctx.lineTo(cx + 8.5, cy); ctx.lineTo(cx + 5, cy + 3.5);
        ctx.stroke();
        break;
      case 'key':
        ctx.beginPath(); ctx.arc(cx - 4, cy, 4, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 9, cy); ctx.lineTo(cx + 9, cy + 4); ctx.moveTo(cx + 5.5, cy); ctx.lineTo(cx + 5.5, cy + 3); ctx.stroke();
        break;
      case 'battle':
        ctx.beginPath();
        ctx.moveTo(cx - 7, cy + 7); ctx.lineTo(cx + 7, cy - 7);
        ctx.moveTo(cx + 7, cy + 7); ctx.lineTo(cx - 7, cy - 7);
        ctx.stroke();
        break;
      case 'spark':
        ctx.beginPath();
        ctx.moveTo(cx, cy - 9); ctx.lineTo(cx + 2.5, cy - 2.5); ctx.lineTo(cx + 9, cy);
        ctx.lineTo(cx + 2.5, cy + 2.5); ctx.lineTo(cx, cy + 9); ctx.lineTo(cx - 2.5, cy + 2.5);
        ctx.lineTo(cx - 9, cy); ctx.lineTo(cx - 2.5, cy - 2.5); ctx.closePath();
        ctx.fill();
        break;
      case 'back':
        ctx.beginPath();
        ctx.moveTo(cx + 7, cy); ctx.lineTo(cx - 6, cy);
        ctx.moveTo(cx - 2, cy - 4.5); ctx.lineTo(cx - 7, cy); ctx.lineTo(cx - 2, cy + 4.5);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  glassPanel(x, y, w, h, r = 24) {
    const ctx = this.ctx;
    const pad = 56;
    const key = `${w | 0}:${h | 0}:${r}`;
    if (!this._panelCache) this._panelCache = new Map();
    let c = this._panelCache.get(key);
    if (!c || c.getContext?.('2d')?.isContextLost?.()) {
      c = document.createElement('canvas');
      c.width = Math.ceil(w + pad * 2);
      c.height = Math.ceil(h + pad * 2);
      const x2 = c.getContext('2d');
      if (x2) {
        const rr2 = (px, py, pw, ph, pr) => { x2.beginPath(); x2.roundRect ? x2.roundRect(px, py, pw, ph, pr) : x2.rect(px, py, pw, ph); };
        x2.save();
        rr2(pad, pad, w, h, r);
        x2.shadowColor = 'rgba(0,0,0,0.72)'; x2.shadowBlur = 50; x2.shadowOffsetY = 20;
        const g = x2.createLinearGradient(0, pad, 0, pad + h);
        g.addColorStop(0, 'rgba(22, 28, 46, 0.86)');
        g.addColorStop(1, 'rgba(9, 12, 21, 0.94)');
        x2.fillStyle = g; x2.fill(); x2.shadowBlur = 0; x2.shadowOffsetY = 0;
        x2.strokeStyle = 'rgba(255, 255, 255, 0.13)'; x2.lineWidth = 1.5; x2.stroke();

        // Top specular rim accent
        rr2(pad + w * 0.14, pad + 0.5, w * 0.72, 2, 1);
        const hl = x2.createLinearGradient(pad + w * 0.14, 0, pad + w * 0.86, 0);
        hl.addColorStop(0, 'rgba(255,255,255,0)');
        hl.addColorStop(0.5, 'rgba(255,212,155,0.48)');
        hl.addColorStop(1, 'rgba(255,255,255,0)');
        x2.fillStyle = hl; x2.fill();
        x2.restore();
        this._panelCache.set(key, c);
      } else {
        c = null;
      }
    }
    if (c) ctx.drawImage(c, x - pad, y - pad);
  }

  drawBackdrop() {
    if (!this.fctx || this.fctx.isContextLost?.() || !this.fireImg) { this._initFire(); this._fireLastT = -1; }
    const ctx = this.ctx, t = this.t + 100, W = this.canvas.width, H = this.canvas.height;
    if (this.fctx && this.fireImg && this.fire?.width > 0) {
      if (this._fireLastT == null || this._fireLastT < 0 || Math.abs(this.t - this._fireLastT) >= 1 / 30) {
        this._fireLastT = this.t;
        const d = this.fireImg.data;
        const t045 = t * 0.45, t055 = t * 0.55, t03 = t * 0.3;
        for (let x = 0; x < FW; x++) X_SIN[x] = Math.sin(x * 0.09 + t045);
        for (let y = 0; y < FH; y++) {
          const yFade = Y_FADE[y], sy = Math.sin(y * 0.135 - t055), row = y * FW;
          const diagBase = y * 0.068 + t03;
          for (let x = 0; x < FW; x++) {
            const idx = row + x;
            const v = X_SIN[x] + sy + Math.sin(x * 0.068 + diagBase) + Math.sin(HYPOT_LUT[idx] - t);
            let k = (v + 4) * 0.125;
            if (k <= 0) k = 0; else if (k >= 1) k = yFade; else k = k * k * yFade;
            const ci = ((k * 255) | 0) * 3, o = idx << 2;
            d[o] = FIRE_LUT[ci]; d[o + 1] = FIRE_LUT[ci + 1]; d[o + 2] = FIRE_LUT[ci + 2]; d[o + 3] = 255;
          }
        }
        this.fctx.putImageData(this.fireImg, 0, 0);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(this.fire, 0, 0, W, H);
    }

    // Subtle futuristic coordinate grid in virtual space
    ctx.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 190, 130, 0.032)';
    ctx.lineWidth = 1;
    const step = 96;
    const shift = (this.t * 14) % step;
    ctx.beginPath();
    for (let gx = 0; gx <= VW; gx += step) { ctx.moveTo(gx, 0); ctx.lineTo(gx, VH); }
    for (let gy = -step + shift; gy <= VH; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(VW, gy); }
    ctx.stroke();
    ctx.restore();

    if (this.embers.length < 85) {
      this.embers.push({
        x: Math.random() * VW, y: VH + 12,
        vx: (Math.random() - 0.5) * 28, vy: -48 - Math.random() * 115,
        s: 1.4 + Math.random() * 2.8, life: 0, max: 4.5 + Math.random() * 4.5,
      });
    }
    ctx.globalCompositeOperation = 'lighter';
    const dt = this.dt || 1 / 60;
    let ew = 0;
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      e.life += dt; if (e.life >= e.max) continue;
      e.x += (e.vx + Math.sin(e.life * 2 + e.s) * 18) * dt; e.y += e.vy * dt;
      const a = Math.min(1, e.life) * Math.max(0, 1 - e.life / e.max);
      ctx.fillStyle = `rgba(255,${155 + e.s * 20 | 0},80,${a * 0.78})`; ctx.beginPath(); ctx.arc(e.x, e.y, e.s, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,100,30,${a * 0.15})`; ctx.beginPath(); ctx.arc(e.x, e.y, e.s * 4.2, 0, 7); ctx.fill();
      this.embers[ew++] = e;
    }
    this.embers.length = ew;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const vigBad = !this.vig || ('naturalWidth' in this.vig
      ? (this.vig.complete === false || !this.vig.naturalWidth)
      : (!this.vig.width || !this.vig.height || this.vig.getContext?.('2d')?.isContextLost?.()));
    if (vigBad) this.resize();
    if (this.vig && (('naturalWidth' in this.vig) ? this.vig.naturalWidth > 0 : (this.vig.width > 0 && this.vig.height > 0))) {
      ctx.drawImage(this.vig, 0, 0, W, H);
    }
  }

  drawLogo(targetH, topY = 42) {
    const ctx = this.ctx, L = this.art?.logo_hd;
    if (!L?.width || !L?.height) return topY + targetH;
    if (this.glowLogo?.canvas?.getContext?.('2d')?.isContextLost?.()) this.glowLogo = null;
    if (!this.glowLogo && L?.width) {
      const pad = 64, c = document.createElement('canvas');
      c.width = L.width + pad * 2; c.height = L.height + pad * 2;
      const x = c.getContext('2d');
      if (x) {
        x.shadowColor = 'rgba(255, 95, 30, 0.52)'; x.shadowBlur = 54; x.drawImage(L, pad, pad);
        x.shadowColor = 'rgba(0, 0, 0, 0.78)'; x.shadowBlur = 18; x.shadowOffsetY = 10; x.drawImage(L, pad, pad);
        this.glowLogo = { canvas: c, pad, lw: L.width, lh: L.height };
      }
    }
    this.logoH += (targetH - this.logoH) * Math.min(1, (this.dt || 0.016) * 10);
    const h = this.logoH, w = h * L.width / L.height, x = VW / 2 - w / 2, y = topY + Math.sin(this.t * 0.9) * 3;
    const gl = this.glowLogo;
    if (gl?.canvas?.width > 0) {
      const sx = w / gl.lw, sy = h / gl.lh, px = gl.pad * sx, py = gl.pad * sy;
      ctx.drawImage(gl.canvas, x - px, y - py, gl.canvas.width * sx, gl.canvas.height * sy);
    } else ctx.drawImage(L, x, y, w, h);
    return y + h;
  }

  drawPillBtn(x, y, w, h, label, { id, primary = false, hot = false, action } = {}) {
    const ctx = this.ctx;
    ctx.save();
    this.rr(x, y, w, h, 14);
    if (primary) {
      if (hot) { ctx.shadowColor = 'rgba(255, 110, 40, 0.55)'; ctx.shadowBlur = 24; }
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, hot ? '#ff7232' : '#f25c1c');
      g.addColorStop(1, hot ? '#cc3614' : '#b82c10');
      ctx.fillStyle = g; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = hot ? '#ffe0a8' : 'rgba(255, 188, 128, 0.72)'; ctx.lineWidth = 1.8; ctx.stroke();
    } else {
      ctx.fillStyle = hot ? 'rgba(255, 255, 255, 0.14)' : 'rgba(22, 28, 44, 0.84)';
      ctx.fill();
      ctx.strokeStyle = hot ? 'rgba(255, 200, 140, 0.55)' : 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 1.5; ctx.stroke();
    }
    this.font(19, 700, DISPLAY, 1.5);
    ctx.fillStyle = primary ? '#ffffff' : (hot ? '#ffffff' : '#e2e8f0');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.restore();
    if (action) this.boxes.push({ id, x, y, w, h, action });
  }

  drawFooter(hints) {
    const ctx = this.ctx, fy = 1018;
    this.font(16, 500, SANS, 0.2);
    const parts = hints.map(([k, label, action]) => {
      const kw = Math.max(40, ctx.measureText(k).width + 24);
      const lw = ctx.measureText(label).width;
      return { k, label, action, kw, w: kw + 10 + lw };
    });
    const total = parts.reduce((s, p) => s + p.w, 0) + (parts.length - 1) * 28;
    const dockW = total + 44;
    this.rr(VW / 2 - dockW / 2, fy - 24, dockW, 48, 24);
    ctx.fillStyle = 'rgba(11, 15, 26, 0.72)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)'; ctx.lineWidth = 1; ctx.stroke();

    let x = VW / 2 - total / 2;
    for (const p of parts) {
      if (p.action) this.boxes.push({ id: 'foot-' + p.k, x: x - 6, y: fy - 22, w: p.w + 12, h: 44, action: p.action });
      this.rr(x, fy - 16, p.kw, 32, 8);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'; ctx.lineWidth = 1.2; ctx.stroke();
      this.font(14, 700, MONO);
      ctx.fillStyle = '#f3f6fc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.k, x + p.kw / 2, fy + 1);
      this.font(16, 500, SANS);
      ctx.fillStyle = '#98a4be'; ctx.textAlign = 'left'; ctx.fillText(p.label, x + p.kw + 10, fy + 1);
      x += p.w + 28;
    }
    this.font(13, 500, MONO, 0.4); ctx.fillStyle = 'rgba(180, 195, 220, 0.36)'; ctx.textAlign = 'right';
    ctx.fillText('FRACAS 2027 · © 1997 GECKOSOFT', VW - 44, fy + 1);
    this.font(16, 500, SANS, 0);
  }

  heading(text, y) {
    const ctx = this.ctx;
    this.font(28, 700, DISPLAY, 3.2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const up = text.toUpperCase(), w = ctx.measureText(up).width;
    ctx.fillStyle = '#f8fafc'; ctx.fillText(up, VW / 2, y);
    const lg = (x0, x1) => { const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, 'rgba(255,168,92,0)'); g.addColorStop(1, 'rgba(255,168,92,0.58)'); return g; };
    ctx.fillStyle = lg(VW / 2 - w / 2 - 210, VW / 2 - w / 2 - 26); ctx.fillRect(VW / 2 - w / 2 - 210, y - 1, 184, 2);
    ctx.fillStyle = lg(VW / 2 + w / 2 + 210, VW / 2 + w / 2 + 26); ctx.fillRect(VW / 2 + w / 2 + 26, y - 1, 184, 2);
    this.font(16, 500, SANS, 0);
  }

  /** Draw a single modern glass control row at (x, y, w, H) for item index `i`. */
  drawRow(it, i, x, y, w, H) {
    const ctx = this.ctx, on = i === this.sel;
    const h = this.hover[i] = (this.hover[i] || 0) + ((on ? 1 : 0) - (this.hover[i] || 0)) * Math.min(1, (this.dt || 0.016) * 16);
    this.boxes.push({ id: 'item-' + i, x, y, w, h: H, item: i });
    ctx.save();
    this.rr(x, y, w, H, 14);
    if (h > 0.02) { ctx.shadowColor = `rgba(255, 96, 32, ${0.42 * h})`; ctx.shadowBlur = 24 * h; }
    const g = ctx.createLinearGradient(x, y, x + w, y + H);
    g.addColorStop(0, `rgba(${20 + 220 * h | 0}, ${26 + 68 * h | 0}, ${42 - 14 * h | 0}, ${0.62 + 0.34 * h})`);
    g.addColorStop(1, `rgba(${13 + 172 * h | 0}, ${18 + 28 * h | 0}, ${30 - 12 * h | 0}, ${0.70 + 0.26 * h})`);
    ctx.fillStyle = g; ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = on ? 'rgba(255, 198, 134, 0.92)' : 'rgba(255, 255, 255, 0.09)';
    ctx.lineWidth = on ? 1.8 : 1; ctx.stroke();

    if (h > 0.05) {
      ctx.fillStyle = `rgba(255, 232, 175, ${h})`;
      this.rr(x + 4, y + 9, 4, H - 18, 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.textBaseline = 'middle';
    const cy = y + H / 2, col = on ? '#ffffff' : '#dce4f4';
    if (it.value) {
      this.font(H < 56 ? 18.5 : 20.5, 600, DISPLAY, 0.4); ctx.textAlign = 'left'; ctx.fillStyle = col;
      ctx.fillText(it.label, x + 22, cy + 1, w * 0.48);

      const right = x + w - 20;
      if (it.toggle) {
        const isOn = !!it.toggle();
        const ta = this.toggleAnim[i] = (this.toggleAnim[i] ?? (isOn ? 1 : 0)) + ((isOn ? 1 : 0) - (this.toggleAnim[i] ?? (isOn ? 1 : 0))) * Math.min(1, (this.dt || 0.016) * 16);
        const sw = 52, sh = 26, sx = right - sw, sy = cy - sh / 2;
        this.rr(sx, sy, sw, sh, sh / 2);
        ctx.fillStyle = isOn ? 'rgba(94, 234, 212, 0.30)' : 'rgba(255, 255, 255, 0.12)'; ctx.fill();
        ctx.strokeStyle = isOn ? '#5eead4' : 'rgba(255, 255, 255, 0.24)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath(); ctx.arc(sx + 13 + ta * (sw - 26), cy, 9.5, 0, 7);
        ctx.fillStyle = isOn ? '#5eead4' : '#e2e8f0'; ctx.fill();
        this.font(15, 700, MONO); ctx.textAlign = 'right';
        ctx.fillStyle = on ? '#ffffff' : (isOn ? '#5eead4' : '#98a4be');
        ctx.fillText(it.value(), sx - 12, cy + 1);
        this.boxes.push({ id: 'tog-' + i, x: sx - 64, y, w: sw + 74, h: H, item: i, dir: 1 });
      } else if (it.bar) {
        const rArrow = right - 10, valRight = right - 34, bw = Math.min(168, Math.max(96, w * 0.24)), bx = valRight - 72 - bw, lArrow = bx - 22;
        const f = Math.max(0, Math.min(1, it.bar()));
        this.rr(bx, cy - 4, bw, 8, 4); ctx.fillStyle = 'rgba(0, 0, 0, 0.48)'; ctx.fill();
        if (f > 0) { this.rr(bx, cy - 4, bw * f, 8, 4); ctx.fillStyle = on ? '#fff3c4' : '#ff9f43'; ctx.fill(); }
        ctx.beginPath(); ctx.arc(bx + bw * f, cy, on ? 7.5 : 6, 0, 7);
        ctx.fillStyle = on ? '#ffffff' : '#ffcf5a'; ctx.fill();
        this.font(17, 700, MONO); ctx.textAlign = 'right';
        ctx.fillStyle = on ? '#ffffff' : '#ffd39b';
        ctx.fillText(it.value(), valRight, cy + 1);
        this.font(22, 700, SANS); ctx.textAlign = 'center';
        ctx.fillStyle = on ? '#ffffff' : 'rgba(203, 213, 225, 0.65)';
        const pulse = on ? Math.sin(this.t * 6) * 2 : 0;
        ctx.fillText('‹', lArrow - pulse, cy - 1);
        ctx.fillText('›', rArrow + pulse, cy - 1);
        this.boxes.push({ id: 'l-' + i, x: lArrow - 18, y, w: 36, h: H, item: i, dir: -1 });
        this.boxes.push({ id: 'b-' + i, x: bx - 8, y, w: bw + 16, h: H, item: i, bx, bw, set: it.set });
        this.boxes.push({ id: 'r-' + i, x: rArrow - 18, y, w: 36, h: H, item: i, dir: 1 });
      } else {
        const rArrow = right - 10, span = Math.min(204, Math.max(150, w * 0.33)), lArrow = right - span, valCx = (lArrow + rArrow) / 2;
        this.font(16.5, 700, MONO); ctx.textAlign = 'center';
        ctx.fillStyle = on ? '#ffffff' : '#ffd39b';
        ctx.fillText(it.value(), valCx, cy + 1, span - 42);
        this.font(22, 700, SANS);
        ctx.fillStyle = on ? '#ffffff' : 'rgba(203, 213, 225, 0.65)';
        const pulse = on ? Math.sin(this.t * 6) * 2 : 0;
        ctx.fillText('‹', lArrow - pulse, cy - 1);
        ctx.fillText('›', rArrow + pulse, cy - 1);
        this.boxes.push({ id: 'l-' + i, x: lArrow - 20, y, w: 40, h: H, item: i, dir: -1 });
        this.boxes.push({ id: 'r-' + i, x: rArrow - 20, y, w: 40, h: H, item: i, dir: 1 });
      }
    } else if (it.sub || it.icon) {
      const hasIcon = !!it.icon;
      if (hasIcon) {
        const ih = Math.min(38, H - 14);
        this.rr(x + 16, cy - ih / 2, ih, ih, 10);
        ctx.fillStyle = on ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        ctx.fill();
        this.drawIcon(it.icon, x + 16 + ih / 2, cy, on ? '#ffffff' : '#ffcf88');
      }
      if (it.sub) {
        ctx.textAlign = 'left';
        this.font(20.5, 700, DISPLAY, 1.0); ctx.fillStyle = col;
        ctx.fillText(it.label.toUpperCase(), x + 70, cy - 10);
        this.font(13.5, 500, SANS, 0.2); ctx.fillStyle = on ? 'rgba(255,244,226,0.86)' : '#8d9bb6';
        ctx.fillText(it.sub, x + 70, cy + 13, w - 110);
        if (on) {
          this.font(22, 700, SANS); ctx.fillStyle = '#fff3d6'; ctx.textAlign = 'right';
          ctx.fillText('›', x + w - 22 + Math.sin(this.t * 7) * 3, cy);
        }
      } else {
        this.font(H < 56 ? 19 : 21, 700, DISPLAY, 1.3); ctx.textAlign = 'center'; ctx.fillStyle = col;
        const txt = it.label.toUpperCase();
        ctx.fillText(txt, x + w / 2, cy + 1);
        if (on) {
          const tw = ctx.measureText(txt).width, f = Math.sin(this.t * 7) * 3;
          for (const sx of [-1, 1]) this.diamond(x + w / 2 + sx * (tw / 2 + 24 + f), cy);
        }
      }
    } else {
      this.font(H < 56 ? 19.5 : 22, 700, DISPLAY, 1.4); ctx.textAlign = 'center'; ctx.fillStyle = col;
      const txt = it.label.toUpperCase();
      ctx.fillText(txt, x + w / 2, cy + 1);
      if (on) {
        const tw = ctx.measureText(txt).width, f = Math.sin(this.t * 7) * 3;
        for (const sx of [-1, 1]) this.diamond(x + w / 2 + sx * (tw / 2 + 26 + f), cy);
      }
    }
    this.font(16, 500, SANS, 0);
  }

  drawItems(its, y0, { w = 640, H = 64, GAP = 12, padX = 28, padY = 22 } = {}) {
    const x = VW / 2 - w / 2;
    const totalH = its.length * H + Math.max(0, its.length - 1) * GAP;
    this.glassPanel(x - padX, y0 - padY, w + padX * 2, totalH + padY * 2, 24);
    its.forEach((it, i) => this.drawRow(it, i, x, y0 + i * (H + GAP), w, H));
  }

  /** Modern 2-Column Battle Setup Studio with live Arena minimap preview (zero overflow!). */
  drawBattleSetup(its, yTop) {
    const ctx = this.ctx;
    const b = this.app.battleCfg || { arena: 0, wins: 3, random: false };
    const lv = this.app.data.battle[b.arena] || this.app.data.battle[0];
    if (this._battlePreviewIdx !== b.arena || !this._battleMini) {
      this._battlePreviewIdx = b.arena;
      this._battleMini = this.miniMap(lv);
    }

    const colGap = 28;
    const leftW = 700, rightW = 760, totalW = leftW + colGap + rightW;
    const lx = VW / 2 - totalW / 2, rx = lx + leftW + colGap;
    const panelH = 548;

    // Left Card: Arena Preview + Core Match Settings (items 0, 1, 4 -> Arena, Wins, Random)
    this.glassPanel(lx, yTop, leftW, panelH, 22);
    this.font(13, 700, MONO, 2.2); ctx.fillStyle = '#5eead4'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('ARENA PREVIEW', lx + 28, yTop + 28);
    this.font(15, 700, DISPLAY, 0.8); ctx.fillStyle = '#ffcf5a'; ctx.textAlign = 'right';
    ctx.fillText((lv?.name || `Arena ${b.arena + 1}`).toUpperCase(), lx + leftW - 28, yTop + 28);

    // Live minimap frame
    const mw = 390, mh = Math.round(mw * 15 / 21);
    const mx = lx + (leftW - mw) / 2, my = yTop + 48;
    this.rr(mx - 10, my - 6, mw + 20, mh + 12, 14);
    ctx.fillStyle = 'rgba(6, 9, 16, 0.86)'; ctx.fill();
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (this._battleMini && !this._battleMini.getContext?.('2d')?.isContextLost?.()) {
      ctx.drawImage(this._battleMini, mx, my, mw, mh);
    }

    // Left column rows: Arena (0), Wins Needed (1), Random Arena (2)
    const leftIdxs = [0, 1, 2];
    leftIdxs.forEach((idxItem, pos) => {
      if (its[idxItem]) this.drawRow(its[idxItem], idxItem, lx + 24, yTop + 344 + pos * 62, leftW - 48, 54);
    });

    // Right Card: AI Bots & Combat Rules (items 3, 4, 5, 6, 7)
    this.glassPanel(rx, yTop, rightW, panelH, 22);
    this.font(13, 700, MONO, 2.2); ctx.fillStyle = '#ff9f50'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('COMBAT RULES & AI BOTS', rx + 28, yTop + 28);
    this.font(13, 600, SANS); ctx.fillStyle = '#98a4be'; ctx.textAlign = 'right';
    ctx.fillText('Smart AI Wizards · Custom Mutators', rx + rightW - 28, yTop + 28);

    const rightIdxs = [3, 4, 5, 6, 7];
    rightIdxs.forEach((idxItem, pos) => {
      if (its[idxItem]) this.drawRow(its[idxItem], idxItem, rx + 24, yTop + 56 + pos * 76, rightW - 48, 64);
    });

    // Bottom Action Bar inside Right Card bottom / below panels cleanly above footer (y = yTop + panelH + 22)
    const barY = yTop + panelH + 22;
    const backIdx = its.length - 1;
    const playIdx = its.length - 2;
    const btnH = 62;
    this.drawPillBtn(lx, barY, 260, btnH, '‹  BACK', {
      id: 'item-' + backIdx,
      hot: this.sel === backIdx || this.hoverBox === 'item-' + backIdx,
      action: () => its[backIdx]?.ok?.(),
    });
    // Register item index for keyboard highlight sync
    if (this.boxes.length) this.boxes[this.boxes.length - 1].item = backIdx;

    this.drawPillBtn(rx + rightW - 380, barY, 380, btnH, 'CHOOSE PLAYERS  ›', {
      id: 'item-' + playIdx,
      primary: true,
      hot: this.sel === playIdx || this.hoverBox === 'item-' + playIdx,
      action: () => its[playIdx]?.ok?.(),
    });
    if (this.boxes.length) this.boxes[this.boxes.length - 1].item = playIdx;
  }

  diamond(x, y) {
    const ctx = this.ctx, r = 6 + Math.sin(this.t * 14 + x) * 0.8;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.shadowColor = '#ffb347'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#fff3d6';
    ctx.fillRect(-r / 2, -r / 2, r, r);
    ctx.restore();
  }

  // ---------------------------------------------------------------- frame
  draw() {
    const ctx = this.ctx;
    if (!ctx || ctx.isContextLost?.() || !this.canvas?.width || !this.canvas?.height) return;
    this.boxes = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if ('filter' in ctx && ctx.filter !== 'none') ctx.filter = 'none';
    ctx.fillStyle = '#060810'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawBackdrop();
    ctx.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
    if (this.screen === 'select') return this.drawSelect();

    const main = this.screen === 'main', opts = this.screen === 'options', battle = this.screen === 'battle';
    const its = this.items();
    const targetH = main ? 300 : opts ? 136 : battle ? 136 : 230;
    const topY = main ? 42 : opts ? 22 : battle ? 22 : 38;
    const bottom = this.drawLogo(targetH, topY);

    if (main) {
      const pw = 510, ph = 36, py = bottom + 14;
      this.rr(VW / 2 - pw / 2, py, pw, ph, 18);
      ctx.fillStyle = 'rgba(12, 18, 32, 0.78)'; ctx.fill();
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.36)'; ctx.lineWidth = 1.2; ctx.stroke();
      this.font(13.5, 700, MONO, 3.0); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#5eead4';
      ctx.fillText('2027 EDITION · CO-OP · BATTLE · P2P ONLINE', VW / 2, py + ph / 2 + 1);
      this.font(16, 500, SANS, 0);
      this.drawItems(its, py + 60, { w: 640, H: 74, GAP: 12, padX: 28, padY: 22 });
    } else {
      let y = bottom + (opts || battle ? 34 : 46);
      this.heading(TITLES[this.screen] || '', y);
      y += opts || battle ? 44 : 66;
      if (this.screen === 'password') return this.drawPassword(y);
      if (battle) {
        this.drawBattleSetup(its, y);
      } else if (this.screen === 'exit') {
        this.glassPanel(VW / 2 - 440, y - 16, 880, 128, 22);
        this.font(24, 500, SANS); ctx.fillStyle = '#dce4f4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Thanks for playing Fracas 2027. You can close this window at any time.', VW / 2, y + 48);
        this.drawItems(its, y + 150, { w: 460, H: 68 });
      } else if (opts) {
        // Auto-fit rows cleanly above the footer dock (y=960) so Options NEVER overflows!
        const availH = 950 - y;
        const gap = its.length > 8 ? 7 : 9;
        const rowH = Math.max(46, Math.min(58, Math.floor((availH - 36 - (its.length - 1) * gap) / Math.max(1, its.length))));
        this.drawItems(its, y + 10, { w: 860, H: rowH, GAP: gap, padX: 30, padY: 18 });
      } else {
        const availH = 940 - y;
        const gap = 12;
        const rowH = Math.max(58, Math.min(72, Math.floor((availH - 44 - (its.length - 1) * gap) / Math.max(1, its.length))));
        this.drawItems(its, y, { w: 680, H: rowH, GAP: gap, padX: 30, padY: 22 });
      }
    }

    const cur = its[this.sel];
    this.drawFooter(cur?.value
      ? [['↑↓', 'Choose'], ['←→', 'Adjust'], ['Esc', 'Back', () => this.back()]]
      : main
        ? [['↑↓', 'Choose'], ['Enter', 'Select']]
        : [['↑↓', 'Choose'], ['Enter', 'Select'], ['Esc', 'Back', () => this.back()]]);
  }

  drawPassword(y) {
    const ctx = this.ctx, N = 10, BW = 72, BH = 88, G = 12, total = N * BW + (N - 1) * G;
    this.glassPanel(VW / 2 - 480, y - 24, 960, 224, 24);
    this.shakeT = Math.max(0, (this.shakeT || 0) - (this.dt || 0.016));
    let x = VW / 2 - total / 2 + Math.sin(this.t * 60) * 14 * this.shakeT;
    for (let i = 0; i < N; i++, x += BW + G) {
      const cur = i === this.typed.length;
      this.rr(x, y + 8, BW, BH, 13); ctx.fillStyle = 'rgba(6, 8, 15, 0.80)'; ctx.fill();
      ctx.strokeStyle = cur ? `rgba(255, 207, 90, ${0.55 + Math.sin(this.t * 6) * 0.45})` : (this.typed[i] ? 'rgba(94, 234, 212, 0.35)' : 'rgba(255, 255, 255, 0.16)');
      ctx.lineWidth = cur ? 2.5 : 1.5; ctx.stroke();
      const ch = this.typed[i];
      if (ch) { this.font(46, 700, MONO); ctx.fillStyle = '#f8fafc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ch, x + BW / 2, y + BH / 2 + 10); }
      else if (cur && Math.floor(this.t * 2.5) % 2 === 0) { ctx.fillStyle = '#ffcf5a'; ctx.fillRect(x + BW / 2 - 16, y + BH - 12, 32, 4); }
    }
    this.boxes.push({ id: 'pw-focus', x: VW / 2 - 480, y: y - 24, w: 960, h: 140, action: () => this.focusPasswordInput() });
    this.font(20, 500, SANS); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (this.note) { ctx.fillStyle = this.good ? '#5eead4' : '#ff6b81'; ctx.fillText(this.note, VW / 2, y + BH + 56); }
    else { ctx.fillStyle = '#98a4be'; ctx.fillText('Type a level password (or tap boxes to paste/type) and press Enter', VW / 2, y + BH + 56); }

    const bw = 230, bh = 58, gap = 18, by = y + 234;
    this.drawPillBtn(VW / 2 - bw - gap / 2, by, bw, bh, 'BACK', { id: 'pw-back', hot: this.hoverBox === 'pw-back', action: () => this.back() });
    this.drawPillBtn(VW / 2 + gap / 2, by, bw, bh, 'CONFIRM', { id: 'pw-ok', primary: true, hot: this.hoverBox === 'pw-ok', action: () => this.submitPassword() });

    this.drawFooter([['A–Z', 'Type'], ['Enter', 'Confirm'], ['Esc', 'Back', () => this.back()]]);
  }

  drawSelect() {
    const ctx = this.ctx, A = this.art, battle = this.opts.mode === 'battle', inp = this.app.input;
    ctx.fillStyle = 'rgba(4, 6, 12, 0.34)'; ctx.fillRect(0, 0, VW, VH);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (!this._selTitleCache || this._selTitleCache.getContext?.('2d')?.isContextLost?.()) {
      const tc = document.createElement('canvas'); tc.width = 780; tc.height = 110;
      const tx = tc.getContext('2d');
      if (tx) {
        tx.font = `700 50px ${DISPLAY}`;
        if ('letterSpacing' in tx) tx.letterSpacing = '2px';
        tx.textAlign = 'center'; tx.textBaseline = 'middle';
        tx.fillStyle = '#f8fafc';
        tx.shadowColor = 'rgba(255, 110, 40, 0.45)'; tx.shadowBlur = 28;
        tx.fillText('CHOOSE YOUR WIZARD', tc.width / 2, tc.height / 2);
        this._selTitleCache = tc;
      }
    }
    if (this._selTitleCache) ctx.drawImage(this._selTitleCache, VW / 2 - this._selTitleCache.width / 2, 74 - this._selTitleCache.height / 2);

    const sub = (battle ? 'BATTLE GAME  ·  ARENA ' : 'NORMAL GAME  ·  LEVEL ') + String(this.level.id).padStart(2, '0') + (this.level.world && !battle ? '  ·  ' + this.level.world.toUpperCase() : '');
    this.font(18, 700, MONO, 1.5);
    const sw = ctx.measureText(sub).width + 44;
    this.rr(VW / 2 - sw / 2, 112, sw, 38, 19);
    ctx.fillStyle = 'rgba(19, 24, 38, 0.80)'; ctx.fill();
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.38)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#5eead4'; ctx.fillText(sub, VW / 2, 132);

    const CW = 366, CH = 528, GAP = 30, totalW = CW * 4 + GAP * 3, x0 = VW / 2 - totalW / 2, y0 = 178;
    const devBadge = d => d?.startsWith?.('bot:') ? `BOT · ${d.slice(4).toUpperCase()}` : d === 'touch' ? 'TOUCH' : d === 'kb0' ? 'KB 1' : d === 'kb1' ? 'KB 2' : 'PAD ' + (+d.slice(3) + 1);
    const controlsLabel = k => {
      if (k === 0) {
        const ks = inp.keys[0];
        return { move: `${inp.keyName(ks.up)}/${inp.keyName(ks.left)}/${inp.keyName(ks.down)}/${inp.keyName(ks.right)}`, brew: inp.keyName(ks.bomb), spell: inp.keyName(ks.power) };
      }
      if (k === 1) {
        const ks = inp.keys[1];
        return { move: `${inp.keyName(ks.up)}/${inp.keyName(ks.left)}/${inp.keyName(ks.down)}/${inp.keyName(ks.right)}`, brew: inp.keyName(ks.bomb), spell: inp.keyName(ks.power) };
      }
      return { move: 'STICK / D-PAD', brew: 'A', spell: 'B / X' };
    };
    const keyHint = k => {
      if (!this.devices.includes('kb0') && k === 0) return inp.keyName(inp.keys[0].bomb) + ' / CLICK';
      if (!this.devices.includes('kb1') && k <= 1) return inp.keyName(inp.keys[1].bomb) + ' / CLICK';
      return 'PAD A / CLICK';
    };

    if (!this._cardCache) this._cardCache = new Map();
    const cardPad = 42;
    for (let k = 0; k < 4; k++) {
      const x = x0 + k * (CW + GAP), on = !!this.devices[k], tm = TEAM[k], jt = this.joinT[k];
      this.boxes.push({ id: 'card-' + k, x, y: y0, w: CW, h: CH, action: () => this.clickCard(k) });
      const cKey = `${k}:${on ? 1 : 0}`;
      let cardImg = this._cardCache.get(cKey);
      if (!cardImg || cardImg.getContext?.('2d')?.isContextLost?.()) {
        const cc = document.createElement('canvas');
        cc.width = CW + cardPad * 2; cc.height = CH + cardPad * 2;
        const gx = cc.getContext('2d');
        if (gx) {
          const rr2 = (px, py, pw, ph, pr) => { gx.beginPath(); gx.roundRect ? gx.roundRect(px, py, pw, ph, pr) : gx.rect(px, py, pw, ph); };
          gx.save();
          rr2(cardPad, cardPad, CW, CH, 22);
          if (on) { gx.shadowColor = tm.color; gx.shadowBlur = 36; }
          const g = gx.createLinearGradient(0, cardPad, 0, cardPad + CH);
          g.addColorStop(0, on ? 'rgba(28, 35, 55, 0.94)' : 'rgba(15, 19, 31, 0.86)');
          g.addColorStop(1, 'rgba(9, 12, 20, 0.96)');
          gx.fillStyle = g; gx.fill(); gx.shadowBlur = 0;
          gx.strokeStyle = on ? tm.light : 'rgba(255, 255, 255, 0.12)'; gx.lineWidth = on ? 2.5 : 1.5; gx.stroke();
          gx.clip();
          const sp = gx.createRadialGradient(cardPad + CW / 2, cardPad + 236, 10, cardPad + CW / 2, cardPad + 236, 215);
          sp.addColorStop(0, on ? tm.color + '5a' : 'rgba(255,255,255,0.04)'); sp.addColorStop(1, 'rgba(0,0,0,0)');
          gx.fillStyle = sp; gx.fillRect(cardPad, cardPad, CW, CH);
          gx.fillStyle = on ? tm.color : 'rgba(255,255,255,0.12)'; gx.fillRect(cardPad, cardPad, CW, 6);
          gx.restore();
          this._cardCache.set(cKey, cc);
          cardImg = cc;
        }
      }
      if (cardImg) ctx.drawImage(cardImg, x - cardPad, y0 - cardPad);

      this.font(22, 700, DISPLAY, 1.5); ctx.fillStyle = on ? tm.light : '#98a4be'; ctx.textAlign = 'center';
      ctx.fillText(tm.name.toUpperCase() + ' · P' + (k + 1), x + CW / 2, y0 + 44);

      const w = A['sel_wiz' + k], sc = 1.22;
      if (w?.width) {
        const ww = w.width * sc, wh = w.height * sc, wx = x + CW / 2 - ww / 2, wy = y0 + 88;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.ellipse(x + CW / 2, wy + wh - 6, ww * 0.55, 14, 0, 0, 7); ctx.fill();
        const bob = on ? Math.sin(this.t * 3 + k) * 4 : 0;
        ctx.save();
        if (!on) ctx.globalAlpha = 0.46;
        ctx.drawImage(w, wx, wy + bob, ww, wh);
        ctx.restore();
        const lift = on ? Math.min(1, jt / 0.6) : 0;
        if (lift < 1 && A.sel_cage?.width) {
          ctx.save();
          this.rr(x + 2, y0 + 6, CW - 4, CH - 12, 20);
          ctx.clip();
          const c = A.sel_cage, cw = c.width * 1.22, chh = c.height * 1.22;
          ctx.globalAlpha = 1 - lift; ctx.drawImage(c, x + CW / 2 - cw / 2, wy - 20 - lift * 260, cw, chh); ctx.globalAlpha = 1;
          ctx.restore();
        }
        ctx.imageSmoothingEnabled = true;
      }

      // Live dynamic keycap controls badge or AI Bot pill
      const isBotCard = typeof this.devices[k] === 'string' && this.devices[k].startsWith('bot:');
      const ctl = controlsLabel(k);
      const pillW = CW - 56, pillH = 54, pillX = x + 28, pillY = y0 + 392;
      this.rr(pillX, pillY, pillW, pillH, 12);
      ctx.fillStyle = isBotCard ? 'rgba(14, 32, 42, 0.84)' : (on ? 'rgba(8, 12, 22, 0.72)' : 'rgba(8, 11, 18, 0.62)'); ctx.fill();
      ctx.strokeStyle = isBotCard ? 'rgba(94, 234, 212, 0.55)' : (on ? tm.color + '88' : 'rgba(255, 255, 255, 0.10)'); ctx.lineWidth = 1.3; ctx.stroke();
      if (isBotCard) {
        this.font(13.5, 700, MONO, 0.8); ctx.fillStyle = '#5eead4'; ctx.textAlign = 'center';
        ctx.fillText(`AI WIZARD · ${this.devices[k].slice(4).toUpperCase()}`, x + CW / 2, pillY + 19, pillW - 18);
        this.font(12, 600, SANS); ctx.fillStyle = '#98a4be';
        ctx.fillText('Click card to cycle difficulty or remove', x + CW / 2, pillY + 39, pillW - 18);
      } else if (!on) {
        this.font(12, 700, MONO, 0.4); ctx.fillStyle = '#98a4be'; ctx.textAlign = 'center';
        ctx.fillText(ctl.move.toUpperCase(), x + CW / 2, pillY + 17, pillW - 18);
        this.font(12.5, 700, MONO, 0.4); ctx.fillStyle = '#ffcf86';
        ctx.fillText(`BREW ${ctl.brew.toUpperCase()}  ·  SPELL ${ctl.spell.toUpperCase()}`, x + CW / 2, pillY + 38, pillW - 18);
        // Clean clickable "+ ADD BOT" pill centered cleanly above the controls box (zero overlap with header!)
        const bw2 = 128, bh2 = 28, bx2 = x + (CW - bw2) / 2, by2 = y0 + 354;
        const hotBot = this.hoverBox === 'bot-' + k;
        this.rr(bx2, by2, bw2, bh2, 14);
        ctx.fillStyle = hotBot ? 'rgba(94, 234, 212, 0.28)' : 'rgba(94, 234, 212, 0.12)'; ctx.fill();
        ctx.strokeStyle = hotBot ? '#5eead4' : 'rgba(94, 234, 212, 0.42)'; ctx.lineWidth = 1.2; ctx.stroke();
        this.font(12, 700, MONO, 0.8); ctx.fillStyle = '#5eead4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+ ADD BOT', bx2 + bw2 / 2, by2 + bh2 / 2 + 1);
        this.boxes.push({ id: 'bot-' + k, x: bx2, y: by2, w: bw2, h: bh2, action: () => this.toggleCardBot(k) });
      } else {
        this.font(12, 700, MONO, 0.4); ctx.fillStyle = '#98a4be'; ctx.textAlign = 'center';
        ctx.fillText(ctl.move.toUpperCase(), x + CW / 2, pillY + 17, pillW - 18);
        this.font(13, 700, MONO, 0.4); ctx.fillStyle = tm.light;
        ctx.fillText(`BREW ${ctl.brew.toUpperCase()}  ·  SPELL ${ctl.spell.toUpperCase()}`, x + CW / 2, pillY + 38, pillW - 18);
      }

      ctx.textBaseline = 'middle';
      if (on) {
        this.font(20, 700, DISPLAY, 1.8); ctx.fillStyle = isBotCard ? '#5eead4' : tm.light;
        ctx.fillText('READY · ' + devBadge(this.devices[k]), x + CW / 2, y0 + CH - 34, CW - 36);
      } else {
        this.font(15.5, 700, MONO, 0.5);
        ctx.globalAlpha = 0.68 + Math.sin(this.t * 4) * 0.30; ctx.fillStyle = '#ffd89b';
        ctx.fillText('BREW · ' + keyHint(k).toUpperCase(), x + CW / 2, y0 + CH - 34, CW - 44);
        ctx.globalAlpha = 1;
      }
    }

    // Bottom status & arena minimap dock (cleanly spaced with zero overlap!)
    const by = 738, bh = 228;
    this.glassPanel(x0, by, totalW, bh, 22);
    const T = Math.max(0, this.timer), f = T / 20, cx = x0 + 96, cy = by + bh / 2 - 10;
    ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.beginPath(); ctx.arc(cx, cy, 56, 0, 7); ctx.stroke();
    ctx.strokeStyle = T < 5 ? '#ff5c77' : '#ffcf5a'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, 56, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f); ctx.stroke(); ctx.lineCap = 'butt';
    this.font(42, 700, MONO); ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.fillText(String(Math.ceil(T)), cx, cy + 2);
    this.font(14, 700, SANS, 1.5); ctx.fillStyle = '#98a4be'; ctx.fillText('SECONDS', cx, cy + 82);

    ctx.textAlign = 'left';
    const joined = this.devices.filter(Boolean).length, need = battle ? 2 : 1;
    const textMaxW = joined >= need ? 730 : 980;
    this.font(29, 700, DISPLAY); ctx.fillStyle = '#f8fafc';
    ctx.fillText(joined ? `${joined} wizard${joined > 1 ? 's' : ''} ready` : 'Waiting for players', x0 + 186, by + 74, textMaxW);
    this.font(18, 500, SANS); ctx.fillStyle = (this.selectNoteT > 0 && this.selectNote) ? '#ffcf5a' : '#cbd5e1';
    ctx.fillText(
      (this.selectNoteT > 0 && this.selectNote)
        ? this.selectNote
        : this.holding
          ? 'Launching match…'
          : joined >= need
            ? 'Press Spell key or click Launch Match to start.'
            : battle
              ? `Battle requires at least 2 wizards (${need - joined} more needed).`
              : 'Press your Brew key or click any wizard card to join.',
      x0 + 186, by + 120, textMaxW
    );
    this.font(16, 500, SANS); ctx.fillStyle = '#8b99b5';
    ctx.fillText(
      joined >= need
        ? 'Click a card to edit/leave · Press B or + ADD BOT for AI wizards.'
        : 'Press B or click + ADD BOT to add AI wizards · Esc to go back.',
      x0 + 186, by + 158, textMaxW
    );

    if (joined >= need) {
      this.drawPillBtn(x0 + 950, by + 83, 272, 62, 'LAUNCH MATCH  ›', {
        id: 'sel-launch',
        primary: true,
        hot: this.hoverBox === 'sel-launch',
        action: () => { this.timer = 0; },
      });
    }

    if (this.mini && !this.mini.getContext?.('2d')?.isContextLost?.()) {
      const mw = 248, mh = mw * this.mini.height / this.mini.width;
      const fx = x0 + totalW - mw - 30, fy = by + (bh - (mh + 34)) / 2;
      this.rr(fx - 8, fy, mw + 16, mh + 34, 13);
      ctx.fillStyle = 'rgba(7, 9, 15, 0.88)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'; ctx.lineWidth = 1.5; ctx.stroke();
      this.font(13, 700, MONO, 0.5); ctx.fillStyle = '#ffcf5a'; ctx.textAlign = 'center';
      ctx.fillText((this.level.name || `Arena ${this.level.id}`).toUpperCase(), fx + mw / 2, fy + 16, mw);
      ctx.drawImage(this.mini, fx, fy + 28, mw, mh);
    }
    this.font(16, 500, SANS, 0);
    this.drawFooter([['BREW', 'Join'], ['B', 'Add Bot'], ['SPELL', 'Launch'], ['Esc', 'Back', () => this.back()]]);
  }
}
