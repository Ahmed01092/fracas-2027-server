// Fracas 2027: app shell, menus, game flow and the fixed-step loop.
import { Game, canExchangeLives, exchangeLife, shareLivesWithAll, giveLifeToSlot, takeLifeFromSlot } from './game/sim.js';
import { W, H, TICK, TEAM, PICKUP_INFO, MONSTERS, computeSpikeState } from './game/constants.js';
import { Renderer2D, QUALITY, loadArt } from './render2d/renderer2d.js';
import { Input, evalTouch4Way, evalSwipeStep } from './input.js';
import { Audio } from './audio.js';
import { ClassicMenu, loadClassicArt } from './ui/classic.js';
import { OnlineController, computeAwards } from './net/lobby.js';
import { SNAP_TICKS } from './net/protocol.js';

const $ = (s, el = document) => el.querySelector(s);
const ui = $('#ui');
const PERSONA_NAMES = ['Eldrin the Sage', 'Kael the Arcanist', 'Brann the Warlock', 'Lyra the Sorceress'];
const DEV_LABEL = d => d === 'kb0' ? 'Keyboard (left)' : d === 'kb1' ? 'Keyboard (right)' : d === 'touch' ? 'Touch' : 'Gamepad ' + (+d.slice(3) + 1);
const STATIC_RENDER_STATES = new Set(['pause', 'levelEnd', 'gameOver', 'roundEnd', 'options', 'controls', 'onlinePause', 'onlineServerPause']);

if (typeof addEventListener === 'function') {
  const blockRightClick = e => {
    if (e.type === 'contextmenu' || e.button === 2) {
      e.preventDefault();
      e.stopImmediatePropagation ? e.stopImmediatePropagation() : e.stopPropagation();
    }
  };
  for (const ev of ['contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) {
    addEventListener(ev, blockRightClick, true);
  }
}

// ------------------------------------------------------------------ settings (per viewer, best effort)
const SAVE_KEY = 'fracas2027';
function loadSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; } }
function store(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }

