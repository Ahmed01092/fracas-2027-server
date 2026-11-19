// Realistic look for the flat 2D view: CC0 photo textures (Poly Haven) baked into the level background with
// relief lighting, soft wall shadows, bevelled raised walls with a visible front face, and real-stone boulders that
// keep the original boulder shapes. Everything is baked once per level, so the game still runs at full speed.
import { W, H, T as TER } from '../game/constants.js';

const T = 64, WW = W * T, WH = H * T;
const REPEAT = 256;                                   // world px per texture repeat (= 4 tiles)
const FLOOR_TEX = { A: 'monastery_stone_floor', B: 'cobblestone_floor_01', C: 'slab_tiles', D: 'cobblestone_floor_04',
                    E: 'mossy_cobblestone', F: 'patterned_paving_02', G: 'metal_grate_rusty', H: 'mixed_rock_tiles',
                    I: 'cobblestone_floor_04', J: 'square_brick_paving' };
const WALL_TEX = {
  'Stone Halls': 'castle_brick_07',
  'Conveyor Works': 'rock_wall_08',
  'Spike Crypt': 'rock_wall_08',
  'Dark Citadel': 'castle_brick_07'
};
const NAMES = [...new Set([...Object.values(FLOOR_TEX), 'castle_brick_07', 'castle_wall_slates', 'rock_wall_08', 'rock_boulder_dry'])];
const L = (() => { const v = [-0.55, -0.62, 0.56], n = Math.hypot(...v); return v.map(c => c / n); })();   // light from top-left

const loadImg = (src, retries = 2) => new Promise((ok, fail) => {
  const attempt = left => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => left > 0 ? setTimeout(() => attempt(left - 1), 500) : fail(new Error(`Failed ${src}`));
    i.src = src;
  };
  attempt(retries);
});

/** load diffuse / normal / AO of every texture, pre-scaled to one REPEAT tile, as pixel arrays */
export async function loadRealTextures() {
  const out = {};
  let c = null, x = null;
  const px = img => {
    if (!img || !img.width || !img.height) return null;
    try {
      if (!c) {
        c = document.createElement('canvas'); c.width = c.height = REPEAT;
        x = c.getContext('2d', { willReadFrequently: true });
      }
      if (!x) return null;
      x.clearRect(0, 0, REPEAT, REPEAT);
      x.drawImage(img, 0, 0, REPEAT, REPEAT);
      return x.getImageData(0, 0, REPEAT, REPEAT).data;
    } catch {
      return null;
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < NAMES.length) {
      const n = NAMES[next++];
      const [d, nr, ao] = await Promise.all(['diff', 'nor', 'ao'].map(k => loadImg(`assets/real/${n}/${k}.jpg`).catch(() => null)));
      const diff = px(d);
      out[n] = diff ? { d: diff, n: px(nr), ao: px(ao) } : null;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

let _bakeBufs = null;
export function releaseBakeBufs() {
  _bakeBufs = null;
}
function getBakeBufs() {
  const n = WW * WH;
  if (!_bakeBufs || _bakeBufs.n !== n) {
    _bakeBufs = {
      n,
      wallMask: new Uint8Array(n),
      capMask: new Uint8Array(n),
      dist: new Float32Array(n),
      height: new Float32Array(n),
      shadowSrc: new Float32Array(n),
      contactSrc: new Float32Array(n),
      blurTmp: new Float32Array(n),
      shadow: new Float32Array(n),
      contact: new Float32Array(n),
      face: new Uint8Array(n),
      colSum: new Float32Array(WW),
    };
  }
  return _bakeBufs;
}

/** two-pass chamfer distance (in px) from every pixel inside `mask` to the nearest pixel outside */
function distanceInside(mask, w, h, out = null, edgeIsOutside = true) {
  const d = (out && out.length >= w * h) ? out : new Float32Array(w * h), INF = 1e6, D1 = 1, D2 = 1.414;
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + D1); else if (edgeIsOutside) v = Math.min(v, D1);
    if (y > 0) { v = Math.min(v, d[i - w] + D1); if (x > 0) v = Math.min(v, d[i - w - 1] + D2); if (x < w - 1) v = Math.min(v, d[i - w + 1] + D2); } else if (edgeIsOutside) v = Math.min(v, D1);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + D1); else if (edgeIsOutside) v = Math.min(v, D1);
    if (y < h - 1) { v = Math.min(v, d[i + w] + D1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + D2); if (x > 0) v = Math.min(v, d[i + w - 1] + D2); } else if (edgeIsOutside) v = Math.min(v, D1);
    d[i] = v;
  }
  return d;
}

