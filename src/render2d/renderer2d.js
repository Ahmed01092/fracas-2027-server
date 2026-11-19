// Fast 2D renderer: the original Fracas sprites (HD-upscaled atlas) + modern lighting, glow, particles, shake.
import { W, H, TEAM, PICKUP_INFO, BLAST_TIME, BLAST_TIMES, FUSE, TICK_HZ, T as TER, spikeVisualState } from '../game/constants.js';
import { loadRealTextures, bakeLevel, makeBoulders, releaseBakeBufs } from './realistic.js';

const T = 64;                                  // world pixels per tile (source art is 16 px, upscaled x4)
const S = 4;                                   // source pixel -> world pixel
const WW = W * T, WH = H * T;
const FEET = 0.46;                            // where a character's feet sit below its tile centre
const CHAR = 0.82;                            // wizards and monsters are drawn a bit smaller than the original art,
                                              // so a head only just reaches the wall behind it
export const PICK_INDEX = ['foot', 'purpleGem', 'greenGem', 'max', 'heart', 'radiation', 'ghost', 'orb', 'ignitor',
  'stoneWind', 'stoneTeleport', 'stoneElectric', 'stoneFire', 'glassFire', 'glassWind', 'glassElectric', 'glassTeleport'];
export const ANIM_DIR = [0, 3, 1, 2];                 // sim dir (E,S,W,N) -> monster sequence index (E,W,N,S)
export const WIZ_BASE = [5, 0, 10, 15];               // sim dir -> first wizard walk frame
export const PINGPONG = [0, 1, 2, 3, 4, 3, 2, 1];
export const SPIKE_GROUP = [0, 1, 3, 2];              // spike wall code -> AM_SPIKE group of 8
export const FIRE_GROUP = [1, 2, 3, 0];               // sim dir -> TH_FIRE group of 14 (up, right, down, left)
const MAGIC_TINTS = ['#ff68ff', '#68ffff', '#ffff72', '#ff7cb8', '#8cb4ff', '#98ff98', '#ffffff'];
const STONE_SPECKS = ['#444650', '#606470', '#7e8492', '#a4aab8'];

export const QUALITY = {
  low: { name: 'Low', light: false, glows: false, realBake: false, fastFx: true, particles: 0.25, smooth: false, dpr: 1 },
  medium: { name: 'Medium', light: true, glows: true, realBake: true, fastFx: false, particles: 0.6, smooth: true, dpr: 1.25 },
  high: { name: 'High', light: true, glows: true, realBake: true, fastFx: false, particles: 1, smooth: true, dpr: 2 },
  ultra: { name: 'Ultra', light: true, glows: true, realBake: true, fastFx: false, particles: 1.6, smooth: true, dpr: 2 },
};

const WORLD_MOOD = {         // darkness, ambient tint
  'Stone Halls': [0.42, '#ffd9a8'], 'Conveyor Works': [0.38, '#cfe0ff'], 'Spike Crypt': [0.55, '#9fb0ff'],
  'Dark Citadel': [0.6, '#ffb0d8'], 'Moonlit Keep': [0.45, '#b8c4ff'], 'Ember Vaults': [0.4, '#ffc090'],
  'Verdant Ruins': [0.35, '#d8ffc0'], 'Storm Bastion': [0.5, '#b0c0ff'], 'Time Halls': [0.38, '#ffe8c0'],
  'Star Sanctum': [0.5, '#d8c0ff'], Battle: [0.4, '#ffd0b0'],
};

function mkCanvas(w, h, opts) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return [c, opts ? c.getContext('2d', opts) : c.getContext('2d')];
}

function isDrawableOk(d) {
  if (!d) return false;
  if ('naturalWidth' in d) return d.complete !== false && d.naturalWidth > 0 && d.naturalHeight > 0;
  return d.width > 0 && d.height > 0 && !d.getContext?.('2d')?.isContextLost?.();
}

function fxHash(a, b = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) ^ 0xc2b2ae35, 0x27d4eb2f);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function promoteSmallImg(canvas, onReady) {
  if (!canvas || typeof Image === 'undefined') return;
  if (typeof canvas.toBlob === 'function' && typeof URL?.createObjectURL === 'function') {
    try {
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => {
          if (im.naturalWidth > 0) onReady(im);
          try { URL.revokeObjectURL(url); } catch {}
        };
        im.onerror = () => { try { URL.revokeObjectURL(url); } catch {} };
        im.src = url;
      }, 'image/png');
      return;
    } catch {}
  }
  if (typeof canvas.toDataURL !== 'function') return;
  try {
    const im = new Image();
    im.onload = () => { if (im.naturalWidth > 0) onReady(im); };
    im.onerror = () => {};
    im.src = canvas.toDataURL('image/png');
  } catch {}
}

export class Renderer2D {
  constructor(canvas, qualityName = 'high', art) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
    this.baseAtlas = art.image; this.hdAtlas = art.hdAtlas || art.image; this.atlas = this.hdAtlas; this.frames = art.frames; this.mons = art.monsters; this.real = art.real;
    this.dark = false; this.blastPreview = false; this.time = 0; this.shake = 0; this.flash = 0; this.flashColor = '#fff'; this.bright = 1; this.psycho = false;
    this.particles = []; this.fx = []; this.emotes = []; this.killFeed = []; this.glowCache = new Map();
    this._fxCache = new Map();
    this._magicCache = new Map(); this._convCache = new Map(); this._barrierCache = new Map();
    this._pickupCache = new Map(); this._bombCache = new Map(); this._ventCache = new Map(); this._spikeCache = new Map();
    this._auraCache = new Map(); this._onewayFrames = null; this._sparkBatch = [];
    this._actorList = []; this._hudBars = [null, null]; this._hudSig = '';
    this.activeFeat = []; this.onewayCells = []; this.rockCells = []; this.ventCells = [];
    this.windParts = []; this._windPool = []; this._windEmitAcc = 0;
    this._surfacesLost = false;
    this._surfGen = 0; this._vigGen = 0; this._bgGen = 0;
    this._bgBlobUrl = null; this._ovBlobUrl = null;
    this._realPromise = null; this._realFailed = false;
    this.bgDrawable = null; this.overhangDrawable = null;
    this.vig = null;
    this.logo = new Image(); this.logo.src = 'assets/menus/logo_hd.png';
    this.qName = qualityName in QUALITY ? qualityName : 'high';
    this.q = QUALITY[this.qName];
    this._watch(canvas);
    this._initSurfaces();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  _watch(c) {
    if (!c || c._watched || !c.addEventListener) return c;
    c._watched = true;
    c.addEventListener('contextlost', e => { e.preventDefault?.(); this._surfacesLost = true; });
    c.addEventListener('contextrestored', () => { this._surfacesLost = true; });
    return c;
  }

  _mkCanvas(w, h, opts) {
    const [c, x] = mkCanvas(w, h, opts);
    this._watch(c);
    return [c, x];
  }

  _promoteBlobLayer(canvas, isCurrent, setImg, setUrl, getOldUrl) {
    if (!canvas || typeof canvas.toBlob !== 'function' || typeof URL?.createObjectURL !== 'function' || typeof Image === 'undefined') return;
    try {
      canvas.toBlob(blob => {
        if (!blob || !isCurrent()) return;
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => {
          if (!isCurrent() || im.naturalWidth <= 0) {
            try { URL.revokeObjectURL(url); } catch {}
            return;
          }
          const prevUrl = getOldUrl();
          setUrl(url);
          setImg(im);
          if (prevUrl && prevUrl !== url) {
            try { URL.revokeObjectURL(prevUrl); } catch {}
          }
        };
        im.onerror = () => {
          try { URL.revokeObjectURL(url); } catch {}
        };
        im.src = url;
      }, 'image/png');
    } catch {}
  }

  _revokeHudUrls() {
    for (const b of this._hudBars) {
      if (b?.url) {
        try { URL.revokeObjectURL(b.url); } catch {}
        b.url = null;
      }
    }
  }

  _initSurfaces() {
    const sGen = ++this._surfGen;
    const fast = !!this.q?.fastFx, realBake = !!this.q?.realBake;
    this.glowCache.clear(); this._fxCache.clear(); this._magicCache?.clear();
    this._convCache?.clear(); this._barrierCache?.clear(); this._pickupCache?.clear();
    this._bombCache?.clear(); this._ventCache?.clear(); this._spikeCache?.clear();
    this._doorCache?.clear(); this._auraCache?.clear(); this._onewayFrames = null;
    this._onewayBg = null; this._portalBase = null; this._scorchImg = null;
    this._revokeHudUrls();
    this._hudBars = [null, null]; this._hudSig = ''; this.vig = null;
    {
      const [am, amx] = this._mkCanvas(64, 64);
      if (amx) {
        const ag = amx.createRadialGradient(32, 32, 2, 32, 32, 32);
        ag.addColorStop(0, 'rgba(235, 248, 255, 0.38)');
        ag.addColorStop(0.42, 'rgba(185, 228, 255, 0.17)');
        ag.addColorStop(0.76, 'rgba(155, 212, 250, 0.05)');
        ag.addColorStop(1, 'rgba(150, 210, 250, 0)');
        amx.fillStyle = ag; amx.fillRect(0, 0, 64, 64);
      }
      this.airMist = am;
      if (!fast) promoteSmallImg(am, im => { if (this._surfGen === sGen) this.airMist = im; });
    }
    [this.bg, this.bgx] = this._mkCanvas(WW, WH);
    if (!fast || this.dark) [this.light, this.lctx] = this._mkCanvas(WW / 4, WH / 4);
    else { this.light = null; this.lctx = null; }
    if (realBake) [this.wallOverhang, this.wallOverhangX] = this._mkCanvas(WW, WH);
    else { this.wallOverhang = null; this.wallOverhangX = null; this.overhangDrawable = null; }
    if (!fast) [this.flameBuf, this.flameCtx] = this._mkCanvas(WW, WH);
    else { this.flameBuf = null; this.flameCtx = null; }
    if (realBake && this.real && this.baseAtlas) {
      const keepBoulders = Array.isArray(this.boulders) && this.boulders.length === 10
        && this.boulders.every(b => !b || ('naturalWidth' in b && isDrawableOk(b)));
      if (!keepBoulders) {
        this.boulders = makeBoulders(this.baseAtlas, this.frames, this.real);
        if (this.boulders) for (const b of this.boulders) this._watch(b);
      }
    } else {
      this.boulders = null;
    }
    if (!fast) {
      if (this.frames && this.baseAtlas) for (let k = 0; k < 16; k++) this.getBarrierSprite(k);
      for (const name of PICK_INDEX) this.getPickupSprite(name);
      for (const k of ['fire', 'electric', 'magic']) for (let f = 0; f < 6; f++) this.getBombSprite(k, f);
      for (let v = 0; v < 4; v++) this.getVentSprite(v);
      for (let w = 0; w < 4; w++) { this.getSpikeSocketSprite(w); this.getSpikeBladeSprite(w); }
      for (const c of ['#ffffff', '#ff8020', '#ff7a20', '#a8dcff', '#b4e4ff', '#c0d8ff', '#9cd8ff', '#ff60ff', '#38b8ff', '#8be6ff', '#ffd700', '#20e8b8', '#80e8ff', '#50ffd2']) this.glow(c);
    }
  }

  _ensureAuxSurfaces() {
    if (!this.q?.fastFx && (!this.flameBuf || !this.flameCtx || this.flameCtx.isContextLost?.())) {
      [this.flameBuf, this.flameCtx] = this._mkCanvas(WW, WH);
    }
    if (this.q?.realBake && (!this.wallOverhang || !this.wallOverhangX || this.wallOverhangX.isContextLost?.())) {
      [this.wallOverhang, this.wallOverhangX] = this._mkCanvas(WW, WH);
    }
    if ((!this.q?.fastFx || this.dark) && (!this.light || !this.lctx || this.lctx.isContextLost?.())) {
      [this.light, this.lctx] = this._mkCanvas(WW / 4, WH / 4);
    }
  }

  ensureRealTextures() {
    if (!this.q?.realBake || this.real || this._realFailed) return this._realPromise;
    if (!this._realPromise) {
      this._realPromise = loadRealTextures().then(real => {
        this._realPromise = null;
        if (!real) { this._realFailed = true; return null; }
        this.real = real;
        if (this.q?.realBake && this.baseAtlas && !this.boulders) {
          this.boulders = makeBoulders(this.baseAtlas, this.frames, this.real);
          if (this.boulders) for (const b of this.boulders) this._watch(b);
        }
        if (this.game && this.q?.realBake) this.buildBackground();
        return real;
      }).catch(() => { this._realPromise = null; this._realFailed = true; return null; });
    }
    return this._realPromise;
  }

  _needsSurfaceRecovery() {
    if (this._surfacesLost) return true;
    const fast = !!this.q?.fastFx, realBake = !!this.q?.realBake;
    if (this.bgx?.isContextLost?.()
      || (realBake && this.wallOverhangX?.isContextLost?.())
      || (this.light && this.lctx?.isContextLost?.())
      || (!fast && this.flameCtx?.isContextLost?.())) return true;
    const bgOk = isDrawableOk(this.bgDrawable) || isDrawableOk(this.bg);
    if (!bgOk || (!fast && !isDrawableOk(this.vig)) || !isDrawableOk(this.airMist)) return true;
    for (const b of this._hudBars) if (b && (b.ctx?.isContextLost?.() || (!isDrawableOk(b.img) && !isDrawableOk(b.canvas)))) return true;
    if (this.boulders) for (const b of this.boulders) if (b && !isDrawableOk(b)) return true;
    return false;
  }

  recoverSurfaces() {
    const keepBg = this.bgDrawable && ('naturalWidth' in this.bgDrawable) && isDrawableOk(this.bgDrawable);
    const keepOv = !this.real || !this.q?.realBake || (this.overhangDrawable && ('naturalWidth' in this.overhangDrawable) && isDrawableOk(this.overhangDrawable));
    this._initSurfaces();
    this.resize();
    if (this.game && !(keepBg && keepOv)) this.buildBackground();
    this._surfacesLost = false;
  }

  setQuality(name) {
    const prevQ = this.q;
    this.qName = QUALITY[name] ? name : 'high';
    this.q = QUALITY[this.qName];
    if (!this.q.realBake) {
      this.boulders = null;
      releaseBakeBufs();
      if (this._ovBlobUrl) { try { URL.revokeObjectURL(this._ovBlobUrl); } catch {} this._ovBlobUrl = null; }
      this.overhangDrawable = null;
      this.wallOverhang = null; this.wallOverhangX = null;
    } else {
      this._ensureAuxSurfaces();
      this.ensureRealTextures();
      if (this.real && this.baseAtlas && !this.boulders) {
        this.boulders = makeBoulders(this.baseAtlas, this.frames, this.real);
        if (this.boulders) for (const b of this.boulders) this._watch(b);
      }
    }
    if (this.q.fastFx) {
      this.flameBuf = null; this.flameCtx = null; this.vig = null;
      if (!this.dark) { this.light = null; this.lctx = null; }
    } else {
      this._ensureAuxSurfaces();
    }
    if (this.canvas && prevQ && (prevQ.dpr !== this.q.dpr || prevQ.fastFx !== this.q.fastFx)) {
      this.resize();
    }
    if (this.game && prevQ && prevQ.realBake !== this.q.realBake) {
      this.buildBackground();
    }
  }