class App {
  constructor(data, art, classicArt) {
    this.data = data; this.art = art; this.classicArt = classicArt;
    const isSmall = matchMedia('(max-width: 960px), (max-height: 540px), (pointer: coarse)').matches;
    this.save = Object.assign({ quality: isSmall ? 'low' : 'high', sfx: 0.8, bright: 1,
                                preset: 'classic', dark: false, blastPreview: false, best: 1, music: 0, touchMode: 'swipe' }, loadSave());
    if (!['dpad', 'swipe'].includes(this.save.touchMode)) this.save.touchMode = 'swipe';
    if ((this.save.v || 0) < 3) { this.save.music = 0; }
    if ((this.save.v || 0) < 2) { this.save.preset = 'classic'; delete this.save.keys; this.save.dark = false; this.save.v = 2; store(this.save); }
    if ((this.save.v || 0) < 4) {
      if (isSmall && this.save.quality === 'medium') this.save.quality = 'low';
      this.save.v = 4;
      store(this.save);
    }
    if ((this.save.v || 0) < 5) {
      this.save.touchMode = 'swipe';
      this.save.v = 5;
      store(this.save);
    }
    this.renderers = {};
    this.setView('classic', true);      // flat 2D view only
    this.renderer.bright = this.save.bright; this.renderer.dark = !!this.save.dark; this.renderer.blastPreview = !!this.save.blastPreview;
    this.input = new Input(); this.input.setPreset(this.save.preset); if (this.save.keys) this.input.keys = this.save.keys;
    this.audio = new Audio(); this.audio.setVolumes(this.save.sfx, this.save.music);
    this.cheats = { rude: false, psycho: false };
    this.devices = [null, null, null, null];
    this.acc = 0; this.last = performance.now(); this.frames = 0; this.fpsT = 0;
    this._needMenuRender = true; this._prevRenderState = null; this._touchActive = null;
    this.touch = { dir: -1, secDir: -1, bomb: false, power: false, held: false, powerHeld: false };
    this.paused = false;
    this.netActive = false; this.netSnapAge = 0;
    this.setupTouch();
    addEventListener('resize', () => { this._needMenuRender = true; });
    addEventListener('pointerdown', e => { if (e.button !== 2) this.unlockAudio(); }, { once: false });
    addEventListener('keydown', e => {
      this.unlockAudio();
      if (e.code === 'NumpadAdd') this.setBright(this.save.bright + 0.1);
      if (e.code === 'NumpadSubtract') this.setBright(this.save.bright - 0.1);
    });
    this.classic = new ClassicMenu(this, classicArt);
    this.online = new OnlineController(this, ui);
    this.titleDemo();
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam) this.online.openMenu({ code: roomParam, autoJoin: true });
    $('#loading').remove();
    requestAnimationFrame(t => this.frame(t));
  }

  setBright(v) { this.save.bright = Math.max(0.5, Math.min(1.6, Math.round(v * 10) / 10)); this.renderer.bright = this.save.bright; this._needMenuRender = true; store(this.save); }

  unlockAudio() {
    this.audio.init();
    if (!this.titleSung && this.classic?.active && this.classic.screen === 'main') {
      this.audio.whenReady('title', () => {
        if (!this.titleSung && this.classic?.active && this.classic.screen === 'main') {
          this.titleSung = true;
          this.audio.play('title');
        }
      });
    }
  }

  syncMusic() {
    if (!this.audio.ctx || this.classic?.active) { this.audio.stopMusic(); return; }
    if (this.save.music > 0 && this.game && !['title', 'gameOver', 'levelEnd', 'roundEnd'].includes(this.state)) {
      const world = this.run?.mode === 'battle' ? 'Battle' : (this.game.level?.world || 'Stone Halls');
      this.audio.music(world);
    } else {
      this.audio.stopMusic();
    }
  }

  // ================================================================== main loop
  frame(now) {
    const safeNow = Number.isFinite(now) ? now : performance.now();
    const dt = Math.min(0.067, Math.max(0, (safeNow - (Number.isFinite(this.last) ? this.last : safeNow)) / 1000 || 0));
    this.last = safeNow;
    try {
      this.input.poll();
      const st = this.state;
      if (this.netActive) this.netSnapAge += dt;
      if (st === 'play') {
        if (this.netActive) this.onlinePlayUpdate(dt);
        else this.playUpdate(dt);
      } else if (this.menuUpdate) {
        this.menuUpdate(dt);            // menus keep the scene alive themselves
      } else if (this.game && !this.paused && !this.netActive) {
        this.simulate(dt, false);
      }
      if (st !== this._prevRenderState) {
        this._prevRenderState = st;
        this._needMenuRender = true;
      }
      const staticMenu = this.paused || STATIC_RENDER_STATES.has(st);
      if (!this.classic?.active) {
        if (!this.game) {
          this.classic?.drawBackdropOnly?.(dt);
        } else {
          this.classic?.show?.(false);
          if (!staticMenu || this._needMenuRender) {
            this._needMenuRender = false;
            const alpha = this.netActive
              ? (this.online?.rb ? this.online.rb.alpha : (this.online?.snapBuf?.length ? 1 : Math.min(1, this.netSnapAge / (SNAP_TICKS * TICK))))
              : Math.min(1, this.acc / TICK);
            this.renderer.render(dt, alpha, { orbit: !!this.orbit });
          }
        }
      }
      document.body?.classList?.toggle('in-game', !!this.game);
      const touchActiveClass = st === 'play' || (!!this.classic?.active && this.classic.screen === 'select' && !this.classic._mobileHtml);
      if (touchActiveClass !== this._touchActive) {
        this._touchActive = touchActiveClass;
        document.body?.classList?.toggle('touch-active', touchActiveClass);
      }
      this.input.endFrame();
      this.frames++; this.fpsT += dt;
      if (this.fpsT > 0.5) { $('#fps').textContent = Math.round(this.frames / this.fpsT) + ' fps · ' + QUALITY[this.save.quality].name; this.frames = 0; this.fpsT = 0; }
    } catch (err) {
      console.error('Frame error:', err);
      this.input?.endFrame?.();
    }
    requestAnimationFrame(t => this.frame(t));
  }

  simulate(dt, withEvents = true) {
    // Snap sub-millisecond display-sync jitter on 60/120 Hz monitors so fixed steps don't alternate 0/2 ticks
    if (Math.abs(dt - TICK) < 0.0018) dt = TICK;
    else if (Math.abs(dt - TICK * 0.5) < 0.0009) dt = TICK * 0.5;
    this.acc = Math.min(this.acc + dt, TICK * 4);
    if (Math.abs(this.acc - TICK) < 0.0012) this.acc = TICK;
    let n = 0;
    while (this.acc >= TICK && n++ < 5) {
      this.game.update(TICK); this.acc -= TICK;
      const ev = this.game.drainEvents();
      this.renderer.handle(ev);
      if (withEvents) this.onEvents(ev);
    }
  }

  onlinePlayUpdate(dt) {
    if (this.online?.rb) {
      this.online.updateRollback(dt);
      this.monsterVoices(dt);
      return;
    }
    this.online.readLocalInput(dt);
    this.online.sampleSnapBuffer(dt);
    const g = this.game;
    if (g && g.freeze <= 0 && g.stasis <= 0 && (g.state === 'play' || g.state === 'clear') && typeof g._spikeTime === 'number') {
      g._spikeTime += dt;
      for (let i = 0; i < W * H; i++) {
        const f = g.feat[i];
        if (f?.k !== 'spike') continue;
        const s = computeSpikeState(g._spikeTime, f.delay);
        f.ph = s.ph;
        f.active = s.active;
      }
    }
    this.monsterVoices(dt);
  }

  playUpdate(dt) {
    const g = this.game;
    const touchRaw = this.readTouch();
    const touchUsedBySlot = g.players.some(p => this.devices[p.slot] === 'touch');
    const touchActive = touchRaw.dir >= 0 || touchRaw.bomb || touchRaw.power || touchRaw.bombHeld || touchRaw.powerHeld;
    for (let pi = 0; pi < g.players.length; pi++) {
      const p = g.players[pi];
      if (p.bot) continue;
      const dev = this.devices[p.slot];
      let r = dev === 'touch' ? touchRaw : this.input.read(dev);
      if (dev !== 'touch' && !touchUsedBySlot && pi === 0 && touchActive) {
        r = {
          dir: touchRaw.dir >= 0 ? touchRaw.dir : r.dir,
          secDir: touchRaw.dir >= 0 ? touchRaw.secDir : r.secDir,
          bomb: !!(r.bomb || touchRaw.bomb),
          power: !!(r.power || touchRaw.power),
          bombHeld: !!(r.bombHeld || touchRaw.bombHeld),
          powerHeld: !!(r.powerHeld || touchRaw.powerHeld),
          start: r.start,
        };
      }
      p.input.dir = r.dir; p.input.secDir = r.secDir ?? -1;
      p.input.bombHeld = !!r.bombHeld; p.input.powerHeld = !!r.powerHeld;
      if (r.bomb) p.input.bomb = true;
      if (r.power) p.input.power = true;
      if (r.start) { this.pause(); return; }
    }
    if (this.input.pressed.has('Escape') || this.input.pressed.has('KeyP')) { this.pause(); return; }
    this.simulate(dt);
    this.monsterVoices(dt);
    if (this.hudT === undefined || (this.hudT += dt) > 0.1) { this.hudT = 0; this.updateHud(); }
    if (g.state === 'won' && g.stateTime > 2.2) this.levelEnd();
    if (g.state === 'lost' && g.stateTime > 2.4) this.gameOver();
    if (g.state === 'roundOver' && g.stateTime > 2.4) this.roundEnd();
  }

  onEvents(events) {
    const a = this.audio, g = this.game;
    const near = (x, y) => g.players.some(p => p.alive && Math.abs(p.x - x) + Math.abs(p.y - y) < 5);
    for (const e of events) {
      switch (e.t) {
        case 'boom': a.play({ fire: 'boom', electric: 'areaElectric', magic: 'areaTeleport' }[e.kind || 'fire'], e.x); break;
        case 'bomb': a.play(e.vent ? 'bombVent' : 'bomb', e.x); break;
        case 'vents': a.play('bombVent', e.x); break;
        case 'ignite': break;
        case 'pickup': { const inf = PICKUP_INFO[e.name]; a.play(inf?.kind === 'power' ? 'power' : 'pickup', e.x);
          break; }
        case 'eat': a.play('pickup', e.x); break;
        case 'reveal': a.play('reveal', e.x); break;
        case 'windZone': a.play('wind', e.x); break;
        case 'stasis': a.play('areaTeleport', e.x); break;
        case 'stasisEnd': a.play('castTeleport', 10.5); break;
        case 'cast': if (e.spell === 'windzone') break;
          if (e.spell === 'speed') { a.play('power', e.x); break; }
          if (e.area && (e.spell === 'electric' || e.spell === 'teleport')) break;          // a special cauldron was dropped; its blast makes the sound
          a.play({ electric: 'electric', teleport: 'castTeleport', fire: 'fire', wind: 'wind' }[e.spell], e.x); break;
        case 'zap': a.play('zap', e.x); break;
        case 'stun': break;
        case 'teleport': if (!e.phase || e.phase === 'hide') a.play('teleport', e.x1 ?? e.x0); break;
        case 'projEnd': if (e.spell === 'fire' && !e.hitActor) a.play('fireHit', e.x); break;
        case 'die': {
          a.play('die', e.x);
          const victim = TEAM[e.p]?.name || `Wizard ${e.p + 1}`;
          if (typeof e.by === 'number' && e.by >= 0 && e.by !== e.p) {
            const killer = TEAM[e.by]?.name || `Wizard ${e.by + 1}`;
            this.renderer?.addFeed?.(`${killer} blasted ${victim}!`, TEAM[e.by]?.light || '#ffcf5a');
          } else if (e.by === e.p) {
            this.renderer?.addFeed?.(`${victim} self-blasted!`, '#ff8aa0');
          } else if (e.cause === 'spike') {
            this.renderer?.addFeed?.(`${victim} hit spikes`, '#ff8aa0');
          } else if (e.cause === 'monster') {
            this.renderer?.addFeed?.(`${victim} fell to a monster`, '#ff8aa0');
          }
          if (g.mode === 'normal' && g.players.length > 1) {
            const fallen = g.players.find(q => q.slot === e.p);
            if (fallen && fallen.lives <= 0 && g.players.some(q => !q.out)) {
              this.toast(`${TEAM[fallen.slot].name} fell out of hearts — clear to share in Life Exchange`, TEAM[fallen.slot].light);
            }
          }
          break;
        }
        case 'respawn': a.play('respawn', e.x); break;
        case 'mdie': if (e.boss) { a.play('bossHit', e.x); this.renderer?.addFeed?.('Guardian defeated!', '#ffcf5a'); } else a.voice(e.type, e.x); break;
        case 'bossHit': a.play('bossHit', e.x); break;
        case 'spike': if (near(e.x, e.y)) a.play('spike', e.x); break;
        case 'powerLow': a.play('powerLow', e.x); break;
        case 'door': a.play('door', e.x); break;
        case 'portal': a.play('portal', e.x); break;
        case 'portalEnter': a.play('win', e.x); break;
        case 'levelWon': a.play('win'); break;
        case 'gameOver': a.play('lose'); break;
        case 'barrier': a.play('barrier', e.x); break;
        case 'barrierTouch': a.play('barrierTouch', e.x); break;
        case 'roundOver': a.play(e.winner >= 0 ? 'win' : 'lose'); break;
      }
    }
  }

  /** monsters call out every few seconds, like the original */
  monsterVoices(dt) {
    const g = this.game; if (!g || g.mode !== 'normal') return;
    this.voiceT = (this.voiceT ?? 2) - dt;
    if (this.voiceT > 0) return;
    const alive = g.monsters.filter(m => m.alive);
    this.voiceT = 2 + Math.random() * 3;
    if (alive.length) { const m = alive[Math.floor(Math.random() * alive.length)]; this.audio.voice(m.type, m.x); }
  }

  // ================================================================== screens & menus
  show(html, state) {
    this.input.capture = null;
    ui.innerHTML = html; this.state = state; this.menuUpdate = null;
  }

  /** generic keyboard/gamepad/mouse menu */
  menu(state, title, items, { sub = '', back, extra = '', logo = false, startSel = 0, wide = false, ultra = false } = {}) {
    this.input.capture = null;
    let sel = items.length ? Math.max(0, Math.min(items.length - 1, startSel)) : -1;
    const ctlHtml = (it, i) => {
      if (!it.value) return '';
      const v = it.value();
      if (it.bar) {
        const pct = Math.max(0, Math.min(100, it.bar() * 100));
        return `<span class="ctl"><span class="step" data-act="left">‹</span><span class="track" data-act="track"><span class="fill" style="width:${pct}%"></span></span><span class="val">${v}</span><span class="step" data-act="right">›</span></span>`;
      }
      if (it.toggle) {
        return `<span class="ctl"><span class="val">${v}</span><span class="toggle ${it.toggle() ? 'on' : ''}"></span></span>`;
      }
      if (it.left || it.right) {
        return `<span class="ctl"><span class="step" data-act="left">‹</span><span class="val">${v}</span><span class="step" data-act="right">›</span></span>`;
      }
      return `<span class="ctl"><span class="val">${v}</span></span>`;
    };
    const vals = items.some(it => it.value && (it.left || it.right || it.bar || it.toggle));
    const cls = `screen${ultra ? ' ultra' : wide ? ' wide' : ''}`;
    ui.innerHTML = `<div class="${cls}"><div class="card">${logo ? `<div style="text-align:center"><h1 class="logo">FRACAS</h1><div class="logo-sub">2027</div></div>` : `<div class="brand-pill"><span class="dot"></span>FRACAS 2027</div><div class="heading"><h2>${title}</h2></div>`}
      ${sub ? `<div class="hint">${sub}</div>` : ''}
      ${extra}
      <div class="menu">${items.map((it, i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}">${it.sub ? `<span class="lbl-wrap"><span class="lbl lbl-action">${it.label}</span><span class="lbl-sub">${it.sub}</span></span>` : `<span class="lbl${it.value ? '' : ' lbl-action'}">${it.label}</span>`}${ctlHtml(it, i)}</div>`).join('')}</div></div>
      <div class="footer"><span><kbd>↑↓</kbd>Choose</span>${vals ? '<span><kbd>←→</kbd>Adjust</span>' : ''}<span><kbd>Enter</kbd>Select</span>${back ? '<span><kbd>Esc</kbd>Back</span>' : ''}</div></div>`;

    const els = [...ui.querySelectorAll('.item')];
    const setSel = (next, scroll = false) => {
      if (!els.length || next < 0 || next >= els.length) return;
      if (next === sel && !scroll) return;
      els[sel]?.classList.remove('sel');
      sel = next;
      const el = els[sel];
      if (el) {
        el.classList.add('sel');
        if (scroll) el.scrollIntoView({ block: 'nearest' });
      }
    };
    const syncValues = () => {
      els.forEach((el, i) => {
        const it = items[i]; if (!it?.value) return;
        const valEl = el.querySelector('.val'); if (valEl) valEl.textContent = it.value();
        const fillEl = el.querySelector('.fill'); if (fillEl && it.bar) fillEl.style.width = `${Math.max(0, Math.min(100, it.bar() * 100))}%`;
        const togEl = el.querySelector('.toggle'); if (togEl && it.toggle) togEl.classList.toggle('on', !!it.toggle());
      });
    };
    const act = k => {
      const it = items[sel]; if (!it) return;
      if (k === 'ok' && it.ok) { this.audio.play('select'); it.ok(sel); if (it.value) syncValues(); }
      else if (k === 'left' && it.left) { this.audio.play('ui'); it.left(); syncValues(); }
      else if (k === 'right' && it.right) { this.audio.play('ui'); it.right(); syncValues(); }
      else if (k === 'ok' && it.right) { this.audio.play('ui'); it.right(); syncValues(); }
    };

    els.forEach(el => {
      const i = +el.dataset.i;
      el.onmouseenter = () => setSel(i, false);
      el.onclick = e => {
        this.audio.init();
        setSel(i, false);
        const target = e.target.closest('[data-act]');
        const it = items[i];
        if (target?.dataset.act === 'left' && it.left) { act('left'); return; }
        if (target?.dataset.act === 'right' && it.right) { act('right'); return; }
        if (target?.dataset.act === 'track' && it.set) {
          const r = target.getBoundingClientRect();
          const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
          this.audio.play('ui'); it.set(frac); syncValues(); return;
        }
        act('ok');
      };
    });
    if (startSel > 0) els[sel]?.scrollIntoView({ block: 'nearest' });

    this.state = state;
    this.menuUpdate = dt => {
      if (this.input.capture) return;
      const m = this.input.menu();
      if (m.dy && items.length) { this.audio.play('ui'); setSel((sel + m.dy + items.length) % items.length, true); }
      if (m.dx < 0) act('left');
      else if (m.dx > 0) act('right');
      else if (m.ok) act('ok');
      if (m.back && back) { this.audio.play('ui'); back(); }
      if (this.game && !this.paused) this.simulate(dt, false);
    };
  }

  openOnlineMenu() { this.online?.openMenu(); }

  titleDemo() { this.title(); }

  title() {                              // the original main menu (stone logo over red fire)
    this._clearLifeEx?.();
    this.input.capture = null;
    this.game = null;
    this.run = null;
    this.netActive = false;
    this.paused = false;
    this.orbit = true; this.audio.stopMusic(); ui.innerHTML = '';
    this.classic.open('main');
    if (!this.titleSung && this.audio.ctx) {
      this.audio.whenReady('title', () => {
        if (!this.titleSung && this.classic?.active && this.classic.screen === 'main') {
          this.titleSung = true; this.audio.play('title');
        }
      });
    }
  }

  persist() { store(this.save); }

  setView(v, init) {
    this.renderers.classic ||= new Renderer2D($('#game'), this.save.quality, this.art);
    this.save.view = v; if (!init) store(this.save);
    this.renderer = this.renderers[v];
    this.renderer.classicArt = this.classicArt;
    this.renderer.bright = this.save.bright; this.renderer.dark = !!this.save.dark; this.renderer.blastPreview = !!this.save.blastPreview; this.renderer.psycho = this.cheats?.psycho;
    $('#game').style.display = 'block';
    if (this.game && !init) { this.renderer.setGame(this.game); this.renderer.hudLevel = this.run?.mode === 'battle' ? this.run.round : this.game.level.id; }
  }
  togglePreset() { const s = this.save; s.preset = s.preset === 'modern' ? 'classic' : 'modern'; this.input.setPreset(s.preset); delete s.keys; store(s); }

  checkpoint(n) { return Math.floor((n - 1) / 5) * 5 + 1; }

  password() { this.classic.open('password'); }

  options(back) {
    const qs = Object.keys(QUALITY);
    const s = this.save;
    const pct = v => Math.round(v * 100) + '%';
    const vol = (k, d) => () => { s[k] = Math.max(0, Math.min(1, Math.round((s[k] + d) * 10) / 10)); this.audio.setVolumes(s.sfx, s.music); store(s); if (k === 'music') this.syncMusic(); };
    const setVol = k => frac => { s[k] = Math.max(0, Math.min(1, Math.round(frac * 10) / 10)); this.audio.setVolumes(s.sfx, s.music); store(s); if (k === 'music') this.syncMusic(); };
    const q = d => () => { s.quality = qs[(qs.indexOf(s.quality) + d + qs.length) % qs.length]; this.renderer.setQuality(s.quality); this._needMenuRender = true; store(s); };
    const layout = () => { s.preset = s.preset === 'modern' ? 'classic' : 'modern'; this.input.setPreset(s.preset); delete s.keys; store(s); };
    const dark = () => { s.dark = !s.dark; this.renderer.dark = s.dark; this._needMenuRender = true; store(s); };
    const blastPrev = () => { s.blastPreview = !s.blastPreview; this.renderer.blastPreview = s.blastPreview; this._needMenuRender = true; store(s); };
    const touchToggle = () => { s.touchMode = s.touchMode === 'swipe' ? 'dpad' : 'swipe'; store(s); this.syncTouchMode?.(); };
    const opts = [
      { label: 'Graphics', value: () => QUALITY[s.quality].name, left: q(-1), right: q(1) },
      { label: 'Sound', value: () => pct(s.sfx), bar: () => s.sfx, set: setVol('sfx'), left: vol('sfx', -0.1), right: vol('sfx', 0.1) },
      { label: 'Music', value: () => s.music ? pct(s.music) : 'Off', bar: () => s.music, set: setVol('music'), left: vol('music', -0.1), right: vol('music', 0.1) },
      { label: 'Brightness', value: () => pct(s.bright), bar: () => (s.bright - 0.5) / 1.1, set: f => this.setBright(Math.round((0.5 + f * 1.1) * 10) / 10), left: () => this.setBright(s.bright - 0.1), right: () => this.setBright(s.bright + 0.1) },
      { label: 'Key Layout', value: () => s.preset === 'modern' ? 'WASD' : 'Original', right: layout, left: layout },
      { label: 'Dungeon Darkness', value: () => s.dark ? 'On' : 'Off', toggle: () => s.dark, right: dark, left: dark },
      { label: 'Blast Preview', value: () => s.blastPreview ? 'On' : 'Off', toggle: () => s.blastPreview, right: blastPrev, left: blastPrev },
    ];
    if (typeof document !== 'undefined' && document.body?.classList?.contains('touch')) {
      opts.push({ label: 'Touch Controls', value: () => s.touchMode === 'dpad' ? '4-Way D-Pad' : 'Swipe Screen', right: touchToggle, left: touchToggle });
    }
    if (typeof window !== 'undefined' && window.fracasDesktop?.isDesktop) {
      const togFs = () => {
        window.fracasDesktop.toggleFullscreen().then(v => { this._isFs = !!v; }).catch(() => {});
        this._isFs = !this._isFs;
      };
      opts.push({ label: 'Fullscreen (F11)', value: () => this._isFs ? 'On' : 'Off', toggle: () => !!this._isFs, right: togFs, left: togFs });
    }
    opts.push({ label: 'Rebind Keys', ok: () => this.rebind(back, () => this.options(back)) });
    opts.push({ label: 'Back', ok: back });
    this.menu('options', 'Options', opts, { back, sub: 'Use ← → or click controls to adjust settings', wide: true });
  }

  rebind(back, returnTo = back, startSel = 0) {
    this.input.capture = null;
    const acts = ['up', 'down', 'left', 'right', 'bomb', 'power'];
    const actLabels = { up: 'Move Up', down: 'Move Down', left: 'Move Left', right: 'Move Right', bomb: 'Brew Cauldron', power: 'Cast Spell' };
    const counts = new Map();
    for (const k of [0, 1]) for (const a of acts) {
      const code = this.input.keys[k][a];
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    const hasDup = [...counts.values()].some(c => c > 1);

    const makeCol = k => {
      const tm = TEAM[k];
      const rows = acts.map((a, ai) => {
        const idx = k * acts.length + ai;
        const code = this.input.keys[k][a];
        const dup = (counts.get(code) || 0) > 1;
        return `<button class="rebind-row" type="button" data-idx="${idx}" data-k="${k}" data-a="${a}">
          <span>${actLabels[a]}</span>
          <span class="keycap${dup ? ' dup' : ''}">${this.input.keyName(code)}</span>
        </button>`;
      }).join('');
      return `<div class="rebind-col" style="--c:${tm.color}">
        <div class="rebind-hdr"><span>Player ${k + 1} · ${tm.name}</span><span class="tag">${k === 0 ? 'Left' : 'Right'}</span></div>
        ${rows}
      </div>`;
    };

    const presetName = this.save.preset === 'modern' ? 'WASD' : 'Original';
    this.show(`<div class="screen ultra"><div class="card">
      <div class="brand-pill"><span class="dot"></span>FRACAS 2027</div>
      <div class="heading"><h2>Rebind Keys</h2></div>
      <p class="hint">Click or select any action and press a new key.${hasDup ? ' <span style="color:#ff8aa0">Warning: duplicate key bindings highlighted in red.</span>' : ''}</p>
      <div class="rebind-grid">${makeCol(0)}${makeCol(1)}</div>
      <div class="rebind-actions">
        <div class="item" data-idx="12"><span class="lbl lbl-action">Reset to ${presetName} defaults</span></div>
        <div class="item" data-idx="13"><span class="lbl lbl-action">Back</span></div>
      </div>
    </div>
    <div class="footer"><span><kbd>↑↓←→</kbd>Navigate</span><span><kbd>Enter</kbd>Rebind</span><span><kbd>Esc</kbd>Back</span></div></div>`, 'options');

    const total = 14;
    let sel = Math.max(0, Math.min(total - 1, startSel));
    const els = [...ui.querySelectorAll('[data-idx]')].sort((a, b) => +a.dataset.idx - +b.dataset.idx);
    const setSel = next => {
      els[sel]?.classList.remove('sel');
      sel = Math.max(0, Math.min(total - 1, next));
      els[sel]?.classList.add('sel');
    };
    setSel(sel);

    const startCapture = idx => {
      const el = els[idx];
      if (!el || el.dataset.k == null) return;
      const k = +el.dataset.k, a = el.dataset.a;
      el.classList.add('capturing');
      const cap = el.querySelector('.keycap');
      if (cap) cap.textContent = 'PRESS KEY…';
      this.audio.play('select');
      this.input.rebind(k, a, code => {
        if (code) {
          this.save.keys = this.input.keys; store(this.save); this.audio.play('select');
          this.rebind(back, returnTo, idx);
        } else {
          this.rebind(back, returnTo, idx);
          this.toast('Rebind cancelled', '#98a4be');
        }
      });
    };

    const activate = idx => {
      if (idx < 12) startCapture(idx);
      else if (idx === 12) {
        this.input.setPreset(this.save.preset); delete this.save.keys; store(this.save);
        this.audio.play('select');
        this.rebind(back, returnTo, 12);
        this.toast(`Keys reset to ${presetName} defaults`, '#5eead4');
      } else {
        this.audio.play('ui');
        this.input.capture = null;
        returnTo();
      }
    };

    els.forEach(el => {
      const idx = +el.dataset.idx;
      el.onmouseenter = () => { if (!this.input.capture) setSel(idx); };
      el.onclick = () => {
        this.audio.init();
        if (this.input.capture) return;
        setSel(idx);
        activate(idx);
      };
    });

    this.menuUpdate = dt => {
      if (this.input.capture) return;
      const m = this.input.menu();
      if (m.dy) {
        this.audio.play('ui');
        if (sel < 12) {
          const col = sel < 6 ? 0 : 1, row = sel % 6 + m.dy;
          if (row >= 6) setSel(12 + col);
          else if (row < 0) setSel(12 + col);
          else setSel(col * 6 + row);
        } else {
          setSel(m.dy < 0 ? (sel === 12 ? 5 : 11) : (sel === 12 ? 0 : 6));
        }
      }
      if (m.dx) {
        this.audio.play('ui');
        if (sel < 12) setSel(sel < 6 ? sel + 6 : sel - 6);
        else setSel(sel === 12 ? 13 : 12);
      }
      if (m.ok) activate(sel);
      if (m.back) { this.audio.play('ui'); this.input.capture = null; returnTo(); }
      if (this.game && !this.paused) this.simulate(dt, false);
    };
  }

  controls(back = () => this.title()) {
    const k = this.input.keys, n = c => `<kbd>${this.input.keyName(c)}</kbd>`;
    const row = (lbl, a, b) => `<div>${lbl}</div><div>${a}</div><div>${b}</div>`;
    this.menu('controls', 'Controls', [{ label: 'Back', ok: back }], { back, wide: true, extra: `<div class="panel"><div class="keys">
      <div class="h">Action</div><div class="h" style="color:${TEAM[0].light}">Player 1 · ${TEAM[0].name}</div><div class="h" style="color:${TEAM[1].light}">Player 2 · ${TEAM[1].name}</div>
      ${row('Move', n(k[0].up) + n(k[0].left) + n(k[0].down) + n(k[0].right), n(k[1].up) + n(k[1].left) + n(k[1].down) + n(k[1].right))}
      ${row('Brew cauldron', n(k[0].bomb), n(k[1].bomb))}
      ${row('Cast spell / jar', n(k[0].power), n(k[1].power))}
      ${row('Pause', '<kbd>Esc</kbd> <kbd>P</kbd>', '<span>Start button</span>')}
      ${row('Brightness', '<kbd>Num +</kbd> <kbd>Num −</kbd>', '<span>Adjust anytime</span>')}
      </div><div class="tip-pill"><b>Gamepads:</b> Stick / D-Pad to move · <b>A</b> brew · <b>B / X</b> cast · <b>Start</b> pause.<br>
      <b>Pro Tip:</b> Hold Brew while casting a glass jar to throw backwards!</div></div>` });
  }

  battleSetup() { this.classic.open('battle'); }

  previewArena() {
    this.game = new Game(this.data.battle[this.battleCfg.arena], { players: [] }); this.game.demo = true;
    this.renderer.setGame(this.game); this.orbit = true;
  }

  /** players press their brew button to join a colour slot */
  join(mode, startLevel) { this.classic.open('select', { mode, level: startLevel || 1 }); }   // the original player-select screen

  // ================================================================== story
  _extractBots(slots) {
    const bots = {};
    for (const s of slots) {
      const dev = this.devices[s];
      if (typeof dev === 'string' && dev.startsWith('bot:')) bots[s] = dev.slice(4) || 'normal';
    }
    return bots;
  }

  startStory(levelId, slots) {
    this.run = { mode: 'normal', level: levelId, slots, bots: this._extractBots(slots), carry: {} };
    this.loadLevel();
  }

  loadLevel() {
    if (this.classic?.active) this.classic.close();
    const r = this.run, lv = this.data.normal[r.level - 1];
    if (!lv) { this.title(); return; }
    this._clearLifeEx?.();
    this.paused = false;
    r._exchangedDone = false;
    this.game = new Game(lv, { players: r.slots, bots: r.bots || {}, carry: r.carry, cheats: this.cheats, seed: Math.floor(Math.random() * 0x100000000) });
    this.renderer.setGame(this.game); this.orbit = false; this.acc = 0;
    this.state = 'play'; this.menuUpdate = null;
    this.syncMusic();
    this.audio.play('getReady');
    this.buildHud();
    const pw = Object.entries(this.data.passwords).find(([, v]) => v === lv.id)?.[0];
    const worldNo = { 'Stone Halls': 1, 'Conveyor Works': 2, 'Spike Crypt': 3, 'Dark Citadel': 4 }[lv.world];
    if (lv.id > this.save.best) { this.save.best = lv.id; store(this.save); }
  }

  /** FRACAS.EXE 0x00643 -> 0x08386 (LIFE EXCHANGE): authentic steel-blue LIVEX popup over the frozen level */
  lifeExchange() {
    const g = this.game;
    if (!canExchangeLives(g)) { this.levelEnd(); return; }
    this._clearLifeEx?.();
    const sorted = [...g.players].sort((a, b) => b.lives - a.lives);
    const fallen = g.players.find(p => p.lives <= 0) || g.players[1];
    const leftSlot = g.players.length === 2 ? g.players[0].slot : sorted[0].slot;
    const rightSlot = g.players.length === 2 ? g.players[1].slot : (fallen.slot !== leftSlot ? fallen.slot : g.players.find(p => p.slot !== leftSlot).slot);

    let trSeq = 0;
    const lx = { leftSlot, rightSlot, hover: null, flashL: 0, flashR: 0, transfers: [] };
    const pushTransfer = (from, to) => {
      lx.transfers.push({ from, to, seq: ++trSeq });
      if (lx.transfers.length > 16) lx.transfers.shift();
    };
    const leftP = () => g.players.find(p => p.slot === lx.leftSlot);
    const rightP = () => g.players.find(p => p.slot === lx.rightSlot);

    const cycleSlot = (side, delta) => {
      if (g.players.length <= 2) return;
      const slots = g.players.map(p => p.slot);
      const other = side === 'leftSlot' ? lx.rightSlot : lx.leftSlot;
      const curIdx = slots.indexOf(lx[side]);
      for (let step = 1; step < slots.length; step++) {
        const cand = slots[(curIdx + step * delta + slots.length) % slots.length];
        if (cand !== other) { lx[side] = cand; return; }
      }
    };
    const pickTab = slot => {
      const p = g.players.find(q => q.slot === slot);
      if (!p) return;
      if (p.lives > 1 && slot !== lx.rightSlot) lx.leftSlot = slot;
      else if (slot !== lx.leftSlot) lx.rightSlot = slot;
    };

    const moveLeft = () => {
      const d = rightP(), r = leftP();
      if (exchangeLife(d, r)) { this.audio.play('pickup'); lx.flashL = 0.16; pushTransfer(d.slot, r.slot); }
    };
    const moveRight = () => {
      const d = leftP(), r = rightP();
      if (exchangeLife(d, r)) { this.audio.play('pickup'); lx.flashR = 0.16; pushTransfer(d.slot, r.slot); }
    };
    const giveTo = targetSlot => {
      const tr = giveLifeToSlot(g, lx, targetSlot);
      if (!tr) return;
      this.audio.play('pickup'); lx.flashR = 0.16; pushTransfer(tr.from, tr.to);
    };
    const takeFrom = donorSlot => {
      const tr = takeLifeFromSlot(g, lx, donorSlot);
      if (!tr) return;
      this.audio.play('pickup'); lx.flashL = 0.16; pushTransfer(tr.from, tr.to);
    };
    const shareAll = () => {
      const list = shareLivesWithAll(g);
      if (!list.length) return;
      this.audio.play('pickup'); lx.flashR = 0.16;
      for (const tr of list) pushTransfer(tr.from, tr.to);
    };

    const canvas = this.renderer.canvas;
    const onMove = e => {
      const h = this.renderer.lifeExchangeHit(e.clientX, e.clientY);
      lx.hover = h ? (h.slot !== undefined ? `${h.kind}:${h.slot}` : h.kind) : null;
      canvas.style.cursor = h ? 'pointer' : 'default';
    };
    const finish = () => {
      this._clearLifeEx?.();
      for (const p of g.players) p.out = p.lives <= 0;
      this.audio.play('select');
      this.menuUpdate = null;
      this.levelEnd();
    };
    const onDown = e => {
      if (e.button && e.button !== 0) return;
      this.audio.init();
      const h = this.renderer.lifeExchangeHit(e.clientX, e.clientY);
      if (!h) return;
      if (h.kind === 'leftArrow') moveLeft();
      else if (h.kind === 'rightArrow') moveRight();
      else if (h.kind === 'giveTo') giveTo(h.slot);
      else if (h.kind === 'takeFrom') takeFrom(h.slot);
      else if (h.kind === 'shareAll') shareAll();
      else if (h.kind === 'leftWiz') { this.audio.play('ui'); cycleSlot('leftSlot', 1); }
      else if (h.kind === 'rightWiz') { this.audio.play('ui'); cycleSlot('rightSlot', 1); }
      else if (h.kind === 'tab') { this.audio.play('ui'); pickTab(h.slot); }
      else if (h.kind === 'confirm') finish();
    };

    this._clearLifeEx = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.style.cursor = 'default';
      if (this.renderer) this.renderer.lifeEx = null;
      this._clearLifeEx = null;
    };

    ui.innerHTML = '';
    this.renderer.lifeEx = lx;
    this.state = 'lifeExchange';
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);

    // Seed initial directional state so held walking keys on portal entry don't fire before release
    const prevDirs = new Map(g.players.map(p => [p.slot, (this.devices[p.slot] === 'touch' ? this.touch.dir : this.input.read(this.devices[p.slot]).dir)]));
    let waitT = 0.42;
    let prevShareKey = false;
    this.menuUpdate = dt => {
      lx.flashL = Math.max(0, lx.flashL - dt);
      lx.flashR = Math.max(0, lx.flashR - dt);
      if (this.input.capture) return;
      waitT = Math.max(0, waitT - dt);
      const m = this.input.menu();
      let confirm = m.ok || this.input.pressed.has('Space');
      let dx = m.dx;
      for (const p of g.players) {
        const dev = this.devices[p.slot];
        if (!dev || dev === 'touch') continue;
        const r = this.input.read(dev);
        const pd = prevDirs.get(p.slot) ?? -1;
        prevDirs.set(p.slot, r.dir);
        if (r.dir !== pd) {
          if (r.dir === 2) dx = -1;
          else if (r.dir === 0) dx = 1;
        }
        if (r.bomb || r.power || r.start) confirm = true;
      }
      const rDown = this.input.pressed.has('KeyR');
      const triggerShare = rDown && !prevShareKey && g.players.length > 2;
      prevShareKey = rDown;
      if (waitT > 0) return;
      if (triggerShare) shareAll();
      else if (dx < 0) moveLeft();
      else if (dx > 0) moveRight();
      else if (m.dy < 0 && g.players.length > 2) { this.audio.play('ui'); cycleSlot('leftSlot', 1); }
      else if (m.dy > 0 && g.players.length > 2) { this.audio.play('ui'); cycleSlot('rightSlot', 1); }
      else if (confirm) finish();
    };
  }

  levelEnd() {
    const g = this.game, r = this.run;
    if (!r._exchangedDone && canExchangeLives(g)) {
      r._exchangedDone = true;
      this.lifeExchange();
      return;
    }
    const awards = computeAwards(g.players, false);
    const rows = g.players.map(p => {
      const botTag = p.bot ? ` <span class="award-tag" style="--ac:#98a4be">BOT</span>` : '';
      const aw = awards.get(p.slot);
      const awTag = aw ? ` <span class="award-tag" style="--ac:${aw.color}">${aw.label}</span>` : '';
      return `<div class="t-name" style="color:${TEAM[p.slot].light}"><span class="t-dot" style="--c:${TEAM[p.slot].color}"></span>${TEAM[p.slot].name}${botTag}${awTag}</div><div class="t-score">${p.score.toLocaleString()}</div><div class="t-kills">${p.kills} kills</div><div class="t-lives">${p.lives > 0 ? '♥'.repeat(p.lives) : '<span style="color:var(--muted);font-size:12px;letter-spacing:.12em">OUT</span>'}</div>`;
    }).join('');
    for (const p of g.players) r.carry[p.slot] = p.carry();
    const next = r.level + 1;
    if (next > 100) { this.victory(); return; }
    const pw = Object.entries(this.data.passwords).find(([, v]) => v === next)?.[0];
    this.menu('levelEnd', `Level ${r.level} cleared!`, [
      { label: `Continue to level ${next}`, ok: () => { r.level = next; this.loadLevel(); } },
      { label: 'Quit to title', ok: () => this.title() },
    ], { wide: true, extra: `<div class="panel"><div class="table"><div class="h">Wizard</div><div class="h">Score</div><div class="h">Kills</div><div class="h">Lives</div>${rows}</div>
      ${pw ? `<div class="pwbox"><span>Password for Level ${next}</span><b>${pw}</b></div>` : ''}</div>` });
  }

  gameOver() {
    const r = this.run, cp = this.checkpoint(r.level);
    this.audio.stopMusic();
    this.menu('gameOver', 'All wizards have fallen', [
      { label: `Try again from level ${cp}`, ok: () => { r.level = cp; r.carry = {}; this.loadLevel(); } },
      { label: 'Quit to title', ok: () => this.title() },
    ], { sub: `You reached level ${r.level}. Final score ${this.game.players.reduce((a, p) => a + p.score, 0).toLocaleString()}.` });
  }

  victory() {
    this.audio.play('win');
    const g = this.game;
    this.menu('levelEnd', 'Fracas Omega is defeated!', [{ label: 'Back to title', ok: () => this.title() }],
      { sub: `All 100 levels cleared. Total score ${g.players.reduce((a, p) => a + p.score, 0).toLocaleString()}. You are the master of the four worlds.` });
  }

  // ================================================================== battle
  startBattle(slots) {
    const b = this.battleCfg || (this.battleCfg = { arena: 0, wins: 3, random: false });
    const mutators = {
      fuseScale: b.fuseScale || 1,
      startMax: !!b.startMax,
      suddenDeath: b.suddenDeath === 'fast' ? 'fast' : 'normal',
    };
    this.run = { mode: 'battle', slots, bots: this._extractBots(slots), mutators, carry: {}, round: 0 };
    this.nextRound();
  }
  nextRound() {
    if (this.classic?.active) this.classic.close();
    const r = this.run, b = this.battleCfg;
    r.round++;
    const arena = b.random ? Math.floor(Math.random() * this.data.battle.length) : b.arena;
    const lv = this.data.battle[arena];
    this.paused = false;
    this.game = new Game(lv, { mode: 'battle', players: r.slots, bots: r.bots || {}, mutators: r.mutators, carry: r.carry, cheats: this.cheats, seed: Math.floor(Math.random() * 0x100000000) });
    this.renderer.setGame(this.game); this.orbit = false; this.acc = 0;
    this.state = 'play'; this.menuUpdate = null;
    this.syncMusic();
    this.audio.play('getReady');
    this.buildHud();
  }
  roundEnd() {
    const g = this.game, r = this.run, b = this.battleCfg;
    for (const p of g.players) r.carry[p.slot] = { wins: p.wins };
    const champ = g.players.find(p => p.wins >= b.wins);
    const w = g.players.find(p => p.alive);
    const awards = computeAwards(g.players, true);
    const rows = g.players.map(p => {
      const botTag = p.bot ? ` <span class="award-tag" style="--ac:#98a4be">BOT</span>` : '';
      const aw = awards.get(p.slot);
      const awTag = aw ? ` <span class="award-tag" style="--ac:${aw.color}">${aw.label}</span>` : '';
      return `<div class="t-name" style="color:${TEAM[p.slot].light}"><span class="t-dot" style="--c:${TEAM[p.slot].color}"></span>${TEAM[p.slot].name}${botTag}${awTag}</div><div class="t-score">${'★'.repeat(p.wins)}${'☆'.repeat(Math.max(0, b.wins - p.wins))}</div><div class="t-kills">${p.kills} kills</div><div></div>`;
    }).join('');
    const extra = `<div class="panel"><div class="table"><div class="h">Wizard</div><div class="h">Wins</div><div class="h">Kills</div><div></div>${rows}</div></div>`;
    if (champ) this.menu('roundEnd', `${TEAM[champ.slot].name} wins the match!`, [
      { label: 'Rematch', ok: () => this.startBattle(r.slots) }, { label: 'Battle setup', ok: () => this.battleSetup() }, { label: 'Quit to title', ok: () => this.title() }], { extra, wide: true });
    else this.menu('roundEnd', w ? `${TEAM[w.slot].name} takes round ${r.round}` : `Round ${r.round}: nobody survived`, [
      { label: 'Next round', ok: () => this.nextRound() }, { label: 'Quit to title', ok: () => this.title() }], { extra, wide: true });
  }

  // ================================================================== pause
  pause() {
    this.audio.play('pause');
    this.paused = true;
    const resume = () => { this.paused = false; ui.innerHTML = ''; this.buildHud(); this.state = 'play'; this.menuUpdate = null; };
    this.menu('pause', 'Paused', [
      { label: 'Resume', ok: resume },
      { label: this.run.mode === 'battle' ? 'Restart round' : 'Restart level', ok: () => { this.paused = false; this.run.mode === 'battle' ? (this.run.round--, this.nextRound()) : this.loadLevel(); } },
      { label: 'Options', ok: () => this.options(() => this.pause()) },
      { label: 'Controls', ok: () => this.controls(() => this.pause()) },
      { label: 'Quit to title', ok: () => { this.paused = false; this.title(); } },
    ], { back: resume });
    const mu = this.menuUpdate;
    this.menuUpdate = dt => {
      if (this.input.pressed.has('KeyP') || this.input.pads.some((_, i) => this.input.padButton(i, 9, true))) { this.audio.play('ui'); resume(); return; }
      mu(dt);
    };
  }

  // ================================================================== HUD
  buildHud() {                          // the original dashboard is drawn on the game canvas (renderer.drawHud)
    ui.innerHTML = '';
    this.renderer.hudLevel = this.run?.mode === 'battle' ? this.run.round : this.game?.level.id;
  }
  updateHud() {}

  banner(big, small, tag = '', foot = '') {
    const b = document.createElement('div'); b.className = 'banner';
    b.innerHTML = `${tag ? `<div class="boss">${tag}</div>` : ''}<div class="big">${big}</div><div class="small">${small}</div>${foot ? `<div class="hint" style="margin-top:8px">${foot}</div>` : ''}`;
    ui.appendChild(b); setTimeout(() => b.remove(), 2900);
  }
  toast(text, color = '#fff') {
    const t = document.createElement('div'); t.className = 'toast'; t.style.borderColor = color; t.style.color = color; t.textContent = text;
    ui.querySelectorAll('.toast').forEach(o => o.remove());
    ui.appendChild(t); setTimeout(() => t.remove(), 2300);
  }

  // ================================================================== touch controls (phones / tablets)
  setupTouch() {
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0) && !matchMedia?.('(pointer: coarse)').matches) return;
    const primaryTouch = (matchMedia?.('(pointer: coarse)').matches && !matchMedia?.('(pointer: fine)').matches) ||
      matchMedia?.('(max-width: 760px), (max-height: 500px)').matches;
    if (primaryTouch) document.body.classList.add('touch');
    else addEventListener('touchstart', () => document.body.classList.add('touch'), { passive: true, once: true });
    const zone = $('#touch .pad-zone');
    const pad = $('#touch .pad');
    const knob = $('#touch .pad .knob');
    const arrows = [...document.querySelectorAll('#touch .pad .arr')];
    const actZone = $('#touch .act-zone');
    const b1 = $('#touch .b1');
    const b2 = $('#touch .b2');
    const mpause = $('#touch .mpause');

    let padId = null, padAx = 0, padAy = 0, padBaseX = 0, padBaseY = 0;
    const dpadDead = 9, swipeStartDead = 9, swipeTurnDist = 13;
    let swipePts = [];
    const actTouches = new Map();
    let zoneRect = null, padHalf = 56, actGeom = null;
    let lastShownDir = -2, lastKnobDir = -2, lastPadTx = null;

    const getMode = () => (this.save.touchMode === 'dpad' ? 'dpad' : 'swipe');
    const applyModeAttrs = () => {
      const m = getMode();
      if (zone) zone.dataset.mode = m;
      if (pad) {
        pad.dataset.mode = m;
        pad.style.transform = '';
      }
      lastPadTx = '';
    };
    this.syncTouchMode = () => {
      applyModeAttrs();
      resetTouch();
    };
    applyModeAttrs();

    const showDir = (dir, knobX = 0, knobY = 0, padShiftX = 0, padShiftY = 0) => {
      this.touch.dir = dir;
      this.touch.secDir = -1;
      if (dir !== lastShownDir) {
        lastShownDir = dir;
        for (const el of arrows) el.classList.toggle('on', +el.dataset.d === dir);
      }
      if (pad) {
        const pTx = (padShiftX || padShiftY) ? `translate3d(${padShiftX}px, ${padShiftY}px, 0)` : '';
        if (pTx !== lastPadTx) {
          lastPadTx = pTx;
          pad.style.transform = pTx;
        }
      }
      if (knob && getMode() === 'swipe' && dir !== lastKnobDir) {
        lastKnobDir = dir;
        knob.style.transform = `translate3d(${knobX}px, ${knobY}px, 0)`;
      }
    };

    const DIRS_XY = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const updateDpad = (clientX, clientY) => {
      const dx = clientX - padBaseX, dy = clientY - padBaseY;
      const dir = evalTouch4Way(dx, dy, this.touch.dir, dpadDead);
      showDir(dir, 0, 0, 0, 0);
    };

    const updateSwipe = (clientX, clientY) => {
      const res = evalSwipeStep(swipePts, clientX, clientY, this.touch.dir, swipeStartDead, swipeTurnDist);
      const dir = res.dir;
      if (res.reset) {
        swipePts = [{ x: clientX, y: clientY }];
        padAx = clientX;
        padAy = clientY;
      } else {
        const last = swipePts[swipePts.length - 1];
        if (!last || Math.hypot(clientX - last.x, clientY - last.y) >= 2) {
          swipePts.push({ x: clientX, y: clientY });
          while (swipePts.length > 2 && Math.hypot(clientX - swipePts[1].x, clientY - swipePts[1].y) > 36) {
            swipePts.shift();
          }
          if (swipePts.length > 24) swipePts.shift();
        }
        const dx = clientX - padAx, dy = clientY - padAy;
        const d = Math.hypot(dx, dy);
        if (d > 28) {
          const pull = (d - 28) / d;
          padAx += dx * pull;
          padAy += dy * pull;
        }
      }
      const zr = zoneRect || (zoneRect = zone.getBoundingClientRect());
      const visCx = Math.max(zr.left + padHalf, Math.min(zr.right - padHalf, padAx));
      const visCy = Math.max(zr.top + padHalf, Math.min(zr.bottom - padHalf, padAy));
      const [kx, ky] = dir >= 0 ? DIRS_XY[dir] : [0, 0];
      showDir(dir, kx * 20, ky * 20, visCx - padBaseX, visCy - padBaseY);
    };

    const findTouch = (list, id) => {
      if (!list) return null;
      for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
      return null;
    };

    zone.addEventListener('touchstart', e => {
      e.preventDefault();
      this.unlockAudio();
      if (padId !== null && !findTouch(e.touches, padId)) padId = null;
      if (padId !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      if (pad) { pad.style.transform = ''; lastPadTx = ''; }
      const r = pad.getBoundingClientRect();
      zoneRect = zone.getBoundingClientRect();
      padHalf = (r.width || pad?.offsetWidth || 112) * 0.5;
      padBaseX = r.left + r.width / 2;
      padBaseY = r.top + r.height / 2;
      if (getMode() === 'dpad') {
        const dist = Math.hypot(t.clientX - padBaseX, t.clientY - padBaseY);
        if (dist > r.width * 0.95) return;
        padId = t.identifier;
        pad?.classList.add('active');
        updateDpad(t.clientX, t.clientY);
      } else {
        padId = t.identifier;
        padAx = t.clientX;
        padAy = t.clientY;
        swipePts = [{ x: t.clientX, y: t.clientY }];
        pad?.classList.add('active');
        updateSwipe(t.clientX, t.clientY);
      }
    }, { passive: false });

    zone.addEventListener('touchmove', e => {
      if (padId === null) return;
      const t = findTouch(e.changedTouches, padId);
      if (!t) return;
      e.preventDefault();
      if (getMode() === 'dpad') updateDpad(t.clientX, t.clientY);
      else updateSwipe(t.clientX, t.clientY);
    }, { passive: false });

    const endPad = e => {
      if (padId === null) return;
      if (!findTouch(e.changedTouches, padId) && findTouch(e.touches, padId)) return;
      padId = null;
      swipePts = [];
      pad?.classList.remove('active');
      showDir(-1, 0, 0, 0, 0);
    };
    zone.addEventListener('touchend', endPad);
    zone.addEventListener('touchcancel', endPad);

    const syncActVisuals = () => {
      let h1 = false, h2 = false;
      for (const st of actTouches.values()) {
        if (st.b1) h1 = true;
        if (st.b2) h2 = true;
      }
      this.touch.held = h1;
      this.touch.powerHeld = h2;
      b1.classList.toggle('on', h1);
      b2.classList.toggle('on', h2);
    };

    const btnGeom = () => {
      const r1 = b1.getBoundingClientRect(), r2 = b2.getBoundingClientRect();
      return {
        c1x: r1.left + r1.width / 2, c1y: r1.top + r1.height / 2, rad1: Math.max(28, r1.width / 2),
        c2x: r2.left + r2.width / 2, c2y: r2.top + r2.height / 2, rad2: Math.max(26, r2.width / 2),
      };
    };

    actZone.addEventListener('touchstart', e => {
      e.preventDefault();
      this.unlockAudio();
      for (const id of actTouches.keys()) {
        if (!findTouch(e.touches, id)) actTouches.delete(id);
      }
      actGeom = btnGeom();
      const g = actGeom;
      for (const t of e.changedTouches) {
        const d1 = Math.hypot(t.clientX - g.c1x, t.clientY - g.c1y);
        const d2 = Math.hypot(t.clientX - g.c2x, t.clientY - g.c2y);
        if (Math.min(d1, d2) > Math.max(g.rad1, g.rad2) * 1.9) continue;
        const pickB1 = d1 <= d2;
        actTouches.set(t.identifier, { b1: pickB1, b2: !pickB1 });
        if (pickB1) this.touch.bomb = true;
        else this.touch.power = true;
      }
      syncActVisuals();
    }, { passive: false });

    actZone.addEventListener('touchmove', e => {
      if (!actTouches.size) return;
      e.preventDefault();
      const g = actGeom || (actGeom = btnGeom());
      let changed = false;
      for (const t of e.changedTouches) {
        const st = actTouches.get(t.identifier);
        if (!st) continue;
        const d1 = Math.hypot(t.clientX - g.c1x, t.clientY - g.c1y);
        const d2 = Math.hypot(t.clientX - g.c2x, t.clientY - g.c2y);
        if (st.b1 && !st.b2 && d2 <= g.rad2 * 1.25) {
          st.b2 = true;
          this.touch.power = true;
          changed = true;
        } else if (st.b1 && st.b2 && d2 > g.rad2 * 1.5 && d1 <= g.rad1 * 1.55) {
          st.b2 = false;
          changed = true;
        } else if (!st.b1 && st.b2 && d1 <= g.rad1 * 1.25) {
          st.b1 = true;
          this.touch.bomb = true;
          changed = true;
        }
      }
      if (changed) syncActVisuals();
    }, { passive: false });

    const endAct = e => {
      let changed = false;
      for (const t of e.changedTouches) {
        if (actTouches.delete(t.identifier)) changed = true;
      }
      for (const id of actTouches.keys()) {
        if (!findTouch(e.touches, id)) { actTouches.delete(id); changed = true; }
      }
      if (changed) syncActVisuals();
    };
    actZone.addEventListener('touchend', endAct);
    actZone.addEventListener('touchcancel', endAct);

    if (mpause) {
      mpause.addEventListener('touchstart', e => {
        e.preventDefault();
        this.unlockAudio();
        if (this.state === 'play') {
          if (this.netActive) this.online.openPause();
          else this.pause();
        }
      }, { passive: false });
    }
    const resetTouch = () => {
      padId = null;
      swipePts = [];
      actTouches.clear();
      zoneRect = null;
      actGeom = null;
      lastShownDir = -2;
      lastKnobDir = -2;
      lastPadTx = null;
      pad?.classList.remove('active');
      showDir(-1, 0, 0, 0, 0);
      syncActVisuals();
    };
    addEventListener('blur', resetTouch);
    addEventListener('resize', resetTouch);
    document.addEventListener?.('visibilitychange', () => { if (document.hidden) resetTouch(); });
  }
  readTouch() {
    const t = this.touch, r = { dir: t.dir, secDir: t.secDir, bomb: t.bomb, power: t.power, bombHeld: t.held, powerHeld: t.powerHeld };
    t.bomb = t.power = false; return r;
  }
}

const _initSave = loadSave();
const _initSmall = typeof matchMedia === 'function' && matchMedia('(max-width: 960px), (max-height: 540px), (pointer: coarse)').matches;
let _initQuality = _initSave.quality || (_initSmall ? 'low' : 'high');
if ((_initSave.v || 0) < 4 && _initSmall && _initQuality === 'medium') _initQuality = 'low';
if (!(_initQuality in QUALITY)) _initQuality = _initSmall ? 'low' : 'high';

Promise.all([
  fetch('data/levels.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} loading data/levels.json`); return r.json(); }),
  loadArt({ loadReal: _initQuality !== 'low' }),
  loadClassicArt(),
])
  .then(([data, art, classicArt]) => { window.app = new App(data, art, classicArt); })
  .catch(e => { const el = $('#loading'); if (el) el.textContent = 'Could not load game: ' + (e?.message || e); console.error(e); });