/** box blur of a float map (separable, radius r, 2 passes ~ gaussian, row-major cache-friendly) */
function blur(src, w, h, r, dst = null, tmp = null, colSum = null) {
  let a = src;
  const b = (tmp && tmp.length >= w * h) ? tmp : new Float32Array(w * h);
  const c = (dst && dst.length >= w * h) ? dst : new Float32Array(w * h);
  const cs = (colSum && colSum.length >= w) ? colSum : new Float32Array(w);
  const inv = 1 / (2 * r + 1);
  const wMax = w - 1, hMax = h - 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = (r + 1) * a[row];
      for (let x = 1; x <= r; x++) s += a[row + (x < w ? x : wMax)];
      const xLim = Math.min(w, r + 1);
      for (let x = 0; x < xLim; x++) {
        b[row + x] = s * inv;
        s += a[row + Math.min(wMax, x + r + 1)] - a[row];
      }
      const xMidEnd = w - r - 1;
      for (let x = r + 1; x < xMidEnd; x++) {
        b[row + x] = s * inv;
        s += a[row + x + r + 1] - a[row + x - r];
      }
      for (let x = Math.max(xLim, xMidEnd); x < w; x++) {
        b[row + x] = s * inv;
        s += a[row + wMax] - a[row + Math.max(0, x - r)];
      }
    }
    // Row-major vertical pass using column-sum buffer to avoid L1/L2 cache misses
    for (let x = 0; x < w; x++) cs[x] = (r + 1) * b[x];
    for (let y = 1; y <= r; y++) {
      const yr = Math.min(hMax, y) * w;
      for (let x = 0; x < w; x++) cs[x] += b[yr + x];
    }
    const yLim = Math.min(h, r + 1);
    for (let y = 0; y < yLim; y++) {
      const dstRow = y * w, addRow = Math.min(hMax, y + r + 1) * w;
      for (let x = 0; x < w; x++) {
        c[dstRow + x] = cs[x] * inv;
        cs[x] += b[addRow + x] - b[x];
      }
    }
    const yMidEnd = h - r - 1;
    for (let y = r + 1; y < yMidEnd; y++) {
      const dstRow = y * w, addRow = (y + r + 1) * w, subRow = (y - r) * w;
      for (let x = 0; x < w; x++) {
        c[dstRow + x] = cs[x] * inv;
        cs[x] += b[addRow + x] - b[subRow + x];
      }
    }
    for (let y = Math.max(yLim, yMidEnd); y < h; y++) {
      const dstRow = y * w, addRow = hMax * w, subRow = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) {
        c[dstRow + x] = cs[x] * inv;
        cs[x] += b[addRow + x] - b[subRow + x];
      }
    }
    a = c;
  }
  return c;
}

// REPEAT is 256 (power of 2); bitwise mask avoids 4 integer divisions per pixel
const tex = (x, y) => (((y & 255) << 8) | (x & 255)) << 2;