  resize() {
    const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 960px), (max-height: 540px), (pointer: coarse)').matches;
    const dprCap = mobile ? Math.min(1.5, this.q?.dpr ?? 1.5) : (this.q?.dpr ?? 2);
    const dpr = Math.min(devicePixelRatio || 1, dprCap);
    const w = Math.max(1, innerWidth || 1), h = Math.max(1, innerHeight || 1);
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    // the original dashboard bar (320x18 source pixels) sits above the board at the board's width; a second one
    // below it for players 3 and 4
    const pad = 8 * dpr, bar = WW * 18 / 320, gap = 6, bars = this.bars || 1;
    const total = WH + (bar + gap) * bars;
    this.scale = Math.min((this.canvas.width - pad * 2) / WW, (this.canvas.height - pad * 2) / total);
    this.ox = (this.canvas.width - WW * this.scale) / 2;
    this.oy = (this.canvas.height - total * this.scale) / 2 + (bar + gap) * this.scale;
    if (this.q?.fastFx) {
      this.vig = null;
      return;
    }
    const vw = Math.max(1, Math.min(this.canvas.width, 320));
    const vh = Math.max(1, Math.round(vw * this.canvas.height / Math.max(1, this.canvas.width)));
    const [v, vx] = this._mkCanvas(vw, vh);
    if (vx) {
      const g = vx.createRadialGradient(v.width / 2, v.height / 2, Math.min(v.width, v.height) * 0.55, v.width / 2, v.height / 2, Math.max(v.width, v.height) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.3)');
      vx.fillStyle = g; vx.fillRect(0, 0, v.width, v.height);
    }
    this.vig = v;
    const vGen = ++this._vigGen;
    promoteSmallImg(v, im => { if (this._vigGen === vGen) this.vig = im; });
  }

  // ---------------------------------------------------------------- drawing helpers
  spr(ctx, key, x, y, opts) {
    const f = this.frames[key]; if (!f) return;
    const [sx, sy, w, h] = f;
    if (!opts) { ctx.drawImage(this.atlas, sx, sy, w, h, x, y, w, h); return; }
    const sc = opts.scale || 1;
    ctx.drawImage(this.atlas, sx, sy, w, h, x - (w * sc - w) / 2, y - (h * sc - h), w * sc, h * sc);
  }
  /** draw a frame at a tile-space position using the frame's own offset (source px) */
  sprAt(ctx, key, tx, ty, opts) {
    const f = this.frames[key]; if (!f) return;
    this.spr(ctx, key, tx * T + f[4] * S, ty * T + f[5] * S, opts);
  }
  /** centre a frame on a tile-space point */
  sprC(ctx, key, cx, cy, scale = 1, rot = 0) {
    const f = this.frames[key]; if (!f) return;
    const [sx, sy, w, h] = f;
    ctx.save(); ctx.translate(cx * T, cy * T); if (rot) ctx.rotate(rot);
    ctx.drawImage(this.atlas, sx, sy, w, h, -w * scale / 2, -h * scale / 2, w * scale, h * scale); ctx.restore();
  }
  glow(color) {
    const hit = this.glowCache.get(color);
    if (isDrawableOk(hit)) return hit;
    const [c, x] = this._mkCanvas(128, 128);
    if (x) {
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, color); g.addColorStop(0.3, color + '88'); g.addColorStop(1, color + '00');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    }
    this.glowCache.set(color, c);
    if (!this.q?.fastFx) promoteSmallImg(c, im => { if (this.glowCache.get(color) === c) this.glowCache.set(color, im); });
    return c;
  }
  addGlow(ctx, color, cx, cy, r, a = 1) {
    ctx.globalAlpha = a; const g = this.glow(color);
    if (isDrawableOk(g)) ctx.drawImage(g, cx * T - r * T, cy * T - r * T, r * 2 * T, r * 2 * T);
    ctx.globalAlpha = 1;
  }
  tintedMagic(frameIdx, color) {
    if (!this._magicCache) this._magicCache = new Map();
    const key = frameIdx + ':' + color;
    const hit = this._magicCache.get(key);
    if (isDrawableOk(hit)) return hit;
    const fr = this.frames['DE_MAGIC/' + frameIdx]; if (!fr || !this.atlas) return null;
    const [sx, sy, w, h] = fr, [c, x] = this._mkCanvas(w, h);
    if (!x) return null;
    x.drawImage(this.atlas, sx, sy, w, h, 0, 0, w, h);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    this._magicCache.set(key, c);
    if (!this.q?.fastFx) promoteSmallImg(c, im => { if (this._magicCache.get(key) === c) this._magicCache.set(key, im); });
    return c;
  }

  /** Cache filtered/tinted/dissolved actor sprite variants offscreen once instead of calling runtime ctx.filter per frame */
  getFxSprite(key, mode) {
    const ck = key + ':' + mode;
    const c = this._fxCache.get(ck);
    if (isDrawableOk(c)) return c;
    const fr = this.frames[key]; if (!fr || !this.atlas) return null;
    const img = this.atlas;
    const [sx, sy, w, h] = fr;
    const isDissolve = mode.startsWith('mdis');
    const [canvas, x] = this._mkCanvas(w, h, isDissolve ? { willReadFrequently: true } : undefined);
    if (!x) return null;
    if (mode === 'flash' || mode === 'portal' || mode === 'tpCyan' || mode === 'tpMag') {
      x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = mode === 'flash' ? '#ffffff' : mode === 'portal' ? '#68ffe4' : mode === 'tpCyan' ? '#3cf2ff' : '#ec58ff';
      x.fillRect(0, 0, w, h);
    } else if (mode === 'stasis') {
      try {
        x.filter = 'sepia(1) saturate(3) hue-rotate(5deg) brightness(1.2)';
        x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      } finally { x.filter = 'none'; }
    } else if (isDissolve) {
      const stage = Math.max(1, Math.min(4, +mode.slice(4) || 1));
      x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      try {
        const imgData = x.getImageData(0, 0, w, h);
        const data = imgData.data;
        const thresh = [0.24, 0.43, 0.61, 0.78][stage - 1];
        const charMix = [0.42, 0.68, 0.85, 0.94][stage - 1];
        const invW = 1 / Math.max(1, w), invH = 1 / Math.max(1, h);
        let anyNonZero = false;
        for (let py = 0; py < h; py++) {
          const yf = py * invH;
          for (let px = 0; px < w; px++) {
            const p = (py * w + px) * 4;
            const a = data[p + 3];
            if (a === 0) continue;
            anyNonZero = true;
            const xf = px * invW;
            const wave = Math.sin(px * 0.24 + Math.cos(py * 0.19) * 1.8) * 0.30
                       + Math.cos(py * 0.28 - Math.sin(px * 0.21) * 1.6) * 0.26
                       + Math.sin((px + py) * 0.45) * 0.14;
            const n = Math.max(0, Math.min(1, 0.52 + wave * 0.65));
            const edgeBias = (1 - yf) * 0.22 + Math.abs(xf - 0.5) * 0.20;
            const val = n * 0.72 + edgeBias;
            if (val < thresh) {
              data[p + 3] = 0;
            } else if (val < thresh + 0.088) {
              const hot = 1 - (val - thresh) / 0.088;
              data[p]     = Math.min(255, Math.round(255 * (0.85 + 0.15 * hot)));
              data[p + 1] = Math.min(255, Math.round(78 + 158 * hot));
              data[p + 2] = Math.min(255, Math.round(10 + 108 * hot * hot));
              data[p + 3] = Math.round(a * (0.72 + 0.28 * hot));
            } else {
              const r = data[p], g = data[p + 1], b = data[p + 2];
              const lum = r * 0.299 + g * 0.587 + b * 0.114;
              const sootR = lum * 0.24 + 12, sootG = lum * 0.16 + 7, sootB = lum * 0.12 + 5;
              const vein = val < thresh + 0.14 ? (1 - (val - thresh - 0.088) / 0.052) * 0.55 : 0;
              data[p]     = Math.min(255, Math.round(r * (1 - charMix) + sootR * charMix + 170 * vein));
              data[p + 1] = Math.min(255, Math.round(g * (1 - charMix) + sootG * charMix + 48 * vein));
              data[p + 2] = Math.min(255, Math.round(b * (1 - charMix) + sootB * charMix + 8 * vein));
            }
          }
        }
        if (anyNonZero) x.putImageData(imgData, 0, 0);
      } catch {}
    } else {
      const idx = +mode.slice(4) || 1;
      const b = [1, 0.65, 0.35, 0.16][idx] ?? 0.25;
      try {
        x.filter = `brightness(${b}) sepia(${Math.min(1, idx * 0.35)})`;
        x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      } finally { x.filter = 'none'; }
    }
    if (this._fxCache.size >= 256) {
      let drop = 64;
      for (const k of this._fxCache.keys()) {
        this._fxCache.delete(k);
        if (--drop <= 0) break;
      }
    }
    this._fxCache.set(ck, canvas);
    return canvas;
  }

  /**
   * Get a pre-rendered conveyor tile canvas for the given direction and palette phase.
   * Implements FRACAS.EXE VGA DAC palette cycling (0x8091): the 3 slat colors rotate
   * every 4 ticks (phase 0,1,2) — forward for East/South, backward for West/North.
   * Returns a 64x64 canvas that can be drawImage'd directly.
   */
  /**
   * Get a pre-rendered HD conveyor tile canvas for the given direction and palette phase.
   * Implements FRACAS.EXE VGA DAC palette cycling (0x8091): the 3 slat colors (#b8b89c, #9c9474, #807048)
   * rotate every 4 ticks (phase 0,1,2) — forward for East/South, backward for West/North.
   * Returns a smooth 64x64 canvas that can be drawImage'd directly.
   */
  getConveyorTile(dir, phase) {
    if (!this._convCache) this._convCache = new Map();
    const key = dir * 3 + phase;
    const hit = this._convCache.get(key);
    if (isDrawableOk(hit)) return hit;

    const [src, sctx] = this._mkCanvas(T, T);
    if (!sctx) return null;

    // 3 original VGA belt slat colors (indices 186-188: #b8b89c, #9c9474, #807048)
    const SLAT = ['#b8b89c', '#9c9474', '#807048'];
    const fwd = (dir === 0 || dir === 1);
    const horiz = (dir === 0 || dir === 2);
    const railW = 4;
    const beltX = horiz ? 0 : 8, beltY = horiz ? 8 : 0;
    const beltW = horiz ? T : T - 16, beltH = horiz ? T - 16 : T;

    // Soft cast shadow matching original 251/252 exterior belt drop shadow
    sctx.fillStyle = 'rgba(0, 0, 8, 0.44)';
    if (horiz) sctx.fillRect(beltX, beltY + beltH, beltW, 4);
    else sctx.fillRect(beltX + beltW, beltY, 4, beltH);

    // Belt bed & smoothly bevelled scrolling 12px-pitch slats (3x 4px bands per cycle)
    sctx.save();
    sctx.beginPath();
    sctx.rect(beltX, beltY, beltW, beltH);
    sctx.clip();

    const pitch = 12;
    const nSlats = Math.ceil((horiz ? beltW : beltH) / pitch) + 2;
    const shift = (fwd ? phase : (3 - phase) % 3) * 4;
    for (let i = -1; i < nSlats; i++) {
      const p0 = i * pitch + shift;
      const g = horiz
        ? sctx.createLinearGradient(p0, 0, p0 + pitch, 0)
        : sctx.createLinearGradient(0, p0, 0, p0 + pitch);
      g.addColorStop(0.0, SLAT[2]);
      g.addColorStop(0.32, SLAT[0]);
      g.addColorStop(0.68, SLAT[1]);
      g.addColorStop(1.0, SLAT[2]);
      sctx.fillStyle = g;
      if (horiz) sctx.fillRect(p0, beltY, pitch, beltH);
      else sctx.fillRect(beltX, p0, beltW, pitch);

      // Subtle slat trough shadow & leading ridge glint
      sctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      if (horiz) sctx.fillRect(p0, beltY + railW, 1.5, beltH - railW * 2);
      else sctx.fillRect(beltX + railW, p0, beltW - railW * 2, 1.5);
    }

    // Vignette depth along inner rail edges
    const innerEdge = horiz
      ? sctx.createLinearGradient(0, beltY + railW, 0, beltY + beltH - railW)
      : sctx.createLinearGradient(beltX + railW, 0, beltX + beltW - railW, 0);
    innerEdge.addColorStop(0, 'rgba(0,0,0,0.35)');
    innerEdge.addColorStop(0.14, 'rgba(255,255,255,0.06)');
    innerEdge.addColorStop(0.86, 'rgba(0,0,0,0.04)');
    innerEdge.addColorStop(1, 'rgba(0,0,0,0.40)');
    sctx.fillStyle = innerEdge;
    sctx.fillRect(beltX, beltY, beltW, beltH);

    // Side metallic guide rails + end caps (#000000 outer border matching OBSTACLE/12..15)
    const drawRail = (rx, ry, rw, rh, topOrLeft) => {
      sctx.fillStyle = '#000000';
      sctx.fillRect(rx, ry, rw, rh);
      const rg = horiz
        ? sctx.createLinearGradient(rx, ry, rx, ry + rh)
        : sctx.createLinearGradient(rx, ry, rx + rw, ry);
      rg.addColorStop(0, topOrLeft ? '#545c66' : '#3a4048');
      rg.addColorStop(0.5, '#2b3036');
      rg.addColorStop(1, '#14171a');
      sctx.fillStyle = rg;
      sctx.fillRect(rx + (horiz ? 1 : 1), ry + (horiz ? 1 : 1), rw - 2, rh - 2);
    };
    if (horiz) {
      drawRail(beltX, beltY, beltW, railW, true);
      drawRail(beltX, beltY + beltH - railW, beltW, railW, false);
      sctx.fillStyle = '#000000';
      sctx.fillRect(beltX, beltY, 3, beltH);
      sctx.fillRect(beltX + beltW - 3, beltY, 3, beltH);
    } else {
      drawRail(beltX, beltY, railW, beltH, true);
      drawRail(beltX + beltW - railW, beltY, railW, beltH, false);
      sctx.fillStyle = '#000000';
      sctx.fillRect(beltX, beltY, beltW, 3);
      sctx.fillRect(beltX, beltY + beltH - 3, beltW, 3);
    }
    sctx.restore();

    this._convCache.set(key, src);
    if (!this.q?.fastFx) promoteSmallImg(src, im => { if (this._convCache.get(key) === src) this._convCache.set(key, im); });
    return src;
  }

  // ---------------------------------------------------------------- level setup
  setGame(game) {
    this.game = game; this.particles = []; this.fx = [];
    this._fxCache.clear();
    const bars = game.players.length > 2 ? 2 : 1;
    if (bars !== this.bars) { this.bars = bars; this.resize(); }
    this.mood = WORLD_MOOD[game.level.world] || WORLD_MOOD['Stone Halls'];
    this.doorAnim = new Map(); this.spikeExt = new Map(); this.ventFlash = new Map(); this.barrierState = new Map(); this.dying = [];
    this.monState = new Map(); this.zapFx = new Map(); this.deaths = new Map(); this.scorch = [];
    this.portalSpawnT = 0; this.portalMotes = []; this.portalEntries = new Map();
    this.powerWarn = new Map(); this.tpVis = new WeakMap();
    this._lxAnim = null;
    this._hudSig = '';
    this.rockVar = new Map((game.level.rocks || []).map(([x, y, v]) => [y * W + x, v % 10]));
    this.activeFeat = []; this.onewayCells = []; this.rockCells = []; this.ventCells = [];
    if (this.windParts) this.windParts.length = 0;
    for (let i = 0; i < W * H; i++) {
      if (game.terrain[i] === TER.ROCK) this.rockCells.push(i);
      const f = game.feat[i];
      if (!f) continue;
      if (f.k === 'door') this.doorAnim.set(i, { from: f.state ?? (f.flipped ? 4 : 0), to: f.state ?? (f.flipped ? 4 : 0), t: 1 });
      if (f.k === 'oneway') this.onewayCells.push(i);
      else if (f.k === 'vent') this.ventCells.push(i);
      else if (f.k === 'walk' || f.k === 'spike' || f.k === 'door') this.activeFeat.push(i);
    }
    this.buildBackground();
  }

  buildBackground() {
    const g = this.game, lv = g?.level, x = this.bgx;
    if (!x || !lv) return;
    const gen = ++this._bgGen;
    if (this._bgBlobUrl) { try { URL.revokeObjectURL(this._bgBlobUrl); } catch {} this._bgBlobUrl = null; }
    if (this._ovBlobUrl) { try { URL.revokeObjectURL(this._ovBlobUrl); } catch {} this._ovBlobUrl = null; }
    this.bgDrawable = this.bg;
    this.overhangDrawable = this.wallOverhang;
    x.imageSmoothingEnabled = false;
    x.fillStyle = '#000'; x.fillRect(0, 0, WW, WH);
    this.wallOverhangX?.clearRect(0, 0, WW, WH);
    if (this.real && this.q?.realBake !== false) {                       // photo-real stone floor and raised walls, baked once per level
      let baked = false;
      try {
        baked = bakeLevel(x, g, this.real, this.wallOverhangX) !== false;
      } catch (e) {
        console.warn('bakeLevel failed, falling back to classic tiles:', e);
      }
      if (baked) {
        this._drawBgVents(x, g);
        this._promoteBlobLayer(this.bg, () => this._bgGen === gen, im => { this.bgDrawable = im; }, u => { this._bgBlobUrl = u; }, () => this._bgBlobUrl);
        this._promoteBlobLayer(this.wallOverhang, () => this._bgGen === gen, im => { this.overhangDrawable = im; }, u => { this._ovBlobUrl = u; }, () => this._ovBlobUrl);
        return;
      }
    }
    for (let i = 0; i < W * H; i++) {
      const cx = i % W, cy = (i / W) | 0, f0 = lv.floorTiles?.[i] ?? 1, f1 = lv.foreTiles?.[i] ?? 0;
      if (f0) this.spr(x, 'BLK_BACK/' + (f0 % 49), cx * T, cy * T);
      if (f1) this.spr(x, 'BLK_FORE/' + (f1 % 77), cx * T, cy * T);
    }
    this._drawBgVents(x, g);
    if (!this.q?.fastFx) {
      this._promoteBlobLayer(this.bg, () => this._bgGen === gen, im => { this.bgDrawable = im; }, u => { this._bgBlobUrl = u; }, () => this._bgBlobUrl);
    }
  }

  _drawBgVents(x, g) {
    const prevS = x.imageSmoothingEnabled, prevQ = x.imageSmoothingQuality;
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    for (let i = 0; i < W * H; i++) {
      const f = g.feat[i];
      if (f?.k !== 'vent') continue;
      const cx = i % W, cy = (i / W) | 0;
      const spr = this.getVentSprite(f.g & 3);
      if (spr && isDrawableOk(spr.canvas)) x.drawImage(spr.canvas, cx * T, cy * T, T, T);
      else this.spr(x, 'OBSTACLE/' + (4 + (f.g & 3)), cx * T, cy * T);
    }
    x.imageSmoothingEnabled = prevS; x.imageSmoothingQuality = prevQ;
  }

  // ---------------------------------------------------------------- events -> effects
  handle(events) {
    const g = this.game;
    for (const e of events) {
      switch (e.t) {
        case 'blast':
          this.shake = Math.min(14, this.shake + 4 + e.cells.length * 0.25);
          const pal = { fire: ['#fff3b0', '#ffb030', '#ff5a10'], electric: ['#ffffff', '#a8dcff', '#60a0ff'], magic: ['#ff80ff', '#80ffff', '#ffff80'] }[e.kind || 'fire'];
          for (const i of e.cells) { const x = i % W + 0.5, y = ((i / W) | 0) + 0.5; this.burst(x, y, pal, 6, 3.2, 0.5, 'spark'); }
          if ((e.kind || 'fire') === 'fire') this.burst(e.x + 0.5, e.y + 0.5, ['#4a4048', '#2a2428'], 8, 1.2, 1.4, 'smoke');
          break;
        case 'rock':
          for (let k = 0, n = Math.round(20 * this.q.particles); k < n; k++) {
            const a = (Math.random() - 0.5) * 2.2;
            this.particles.push({ k: 'speck', x: e.x + 0.15 + Math.random() * 0.7, y: e.y + 0.15 + Math.random() * 0.6,
              vx: a * 1.4, vy: -0.6 - Math.random() * 2.4, t: 0, life: 0.48 + Math.random() * 0.35,
              c: STONE_SPECKS[k & 3], s: (1 + (Math.random() < 0.35 ? 0.5 : 0)) * S, rot: 0 });
          }
          break;
        case 'reveal': this.burst(e.x + 0.5, e.y + 0.5, [PICKUP_INFO[e.name]?.color || '#ffffff', '#ffffff'], 16, 2.5, 0.7, 'spark'); break;
        case 'pickup': { const col = PICKUP_INFO[e.name]?.color || '#ffffff'; this.burst(e.x + 0.5, e.y + 0.5, [col, '#ffffff'], 26, 3.5, 0.8, 'spark'); this.ring(e.x + 0.5, e.y + 0.5, col); break; }
        case 'eat': case 'burn': this.burst(e.x + 0.5, e.y + 0.5, ['#ffffff', '#ff9a40'], 10, 2, 0.5, 'spark'); break;
        case 'powerLow': this.powerWarn.set(e.p, 0.085); break;
        case 'stasis':
          this.shake = Math.min(14, this.shake + 6);
          this.flash = 0.55;
          this.flashColor = '#ffe040';
          this.burst(e.x + 0.5, e.y + 0.5, ['#ffd700', '#fff8a0', '#ffffff', '#ffaa00'], 40, 4.5, 0.9, 'spark');
          this.ring(e.x + 0.5, e.y + 0.5, '#ffd700');
          break;
        case 'stasisEnd':
          this.flash = 0.25;
          this.flashColor = '#ffffff';
          this.burst(WW / (2 * T), WH / (2 * T), ['#ffe040', '#ffffff'], 24, 3, 0.5, 'spark');
          break;
        case 'zap': this.zapFx.set(e.id, 0.55); this.shake = Math.min(10, this.shake + 2.5); this.burst(e.x, e.y, ['#ffffff', '#a8dcff', '#38b8ff'], 22, 4.4, 0.55, 'spark'); this.flashAt = [e.x, e.y]; break;
        case 'teleport':
          if (!e.phase) {
            this.fx.push({ k: 'magi', x: e.x0, y: e.y0, t: 0 }, { k: 'magi', x: e.x1, y: e.y1, t: 0 });
            this.burst(e.x1, e.y1, MAGIC_TINTS, 14, 2.4, 0.65, 'mstar');
          } else {
            this.ring(e.x1, e.y1, e.phase === 'hide' ? '#d070ff' : '#70f8ff');
            this.burst(e.x1, e.y1, MAGIC_TINTS, 8, 1.8, 0.55, 'mstar');
          }
          break;
        case 'vents': for (const [vx, vy] of g.vents) this.ventFlash.set(vy * W + vx, 0.6); break;
        case 'windZone': {
          const wx = e.x + 0.5, wy = e.y + 0.5;
          this.ring(wx, wy, '#9cd8ff');
          this.burst(wx, wy, ['#ffffff', '#cceeff', '#88d0ff'], e.all ? 24 : 14, e.all ? 4.2 : 3.0, 0.55, 'spark');
          break;
        }
        case 'barrier': {
          const i = e.y * W + e.x, horiz = !!(e.horiz ?? e.ns);
          if (!this.barrierState) this.barrierState = new Map();
          this.barrierState.set(i, { frame: Math.floor(Math.random() * 8), timer: 0, age: 0, horiz });
          const [ax0, ay0, ax1, ay1] = horiz ? [e.x + 0.04, e.y + 0.5, e.x + 0.96, e.y + 0.5] : [e.x + 0.5, e.y + 0.04, e.x + 0.5, e.y + 0.96];
          this.burst(ax0, ay0, ['#ffffff', '#7ce2ff', '#289eff'], 7, 2.2, 0.36, 'spark');
          this.burst(ax1, ay1, ['#ffffff', '#7ce2ff', '#289eff'], 7, 2.2, 0.36, 'spark');
          break;
        }
        case 'barrierTouch':
          this.burst(e.x, e.y, ['#ffffff', '#88e8ff', '#289eff'], 6, 2.4, 0.32, 'spark');
          break;
        case 'door': {
          const i = e.y * W + e.x, d = this.doorAnim.get(i);
          if (d) {
            const to = e.state !== undefined ? e.state : (e.flipped ? 4 : 0);
            if (e.byPlayer) {
              d.from = to;
              d.to = to;
              d.t = 1;
            } else {
              d.from = (d.to !== undefined && d.to !== to) ? d.to : (4 - to);
              d.to = to;
              d.t = 0;
            }
          }
          break;
        }
        case 'cast': { const p = g.players.find(q => q.slot === e.p); if (p) this.burst(p.x, p.y, [TEAM[e.p].light, '#ffffff'], e.area ? 30 : 12, e.area ? 4 : 2.5, 0.5, 'spark'); break; }
        case 'mdie': {
          const mv = this.monState.get(e.id);
          const fbM = this.mons?.[e.type] || this.mons?.[3];
          const fbKey = fbM ? `${fbM.file}/${fbM.seqs?.[3]?.[0] ?? 0}` : null;
          this.dying.push({ x: e.x, y: e.y, key: mv?.key || fbKey, feet: mv?.feet, type: mv?.type ?? e.type, t: 0, boss: e.boss });
          this.scorch.push({ x: e.x, y: e.y - 0.1, t: -0.6 });
          this.burst(e.x, e.y - 0.2, ['#fff2a0', '#ffb030', '#ff5010'], 24, 2.6, 0.7, 'spark');      // it goes up in flames
          if (e.boss) { this.shake = 22; this.flash = 0.7; this.flashColor = '#ffffff'; }
          break;
        }
        case 'bossHit': this.shake = 10; this.burst(e.x, e.y, ['#ffffff', '#ff4060'], 30, 4, 0.5, 'spark'); break;
        case 'die': {
          const fire = true;                               // every death burns
          this.deaths.set(e.p, { t: 0, fire, x: e.x, y: e.y });
          if (fire) { this.burst(e.x, e.y - 0.2, ['#fff2a0', '#ffb030', '#ff5010'], 26, 2.2, 0.8, 'spark'); this.scorch.push({ x: e.x, y: e.y, t: 0 }); }
          else this.burst(e.x, e.y - 0.3, [TEAM[e.p].light, TEAM[e.p].color, '#ffffff'], 34, 3, 0.9, 'spark');
          this.flash = 0.25; this.flashColor = fire ? '#ffb060' : '#ffffff';
          this.shake = Math.max(this.shake, 8); break;
        }
        case 'respawn': this.fx.push({ k: 'magi', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); break;
        case 'portalEnter': {
          const pl = g.players.find(q => q.slot === e.p);
          this.portalEntries.set(e.p, { x: e.x, y: e.y, t: 0, dur: 1.06, dir: pl?.dir ?? 1 });
          this.ring(e.x, e.y, '#60ffd8');
          this.burst(e.x, e.y, ['#40ffc0', '#90e8ff', '#ffffff'], 28, 3.2, 0.85, 'spark');
          break;
        }
        case 'portal':
          this.portalSpawnT = 0;
          this.portalMotes = Array.from({ length: 28 }, (_, k) => ({
            ang: (k / 28) * Math.PI * 2,
            rad: 0.16 + Math.random() * 0.34,
            sp: (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random() * 1.4),
            phase: Math.random() * 6.28,
            fr: 2 + (k % 8),
            lift: Math.random(),
          }));
          this.burst(e.x + 0.5, e.y + 0.5, ['#40ffc0', '#80e8ff', '#ffffff'], 48, 3.6, 1.0, 'spark');
          this.flash = 0.25; this.flashColor = '#40ffc0';
          break;
        case 'levelWon': this.flash = 0.5; this.flashColor = '#ffffff'; break;
        case 'shield': { const p = g.players.find(q => q.slot === e.p); if (p) this.ring(p.x, p.y, '#80d0ff'); break; }
      }
    }
  }

  burst(x, y, colors, n, speed, life, k) {
    n = Math.round(n * this.q.particles);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ k, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (k === 'smoke' ? 0.6 : 0), t: 0,
        life: life * (0.6 + Math.random() * 0.6), c: colors[i % colors.length],
        s: k === 'smoke' ? 0.5 + Math.random() * 0.5 : k === 'chunk' ? 0.15 + Math.random() * 0.12 : k === 'mstar' ? 0.75 + Math.random() * 0.4 : 0.12 + Math.random() * 0.14,
        rot: Math.random() * 6 });
    }
    const cap = this.q?.fastFx ? 350 : 1500;
    if (this.particles.length > cap) this.particles.splice(0, this.particles.length - cap);
  }
  ring(x, y, color) { this.fx.push({ k: 'ring', x, y, t: 0, c: color }); }

  _tickVentFlash(dt) {
    for (const [i, v] of this.ventFlash) {
      if (v - dt <= 0) this.ventFlash.delete(i); else this.ventFlash.set(i, v - dt);
    }
  }

  // ---------------------------------------------------------------- frame
  render(dt, alpha, opts = {}) {
    this.time += dt;
    const g = this.game, ctx = this.ctx, t = this.time;
    const fast = !!this.q?.fastFx;
    if (!ctx || ctx.isContextLost?.()) { this._surfacesLost = true; return; }
    if (this._needsSurfaceRecovery()) this.recoverSurfaces();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    if ('filter' in ctx && ctx.filter !== 'none') ctx.filter = 'none';
    ctx.fillStyle = '#06050a'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!g) return;
    this.shake = Math.max(0, this.shake - dt * 40);
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    let scale = this.scale, ox = this.ox, oy = this.oy;
    if (opts.orbit) {                                     // title screen: slow drifting zoom
      const z = 1.12 + Math.sin(t * 0.15) * 0.06; scale *= z;
      ox -= (WW * this.scale * (z - 1)) / 2 + Math.sin(t * 0.11) * 40; oy -= (WH * this.scale * (z - 1)) / 2;
    }
    ctx.setTransform(scale, 0, 0, scale, ox + sx, oy + sy);
    ctx.imageSmoothingEnabled = this.q.smooth; ctx.imageSmoothingQuality = fast ? 'low' : 'medium';
    const bgDraw = isDrawableOk(this.bgDrawable) ? this.bgDrawable : (isDrawableOk(this.bg) ? this.bg : null);
    if (bgDraw) ctx.drawImage(bgDraw, 0, 0);
    let sw = 0;
    for (let i = 0; i < this.scorch.length; i++) {
      const sc = this.scorch[i];
      sc.t += dt;
      const a = sc.t < 0 ? 0 : Math.max(0, Math.min(0.55, sc.t * 2) - sc.t * 0.12);
      if (a > 0) {
        const sx0 = sc.x * T, sy0 = (sc.y + 0.3) * T;
        if (fast) {
          ctx.globalAlpha = a * 0.68; ctx.fillStyle = '#090605';
          ctx.beginPath(); ctx.ellipse(sx0, sy0, 0.32 * T, 0.14 * T, 0, 0, 7); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          if (!this._scorchImg || !isDrawableOk(this._scorchImg)) {
            const [scv, scx] = this._mkCanvas(128, 128);
            if (scx) {
              const sg = scx.createRadialGradient(64, 64, 4, 64, 64, 64);
              sg.addColorStop(0, 'rgba(6, 4, 3, 1)');
              sg.addColorStop(0.52, 'rgba(18, 11, 8, 0.65)');
              sg.addColorStop(1, 'rgba(18, 10, 6, 0)');
              scx.fillStyle = sg; scx.fillRect(0, 0, 128, 128);
            }
            this._scorchImg = scv;
          }
          ctx.save();
          ctx.globalAlpha = Math.min(1, a * 1.45);
          ctx.drawImage(this._scorchImg, sx0 - 0.52 * T, sy0 - 0.25 * T, 1.04 * T, 0.50 * T);
          ctx.globalAlpha = a * 0.72; ctx.fillStyle = '#090605';
          ctx.beginPath(); ctx.ellipse(sx0, sy0, 0.28 * T, 0.13 * T, 0, 0, 7); ctx.fill();
          if (sc.t < 2.6) {
            const heat = Math.max(0, 1 - sc.t / 2.6);
            const seed = Math.round(sc.x * 13 + sc.y * 29);
            for (let c = 0; c < 6; c++) {
              const ang = fxHash(seed, c * 3) * Math.PI * 2;
              const rad = (0.05 + fxHash(seed, c * 3 + 1) * 0.22) * T;
              const ex = sx0 + Math.cos(ang) * rad, ey = sy0 + Math.sin(ang) * rad * 0.48;
              const pulse = 0.55 + 0.45 * Math.sin(t * 9 + c * 1.7 + seed);
              ctx.globalAlpha = heat * pulse * 0.85;
              ctx.fillStyle = c % 2 === 0 ? '#ff7a18' : '#ffd24a';
              ctx.beginPath(); ctx.arc(ex, ey, 1.5 + fxHash(seed, c * 3 + 2) * 1.8, 0, 7); ctx.fill();
            }
          }
          ctx.restore();
        }
      }
      if (sc.t < 0 || a > 0) this.scorch[sw++] = sc;
    }
    this.scorch.length = sw;
    const ov = isDrawableOk(this.overhangDrawable) ? this.overhangDrawable : (isDrawableOk(this.wallOverhang) ? this.wallOverhang : null);
    if (this.real && this.q?.realBake !== false && this.scorch.length && ov) ctx.drawImage(ov, 0, 0);
    this.drawFeatures(dt);
    this.drawWinds(dt);                         // floor-level air currents (wind zones & vent drafts), under items & actors
    this.drawPortal(dt);
    this.drawItems();
    if (this.blastPreview) this.drawBlastPreview();
    this.drawBombs(alpha);
    if (!fast && g.flames.size && this.flameCtx && this.flameBuf?.width > 0 && !this.flameCtx.isContextLost?.()) { // composite flames at 1:1 atlas scale and clip under overhanging 3D brick wall faces & caps
      let minX = W, minY = H, maxX = 0, maxY = 0;
      for (const i of g.flames.keys()) {
        const cx = i % W, cy = (i / W) | 0;
        if (cx < minX) minX = cx; if (cx + 1 > maxX) maxX = cx + 1;
        if (cy < minY) minY = cy; if (cy + 1 > maxY) maxY = cy + 1;
      }
      const rx = Math.max(0, (minX - 1) * T), ry = Math.max(0, (minY - 1) * T);
      const rw = Math.min(WW, (maxX + 1) * T) - rx, rh = Math.min(WH, (maxY + 1) * T) - ry;
      if (rw > 0 && rh > 0) {
        const fc = this.flameCtx;
        fc.save();
        fc.setTransform(1, 0, 0, 1, 0, 0);
        fc.clearRect(rx, ry, rw, rh);
        fc.beginPath(); fc.rect(rx, ry, rw, rh); fc.clip();
        fc.imageSmoothingEnabled = false;
        this.drawFlames(fc);
        if (this.real && ov) {
          fc.globalCompositeOperation = 'destination-out';
          fc.drawImage(ov, rx, ry, rw, rh, rx, ry, rw, rh);
        }
        fc.restore();
        ctx.drawImage(this.flameBuf, rx, ry, rw, rh, rx, ry, rw, rh);
      }
    } else {
      this.drawFlames();
    }
    this.drawActors(dt, alpha);
    this.drawProjectiles(alpha);
    this.drawBarriers(dt);
    if (this.dark) {
      if (!this.lctx) [this.light, this.lctx] = this._mkCanvas(WW / 4, WH / 4);
      this.drawLighting(0.75);   // dungeon darkness when enabled in options
    }
    if (this.q?.glows !== false) this.drawGlows(alpha, dt);
    else this._tickVentFlash(dt);
    this.drawParticles(dt);
    this.drawFx(dt);
    this.drawEmotes(dt);
    this.drawHud();
    this.drawFeed(dt);
    this.drawGetReady();
    this.drawLifeExchange();
    // screen-space post
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!fast && isDrawableOk(this.vig)) ctx.drawImage(this.vig, 0, 0, this.canvas.width, this.canvas.height);
    if (g.stasis > 0) {
      const pulse = 0.55 + 0.35 * Math.sin(t * 8);
      const warn = g.stasis < 2.0 ? (Math.sin(t * 20) > 0 ? 0.9 : 0.2) : pulse;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 215, 0, ${0.45 * warn})`;
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, this.canvas.width - 14, this.canvas.height - 14);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 * warn})`;
      ctx.lineWidth = 4;
      ctx.strokeRect(16, 16, this.canvas.width - 32, this.canvas.height - 32);
      ctx.restore();
    }
    this.flash = Math.max(0, this.flash - dt * 1.5);
    if (this.flash > 0) { ctx.globalAlpha = this.flash * 0.55; ctx.fillStyle = this.flashColor; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); ctx.globalAlpha = 1; }
    const filt = (Math.abs(this.bright - 1) <= 0.01 && !this.psycho)
      ? 'none'
      : `brightness(${this.bright})` + (this.psycho ? ` hue-rotate(${(t * 240) % 360}deg)` : '');
    if (this.canvas.style.filter !== filt) this.canvas.style.filter = filt;
  }

  addEmote(slot, text) {
    this.emotes = this.emotes.filter(e => e.slot !== slot);
    this.emotes.push({ slot, text: String(text || '').slice(0, 22), t: 2.6, maxT: 2.6 });
  }

  addFeed(text, color = '#f3f6fc') {
    this.killFeed.push({ text: String(text || '').slice(0, 44), color, t: 4.0, maxT: 4.0 });
    if (this.killFeed.length > 4) this.killFeed.shift();
  }

  drawBlastPreview() {
    const g = this.game, ctx = this.ctx;
    if (!g?.bombs?.length) return;
    const danger = new Set();
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const b of g.bombs) {
      if (b.fuse > 0.95) continue;
      const kind = b.kind || 'fire';
      const maxR = kind === 'electric' ? 21 : (b.vent >= 0 && kind === 'fire' ? 1 : b.range);
      danger.add(b.cy * W + b.cx);
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = dirs[d];
        for (let r = 1; r <= maxR; r++) {
          const nx = b.cx + dx * r, ny = b.cy + dy * r;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
          const ni = ny * W + nx;
          if (g.terrain[ni] === TER.WALL || g.barriers.has(ni)) break;
          if (g.terrain[ni] === TER.ROCK) { if (kind === 'fire') danger.add(ni); break; }
          const f = g.feat[ni];
          if (f?.k === 'oneway' && f.d !== d) break;
          danger.add(ni);
          if (f?.k === 'door') break;
        }
      }
    }
    if (!danger.size) return;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 18);
    ctx.save();
    ctx.fillStyle = `rgba(255, 72, 48, ${0.14 + 0.14 * pulse})`;
    ctx.strokeStyle = `rgba(255, 190, 90, ${0.35 + 0.35 * pulse})`;
    ctx.lineWidth = 2;
    for (const ci of danger) {
      const x = (ci % W) * T, y = ((ci / W) | 0) * T;
      ctx.fillRect(x + 4, y + 4, T - 8, T - 8);
      ctx.strokeRect(x + 5, y + 5, T - 10, T - 10);
    }
    ctx.restore();
  }

  drawEmotes(dt) {
    const g = this.game, ctx = this.ctx;
    if (!this.emotes.length || !g) return;
    ctx.save();
    ctx.font = '700 17px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let w = 0;
    for (let i = 0; i < this.emotes.length; i++) {
      const em = this.emotes[i];
      em.t -= dt;
      if (em.t <= 0) continue;
      this.emotes[w++] = em;
      const p = g.players.find(q => q.slot === em.slot);
      if (!p || !p.alive) continue;
      const tm = TEAM[em.slot] || TEAM[0];
      const alpha = em.t < 0.4 ? em.t / 0.4 : Math.min(1, (em.maxT - em.t) * 6);
      const lift = (1 - em.t / em.maxT) * 14;
      const px = Math.max(80, Math.min(WW - 80, p.x * T));
      const py = Math.max(36, p.y * T - T * 0.85 - lift);
      const tw = Math.max(66, ctx.measureText(em.text).width + 22);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(10, 14, 24, 0.88)';
      ctx.strokeStyle = tm.light;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px - tw / 2, py - 15, tw, 30, 15);
      else ctx.rect(px - tw / 2, py - 15, tw, 30);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(em.text, px, py + 1);
    }
    this.emotes.length = w;
    ctx.restore();
  }

  drawFeed(dt) {
    if (!this.killFeed.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '700 15px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let w = 0;
    let row = 0;
    for (let i = 0; i < this.killFeed.length; i++) {
      const it = this.killFeed[i];
      it.t -= dt;
      if (it.t <= 0) continue;
      this.killFeed[w++] = it;
      const alpha = it.t < 0.6 ? it.t / 0.6 : Math.min(1, (it.maxT - it.t) * 8);
      const tw = ctx.measureText(it.text).width + 20;
      const x = WW - 14;
      const y = 78 + row * 30;
      ctx.globalAlpha = alpha * 0.92;
      ctx.fillStyle = 'rgba(8, 12, 22, 0.80)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - tw, y - 12, tw, 24, 8);
      else ctx.rect(x - tw, y - 12, tw, 24);
      ctx.fill();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, x - 10, y + 1);
      row++;
    }
    this.killFeed.length = w;
    ctx.restore();
  }

  drawFeatures(dt) {
    const g = this.game, ctx = this.ctx, t = this.time;
    if (this.onewayCells.length) {
      for (let k = 0; k < this.onewayCells.length; k++) {
        const i = this.onewayCells[k], f = g.feat[i];
        if (!f) continue;
        this._drawOnewayGate(ctx, i % W, (i / W) | 0, f.d, t, i);
      }
    }
    const phase = Math.floor(t * 31 / 4) % 3;
    for (let k = 0; k < this.activeFeat.length; k++) {
      const i = this.activeFeat[k], f = g.feat[i];
      if (!f) continue;
      const cx = i % W, cy = (i / W) | 0;
      if (f.k === 'walk') {
        // FRACAS.EXE VGA DAC palette cycling: static sprite, 3 slat colors rotate every 4 ticks
        const tile = this.getConveyorTile(f.d, phase);
        if (isDrawableOk(tile)) ctx.drawImage(tile, cx * T, cy * T);
      } else if (f.k === 'spike') {
        const wIdx = (f.wall >= 0 && f.wall < 4) ? (f.wall | 0) : 0;
        let ext, warn;
        if (typeof f.ph === 'number') {
          ({ ext, warn } = spikeVisualState(f.ph, f.out, f.active !== false));
        } else if (f.out) {
          ext = 1; warn = 1;
        } else {
          const cur = this.spikeExt.get(i) || 0;
          ext = Math.max(0, cur - dt * 4);
          warn = ext;
        }
        this.spikeExt.set(i, ext);
        this._drawWallSpike(ctx, cx, cy, wIdx, ext, warn);
      } else if (f.k === 'door') {
        const d = this.doorAnim.get(i);
        if (d && d.t < 1) d.t = Math.min(1, d.t + dt * 5);
        let actorInDoor = null;
        for (let pi = 0; pi < g.players.length; pi++) {
          const p = g.players[pi];
          if (p.alive && p.tpPhase !== 'hide' && p.cx === cx && p.cy === cy) { actorInDoor = p; break; }
        }
        if (!actorInDoor) {
          for (let mi = 0; mi < g.monsters.length; mi++) {
            const m = g.monsters[mi];
            if (m.alive && m.tpPhase !== 'hide' && m.cx === cx && m.cy === cy) { actorInDoor = m; break; }
          }
        }
        let prog;
        if (actorInDoor) {
          const ax = actorInDoor.x, ay = actorInDoor.y;
          prog = Math.max(0, Math.min(1, f.ns ? (ay - cy) : (ax - cx)));
        } else if (d && d.t < 1) {
          const ease = 1 - Math.pow(1 - d.t, 2.2);
          prog = Math.max(0, Math.min(1, (d.from + (d.to - d.from) * ease) / 4));
        } else {
          prog = Math.max(0, Math.min(1, (f.state ?? (f.flipped ? 4 : 0)) / 4));
        }
        const kind = ((f.kind ?? f.d ?? 0) & 3);
        this._drawFlipDoor(ctx, cx, cy, kind, prog);
      }
    }
    if (!this.noRocks) {
      let rw = 0;
      for (let k = 0; k < this.rockCells.length; k++) {
        const i = this.rockCells[k];
        if (g.terrain[i] !== TER.ROCK) continue;
        this.rockCells[rw++] = i;
        const cx = i % W, cy = (i / W) | 0;
        const v = this.rockVar.get(i) || 0, b = this.boulders?.[v], fr = this.frames['OBSTACLE/' + (24 + v)];
        const bOk = b && fr && isDrawableOk(b);
        if (b && !bOk) this._surfacesLost = true;
        if (bOk) {
          const bx = cx * T + fr[4] * S, by = cy * T + fr[5] * S;
          ctx.globalAlpha = 0.4; ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.ellipse(bx + b.width / 2 + 3, by + b.height - 10, b.width * 0.44, b.height * 0.13, 0, 0, 7); ctx.fill();
          ctx.globalAlpha = 1; ctx.drawImage(b, bx, by);
        } else this.sprAt(ctx, 'OBSTACLE/' + (24 + v), cx, cy);
      }
      this.rockCells.length = rw;
    }
  }

  drawItems() {
    const g = this.game, ctx = this.ctx, t = this.time;
    if (!g.items.size) return;
    const useGlow = this.q?.glows !== false;
    const prevSmooth = ctx.imageSmoothingEnabled;
    const prevQual = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.q?.fastFx ? 'low' : (this.qName === 'ultra' ? 'high' : 'medium');
    for (const [i, it] of g.items) {
      const cx = i % W + 0.5, cy = ((i / W) | 0) + 0.5, rise = Math.min(1, it.age * 4);
      const bob = Math.sin(t * 3.2 + i) * 0.055 - 0.07 * rise;
      const iy = cy + bob;
      const sc = (0.62 + rise * 0.38) * (1 + Math.sin(t * 4.5 + i * 1.7) * 0.03);
      const col = PICKUP_INFO[it.name]?.color || '#ffcf5a';

      if (useGlow) {
        // Subtle ambient floor illumination pool under the floating pickup
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this.addGlow(ctx, col, cx, cy + 0.08, 0.56 * (0.75 + 0.25 * rise), (0.14 + Math.sin(t * 3.8 + i) * 0.03) * rise);
        ctx.restore();
      }

      // Ground contact shadow
      ctx.globalAlpha = 0.44 * rise;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(cx * T, (cy + 0.34) * T, Math.max(0.14, 0.26 - bob * 0.35) * T, 0.085 * T, 0, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (useGlow) {
        // Subtle backlight halo separating item contours from dark dungeon stone
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this.addGlow(ctx, col, cx, iy, 0.42 * sc, 0.10 * rise);
        this.addGlow(ctx, '#ffffff', cx, iy, 0.26 * sc, 0.05 * rise);
        ctx.restore();
      }

      // Crisp 128x128 supersampled modern pickup sprite (falls back to classic sprite if unknown)
      const spr = this.getPickupSprite(it.name);
      if (spr && isDrawableOk(spr.canvas)) {
        const sz = T * sc;
        ctx.drawImage(spr.canvas, cx * T - sz / 2, iy * T - sz / 2, sz, sz);
      } else {
        this.sprC(ctx, 'AM_PICKP/' + PICK_INDEX.indexOf(it.name), cx, iy, sc);
      }
    }
    ctx.imageSmoothingEnabled = prevSmooth;
    ctx.imageSmoothingQuality = prevQual;
  }

  drawBombs(alpha = 1) {
    const g = this.game, ctx = this.ctx, t = this.time;
    if (!g.bombs.length) return;
    const useGlow = this.q?.glows !== false;
    const prevSmooth = ctx.imageSmoothingEnabled, prevQual = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = this.q?.fastFx ? 'low' : (this.qName === 'ultra' ? 'high' : 'medium');
    for (const b of g.bombs) {
      const rx = b.rx ?? (b.x + (b.slide ? [1, 0, -1, 0][b.slide.d] * b.sp : 0));
      const ry = b.ry ?? (b.y + (b.slide ? [0, 1, 0, -1][b.slide.d] * b.sp : 0));
      const prx = b.prx ?? rx, pry = b.pry ?? ry;
      const x = prx + (rx - prx) * alpha, y = pry + (ry - pry) * alpha;
      const kind = (b.kind === 'electric' || b.kind === 'magic') ? b.kind : 'fire';
      const seed = (b.id | 0) * 1.37 + 1;
      const rem = b.fuse != null ? b.fuse : (b.t ?? 2);
      const urgent = b.vent >= 0 ? 0 : Math.max(0, Math.min(1, 1 - rem / 1.1));
      const sx = 1, sy = 1, jitX = 0;
      const fi = Math.floor((t * (TICK_HZ / 3) + seed * 2) % 6 + 6) % 6;

      if (useGlow) {
        // Ground contact shadow + flickering floor glow pool under active cauldron
        const glowCol = kind === 'electric' ? '#74bce0' : kind === 'magic' ? '#d864ff' : '#ff7418';
        const glowPulse = (0.17 + urgent * 0.14) + Math.sin(t * 22 + seed) * 0.04;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this.addGlow(ctx, glowCol, x + 0.5, y + 0.44, 0.64 + urgent * 0.18, glowPulse);
        ctx.restore();
      }

      ctx.globalAlpha = 0.42;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse((x + 0.5) * T, (y + 0.84) * T, 0.34 * T * sx, 0.105 * T, 0, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;

      const bSpr = this.getBombSprite(kind, fi);
      if (bSpr?.canvas) {
        if (sx === 1 && sy === 1 && jitX === 0) {
          ctx.drawImage(bSpr.canvas, x * T, y * T, T, T);
        } else {
          ctx.save();
          ctx.translate((x + 0.5) * T + jitX, (y + 0.86) * T);
          ctx.scale(sx, sy);
          ctx.drawImage(bSpr.canvas, -0.5 * T, -0.86 * T, T, T);
          ctx.restore();
        }
      } else {
        this.sprAt(ctx, 'AM_FIRE/' + ((kind === 'electric' ? 6 : kind === 'magic' ? 12 : 0) + fi), x, y);
      }
    }
    ctx.imageSmoothingEnabled = prevSmooth; ctx.imageSmoothingQuality = prevQual;
  }

  drawFlames(ctx = this.ctx) {
    const g = this.game;
    if (this.q?.fastFx) {
      const flames = g.flames;
      if (!flames.size) return;
      const tickSnap = Math.floor(this.time * 18);
      const sameKind = (x, y, kind) => {
        if (x < 0 || x >= W || y < 0 || y >= H) return false;
        const o = flames.get(y * W + x);
        return !!o && (o.kind || 'fire') === kind;
      };
      for (const [i, f] of flames) {
        const kind = f.kind || 'fire';
        const x = i % W, y = (i / W) | 0;
        const maxT = f.maxT || BLAST_TIMES[kind] || BLAST_TIME;
        if (kind === 'fire') {
          const mask = (sameKind(x, y - 1, kind) ? 1 : 0) | (sameKind(x + 1, y, kind) ? 2 : 0)
            | (sameKind(x, y + 1, kind) ? 4 : 0) | (sameKind(x - 1, y, kind) ? 8 : 0);
          const stage = Math.max(0, Math.min(3, Math.floor((1 - f.t / maxT) * 4)));
          this.sprAt(ctx, 'EXP_FIRE/' + (stage * 16 + mask), x, y);
        } else if (kind === 'electric') {
          const n = sameKind(x, y - 1, kind), e = sameKind(x + 1, y, kind), s = sameKind(x, y + 1, kind), w = sameKind(x - 1, y, kind);
          const variant = (n || s) && !(e || w) ? 1 : (e || w) && !(n || s) ? 2 : 0;
          const anim = (tickSnap + ((x * 3 + y * 5) & 7)) & 7;
          const fade = Math.min(1, f.t / (maxT * 0.25));
          if (fade < 0.99) ctx.globalAlpha = fade;
          this.sprAt(ctx, 'EXP_ELEC/' + (anim * 3 + variant), x, y);
          if (fade < 0.99) ctx.globalAlpha = 1;
        } else {
          const anim = (tickSnap + ((x * 7 + y * 13) % 9)) % 9;
          const fade = Math.min(1, f.t / (maxT * 0.3));
          if (fade < 0.99) ctx.globalAlpha = fade;
          this.sprAt(ctx, 'EXP_MAGI/' + anim, x, y);
          if (fade < 0.99) ctx.globalAlpha = 1;
        }
      }
      return;
    }
    let hasFire = false, hasElectric = false, hasMagic = false;
    for (const [i, f] of g.flames) {
      const kind = f.kind || 'fire';
      if (kind === 'fire') { hasFire = true; continue; }
      if (kind === 'electric') { hasElectric = true; continue; }
      if (kind === 'magic') { hasMagic = true; continue; }
      const x = i % W, y = (i / W) | 0;
      const same = (dx, dy) => { const o = g.flames.get((y + dy) * W + (x + dx)); return o && (o.kind || 'fire') === kind && x + dx >= 0 && x + dx < W; };
      const mask = (same(0, -1) ? 1 : 0) | (same(1, 0) ? 2 : 0) | (same(0, 1) ? 4 : 0) | (same(-1, 0) ? 8 : 0);
      const maxT = f.maxT || BLAST_TIMES[kind] || BLAST_TIME;
      const stage = Math.min(3, Math.floor((1 - f.t / maxT) * 4));
      this.sprAt(ctx, 'EXP_FIRE/' + (stage * 16 + mask), x, y);
    }
    if (hasFire) this._drawFireWaves(ctx);
    if (hasElectric) this._drawElectricWaves(ctx);
    if (hasMagic) this._drawMagicWaves(ctx);
  }

  drawActors(dt, alpha) {
    const g = this.game, ctx = this.ctx, L = (a, b) => a + (b - a) * alpha;
    const list = this._actorList, pool = this._actorPool || (this._actorPool = []);
    list.length = 0;
    const pushItem = (y, p, m) => {
      const idx = list.length;
      let it = pool[idx];
      if (!it) pool[idx] = it = { y: 0, p: null, m: null };
      it.y = y; it.p = p; it.m = m;
      list.push(it);
    };
    for (let pi = 0; pi < g.players.length; pi++) {
      const p = g.players[pi];
      const entering = this.portalEntries?.has(p.slot);
      if ((p.exited && !entering) || (p.out && !p.alive && !entering && (p.deadT = (p.deadT || 0) + dt) > 140 / TICK_HZ)) continue;
      if (p.alive) p.deadT = 0;
      pushItem(L(p.py, p.y), p, null);
    }
    for (let mi = 0; mi < g.monsters.length; mi++) {
      const m = g.monsters[mi];
      if (m.alive) pushItem(L(m.py, m.y), null, m);
    }
    list.sort((a, b) => a.y - b.y);
    for (let li = 0; li < list.length; li++) {
      const it = list[li];
      if (it.p) this.drawWizard(it.p, L(it.p.px, it.p.x), L(it.p.py, it.p.y), dt);
      else this.drawMonster(it.m, L(it.m.px, it.m.x), L(it.m.py, it.m.y), dt);
    }
    // dying monsters: unified thermal ember-edge dissolve and fire collapse (FRACAS.EXE 0xc8bd..0xca5c)
    let dw = 0;
    const DYING_DUR = 140 / TICK_HZ;
    for (let di = 0; di < this.dying.length; di++) {
      const d = this.dying[di];
      d.t += dt; if (!d.key) continue;
      const t = d.t;
      if (t < DYING_DUR) {
        const sc = d.boss ? 1.6 : 1;
        const fr = this.frames[d.key];
        const px = fr ? (d.x - 0.5) * T + fr[4] * S : (d.x - 0.5) * T;
        const py = fr ? (d.y - 0.5) * T + Math.min(fr[5] * S, T - fr[3]) : (d.y - 0.5) * T;
        const feetY = fr ? py + fr[3] : (d.y + 0.5) * T;
        const ffr = this.frames['WIZ0/' + (23 + (Math.floor(t * 15.5) % 5))];
        const yAdjSrc = { 4: -9, 6: -9, 7: -5, 17: -9, 18: -9, 19: -9, 20: -9 }[d.type] || 0;
        const caf5 = { 2: -5, 3: -3, 4: 5, 5: -6, 6: 5, 7: 1, 8: -3, 9: -3, 10: -3, 11: -6, 12: -5, 13: -3, 14: -3, 15: -5, 16: -6, 17: 5, 18: 5, 19: 5, 20: 5 }[d.type] ?? -3;
        const fx = ffr ? (sc === 1 ? (d.x - 0.5) * T + ffr[4] * S : d.x * T - (ffr[2] * sc) / 2 + ffr[4] * S) : 0;
        const fy = ffr ? (sc === 1
          ? (d.y - 0.5) * T + (yAdjSrc + caf5 + ffr[5] - 1) * S
          : (d.y - 0.5) * T + (yAdjSrc + caf5 + 24) * S - ffr[3] * sc) : 0;
        this._drawBurningActor(d.key, d.x, d.y, px, py, feetY, fx, fy, sc, t);
        this.dying[dw++] = d;
      }
    }
    this.dying.length = dw;
  }

  _drawBurningActor(key, wx, wy, px, py, feetY, fx, fy, sc, t) {
    const ctx = this.ctx;
    const DYING_DUR = 140 / TICK_HZ;
    if (t >= DYING_DUR) return;
    const sinkStart = 30 / TICK_HZ;
    const dp = Math.max(0, Math.min(1, (t - sinkStart) / (DYING_DUR - sinkStart)));
    const bodyAlpha = Math.max(0, 1 - Math.pow(dp, 1.15));
    const fireFade = Math.min(1, t * 9) * Math.max(0, 1 - Math.max(0, t - (DYING_DUR - 0.60)) / 0.60);
    const fr = this.frames[key];
    if (fr && bodyAlpha > 0.005) {
      ctx.save();
      ctx.globalAlpha = 0.36 * bodyAlpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(wx * T, (wy + 0.36) * T, 0.3 * sc * T, 0.3 * sc * 0.33 * T, 0, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
      const sink = dp * dp * 13 * S * sc;
      const jx = t < 0.18 ? Math.sin(t * 72 + wx * 5) * 3.0 * (1 - t / 0.18) : 0;
      if (t < 0.16) {
        ctx.globalAlpha = bodyAlpha;
        this.charSpr(ctx, key, px + jx, py, wx * T, feetY, sc);
        if (Math.sin(t * 58) > 0) {
          ctx.globalAlpha = bodyAlpha * 0.52;
          this.charSpr(ctx, key, px + jx, py, wx * T, feetY, sc, 'flash');
        }
      } else if (this.q?.fastFx) {
        ctx.globalAlpha = bodyAlpha * 0.85;
        this.charSpr(ctx, key, px, py + sink, wx * T, feetY, sc);
      } else {
        const stageF = Math.min(3.999, dp * 4);
        const s0 = 1 + Math.floor(stageF);
        const s1 = Math.min(4, s0 + 1);
        const blend = stageF - Math.floor(stageF);
        ctx.globalAlpha = bodyAlpha * (s1 > s0 ? 1 - blend * 0.5 : 1);
        this.charSpr(ctx, key, px, py + sink, wx * T, feetY, sc, `mdis${s0}`);
        if (s1 > s0 && blend > 0.02) {
          ctx.globalAlpha = bodyAlpha * blend;
          this.charSpr(ctx, key, px, py + sink, wx * T, feetY, sc, `mdis${s1}`);
        }
      }
      ctx.restore();
    }
    const ffr = this.frames['WIZ0/' + (23 + (Math.floor(t * 15.5) % 5))];
    if (ffr && fireFade > 0.01) {
      const fw = ffr[2] * sc, fh = ffr[3] * sc;
      ctx.save();
      ctx.globalAlpha = fireFade;
      ctx.drawImage(this.atlas, ffr[0], ffr[1], ffr[2], ffr[3], fx, fy, fw, fh);
      if (this.q?.glows !== false) {
        ctx.globalCompositeOperation = 'lighter';
        this.addGlow(ctx, '#ff7a20', wx, wy - 0.05, 0.85 * sc, 0.35 * fireFade);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }
    if (fireFade > 0.16 && Math.random() < 0.62) this.particles.push({ k: 'spark', x: wx + (Math.random() - 0.5) * 0.52 * sc, y: wy - Math.random() * 0.55 * sc, vx: (Math.random() - 0.5) * 0.65, vy: -1.5 - Math.random() * 1.5, t: 0, life: 0.55, s: 0.065, c: Math.random() < 0.5 ? '#ffd060' : '#ff6a10' });
    else if (t > DYING_DUR - 0.75 && Math.random() < 0.34) this.particles.push({ k: 'smoke', x: wx + (Math.random() - 0.5) * 0.32 * sc, y: wy - 0.15, vx: (Math.random() - 0.5) * 0.28, vy: -0.75 - Math.random() * 0.55, t: 0, life: 0.68, s: 0.22 * sc, c: '#38302c' });
  }

  shadow(x, y, r = 0.3) {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.38; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x * T, (y + 0.36) * T, r * T, r * 0.33 * T, 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  }

  teleportMaskVisible(e) {
    if (!e.tpPhase) return true;
    const remTicks = Math.max(0, Math.floor((e.tpTimer || 0) * 31));
    const q = 3 - Math.min(3, Math.floor(remTicks / 26));
    const mask = e.tpPhase === 'hide' ? [0, 1, 3, 7][q] : [7, 3, 1, 0][q];
    return (Math.floor(this.time * 31) & mask) === 0;
  }

  /** FRACAS.EXE 0xcbb8..0xcc4d: arcane floor seal, helical phase ribbons & shimmering prism sparkles */
  drawMagicStars(e, x, y, sc = 1) {
    const ctx = this.ctx, t = this.time, tick = Math.floor(t * 16), seed = ((e?.id | 0) + 1) * 13;
    const cx = x * T, cy = (y - 0.14 * sc) * T;
    const cols = ['#00fcfc', '#fc00fc', '#fcfc00', '#74bce0'];
    const cMain = cols[Math.floor(fxHash(tick >> 1, seed) * cols.length)];
    const cSub = cols[(cols.indexOf(cMain) + 1 + ((tick >> 1) % 3)) % cols.length];
    ctx.save();
    const tpFrac = e?.tpDur ? Math.max(0, Math.min(1, 1 - (e.tpTimer || 0) / e.tpDur)) : 0.5;
    const sealPulse = e?.tpPhase === 'hide'
      ? Math.sin(Math.min(1, tpFrac * 1.25) * Math.PI * 0.5)
      : Math.max(0.15, 1 - Math.pow(tpFrac, 1.5));
    const fy = (y + 0.34) * T, rx = 0.40 * T * sc, ry = rx * 0.38;
    // Floor dimensional seal rings
    ctx.save();
    ctx.globalAlpha = 0.72 * sealPulse;
    ctx.strokeStyle = '#00fcfc'; ctx.lineWidth = 2.0;
    ctx.beginPath(); ctx.ellipse(cx, fy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([7 * sc, 5 * sc]);
    ctx.strokeStyle = '#ec58ff'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.ellipse(cx, fy, rx * 0.78, ry * 0.78, t * 2.4, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // Two counter-twisting ascending helical phase ribbons around the body
    for (let h = 0; h < 2; h++) {
      ctx.beginPath();
      const steps = 16;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const a = t * 6.5 + seed + h * Math.PI + u * Math.PI * 2.2;
        const hx = cx + Math.cos(a) * rx * 0.72 * (1 - u * 0.25);
        const hy = fy - u * 0.96 * T * sc + Math.sin(a) * 3.5;
        if (s === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
      }
      ctx.strokeStyle = h === 0 ? `rgba(60, 245, 255, ${0.58 * sealPulse})` : `rgba(236, 88, 255, ${0.52 * sealPulse})`;
      ctx.lineWidth = 2.2 * sc;
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 0.38 * T * sc);
    g.addColorStop(0, 'rgba(252, 252, 252, 0.36)');
    g.addColorStop(0.55, 'rgba(0, 252, 252, 0.20)');
    g.addColorStop(1, 'rgba(252, 0, 252, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 0.38 * T * sc, 0, Math.PI * 2); ctx.fill();
    this._sparkleCross(ctx, cx + Math.sin(t * 11 + seed) * 3, cy + Math.cos(t * 13 + seed) * 3, 12.0 * sc, cMain, { glow: 0.42, outline: 'rgba(8, 4, 22, 0.82)' });
    this._sparkleCross(ctx, cx + Math.cos(t * 6.5 + seed) * 0.24 * T * sc, cy + Math.sin(t * 7.8 + seed) * 0.20 * T * sc, 8.2 * sc, cSub, { alpha: 0.85, glow: 0.30, outline: 'rgba(8, 4, 22, 0.78)' });
    this._glintV(ctx, cx - Math.sin(t * 5.2 + seed) * 0.22 * T * sc, cy - Math.cos(t * 6.1 + seed) * 0.16 * T * sc, 10 * sc, cols[(cols.indexOf(cSub) + 1) % cols.length]);
    ctx.restore();
  }

  /** FRACAS.EXE 0xc840..0xc85d: wizard descends smoothly into the sunken portal rift over 33 ticks */
  drawPortalSink(p, dt) {
    const g = this.game, st = this.portalEntries.get(p.slot); if (!st || !g.portal) return;
    st.t += dt;
    if (st.t >= st.dur) { this.portalEntries.delete(p.slot); return; }
    const ctx = this.ctx, k = st.t / st.dur, t = this.time;
    const cx = g.portal.x + 0.5, cy = g.portal.y + 0.5;
    const stepK = Math.min(1, k / 0.24);
    const sinkK = Math.max(0, (k - 0.16) / 0.84);
    const ease = sinkK * sinkK * (1.28 - 0.28 * sinkK);
    const gx = st.x + (cx - st.x) * stepK;
    const gy = st.y + (cy - st.y) * stepK;
    const sinkPx = ease * 0.96 * T;
    const sc = 1 - ease * 0.34;
    const frameKey = `WIZ${p.slot}/${WIZ_BASE[st.dir] + (PINGPONG[Math.floor(st.t * 14) % 8])}`;

    const cxPx = cx * T, cyPx = cy * T;
    const innerR = 0.46 * T * 0.74 + 1.5, aspect = 0.93;
    ctx.save();
    // Clip smoothly along the curved front inner rim of the sunken portal well (never flat horizontal cut)
    ctx.beginPath();
    if (sinkK <= 0.01) {
      ctx.rect(cxPx - 1.1 * T, cyPx - 2.0 * T, 2.2 * T, 2.9 * T);
    } else {
      ctx.moveTo(cxPx - 0.95 * T, cyPx - 2.0 * T);
      ctx.lineTo(cxPx + 0.95 * T, cyPx - 2.0 * T);
      ctx.lineTo(cxPx + 0.95 * T, cyPx);
      ctx.lineTo(cxPx + innerR, cyPx);
      ctx.ellipse(cxPx, cyPx, innerR, innerR * aspect, 0, 0, Math.PI, false);
      ctx.lineTo(cxPx - 0.95 * T, cyPx);
      ctx.closePath();
    }
    ctx.clip();

    const fade = Math.max(0, 1 - Math.max(0, k - 0.62) / 0.38);
    ctx.globalCompositeOperation = 'lighter';
    this.addGlow(ctx, '#48ffd4', gx, gy - 0.08 + ease * 0.38, 0.85, 0.34 * fade);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = fade;
    const bx = (gx - 0.5) * T + 4, by = (gy - 0.5) * T - 7 * S + sinkPx;
    this.charSpr(ctx, frameKey, bx, by, gx * T, (gy + 0.5) * T + sinkPx, sc);
    if (ease > 0.10) {
      ctx.globalAlpha = fade * Math.min(0.38, ease * 0.45);
      this.charSpr(ctx, frameKey, bx, by, gx * T, (gy + 0.5) * T + sinkPx, sc, 'portal');
    }
    if (sinkK > 0.02) {
      // Swirling vortex energy meniscus & rising plasma arcs wrapping across the descending wizard
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.sin(Math.min(1, sinkK) * Math.PI) * 0.85;
      ctx.strokeStyle = '#60ffe0'; ctx.lineWidth = 2.6;
      const rx = innerR * (0.94 - sinkK * 0.25);
      ctx.beginPath();
      ctx.ellipse(cxPx, cyPx - sinkK * 4, rx, rx * aspect * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      for (let a = 0; a < 2; a++) {
        const ang0 = t * 5.2 + a * Math.PI + k * 4.5;
        ctx.strokeStyle = a === 0 ? '#a8fff0' : '#40d0ff';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.ellipse(cxPx, cyPx - (0.14 + a * 0.16) * T, rx * 0.88, rx * 0.30, 0, ang0, ang0 + 1.5);
        ctx.stroke();
      }
      if (Math.random() < dt * 26 * this.q.particles) {
        const ang = Math.random() * Math.PI * 2;
        this.particles.push({
          k: 'spark',
          x: cx + Math.cos(ang) * 0.24,
          y: cy + Math.sin(ang) * 0.12 - sinkK * 0.2,
          vx: Math.cos(ang + 1.4) * 0.5,
          vy: -0.9 - Math.random() * 0.8,
          t: 0, life: 0.48, s: 0.075,
          c: Math.random() < 0.5 ? '#88ffe8' : '#ffffff',
        });
      }
    }
    ctx.restore();
  }

  _selectWizardKey(p, dt, moving, stunned) {
    p.walkT = (p.walkT || 0) + (moving ? dt * (p.sprint ? 2 : 1) : 0);
    let frame = WIZ_BASE[p.dir] + (moving ? PINGPONG[Math.floor(p.walkT * 14) % 8] : 0);
    if (stunned) frame = (Math.ceil(p.stun * TICK_HZ) & 15) > 7 ? 21 : 20; // electrocuted: 0xca93 shocked/skeleton alternation
    return `WIZ${p.slot}/${frame}`;
  }

  drawWizard(p, x, y, dt) {
    const ctx = this.ctx, t = this.time;
    if (this.portalEntries?.has(p.slot)) { this.drawPortalSink(p, dt); return; }
    const bx = (x - 0.5) * T + 4, by = (y - 0.5) * T - 7 * S;
    if (!p.alive) { this.drawDeath(p, bx, by, dt); return; }
    this.deaths.delete(p.slot);
    const moving = !p.tpPhase && (p._forceMoving ?? (Math.abs(p.x - p.px) + Math.abs(p.y - p.py) > 1e-4));
    const stunned = p.stun > 0 && !p.tpPhase;
    const sprKey = this._selectWizardKey(p, dt, moving, stunned);
    const warn = this.powerWarn?.get(p.slot) || 0;
    if (warn > 0) {
      if (warn - dt <= 0) this.powerWarn.delete(p.slot);
      else this.powerWarn.set(p.slot, warn - dt);
    }
    this.shadow(x, y, 0.26);
    if (!p.tpPhase) this._drawWizardStatusAurasBack(ctx, p, x, y, t);
    let alpha = p.ghost > 0 ? 0.4 : 1;
    if (p.radiation > 0 && p.radiation < 1.5) alpha *= 0.84 + 0.16 * Math.sin(t * 22);
    ctx.globalAlpha = alpha;
    const jx = stunned ? Math.sin(t * 80) * 2 : 0;
    if (p.tpPhase) {
      this._drawTeleportBody(ctx, p, sprKey, bx + jx, by, x * T, (y + 0.5) * T, 1, alpha);
    } else {
      this.charSpr(ctx, sprKey, bx + jx, by, x * T, (y + 0.5) * T, 1, warn > 0 ? 'flash' : null);
    }
    ctx.globalAlpha = 1;
    if (p.tpPhase) this.drawMagicStars(p, x, y, 1);
    else this._drawWizardStatusAurasFront(ctx, p, x, y, t, dt);
  }

  /** electrocution: crisp snapping vector lightning arcs crackling tightly across the shocked body */
  shockArcs(x, y) {
    this._drawBodyShock(this.ctx, x, y, Math.floor(x * 11 + y * 23), 1.0);
  }

  /** a wizard / monster frame at its usual place, shrunk by CHAR around its feet (fx, fy) */
  charSpr(ctx, key, x, y, fx, fy, sc = 1, fxMode = null) {
    const fr = this.frames[key]; if (!fr || !this.atlas) return;
    const k = CHAR * sc, [sx, sy, w, h] = fr;
    const dx = fx + (x - fx) * k + (w - w * sc) / 2 * k;
    const dy = fy + (y - fy) * k - (h * sc - h) * k;
    const dw = w * k, dh = h * k;
    const spr = fxMode ? this.getFxSprite(key, fxMode) : null;
    if (spr) ctx.drawImage(spr, 0, 0, w, h, dx, dy, dw, dh);
    else ctx.drawImage(this.atlas, sx, sy, w, h, dx, dy, dw, dh);
  }
  /** the wizard's 'hit' / reeling pose (WIZ/22) */
  hitPose(ctx, p, bx, by, fxMode = null, sc = 1) {
    this.charSpr(ctx, `WIZ${p.slot}/22`, bx, by, bx + 28, by + 92, sc, fxMode);
  }

  /** death: caught in fire -> unified thermal dissolve and fire collapse; caught by magic -> dissolves into sparkles */
  drawDeath(p, bx, by, dt) {
    const ctx = this.ctx, d = this.deaths.get(p.slot) || { t: 9, fire: true, x: p.x, y: p.y };
    d.t += dt; this.deaths.set(p.slot, d);
    const t = d.t, cx = bx + 28, feet = by + 92;
    if (d.fire) {
      const wx = cx / T, wy = (feet - 0.5 * T) / T;
      const ffr = this.frames['WIZ0/' + (23 + (Math.floor(t * 15.5) % 5))];
      const fx = ffr ? bx - 4 + ffr[4] * S : bx, fy = ffr ? by + (ffr[5] - 1) * S : by;
      this._drawBurningActor(`WIZ${p.slot}/22`, wx, wy, bx, by, feet, fx, fy, 1, t);
    } else {
      // reel back, then dissolve into team magic sparkles
      const a = Math.max(0, 1 - t / 0.70);
      if (a > 0) {
        const hx = bx + Math.sin(t * 60) * 3 * a, hy = by - (1 - a) * 18;
        ctx.save(); ctx.globalAlpha = a;
        this.hitPose(ctx, p, hx, hy);
        if (a < 0.92) { ctx.globalAlpha = a * Math.min(0.85, 1 - a); this.hitPose(ctx, p, hx, hy, 'flash'); }
        ctx.restore();
        if (Math.random() < dt * 60) this.particles.push({ k: 'spark', x: (cx + (Math.random() - .5) * 40) / T, y: (by + 20 + Math.random() * 60) / T, vx: (Math.random() - .5) * 1.2, vy: -1 - Math.random(), t: 0, life: 0.8, s: 0.09, c: TEAM[p.slot].light });
      }
    }
  }

  drawMonster(m, x, y, dt) {
    const g = this.game, ctx = this.ctx, t = this.time, A = this.mons?.[m.type] || this.mons?.[3];
    if (!A) return;
    const d = ANIM_DIR[m.dir] ?? 3;
    let st = this.monState.get(m.id);
    if (!st) { st = { i: 0, acc: 0, key: null }; this.monState.set(m.id, st); }
    if (m.moving && m.stun <= 0 && !m.tpPhase) { st.acc += dt * 30; while (st.acc >= 1) { st.acc--; st.i++; } }
    let fi;
    if (m.zapped > 0 && !m.tpPhase && A.zap) fi = (Math.ceil(m.zapped * TICK_HZ) & 15) > 7 ? A.zap[d] : A.stun?.[d];
    else if (m.stun > 0 && !m.tpPhase && A.stun) fi = A.stun[d];
    else { const seq = A.seqs?.[d]; if (!seq?.length) return; fi = seq[st.i % seq.length]; }
    if (fi == null) return;
    const key = `${A.file}/${fi}`; st.key = key; st.type = m.type;
    const fr = this.frames[key]; if (!fr) return;
    const sc = m.boss ? 1.6 : 1;
    const px = (x - 0.5) * T + fr[4] * S + (m.zapped > 0 && !m.tpPhase ? Math.sin(t * 90) * 3 : 0);
    const py = (y - 0.5) * T + Math.min(fr[5] * S, T - fr[3]);
    st.feet = py + fr[3];
    this.shadow(x, y, 0.3 * sc);
    if (m.boss) this.addGlow(ctx, m.info?.accent || '#ff4060', x, y, 1.1, 0.35 + Math.sin(t * 4) * 0.1);
    const fxMode = (m.flash > 0 && Math.sin(t * 40) > 0) ? 'flash' : (g.stasis > 0 ? 'stasis' : null);
    if (m.tpPhase) {
      this._drawTeleportBody(ctx, m, key, px, py, x * T, py + fr[3], sc, 1);
    } else {
      this.charSpr(ctx, key, px, py, x * T, py + fr[3], sc, fxMode);
    }
    if (m.tpPhase) this.drawMagicStars(m, x, y, sc);
    if (m.boss) {        // health pips
      for (let k = 0; k < m.maxHp; k++) {
        ctx.fillStyle = k < m.hp ? '#ff3a5a' : 'rgba(255,255,255,0.25)';
        ctx.fillRect((x - 0.35 + k * 0.25) * T, (y - 1.35) * T, 0.2 * T, 0.08 * T);
      }
    }
  }

  /** Inferno-jar wind zones: a pale air current streaming outward along each arm */
  /** top (and optional bottom for 3-4 players) dashboard: power icon, score, cauldrons/range, lives per player; level number; logo */
  drawHud() {
    const g = this.game, ctx = this.ctx, BH = WW * 18 / 320, bars = this.bars || 1;
    const F_DISP = "'Space Grotesk', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
    const F_UI = "'Plus Jakarta Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
    const F_MONO = "'JetBrains Mono', 'Cascadia Code', ui-monospace, Consolas, monospace";
    const POWER_ICON = { stoneWind: 1, stoneTeleport: 3, stoneElectric: 4, stoneFire: 6, glassWind: 7, glassTeleport: 9,
                         glassElectric: 10, glassFire: 11, foot: 12, ignitor: 13, orb: 'orb' };
    const rr = (c, x, y, w, h, r) => { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); };
    const setSp = (c, px) => { if ('letterSpacing' in c) c.letterSpacing = px; };
    const barY = [-BH - 6, WH + 6], SEC = WW * 0.36;
    const logoReady = this.logo?.complete && this.logo.naturalWidth ? 1 : 0;
    const hudLvl = this.hudLevel ?? g.level.id ?? 1;
    const worldLabel = (g.mode === 'battle' ? (g.level?.name || 'Battle Arena') : (g.level?.world || 'Stone Halls')).toUpperCase();
    let sig = `${bars}|${hudLvl}|${g.mode}|${worldLabel}|${logoReady}`;
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      const out = (p.out && !p.exited) || (g.mode !== 'battle' && p.lives <= 0 && !p.alive);
      sig += `;${p.slot},${out ? 1 : 0},${p.exited ? 1 : 0},${p.power || ''},${p.radiation > 0 ? 1 : 0},${p.score},${p.bombsMax},${p.range},${p.lives},${p.wins}`;
    }
    if (sig !== this._hudSig) {
      this._hudSig = sig;
      const useShadow = !this.q?.fastFx;
      const bw = WW + 4, bh = Math.ceil(BH) + 4;
      for (let b = 0; b < bars; b++) {
        if (!this._hudBars[b] || !this._hudBars[b].ctx || this._hudBars[b].ctx.isContextLost?.()) {
          if (this._hudBars[b]?.url) { try { URL.revokeObjectURL(this._hudBars[b].url); } catch {} }
          const [cv, hctx] = this._mkCanvas(bw, bh);
          this._hudBars[b] = { canvas: cv, ctx: hctx, img: null, url: null, gen: 0 };
        }
        const bar = this._hudBars[b], cv = bar.canvas, hctx = bar.ctx;
        if (!hctx) continue;
        bar.img = null;
        const barGen = ++bar.gen;
        hctx.setTransform(1, 0, 0, 1, 0, 0);
        hctx.clearRect(0, 0, cv.width, cv.height);
        hctx.save();
        hctx.translate(2, 2);
        hctx.textBaseline = 'middle';
        rr(hctx, 0, 0, WW, BH, 14);
        const gr = hctx.createLinearGradient(0, 0, 0, BH); gr.addColorStop(0, '#141926'); gr.addColorStop(1, '#090c14');
        hctx.fillStyle = gr; hctx.fill(); hctx.strokeStyle = 'rgba(255,255,255,0.14)'; hctx.lineWidth = 2; hctx.stroke();
        rr(hctx, 4, 3, WW - 8, BH / 2 - 4, 10); hctx.fillStyle = 'rgba(255,255,255,0.03)'; hctx.fill();
        for (const x of [SEC, SEC * 2]) { hctx.fillStyle = 'rgba(255,255,255,0.12)'; hctx.fillRect(x, 12, 2, BH - 24); }

        // Unused player slot (solo 1-player mode or 3-player bottom bar): show clean world/mode badge instead of ghost PLAYER N
        for (let side = 0; side < 2; side++) {
          const p = g.players[b * 2 + side];
          if (p) continue;
          const cx = side * SEC + SEC / 2;
          hctx.textAlign = 'center';
          hctx.font = `700 ${BH * 0.16}px ${F_UI}`; setSp(hctx, '2.2px');
          hctx.fillStyle = 'rgba(94, 234, 212, 0.72)';
          hctx.fillText(g.mode === 'battle' ? 'BATTLE ARENA' : 'STORY CAMPAIGN', cx, BH * 0.34);
          hctx.font = `700 ${BH * 0.24}px ${F_DISP}`; setSp(hctx, '1.6px');
          hctx.fillStyle = 'rgba(226, 232, 240, 0.58)';
          hctx.fillText(worldLabel, cx, BH * 0.66, SEC - 36);
          setSp(hctx, '0px');
        }

        // Right info panel: Level/Round + Fracas logo on top bar; squad summary on bottom bar (3-4 players)
        const ix = SEC * 2;
        const battle = g.mode === 'battle';
        if (b === 0) {
          hctx.textAlign = 'left'; hctx.font = `700 ${BH * 0.17}px ${F_UI}`; hctx.fillStyle = 'rgba(152,164,190,0.8)';
          setSp(hctx, '2.5px');
          hctx.fillText(battle ? 'ROUND' : 'LEVEL', ix + 22, BH * 0.28);
          setSp(hctx, '1px');
          hctx.font = `700 ${BH * 0.44}px ${F_MONO}`; hctx.fillStyle = '#f8fafc';
          if (useShadow) { hctx.shadowColor = 'rgba(255,120,40,0.5)'; hctx.shadowBlur = 12; }
          hctx.fillText(String(hudLvl).padStart(3, '0').slice(-3), ix + 20, BH * 0.66);
          hctx.shadowBlur = 0; setSp(hctx, '0px');
          if (logoReady) {
            const lh = BH * 0.78, lw = lh * this.logo.naturalWidth / this.logo.naturalHeight;
            if (useShadow) { hctx.shadowColor = 'rgba(255,80,20,0.45)'; hctx.shadowBlur = 14; }
            hctx.drawImage(this.logo, WW - lw - 18, (BH - lh) / 2, lw, lh); hctx.shadowBlur = 0;
          }
        } else {
          hctx.textAlign = 'left'; hctx.font = `700 ${BH * 0.17}px ${F_UI}`; hctx.fillStyle = 'rgba(152,164,190,0.8)';
          setSp(hctx, '2.2px');
          hctx.fillText(battle ? 'ARENA' : 'WORLD', ix + 22, BH * 0.28);
          setSp(hctx, '0.8px');
          hctx.font = `700 ${BH * 0.28}px ${F_DISP}`; hctx.fillStyle = '#f8fafc';
          hctx.fillText(worldLabel, ix + 22, BH * 0.66, (WW - ix) - 110);
          hctx.textAlign = 'right'; hctx.font = `700 ${BH * 0.28}px ${F_MONO}`; hctx.fillStyle = '#5eead4';
          hctx.fillText(`${g.players.length}P`, WW - 22, BH * 0.54);
          setSp(hctx, '0px');
        }

        for (let side = 0; side < 2; side++) {
          const p = g.players[b * 2 + side];
          if (!p) continue;
          const x0 = side * SEC, tm = TEAM[p.slot] || TEAM[0];
          const out = (p.out && !p.exited) || (g.mode !== 'battle' && p.lives <= 0 && !p.alive);
          hctx.globalAlpha = out ? 0.4 : 1;
          // power slot frame & icon
          const S = BH - 18, sx = x0 + 14, sy = 9;
          rr(hctx, sx, sy, S, S, 10); hctx.fillStyle = 'rgba(0,0,0,0.48)'; hctx.fill();
          hctx.strokeStyle = tm.color; hctx.lineWidth = 2; hctx.stroke();
          const iconName = (p.power && POWER_ICON[p.power]) ? p.power : (p.radiation > 0 ? 'radiation' : null);
          if (iconName) {
            const icoCol = PICKUP_INFO[iconName]?.color || '#ffcf5a';
            const ig = hctx.createRadialGradient(sx + S / 2, sy + S / 2, 2, sx + S / 2, sy + S / 2, S * 0.58);
            ig.addColorStop(0, icoCol.length === 7 ? icoCol + '48' : 'rgba(255,207,90,0.28)');
            ig.addColorStop(1, 'rgba(0,0,0,0)');
            hctx.fillStyle = ig;
            rr(hctx, sx + 2, sy + 2, S - 4, S - 4, 8); hctx.fill();
            const spr = this.getPickupSprite(iconName);
            if (spr && isDrawableOk(spr.canvas)) {
              const prevSm = hctx.imageSmoothingEnabled;
              hctx.imageSmoothingEnabled = true;
              hctx.drawImage(spr.canvas, sx + 3, sy + 3, S - 6, S - 6);
              hctx.imageSmoothingEnabled = prevSm;
            } else {
              const code = p.power ? (POWER_ICON[p.power] ?? 0) : p.radiation > 0 ? 14 : 0;
              const f = code === 'orb' ? this.frames['AM_PICKP/7'] : this.frames['PKUP_ICO/' + code];
              if (f) { const k = Math.min((S - 12) / f[2], (S - 12) / f[3]); hctx.drawImage(this.atlas, f[0], f[1], f[2], f[3], sx + (S - f[2] * k) / 2, sy + (S - f[3] * k) / 2, f[2] * k, f[3] * k); }
            }
          }
          // score: bright tabular digits, dim leading zeros
          const score = String(Math.min(999999, p.score)).padStart(6, '0'), lead = score.match(/^0*/)[0].length;
          const scx = sx + S + 18, fs = BH * 0.44;
          hctx.font = `700 ${fs}px ${F_MONO}`; hctx.textAlign = 'left';
          hctx.fillStyle = 'rgba(255,255,255,0.14)'; hctx.fillText(score.slice(0, Math.min(lead, 5)), scx, BH * 0.41);
          const dw = hctx.measureText(score.slice(0, Math.min(lead, 5))).width;
          hctx.fillStyle = tm.light;
          if (useShadow) { hctx.shadowColor = tm.color; hctx.shadowBlur = 10; }
          hctx.fillText(score.slice(Math.min(lead, 5)), scx + dw, BH * 0.41); hctx.shadowBlur = 0;
          hctx.font = `700 ${BH * 0.16}px ${F_UI}`; hctx.fillStyle = p.exited ? '#5eead4' : 'rgba(152,164,190,0.85)';
          setSp(hctx, '2px'); hctx.fillText(p.exited ? tm.name.toUpperCase() + ' · SAFE' : `${tm.name.toUpperCase()} · P${p.slot + 1}`, scx + 2, BH * 0.78); setSp(hctx, '0px');
          // cauldrons (green) and blast range (purple) as 5 pips each
          const px = x0 + SEC * 0.62, pw = SEC * 0.033, ph = BH * 0.16, gap = pw * 0.45;
          const pips = (y, n, on, icon) => {
            hctx.fillStyle = 'rgba(152,164,190,0.8)'; hctx.font = `700 ${BH * 0.16}px ${F_UI}`; hctx.textAlign = 'right'; hctx.fillText(icon, px - 6, y + ph / 2 + 1);
            for (let i = 0; i < 5; i++) { rr(hctx, px + i * (pw + gap), y, pw, ph, 3); hctx.fillStyle = i < n ? on : 'rgba(255,255,255,0.09)'; hctx.fill(); }
          };
          pips(BH * 0.24, Math.min(5, p.bombsMax), '#48e070', 'POTS');
          pips(BH * 0.58, Math.min(5, p.range), '#b070ff', 'RANGE');
          // lives (hearts) or battle wins (stars)
          const lx = x0 + SEC - 16; hctx.textAlign = 'right';
          if (battle) { hctx.font = `700 ${BH * 0.34}px ${F_MONO}`; hctx.fillStyle = '#ffcf5a'; hctx.fillText('★ ' + p.wins, lx, BH / 2); }
          else {
            const n = Math.max(0, p.lives); hctx.font = `700 ${BH * 0.34}px ${F_MONO}`;
            hctx.fillStyle = '#f8fafc'; hctx.fillText(String(n), lx, BH / 2 + 1);
            const w = hctx.measureText(String(n)).width; hctx.fillStyle = '#ff5c77';
            if (useShadow) { hctx.shadowColor = '#ff2040'; hctx.shadowBlur = 10; }
            hctx.fillText('♥', lx - w - 6, BH / 2); hctx.shadowBlur = 0;
          }
          hctx.globalAlpha = 1;
        }
        hctx.restore();
      }
    }
    for (let b = 0; b < bars; b++) {
      const bar = this._hudBars[b];
      const cv = isDrawableOk(bar?.img) ? bar.img : (isDrawableOk(bar?.canvas) ? bar.canvas : null);
      if (cv) ctx.drawImage(cv, -2, barY[b] - 2);
    }
    for (let pi = 0; pi < g.players.length; pi++) {
      const p = g.players[pi];
      if (!p.power || !POWER_ICON[p.power] || !p.powerMax) continue;
      const out = (p.out && !p.exited) || (g.mode !== 'battle' && p.lives <= 0 && !p.alive);
      const side = pi & 1, by = barY[pi >> 1], x0 = side * SEC, tm = TEAM[p.slot] || TEAM[0];
      const S = BH - 18, sx = x0 + 14, sy = by + 9;
      const fr = Math.max(0, p.powerTime / p.powerMax), low = p.powerTime < 300 / 31;
      ctx.globalAlpha = out ? 0.4 : 1;
      ctx.strokeStyle = low && Math.floor(this.time * 6) % 2 ? '#ff5040' : tm.light; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(sx + S / 2, sy + S / 2, S / 2 + 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fr); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (g.stasis > 0) {
      // Dock cleanly on the top perimeter wall strip so Player 2's HUD bar is never occluded
      const pw = 290, ph = 36, px = WW / 2 - pw / 2, py = 12, frac = Math.max(0, Math.min(1, g.stasis / 7.0));
      ctx.save(); ctx.textBaseline = 'middle';
      rr(ctx, px, py, pw, ph, 18);
      ctx.fillStyle = 'rgba(11, 14, 22, 0.88)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.72)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = `700 17px ${F_MONO}`; ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(80, 48, 0, 0.85)';
      ctx.strokeText(`CHRONO STASIS ${g.stasis.toFixed(1)}s`, WW / 2, py + 15);
      ctx.fillStyle = '#ffe040';
      ctx.fillText(`CHRONO STASIS ${g.stasis.toFixed(1)}s`, WW / 2, py + 15);
      rr(ctx, px + 20, py + ph - 8, pw - 40, 3, 1.5); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
      if (frac > 0) { rr(ctx, px + 20, py + ph - 8, (pw - 40) * frac, 3, 1.5); ctx.fillStyle = '#ffe040'; ctx.fill(); }
      ctx.restore();
    }
  }

  /** 'GET READY' while the level is frozen at the start, like the original */
  drawGetReady() {
    const g = this.game; if (!(g.freeze > 0) || !g.players.length) return;
    const ctx = this.ctx, a = Math.min(1, g.freeze * 3);
    ctx.save(); ctx.globalAlpha = a;
    ctx.font = `700 ${T * 1.45}px 'Space Grotesk', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
    ctx.lineJoin = 'round'; ctx.lineWidth = T * 0.24; ctx.strokeStyle = '#0a0d16'; ctx.strokeText('GET READY', WW / 2, WH / 2);
    const gr = ctx.createLinearGradient(0, WH / 2 - T, 0, WH / 2 + T);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.55, '#ffd89b'); gr.addColorStop(1, '#ff9a3c');
    ctx.fillStyle = gr; ctx.fillText('GET READY', WW / 2, WH / 2);
    ctx.restore();
  }

  /** Layout geometry (in 1344x960 board space) for the modern glassmorphic Life Exchange overlay */
  lifeExchangeLayout() {
    const lx = this.lifeEx, g = this.game;
    if (!lx || !g) return null;
    const multi = g.players.length > 2;
    if (!multi) {
      const bw = 604, bh = 344, bx = (WW - bw) / 2, by = (WH - bh) / 2;
      const podW = 192, podH = 148, podY = by + 106;
      const leftPod = { kind: 'leftWiz', x: bx + 28, y: podY, w: podW, h: podH };
      const rightPod = { kind: 'rightWiz', x: bx + bw - 28 - podW, y: podY, w: podW, h: podH };
      const midY = podY + podH / 2 - 28;
      const leftArrow = { kind: 'leftArrow', x: WW / 2 - 60, y: midY, w: 54, h: 56 };
      const rightArrow = { kind: 'rightArrow', x: WW / 2 + 6, y: midY, w: 54, h: 56 };
      const confirm = { kind: 'confirm', x: WW / 2 - 156, y: by + bh - 62, w: 312, h: 44 };
      return { multi: false, bx, by, bw, bh, box: { x: bx, y: by, w: bw, h: bh }, leftWiz: leftPod, rightWiz: rightPod, leftArrow, rightArrow, tabs: [], pods: [], shareAll: null, confirm };
    }

    const n = g.players.length;
    const podW = 190, podH = 228, gap = 16, padX = 28;
    const bw = n * podW + (n - 1) * gap + padX * 2, bh = 430;
    const bx = (WW - bw) / 2, by = (WH - bh) / 2;
    const podY = by + 104, startX = bx + padX;
    const pods = g.players.map((p, idx) => {
      const x = startX + idx * (podW + gap);
      const btnY = podY + podH - 42, btnH = 30;
      return {
        slot: p.slot,
        rect: { kind: 'pod', slot: p.slot, x, y: podY, w: podW, h: podH },
        takeBtn: { kind: 'takeFrom', slot: p.slot, x: x + 14, y: btnY, w: 54, h: btnH },
        giveBtn: { kind: 'giveTo', slot: p.slot, x: x + 76, y: btnY, w: podW - 90, h: btnH },
      };
    });
    const canShareAll = g.players.some(p => p.lives <= 0) && g.players.some(p => p.lives > 1);
    const ctaY = by + bh - 64, ctaH = 44;
    const shareAll = canShareAll ? { kind: 'shareAll', x: bx + padX, y: ctaY, w: (bw - padX * 2 - 16) / 2, h: ctaH } : null;
    const confirm = shareAll
      ? { kind: 'confirm', x: shareAll.x + shareAll.w + 16, y: ctaY, w: shareAll.w, h: ctaH }
      : { kind: 'confirm', x: WW / 2 - 170, y: ctaY, w: 340, h: ctaH };
    return { multi: true, bx, by, bw, bh, box: { x: bx, y: by, w: bw, h: bh }, pods, shareAll, confirm, tabs: [] };
  }

  /** Hit-test client coordinates against the active Life Exchange overlay */
  lifeExchangeHit(clientX, clientY) {
    const lay = this.lifeExchangeLayout();
    if (!lay || !this.scale) return null;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const wx = ((clientX - r.left) * (this.canvas.width / r.width) - this.ox) / this.scale;
    const wy = ((clientY - r.top) * (this.canvas.height / r.height) - this.oy) / this.scale;
    const inBox = (b, pad = 4) => b && wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad;
    if (!lay.multi) {
      if (inBox(lay.leftArrow, 6)) return { kind: 'leftArrow' };
      if (inBox(lay.rightArrow, 6)) return { kind: 'rightArrow' };
      if (inBox(lay.confirm, 4)) return { kind: 'confirm' };
      return null;
    }
    if (lay.shareAll && inBox(lay.shareAll, 4)) return { kind: 'shareAll' };
    if (inBox(lay.confirm, 4)) return { kind: 'confirm' };
    for (const item of lay.pods) {
      if (inBox(item.giveBtn, 3)) return { kind: 'giveTo', slot: item.slot };
      if (inBox(item.takeBtn, 3)) return { kind: 'takeFrom', slot: item.slot };
      if (inBox(item.rect, 2)) return { kind: 'tab', slot: item.slot };
    }
    return null;
  }

  /** Sleek dark-glass LIFE EXCHANGE overlay supporting both 2P transfer and 3-4P all-player sharing */
  drawLifeExchange() {
    const lx = this.lifeEx, lay = this.lifeExchangeLayout(), g = this.game;
    if (!lx || !lay) return;
    const ctx = this.ctx, { bx, by, bw, bh } = lay;
    const F_DISP = "'Space Grotesk', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
    const F_UI = "'Plus Jakarta Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
    const F_MONO = "'JetBrains Mono', 'Cascadia Code', ui-monospace, Consolas, monospace";
    const rr = (x, y, w, h, rad) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, rad) : ctx.rect(x, y, w, h); };
    const setSp = px => { if ('letterSpacing' in ctx) ctx.letterSpacing = px; };

    ctx.save();
    // Soft ambient backdrop dim spotlighting the card over the frozen dungeon board
    const bgWash = ctx.createRadialGradient(WW / 2, WH / 2, 120, WW / 2, WH / 2, WW * 0.6);
    bgWash.addColorStop(0, 'rgba(6, 9, 18, 0.42)');
    bgWash.addColorStop(1, 'rgba(4, 6, 12, 0.72)');
    ctx.fillStyle = bgWash;
    ctx.fillRect(0, 0, WW, WH);

    // Outer orange aura + frosted dark-glass container
    ctx.shadowColor = 'rgba(255, 110, 40, 0.16)'; ctx.shadowBlur = 48;
    rr(bx, by, bw, bh, 22);
    const panel = ctx.createLinearGradient(0, by, 0, by + bh);
    panel.addColorStop(0, 'rgba(22, 28, 46, 0.94)');
    panel.addColorStop(1, 'rgba(10, 13, 24, 0.97)');
    ctx.fillStyle = panel; ctx.fill();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.78)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14;
    ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)'; ctx.lineWidth = 1.5; ctx.stroke();

    // Top specular accent hairline
    rr(bx + 18, by + 1, bw - 36, 2, 1);
    const topLine = ctx.createLinearGradient(bx + 18, 0, bx + bw - 18, 0);
    topLine.addColorStop(0, 'rgba(255, 255, 255, 0)');
    topLine.addColorStop(0.5, 'rgba(255, 210, 160, 0.42)');
    topLine.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = topLine; ctx.fill();

    // Heading + divider hairlines + subtitle
    const hy = by + 40;
    ctx.font = `700 26px ${F_DISP}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; setSp('3px');
    const titleGrad = ctx.createLinearGradient(0, hy - 14, 0, hy + 14);
    titleGrad.addColorStop(0, '#ffffff'); titleGrad.addColorStop(0.55, '#ffd89b'); titleGrad.addColorStop(1, '#ff9a3c');
    ctx.fillStyle = titleGrad;
    ctx.shadowColor = 'rgba(255, 120, 40, 0.35)'; ctx.shadowBlur = 14;
    ctx.fillText('LIFE EXCHANGE', WW / 2, hy); ctx.shadowBlur = 0; setSp('0px');

    const tw = ctx.measureText('LIFE EXCHANGE').width + 44;
    const divL = ctx.createLinearGradient(bx + 28, 0, WW / 2 - tw / 2, 0);
    divL.addColorStop(0, 'rgba(255, 168, 92, 0)'); divL.addColorStop(1, 'rgba(255, 168, 92, 0.52)');
    ctx.fillStyle = divL; ctx.fillRect(bx + 28, hy - 1, Math.max(20, (WW / 2 - tw / 2) - (bx + 28)), 1.5);
    const divR = ctx.createLinearGradient(bx + bw - 28, 0, WW / 2 + tw / 2, 0);
    divR.addColorStop(0, 'rgba(255, 168, 92, 0)'); divR.addColorStop(1, 'rgba(255, 168, 92, 0.52)');
    ctx.fillStyle = divR; ctx.fillRect(WW / 2 + tw / 2, hy - 1, Math.max(20, (bx + bw - 28) - (WW / 2 + tw / 2)), 1.5);

    ctx.font = `500 13.5px ${F_UI}`; ctx.fillStyle = '#98a4be';
    ctx.fillText(
      lay.multi
        ? 'Share spare hearts with any fallen wizard (or all at once) — donors always keep at least 1 ♥'
        : 'Share hearts for the next level — donors always keep at least 1 ♥',
      WW / 2, by + 72
    );

    // Track live transfer & celebratory portrait state across frames
    const anim = this._lxAnim || (this._lxAnim = { lastTime: this.time, prevFL: 0, prevFR: 0, lastSeq: 0, hearts: [], castBySlot: new Map() });
    const nowT = this.time;
    const dtLx = Math.min(0.05, Math.max(0, nowT - (anim.lastTime ?? nowT)));
    anim.lastTime = nowT;
    const spawnTransfer = (fromRect, toRect, recSlot, col) => {
      if (!fromRect || !toRect) return;
      anim.hearts.push({
        x0: fromRect.x + fromRect.w / 2, y0: fromRect.y + fromRect.h / 2 - 8,
        x1: toRect.x + toRect.w / 2, y1: toRect.y + toRect.h / 2 - 8,
        t: 0, dur: 0.44, col,
      });
      anim.castBySlot.set(recSlot, 0.44);
    };

    if (!lay.multi) {
      const leftP = g.players.find(p => p.slot === lx.leftSlot), rightP = g.players.find(p => p.slot === lx.rightSlot);
      if (!leftP || !rightP) { ctx.restore(); return; }
      if ((lx.flashL || 0) > anim.prevFL + 0.02) spawnTransfer(lay.rightWiz, lay.leftWiz, leftP.slot, TEAM[leftP.slot].light);
      if ((lx.flashR || 0) > anim.prevFR + 0.02) spawnTransfer(lay.leftWiz, lay.rightWiz, rightP.slot, TEAM[rightP.slot].light);
      anim.prevFL = lx.flashL || 0;
      anim.prevFR = lx.flashR || 0;
      for (const [s, v] of anim.castBySlot) {
        if (v - dtLx <= 0) anim.castBySlot.delete(s); else anim.castBySlot.set(s, v - dtLx);
      }

      const drawPod = (p, rect, side, mirror) => {
        const tm = TEAM[p.slot], out = p.lives <= 0;
        const reviveT = anim.castBySlot.get(p.slot) || 0;
        ctx.save();
        rr(rect.x, rect.y, rect.w, rect.h, 16);
        const podBg = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
        podBg.addColorStop(0, out ? 'rgba(14, 17, 28, 0.72)' : 'rgba(22, 29, 48, 0.85)');
        podBg.addColorStop(1, 'rgba(9, 12, 22, 0.90)');
        ctx.fillStyle = podBg; ctx.fill();
        ctx.strokeStyle = reviveT > 0 ? '#ff84a0' : out ? 'rgba(255, 255, 255, 0.10)' : tm.color;
        ctx.globalAlpha = out ? 0.88 : 1;
        ctx.lineWidth = reviveT > 0 ? 2 : 1.5; ctx.stroke();

        ctx.globalAlpha = out ? 0.35 : 0.9;
        ctx.fillStyle = tm.color;
        rr(rect.x + 18, rect.y + 1, rect.w - 36, 3, 2); ctx.fill();

        const fr = this.frames['WIZ' + p.slot + '/0'];
        const wh = 82, ww = fr ? wh * (fr[2] / fr[3]) : 50;
        const wx = mirror ? rect.x + rect.w - 22 - ww : rect.x + 22;
        const wy = rect.y + (rect.h - wh) / 2 + 4;
        const aura = ctx.createRadialGradient(wx + ww / 2, wy + wh / 2, 2, wx + ww / 2, wy + wh / 2, 54);
        aura.addColorStop(0, tm.color + (out ? '26' : '55'));
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 1; ctx.fillStyle = aura;
        ctx.fillRect(wx - 24, wy - 16, ww + 48, wh + 32);
        if (fr) {
          ctx.globalAlpha = out ? 0.42 : 1;
          ctx.drawImage(this.atlas, fr[0], fr[1], fr[2], fr[3], wx, wy, ww, wh);
        }

        ctx.globalAlpha = 1;
        const tx = mirror ? rect.x + 20 : rect.x + rect.w - 20;
        const textMaxW = rect.w - 94;
        ctx.textAlign = mirror ? 'left' : 'right';
        ctx.font = `700 11.5px ${F_DISP}`; setSp('1.8px'); ctx.fillStyle = tm.light;
        ctx.fillText(tm.name.toUpperCase(), tx, rect.y + 30, textMaxW); setSp('0px');

        const lifeY = rect.y + 76;
        if (out) {
          ctx.font = `700 28px ${F_MONO}`; ctx.fillStyle = 'rgba(255, 92, 119, 0.72)';
          ctx.fillText('0', tx, lifeY);
          ctx.font = `700 10px ${F_DISP}`; setSp('1.2px'); ctx.fillStyle = '#ff6b81';
          ctx.fillText('FALLEN · NEXT LV', tx, rect.y + 114, textMaxW); setSp('0px');
        } else {
          const s = String(p.lives);
          ctx.font = `700 36px ${F_MONO}`; ctx.fillStyle = '#f8fafc';
          ctx.shadowColor = tm.color; ctx.shadowBlur = 10;
          ctx.fillText(s, tx, lifeY); ctx.shadowBlur = 0;
          const nw = ctx.measureText(s).width;
          ctx.font = `700 22px ${F_UI}`; ctx.fillStyle = '#ff5c77';
          ctx.shadowColor = 'rgba(255, 50, 90, 0.55)'; ctx.shadowBlur = 10;
          const hx = mirror ? tx + nw + 10 : tx - nw - 10;
          ctx.fillText('♥', hx, lifeY + 1); ctx.shadowBlur = 0;

          const show = Math.min(5, p.lives);
          const pips = '♥ '.repeat(show).trim() + (p.lives > 5 ? ` +${p.lives - 5}` : '');
          ctx.font = `600 13px ${F_UI}`; ctx.fillStyle = '#ff7b93';
          ctx.fillText(pips, tx, rect.y + 114, textMaxW);
        }
        ctx.restore();
      };
      drawPod(leftP, lay.leftWiz, 'leftWiz', false);
      drawPod(rightP, lay.rightWiz, 'rightWiz', true);

      const drawTransferBtn = (rect, enabled, hovered, flash, dirSign) => {
        ctx.save();
        const bump = flash > 0 ? Math.sin(Math.min(1, flash / 0.16) * Math.PI) * 5 * dirSign : 0;
        const sc = enabled && (flash > 0 ? 1.08 : hovered ? 1.05 : 1);
        const cx = rect.x + rect.w / 2 + bump, cy = rect.y + rect.h / 2;
        ctx.translate(cx, cy); ctx.scale(sc, sc);
        ctx.globalAlpha = enabled ? 1 : 0.28;
        rr(-rect.w / 2, -rect.h / 2, rect.w, rect.h, 15);
        if (enabled && (hovered || flash > 0)) {
          ctx.shadowColor = flash > 0 ? 'rgba(255, 207, 90, 0.55)' : 'rgba(94, 234, 212, 0.40)';
          ctx.shadowBlur = 18;
        }
        const bg = ctx.createLinearGradient(0, -rect.h / 2, 0, rect.h / 2);
        if (flash > 0) { bg.addColorStop(0, 'rgba(255, 196, 86, 0.45)'); bg.addColorStop(1, 'rgba(242, 92, 28, 0.35)'); }
        else if (hovered && enabled) { bg.addColorStop(0, 'rgba(56, 108, 128, 0.92)'); bg.addColorStop(1, 'rgba(28, 56, 76, 0.96)'); }
        else { bg.addColorStop(0, 'rgba(30, 42, 66, 0.90)'); bg.addColorStop(1, 'rgba(16, 22, 38, 0.94)'); }
        ctx.fillStyle = bg; ctx.fill(); ctx.shadowBlur = 0;
        ctx.strokeStyle = flash > 0 ? '#ffd880' : (enabled && hovered) ? '#5eead4' : enabled ? 'rgba(130, 210, 235, 0.45)' : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1.5; ctx.stroke();

        ctx.strokeStyle = flash > 0 ? '#fff9e6' : enabled ? '#e6fbff' : '#94a3b8';
        ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        const s = dirSign;
        ctx.moveTo(-s * 10, 0); ctx.lineTo(s * 10, 0);
        ctx.moveTo(s * 2, -8); ctx.lineTo(s * 10, 0); ctx.lineTo(s * 2, 8);
        ctx.stroke();
        ctx.restore();
      };
      drawTransferBtn(lay.leftArrow, rightP.lives > 1, lx.hover === 'leftArrow', lx.flashL || 0, -1);
      drawTransferBtn(lay.rightArrow, leftP.lives > 1, lx.hover === 'rightArrow', lx.flashR || 0, 1);

      ctx.font = `700 10.5px ${F_DISP}`; ctx.textAlign = 'center'; setSp('1.6px');
      ctx.fillStyle = 'rgba(152, 164, 190, 0.78)';
      ctx.fillText('TRANSFER 1 ♥', WW / 2, lay.leftArrow.y + lay.leftArrow.h + 20);
      setSp('0px');
    } else {
      // Multi-player (3 or 4 players): show ALL players side-by-side with direct +1 / -1 buttons + Revive All Fallen button
      const podBySlot = new Map(lay.pods.map(item => [item.slot, item.rect]));
      if (Array.isArray(lx.transfers)) {
        for (const tr of lx.transfers) {
          if (tr.seq > anim.lastSeq) {
            anim.lastSeq = tr.seq;
            spawnTransfer(podBySlot.get(tr.from), podBySlot.get(tr.to), tr.to, (TEAM[tr.to] || TEAM[0]).light);
          }
        }
      }
      for (const [s, v] of anim.castBySlot) {
        if (v - dtLx <= 0) anim.castBySlot.delete(s); else anim.castBySlot.set(s, v - dtLx);
      }

      const anyOtherDonor = slot => g.players.some(q => q.slot !== slot && q.lives > 1);
      for (const item of lay.pods) {
        const p = g.players.find(q => q.slot === item.slot);
        if (!p) continue;
        const rect = item.rect, tm = TEAM[p.slot], out = p.lives <= 0;
        const isDonor = p.slot === lx.leftSlot && p.lives > 1;
        const isTarget = p.slot === lx.rightSlot;
        const reviveT = anim.castBySlot.get(p.slot) || 0;
        const cardHot = lx.hover === 'tab:' + p.slot;

        ctx.save();
        rr(rect.x, rect.y, rect.w, rect.h, 16);
        const podBg = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
        podBg.addColorStop(0, out ? 'rgba(14, 17, 28, 0.78)' : 'rgba(24, 31, 52, 0.88)');
        podBg.addColorStop(1, 'rgba(9, 12, 22, 0.94)');
        ctx.fillStyle = podBg; ctx.fill();
        ctx.strokeStyle = reviveT > 0 ? '#ff84a0' : isDonor ? '#5eead4' : (cardHot || isTarget) ? '#ffcf5a' : out ? 'rgba(255, 255, 255, 0.12)' : tm.color;
        ctx.lineWidth = (isDonor || reviveT > 0 || cardHot) ? 2 : 1.5; ctx.stroke();

        ctx.fillStyle = tm.color;
        ctx.globalAlpha = out ? 0.45 : 0.95;
        rr(rect.x + 18, rect.y + 1, rect.w - 36, 3, 2); ctx.fill();
        ctx.globalAlpha = 1;

        // Top badge: DONOR / P1..P4
        ctx.textAlign = 'left';
        ctx.font = `700 11px ${F_DISP}`; setSp('1.4px'); ctx.fillStyle = tm.light;
        ctx.fillText(`P${p.slot + 1} · ${tm.name.toUpperCase()}`, rect.x + 14, rect.y + 22, rect.w - 28);
        setSp('0px');
        if (isDonor) {
          ctx.textAlign = 'right';
          ctx.font = `700 9.5px ${F_MONO}`; ctx.fillStyle = '#5eead4';
          ctx.fillText('DONOR', rect.x + rect.w - 14, rect.y + 22);
        }

        // Wizard sprite
        const fr = this.frames['WIZ' + p.slot + '/0'];
        const wh = 76, ww = fr ? wh * (fr[2] / fr[3]) : 46;
        const wx = rect.x + 16, wy = rect.y + 48;
        const aura = ctx.createRadialGradient(wx + ww / 2, wy + wh / 2, 2, wx + ww / 2, wy + wh / 2, 46);
        aura.addColorStop(0, tm.color + (out ? '26' : '55'));
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aura; ctx.fillRect(wx - 20, wy - 14, ww + 40, wh + 28);
        if (fr) {
          ctx.globalAlpha = out ? 0.42 : 1;
          ctx.drawImage(this.atlas, fr[0], fr[1], fr[2], fr[3], wx, wy, ww, wh);
          ctx.globalAlpha = 1;
        }

        // Life counter on right of sprite
        const tx = rect.x + rect.w - 16;
        ctx.textAlign = 'right';
        if (out) {
          ctx.font = `700 28px ${F_MONO}`; ctx.fillStyle = 'rgba(255, 92, 119, 0.80)';
          ctx.fillText('0', tx, wy + 26);
          ctx.font = `700 10px ${F_DISP}`; setSp('1px'); ctx.fillStyle = '#ff6b81';
          ctx.fillText('FALLEN', tx, wy + 52); setSp('0px');
        } else {
          const s = String(p.lives);
          ctx.font = `700 32px ${F_MONO}`; ctx.fillStyle = '#f8fafc';
          ctx.shadowColor = tm.color; ctx.shadowBlur = 10;
          ctx.fillText(s, tx, wy + 26); ctx.shadowBlur = 0;
          const nw = ctx.measureText(s).width;
          ctx.font = `700 20px ${F_UI}`; ctx.fillStyle = '#ff5c77';
          ctx.fillText('♥', tx - nw - 8, wy + 27);
          const show = Math.min(4, p.lives);
          const pips = '♥'.repeat(show) + (p.lives > 4 ? `+${p.lives - 4}` : '');
          ctx.font = `600 12px ${F_UI}`; ctx.fillStyle = '#ff7b93';
          ctx.fillText(pips, tx, wy + 54);
        }

        // Bottom -1 / +1 ♥ buttons inside each player card
        const canTake = p.lives > 1;
        const tBtn = item.takeBtn, tHot = lx.hover === `takeFrom:${p.slot}`;
        ctx.globalAlpha = canTake ? 1 : 0.30;
        rr(tBtn.x, tBtn.y, tBtn.w, tBtn.h, 9);
        ctx.fillStyle = (canTake && tHot) ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.07)'; ctx.fill();
        ctx.strokeStyle = (canTake && tHot) ? '#ffcf5a' : 'rgba(255, 255, 255, 0.16)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.font = `700 13px ${F_MONO}`; ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'center';
        ctx.fillText('-1', tBtn.x + tBtn.w / 2, tBtn.y + tBtn.h / 2 + 0.5);

        const canGive = anyOtherDonor(p.slot);
        const gBtn = item.giveBtn, gHot = lx.hover === `giveTo:${p.slot}`;
        ctx.globalAlpha = canGive ? 1 : 0.30;
        rr(gBtn.x, gBtn.y, gBtn.w, gBtn.h, 9);
        ctx.fillStyle = (canGive && gHot) ? 'rgba(94, 234, 212, 0.28)' : out && canGive ? 'rgba(94, 234, 212, 0.18)' : 'rgba(255, 255, 255, 0.08)';
        ctx.fill();
        ctx.strokeStyle = (canGive && gHot) ? '#5eead4' : out && canGive ? 'rgba(94, 234, 212, 0.72)' : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1.2; ctx.stroke();
        ctx.font = `700 13px ${F_DISP}`; ctx.fillStyle = out && canGive ? '#5eead4' : '#f8fafc';
        ctx.fillText('+1 ♥', gBtn.x + gBtn.w / 2, gBtn.y + gBtn.h / 2 + 0.5);
        ctx.restore();
      }
    }

    // Optional REVIVE ALL FALLEN CTA (teal) when 3-4 players & fallen players can be revived
    if (lay.shareAll) {
      const sBtn = lay.shareAll, sHot = lx.hover === 'shareAll';
      ctx.save();
      rr(sBtn.x, sBtn.y, sBtn.w, sBtn.h, 13);
      ctx.shadowColor = sHot ? 'rgba(94, 234, 212, 0.45)' : 'rgba(94, 234, 212, 0.20)';
      ctx.shadowBlur = sHot ? 22 : 12;
      const sg = ctx.createLinearGradient(sBtn.x, sBtn.y, sBtn.x + sBtn.w, sBtn.y + sBtn.h);
      sg.addColorStop(0, sHot ? 'rgba(94, 234, 212, 0.34)' : 'rgba(94, 234, 212, 0.22)');
      sg.addColorStop(1, sHot ? 'rgba(20, 140, 130, 0.42)' : 'rgba(16, 100, 96, 0.30)');
      ctx.fillStyle = sg; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = sHot ? '#8ff7e6' : 'rgba(94, 234, 212, 0.75)';
      ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = `700 14px ${F_DISP}`; ctx.fillStyle = '#d9fff8'; setSp('0.9px');
      ctx.fillText('REVIVE ALL FALLEN ♥', sBtn.x + sBtn.w / 2, sBtn.y + sBtn.h / 2 + 0.5); setSp('0px');
      ctx.restore();
    }

    // Primary gradient CTA button
    const cBtn = lay.confirm, cHot = lx.hover === 'confirm';
    ctx.save();
    rr(cBtn.x, cBtn.y, cBtn.w, cBtn.h, 13);
    ctx.shadowColor = cHot ? 'rgba(255, 98, 36, 0.50)' : 'rgba(242, 92, 28, 0.28)';
    ctx.shadowBlur = cHot ? 26 : 16;
    const ctaGrad = ctx.createLinearGradient(cBtn.x, cBtn.y, cBtn.x + cBtn.w, cBtn.y + cBtn.h);
    ctaGrad.addColorStop(0, cHot ? '#ff7030' : '#f25c1c');
    ctaGrad.addColorStop(1, cHot ? '#d43a16' : '#ba2e10');
    ctx.fillStyle = ctaGrad; ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = cHot ? 'rgba(255, 224, 178, 0.9)' : 'rgba(255, 184, 120, 0.7)';
    ctx.lineWidth = 1.4; ctx.stroke();
    const nextLv = (g.level?.id || 1) + 1;
    const ctaText = nextLv <= 100 ? `CONTINUE TO LEVEL ${nextLv}` : 'CONTINUE';
    ctx.font = `700 15px ${F_DISP}`; ctx.fillStyle = '#ffffff'; setSp('0.9px');
    ctx.fillText(ctaText, cBtn.x + cBtn.w / 2, cBtn.y + cBtn.h / 2 + 0.5); setSp('0px');
    ctx.restore();

    // Subtle footer hint below card
    ctx.font = `500 12.5px ${F_UI}`; ctx.fillStyle = 'rgba(210, 222, 245, 0.75)';
    ctx.fillText(
      lay.multi
        ? 'Click +1 ♥ / Revive All   ·   ← / → Transfer   ·   Enter Continue'
        : '← / → Move Heart   ·   Brew / Enter Continue',
      WW / 2, by + bh + 22
    );

    // Animated flying heart particles arcing between pods on transfer
    if (anim.hearts.length) {
      let hw = 0;
      for (let i = 0; i < anim.hearts.length; i++) {
        const h = anim.hearts[i];
        h.t += dtLx;
        if (h.t >= h.dur) continue;
        anim.hearts[hw++] = h;
        const u = h.t / h.dur;
        const hx = h.x0 + (h.x1 - h.x0) * u;
        const hy = h.y0 + (h.y1 - h.y0) * u - Math.sin(u * Math.PI) * 52;
        const sc = 1.0 + Math.sin(u * Math.PI) * 0.45;
        ctx.save();
        ctx.globalAlpha = Math.sin(Math.min(1, u * 1.15) * Math.PI);
        ctx.fillStyle = '#ff5c77';
        ctx.shadowColor = '#ff2a55'; ctx.shadowBlur = 16;
        ctx.font = `700 ${Math.round(28 * sc)}px ${F_UI}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('♥', hx, hy);
        ctx.shadowBlur = 0;
        for (let t = 1; t <= 3; t++) {
          const tu = Math.max(0, u - t * 0.06);
          const tx = h.x0 + (h.x1 - h.x0) * tu;
          const ty = h.y0 + (h.y1 - h.y0) * tu - Math.sin(tu * Math.PI) * 52;
          ctx.globalAlpha *= 0.65;
          ctx.fillStyle = t === 1 ? '#ffd89b' : h.col;
          ctx.beginPath(); ctx.arc(tx, ty, 3.6 - t * 0.7, 0, 7); ctx.fill();
        }
        ctx.restore();
      }
      anim.hearts.length = hw;
    }

    ctx.restore();
  }

  /**
   * Realistic volumetric airflow for Storm / Gust wind zones & floor air vents:
   * - Ambient subtle rising vapor drafts above pressurized floor vents (this.ventCells)
   * - Soft rotating atmospheric vortex on active wind casters + tapered directional flow wash
   * - Traveling bowed pneumatic pressure fronts showing exact arm reach & blow direction
   * - Smooth dt-driven curved laminar air filaments, billowing vapor puffs, and floating motes (object-pooled)
   */
  drawWinds(dt = 1 / 60) {
    const g = this.game, ctx = this.ctx, t = this.time;
    const winds = g.winds || [];
    const parts = this.windParts || (this.windParts = []);
    const pool = this._windPool || (this._windPool = []);
    const vents = this.ventCells || [];
    if (this.windGame !== g) { parts.length = 0; this.windGame = g; }
    if (!winds.length && !parts.length && !vents.length) return;

    const fast = !!this.q?.fastFx;
    const qScale = this.q?.particles ?? 1;
    const stepDt = Math.max(0, Math.min(dt || 0, 0.05));
    ctx.save();

    // 1. Subtle ambient vapor draft & pressurized steam pulse over floor air vents
    if (vents.length && this.airMist) {
      for (let vi = 0; vi < vents.length; vi++) {
        const cell = vents[vi];
        const hot = this.ventFlash?.get(cell) || 0;
        if (fast && hot <= 0) continue;
        const vx = (cell % W) + 0.5, vy = ((cell / W) | 0) + 0.5;
        const nWisp = fast ? 1 : (hot > 0 ? 3 : 2);
        for (let k = 0; k < nWisp; k++) {
          const ph = (t * (hot > 0 ? 1.45 : 0.72) + vi * 0.37 + k * 0.5) % 1;
          const wy = vy - ph * (hot > 0 ? 0.62 : 0.36);
          const wx = vx + Math.sin(ph * Math.PI * 2 + vi * 1.3 + k * 2.1) * 0.1;
          const sz = (0.34 + ph * (hot > 0 ? 0.52 : 0.28)) * T;
          const a = Math.sin(ph * Math.PI) * (0.14 + hot * 0.38) * Math.min(1.2, Math.max(0.5, qScale));
          if (a > 0.01) {
            ctx.globalAlpha = a;
            ctx.drawImage(this.airMist, wx * T - sz / 2, wy * T - sz / 2, sz, sz);
          }
        }
      }
    }

    // 2. Active Storm / Gust channels, caster vortices, bowed pressure waves, and fluid particle emission
    const maxParts = fast ? 64 : 240;
    if (winds.length) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let wi = 0; wi < winds.length; wi++) {
        const w = winds[wi], arms = w.arms || [0, 0, 0, 0];
        if (!w._acc) w._acc = [0, 0, 0, 0];
        const age = Math.max(0, (w.max || 8.2) - w.t);
        const fade = Math.min(1, age * 4.5) * Math.min(1, Math.max(0, w.t / 0.45));
        if (fade <= 0.005) continue;
        const ox = (w.x + 0.5) * T, oy = (w.y + 0.5) * T;

        // Caster atmospheric vortex (soft mist pool + rotating swirl arcs)
        if (this.airMist && !fast) {
          const mSz = (1.05 + Math.sin(t * 7 + (w.id || wi)) * 0.08) * T;
          ctx.globalAlpha = 0.36 * fade;
          ctx.drawImage(this.airMist, ox - mSz / 2, oy - mSz / 2, mSz, mSz);
        }
        const rot = t * 6.5 + (w.id || wi) * 1.7;
        for (let s = 0; s < 2; s++) {
          const a0 = rot + s * Math.PI;
          ctx.strokeStyle = '#d4f0ff'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.26 * fade;
          ctx.beginPath(); ctx.arc(ox, oy, 0.26 * T, a0, a0 + 1.5); ctx.stroke();
          if (!fast) {
            ctx.strokeStyle = '#9fd8ff'; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.16 * fade;
            ctx.beginPath(); ctx.arc(ox, oy, 0.39 * T, a0 + 0.45, a0 + 1.85); ctx.stroke();
          }
        }

        // Per-arm directional corridor wash + traveling bowed pressure waves + streamlines
        for (let d = 0; d < 4; d++) {
          const arm = arms[d];
          if (!arm) continue;
          const dx = d === 0 ? 1 : d === 2 ? -1 : 0;
          const dy = d === 1 ? 1 : d === 3 ? -1 : 0;
          const px = -dy, py = dx;

          const sx = (w.x + 0.5 + dx * 0.24) * T, sy = (w.y + 0.5 + dy * 0.24) * T;
          const ex = (w.x + 0.5 + dx * (arm + 0.48)) * T, ey = (w.y + 0.5 + dy * (arm + 0.48)) * T;
          if (fast) {
            ctx.globalAlpha = 0.11 * fade;
            ctx.strokeStyle = '#bce6ff';
          } else {
            const gr = ctx.createLinearGradient(sx, sy, ex, ey);
            gr.addColorStop(0, `rgba(180, 226, 255, ${0.14 * fade})`);
            gr.addColorStop(0.55, `rgba(210, 240, 255, ${0.10 * fade})`);
            gr.addColorStop(1, 'rgba(180, 226, 255, 0)');
            ctx.globalAlpha = 1;
            ctx.strokeStyle = gr;
          }
          ctx.lineWidth = 0.64 * T;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

          // Traveling bowed aerodynamic shock fronts
          const nWaves = Math.max(2, Math.min(fast ? 2 : 4, Math.ceil(arm * 0.65)));
          for (let k = 0; k < nWaves; k++) {
            const u = (t * 0.78 + k / nWaves + wi * 0.19) % 1;
            const dPos = 0.28 + u * arm;
            const cx = (w.x + 0.5 + dx * dPos) * T, cy = (w.y + 0.5 + dy * dPos) * T;
            const back = 0.17 * T, span = (0.28 + Math.sin(u * Math.PI) * 0.08) * T;
            const t1x = cx - dx * back + px * span, t1y = cy - dy * back + py * span;
            const t2x = cx - dx * back - px * span, t2y = cy - dy * back - py * span;
            const ax = cx + dx * 0.08 * T, ay = cy + dy * 0.08 * T;
            const ctrlX = 2 * ax - 0.5 * (t1x + t2x), ctrlY = 2 * ay - 0.5 * (t1y + t2y);
            ctx.strokeStyle = '#dcf4ff';
            ctx.lineWidth = 2.2;
            ctx.globalAlpha = Math.sin(u * Math.PI) * 0.28 * fade;
            ctx.beginPath(); ctx.moveTo(t1x, t1y); ctx.quadraticCurveTo(ctrlX, ctrlY, t2x, t2y); ctx.stroke();
          }

          if (stepDt > 0 && parts.length < maxParts) {
            w._acc[d] += stepDt * (18 + arm * 6) * Math.max(0.25, qScale);
            while (w._acc[d] >= 1 && parts.length < maxParts) {
              w._acc[d] -= 1;
              const roll = Math.random();
              const kind = roll < 0.62 ? 0 : roll < 0.86 ? 1 : 2;
              const fwd = 0.06 + Math.random() * 0.32;
              const lat = (Math.random() - 0.5) * 0.68;
              const sp = kind === 1 ? (2.6 + Math.random() * 3.0) : (5.4 + Math.random() * 5.2);
              const maxDist = arm + 0.48;
              const life = Math.max(0.08, (maxDist - fwd) / sp);
              const p = pool.length ? pool.pop() : {};
              p.kind = kind;
              p.ox = w.x + 0.5; p.oy = w.y + 0.5;
              p.dx = dx; p.dy = dy; p.px = px; p.py = py;
              p.fwd0 = fwd; p.lat = lat; p.sp = sp;
              p.age = 0; p.life = life;
              p.amp = (kind === 1 ? 0.08 : 0.04 + Math.random() * 0.075) * (Math.random() < 0.5 ? 1 : -1);
              p.freq = 6 + Math.random() * 8;
              p.phase = Math.random() * 6.283;
              p.lenT = 0.05 + Math.random() * 0.045;
              p.w = kind === 2 ? (1.5 + Math.random() * 1.4) : (1.3 + Math.random() * 1.5);
              p.sz = (0.34 + Math.random() * 0.44) * T;
              p.bright = Math.random() < 0.45 ? 1 : 0;
              parts.push(p);
            }
          }
        }
      }
    }

    // 3. Advance & render curved laminar wind filaments, soft vapor puffs, and sunlit airborne motes (batched by bucket)
    if (parts.length) {
      ctx.lineCap = 'round';
      const filBuckets = this._windFilBuckets || (this._windFilBuckets = [[], [], [], []]);
      for (let b = 0; b < 4; b++) filBuckets[b].length = 0;
      const moteBright = this._windMoteB || (this._windMoteB = []);
      const moteDim = this._windMoteD || (this._windMoteD = []);
      moteBright.length = 0; moteDim.length = 0;
      let pw = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.age += stepDt;
        if (p.age >= p.life) { pool.push(p); continue; }
        parts[pw++] = p;
        const k = p.age / p.life;
        const env = (k < 0.16 ? k / 0.16 : 1) * (k > 0.68 ? (1 - k) / 0.32 : 1);
        const fwd = p.fwd0 + p.sp * p.age;
        const sway = Math.sin(p.phase + p.age * p.freq) * p.amp * Math.min(1, fwd * 0.85);

        if (p.kind === 1) {
          if (!this.airMist) continue;
          const x = (p.ox + p.dx * fwd + p.px * (p.lat + sway)) * T;
          const y = (p.oy + p.dy * fwd + p.py * (p.lat + sway)) * T;
          const sz = p.sz * (0.75 + k * 0.55);
          ctx.globalAlpha = 0.38 * env;
          ctx.drawImage(this.airMist, x - sz / 2, y - sz / 2, sz, sz);
        } else if (p.kind === 2) {
          p._mx = (p.ox + p.dx * fwd + p.px * (p.lat + sway)) * T;
          p._my = (p.oy + p.dy * fwd + p.py * (p.lat + sway)) * T;
          p._env = env;
          if (p.bright) moteBright.push(p); else moteDim.push(p);
        } else {
          const t0 = Math.max(0, p.age - p.lenT);
          const tm = (t0 + p.age) * 0.5;
          const f0 = p.fwd0 + p.sp * t0, fm = p.fwd0 + p.sp * tm;
          const s0 = Math.sin(p.phase + t0 * p.freq) * p.amp * Math.min(1, f0 * 0.85);
          const sm = Math.sin(p.phase + tm * p.freq) * p.amp * Math.min(1, fm * 0.85);
          const x0 = (p.ox + p.dx * f0 + p.px * (p.lat + s0)) * T;
          const y0 = (p.oy + p.dy * f0 + p.py * (p.lat + s0)) * T;
          const xm = (p.ox + p.dx * fm + p.px * (p.lat + sm)) * T;
          const ym = (p.oy + p.dy * fm + p.py * (p.lat + sm)) * T;
          const x1 = (p.ox + p.dx * fwd + p.px * (p.lat + sway)) * T;
          const y1 = (p.oy + p.dy * fwd + p.py * (p.lat + sway)) * T;
          p._x0 = x0; p._y0 = y0;
          p._cx = 2 * xm - 0.5 * (x0 + x1);
          p._cy = 2 * ym - 0.5 * (y0 + y1);
          p._x1 = x1; p._y1 = y1;
          const bi = Math.min(3, Math.max(0, (env * 4) | 0));
          filBuckets[bi].push(p);
        }
      }
      parts.length = pw;
      for (let bi = 0; bi < 4; bi++) {
        const list = filBuckets[bi];
        if (!list.length) continue;
        const envB = (bi + 0.5) / 4;
        ctx.strokeStyle = '#9cd8ff';
        ctx.lineWidth = 4.4;
        ctx.globalAlpha = 0.16 * envB;
        ctx.beginPath();
        for (let j = 0; j < list.length; j++) { const p = list[j]; ctx.moveTo(p._x0, p._y0); ctx.quadraticCurveTo(p._cx, p._cy, p._x1, p._y1); }
        ctx.stroke();

        ctx.strokeStyle = '#dcf4ff';
        ctx.lineWidth = 2.0;
        ctx.globalAlpha = 0.48 * envB;
        ctx.beginPath();
        for (let j = 0; j < list.length; j++) { const p = list[j]; ctx.moveTo(p._x0, p._y0); ctx.quadraticCurveTo(p._cx, p._cy, p._x1, p._y1); }
        ctx.stroke();
      }
      for (const [col, aMul, list] of [['#ffffff', 0.65, moteBright], ['#cceeff', 0.44, moteDim]]) {
        if (!list.length) continue;
        ctx.fillStyle = col;
        ctx.globalAlpha = aMul;
        ctx.beginPath();
        for (let j = 0; j < list.length; j++) {
          const p = list[j];
          ctx.moveTo(p._mx + p.w, p._my);
          ctx.arc(p._mx, p._my, p.w, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    ctx.restore();
  }

  drawProjectiles(alpha = 1) {
    const g = this.game, ctx = this.ctx, t = this.time;
    for (const p of g.projs) {
      const px = p.px !== undefined ? p.px + (p.x - p.px) * alpha : p.x;
      const py = p.py !== undefined ? p.py + (p.y - p.py) * alpha : p.y;
      if (p.spell === 'fire') this._drawFireOrb(ctx, px, py, p.d, t, (p.id | 0) + p.d + 1);
      else if (p.spell === 'electric') this._drawElectricOrb(ctx, px, py, 0.34 * T, t, (p.id | 0) + p.d + 1);
      else if (p.spell === 'teleport') this._drawMagicCluster(ctx, px, py, 0.36 * T, t, (p.id | 0) + p.d + 1);
      else {
        const ang = (p.d || 0) * Math.PI / 2, c = Math.cos(ang), s = Math.sin(ang);
        ctx.save();
        ctx.translate(px * T, py * T);
        ctx.rotate(ang);
        if (isDrawableOk(this.airMist)) {
          ctx.globalAlpha = 0.58;
          ctx.drawImage(this.airMist, -0.58 * T, -0.34 * T, 0.72 * T, 0.68 * T);
        }
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(185, 232, 255, 0.72)'; ctx.lineWidth = 4.5;
        ctx.beginPath(); ctx.moveTo(-0.16 * T, -0.28 * T); ctx.quadraticCurveTo(0.28 * T, 0, -0.16 * T, 0.28 * T); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(-0.08 * T, -0.21 * T); ctx.quadraticCurveTo(0.22 * T, 0, -0.08 * T, 0.21 * T); ctx.stroke();
        ctx.restore();
        if (Math.random() < 0.75 * this.q.particles) {
          this.particles.push({
            k: 'mote', x: px - c * 0.15 + (Math.random() - 0.5) * 0.24, y: py - s * 0.15 + (Math.random() - 0.5) * 0.24,
            vx: -c * 1.4 + (Math.random() - 0.5) * 0.9, vy: -s * 1.4 + (Math.random() - 0.5) * 0.9,
            t: 0, life: 0.26, s: 0.34, c: '#dcf4ff', rot: ang
          });
        }
      }
      if (p.spell !== 'wind' && Math.random() < 0.5 * this.q.particles) this.particles.push({ k: 'spark', x: px, y: py, vx: 0, vy: 0, t: 0, life: 0.3, s: 0.14,
        c: { fire: '#ff8a20', electric: '#c8ecff', teleport: '#ff80ff' }[p.spell] || '#ffffff' });
    }
  }

  /** Build and cache a clean high-voltage canvas from original AM_FORCE/k (strips dark rect bake & adds ionized glow) */
  getBarrierSprite(k) {
    if (!this._barrierCache) this._barrierCache = new Map();
    const hit = this._barrierCache.get(k);
    if (hit && isDrawableOk(hit.canvas)) return hit;
    const fr = this.frames['AM_FORCE/' + k];
    if (!fr || !this.baseAtlas) return null;
    const [sx, sy, w, h] = fr, pad = 18;
    const [src, sctx] = this._mkCanvas(w, h, { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(this.baseAtlas, sx, sy, w, h, 0, 0, w, h);
    const data = sctx.getImageData(0, 0, w, h).data;
    const cw = w >> 2, ch = h >> 2, horiz = k >= 8, mask = new Uint8Array(cw * ch);
    for (let gy = 0; gy < ch; gy++) for (let gx = 0; gx < cw; gx++) {
      if (data[((gy * 4 + 2) * w + (gx * 4 + 2)) * 4] > 180) mask[gy * cw + gx] = 1;
    }
    const px = gx => pad + gx * 4 + 2, py = gy => pad + gy * 4 + 2;
    const edges = [], dots = [];
    for (let gy = 0; gy < ch; gy++) for (let gx = 0; gx < cw; gx++) {
      if (!mask[gy * cw + gx]) continue;
      let deg = 0;
      const right = gx + 1 < cw && mask[gy * cw + gx + 1];
      const down = gy + 1 < ch && mask[(gy + 1) * cw + gx];
      if (right) { edges.push([px(gx), py(gy), px(gx + 1), py(gy)]); deg++; }
      if (down) { edges.push([px(gx), py(gy), px(gx), py(gy + 1)]); deg++; }
      if (gx + 1 < cw && gy + 1 < ch && mask[(gy + 1) * cw + gx + 1] && !(right && down)) {
        edges.push([px(gx), py(gy), px(gx + 1), py(gy + 1)]); deg++;
      }
      if (gx > 0 && gy + 1 < ch && mask[(gy + 1) * cw + gx - 1] && !(mask[gy * cw + gx - 1] && down)) {
        edges.push([px(gx), py(gy), px(gx - 1), py(gy + 1)]); deg++;
      }
      if (horiz) {
        if (gx === 0) { edges.push([pad, py(gy), px(0), py(gy)]); deg++; }
        if (gx === cw - 1) { edges.push([px(gx), py(gy), pad + w, py(gy)]); deg++; }
      } else {
        if (gy === 0) { edges.push([px(gx), pad, px(gx), py(0)]); deg++; }
        if (gy === ch - 1) { edges.push([px(gx), py(gy), px(gx), pad + h]); deg++; }
      }
      const hasPrev = (gx > 0 && mask[gy * cw + gx - 1]) || (gy > 0 && mask[(gy - 1) * cw + gx]) ||
        (gx > 0 && gy > 0 && mask[(gy - 1) * cw + gx - 1]) || (gx + 1 < cw && gy > 0 && mask[(gy - 1) * cw + gx + 1]);
      if (deg === 0 && !hasPrev) dots.push([px(gx), py(gy)]);
    }

    const [out, c] = this._mkCanvas(w + pad * 2, h + pad * 2);
    if (!c) return null;
    const trace = () => {
      c.beginPath();
      for (const [x0, y0, x1, y1] of edges) { c.moveTo(x0, y0); c.lineTo(x1, y1); }
      for (const [dx, dy] of dots) { c.moveTo(dx, dy); c.lineTo(dx + 0.01, dy); }
    };
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(4, 18, 48, 0.36)'; c.lineWidth = 12.5; c.shadowColor = 'rgba(4, 14, 40, 0.45)'; c.shadowBlur = 5;
    trace(); c.stroke();
    c.strokeStyle = 'rgba(28, 138, 255, 0.44)'; c.lineWidth = 10; c.shadowColor = '#1e90ff'; c.shadowBlur = 11;
    trace(); c.stroke();
    c.strokeStyle = 'rgba(84, 222, 255, 0.90)'; c.lineWidth = 4.6; c.shadowColor = '#5ce2ff'; c.shadowBlur = 5;
    trace(); c.stroke();
    c.strokeStyle = '#f6fcff'; c.lineWidth = 1.9; c.shadowColor = '#ffffff'; c.shadowBlur = 2;
    trace(); c.stroke();
    c.shadowBlur = 0;

    const entry = { canvas: out, pad, w, h, fr };
    this._barrierCache.set(k, entry);
    if (!this.q?.fastFx) promoteSmallImg(out, im => { if (this._barrierCache.get(k) === entry) entry.canvas = im; });
    return entry;
  }

  /**
   * Pre-render and cache a crisp 128x128 supersampled modern pickup sprite faithful to original AM_PICKP/0..16.
   * Covers all 17 pickups in PICK_INDEX for both map rendering (drawItems) and the HUD power slot (drawHud).
   */
  getPickupSprite(name) {
    if (!PICK_INDEX.includes(name)) return null;
    if (!this._pickupCache) this._pickupCache = new Map();
    const hit = this._pickupCache.get(name);
    if (hit && isDrawableOk(hit.canvas)) return hit;

    const S = 128;
    const [out, c] = this._mkCanvas(S, S);
    if (!c) return null;

    c.save();
    c.translate(S / 2, S / 2);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const rRect = (x, y, w, h, r) => {
      c.beginPath();
      if (c.roundRect) c.roundRect(x, y, w, h, r);
      else c.rect(x, y, w, h);
    };
    const poly = pts => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
    };
    const setDropShadow = () => {
      c.shadowColor = 'rgba(0, 0, 0, 0.58)';
      c.shadowBlur = 5.5;
      c.shadowOffsetX = 1.5;
      c.shadowOffsetY = 3.0;
    };
    const clearShadow = () => {
      c.shadowColor = 'rgba(0, 0, 0, 0)';
      c.shadowBlur = 0;
      c.shadowOffsetX = 0;
      c.shadowOffsetY = 0;
    };

    // Original AM_PICKP/9..12 compact potion bottle (broad shouldered stone vessel)
    const traceStoneBottle = () => {
      c.beginPath();
      c.moveTo(-12, -26);
      c.lineTo(-12, -11);
      c.bezierCurveTo(-14, -4, -39, 1, -39, 21);
      c.bezierCurveTo(-39, 40, -25, 49, 0, 49);
      c.bezierCurveTo(25, 49, 39, 40, 39, 21);
      c.bezierCurveTo(39, 1, 14, -4, 12, -11);
      c.lineTo(12, -26);
      c.closePath();
    };
    // Original AM_PICKP/13..16 pear/teardrop flask (smoothly sloping shoulders from neck)
    const traceGlassBottle = () => {
      c.beginPath();
      c.moveTo(-11, -26);
      c.bezierCurveTo(-10, -14, -14, -7, -23, 0);
      c.bezierCurveTo(-35, 9, -40, 18, -39, 27);
      c.bezierCurveTo(-38, 42, -24, 49, 0, 49);
      c.bezierCurveTo(24, 49, 38, 42, 39, 27);
      c.bezierCurveTo(40, 18, 35, 9, 23, 0);
      c.bezierCurveTo(14, -7, 10, -14, 11, -26);
      c.closePath();
    };
    const traceBottleCap = () => {
      rRect(-19, -48, 38, 21, 8.5);
    };
    const traceBulb = () => {
      c.beginPath();
      c.moveTo(-14, -6);
      c.bezierCurveTo(-29, 0, -39, 9, -39, 21);
      c.bezierCurveTo(-39, 40, -25, 49, 0, 49);
      c.bezierCurveTo(25, 49, 39, 40, 39, 21);
      c.bezierCurveTo(39, 9, 29, 0, 14, -6);
      c.closePath();
    };

    const STONE_BULB = {
      stoneWind:     { hi: '#9cd0ff', c0: '#84b4fc', c1: '#748cd8', c2: '#686cb4', c3: '#484070', dot: '#a8d4ff' },
      stoneTeleport: { hi: '#fca8fc', c0: '#e448d8', c1: '#ac34a4', c2: '#742470', c3: '#4c184c', dot: '#fc88f8' },
      stoneElectric: { hi: '#fcfcfc', c0: '#f0f0f0', c1: '#b8b8b8', c2: '#909090', c3: '#b8b8b8', dot: '#fcfcfc', rimWhite: true },
      stoneFire:     { hi: '#fcfcfc', c0: '#ecd800', c1: '#b09c00', c2: '#786800', c3: '#202428', dot: '#fcfcfc' },
    };

    const GLASS_THEMES = {
      glassFire:     { cap0: '#e06000', cap1: '#a42c00', cap2: '#6c0400', n0: '#e06000', n1: '#a42c00', c0: '#fc7c00', c1: '#e06000', c2: '#c44800', c3: '#880c00', dot: '#fcfc00' },
      glassWind:     { cap0: '#84b4fc', cap1: '#748cd8', cap2: '#686cb4', n0: '#84b4fc', n1: '#686cb4', c0: '#84b4fc', c1: '#748cd8', c2: '#686cb4', c3: '#605894', dot: '#c8e4ff' },
      glassElectric: { cap0: '#fcfcfc', cap1: '#b8b8b8', cap2: '#909090', n0: '#fcfcfc', n1: '#909090', c0: '#fcfcfc', c1: '#fcfcfc', c2: '#b8b8b8', c3: '#6c6c6c', dot: '#ffffff' },
      glassTeleport: { cap0: '#808c9c', cap1: '#58606c', cap2: '#303438', n0: '#6c7480', n1: '#444850', c0: '#808c9c', c1: '#6c7480', c2: '#58606c', c3: '#303438', dot: '#fcfcfc' },
    };

    if (STONE_BULB[name]) {
      const th = STONE_BULB[name];
      // Lower vessel + translucent icy-blue top neck/cap matching AM_PICKP/9..12
      setDropShadow();
      traceStoneBottle();
      const topG = c.createLinearGradient(-13, -26, 13, -4);
      topG.addColorStop(0, 'rgba(116, 188, 224, 0.92)');
      topG.addColorStop(0.5, 'rgba(80, 136, 164, 0.85)');
      topG.addColorStop(1, 'rgba(36, 60, 72, 0.92)');
      c.fillStyle = topG;
      c.fill();
      clearShadow();

      // Translucent clear glass highlight on neck + subtle clear right-side hollow (AM_PICKP/9..12)
      c.save();
      traceStoneBottle();
      c.clip();
      c.fillStyle = 'rgba(20, 34, 42, 0.42)';
      c.fillRect(0, -26, 14, 24);
      const nkG = c.createLinearGradient(-8, -22, -2, -22);
      nkG.addColorStop(0, '#74bce0');
      nkG.addColorStop(1, '#64a0c0');
      c.fillStyle = nkG;
      c.fillRect(-8, -22, 6, 16);

      // Filled stone-potion bulb
      traceBulb();
      if (th.rimWhite) {
        // stoneElectric: silver interior with gleaming white U-shaped pearl inner rim
        const silverG = c.createRadialGradient(-4, 14, 4, 0, 22, 36);
        silverG.addColorStop(0, '#b8b8b8');
        silverG.addColorStop(1, '#909090');
        c.fillStyle = silverG;
        c.fill();
        c.strokeStyle = '#fcfcfc';
        c.lineWidth = 10;
        c.beginPath();
        c.moveTo(-29, 4);
        c.bezierCurveTo(-36, 16, -34, 42, 0, 44);
        c.bezierCurveTo(34, 42, 36, 16, 29, 4);
        c.stroke();
      } else {
        const bg = c.createRadialGradient(-14, 14, 3, 0, 22, 42);
        bg.addColorStop(0, th.hi);
        bg.addColorStop(0.32, th.c0);
        bg.addColorStop(0.68, th.c1);
        bg.addColorStop(0.88, th.c2);
        bg.addColorStop(1, th.c3);
        c.fillStyle = bg;
        c.fill();
      }

      // Original bright upper-left highlight dot
      c.beginPath();
      c.ellipse(-15, 13, 6.5, 5.2, -0.45, 0, Math.PI * 2);
      c.fillStyle = th.dot;
      c.fill();
      c.restore();

      traceStoneBottle();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();

      // Rounded icy translucent cap (lower-right gleam fading up into deep #305464/#243c48)
      setDropShadow();
      traceBottleCap();
      const capG = c.createRadialGradient(4, -33, 2, 0, -40, 22);
      capG.addColorStop(0, '#74bce0');
      capG.addColorStop(0.38, '#64a0c0');
      capG.addColorStop(0.72, '#305464');
      capG.addColorStop(1, '#243c48');
      c.fillStyle = capG;
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    } else if (GLASS_THEMES[name]) {
      const th = GLASS_THEMES[name];
      // Pear-shaped compact flask colored through cap, sloping neck, and bulb (AM_PICKP/13..16)
      setDropShadow();
      traceGlassBottle();
      const neckG = c.createLinearGradient(-12, -26, 12, -2);
      neckG.addColorStop(0, th.n0);
      neckG.addColorStop(1, th.n1);
      c.fillStyle = neckG;
      c.fill();
      clearShadow();

      c.save();
      traceGlassBottle();
      c.clip();
      const bulbG = c.createRadialGradient(-13, 14, 3, 2, 22, 44);
      bulbG.addColorStop(0, th.c0);
      bulbG.addColorStop(0.42, th.c1);
      bulbG.addColorStop(0.78, th.c2);
      bulbG.addColorStop(1, th.c3);
      c.fillStyle = bulbG;
      c.beginPath();
      c.ellipse(0, 22, 44, 34, 0, 0, Math.PI * 2);
      c.fill();

      // Upper-left bright glint spot
      c.beginPath();
      c.ellipse(-14, 15, 6.8, 5.2, -0.45, 0, Math.PI * 2);
      c.fillStyle = th.dot;
      c.fill();
      c.restore();

      traceGlassBottle();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();

      // Element-colored rounded cap matching AM_PICKP/13..16
      setDropShadow();
      traceBottleCap();
      const capG = c.createRadialGradient(-4, -36, 2, 0, -37, 21);
      capG.addColorStop(0, th.cap0);
      capG.addColorStop(0.55, th.cap1);
      capG.addColorStop(1, th.cap2);
      c.fillStyle = capG;
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    } else if (name === 'greenGem') {
      // AM_PICKP/2: plump rotated emerald diamond spanning edge-to-edge with top-left shine
      setDropShadow();
      poly([[0, -53], [53, 0], [0, 53], [-53, 0]]);
      const gg = c.createLinearGradient(-34, -34, 34, 34);
      gg.addColorStop(0, '#50dc48');
      gg.addColorStop(0.44, '#3ca834');
      gg.addColorStop(0.74, '#287424');
      gg.addColorStop(1, '#184c18');
      c.fillStyle = gg;
      c.fill();
      clearShadow();

      // Soft upper-left facet glow + bright white hotspot matching AM_PICKP/2
      c.save();
      poly([[0, -53], [53, 0], [0, 53], [-53, 0]]);
      c.clip();
      const hi = c.createRadialGradient(-16, -12, 2, -12, -10, 36);
      hi.addColorStop(0, '#fcfcfc');
      hi.addColorStop(0.32, '#90fc88');
      hi.addColorStop(0.7, 'rgba(80, 220, 72, 0.35)');
      hi.addColorStop(1, 'rgba(80, 220, 72, 0)');
      c.fillStyle = hi;
      c.fillRect(-54, -54, 108, 108);
      c.restore();

      poly([[0, -53], [53, 0], [0, 53], [-53, 0]]);
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    } else if (name === 'purpleGem') {
      // AM_PICKP/1: sleek chamfered vertical capsule crystal with flat sides & white-pink diagonal streak
      const traceCapsule = () => {
        rRect(-29, -50, 58, 100, 21);
      };
      setDropShadow();
      traceCapsule();
      c.fillStyle = '#4c184c';
      c.fill();
      clearShadow();

      c.save();
      traceCapsule();
      c.clip();
      const bodyG = c.createRadialGradient(5, 14, 6, 0, 0, 54);
      bodyG.addColorStop(0, '#ac34a4');
      bodyG.addColorStop(0.58, '#742470');
      bodyG.addColorStop(1, '#4c184c');
      c.fillStyle = bodyG;
      rRect(-21, -42, 42, 84, 15);
      c.fill();

      // Lower-right magenta bounce glow inside cabochon
      const glowG = c.createRadialGradient(12, 22, 2, 9, 19, 20);
      glowG.addColorStop(0, '#fc88f8');
      glowG.addColorStop(0.55, '#e448d8');
      glowG.addColorStop(1, 'rgba(172, 52, 164, 0)');
      c.fillStyle = glowG;
      c.beginPath();
      c.arc(9, 19, 20, 0, Math.PI * 2);
      c.fill();

      // Crisp upper-left white-to-pink facet highlight streak
      c.strokeStyle = '#fc88f8';
      c.lineWidth = 8.5;
      c.beginPath();
      c.moveTo(-19, -4);
      c.quadraticCurveTo(-19, -28, -4, -36);
      c.stroke();
      c.strokeStyle = '#fcfcfc';
      c.lineWidth = 4.2;
      c.beginPath();
      c.moveTo(-17, -14);
      c.quadraticCurveTo(-17, -29, -6, -35);
      c.stroke();
      c.restore();

      traceCapsule();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    } else if (name === 'heart') {
      // AM_PICKP/4: plump classic ruby red heart with dark-red inner bevel and upper-left lobe shine
      const traceHeart = () => {
        c.beginPath();
        c.moveTo(0, 48);
        c.bezierCurveTo(-18, 34, -50, 13, -50, -14);
        c.bezierCurveTo(-50, -35, -31, -46, -14, -41);
        c.bezierCurveTo(-5, -38, -1, -28, 0, -24);
        c.bezierCurveTo(1, -28, 5, -38, 14, -41);
        c.bezierCurveTo(31, -46, 50, -35, 50, -14);
        c.bezierCurveTo(50, 13, 18, 34, 0, 48);
        c.closePath();
      };
      setDropShadow();
      traceHeart();
      c.fillStyle = '#880000';
      c.fill();
      clearShadow();

      c.save();
      traceHeart();
      c.clip();
      const hg = c.createRadialGradient(-8, -6, 6, 0, 2, 54);
      hg.addColorStop(0, '#fc0000');
      hg.addColorStop(0.68, '#fc0000');
      hg.addColorStop(0.86, '#c40000');
      hg.addColorStop(1, '#880000');
      c.fillStyle = hg;
      c.fillRect(-52, -48, 104, 98);

      // Upper-left lobe specular shine (#fcfcfc + #fc8484 halo)
      c.beginPath();
      c.ellipse(-25, -20, 9.5, 6.2, -0.65, 0, Math.PI * 2);
      c.fillStyle = '#fc8484';
      c.fill();
      c.beginPath();
      c.ellipse(-26, -21, 5.2, 3.4, -0.65, 0, Math.PI * 2);
      c.fillStyle = '#fcfcfc';
      c.fill();
      c.restore();

      traceHeart();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    } else if (name === 'foot') {
      // AM_PICKP/0: winged bare human foot facing right with tucked feathered wing on ankle
      const drawFoot = () => {
        c.beginPath();
        c.moveTo(-22, -42);
        c.lineTo(-4, -42);
        c.bezierCurveTo(-1, -20, 0, -6, 5, 4);
        c.bezierCurveTo(13, 12, 29, 13, 40, 13);
        c.bezierCurveTo(49, 13, 52, 20, 49, 28);
        c.bezierCurveTo(46, 35, 36, 37, 22, 37);
        c.bezierCurveTo(12, 37, 4, 34, -6, 36);
        c.lineTo(-22, 39);
        c.bezierCurveTo(-30, 39, -31, 27, -27, 13);
        c.lineTo(-22, -42);
        c.closePath();
      };
      setDropShadow();
      drawFoot();
      const fg = c.createLinearGradient(-22, -40, 44, 38);
      fg.addColorStop(0, '#94706c');
      fg.addColorStop(0.28, '#c89490');
      fg.addColorStop(0.55, '#fcbcb4');
      fg.addColorStop(0.84, '#c89490');
      fg.addColorStop(1, '#64483c');
      c.fillStyle = fg;
      c.fill();
      clearShadow();

      // Arch & heel shadow along sole + vertical highlight down front shin/instep
      c.save();
      drawFoot();
      c.clip();
      c.strokeStyle = '#64483c';
      c.lineWidth = 6.5;
      c.beginPath();
      c.moveTo(-26, 37);
      c.quadraticCurveTo(0, 32, 38, 36);
      c.stroke();
      c.strokeStyle = '#fcbcb4';
      c.lineWidth = 5;
      c.beginPath();
      c.moveTo(-10, -32);
      c.quadraticCurveTo(-4, 6, 28, 18);
      c.stroke();
      c.restore();

      drawFoot();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();

      // Swept 3-feather ankle wing on upper-left (AM_PICKP/0)
      setDropShadow();
      c.beginPath();
      c.moveTo(-12, -26);
      c.bezierCurveTo(-22, -36, -38, -34, -45, -24);
      c.bezierCurveTo(-39, -19, -33, -18, -30, -17);
      c.bezierCurveTo(-39, -17, -46, -15, -46, -12);
      c.bezierCurveTo(-42, -7, -34, -6, -30, -5);
      c.bezierCurveTo(-36, -4, -40, -2, -38, -1);
      c.bezierCurveTo(-30, 4, -18, 2, -13, -6);
      c.closePath();
      const wg = c.createLinearGradient(-46, -28, -14, 2);
      wg.addColorStop(0, '#fcfcfc');
      wg.addColorStop(0.55, '#fcfcfc');
      wg.addColorStop(0.80, '#b0c4d8');
      wg.addColorStop(1, '#808c9c');
      c.fillStyle = wg;
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 5;
      c.stroke();
    } else if (name === 'max') {
      // AM_PICKP/3: thick rounded-block staggered cyan M, yellow X, magenta A fused in bold black ink
      const traceM = () => {
        c.beginPath();
        c.moveTo(-44, 12); c.lineTo(-44, -22);
        c.quadraticCurveTo(-44, -34, -35, -34);
        c.quadraticCurveTo(-26, -34, -26, -22);
        c.lineTo(-26, 8);
        c.moveTo(-26, -22);
        c.quadraticCurveTo(-26, -34, -17, -34);
        c.quadraticCurveTo(-8, -34, -8, -22);
        c.lineTo(-8, 12);
      };
      const traceX = () => {
        c.beginPath();
        c.moveTo(4, -26); c.lineTo(46, 14);
        c.moveTo(46, -26); c.lineTo(4, 14);
      };
      const traceA = () => {
        c.beginPath();
        c.moveTo(-16, 40);
        c.lineTo(-16, 12);
        c.quadraticCurveTo(-16, -2, 2, -2);
        c.quadraticCurveTo(20, -2, 20, 12);
        c.lineTo(20, 40);
        c.moveTo(-16, 22);
        c.lineTo(20, 22);
      };

      // Merged outer black silhouette outline across all 3 letters
      setDropShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 22;
      traceM(); c.stroke();
      traceX(); c.stroke();
      traceA(); c.stroke();
      clearShadow();

      // Cyan 'M'
      c.strokeStyle = '#00fcfc';
      c.lineWidth = 10;
      traceM(); c.stroke();

      // Yellow 'X'
      c.strokeStyle = '#fcfc00';
      c.lineWidth = 10;
      traceX(); c.stroke();

      // Magenta 'A' separated cleanly in front of M & X + dark cutout window above crossbar
      c.strokeStyle = '#000000';
      c.lineWidth = 18;
      traceA(); c.stroke();
      c.strokeStyle = '#fc00fc';
      c.lineWidth = 10;
      traceA(); c.stroke();

      poly([[-6, 6], [10, 6], [10, 17], [-6, 17]]);
      c.fillStyle = '#000000';
      c.fill();
      c.strokeStyle = '#000000';
      c.lineWidth = 1;
      c.stroke();
    } else if (name === 'radiation') {
      // AM_PICKP/5: glossy black sphere with 3 golden blades & 3 black gap wedges
      setDropShadow();
      c.beginPath();
      c.arc(0, 0, 48, 0, Math.PI * 2);
      c.fillStyle = '#000000';
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 2.5;
      c.stroke();

      c.save();
      c.beginPath();
      c.arc(0, 0, 42, 0, Math.PI * 2);
      c.clip();
      const rg = c.createRadialGradient(0, 0, 4, 0, 0, 42);
      rg.addColorStop(0, '#ecd800');
      rg.addColorStop(0.62, '#ecd800');
      rg.addColorStop(0.86, '#b09c00');
      rg.addColorStop(1, '#786800');
      c.fillStyle = rg;
      c.fillRect(-44, -44, 88, 88);

      c.fillStyle = '#000000';
      poly([[-6, -2], [-12, -44], [-46, -44], [-46, -2]]); c.fill();
      poly([[6, -2], [12, -44], [46, -44], [46, -2]]); c.fill();
      poly([[-7, 10], [7, 10], [22, 46], [-22, 46]]); c.fill();
      c.restore();
    } else if (name === 'ghost') {
      // AM_PICKP/6: icy translucent cyan-blue friendly sheet ghost with vertical oval eyes & straight mouth
      const drawGhost = () => {
        c.beginPath();
        c.moveTo(-42, 6);
        c.bezierCurveTo(-42, -32, -26, -50, 0, -50);
        c.bezierCurveTo(26, -50, 42, -32, 42, 6);
        c.lineTo(42, 34);
        c.bezierCurveTo(42, 49, 23, 49, 19, 34);
        c.bezierCurveTo(14, 49, -14, 49, -19, 34);
        c.bezierCurveTo(-23, 49, -42, 49, -42, 34);
        c.closePath();
      };
      setDropShadow();
      drawGhost();
      const gg = c.createRadialGradient(0, -10, 6, 0, 0, 52);
      gg.addColorStop(0, '#74bce0');
      gg.addColorStop(0.55, '#64a0c0');
      gg.addColorStop(0.84, '#5088a4');
      gg.addColorStop(1, '#305464');
      c.fillStyle = gg;
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();

      // Tail fold crease shadows
      c.strokeStyle = '#305464';
      c.lineWidth = 3.5;
      for (const tx of [-19, 19]) {
        c.beginPath();
        c.moveTo(tx, 26);
        c.lineTo(tx, 37);
        c.stroke();
      }

      // Two tall oval black eyes + clean flat straight ghost mouth matching AM_PICKP/6
      c.fillStyle = '#000000';
      for (const ex of [-14, 14]) {
        c.beginPath();
        c.ellipse(ex, -11, 5.2, 8.8, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.beginPath();
      c.moveTo(-20, 14);
      c.lineTo(20, 14);
      c.stroke();
    } else if (name === 'orb') {
      // AM_PICKP/7: glossy pitch-black sphere with glowing golden-yellow core inside
      setDropShadow();
      c.beginPath();
      c.arc(0, 0, 48, 0, Math.PI * 2);
      c.fillStyle = '#000000';
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 3;
      c.stroke();

      // Graphite inner shell halo (#202428) + glowing golden core (#ecd800 -> #b09c00 -> #786800)
      c.beginPath();
      c.arc(0, 0, 31, 0, Math.PI * 2);
      const og = c.createRadialGradient(0, -1, 4, 0, 0, 31);
      og.addColorStop(0, '#ecd800');
      og.addColorStop(0.55, '#ecd800');
      og.addColorStop(0.76, '#b09c00');
      og.addColorStop(0.90, '#786800');
      og.addColorStop(1, '#202428');
      c.fillStyle = og;
      c.fill();
    } else if (name === 'ignitor') {
      // AM_PICKP/8: brown T-handle, metallic plunger shaft, steel detonator box with wire stub
      c.strokeStyle = '#000000';
      c.lineWidth = 8;
      c.beginPath();
      c.moveTo(32, 36);
      c.lineTo(48, 41);
      c.stroke();
      c.strokeStyle = '#58606c';
      c.lineWidth = 3.2;
      c.beginPath();
      c.moveTo(34, 37);
      c.lineTo(48, 41);
      c.stroke();

      // Main slate-steel box (with crisp 3D bevel highlight along top/left inner edges)
      setDropShadow();
      rRect(-34, -5, 68, 52, 5);
      const boxG = c.createLinearGradient(-34, -5, 34, 47);
      boxG.addColorStop(0, '#808c9c');
      boxG.addColorStop(0.45, '#6c7480');
      boxG.addColorStop(1, '#444850');
      c.fillStyle = boxG;
      c.fill();
      clearShadow();

      c.save();
      rRect(-34, -5, 68, 52, 5);
      c.clip();
      const bevG = c.createLinearGradient(-29, 0, 26, 42);
      bevG.addColorStop(0, '#fcfcfc');
      bevG.addColorStop(0.35, '#808c9c');
      bevG.addColorStop(1, 'rgba(128, 140, 156, 0)');
      c.strokeStyle = bevG;
      c.lineWidth = 4.5;
      c.beginPath();
      c.moveTo(-29, 42);
      c.lineTo(-29, 0);
      c.lineTo(26, 0);
      c.stroke();
      c.restore();

      rRect(-34, -5, 68, 52, 5);
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();

      c.fillStyle = '#fcfcfc';
      c.beginPath();
      c.arc(-26, 3, 2.8, 0, Math.PI * 2);
      c.fill();

      // Metallic plunger shaft
      rRect(-8, -28, 16, 24, 2);
      const shG = c.createLinearGradient(-8, -16, 8, -16);
      shG.addColorStop(0, '#808c9c');
      shG.addColorStop(0.55, '#58606c');
      shG.addColorStop(1, '#444850');
      c.fillStyle = shG;
      c.fill();
      c.strokeStyle = '#000000';
      c.lineWidth = 4.5;
      c.stroke();

      // Earthy brown wooden T-handle bar
      setDropShadow();
      rRect(-27, -49, 54, 20, 4);
      const thG = c.createLinearGradient(0, -49, 0, -29);
      thG.addColorStop(0, '#986c6c');
      thG.addColorStop(0.35, '#805854');
      thG.addColorStop(0.75, '#64483c');
      thG.addColorStop(1, '#483828');
      c.fillStyle = thG;
      c.fill();
      clearShadow();
      c.strokeStyle = '#000000';
      c.lineWidth = 5.5;
      c.stroke();
    }

    c.restore();
    const entry = { canvas: out, size: S };
    this._pickupCache.set(name, entry);
    if (!this.q?.fastFx) promoteSmallImg(out, im => { if (this._pickupCache.get(name) === entry) entry.canvas = im; });
    return entry;
  }

  /**
   * Shared centered supersampled sprite builder/cache with standard drawing helpers.
   */
  _cachedHdSprite(cache, key, paintFn, S = 128, scale = 1) {
    const hit = cache.get(key);
    if (hit && isDrawableOk(hit.canvas)) return hit;
    const [out, c] = this._mkCanvas(S, S);
    if (!c) return null;
    c.save();
    c.translate(S / 2, S / 2);
    if (scale !== 1) c.scale(scale, scale);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    paintFn(c);
    c.restore();
    const entry = { canvas: out, size: S };
    cache.set(key, entry);
    if (!this.q?.fastFx) promoteSmallImg(out, im => { if (cache.get(key) === entry) entry.canvas = im; });
    return entry;
  }

  /**
   * Pre-render and cache a crisp 128x128 supersampled cauldron bomb sprite faithful to original AM_FIRE/0..17.
   * kind: 'fire' | 'electric' | 'magic', frameIdx: 0..5.
   */
  getBombSprite(kind = 'fire', frameIdx = 0) {
    const k = (kind === 'electric' || kind === 'magic') ? kind : 'fire';
    const fi = ((frameIdx | 0) % 6 + 6) % 6;
    if (!this._bombCache) this._bombCache = new Map();
    return this._cachedHdSprite(this._bombCache, `${k}:${fi}`, c => {
      const ph = (fi / 6) * Math.PI * 2;
      const flick = fxHash(fi + (k === 'electric' ? 31 : k === 'magic' ? 71 : 11), 9);
      c.lineCap = 'round';
      c.lineJoin = 'round';

      // Open dark charred cauldron throat behind front rim (y = -14)
      c.beginPath();
      c.ellipse(0, -14, 31, 6.0, 0, 0, Math.PI * 2);
      c.fillStyle = '#070404';
      c.fill();
      c.beginPath();
      c.ellipse(0, -13.5, 25, 4.2, 0, 0, Math.PI * 2);
      c.fillStyle = k === 'electric' ? '#1e4260' : k === 'magic' ? '#24143a' : '#421604';
      c.fill();

      // 1. Hand-thrown dark terracotta earthenware cauldron (authentic AM_FIRE/0..17 silhouette & warm ceramic grain)
      const tracePot = () => {
        c.beginPath();
        c.moveTo(-34, -15);
        c.lineTo(34, -15);
        c.quadraticCurveTo(37.5, -10, 29, -5.5);
        c.bezierCurveTo(28.5, -0.5, 34, 3.5, 38.5, 8.5);
        c.bezierCurveTo(47.5, 19.5, 46, 40.5, 29, 50.5);
        c.quadraticCurveTo(0, 54.5, -29, 50.5);
        c.bezierCurveTo(-46, 40.5, -47.5, 19.5, -38.5, 8.5);
        c.bezierCurveTo(-34, 3.5, -28.5, -0.5, -29, -5.5);
        c.quadraticCurveTo(-37.5, -10, -34, -15);
        c.closePath();
      };
      tracePot();
      const potG = c.createRadialGradient(-15, 18, 4, 4, 24, 54);
      potG.addColorStop(0.0, '#a46a54');
      potG.addColorStop(0.36, '#7e4c3c');
      potG.addColorStop(0.72, '#573328');
      potG.addColorStop(1.0, '#301b15');
      c.fillStyle = potG;
      c.fill();

      c.save();
      tracePot();
      c.clip();
      // Subtle kiln-fired stoneware mineral speckles for tactile ceramic realism
      for (let m = 0; m < 18; m++) {
        const mx = (fxHash(17, m * 2) - 0.5) * 76;
        const my = -4 + fxHash(29, m * 2 + 1) * 54;
        const mr = 1.1 + fxHash(41, m) * 2.2;
        c.fillStyle = (m & 1) ? 'rgba(32, 16, 12, 0.24)' : 'rgba(218, 164, 134, 0.14)';
        c.beginPath(); c.arc(mx, my, mr, 0, Math.PI * 2); c.fill();
      }
      // Flared stoneware rim bevel & deep under-lip shadow shelf
      const lipG = c.createLinearGradient(-35, 0, 35, 0);
      lipG.addColorStop(0.0, '#ac725c');
      lipG.addColorStop(0.45, '#865242');
      lipG.addColorStop(1.0, '#5a362b');
      c.fillStyle = lipG;
      c.fillRect(-38, -16, 76, 10.5);

      const neckG = c.createLinearGradient(0, -6, 0, 7);
      neckG.addColorStop(0.0, 'rgba(22, 10, 8, 0.82)');
      neckG.addColorStop(0.55, 'rgba(36, 18, 14, 0.42)');
      neckG.addColorStop(1.0, 'rgba(36, 18, 14, 0)');
      c.fillStyle = neckG;
      c.fillRect(-38, -6, 76, 13);

      // Subtle ceramic belly specular reflection + bottom bounce shadow
      c.fillStyle = 'rgba(232, 178, 148, 0.22)';
      c.beginPath();
      c.ellipse(-20, 22, 8.5, 15, -0.28, 0, Math.PI * 2);
      c.fill();

      // Dynamic per-frame bounced light from the boiling contents onto the upper clay belly & lip!
      const lx = Math.sin(ph) * 10;
      const bounceCol = k === 'electric'
        ? `rgba(128, 208, 255, ${0.26 + flick * 0.16})`
        : k === 'magic'
          ? `rgba(${fi % 2 ? '0, 252, 252' : '252, 0, 252'}, ${0.22 + flick * 0.12})`
          : `rgba(255, 148, 36, ${0.24 + flick * 0.16})`;
      const rimBounce = c.createRadialGradient(lx, -12, 2, lx, -4, 34);
      rimBounce.addColorStop(0.0, bounceCol);
      rimBounce.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      c.fillStyle = rimBounce;
      c.fillRect(-44, -18, 88, 36);
      c.restore();

      tracePot();
      c.strokeStyle = '#080504';
      c.lineWidth = 5.6;
      c.stroke();

      c.strokeStyle = 'rgba(0, 0, 0, 0.62)';
      c.lineWidth = 2.0;
      c.beginPath(); c.moveTo(-29, -5.5); c.quadraticCurveTo(0, -3.2, 29, -5.5); c.stroke();

      // 2. Dynamic erupting cauldron substance (fire / electric / magic) faithful to AM_FIRE/0..17
      if (k === 'fire') {
        const s1 = Math.sin(ph) * 6.5, s2 = Math.cos(ph) * 5.2;
        const flareR = 26 + flick * 6;
        const mouthG = c.createRadialGradient(s1 * 0.25, -20, 2, 0, -24, flareR);
        mouthG.addColorStop(0.0, 'rgba(252, 252, 60, 0.56)');
        mouthG.addColorStop(0.55, 'rgba(252, 112, 0, 0.34)');
        mouthG.addColorStop(1.0, 'rgba(196, 48, 0, 0)');
        c.fillStyle = mouthG;
        c.beginPath(); c.ellipse(0, -21, 32, 18, 0, 0, Math.PI * 2); c.fill();

        // Asymmetric roaring 3-tongue eruption with churning hot core & charred outline
        const leanL = -4 + Math.sin(ph + 1.1) * 5.5;
        const leanC = s1 * 0.72;
        const leanR = 5 + Math.cos(ph + 2.2) * 5.5;
        const hC = -53 - Math.abs(Math.sin(ph)) * 5.5;
        const hL = -39 - ((fi % 2) ? 5 : 0);
        const hR = -41 - ((fi % 3 === 0) ? 5 : 0);

        const traceRoar = () => {
          c.beginPath();
          c.moveTo(-26, -14);
          c.bezierCurveTo(-33, -25, -25 + s2 * 0.4, -36, -16 + leanL * 0.5, hL);
          c.bezierCurveTo(-13, hL + 8, -11, -30, -9, -31);
          c.bezierCurveTo(-13, -44, -5 + leanC * 0.6, hC + 4, leanC * 0.45, hC);
          c.bezierCurveTo(7 + leanC * 0.5, hC + 6, 11, -35, 10, -29);
          c.bezierCurveTo(14, -35, 16 + leanR * 0.4, hR - 2, 18 + leanR * 0.35, hR + 2);
          c.bezierCurveTo(28, -32, 31, -22, 26, -14);
          c.quadraticCurveTo(0, -11, -26, -14);
          c.closePath();
        };
        traceRoar();
        c.strokeStyle = '#180500'; c.lineWidth = 4.6; c.stroke();
        const fG = c.createLinearGradient(0, -56, 0, -12);
        fG.addColorStop(0.0, '#fc7c00');
        fG.addColorStop(0.55, '#e85800');
        fG.addColorStop(1.0, '#a82600');
        c.fillStyle = fG; c.fill();

        // Churning inner gold-yellow magma tongues
        c.beginPath();
        c.moveTo(-19, -14);
        c.bezierCurveTo(-22, -25, -13 + leanL * 0.35, -36, -7, -28);
        c.bezierCurveTo(-9, -40, -3 + leanC * 0.5, -49, leanC * 0.35, hC + 7);
        c.bezierCurveTo(6 + leanC * 0.4, -44, 11, -33, 12, -29);
        c.bezierCurveTo(17, -33, 22, -23, 19, -14);
        c.quadraticCurveTo(0, -11.5, -19, -14);
        c.closePath();
        c.fillStyle = '#fcfc00'; c.fill();

        // Blazing white-hot ember heart shifting organically per frame
        c.fillStyle = '#fcfcfc';
        c.beginPath();
        c.ellipse(leanC * 0.25, -22, 7.5 + flick * 2.5, 9.0, Math.sin(ph) * 0.25, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.arc(leanL * 0.65 - 11, -22, 3.2, 0, Math.PI * 2);
        c.arc(leanR * 0.6 + 11, -23, 3.0, 0, Math.PI * 2);
        c.fill();

        // Glowing rim ember reflections + detached rising cinders
        c.strokeStyle = 'rgba(252, 184, 56, 0.72)';
        c.lineWidth = 2.6;
        c.beginPath(); c.moveTo(-25, -15); c.quadraticCurveTo(0, -12, 25, -15); c.stroke();

        for (let sp = 0; sp < 4; sp++) {
          const sx = (sp - 1.5) * 14 + Math.sin(ph + sp * 2.1) * 6;
          const sy = -41 - ((fi + sp * 2) % 6) * 2.8;
          this._sparkDot(c, sx, sy, 2.0 + (sp & 1) * 0.8, sp % 2 ? '#fcfc00' : '#fc7c00', '#180500');
        }
      } else if (k === 'electric') {
        // AM_FIRE/6..11 fidelity: churning blinding white-cyan plasma froth spilling OVER rim onto cauldron walls
        const j1 = Math.sin(ph) * 7, j2 = Math.cos(ph * 2) * 6;
        const poolG = c.createRadialGradient(0, -19, 3, 0, -21, 34);
        poolG.addColorStop(0.0, 'rgba(252, 252, 252, 0.92)');
        poolG.addColorStop(0.45, 'rgba(116, 188, 224, 0.65)');
        poolG.addColorStop(1.0, 'rgba(32, 118, 196, 0)');
        c.fillStyle = poolG;
        c.beginPath(); c.ellipse(0, -21, 33, 17, 0, 0, Math.PI * 2); c.fill();

        // Thick foaming plasma arc cloud surging out of throat
        const cloudA = this._jaggedSpan(-22, -16, 22, -16, 6, 7.5, fi * 13 + 3);
        const cloudB = this._jaggedSpan(-15, -18, 17 + j1 * 0.5, -42 + j2 * 0.4, 7, 8.0, fi * 19 + 5);
        this._strokeElectricPts(c, cloudA, 1.05, 0.98, 0.65);
        this._strokeElectricPts(c, cloudB, 0.95, 1.0, 0.62);

        // Overflowing electrical bolts crawling down the clay rim and pot walls (key signature of AM_FIRE/6..11!)
        const spillL = this._jaggedSpan(-19 + j1 * 0.3, -17, -28 + (fi & 1) * 4, 2 + (fi % 3) * 5, 6, 4.5, fi * 23 + 7);
        const spillR = this._jaggedSpan(17 + j2 * 0.3, -17, 26 - (fi & 1) * 4, 0 + ((fi + 1) % 3) * 5, 6, 4.5, fi * 29 + 11);
        const crest = this._jaggedSpan(-4 + j2 * 0.3, -24, j1 * 0.9, -51, 7, 7.2, fi * 37 + 13);
        this._strokeElectricPts(c, spillL, 0.80, 0.96, 0.65);
        this._strokeElectricPts(c, spillR, 0.80, 0.96, 0.65);
        this._strokeElectricPts(c, crest, 0.88, 1.0, 0.62);

        // White-hot frothy plasma discharge nucleus sitting across lip
        c.fillStyle = '#fcfcfc';
        c.beginPath();
        c.ellipse(j1 * 0.3, -20, 12 + flick * 3, 6.5, Math.sin(ph) * 0.2, 0, Math.PI * 2);
        c.fill();

        // Sharp snapping peripheral sparks (AM_FIRE/6..11)
        const sparks = [
          [-38 + j1 * 0.5, -29 - j2 * 0.3, 6.4, '#74bce0'],
          [38 - j2 * 0.5, -27 + j1 * 0.3, 6.4, '#fcfcfc'],
          [-29 - j2 * 0.4, -44 + j1 * 0.3, 5.5, '#fcfcfc'],
          [30 + j1 * 0.4, -42 - j2 * 0.3, 5.8, '#74bce0'],
          [-43, -4 + j1 * 0.4, 4.6, '#74bce0'],
          [43, -5 - j2 * 0.4, 4.6, '#fcfcfc'],
        ];
        for (let i = 0; i < sparks.length; i++) {
          const [sx, sy, sr, scol] = sparks[i];
          if ((i + fi) % 2 === 0) this._sparkleCross(c, sx, sy, sr * 1.15, scol, { aspect: 0.78, waist: 0.24, glow: 0.30, outline: '#061428' });
          else this._sparkDot(c, sx, sy, sr * 0.62, scol, '#061428');
        }
      } else {
        // AM_FIRE/12..17 fidelity: bubbling iridescent potion froth + dynamic burst of sharp crystal shards & flares
        const mist = c.createRadialGradient(0, -22, 2, 0, -24, 35);
        mist.addColorStop(0.0, 'rgba(252, 252, 252, 0.55)');
        mist.addColorStop(0.35, 'rgba(0, 252, 252, 0.40)');
        mist.addColorStop(0.7, 'rgba(252, 0, 252, 0.26)');
        mist.addColorStop(1.0, 'rgba(116, 188, 224, 0)');
        c.fillStyle = mist;
        c.beginPath(); c.ellipse(0, -22, 34, 20, 0, 0, Math.PI * 2); c.fill();

        // Frothy overflowing potion lip + dynamic jewel bubbles across rim
        const palette = ['#00fcfc', '#fc00fc', '#fcfc00', '#74bce0', '#fcfcfc'];
        for (let b = 0; b < 5; b++) {
          const bx = -18 + b * 9 + Math.sin(ph + b * 1.4) * 3.5;
          const by = -16 - Math.abs(Math.cos(ph + b)) * 4;
          const bCol = palette[(fi + b) % 4];
          c.strokeStyle = '#0a0416'; c.lineWidth = 2.6;
          c.beginPath(); c.arc(bx, by, 4.2, 0, Math.PI * 2); c.stroke();
          c.fillStyle = bCol;
          c.beginPath(); c.arc(bx, by, 4.2, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#fcfcfc';
          c.beginPath(); c.arc(bx - 1.2, by - 1.2, 1.4, 0, Math.PI * 2); c.fill();
        }

        // Dynamic erupting diamond shards & flares rising out of potion mouth
        for (let g = 0; g < 7; g++) {
          const seed = fi * 13 + g * 5;
          const h0 = fxHash(seed, 1), h1 = fxHash(seed, 2), h2 = fxHash(seed, 3);
          const gx = (h0 - 0.5) * 52;
          const gy = -22 - h1 * 28;
          const col = palette[(g + fi) % 4];
          if (g % 3 === 0) {
            this._sparkleCross(c, gx, gy, 8.2 + h2 * 4.5, col, { aspect: 0.68, waist: 0.20, glow: 0.34, outline: 'rgba(10, 4, 22, 0.88)' });
          } else if (g % 3 === 1) {
            this._glintV(c, gx, gy, 9.5 + h2 * 4.0, col, 'rgba(10, 4, 22, 0.86)');
          } else {
            this._sparkDot(c, gx, gy, 3.0 + h2 * 1.4, col, 'rgba(10, 4, 22, 0.88)');
          }
        }
      }
    });
  }

  /** Crisp 4-point cross sparkle (+) with bright #fcfcfc center core matching original EXP_MAGI / TH_MAGI / DE_MAGIC. */
  _sparkleCross(ctx, x, y, r, col, opts = {}) {
    const ry = r, rx = r * (opts.aspect ?? 0.62);
    const wy = r * (opts.waist ?? 0.16), wx = r * (opts.waist ?? 0.16);
    const alpha = opts.alpha ?? 1;
    const glow = opts.glow ?? 0.28;
    const outline = opts.outline === undefined ? 'rgba(8, 4, 20, 0.72)' : opts.outline;
    const trace = s => {
      ctx.beginPath();
      ctx.moveTo(x, y - ry * s);
      ctx.lineTo(x + wx * s, y - wy * s);
      ctx.lineTo(x + rx * s, y);
      ctx.lineTo(x + wx * s, y + wy * s);
      ctx.lineTo(x, y + ry * s);
      ctx.lineTo(x - wx * s, y + wy * s);
      ctx.lineTo(x - rx * s, y);
      ctx.lineTo(x - wx * s, y - wy * s);
      ctx.closePath();
    };
    ctx.save();
    if (alpha < 1) ctx.globalAlpha *= alpha;
    if (glow > 0) {
      const gl = this.glow(col);
      if (isDrawableOk(gl)) {
        const prevA = ctx.globalAlpha, rad = r * 1.45;
        ctx.globalAlpha = prevA * glow;
        ctx.drawImage(gl, x - rad, y - rad, rad * 2, rad * 2);
        ctx.globalAlpha = prevA;
      }
    }
    trace(1);
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(1.3, r * 0.24);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.fillStyle = col;
    ctx.fill();
    if (opts.core !== false) {
      trace(0.45);
      ctx.fillStyle = '#fcfcfc';
      ctx.fill();
    }
    ctx.restore();
  }

  /** Slim vertical shimmer glint matching FRACAS EXP_MAGI vertical bars. */
  _glintV(ctx, x, y, len, col, outline = 'rgba(8, 4, 20, 0.72)') {
    const hw = Math.max(1.1, len * 0.16), hh = len * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y); ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
    ctx.closePath();
    if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke(); }
    ctx.fillStyle = col; ctx.fill();
    ctx.fillStyle = '#fcfcfc';
    ctx.beginPath();
    ctx.moveTo(x, y - hh * 0.45); ctx.lineTo(x + hw * 0.55, y); ctx.lineTo(x, y + hh * 0.45); ctx.lineTo(x - hw * 0.55, y);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** Crisp diamond pinpoint dust speck. */
  _sparkDot(ctx, x, y, r, col, outline = 'rgba(8, 4, 20, 0.75)') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
    if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.stroke(); }
    ctx.fillStyle = col; ctx.fill();
    ctx.restore();
  }

  /** Deterministic jagged lightning span between fixed endpoints (x0,y0) -> (x1,y1). */
  _jaggedSpan(x0, y0, x1, y1, stepLen, amp, seed) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (L < 1e-3) return [[x0, y0], [x1, y1]];
    const n = Math.max(2, Math.round(L / stepLen));
    const tx = dx / L, ty = dy / L, nx = -ty, ny = tx;
    const pts = [[x0, y0]];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const j = (fxHash(seed, i) - 0.5) * 2 * amp;
      const along = (fxHash(seed + 97, i) - 0.5) * stepLen * 0.25;
      pts.push([x0 + dx * f + tx * along + nx * j, y0 + dy * f + ty * along + ny * j]);
    }
    pts.push([x1, y1]);
    return pts;
  }

  /** Layered Fracas electric stroke: contrast sheath + #64a0c0 + #74bce0 + #fcfcfc hot core. */
  _strokeElectricPts(ctx, pts, scale = 1, alpha = 1, sheathAlpha = 0.48) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (sheathAlpha > 0) {
      ctx.strokeStyle = `rgba(32, 148, 224, ${0.26 * alpha})`;
      ctx.lineWidth = 10.0 * scale;
      ctx.stroke();
      ctx.strokeStyle = `rgba(4, 16, 38, ${sheathAlpha * alpha})`;
      ctx.lineWidth = 6.8 * scale;
      ctx.stroke();
    }
    ctx.strokeStyle = '#64a0c0'; ctx.globalAlpha = 0.94 * alpha; ctx.lineWidth = 4.9 * scale; ctx.stroke();
    ctx.strokeStyle = '#74bce0'; ctx.globalAlpha = 1.0 * alpha; ctx.lineWidth = 3.1 * scale; ctx.stroke();
    ctx.strokeStyle = '#fcfcfc'; ctx.globalAlpha = 1.0 * alpha; ctx.lineWidth = 1.5 * scale; ctx.stroke();
    ctx.restore();
  }

  /** Vector TH_ELEC writhing ball-lightning torus with vigorous snapping interior filaments. */
  _drawElectricOrb(ctx, wx, wy, r, t, seed = 1) {
    if (this.q?.fastFx) {
      this.sprAt(ctx, 'TH_ELEC/' + (Math.floor(t * 18 + seed) & 7), wx - 0.5, wy - 0.5);
      return;
    }
    const cx = wx * T, cy = wy * T, snap = Math.floor(t * 24);
    ctx.save();
    const glow = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r * 1.9);
    glow.addColorStop(0, 'rgba(252, 252, 252, 0.44)');
    glow.addColorStop(0.45, 'rgba(116, 188, 224, 0.36)');
    glow.addColorStop(1, 'rgba(24, 124, 224, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2); ctx.fill();

    // Organic jagged outer plasma ring (churning TH_ELEC/0..7 ring instead of rigid wireframe)
    const segs = 12;
    const ringPts = [];
    for (let i = 0; i <= segs; i++) {
      const k = i % segs;
      const a = (k / segs) * Math.PI * 2 + t * 2.4;
      const jit = (fxHash(snap * 13 + seed, k) - 0.5) * r * 0.30;
      const rad = r * 0.88 + jit;
      ringPts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
    this._strokeElectricPts(ctx, ringPts, 0.92, 0.98, 0.58);

    // Bold writhing internal filaments jumping unpredictably across the orb cavity
    for (let s = 0; s < 3; s++) {
      const a0 = fxHash(snap * 19 + seed, s * 3) * Math.PI * 2;
      const a1 = a0 + 1.8 + fxHash(snap * 23 + seed, s * 3 + 1) * 2.4;
      const sx = cx + Math.cos(a0) * r * 0.84, sy = cy + Math.sin(a0) * r * 0.84;
      const ex = cx + Math.cos(a1) * r * 0.84, ey = cy + Math.sin(a1) * r * 0.84;
      this._strokeElectricPts(ctx, this._jaggedSpan(sx, sy, ex, ey, 5.5, 4.8, snap * 29 + s * 11 + seed), 0.72, 0.98, 0.46);
    }
    for (let p = 0; p < 3; p++) {
      const pa = t * 6.5 + p * 2.1 + seed;
      this._sparkDot(ctx, cx + Math.cos(pa) * r * 1.08, cy + Math.sin(pa) * r * 1.08, 2.3, '#fcfcfc', '#061428');
    }
    ctx.restore();
  }

  /** Vector TH_MAGI dancing prism sparkle cluster matching EXP_MAGI/TH_MAGI. */
  _drawMagicCluster(ctx, wx, wy, r, t, seed = 1) {
    if (this.q?.fastFx) {
      this.sprAt(ctx, 'TH_MAGI/' + (Math.floor(t * 18 + seed) % 9), wx - 0.5, wy - 0.5);
      return;
    }
    const cx = wx * T, cy = wy * T;
    const cols = ['#00fcfc', '#fc00fc', '#fcfc00', '#74bce0'];
    ctx.save();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.6);
    g.addColorStop(0, 'rgba(252, 252, 252, 0.44)');
    g.addColorStop(0.55, 'rgba(0, 252, 252, 0.28)');
    g.addColorStop(1, 'rgba(252, 0, 252, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2); ctx.fill();

    const base = t * 8.2 + seed;
    for (let i = 0; i < 4; i++) {
      const a = base + (i * Math.PI * 2) / 4;
      const ox = Math.cos(a * 1.1) * r * 0.48, oy = Math.sin(a * 1.4 + i) * r * 0.44;
      const col = cols[(i + Math.floor(t * 11 + seed)) % cols.length];
      if (i % 2 === 0) this._sparkleCross(ctx, cx + ox, cy + oy, r * (i === 0 ? 0.66 : 0.48), col, { glow: 0.30, outline: 'rgba(8, 4, 20, 0.88)' });
      else this._glintV(ctx, cx + ox, cy + oy, r * 0.82, col, 'rgba(8, 4, 20, 0.88)');
    }
    this._sparkDot(ctx, cx - Math.cos(base * 1.4) * r * 0.72, cy + Math.sin(base * 1.9) * r * 0.55, 2.6, '#fcfcfc', 'rgba(8, 4, 20, 0.85)');
    ctx.restore();
  }

  /** Smooth HD holographic prism phase dematerialization / rematerialization during teleport. */
  _drawTeleportBody(ctx, e, sprKey, bx, by, fx, fy, sc = 1, baseAlpha = 1) {
    const t = this.time;
    const tpFrac = e.tpDur ? Math.max(0, Math.min(1, 1 - (e.tpTimer || 0) / e.tpDur)) : 0.5;
    const isHide = e.tpPhase === 'hide';
    const phase = isHide ? tpFrac : (1 - tpFrac); // 0 = solid, 1 = dematerialized
    const bodyAlpha = baseAlpha * Math.max(0.06, 1 - Math.pow(phase, 1.35) * 0.94);
    const lift = Math.sin(phase * Math.PI * 0.5) * 6 * sc;
    const shear = Math.sin(t * 48 + (e.id | 0)) * 2.2 * phase;
    const sep = (1.2 + 3.4 * phase) * sc;
    const bodySc = sc * (isHide ? 1 - phase * 0.08 : 0.86 + (1 - phase) * 0.14);

    if (phase > 0.08) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = baseAlpha * Math.sin(phase * Math.PI) * 0.55;
      this.charSpr(ctx, sprKey, bx - sep + shear, by - lift, fx, fy, bodySc, 'tpCyan');
      this.charSpr(ctx, sprKey, bx + sep + shear, by - lift, fx, fy, bodySc, 'tpMag');
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = bodyAlpha;
    this.charSpr(ctx, sprKey, bx + shear * 0.4, by - lift, fx, fy, bodySc);
    if (phase > 0.55) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = baseAlpha * Math.sin(Math.min(1, (phase - 0.55) / 0.45) * Math.PI) * 0.45;
      this.charSpr(ctx, sprKey, bx + shear * 0.4, by - lift, fx, fy, bodySc, 'flash');
    }
    ctx.restore();
  }

  /** Ground sigils & back-hemisphere glow behind HD wizards for invulnerability, radiation, and shields. */
  _drawWizardStatusAurasBack(ctx, p, x, y, t) {
    const cx = x * T, fy = (y + 0.36) * T;
    if (p.invuln > 0) {
      const fade = Math.min(1, p.invuln / 0.55);
      const warn = p.invuln < 0.9 ? (0.45 + 0.55 * Math.sin(t * 24)) : 1;
      const a = fade * warn;
      const tm = TEAM[p.slot] || TEAM[0];
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.addGlow(ctx, tm.light, x, y + 0.04, 0.72, 0.24 * a);
      ctx.globalAlpha = 0.55 * a;
      ctx.strokeStyle = tm.light; ctx.lineWidth = 2.0;
      ctx.beginPath(); ctx.ellipse(cx, fy, 0.38 * T, 0.13 * T, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (p.radiation > 0) {
      const fade = Math.min(1, p.radiation / 0.45);
      const warn = p.radiation < 1.5 ? (0.42 + 0.58 * Math.sin(t * 22)) : 1;
      const a = fade * warn;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.addGlow(ctx, '#ffd400', x, y + 0.06, 0.85, 0.30 * a);
      ctx.globalAlpha = 0.78 * a;
      // Rotating golden hazard containment floor sigil
      ctx.strokeStyle = '#ffe840'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.ellipse(cx, fy, 0.43 * T, 0.15 * T, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#ff9c18'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.ellipse(cx, fy, 0.34 * T, 0.115 * T, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      for (let k = 0; k < 3; k++) {
        const ang0 = t * 2.6 + k * ((Math.PI * 2) / 3);
        ctx.strokeStyle = '#fff394'; ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.ellipse(cx, fy, 0.40 * T, 0.14 * T, 0, ang0, ang0 + 0.85);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _getAuraSprite(key, rx, ry, colMid) {
    if (!this._auraCache) this._auraCache = new Map();
    const ck = `${key}:${Math.round(rx)}:${Math.round(ry)}`;
    const hit = this._auraCache.get(ck);
    if (isDrawableOk(hit)) return hit;
    const w = Math.ceil(rx * 2 + 8), h = Math.ceil(ry * 2 + 8);
    const [c, x] = this._mkCanvas(w, h);
    if (x) {
      const cx = w / 2, cy = h / 2;
      const gr = x.createRadialGradient(cx - rx * 0.22, cy - ry * 0.25, rx * 0.15, cx, cy, ry);
      if (key === 'rad') {
        gr.addColorStop(0, 'rgba(255, 220, 60, 0)');
        gr.addColorStop(0.60, 'rgba(255, 210, 40, 0.08)');
        gr.addColorStop(0.86, 'rgba(255, 196, 36, 0.36)');
        gr.addColorStop(1, 'rgba(255, 248, 165, 0.72)');
      } else {
        gr.addColorStop(0, 'rgba(255, 255, 255, 0)');
        gr.addColorStop(0.62, 'rgba(200, 238, 255, 0.05)');
        gr.addColorStop(0.86, colMid + '42');
        gr.addColorStop(1, '#ffffffaa');
      }
      x.fillStyle = gr;
      x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.fill();
    }
    this._auraCache.set(ck, c);
    return c;
  }

  /** Front Fresnel shells, orbiting energy ribbons & specular crescents over HD wizards. */
  _drawWizardStatusAurasFront(ctx, p, x, y, t, dt) {
    const cx = x * T, cy = (y - 0.06) * T, fast = !!this.q?.fastFx;
    if (p.invuln > 0) {
      const fade = Math.min(1, p.invuln / 0.55);
      const warn = p.invuln < 0.9 ? (0.45 + 0.55 * Math.sin(t * 24)) : 1;
      const a = fade * warn;
      const tm = TEAM[p.slot] || TEAM[0];
      const rx = 0.40 * T, ry = 0.55 * T;
      ctx.save();
      if (!fast) ctx.globalCompositeOperation = 'lighter';
      if (!fast) {
        const aura = this._getAuraSprite(`inv_${p.slot}`, rx, ry, tm.light);
        if (isDrawableOk(aura)) {
          ctx.globalAlpha = a * 0.85;
          ctx.drawImage(aura, cx - aura.width / 2, cy - aura.height / 2);
        }
      }
      ctx.strokeStyle = tm.light; ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.52 * a;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      if (!fast) {
        // Top-left Fresnel specular crescent matching world light [-0.55, -0.62]
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.0; ctx.lineCap = 'round';
        ctx.globalAlpha = 0.58 * a;
        ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.88, ry * 0.88, 0, Math.PI * 1.12, Math.PI * 1.46); ctx.stroke();
        // Rotating sanctuary halo orbit around waist
        const orbA = t * 3.4 + p.slot;
        ctx.globalAlpha = 0.65 * a;
        ctx.strokeStyle = '#e8f8ff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(cx, cy + 0.12 * T, rx * 0.96, 0.11 * T, 0.12, orbA, orbA + 2.2); ctx.stroke();
      }
      ctx.restore();
    }
    if (p.radiation > 0) {
      const fade = Math.min(1, p.radiation / 0.45);
      const warn = p.radiation < 1.5 ? (0.42 + 0.58 * Math.sin(t * 22)) : 1;
      const a = fade * warn;
      const rx = (p.invuln > 0 ? 0.47 : 0.43) * T, ry = (p.invuln > 0 ? 0.60 : 0.57) * T;
      ctx.save();
      if (!fast) ctx.globalCompositeOperation = 'lighter';
      if (!fast) {
        const aura = this._getAuraSprite('rad', rx, ry, '#ffe650');
        if (isDrawableOk(aura)) {
          ctx.globalAlpha = a * 0.92;
          ctx.drawImage(aura, cx - aura.width / 2, cy - aura.height / 2);
        }
      }
      ctx.strokeStyle = p.radiation < 1.5 ? '#ff9428' : '#ffe650'; ctx.lineWidth = 2.0;
      ctx.globalAlpha = 0.62 * a;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      // Two counter-tilted orbiting energy arcs
      for (let i = 0; i < (fast ? 1 : 2); i++) {
        const ang0 = t * (i === 0 ? 4.2 : -3.5) + i * 2.0;
        ctx.strokeStyle = i === 0 ? '#fff6a0' : '#ffb428';
        ctx.lineWidth = 2.0;
        ctx.globalAlpha = 0.72 * a;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx * 0.96, 0.15 * T, i === 0 ? 0.28 : -0.28, ang0, ang0 + 2.1);
        ctx.stroke();
      }
      if (Math.random() < dt * 10 * this.q.particles) {
        const ang = Math.random() * Math.PI * 2;
        this.particles.push({
          k: 'spark',
          x: x + Math.cos(ang) * 0.36,
          y: y + Math.sin(ang) * 0.28 - 0.06,
          vx: Math.cos(ang + 1.5) * 0.35,
          vy: -0.45 - Math.random() * 0.45,
          t: 0, life: 0.36, s: 0.065,
          c: Math.random() < 0.5 ? '#fff288' : '#ffb820',
        });
      }
      ctx.restore();
    }
    if (p.shields > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#7ce2ff'; ctx.lineWidth = 2.2;
      ctx.globalAlpha = 0.55 + Math.sin(t * 8) * 0.25;
      ctx.beginPath(); ctx.ellipse(cx, cy, 0.42 * T, 0.54 * T, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  /** Shared tight crackling arcs drawn over shocked/electrocuted character bodies. */
  _drawBodyShock(ctx, wx, wy, seed = 1, radiusScale = 1) {
    const cx = wx * T, cy = (wy - 0.14) * T;
    const snap = Math.floor(this.time * 24);
    const rx = 0.28 * T * radiusScale, ry = 0.34 * T * radiusScale;
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const h0 = fxHash(snap + seed, i * 11 + 1), h1 = fxHash(snap + seed, i * 11 + 2);
      const a0 = h0 * Math.PI * 2, a1 = a0 + 1.9 + h1 * 1.6;
      const pts = this._jaggedSpan(
        cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry,
        cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry,
        7, 4.8 * radiusScale, snap * 29 + i * 17 + seed
      );
      this._strokeElectricPts(ctx, pts, 0.62, 0.96, 0.46);
    }
    this._sparkDot(ctx, cx + (fxHash(snap, seed + 5) - 0.5) * rx * 1.4, cy + (fxHash(snap, seed + 9) - 0.5) * ry * 1.4, 2.5, '#74bce0');
    ctx.restore();
  }

  /** Group connected flame cells of `kind` into seam-free horizontal/vertical runs, junctions, and dead-end tips. */
  _flameRuns(kind) {
    const flames = this.game.flames;
    const defaultMaxT = BLAST_TIMES[kind] || BLAST_TIME;
    const maxOf = f => f.maxT || defaultMaxT;
    const has = (x, y) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const o = flames.get(y * W + x);
      return o && (o.kind || 'fire') === kind;
    };
    const runsH = [], runsV = [], nodes = [], tips = [];
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!has(x, y)) { x++; continue; }
        const x0 = x;
        let sumT = 0, sumMaxT = 0;
        while (x < W && has(x, y)) { const fl = flames.get(y * W + x); sumT += fl.t; sumMaxT += maxOf(fl); x++; }
        const x1 = x - 1;
        const vertAtStart = has(x0, y - 1) || has(x0, y + 1);
        const vertAtEnd = has(x1, y - 1) || has(x1, y + 1);
        if (x1 > x0) {
          const px0 = (x0 + (vertAtStart ? 0.5 : 0.12)) * T;
          const px1 = (x1 + (vertAtEnd ? 0.5 : 0.88)) * T;
          runsH.push({ x0: px0, y0: (y + 0.5) * T, x1: px1, y1: (y + 0.5) * T, avgT: sumT / (x1 - x0 + 1), maxT: sumMaxT / (x1 - x0 + 1), seed: y * W + x0 });
        }
      }
    }
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (!has(x, y)) { y++; continue; }
        const y0 = y;
        let sumT = 0, sumMaxT = 0;
        while (y < H && has(x, y)) { const fl = flames.get(y * W + x); sumT += fl.t; sumMaxT += maxOf(fl); y++; }
        const y1 = y - 1;
        const horizAtStart = has(x - 1, y0) || has(x + 1, y0);
        const horizAtEnd = has(x - 1, y1) || has(x + 1, y1);
        if (y1 > y0) {
          const py0 = (y0 + (horizAtStart ? 0.5 : 0.12)) * T;
          const py1 = (y1 + (horizAtEnd ? 0.5 : 0.88)) * T;
          runsV.push({ x0: (x + 0.5) * T, y0: py0, x1: (x + 0.5) * T, y1: py1, avgT: sumT / (y1 - y0 + 1), maxT: sumMaxT / (y1 - y0 + 1), seed: (y0 * W + x) + 4096 });
        }
      }
    }
    for (const [i, f] of flames) {
      if ((f.kind || 'fire') !== kind) continue;
      const x = i % W, y = (i / W) | 0;
      const nN = has(x, y - 1), nE = has(x + 1, y), nS = has(x, y + 1), nW = has(x - 1, y);
      const branches = (nN ? 1 : 0) + (nE ? 1 : 0) + (nS ? 1 : 0) + (nW ? 1 : 0);
      const cx = (x + 0.5) * T, cy = (y + 0.5) * T;
      if (branches === 0 || (branches >= 2 && !(nN && nS && !nE && !nW) && !(nE && nW && !nN && !nS))) {
        nodes.push({ cx, cy, t: f.t, maxT: maxOf(f), branches, isolated: branches === 0, seed: i });
      }
      if (branches === 1) {
        const dx = nW ? 1 : nE ? -1 : 0, dy = nN ? 1 : nS ? -1 : 0;
        tips.push({ cx: cx + dx * 0.36 * T, cy: cy + dy * 0.36 * T, dx, dy, t: f.t, maxT: maxOf(f), seed: i });
      }
    }
    return { runsH, runsV, nodes, tips };
  }

  /** Trace a turbulent double-edged organic flame envelope polygon along segment (x0,y0)->(x1,y1). */
  _traceFlameEnvelope(ctx, x0, y0, x1, y1, halfW, tongueAmp, stepPx, snap, time, seed) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (L < 2) return;
    const tx = dx / L, ty = dy / L, nx = -ty, ny = tx;
    const n = Math.max(4, Math.round(L / stepPx));
    const need = n + 1;
    if (!this._envTX || this._envTX.length < need) {
      const cap = Math.max(need, 256);
      this._envTX = new Float32Array(cap); this._envTY = new Float32Array(cap);
      this._envBX = new Float32Array(cap); this._envBY = new Float32Array(cap);
    }
    const topX = this._envTX, topY = this._envTY, botX = this._envBX, botY = this._envBY;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const cap = Math.sin(Math.pow(Math.min(1, Math.min(f, 1 - f) * 5.2), 0.7) * Math.PI * 0.5);
      const wTop = halfW * (0.45 + 0.55 * cap)
        + Math.sin(f * L * 0.14 - time * 24 + seed + i * 0.7) * tongueAmp * 0.55 * cap
        + (fxHash(snap + seed, i * 3 + 1) - 0.35) * tongueAmp * 0.9 * cap;
      const wBot = halfW * (0.45 + 0.55 * cap)
        + Math.cos(f * L * 0.13 + time * 21 + seed * 2 + i * 0.8) * tongueAmp * 0.55 * cap
        + (fxHash(snap + seed, i * 3 + 2) - 0.35) * tongueAmp * 0.9 * cap;
      const sway = Math.sin(f * L * 0.08 - time * 18 + seed) * tongueAmp * 0.35 * cap;
      const px = x0 + dx * f, py = y0 + dy * f;
      topX[i] = px + nx * (wTop + sway); topY[i] = py + ny * (wTop + sway);
      botX[i] = px - nx * (wBot - sway); botY[i] = py - ny * (wBot - sway);
    }
    ctx.beginPath();
    ctx.moveTo(x0 - tx * halfW * 0.32, y0 - ty * halfW * 0.32);
    for (let i = 0; i <= n; i++) ctx.lineTo(topX[i], topY[i]);
    ctx.lineTo(x1 + tx * halfW * 0.32, y1 + ty * halfW * 0.32);
    for (let i = n; i >= 0; i--) ctx.lineTo(botX[i], botY[i]);
    ctx.closePath();
  }

  /** Continuous high-voltage plasma discharges across flame corridors (faithful to EXP_ELEC/0..23). */
  _drawElectricWaves(ctx) {
    const { runsH, runsV, nodes, tips } = this._flameRuns('electric');
    const allRuns = [...runsH, ...runsV];
    if (!allRuns.length && !nodes.length) return;
    const snap = Math.floor(this.time * 24);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 1. Wide luminous blue-white plasma corridor envelope unifying discharges
    for (const r of allRuns) {
      const fade = Math.min(1, r.avgT / (r.maxT * 0.28));
      ctx.strokeStyle = `rgba(48, 152, 232, ${0.14 * fade})`;
      ctx.lineWidth = T * 0.70;
      ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();
      ctx.strokeStyle = `rgba(128, 204, 248, ${0.22 * fade})`;
      ctx.lineWidth = T * 0.38;
      ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();
    }
    // 2. Bold high-amperage primary plasma ribbon + violent secondary snapping arc + branching whips
    for (let idx = 0; idx < allRuns.length; idx++) {
      const r = allRuns[idx];
      const fade = Math.min(1, r.avgT / (r.maxT * 0.26));
      const mainPts = this._jaggedSpan(r.x0, r.y0, r.x1, r.y1, 9, 10.5, snap * 37 + r.seed);
      const secPts = this._jaggedSpan(r.x0, r.y0, r.x1, r.y1, 11, 13.5, snap * 53 + r.seed + 19);
      this._strokeElectricPts(ctx, secPts, 0.78, fade * 0.76, 0.34);
      this._strokeElectricPts(ctx, mainPts, 1.38, fade, 0.56);
      if (mainPts.length > 5 && fxHash(snap, r.seed) > 0.20) {
        const mi = 2 + Math.floor(fxHash(snap + 3, r.seed) * (mainPts.length - 4));
        const p = mainPts[mi];
        const ang = fxHash(snap + 7, r.seed) * Math.PI * 2;
        this._strokeElectricPts(ctx, this._jaggedSpan(p[0], p[1], p[0] + Math.cos(ang) * 18, p[1] + Math.sin(ang) * 18, 6, 3.6, snap + r.seed), 0.62, fade * 0.90, 0.36);
      }
    }
    // 3. Intense white-hot plasma nexus rings & isolated 1x1 zaps (EXP_ELEC/0,6 fidelity)
    const elecGlow = this.glow('#74bce0'), whiteGlow = this.glow('#ffffff');
    for (const n of nodes) {
      const fade = Math.min(1, n.t / (n.maxT * 0.26));
      const rad = T * 0.44;
      if (isDrawableOk(elecGlow)) { ctx.globalAlpha = 0.72 * fade; ctx.drawImage(elecGlow, n.cx - rad, n.cy - rad, rad * 2, rad * 2); }
      if (isDrawableOk(whiteGlow)) { ctx.globalAlpha = 0.78 * fade; ctx.drawImage(whiteGlow, n.cx - rad * 0.55, n.cy - rad * 0.55, rad * 1.1, rad * 1.1); }
      ctx.globalAlpha = 1;
      if (n.isolated) {
        const sp = T * 0.39;
        this._strokeElectricPts(ctx, this._jaggedSpan(n.cx - sp, n.cy, n.cx + sp, n.cy, 7, 7.2, snap * 41 + n.seed), 1.25, fade, 0.54);
        this._strokeElectricPts(ctx, this._jaggedSpan(n.cx, n.cy - sp, n.cx, n.cy + sp, 7, 7.2, snap * 43 + n.seed + 5), 1.25, fade, 0.54);
      }
      const rr = T * 0.19;
      for (let q = 0; q < 4; q++) {
        if (fxHash(snap + q, n.seed) < 0.18) continue;
        const a0 = q * Math.PI * 0.5 + 0.1, a1 = a0 + Math.PI * 0.55;
        this._strokeElectricPts(ctx, this._jaggedSpan(
          n.cx + Math.cos(a0) * rr, n.cy + Math.sin(a0) * rr,
          n.cx + Math.cos(a1) * rr, n.cy + Math.sin(a1) * rr, 6, 3.8, snap * 17 + q + n.seed
        ), 0.72, fade * 0.94, 0.36);
      }
    }
    // 4. Wall-impact corona discharge tendrils at corridor ends
    for (const tip of tips) {
      const fade = Math.min(1, tip.t / (tip.maxT * 0.26));
      const baseA = Math.atan2(tip.dy, tip.dx);
      for (const sgn of [-1, 1]) {
        const a = baseA + sgn * (0.45 + fxHash(snap, tip.seed + sgn) * 0.35);
        const len = T * (0.18 + fxHash(snap + 5, tip.seed + sgn) * 0.09);
        this._strokeElectricPts(ctx, this._jaggedSpan(tip.cx, tip.cy, tip.cx + Math.cos(a) * len, tip.cy + Math.sin(a) * len, 6, 3.2, snap + tip.seed + sgn), 0.62, fade * 0.94, 0.36);
      }
    }
    ctx.restore();
  }

  /** Translucent spectral veil + tumbling EXP_MAGI prism crystals & sparkles for invisibility bombs. */
  _drawMagicWaves(ctx) {
    const { runsH, runsV, nodes } = this._flameRuns('magic');
    const allRuns = [...runsH, ...runsV];
    if (!allRuns.length && !nodes.length) return;
    const t = this.time;
    const cols = ['#00fcfc', '#fc00fc', '#fcfc00', '#74bce0'];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of allRuns) {
      const fade = Math.min(1, r.avgT / (r.maxT * 0.34));
      const pulse = 0.86 + 0.14 * Math.sin(t * 20 + r.seed);
      ctx.strokeStyle = `rgba(116, 188, 224, ${0.10 * fade * pulse})`;
      ctx.lineWidth = T * 0.64;
      ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();

      ctx.strokeStyle = `rgba(0, 252, 252, ${0.14 * fade * pulse})`;
      ctx.lineWidth = T * 0.38;
      ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();

      const dx = r.x1 - r.x0, dy = r.y1 - r.y0, L = Math.hypot(dx, dy);
      if (L > 4) {
        const steps = Math.max(6, Math.round(L / 9));
        const nx = -dy / L, ny = dx / L;
        for (const [phaseOff, col, amp, lw] of [
          [0, `rgba(0, 252, 252, ${0.56 * fade})`, 7.5, 2.2],
          [Math.PI, `rgba(252, 0, 252, ${0.50 * fade})`, 6.8, 2.0],
          [Math.PI * 0.5, `rgba(252, 252, 252, ${0.65 * fade})`, 4.2, 1.4],
        ]) {
          ctx.beginPath();
          for (let s = 0; s <= steps; s++) {
            const f = s / steps, env = Math.sin(f * Math.PI);
            const off = Math.sin(f * L * 0.095 - t * 14 + r.seed + phaseOff) * amp * (0.18 + 0.82 * env);
            const px = r.x0 + dx * f + nx * off, py = r.y0 + dy * f + ny * off;
            if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
        }
      }
    }
    for (const r of allRuns) {
      const fade = Math.min(1, r.avgT / (r.maxT * 0.3));
      const prog = Math.max(0, 1 - r.avgT / r.maxT);
      const dx = r.x1 - r.x0, dy = r.y1 - r.y0, L = Math.hypot(dx, dy);
      if (L < 4) continue;
      const nx = -dy / L, ny = dx / L;
      const count = Math.max(4, Math.round(L / 20));
      for (let i = 0; i < count; i++) {
        const h0 = fxHash(r.seed, i * 3 + 1), h1 = fxHash(r.seed, i * 3 + 2), h2 = fxHash(r.seed, i * 3 + 3);
        const f = (i + 0.2 + 0.6 * h0) / count;
        const lat = (h1 - 0.5) * 2 * (16 + prog * 11) + Math.sin(t * 11 + i * 2.1 + r.seed) * 4.5;
        const sx = r.x0 + dx * f + nx * lat, sy = r.y0 + dy * f + ny * lat - prog * 5;
        const tw = 0.55 + 0.45 * Math.sin(t * 24 + h2 * 14);
        const col = cols[(i + Math.floor(t * 10 + h2 * 4)) % cols.length];
        if (i % 4 === 0) {
          this._glintV(ctx, sx, sy, 9.5 + h2 * 5.0, col, 'rgba(8, 4, 22, 0.86)');
        } else if (i % 5 === 2) {
          this._sparkDot(ctx, sx, sy, 2.8 + h1 * 1.4, col, 'rgba(8, 4, 22, 0.88)');
        } else {
          this._sparkleCross(ctx, sx, sy, 8.2 + h2 * 5.4, col, { alpha: fade * tw, glow: 0.32, outline: 'rgba(8, 4, 22, 0.88)' });
        }
      }
    }
    const cyanGlow = this.glow('#00fcfc'), whiteGlowM = this.glow('#ffffff');
    for (const n of nodes) {
      const fade = Math.min(1, n.t / (n.maxT * 0.28));
      const rad = T * 0.44;
      if (isDrawableOk(cyanGlow)) { ctx.globalAlpha = 0.52 * fade; ctx.drawImage(cyanGlow, n.cx - rad, n.cy - rad, rad * 2, rad * 2); }
      if (isDrawableOk(whiteGlowM)) { ctx.globalAlpha = 0.62 * fade; ctx.drawImage(whiteGlowM, n.cx - rad * 0.5, n.cy - rad * 0.5, rad, rad); }
      ctx.globalAlpha = 1;
      if (n.isolated) {
        const prog = Math.max(0, 1 - n.t / n.maxT);
        ctx.strokeStyle = `rgba(0, 252, 252, ${0.68 * fade})`; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(n.cx, n.cy, T * (0.24 + prog * 0.16), 0, Math.PI * 2); ctx.stroke();
        for (let k = 0; k < 4; k++) {
          const a = k * 1.57 + t * 5.0;
          const dist = T * (0.20 + prog * 0.14);
          this._sparkleCross(ctx, n.cx + Math.cos(a) * dist, n.cy + Math.sin(a) * dist, 7.6, cols[(k + Math.floor(t * 9)) % 4], { alpha: fade, glow: 0.28, outline: 'rgba(8, 4, 22, 0.88)' });
        }
      }
      const heroCol = cols[Math.floor(t * 10 + n.seed) % cols.length];
      this._sparkleCross(ctx, n.cx, n.cy, 14.0, heroCol, { alpha: fade, glow: 0.44, outline: 'rgba(8, 4, 22, 0.88)' });
    }
    ctx.restore();
  }

  /** Roiling blazing TH_FIRE magma fireball comet with white-hot front cap & trailing molten droplets. */
  _drawFireOrb(ctx, wx, wy, dir, t, seed = 1) {
    if (this.q?.fastFx) {
      const dirRow = [1, 2, 3, 0][dir & 3];
      const fr = dirRow * 14 + (Math.floor(t * 20 + seed) & 7);
      this.sprAt(ctx, 'TH_FIRE/' + fr, wx - 0.5, wy - 0.5);
      return;
    }
    const cx = wx * T, cy = wy * T;
    const ang = [0, Math.PI / 2, Math.PI, -Math.PI / 2][dir & 3];
    const snap = Math.floor(t * 24);
    const wag = Math.sin(t * 28 + seed) * 4.5;
    ctx.save();
    const halo = ctx.createRadialGradient(cx, cy, 2, cx, cy, 0.48 * T);
    halo.addColorStop(0.0, 'rgba(252, 252, 40, 0.54)');
    halo.addColorStop(0.55, 'rgba(252, 112, 0, 0.34)');
    halo.addColorStop(1.0, 'rgba(180, 42, 0, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, 0.48 * T, 0, Math.PI * 2); ctx.fill();

    ctx.translate(cx, cy);
    ctx.rotate(ang);

    // Churning asymmetrical fireball silhouette matching TH_FIRE/0..9 (thick rounded magma head + ragged wake)
    const lobes = 12;
    ctx.beginPath();
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const rear = Math.cos(a) < 0 ? (-Math.cos(a) * 0.22 * T) : 0;
      const jit = (fxHash(snap + seed, i) - 0.5) * 4.5;
      const rx = 0.22 * T + rear + jit * 0.6;
      const ry = 0.19 * T * (Math.cos(a) < -0.35 ? 0.72 : 1.0) + jit * 0.5;
      const px = Math.cos(a) * rx - 0.04 * T;
      const py = Math.sin(a) * ry + (Math.cos(a) < -0.2 ? wag * (-Math.cos(a)) : 0);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = '#240500'; ctx.lineWidth = 3.8; ctx.stroke();
    const mG = ctx.createLinearGradient(-0.38 * T, 0, 0.22 * T, 0);
    mG.addColorStop(0.0, '#9c2000');
    mG.addColorStop(0.45, '#fc7400');
    mG.addColorStop(1.0, '#ecd800');
    ctx.fillStyle = mG; ctx.fill();

    // Inner bright yellow fireball core + off-center forward white-hot blaze spot (TH_FIRE signature!)
    ctx.fillStyle = '#fcfc00';
    ctx.beginPath();
    ctx.ellipse(0.03 * T, wag * 0.15, 0.13 * T, 0.115 * T, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fcfcfc';
    ctx.beginPath();
    ctx.arc(0.08 * T, -0.02 * T + Math.sin(t * 36 + seed) * 1.5, 0.062 * T, 0, Math.PI * 2);
    ctx.fill();

    // Detached molten magma droplets trailing behind fireball
    for (let d = 0; d < 3; d++) {
      const ds = (fxHash(snap + seed, d + 20) - 0.5) * 0.24 * T;
      const dx = -0.28 * T - d * 0.10 * T - fxHash(snap, d + 40) * 5;
      const dy = ds + wag * (0.4 + d * 0.25);
      this._sparkDot(ctx, dx, dy, 2.5 - d * 0.45, d === 0 ? '#fcfc00' : '#fc7c00', '#240500');
    }
    ctx.restore();
  }

  /** Continuous roaring volcanic fire blast across connected corridors (faithful to EXP_FIRE/0..63). */
  _drawFireWaves(ctx) {
    const { runsH, runsV, nodes, tips } = this._flameRuns('fire');
    const allRuns = [...runsH, ...runsV];
    if (!allRuns.length && !nodes.length) return;
    const t = this.time;
    const snap = Math.floor(t * 24);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 1. Feathered thermal radiance + charred crimson-obsidian volcanic crust along every connected run
    for (const r of allRuns) {
      const prog = Math.max(0, Math.min(1, 1 - r.avgT / r.maxT));
      const fade = Math.min(1, r.avgT / (r.maxT * 0.28));
      const pulseW = (0.86 + 0.14 * Math.sin(Math.min(1, (1 - prog) * 3.2) * Math.PI * 0.5)) * (1 - prog * 0.34);

      ctx.strokeStyle = `rgba(252, 88, 0, ${0.24 * fade})`;
      ctx.lineWidth = T * 0.80 * pulseW;
      ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();

      ctx.fillStyle = `rgba(38, 6, 0, ${0.84 * fade})`;
      this._traceFlameEnvelope(ctx, r.x0, r.y0, r.x1, r.y1, T * 0.32 * pulseW, 6.5 * pulseW, 14, snap, t, r.seed);
      ctx.fill();

      ctx.fillStyle = `rgba(176, 40, 0, ${0.96 * fade})`;
      this._traceFlameEnvelope(ctx, r.x0, r.y0, r.x1, r.y1, T * 0.27 * pulseW, 6.0 * pulseW, 14, snap + 3, t, r.seed + 7);
      ctx.fill();
    }
    // 2. Churning vermilion-orange combustion body, molten gold river & jagged white-hot plasma patches
    for (const r of allRuns) {
      const prog = Math.max(0, Math.min(1, 1 - r.avgT / r.maxT));
      const fade = Math.min(1, r.avgT / (r.maxT * 0.28));
      const pulseW = (0.86 + 0.14 * Math.sin(Math.min(1, (1 - prog) * 3.2) * Math.PI * 0.5)) * (1 - prog * 0.34);
      const dx = r.x1 - r.x0, dy = r.y1 - r.y0, L = Math.hypot(dx, dy);
      if (L < 2) continue;
      const nx = -dy / L, ny = dx / L;

      ctx.fillStyle = `rgba(252, 118, 0, ${0.98 * fade})`;
      this._traceFlameEnvelope(ctx, r.x0, r.y0, r.x1, r.y1, T * 0.215 * pulseW, 5.4 * pulseW, 14, snap + 11, t * 1.15, r.seed + 19);
      ctx.fill();

      ctx.fillStyle = `rgba(244, 212, 0, ${0.96 * fade})`;
      this._traceFlameEnvelope(ctx, r.x0, r.y0, r.x1, r.y1, T * 0.13 * pulseW, 4.4 * pulseW, 15, snap + 23, t * 1.35, r.seed + 37);
      ctx.fill();

      const steps = Math.max(4, Math.round(L / 14));
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const f = s / steps, env = Math.sin(f * Math.PI);
        const j = Math.sin(f * L * 0.17 - t * 28 + r.seed) * 4.2 * (0.2 + 0.8 * env);
        const px = r.x0 + dx * f + nx * j, py = r.y0 + dy * f + ny * j;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `rgba(252, 252, 0, ${0.96 * fade})`;
      ctx.lineWidth = T * 0.085 * pulseW;
      ctx.stroke();

      // Irregular elongated white-hot splatters & crackling orange edge embers (EXP_FIRE c0..c3 fidelity)
      const splats = Math.max(2, Math.round(L / 22));
      for (let i = 0; i < splats; i++) {
        const f = (i + 0.5) / splats;
        const j = (fxHash(snap, r.seed + i * 7) - 0.5) * 8;
        const bx = r.x0 + dx * f + nx * j, by = r.y0 + dy * f + ny * j;
        const ang = (Math.atan2(dy, dx)) + (fxHash(snap + 1, r.seed + i) - 0.5) * 0.9;
        const rx = (3.8 + fxHash(snap + 2, r.seed + i) * 4.5) * (1 - prog * 0.45);
        const ry = (1.8 + fxHash(snap + 3, r.seed + i) * 2.2) * (1 - prog * 0.35);
        if (rx > 1.2) {
          ctx.fillStyle = `rgba(252, 252, 252, ${0.94 * fade})`;
          ctx.beginPath();
          ctx.ellipse(bx, by, rx, ry, ang, 0, Math.PI * 2);
          ctx.fill();
        }
        if ((i + snap) % 2 === 0) {
          const side = ((i & 1) ? 1 : -1) * (16 + fxHash(snap + 5, r.seed + i) * 10) * pulseW;
          this._sparkDot(ctx, r.x0 + dx * f + nx * side, r.y0 + dy * f + ny * side, 2.2, '#fcfc00', 'rgba(38, 6, 0, 0.78)');
        }
      }
    }
    // 3. Cross / T / L junction core bursts & seamless layered 1x1 volcanic fire crosses
    for (const n of nodes) {
      const prog = Math.max(0, Math.min(1, 1 - n.t / n.maxT));
      const fade = Math.min(1, n.t / (n.maxT * 0.28));
      const pulseW = (0.86 + 0.14 * Math.sin(Math.min(1, (1 - prog) * 3.2) * Math.PI * 0.5)) * (1 - prog * 0.34);
      if (n.isolated) {
        // EXP_FIRE/0..16..32..48 authentic scalloped multi-lobe fiery crater burst
        const baseR = T * (0.42 - prog * 0.14) * pulseW;
        const traceCrater = (rad, amp, phase) => {
          ctx.beginPath();
          const segs = 14;
          for (let s = 0; s <= segs; s++) {
            const a = (s / segs) * Math.PI * 2;
            const rJit = rad + Math.sin(a * 4 + t * 22 + phase) * amp + (fxHash(snap + phase, s) - 0.5) * amp * 1.1;
            const px = n.cx + Math.cos(a) * rJit, py = n.cy + Math.sin(a) * rJit;
            if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        };
        ctx.fillStyle = `rgba(38, 6, 0, ${0.84 * fade})`; traceCrater(baseR * 1.10, 3.8, 0); ctx.fill();
        ctx.fillStyle = `rgba(176, 40, 0, ${0.96 * fade})`; traceCrater(baseR * 0.94, 3.4, 3); ctx.fill();
        ctx.fillStyle = `rgba(252, 118, 0, ${0.98 * fade})`; traceCrater(baseR * 0.74, 2.8, 7); ctx.fill();
        ctx.fillStyle = `rgba(252, 236, 0, ${0.96 * fade})`; traceCrater(baseR * 0.48, 2.2, 11); ctx.fill();
        ctx.fillStyle = `rgba(252, 252, 252, ${0.94 * fade})`;
        ctx.beginPath(); ctx.ellipse(n.cx + Math.sin(t * 26) * 2, n.cy + Math.cos(t * 22) * 2, baseR * 0.24, baseR * 0.18, t * 4, 0, Math.PI * 2); ctx.fill();
      } else {
        const rad = T * 0.46 * pulseW;
        const orgGlow = this.glow('#ff8020'), yelGlow = this.glow('#fcfc00'), whtGlow = this.glow('#ffffff');
        if (isDrawableOk(orgGlow)) { ctx.globalAlpha = 0.55 * fade; ctx.drawImage(orgGlow, n.cx - rad, n.cy - rad, rad * 2, rad * 2); }
        if (isDrawableOk(yelGlow)) { ctx.globalAlpha = 0.72 * fade; ctx.drawImage(yelGlow, n.cx - rad * 0.75, n.cy - rad * 0.75, rad * 1.5, rad * 1.5); }
        if (isDrawableOk(whtGlow)) { ctx.globalAlpha = 0.85 * fade; ctx.drawImage(whtGlow, n.cx - rad * 0.42, n.cy - rad * 0.42, rad * 0.84, rad * 0.84); }
        ctx.globalAlpha = 1;
        this._sparkleCross(ctx, n.cx, n.cy, 13.5 * (1 - prog * 0.34), '#fcfc00', {
          aspect: 0.88, waist: 0.30, alpha: fade, glow: 0.36, outline: 'rgba(150, 36, 0, 0.78)',
        });
      }
    }
    // 4. Outward ember sparks flying off wall-impact dead ends
    for (const tip of tips) {
      const fade = Math.min(1, tip.t / (tip.maxT * 0.28));
      const baseA = Math.atan2(tip.dy, tip.dx);
      for (const sgn of [-1, 1]) {
        const a = baseA + sgn * (0.45 + fxHash(snap, tip.seed + sgn) * 0.38);
        const len = T * (0.15 + fxHash(snap + 5, tip.seed + sgn) * 0.10);
        this._sparkDot(ctx, tip.cx + Math.cos(a) * len, tip.cy + Math.sin(a) * len, 2.6 * fade + 0.8, '#fcfc00', 'rgba(38, 6, 0, 0.82)');
      }
    }
    ctx.restore();
  }

  _getOnewayBg(halfW, halfH) {
    let bg = this._onewayBg;
    if (bg) return bg;
    const cw = Math.ceil(halfW * 2 + 6), ch = Math.ceil(halfH * 2 + 6);
    bg = document.createElement('canvas');
    bg.width = cw; bg.height = ch;
    const b = bg.getContext('2d');
    b.translate(halfW + 3, halfH + 3);

    b.fillStyle = 'rgba(0, 0, 8, 0.44)';
    b.fillRect(-halfW + 1.5, -halfH + 1.5, halfW * 2, halfH * 2);

    const slotG = b.createLinearGradient(-halfW, 0, halfW, 0);
    slotG.addColorStop(0.0, 'rgba(6, 10, 18, 0.74)');
    slotG.addColorStop(0.5, 'rgba(16, 24, 38, 0.80)');
    slotG.addColorStop(1.0, 'rgba(6, 10, 18, 0.74)');
    b.fillStyle = slotG;
    b.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);

    // Subtle machined guide track slats along movement direction
    b.fillStyle = 'rgba(140, 175, 210, 0.10)';
    for (let sy = -halfH + 8; sy < halfH - 6; sy += 9) {
      b.fillRect(-halfW + 3, sy, halfW * 2 - 6, 1.5);
    }

    // Crisp forged iron channel rails & wall-mounting bracket shoes
    b.strokeStyle = 'rgba(0, 0, 0, 0.90)'; b.lineWidth = 2.0;
    b.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
    b.strokeStyle = 'rgba(148, 178, 212, 0.26)'; b.lineWidth = 1.2;
    b.beginPath();
    b.moveTo(-halfW + 1.5, -halfH + 2); b.lineTo(-halfW + 1.5, halfH - 2);
    b.moveTo(halfW - 1.5, -halfH + 2); b.lineTo(halfW - 1.5, halfH - 2);
    b.stroke();

    for (const endY of [-halfH, halfH - 4.5]) {
      b.fillStyle = '#3b4350';
      b.fillRect(-halfW, endY, halfW * 2, 4.5);
      b.fillStyle = 'rgba(220, 232, 244, 0.28)';
      b.fillRect(-halfW + 2, endY + 0.8, halfW * 2 - 4, 1.2);
      b.fillStyle = '#181c22';
      b.beginPath();
      b.arc(-halfW + 5, endY + 2.2, 1.1, 0, Math.PI * 2);
      b.arc(halfW - 5, endY + 2.2, 1.1, 0, Math.PI * 2);
      b.fill();
    }
    this._onewayBg = bg;
    return bg;
  }

  _getOnewayFrame(phaseIdx, halfW, halfH) {
    if (!this._onewayFrames) this._onewayFrames = new Array(12);
    const idx = ((phaseIdx | 0) % 12 + 12) % 12;
    let c = this._onewayFrames[idx];
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const bg = this._getOnewayBg(halfW, halfH);
    g.translate(32, 32);
    g.drawImage(bg, -halfW - 3, -halfH - 3);
    g.beginPath(); g.rect(-halfW + 2, -halfH + 4.5, halfW * 2 - 4, halfH * 2 - 9); g.clip();
    const scroll = idx / 12;
    const step = 0.36 * T, cw = 0.105 * T, armY = 0.33 * T;
    for (let k = -1; k <= 2; k++) {
      const xOff = (scroll - 0.5 + k) * step;
      const edgeFade = Math.max(0.28, 1 - Math.abs(xOff) / (halfW + 0.16 * T));
      g.save();
      g.globalAlpha = edgeFade;
      const traceChev = (ox, thick) => {
        const xBack = xOff - cw + ox, xMid = xOff + cw * 0.35 + ox, xTip = xOff + cw + ox;
        g.beginPath();
        g.moveTo(xBack, -armY);
        g.lineTo(xBack + thick, -armY);
        g.lineTo(xTip + thick * 0.45, 0);
        g.lineTo(xBack + thick, armY);
        g.lineTo(xBack, armY);
        g.lineTo(xMid, 0);
        g.closePath();
      };
      traceChev(0, 6.8);
      g.strokeStyle = 'rgba(2, 6, 16, 0.92)'; g.lineWidth = 2.4; g.stroke();
      g.fillStyle = '#70b4e4'; g.fill();
      traceChev(-0.8, 4.9);
      g.fillStyle = '#fcfcfc'; g.fill();
      g.restore();
    }
    this._onewayFrames[idx] = c;
    return c;
  }

  /** Realistic dungeon threshold One-Way Arrow Gate matching original AM_ONEWY/0..27 flush obsidian grate & crisp chevrons. */
  _drawOnewayGate(ctx, cx, cy, dir, t, seed = 0) {
    const px = (cx + 0.5) * T, py = (cy + 0.5) * T;
    const ang = [0, Math.PI / 2, Math.PI, -Math.PI / 2][(dir | 0) & 3];
    const halfW = 0.28 * T, halfH = 0.49 * T;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);

    if (this.q?.fastFx) {
      const phaseIdx = Math.floor((((t * (TICK_HZ / 21)) % 1 + 1) % 1) * 12);
      ctx.drawImage(this._getOnewayFrame(phaseIdx, halfW, halfH), -32, -32);
      ctx.restore();
      return;
    }

    // 1. Cached recessed dark smoked-iron grating, guide slats, rails & bracket shoes
    const bg = this._getOnewayBg(halfW, halfH);
    ctx.drawImage(bg, -halfW - 3, -halfH - 3);

    // 2. Sharp beveled silver-white directional chevrons gliding briskly across the channel (AM_ONEWY/0..27)
    ctx.beginPath(); ctx.rect(-halfW + 2, -halfH + 4.5, halfW * 2 - 4, halfH * 2 - 9); ctx.clip();
    const scroll = ((t * (TICK_HZ / 21)) % 1 + 1) % 1;
    const step = 0.36 * T;
    const cw = 0.105 * T, armY = 0.33 * T;
    for (let k = -1; k <= 2; k++) {
      const xOff = (scroll - 0.5 + k) * step;
      const edgeFade = Math.max(0.28, 1 - Math.abs(xOff) / (halfW + 0.16 * T));
      ctx.save();
      ctx.globalAlpha = edgeFade;
      // Sharp solid beveled polygon chevron matching original crisp arrowhead vertices
      const traceChev = (ox, thick) => {
        const xBack = xOff - cw + ox, xMid = xOff + cw * 0.35 + ox, xTip = xOff + cw + ox;
        ctx.beginPath();
        ctx.moveTo(xBack, -armY);
        ctx.lineTo(xBack + thick, -armY);
        ctx.lineTo(xTip + thick * 0.45, 0);
        ctx.lineTo(xBack + thick, armY);
        ctx.lineTo(xBack, armY);
        ctx.lineTo(xMid, 0);
        ctx.closePath();
      };
      traceChev(0, 6.8);
      ctx.strokeStyle = 'rgba(2, 6, 16, 0.92)'; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.fillStyle = '#70b4e4'; ctx.fill();

      traceChev(-0.8, 4.9);
      ctx.fillStyle = '#fcfcfc'; ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Realistic oak-bronze & forged-iron L-shaped Flip-Door matching AM_DOOR/0..19 kinematics & hardware. */
  _drawFlipDoor(ctx, cx, cy, kind, prog) {
    const k = (kind | 0) & 3;
    const pr = Math.max(0, Math.min(1, prog));
    if (pr === 0 || pr === 1) {
      if (!this._doorCache) this._doorCache = new Map();
      const key = `${k}:${pr}`;
      let spr = this._doorCache.get(key);
      if (!spr) {
        spr = document.createElement('canvas');
        spr.width = 128; spr.height = 128;
        this._renderFlipDoor(spr.getContext('2d'), 32, 32, k, pr);
        this._doorCache.set(key, spr);
      }
      ctx.drawImage(spr, cx * T - 32, cy * T - 32);
      return;
    }
    this._renderFlipDoor(ctx, cx * T, cy * T, k, pr);
  }

  _renderFlipDoor(ctx, ox, oy, k, pr) {
    const specs = [
      [0.5,       13.5 / 16,  Math.PI,      Math.PI / 2],
      [2.5 / 16,  0.5,       -Math.PI / 2,  Math.PI / 2],
      [0.5,       2.5 / 16,   Math.PI / 2, -Math.PI / 2],
      [13.5 / 16, 0.5,        Math.PI,     -Math.PI / 2],
    ];
    const [hx, hy, a0, da] = specs[k];
    const px = ox + hx * T, py = oy + hy * T;
    const ang = a0 + da * pr;
    const armLen = 0.70 * T, hw = 0.145 * T;

    const traceL = () => {
      ctx.beginPath();
      ctx.moveTo(0, -hw);
      ctx.lineTo(armLen, -hw);
      ctx.arc(armLen, 0, hw, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(hw, hw);
      ctx.lineTo(hw, armLen);
      ctx.arc(0, armLen, hw, 0, Math.PI);
      ctx.lineTo(-hw, 0);
      ctx.arc(0, 0, hw, Math.PI, Math.PI * 1.5);
      ctx.closePath();
    };

    ctx.save();
    // 1. Cast shadow beneath rotating bronze-oak bracket
    ctx.save();
    ctx.translate(px + 3, py + 5);
    ctx.rotate(ang);
    traceL();
    ctx.fillStyle = 'rgba(0, 0, 8, 0.42)';
    ctx.fill();
    ctx.restore();

    // 2. Heavy weathered hardwood/bronze L-bracket + iron tip collars + grain highlights
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    traceL();
    const beamG = ctx.createLinearGradient(-hw, -hw, armLen * 0.72, armLen * 0.72);
    beamG.addColorStop(0.0, '#8d5946');
    beamG.addColorStop(0.42, '#693f31');
    beamG.addColorStop(0.82, '#472a20');
    beamG.addColorStop(1.0, '#2a1812');
    ctx.fillStyle = beamG;
    ctx.fill();

    ctx.save();
    traceL();
    ctx.clip();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Narrow top-left oil-rubbed cylindrical specular catch & fine hardwood grain lines
    ctx.strokeStyle = 'rgba(232, 186, 156, 0.40)';
    ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(armLen - 2, -hw * 0.45); ctx.lineTo(-hw * 0.45, -hw * 0.45); ctx.lineTo(-hw * 0.45, armLen - 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(28, 12, 8, 0.34)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(armLen - 3, 1.5); ctx.lineTo(1.5, 1.5); ctx.lineTo(1.5, armLen - 3); ctx.stroke();
    ctx.strokeStyle = 'rgba(18, 8, 5, 0.56)';
    ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(armLen, hw - 1.5); ctx.lineTo(hw - 1.5, hw - 1.5); ctx.lineTo(hw - 1.5, armLen); ctx.stroke();

    // Dark forged iron reinforcing sleeves near the arm tips
    ctx.fillStyle = '#38404c';
    ctx.fillRect(armLen - 8, -hw - 1, 6, hw * 2 + 2);
    ctx.fillRect(-hw - 1, armLen - 8, hw * 2 + 2, 6);
    ctx.strokeStyle = '#080504'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(armLen - 8, -hw); ctx.lineTo(armLen - 8, hw);
    ctx.moveTo(-hw, armLen - 8); ctx.lineTo(hw, armLen - 8);
    ctx.stroke();
    ctx.restore();

    traceL();
    ctx.strokeStyle = '#070504';
    ctx.lineWidth = 3.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Subtle forged steel tip pins
    for (const [rx, ry] of [[armLen - 2, 0], [0, armLen - 2]]) {
      ctx.fillStyle = '#586272';
      ctx.beginPath(); ctx.arc(rx, ry, 2.7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#dce6f2';
      ctx.beginPath(); ctx.arc(rx - 0.6, ry - 0.6, 1.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 3. Machined chamfered iron hinge block housing & domed steel axle cap matching AM_DOOR hardware
    const bR = hw * 1.18, ch = 3.8;
    ctx.beginPath();
    ctx.moveTo(px - bR + ch, py - bR);
    ctx.lineTo(px + bR - ch, py - bR);
    ctx.lineTo(px + bR, py - bR + ch);
    ctx.lineTo(px + bR, py + bR - ch);
    ctx.lineTo(px + bR - ch, py + bR);
    ctx.lineTo(px - bR + ch, py + bR);
    ctx.lineTo(px - bR, py + bR - ch);
    ctx.lineTo(px - bR, py - bR + ch);
    ctx.closePath();
    const blockG = ctx.createLinearGradient(px - bR, py - bR, px + bR, py + bR);
    blockG.addColorStop(0.0, '#909eae');
    blockG.addColorStop(0.45, '#5a6474');
    blockG.addColorStop(1.0, '#2a303a');
    ctx.fillStyle = blockG; ctx.fill();
    ctx.strokeStyle = '#070504'; ctx.lineWidth = 2.8; ctx.stroke();

    const capR = hw * 0.72;
    const capG = ctx.createRadialGradient(px - capR * 0.35, py - capR * 0.35, 1, px, py, capR);
    capG.addColorStop(0.0, '#fcfcfc');
    capG.addColorStop(0.45, '#8c9bae');
    capG.addColorStop(1.0, '#2d333d');
    ctx.fillStyle = capG;
    ctx.beginPath(); ctx.arc(px, py, capR, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#070504'; ctx.lineWidth = 2.0; ctx.stroke();
    ctx.restore();
  }

  _spikeLight(w) {
    const ang = [0, Math.PI / 2, Math.PI, -Math.PI / 2][w];
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return {
      ang,
      ca,
      sa,
      lu: -0.663 * ca - 0.748 * sa,
      lv: 0.663 * sa - 0.748 * ca,
    };
  }

  _paintSpikeSocket(c, w) {
    const { ang, lu, lv } = this._spikeLight(w);
    const uBack = w === 3 ? -5.8 : (w === 1 ? -9.0 : -7.2);
    const uFront = 5.5;
    const uMid = (uBack + uFront) * 0.5;
    const hw = 22.5, ch = 3.6;
    const litSign = lv < 0 ? -1 : 1;

    c.save();
    c.rotate(ang);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // 1. Chamfered forged-steel wall mounting flange (matching L-door axle housing craftsmanship)
    c.beginPath();
    c.moveTo(uBack + ch, -hw);
    c.lineTo(uFront - ch, -hw);
    c.lineTo(uFront, -hw + ch);
    c.lineTo(uFront, hw - ch);
    c.lineTo(uFront - ch, hw);
    c.lineTo(uBack + ch, hw);
    c.lineTo(uBack, hw - ch);
    c.lineTo(uBack, -hw + ch);
    c.closePath();
    const blockG = c.createLinearGradient(uMid + lu * 12, lv * hw, uMid - lu * 12, -lv * hw);
    blockG.addColorStop(0.0, '#909eae');
    blockG.addColorStop(0.45, '#5a6474');
    blockG.addColorStop(1.0, '#2a303a');
    c.fillStyle = blockG;
    c.fill();

    // Subtle crisp bevel highlight on lit mounting edge
    c.strokeStyle = 'rgba(236, 244, 252, 0.34)';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(uBack + 1.5, litSign * (hw - 4));
    c.lineTo(uFront - 3.5, litSign * (hw - 4));
    c.stroke();

    c.beginPath();
    c.moveTo(uBack + ch, -hw);
    c.lineTo(uFront - ch, -hw);
    c.lineTo(uFront, -hw + ch);
    c.lineTo(uFront, hw - ch);
    c.lineTo(uFront - ch, hw);
    c.lineTo(uBack + ch, hw);
    c.lineTo(uBack, hw - ch);
    c.lineTo(uBack, -hw + ch);
    c.closePath();
    c.strokeStyle = '#070504';
    c.lineWidth = 2.8;
    c.stroke();

    // 2. Arched oak-bronze / copper throat collar housing with open bore jaws
    const traceCollar = () => {
      c.beginPath();
      c.moveTo(0.6, -14.8);
      c.lineTo(7.4, -14.8);
      c.quadraticCurveTo(12.6, -14.4, 12.6, -10.8);
      c.lineTo(12.6, -8.8);
      c.lineTo(9.2, -8.8);
      c.quadraticCurveTo(6.6, 0, 9.2, 8.8);
      c.lineTo(12.6, 8.8);
      c.lineTo(12.6, 10.8);
      c.quadraticCurveTo(12.6, 14.4, 7.4, 14.8);
      c.lineTo(0.6, 14.8);
      c.quadraticCurveTo(-1.2, 0, 0.6, -14.8);
      c.closePath();
    };
    traceCollar();
    const bronzeG = c.createLinearGradient(2 + lu * 8, lv * 15, 9 - lu * 8, -lv * 15);
    bronzeG.addColorStop(0.0, '#965f4b');
    bronzeG.addColorStop(0.42, '#693f31');
    bronzeG.addColorStop(0.82, '#472a20');
    bronzeG.addColorStop(1.0, '#2a1812');
    c.fillStyle = bronzeG;
    c.fill();

    c.save();
    traceCollar();
    c.clip();
    // Oil-rubbed cylindrical specular catchlight & forged iron rim band
    c.strokeStyle = 'rgba(232, 186, 156, 0.45)';
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(1.8, litSign * 11.8);
    c.quadraticCurveTo(7.2, litSign * 11.8, 11.5, litSign * 10.2);
    c.stroke();
    c.fillStyle = '#38404c';
    c.fillRect(0.2, -16, 3.2, 32);
    c.strokeStyle = '#080504';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(3.4, -16);
    c.lineTo(3.4, 16);
    c.stroke();
    c.restore();

    traceCollar();
    c.strokeStyle = '#070504';
    c.lineWidth = 3.0;
    c.stroke();

    // 3. Domed spherical steel rivets on both mounting flange ears (exact L-door axle cap finish)
    const uRiv = uBack * 0.38 + 1.1;
    const rivR = 3.0;
    for (const vRiv of [-18.4, 18.4]) {
      const capG = c.createRadialGradient(
        uRiv + lu * rivR * 0.35, vRiv + lv * rivR * 0.35, 0.5,
        uRiv, vRiv, rivR
      );
      capG.addColorStop(0.0, '#fcfcfc');
      capG.addColorStop(0.45, '#8c9bae');
      capG.addColorStop(1.0, '#2d333d');
      c.fillStyle = capG;
      c.beginPath();
      c.arc(uRiv, vRiv, rivR, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#070504';
      c.lineWidth = 1.8;
      c.stroke();
    }
    c.restore();
  }

  _paintSpikeBlade(c, w) {
    const { ang, lu, lv } = this._spikeLight(w);
    const litSign = lv < 0 ? -1 : 1;

    c.save();
    c.rotate(ang);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // 1. Cylindrical forged dark-iron plunger shaft
    const sHw = 7.2;
    c.beginPath();
    c.rect(1.0, -sHw, 24.0, sHw * 2);
    const shaftG = c.createLinearGradient(0, lv * sHw, 0, -lv * sHw);
    shaftG.addColorStop(0.0, '#8896a8');
    shaftG.addColorStop(0.48, '#4e5968');
    shaftG.addColorStop(1.0, '#212730');
    c.fillStyle = shaftG;
    c.fill();
    c.strokeStyle = 'rgba(240, 248, 255, 0.38)';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(2.0, lv * 3.0);
    c.lineTo(23.5, lv * 3.0);
    c.stroke();
    c.strokeStyle = '#070504';
    c.lineWidth = 3.0;
    c.strokeRect(1.0, -sHw, 24.0, sHw * 2);

    // 2. Chamfered steel reinforcing collar ring at spearhead heel
    const cHw = 10.4;
    c.beginPath();
    c.moveTo(23.0, -cHw + 1.8);
    c.lineTo(24.8, -cHw);
    c.lineTo(28.5, -cHw);
    c.lineTo(28.5, cHw);
    c.lineTo(24.8, cHw);
    c.lineTo(23.0, cHw - 1.8);
    c.closePath();
    const colG = c.createLinearGradient(25 + lu * 5, lv * cHw, 26 - lu * 5, -lv * cHw);
    colG.addColorStop(0.0, '#9fb0c2');
    colG.addColorStop(0.5, '#596475');
    colG.addColorStop(1.0, '#272e38');
    c.fillStyle = colG;
    c.fill();
    c.strokeStyle = '#070504';
    c.lineWidth = 2.6;
    c.stroke();

    // 3. Broad two-facet beveled forged-steel spearhead (world top-left lit!)
    const traceSpear = () => {
      c.beginPath();
      c.moveTo(28.5, -13.0);
      c.lineTo(34.5, -11.8);
      c.lineTo(56.5, 0);
      c.lineTo(34.5, 11.8);
      c.lineTo(28.5, 13.0);
      c.closePath();
    };

    // Lit bevel facet
    c.beginPath();
    c.moveTo(28.5, 0);
    c.lineTo(28.5, litSign * 13.0);
    c.lineTo(34.5, litSign * 11.8);
    c.lineTo(56.5, 0);
    c.closePath();
    const litG = c.createLinearGradient(34, litSign * 11, 48, 0);
    litG.addColorStop(0.0, '#f3f8fd');
    litG.addColorStop(0.45, '#bccadd');
    litG.addColorStop(1.0, '#8596ab');
    c.fillStyle = litG;
    c.fill();

    // Shaded bevel facet
    c.beginPath();
    c.moveTo(28.5, 0);
    c.lineTo(28.5, -litSign * 13.0);
    c.lineTo(34.5, -litSign * 11.8);
    c.lineTo(56.5, 0);
    c.closePath();
    const shdG = c.createLinearGradient(32, 0, 44, -litSign * 11);
    shdG.addColorStop(0.0, '#627083');
    shdG.addColorStop(0.55, '#3e4756');
    shdG.addColorStop(1.0, '#212730');
    c.fillStyle = shdG;
    c.fill();

    // Sharp beveled center spine ridge catchlight + crisp heel bevel line
    c.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(29.8, 0);
    c.lineTo(54.2, 0);
    c.stroke();

    traceSpear();
    c.strokeStyle = '#070504';
    c.lineWidth = 3.2;
    c.stroke();

    c.restore();
  }

  /** Pre-render and cache 2x-SSAA forged wall-mount socket sprite for wall orientation 0..3. */
  getSpikeSocketSprite(wall = 0) {
    const w = (wall >= 0 && wall < 4) ? (wall | 0) : 0;
    if (!this._spikeCache) this._spikeCache = new Map();
    return this._cachedHdSprite(this._spikeCache, `sock:${w}`, c => this._paintSpikeSocket(c, w), 256, 2);
  }

  /** Pre-render and cache 2x-SSAA beveled forged-steel spearhead & plunger sprite for wall orientation 0..3. */
  getSpikeBladeSprite(wall = 0) {
    const w = (wall >= 0 && wall < 4) ? (wall | 0) : 0;
    if (!this._spikeCache) this._spikeCache = new Map();
    return this._cachedHdSprite(this._spikeCache, `blade:${w}`, c => this._paintSpikeBlade(c, w), 256, 2);
  }

  /** Render forged oak-bronze & beveled-steel wall spike anchored cleanly on wall seam `wall` (0:W, 1:N, 2:E, 3:S). */
  _drawWallSpike(ctx, cx, cy, wall, ext, warn = 0) {
    const w = (wall >= 0 && wall < 4) ? (wall | 0) : 0;
    const e = Math.max(0, Math.min(1, ext));
    const wn = Math.max(0, Math.min(1, warn));
    const seams = [
      [cx * T, (cy + 0.5) * T, 1, 0],
      [(cx + 0.5) * T, cy * T, 0, 1],
      [(cx + 1) * T, (cy + 0.5) * T, -1, 0],
      [(cx + 0.5) * T, (cy + 1) * T, 0, -1],
    ];
    const [ox, oy, dx, dy] = seams[w];
    const { ang, ca, sa } = this._spikeLight(w);
    const slide = (e - 1) * 35;
    const tipU = 56.5 + slide;

    ctx.save();
    if (this.q?.fastFx) {
      ctx.translate(ox, oy);
      if (wn > 0.02) {
        ctx.fillStyle = `rgba(255, 112, 32, ${(0.55 * wn).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(dx * 8.5, dy * 8.5, 8.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (e > 0.01) {
        const blade = this.getSpikeBladeSprite(w);
        if (blade && isDrawableOk(blade.canvas)) {
          let sx = 0, sy = 0, sw = 256, sh = 256, dstX = -64, dstY = -64;
          if (w === 0) {
            sx = Math.max(0, Math.min(256, (69 - slide) * 2));
            sw = 256 - sx;
            dstX = -64 + slide + sx / 2;
          } else if (w === 1) {
            sy = Math.max(0, Math.min(256, (69 - slide) * 2));
            sh = 256 - sy;
            dstY = -64 + slide + sy / 2;
          } else if (w === 2) {
            sw = Math.max(0, Math.min(256, (59 + slide) * 2));
            dstX = -64 - slide;
          } else {
            sh = Math.max(0, Math.min(256, (59 + slide) * 2));
            dstY = -64 - slide;
          }
          if (sw > 0 && sh > 0) {
            ctx.drawImage(blade.canvas, sx, sy, sw, sh, dstX, dstY, sw / 2, sh / 2);
          }
        }
      }
      const sock = this.getSpikeSocketSprite(w);
      if (sock && isDrawableOk(sock.canvas)) {
        ctx.drawImage(sock.canvas, -64, -64, 128, 128);
      } else {
        this._paintSpikeSocket(ctx, w);
      }
      ctx.restore();
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.qName === 'ultra' ? 'high' : 'medium';
    ctx.translate(ox, oy);

    // 1. World-consistent down-right cast floor shadow (clipped to open floor side u >= 0.5)
    const su = 3 * ca + 5 * sa;
    const sv = -3 * sa + 5 * ca;
    ctx.save();
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.rect(0.5, -26, 66, 52);
    ctx.clip();
    ctx.fillStyle = 'rgba(0, 0, 8, 0.42)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(su, -14.8 + sv, 12.6, 29.6, 4) : ctx.rect(su, -14.8 + sv, 12.6, 29.6);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(4 + su, -8 + sv);
    ctx.lineTo(Math.max(12, tipU - 22) + su, -10.5 + sv);
    ctx.lineTo(Math.max(16, tipU - 18) + su, -13 + sv);
    ctx.lineTo(tipU + su, sv);
    ctx.lineTo(Math.max(16, tipU - 18) + su, 13 + sv);
    ctx.lineTo(Math.max(12, tipU - 22) + su, 10.5 + sv);
    ctx.lineTo(4 + su, 8 + sv);
    ctx.closePath();
    ctx.fill();

    // 2. Dark recessed bore throat cavity + subtle priming ember cue during telegraph/active hold
    ctx.fillStyle = '#06070a';
    ctx.fillRect(3.5, -10.5, 9.0, 21.0);
    if (wn > 0.02) {
      const tg = ctx.createRadialGradient(8.5, 0, 1, 8.5, 0, 11.5);
      tg.addColorStop(0.0, `rgba(255, 136, 44, ${(0.62 * wn).toFixed(3)})`);
      tg.addColorStop(0.55, `rgba(205, 42, 16, ${(0.28 * wn).toFixed(3)})`);
      tg.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = tg;
      ctx.fillRect(3.5, -11.5, 10.5, 23.0);
    }
    ctx.restore();

    // 3. Sliding forged-steel spearhead & plunger clipped cleanly inside the bore mouth (u >= 5.0)
    const blade = this.getSpikeBladeSprite(w);
    ctx.save();
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.rect(5.0, -24, 60, 48);
    ctx.clip();
    ctx.rotate(-ang);
    if (blade && isDrawableOk(blade.canvas)) {
      ctx.drawImage(blade.canvas, -64 + dx * slide, -64 + dy * slide, 128, 128);
    } else {
      ctx.save();
      ctx.translate(dx * slide, dy * slide);
      this._paintSpikeBlade(ctx, w);
      ctx.restore();
    }
    if (e > 0.96) {
      ctx.save();
      ctx.rotate(ang);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(29.5 + slide, 0);
      ctx.lineTo(54.5 + slide, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // 4. Forged steel anchor flange, domed steel rivets & oak-bronze throat collar over the shaft base
    const sock = this.getSpikeSocketSprite(w);
    if (sock && isDrawableOk(sock.canvas)) {
      ctx.drawImage(sock.canvas, -64, -64, 128, 128);
    } else {
      this._paintSpikeSocket(ctx, w);
    }
    ctx.restore();
  }

  /**
   * Pre-render and cache a crisp 128x128 supersampled floor vent sprite faithful to original OBSTACLE/4..7.
   * variant: 0 (square 5-louver grate), 1 (round 3-vertical-slot grate), 2 (open circular vent pipe), 3 (diamond 3-slot grate).
   */
  getVentSprite(variant = 0) {
    const v = ((variant | 0) % 4 + 4) % 4;
    if (!this._ventCache) this._ventCache = new Map();
    return this._cachedHdSprite(this._ventCache, `v:${v}`, c => {
      const rRect = (x, y, w, h, r) => {
        c.beginPath();
        if (c.roundRect) c.roundRect(x, y, w, h, r);
        else c.rect(x, y, w, h);
      };
      const bevelGrad = () => {
        const g = c.createLinearGradient(-46, -46, 46, 46);
        g.addColorStop(0.0, '#8e9aa8');
        g.addColorStop(0.28, '#808c9c');
        g.addColorStop(0.58, '#6c7480');
        g.addColorStop(0.84, '#58606c');
        g.addColorStop(1.0, '#303438');
        return g;
      };
      const drawDropShadow = drawShape => {
        c.save();
        c.translate(3.5, 4.5);
        drawShape();
        c.fillStyle = 'rgba(0, 0, 8, 0.45)';
        c.fill();
        c.restore();
      };

      if (v === 0) {
        const shape = () => rRect(-46, -46, 92, 92, 12);
        drawDropShadow(shape);
        shape();
        c.fillStyle = bevelGrad();
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 6.0;
        c.stroke();

        // Top-left crisp steel catch highlight
        c.strokeStyle = 'rgba(252, 252, 252, 0.55)';
        c.lineWidth = 3.0;
        c.beginPath(); c.moveTo(-36, -34); c.lineTo(-36, -38); c.lineTo(30, -38); c.stroke();

        // 5 horizontal recessed dark louver slots (exact match to OBSTACLE/4)
        for (let s = 0; s < 5; s++) {
          const sy = -33 + s * 15;
          rRect(-31, sy, 62, 7.5, 3.5);
          c.fillStyle = '#000000';
          c.fill();
          c.fillStyle = 'rgba(252, 252, 252, 0.22)';
          c.fillRect(-29, sy + 7.5, 58, 1.5);
        }
      } else if (v === 1) {
        const shape = () => { c.beginPath(); c.arc(0, 0, 46, 0, Math.PI * 2); };
        drawDropShadow(shape);
        shape();
        c.fillStyle = bevelGrad();
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 6.0;
        c.stroke();

        // Specular rim catch
        c.strokeStyle = 'rgba(252, 252, 252, 0.65)';
        c.lineWidth = 3.0;
        c.beginPath(); c.arc(0, 0, 39, Math.PI * 0.98, Math.PI * 1.48); c.stroke();

        // 3 vertical recessed slots (exact match to OBSTACLE/5)
        const slots = [[-19, 54], [0, 68], [19, 54]];
        for (const [sx, sh] of slots) {
          rRect(sx - 5.5, -sh / 2, 11, sh, 5.5);
          c.fillStyle = '#000000';
          c.fill();
        }
      } else if (v === 2) {
        const shape = () => { c.beginPath(); c.arc(0, 0, 46, 0, Math.PI * 2); };
        drawDropShadow(shape);
        shape();
        c.fillStyle = bevelGrad();
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 6.0;
        c.stroke();

        c.strokeStyle = 'rgba(252, 252, 252, 0.65)';
        c.lineWidth = 3.2;
        c.beginPath(); c.arc(0, 0, 39, Math.PI * 0.98, Math.PI * 1.48); c.stroke();

        // Open circular pipe hole (exact match to OBSTACLE/6)
        c.beginPath(); c.arc(0, 0, 27, 0, Math.PI * 2);
        const pitG = c.createRadialGradient(-6, -6, 2, 2, 2, 27);
        pitG.addColorStop(0.0, '#1c2026');
        pitG.addColorStop(0.55, '#07080a');
        pitG.addColorStop(1.0, '#000000');
        c.fillStyle = pitG;
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 4.5;
        c.stroke();
      } else {
        const shape = () => {
          c.beginPath();
          c.moveTo(0, -52); c.lineTo(52, 0); c.lineTo(0, 52); c.lineTo(-52, 0);
          c.closePath();
        };
        drawDropShadow(shape);
        shape();
        c.fillStyle = bevelGrad();
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 6.0;
        c.stroke();

        c.strokeStyle = 'rgba(252, 252, 252, 0.58)';
        c.lineWidth = 2.8;
        c.beginPath(); c.moveTo(-36, -6); c.lineTo(0, -42); c.lineTo(14, -28); c.stroke();

        // 3 horizontal recessed slots inside diamond (exact match to OBSTACLE/7)
        const slots = [[-19, 34], [0, 66], [19, 34]];
        for (const [sy, sw] of slots) {
          rRect(-sw / 2, sy - 5, sw, 10, 4.5);
          c.fillStyle = '#000000';
          c.fill();
        }
      }
    });
  }

  /** Wall-mounted cathode terminals anchoring the electric barrier into opposing brick walls */
  drawBarrierTerminals(ctx, x, y, horiz) {
    const paintCap = (cx, cy, vertical) => {
      ctx.save();
      ctx.translate(cx, cy);
      if (vertical) ctx.rotate(Math.PI / 2);
      const pw = 24, ph = 8;
      const g = ctx.createLinearGradient(-pw / 2, -ph / 2, pw / 2, ph / 2);
      g.addColorStop(0, '#5a6882'); g.addColorStop(0.5, '#2b3446'); g.addColorStop(1, '#121722');
      ctx.fillStyle = g;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-pw / 2, -ph / 2, pw, ph, 2.5);
      else ctx.rect(-pw / 2, -ph / 2, pw, ph);
      ctx.fill();
      ctx.strokeStyle = 'rgba(5, 8, 14, 0.85)'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.fillStyle = '#091424';
      ctx.fillRect(-8.5, -1.6, 17, 3.2);
      const ion = ctx.createLinearGradient(-8, 0, 8, 0);
      ion.addColorStop(0, '#289eff'); ion.addColorStop(0.5, '#d8f8ff'); ion.addColorStop(1, '#289eff');
      ctx.fillStyle = ion;
      ctx.fillRect(-7.5, -1.1, 15, 2.2);
      ctx.restore();
    };
    if (horiz) { paintCap(x * T, y * T + T / 2, true); paintCap((x + 1) * T, y * T + T / 2, true); }
    else {
      const topY = y * T + 2;
      paintCap(x * T + T / 2, topY, false);
      paintCap(x * T + T / 2, (y + 1) * T, false);
    }
  }

  drawBarriers(dt = 1 / 60) {
    const g = this.game, ctx = this.ctx;
    if (!this.barrierState) this.barrierState = new Map();
    for (const key of this.barrierState.keys()) if (!g.barriers.has(key)) this.barrierState.delete(key);
    for (const [i, life] of g.barriers) {
      const x = i % W, y = (i / W) | 0;
      const across = g.terrain[i - 1] === TER.WALL && g.terrain[i + 1] === TER.WALL;
      let st = this.barrierState.get(i);
      if (!st) {
        st = { frame: Math.floor(Math.random() * 8), timer: 0, age: 0, horiz: across };
        this.barrierState.set(i, st);
      }
      st.age += dt;
      st.timer += dt;
      while (st.timer >= 2 / TICK_HZ) {                       // FRACAS.EXE 0xeb67..0xebed: random non-repeating frame every 2 ticks (15.5 Hz)
        st.timer -= 2 / TICK_HZ;
        let next = st.frame;
        while (next === st.frame) next = Math.floor(Math.random() * 8);
        st.frame = next;
      }
      const k = (st.horiz ? 8 : 0) + st.frame;
      const spr = this.getBarrierSprite(k);
      const sputter = life < 0.22 ? (0.45 + 0.55 * Math.sin(st.age * 70)) * Math.max(0.25, life / 0.22) : 1;
      const fadeIn = Math.min(1, st.age / 0.08);
      ctx.save();
      ctx.globalAlpha = fadeIn * sputter;
      this.drawBarrierTerminals(ctx, x, y, st.horiz);
      if (spr && isDrawableOk(spr.canvas)) {
        const dx = x * T + (T - spr.w) / 2 - spr.pad, dy = y * T + (T - spr.h) / 2 - spr.pad;
        ctx.drawImage(spr.canvas, dx, dy);
        if (st.age < 0.14) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (1 - st.age / 0.14) * 0.65;
          ctx.drawImage(spr.canvas, dx, dy);
        }
      }
      ctx.restore();
      if (Math.random() < dt * 3.5 * this.q.particles) {
        const off = 0.2 + Math.random() * 0.6;
        this.particles.push({
          k: 'spark', x: x + (st.horiz ? off : 0.5), y: y + (st.horiz ? 0.5 : off),
          vx: (Math.random() - 0.5) * 1.4, vy: (Math.random() - 0.5) * 1.4,
          t: 0, life: 0.22, s: 0.16, rot: 0, c: '#a8ecff',
        });
      }
    }
  }

  /** Volumetric sunken stone rift well lit from top-left [-0.55, -0.62] with counter-rotating plasma filaments & LOADREAD motes */
  drawPortal(dt = 1 / 60) {
    const g = this.game, ctx = this.ctx, t = this.time;
    if (!g.portal) return;
    this.portalSpawnT = Math.min(1, (this.portalSpawnT || 0) + dt * 1.65);
    const e = 1 - Math.pow(1 - this.portalSpawnT, 3);
    const eScale = 0.25 + 0.75 * e;
    const cx = (g.portal.x + 0.5) * T, cy = (g.portal.y + 0.5) * T;
    const outerR = 0.46 * T * eScale, innerR = outerR * 0.74, aspect = 0.93;

    ctx.save();
    ctx.translate(cx, cy);

    // 1+2+3a. Cached static AO halo, carved granite curb, sunken bevel, masonry joints & obsidian well base
    let base = this._portalBase;
    if (!base) {
      const r0 = 0.46 * T, ir0 = r0 * 0.74, half = 64;
      base = document.createElement('canvas');
      base.width = 128; base.height = 128;
      const b = base.getContext('2d');
      b.translate(half, half);

      const ao = b.createRadialGradient(0, 2, r0 * 0.7, 0, 2, r0 * 1.38);
      ao.addColorStop(0, 'rgba(0, 0, 0, 0.75)');
      ao.addColorStop(0.65, 'rgba(8, 36, 38, 0.36)');
      ao.addColorStop(1, 'rgba(0, 0, 0, 0)');
      b.fillStyle = ao;
      b.beginPath(); b.ellipse(0, 2, r0 * 1.38, r0 * 1.38 * aspect, 0, 0, Math.PI * 2); b.fill();

      b.save();
      b.scale(1, aspect);
      const curb = b.createLinearGradient(-r0 * 0.8, -r0 * 0.85, r0 * 0.8, r0 * 0.85);
      curb.addColorStop(0, '#8a96a8'); curb.addColorStop(0.45, '#465060'); curb.addColorStop(1, '#161b24');
      b.fillStyle = curb;
      b.beginPath(); b.arc(0, 0, r0, 0, Math.PI * 2); b.fill();
      b.strokeStyle = 'rgba(0, 0, 0, 0.7)'; b.lineWidth = 2; b.stroke();

      const bevel = b.createLinearGradient(-ir0, -ir0, ir0, ir0);
      bevel.addColorStop(0, '#0a0f18'); bevel.addColorStop(0.55, '#193b44'); bevel.addColorStop(1, '#44b8ac');
      b.fillStyle = bevel;
      b.beginPath(); b.arc(0, 0, ir0 + 3.5, 0, Math.PI * 2); b.fill();

      b.strokeStyle = 'rgba(8, 12, 18, 0.6)'; b.lineWidth = 1.5;
      b.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = k * (Math.PI / 4);
        b.moveTo(Math.cos(a + 0.39) * (ir0 + 2), Math.sin(a + 0.39) * (ir0 + 2));
        b.lineTo(Math.cos(a + 0.39) * r0, Math.sin(a + 0.39) * r0);
      }
      b.stroke();

      b.beginPath(); b.arc(0, 0, ir0, 0, Math.PI * 2); b.clip();
      const well = b.createRadialGradient(-2, -3, 1, 0, 0, ir0);
      well.addColorStop(0, '#02070c'); well.addColorStop(0.42, '#06202a');
      well.addColorStop(0.78, '#0c4e5c'); well.addColorStop(1, '#1b8a82');
      b.fillStyle = well; b.fillRect(-ir0, -ir0, ir0 * 2, ir0 * 2);
      b.restore();
      this._portalBase = base;
    }
    if (eScale === 1) {
      ctx.drawImage(base, -64, -64);
    } else {
      ctx.save();
      ctx.scale(eScale, eScale);
      ctx.drawImage(base, -64, -64);
      ctx.restore();
    }

    ctx.save();
    ctx.scale(1, aspect);

    // Pulsing carved arcane runes around the stone ring
    const runePhase = t * 2.8, rMid = (outerR + innerR) * 0.5;
    for (let k = 0; k < 8; k++) {
      const a = k * (Math.PI / 4);
      const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(runePhase + k * 0.9));
      ctx.fillStyle = `rgba(110, 255, 224, ${pulse * 0.85})`;
      ctx.beginPath(); ctx.arc(Math.cos(a) * rMid, Math.sin(a) * rMid, 2.2, 0, Math.PI * 2); ctx.fill();
    }

    // 3b. Clipped volumetric swirling vortex filaments & caustic core
    const activeDescent = this.portalEntries?.size > 0;
    const surge = activeDescent ? 1.55 : 1.0;
    const fast = !!this.q?.fastFx;
    if (!fast) {
      ctx.beginPath(); ctx.arc(0, 0, innerR, 0, Math.PI * 2); ctx.clip();
    }

    ctx.globalCompositeOperation = 'lighter';
    const ringCount = fast ? 2 : 3;
    for (let ring = 0; ring < ringCount; ring++) {
      const dir = ring % 2 === 0 ? 1 : -1;
      const rot = t * (1.4 + ring * 0.75) * surge * dir;
      const rad = innerR * (0.86 - ring * 0.22);
      ctx.strokeStyle = ['#1fd6b8', '#48b8ff', '#b8fff2'][ring];
      ctx.lineWidth = (3.2 - ring * 0.7) * (activeDescent ? 1.18 : 1.0);
      for (let arc = 0; arc < 2; arc++) {
        const baseRot = rot + arc * Math.PI;
        ctx.globalAlpha = Math.min(1, (0.42 + ring * 0.14) * (activeDescent ? 1.25 : 1.0));
        ctx.beginPath(); ctx.arc(0, 0, rad, baseRot, baseRot + 1.9); ctx.stroke();
      }
    }
    // Deep receding caustic core
    const corePulse = (0.72 + 0.28 * Math.sin(t * 5 * surge)) * (activeDescent ? 1.25 : 1.0);
    const rCore = innerR * 0.65;
    ctx.globalAlpha = Math.min(1, 0.55 * corePulse);
    ctx.drawImage(this.glow('#3cf0c8'), -rCore, -rCore, rCore * 2, rCore * 2);
    if (!fast) {
      ctx.globalAlpha = Math.min(1, 0.85 * corePulse);
      ctx.drawImage(this.glow('#e1fff8'), -rCore * 0.5, -rCore * 0.5, rCore, rCore);
    }
    ctx.restore();

    // 4. Orbiting & rising DE_MAGIC/0..3 sparkles emerging from the pit
    if (this.portalMotes?.length) {
      for (let k = 0; k < this.portalMotes.length; k++) {
        const m = this.portalMotes[k];
        m.lift = (m.lift + dt * 0.65) % 1;
        m.ang += m.sp * dt;
        if (fast && (k & 1)) continue;
        const r = innerR * (0.28 + m.rad * (1 - m.lift * 0.45));
        const mx = Math.cos(m.ang) * r, my = Math.sin(m.ang) * r * aspect - m.lift * (0.45 * T);
        const star = this.tintedMagic(m.fr % 4, '#90ffe8');
        ctx.globalAlpha = Math.sin(m.lift * Math.PI) * 0.9 * e;
        if (star) {
          const sk = 14 / Math.max(star.width, star.height, 1);
          const sw = star.width * sk, sh = star.height * sk;
          ctx.drawImage(star, mx - sw / 2, my - sh / 2, sw, sh);
        } else {
          ctx.fillStyle = '#90ffe8'; ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
        }
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** darkness with soft holes around light sources (cheap: 1/4-res canvas, upscaled smoothly) */
  drawLighting(depth = 0.75) {
    const g = this.game, l = this.lctx, q = 0.25, t = this.time;
    if (!l || l.isContextLost?.() || !this.light?.width) return;
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, WW * q, WH * q);
    l.fillStyle = `rgba(4,3,12,${this.mood[0] * depth})`; l.fillRect(0, 0, WW * q, WH * q);
    l.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => { l.globalAlpha = a; l.drawImage(this.glow('#ffffff'), (x - r) * T * q, (y - r) * T * q, r * 2 * T * q, r * 2 * T * q); };
    for (const p of g.players) if (p.alive) hole(p.x, p.y, 3.2);
    for (const b of g.bombs) hole(b.cx + 0.5, b.cy + 0.5, 1.6 + Math.sin(t * 10) * 0.1);
    for (const i of g.flames.keys()) hole(i % W + 0.5, ((i / W) | 0) + 0.5, 1.6);
    for (const p of g.projs) hole(p.x, p.y, 1.6);
    for (const i of g.items.keys()) hole(i % W + 0.5, ((i / W) | 0) + 0.5, 1.45, 0.9);
    for (const m of g.monsters) if (m.alive && m.boss) hole(m.x, m.y, 2);
    if (g.portal) hole(g.portal.x + 0.5, g.portal.y + 0.5, 3);
    for (const [i] of g.barriers) hole(i % W + 0.5, ((i / W) | 0) + 0.5, 1.4);
    for (const w of g.winds || []) hole(w.x + 0.5, w.y + 0.5, 1.5, 0.55);
    if (!g.players.length) hole(10.5, 7.5, 9, 0.8);                   // title / arena preview
    l.globalAlpha = 1; l.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.light, 0, 0, WW, WH);
  }

  drawGlows(alpha = 1, dt = 1 / 60) {
    const g = this.game, ctx = this.ctx, t = this.time, L = (a, b) => a + (b - a) * alpha;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of g.players) if (p.alive && p.cast > 0) this.addGlow(ctx, TEAM[p.slot].color, L(p.px, p.x), L(p.py, p.y) - 0.2, 0.9, 0.4);
    for (const b of g.bombs) {
      const urg = Math.max(0, 1 - b.fuse / FUSE);
      const bx = b.prx !== undefined ? L(b.prx, b.rx) : b.cx;
      const by = b.pry !== undefined ? L(b.pry, b.ry) : b.cy;
      const bCol = { fire: '#ff8a20', electric: '#74bce0', magic: '#e060ff' }[b.kind || 'fire'] || '#ff8a20';
      this.addGlow(ctx, bCol, bx + 0.5, by + 0.4, 0.55 + urg * 0.25, 0.14 + urg * 0.14 + Math.sin(t * 20) * 0.04 * urg);
    }
    for (const [i, f] of g.flames) {
      const kind = f.kind || 'fire';
      const maxT = f.maxT || BLAST_TIMES[kind] || BLAST_TIME;
      this.addGlow(ctx, { fire: '#ff7a20', electric: '#a8dcff', magic: '#ff60ff' }[kind] || '#ff7a20', i % W + 0.5, ((i / W) | 0) + 0.5, 1.25, 0.10 * Math.min(1, f.t / maxT) + 0.03);
    }
    for (const p of g.projs) {
      const px = p.px !== undefined ? L(p.px, p.x) : p.x;
      const py = p.py !== undefined ? L(p.py, p.y) : p.y;
      this.addGlow(ctx, { fire: '#ff7020', electric: '#a0d8ff', teleport: '#ff60ff', wind: '#c0d8ff' }[p.spell] || '#ffffff', px, py, 0.8, 0.28);
    }
    for (const [i, it] of g.items) {
      const col = PICKUP_INFO[it.name]?.color || '#ffffff';
      const rise = Math.min(1, it.age * 4);
      const bob = Math.sin(t * 3.2 + i) * 0.055 - 0.07 * rise;
      const cx = i % W + 0.5, cy = ((i / W) | 0) + 0.5 + bob;
      this.addGlow(ctx, col, cx, cy, 0.72, (0.16 + Math.sin(t * 4 + i) * 0.04) * rise);
      this.addGlow(ctx, '#ffffff', cx, cy, 0.34, 0.06 * rise);
    }
    for (const [i, v] of this.ventFlash) {
      this.addGlow(ctx, '#ff6a10', i % W + 0.5, ((i / W) | 0) + 0.5, 1, v);
      if (v - dt <= 0) this.ventFlash.delete(i); else this.ventFlash.set(i, v - dt);
    }
    for (const w of g.winds || []) {
      const age = Math.max(0, (w.max || 8.2) - w.t);
      const fade = Math.min(1, age * 4.5) * Math.min(1, Math.max(0, w.t / 0.45));
      if (fade > 0) this.addGlow(ctx, '#b4e4ff', w.x + 0.5, w.y + 0.5, 1.0, (0.16 + Math.sin(t * 7 + (w.id || 0)) * 0.04) * fade);
    }
    for (const [i, life] of g.barriers) {
      const bx = i % W, by = (i / W) | 0;
      const horiz = this.barrierState?.get(i)?.horiz ?? (g.terrain[i - 1] === TER.WALL && g.terrain[i + 1] === TER.WALL);
      const fade = life < 0.2 ? Math.max(0.3, life / 0.2) : 1;
      const pulse = (0.34 + Math.random() * 0.18) * fade;
      this.addGlow(ctx, '#38b8ff', bx + 0.5, by + 0.5, 1.05, pulse);
      if (horiz) {
        this.addGlow(ctx, '#8be6ff', bx + 0.08, by + 0.5, 0.55, pulse * 0.72);
        this.addGlow(ctx, '#8be6ff', bx + 0.92, by + 0.5, 0.55, pulse * 0.72);
      } else {
        this.addGlow(ctx, '#8be6ff', bx + 0.5, by + 0.08, 0.55, pulse * 0.72);
        this.addGlow(ctx, '#8be6ff', bx + 0.5, by + 0.92, 0.55, pulse * 0.72);
      }
    }
    if (g.portal) {
      const pPulse = (0.48 + Math.sin(t * 3.8) * 0.12) * (this.portalEntries?.size ? 1.45 : 1.0);
      this.addGlow(ctx, '#20e8b8', g.portal.x + 0.5, g.portal.y + 0.5, 1.45, Math.min(0.65, pPulse * 0.34));
    }
    for (const p of g.players) {
      if (!p.alive) continue;
      const wx = L(p.px, p.x), wy = L(p.py, p.y);
      if (p.tpPhase) {
        this.addGlow(ctx, '#40f4ff', wx, wy - 0.1, 0.95, 0.32 + Math.sin(t * 9) * 0.08);
      } else if (p.radiation > 0) {
        this.addGlow(ctx, '#ffd400', wx, wy, 0.95, 0.24 + Math.sin(t * 7) * 0.06);
      } else if (p.invuln > 0) {
        this.addGlow(ctx, TEAM[p.slot].light, wx, wy, 0.85, Math.min(1, p.invuln) * 0.18);
      }
      if (p.stun > 0 && !p.tpPhase) {
        const pulse = this.zapFx?.has(p.id) ? 0.78 : 0.46;
        this.addGlow(ctx, '#74d6ff', wx, wy - 0.12, 1.05, pulse + Math.random() * 0.32);
      }
    }
    for (const m of g.monsters) {
      if (!m.alive) continue;
      if (m.tpPhase) this.addGlow(ctx, '#d860ff', L(m.px, m.x), L(m.py, m.y) - 0.1, 0.9, 0.28);
      if (m.zapped > 0) this.addGlow(ctx, '#a8dcff', L(m.px, m.x), L(m.py, m.y) - 0.2, 1, 0.5 + Math.random() * 0.4);
    }
    if (g.stasis > 0) for (const m of g.monsters) if (m.alive) this.addGlow(ctx, '#ffd700', L(m.px, m.x), L(m.py, m.y) - 0.2, 0.9, 0.45 + Math.sin(t * 6 + m.id) * 0.15);
    ctx.globalCompositeOperation = 'source-over';
  }

  drawParticles(dt) {
    const ctx = this.ctx, parts = this.particles;
    const fast = !!this.q?.fastFx;
    const sparks = this._sparkBatch || (this._sparkBatch = []);
    sparks.length = 0;
    let pw = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.t += dt; if (p.t >= p.life) continue;
      parts[pw++] = p;
      const k = p.t / p.life, drag = Math.exp(-dt * (p.k === 'smoke' ? 1.5 : p.k === 'speck' ? 1.8 : 2.5));
      p.vx *= drag; p.vy = p.vy * drag + (p.k === 'chunk' ? 9 : p.k === 'speck' ? 11 : p.k === 'spark' ? 1.5 : p.k === 'mstar' ? 0.5 : -0.3) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += dt * 6;
      if (p.k === 'spark') {
        sparks.push(p);
      } else if (p.k === 'speck') {
        ctx.globalAlpha = 1 - Math.max(0, (k - 0.65) / 0.35);
        ctx.fillStyle = p.c; ctx.fillRect(Math.floor(p.x * T - p.s / 2), Math.floor(p.y * T - p.s / 2), p.s, p.s);
        ctx.globalAlpha = 1;
      } else if (p.k === 'mstar') {
        const sc = Math.max(4.5, (p.s || 1) * 11 * (1 - k * 0.45));
        this._sparkleCross(ctx, p.x * T, p.y * T, sc, p.c, { alpha: 1 - k * 0.6, glow: fast ? 0 : 0.30 });
      } else if (p.k === 'mote') {
        if (this.airMist) {
          const sz = p.s * T * (0.7 + k * 0.8);
          ctx.globalAlpha = 0.52 * (1 - k);
          ctx.drawImage(this.airMist, p.x * T - sz / 2, p.y * T - sz / 2, sz, sz);
          ctx.globalAlpha = 1;
        }
      } else if (p.k === 'smoke') {
        ctx.globalAlpha = 0.45 * (1 - k); ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x * T, p.y * T, p.s * T * (0.6 + k), 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      } else if (p.k === 'chunk') {
        ctx.save(); ctx.translate(p.x * T, p.y * T); ctx.rotate(p.rot); ctx.fillStyle = p.c; const s = p.s * T * (1 - k * 0.5); ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore();
      } else if (p.k === 'star') {
        const sc = Math.max(4, (p.s || 1) * 12 * (1 - k));
        this._sparkleCross(ctx, p.x * T, p.y * T, sc, p.c || '#fcfc00', { glow: fast ? 0 : 0.28 });
      }
    }
    parts.length = pw;
    if (sparks.length) {
      ctx.globalCompositeOperation = 'lighter';
      if (fast) {
        for (let i = 0; i < sparks.length; i++) {
          const p = sparks[i];
          const k = p.t / p.life;
          const r = Math.max(1.5, p.s * (1 - k * 0.5) * 0.24 * T);
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = p.c;
          ctx.beginPath(); ctx.arc(p.x * T, p.y * T, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else {
        for (let i = 0; i < sparks.length; i++) {
          const p = sparks[i];
          const k = p.t / p.life;
          this.addGlow(ctx, p.c, p.x, p.y, p.s * (1 - k * 0.5), 1 - k);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      sparks.length = 0;
    }
  }

  drawFx(dt) {
    const ctx = this.ctx, fx = this.fx;
    let fw = 0;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      f.t += dt;
      if (f.k === 'magi') {
        const prog = f.t / 0.65, fade = Math.max(0, 1 - prog);
        const cx = f.x * T, cy = f.y * T;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this.addGlow(ctx, '#68f8ff', f.x, f.y, 0.65 + prog * 0.35, 0.38 * fade);
        ctx.strokeStyle = `rgba(0, 252, 252, ${0.62 * fade})`; ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.ellipse(cx, cy + 0.14 * T, (0.14 + prog * 0.64) * T, (0.06 + prog * 0.26) * T, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(252, 0, 252, ${0.46 * fade})`; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.arc(cx, cy, (0.08 + prog * 0.48) * T, 0, Math.PI * 2); ctx.stroke();
        const cols = ['#00fcfc', '#fc00fc', '#fcfc00', '#74bce0'];
        for (let s = 0; s < 6; s++) {
          const a = s * 1.047 + prog * 2.4 + f.x;
          const dist = (0.06 + prog * 0.46) * T;
          this._sparkleCross(ctx, cx + Math.cos(a) * dist, cy + Math.sin(a) * dist * 0.72 - prog * 14, 9.5 - prog * 3.5, cols[(s + Math.floor(f.t * 12)) % 4], { alpha: fade, glow: 0.32 });
        }
        ctx.restore();
        if (f.t < 0.65) fx[fw++] = f;
      } else if (f.k === 'ring') {
        const k = f.t / 0.5; ctx.globalAlpha = 1 - k; ctx.strokeStyle = f.c; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(f.x * T, f.y * T, (0.2 + k * 0.8) * T, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
        if (k < 1) fx[fw++] = f;
      }
    }
    fx.length = fw;
    for (const [id, v] of this.zapFx) {
      let m = null;
      for (let i = 0; i < this.game.monsters.length; i++) if (this.game.monsters[i].id === id) { m = this.game.monsters[i]; break; }
      if (!m) for (let i = 0; i < this.game.players.length; i++) if (this.game.players[i].id === id) { m = this.game.players[i]; break; }
      if (m) this._drawBodyShock(ctx, m.x, m.y - 0.06, id + 1, 1.05);
      if (v - dt <= 0) this.zapFx.delete(id); else this.zapFx.set(id, v - dt);
    }
  }
}

/** load atlas image + metadata (critical core first, optional HD/textures second with retries) */
export async function loadArt({ loadReal = true } = {}) {
  const json = async (url, retries = 2) => {
    for (let left = retries; ; left--) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
        return await r.json();
      } catch (e) {
        if (left <= 0) throw e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };
  const loadImg = (src, errMsg, retries = 2) => new Promise((ok, fail) => {
    const attempt = left => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => left > 0
        ? setTimeout(() => attempt(left - 1), 600)
        : fail(new Error(errMsg || `Failed to load ${src}`));
      i.src = src;
    };
    attempt(retries);
  });

  // Load mandatory base atlas & metadata first so slow mobile tunnels don't drop them under optional texture load.
  const [meta, mons, image] = await Promise.all([
    json('assets/atlas.json'),
    json('assets/monsters.json'),
    loadImg('assets/atlas.png', 'Failed to load assets/atlas.png').then(async i => {
      await i.decode().catch(() => {});
      return i;
    }),
  ]);

  const [real, hdAtlas] = await Promise.all([
    loadReal ? loadRealTextures().catch(e => { console.warn('real textures unavailable', e); return null; }) : Promise.resolve(null),
    loadImg('assets/atlas_hd.png').catch(() => null),
  ]);

  return { image, frames: meta.frames, monsters: mons, real, hdAtlas: hdAtlas || image };
}