/** bake the realistic floor + walls of a level into ctx (size W*64 x H*64), optionally writing wall caps + front overhangs into overhangCtx */
export function bakeLevel(ctx, game, real, overhangCtx = null) {
  if (!ctx || !game?.level || !real) return false;
  const lv = game.level;
  let wtName = WALL_TEX[lv.world];
  if (!wtName) {
    wtName = (lv.floor === 'C' || lv.floor === 'G') ? 'castle_wall_slates' : 'castle_brick_07';
  }
  const anyTex = Object.values(real).find(t => t?.d);
  const ft = [real[FLOOR_TEX[lv.floor] || FLOOR_TEX.A], real[FLOOR_TEX.A], real.monastery_stone_floor, anyTex].find(t => t?.d);
  const wt = [real[wtName], real.castle_brick_07, real.castle_wall_slates, ft].find(t => t?.d);
  if (!ft?.d || !wt?.d) return false;
  const { wallMask, capMask, dist, height, shadowSrc, contactSrc, blurTmp, shadow, contact, face, colSum } = getBakeBufs();
  wallMask.fill(0); capMask.fill(0); height.fill(0); shadowSrc.fill(0); face.fill(0);
  const isWall = (cx, cy) => cx < 0 || cy < 0 || cx >= W || cy >= H || game.terrain[cy * W + cx] === TER.WALL;
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) if (isWall(cx, cy))
    for (let y = cy * T; y < cy * T + T; y++) {
      wallMask.fill(1, y * WW + cx * T, y * WW + cx * T + T);
      capMask.fill(1, y * WW + cx * T, y * WW + cx * T + T);
    }
  // front faces stay inside the bottom FACE rows of south-exposed walls so floor vents/props are never buried
  const FACE = 12;
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) if (isWall(cx, cy) && !isWall(cx, cy + 1)) {
    const y0 = (cy + 1) * T - FACE;
    for (let y = y0; y < (cy + 1) * T; y++) {
      capMask.fill(0, y * WW + cx * T, y * WW + cx * T + T);
      face.fill(1 + (y - y0), y * WW + cx * T, y * WW + cx * T + T);
    }
  }
  // continuous rounded bevel over joined wall caps (outer viewport edges stay flush without border outlines)
  distanceInside(capMask, WW, WH, dist, false);
  const R = 22, invR = 1 / R;
  for (let i = 0; i < WW * WH; i++) {
    if (!capMask[i]) continue;
    const k = Math.min(1, dist[i] * invR);
    height[i] = Math.sqrt(Math.max(0, 1 - (1 - k) * (1 - k))) * R;
  }
  // deep soft shadows cast down-right plus contact occlusion grounding walls into the floor
  const SX = 16, SY = 22;
  for (let y = SY; y < WH; y++) {
    const srcRow = (y - SY) * WW, dstRow = y * WW + SX;
    for (let x = 0; x < WW - SX; x++) shadowSrc[dstRow + x] = wallMask[srcRow + x];
  }
  for (let i = 0; i < WW * WH; i++) contactSrc[i] = wallMask[i];
  blur(shadowSrc, WW, WH, 8, shadow, blurTmp, colSum);
  blur(contactSrc, WW, WH, 9, contact, blurTmp, colSum);
  const img = ctx.createImageData(WW, WH); if (!img) return false;
  const o = img.data;
  const overImg = overhangCtx ? overhangCtx.createImageData(WW, WH) : null, ov = overImg?.data;
  const wtd = wt.d, wtn = wt.n, wtao = wt.ao;
  const ftd = ft.d, ftn = ft.n, ftao = ft.ao;
  const L0 = L[0], L1 = L[1], L2 = L[2];
  const nMax = WW * WH - 1;
  for (let y = 0; y < WH; y++) {
    const rowOff = y * WW;
    const wtCapY = ((y >> 1) & 255) << 8;
    const wtFaceY = (y & 255) << 8;
    const ftY = (((y * 0.7) | 0) & 255) << 8;
    const cy = (y / T) | 0;
    for (let x = 0; x < WW; x++) {
      const i = rowOff + x, p = i << 2;
      let r, g, b;
      if (capMask[i]) {
        const t = (wtCapY | ((x >> 1) & 255)) << 2;
        const hx = (height[i < nMax ? i + 1 : nMax] - height[i > 0 ? i - 1 : 0]) * 0.5;
        const hy = (height[i + WW <= nMax ? i + WW : nMax] - height[i >= WW ? i - WW : 0]) * 0.5;
        const wnx = wtn ? wtn[t] / 255 - 0.5 : 0, wny = wtn ? wtn[t + 1] / 255 - 0.5 : 0;
        const nx = -hx * 0.9 + wnx * 0.9, ny = -hy * 0.9 - wny * 0.9;
        const invNl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const lam = Math.max(0, (nx * L0 + ny * L1 + L2) * invNl);
        const ao = wtao ? wtao[t] / 255 : 1;
        const k = (0.35 + 0.95 * lam) * (0.55 + 0.45 * ao) * (0.92 + 0.12 * Math.min(1, height[i] * invR));
        r = wtd[t] * k; g = wtd[t + 1] * k; b = wtd[t + 2] * k;
        if (dist[i] < 1.8) { r *= 0.32; g *= 0.32; b *= 0.32; }                   // crisp dark comic/3D contour outline
      } else if (face[i]) {
        const t = (wtFaceY | ((x >> 1) & 255)) << 2, fy = (face[i] - 1) / FACE;  // side wall in shade
        const k = (0.52 - fy * 0.22) * (wtao ? 0.6 + 0.4 * wtao[t] / 255 : 1);
        r = wtd[t] * k; g = wtd[t + 1] * k; b = wtd[t + 2] * k;
        const cx = (x / T) | 0, lx = x - cx * T;
        if (face[i] === FACE || (lx < 2 && !isWall(cx - 1, cy)) || (lx >= T - 2 && !isWall(cx + 1, cy))) {
          r *= 0.42; g *= 0.42; b *= 0.42;
        }
      } else {
        const t = (ftY | (((x * 0.7) | 0) & 255)) << 2;
        const fnx = ftn ? ftn[t] / 255 - 0.5 : 0, fny = ftn ? ftn[t + 1] / 255 - 0.5 : 0;
        const nx = fnx * 1.6, ny = -fny * 1.6;
        const invNl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const lam = Math.max(0, (nx * L0 + ny * L1 + L2) * invNl);
        const ao = ftao ? ftao[t] / 255 : 1;
        const sh = 1 - shadow[i] * 0.65, cont = 1 - Math.min(1, contact[i] * 1.8) * 0.4;
        // recessed dungeon floor tone calibration ensures clear separation from walls
        const k = (0.38 + 0.62 * lam) * (0.5 + 0.5 * ao) * sh * cont * 0.82;
        r = ftd[t] * k; g = ftd[t + 1] * k; b = ftd[t + 2] * k;
      }
      o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = 255;
      if (ov && wallMask[i]) {
        ov[p] = r; ov[p + 1] = g; ov[p + 2] = b; ov[p + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  if (overhangCtx && overImg) overhangCtx.putImageData(overImg, 0, 0);
  return true;
}

/** real-stone boulders that keep the original boulder silhouettes (OBSTACLE 24..33) */
export function makeBoulders(atlas, frames, real) {
  const rt = real?.rock_boulder_dry;
  if (!rt?.d || !atlas || !frames) return null;
  const out = [];
  let sc = null, scx = null;
  for (let v = 0; v < 10; v++) {
    const f = frames['OBSTACLE/' + (24 + v)]; if (!f) { out.push(null); continue; }
    const [sx, sy, w, h] = f;
    if (!w || !h) { out.push(null); continue; }
    if (!sc || sc.width !== w || sc.height !== h) {
      sc = document.createElement('canvas'); sc.width = w; sc.height = h;
      scx = sc.getContext('2d', { willReadFrequently: true });
    } else if (scx) {
      scx.clearRect(0, 0, w, h);
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    if (!scx || !x) { out.push(null); continue; }
    scx.drawImage(atlas, sx, sy, w, h, 0, 0, w, h);
    const src = scx.getImageData(0, 0, w, h);
    if (!src?.data) { out.push(null); continue; }
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = src.data[i * 4 + 3] > 128 ? 1 : 0;
    const dist = distanceInside(mask, w, h), R = Math.max(10, Math.min(w, h) * 0.42);
    const hgt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask[i]) { const k = Math.min(1, dist[i] / R); hgt[i] = Math.sqrt(Math.max(0, 1 - (1 - k) * (1 - k))) * R; }
    const img = x.createImageData(w, h); if (!img) { out.push(null); continue; }
    const o = img.data, ox = v * 97, oy = v * 53, rtn = rt.n;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx; if (!mask[i]) continue;
      const t = tex(xx + ox, yy + oy);
      const hx = ((xx < w - 1 ? hgt[i + 1] : 0) - (xx > 0 ? hgt[i - 1] : 0)) * 0.5, hy = ((yy < h - 1 ? hgt[i + w] : 0) - (yy > 0 ? hgt[i - w] : 0)) * 0.5;
      const rnx = rtn ? rtn[t] / 255 - 0.5 : 0, rny = rtn ? rtn[t + 1] / 255 - 0.5 : 0;
      const nx = -hx * 0.35 + rnx * 0.95, ny = -hy * 0.35 - rny * 0.95;
      const invNl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const lam = Math.max(0, (nx * L[0] + ny * L[1] + L[2]) * invNl);
      const spec = Math.pow(lam, 24) * 18;
      const k = (0.30 + 0.68 * Math.pow(lam, 1.15)) * (rt.ao ? 0.45 + 0.55 * rt.ao[t] / 255 : 1) * (dist[i] < 2.0 ? 0.28 : 1);
      o[i * 4] = Math.min(255, rt.d[t] * k * 0.95 + spec); o[i * 4 + 1] = Math.min(255, rt.d[t + 1] * k * 0.93 + spec);
      o[i * 4 + 2] = Math.min(255, rt.d[t + 2] * k * 0.9 + spec); o[i * 4 + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    // Promote boulders to permanent HTMLImageElements so Chromium GPU cache eviction cannot turn them black/transparent
    const idx = out.length;
    out.push(c);
    if (typeof Image !== 'undefined') {
      if (typeof c.toBlob === 'function' && typeof URL?.createObjectURL === 'function') {
        try {
          c.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const im = new Image();
            im.onload = () => {
              if (im.naturalWidth > 0) out[idx] = im;
              try { URL.revokeObjectURL(url); } catch {}
            };
            im.onerror = () => { try { URL.revokeObjectURL(url); } catch {} };
            im.src = url;
          }, 'image/png');
          continue;
        } catch {}
      }
      if (typeof c.toDataURL === 'function') {
        try {
          const im = new Image();
          im.onload = () => { if (im.naturalWidth > 0) out[idx] = im; };
          im.onerror = () => {};
          im.src = c.toDataURL('image/png');
        } catch {}
      }
    }
  }
  return out;
}

