// Original PCM samples (assets/sounds/*.raw) + WebAudio generative world soundtracks & fallback synth.
export const WORLD_MUSIC = {
  'Stone Halls':    { root: 50, scale: [0, 2, 3, 5, 7, 8, 10],  prog: [0, 5, 3, 4], bpm: 104 },
  'Conveyor Works': { root: 45, scale: [0, 2, 3, 5, 7, 9, 10],  prog: [0, 3, 6, 4], bpm: 122 },
  'Spike Crypt':    { root: 47, scale: [0, 1, 3, 5, 7, 8, 10],  prog: [0, 5, 1, 4], bpm: 96 },
  'Dark Citadel':   { root: 43, scale: [0, 2, 3, 5, 7, 8, 11],  prog: [0, 5, 6, 4], bpm: 116 },
  'Moonlit Keep':   { root: 48, scale: [0, 2, 3, 5, 7, 9, 10],  prog: [0, 6, 3, 4], bpm: 102 },
  'Ember Vaults':   { root: 46, scale: [0, 1, 4, 5, 7, 8, 10],  prog: [0, 5, 4, 3], bpm: 118 },
  'Verdant Ruins':  { root: 52, scale: [0, 2, 4, 5, 7, 9, 11],  prog: [0, 4, 5, 3], bpm: 106 },
  'Storm Bastion':  { root: 44, scale: [0, 2, 3, 6, 7, 8, 11],  prog: [0, 5, 2, 4], bpm: 124 },
  'Time Halls':     { root: 49, scale: [0, 2, 3, 5, 7, 9, 11],  prog: [0, 3, 5, 4], bpm: 110 },
  'Star Sanctum':   { root: 51, scale: [0, 2, 4, 6, 7, 9, 11],  prog: [0, 4, 2, 5], bpm: 112 },
  'Battle':         { root: 43, scale: [0, 2, 3, 5, 7, 10, 11], prog: [0, 5, 6, 4], bpm: 128 },
  default:          { root: 48, scale: [0, 2, 4, 5, 7, 9, 11],  prog: [0, 5, 3, 4], bpm: 108 },
};
const mtof = m => 440 * 2 ** ((m - 69) / 12);

// original Fracas samples (assets/sounds/*.raw = signed 8-bit mono, 11025 Hz) per game event,
// mapped from the play-sample calls in FRACAS.EXE and checked against recordings of the original
const ORIGINAL = {
  bomb: 'fxa01', bombVent: 'fxa02', boom: 'fxa03', areaElectric: 'fxa06', areaTeleport: 'fxa05',
  fire: 'fxa08', electric: 'fxa10', castTeleport: 'fxa09', wind: 'fxa14', fireHit: 'fxa14', zap: 'fxc05',
  pickup: 'fxc08', power: 'fxc08', reveal: 'fxb09', teleport: 'fxc03', portal: 'fxb07', win: 'fxb08', spike: 'fxb06', barrier: 'fxb03', barrierTouch: 'fxb06',
  die: 'fxc06', respawn: null, stun: 'fxc05', mdie: 'fxf01', getReady: 'fxd01', powerLow: 'fxd03', pause: 'fxd03',
  ui: 'fxe01', select: 'fxe02', bounce: 'fxe03', join: 'fxe04', tick: 'fxe05', title: 'mainsam', rock: null,
};
const RUDE = ['fxc09', 'fxc10', 'fxc11', 'fxc12', 'fxc13'];
// each monster's own call (per-type sound table in FRACAS.EXE); new types use the call of the monster they were drawn from
const VOICE = { 2: 'fxf07', 3: 'fxf03', 4: 'fxf01', 5: 'fxf06', 6: 'fxf02', 7: 'fxf05', 8: 'fxf04', 9: 'fxf03', 10: 'fxf03',
  11: 'fxf06', 12: 'fxf07', 13: 'fxf03', 14: 'fxf04', 15: 'fxf07', 16: 'fxf06', 17: 'fxf01', 18: 'fxf01', 19: 'fxf02', 20: 'fxf02' };

export class Audio {
  constructor() { this.ctx = null; this.sfxVol = 0.8; this.musicVol = 0.45; this.rude = false; this.musicOn = false; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    let c;
    try { c = this.ctx = new AC(); } catch { this.ctx = null; return; }
    this.master = c.createDynamicsCompressor(); this.master.threshold.value = -14; this.master.ratio.value = 4; this.master.connect(c.destination);
    this.sfxBus = c.createGain(); this.sfxBus.gain.value = this.sfxVol; this.sfxBus.connect(this.master);
    this.musicBus = c.createGain(); this.musicBus.gain.value = this.musicVol; this.musicBus.connect(this.master);
    // Lazily create shared reverb only when synthesized SFX or music actually sends to it
    this.verb = null;
    this.samples = {};
    this._onReady = {};
    const names = new Set([...Object.values(ORIGINAL).filter(Boolean), ...RUDE, ...Object.values(VOICE)]);
    for (const n of names) fetch(`assets/sounds/${n}.raw`).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(ab => {
      const pcm = new Int8Array(ab), buf = c.createBuffer(1, Math.max(1, pcm.length), 11025), ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 128;
      this.samples[n] = buf;
      const cbs = this._onReady[n];
      if (cbs) { delete this._onReady[n]; for (const cb of cbs) cb(); }
    }).catch(() => {});
    this.noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  _getVerb() {
    if (this.verb || !this.ctx) return this.verb;
    const c = this.ctx;
    const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 960px), (pointer: coarse)').matches;
    this.verb = c.createConvolver();
    this.verb.buffer = this.impulse(mobile ? 0.9 : 2.4);
    const vg = c.createGain(); vg.gain.value = 0.3;
    this.verb.connect(vg); vg.connect(this.master);
    return this.verb;
  }

  impulse(sec) {
    const c = this.ctx, n = c.sampleRate * sec, b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3; }
    return b;
  }

  setVolumes(sfx, music) {
    this.sfxVol = sfx; this.musicVol = music;
    if (this.ctx) { this.sfxBus.gain.value = sfx; this.musicBus.gain.value = music; }
  }

  // ---------------------------------------------------------------- building blocks
  env(g, t, a, peak, dec, sus = 0, rel = 0.05) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sus || 0.0001), t + a + dec);
    if (rel) g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec + rel);
  }
  osc(type, f0, f1, dur, vol, { t = 0, bus, verb = 0.2, pan = 0 } = {}) {
    const c = this.ctx, now = c.currentTime + t, o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.type = type; o.frequency.setValueAtTime(f0, now); if (f1) o.frequency.exponentialRampToValueAtTime(f1, now + dur);
    this.env(g, now, 0.005, vol, dur);
    p.pan.value = pan; o.connect(g); g.connect(p); p.connect(bus || this.sfxBus);
    if (verb) { const s = c.createGain(); s.gain.value = verb; g.connect(s); s.connect(this._getVerb()); }
    o.start(now); o.stop(now + dur + 0.1);
  }
  noise(dur, vol, filter, f0, f1, { t = 0, q = 1, verb = 0.25, pan = 0 } = {}) {
    const c = this.ctx, now = c.currentTime + t, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), p = c.createStereoPanner();
    s.buffer = this.noiseBuf; s.loop = true; f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, now); if (f1) f.frequency.exponentialRampToValueAtTime(f1, now + dur);
    this.env(g, now, 0.004, vol, dur); p.pan.value = pan;
    s.connect(f); f.connect(g); g.connect(p); p.connect(this.sfxBus);
    if (verb) { const v = c.createGain(); v.gain.value = verb; g.connect(v); v.connect(this._getVerb()); }
    s.start(now); s.stop(now + dur + 0.1);
  }

  /** invoke `cb` once the original sample for `name` is decoded (immediately if already ready) */
  whenReady(name, cb) {
    const n = ORIGINAL[name];
    if (!n || !this.ctx) return;
    if (this.samples?.[n]) { cb(); return; }
    (this._onReady[n] ||= []).push(cb);
  }

  /** play one of the original samples; returns false if it is not loaded */
  sample(n, pan = 0, vol = 1) {
    const buf = this.samples?.[n]; if (!buf) return false;
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain(), p = c.createStereoPanner();
    s.buffer = buf; g.gain.value = vol; p.pan.value = pan;
    s.connect(g); g.connect(p); p.connect(this.sfxBus); s.start();
    return true;
  }
  voice(type, x = 10.5) { if (this.ctx) this.sample(VOICE[type] || 'fxf03', Math.max(-0.8, Math.min(0.8, (x - 10.5) / 12)), 0.8); }

  /** x in tiles (0..21) pans the sound across the stereo field */
  play(name, x = 10.5) {
    if (!this.ctx) return;
    const pan = Math.max(-0.8, Math.min(0.8, (x - 10.5) / 12));
    if (name in ORIGINAL) {
      if (ORIGINAL[name] === null) return;
      const n = name === 'pickup' && this.rude ? RUDE[Math.floor(Math.random() * RUDE.length)] : ORIGINAL[name];
      if (this.sample(n, pan)) return;
    }
    const o = { pan };
    switch (name) {
      case 'boom':
        this.noise(1.1, 0.9, 'lowpass', 2400, 90, { ...o, q: 0.7, verb: 0.45 });
        this.osc('sine', 110, 32, 0.6, 0.9, o);
        this.noise(0.25, 0.4, 'highpass', 3000, 800, o);
        break;
      case 'bomb': this.osc('sine', 340, 120, 0.16, 0.5, o); this.osc('triangle', 680, 300, 0.1, 0.15, o); break;
      case 'pickup':
        if (this.rude) { this.osc('sawtooth', 160, 60, 0.4, 0.3, o); this.osc('square', 90, 140, 0.35, 0.15, { ...o, t: 0.05 }); break; }
        [0, 4, 7, 12].forEach((s, i) => this.osc('triangle', mtof(76 + s), 0, 0.22, 0.25, { ...o, t: i * 0.055, verb: 0.4 }));
        break;
      case 'power': [0, 7, 12, 19].forEach((s, i) => this.osc('sine', mtof(72 + s), 0, 0.3, 0.22, { ...o, t: i * 0.04, verb: 0.5 })); break;
      case 'zap': for (let i = 0; i < 6; i++) this.osc('sawtooth', 300 + Math.random() * 1600, 80 + Math.random() * 200, 0.07, 0.18, { ...o, t: i * 0.04 }); this.noise(0.3, 0.25, 'bandpass', 4000, 2000, { ...o, q: 4 }); break;
      case 'fire': this.noise(0.45, 0.45, 'bandpass', 600, 2400, { ...o, q: 1.2 }); this.osc('sawtooth', 120, 60, 0.3, 0.15, o); break;
      case 'wind': this.noise(0.9, 0.4, 'bandpass', 400, 1800, { ...o, q: 2, verb: 0.5 }); break;
      case 'teleport': this.osc('sine', 300, 1800, 0.45, 0.3, { ...o, verb: 0.6 }); this.osc('triangle', 600, 2400, 0.4, 0.12, { ...o, t: 0.05 }); break;
      case 'die': this.osc('sawtooth', 520, 60, 0.9, 0.35, { ...o, verb: 0.5 }); this.noise(0.5, 0.3, 'lowpass', 1200, 200, o); break;
      case 'mdie': this.noise(0.25, 0.4, 'bandpass', 900, 300, { ...o, q: 3 }); this.osc('square', 420, 90, 0.22, 0.18, o); break;
      case 'bossHit': this.osc('sawtooth', 90, 45, 0.5, 0.5, o); this.noise(0.4, 0.5, 'lowpass', 800, 100, o); break;
      case 'spike': this.osc('square', 1900, 900, 0.08, 0.05, o); this.noise(0.08, 0.08, 'highpass', 5000, 3000, o); break;
      case 'rock': this.noise(0.4, 0.35, 'lowpass', 900, 150, { ...o, q: 1 }); break;
      case 'door': this.osc('triangle', 180, 90, 0.25, 0.25, o); this.noise(0.2, 0.15, 'bandpass', 500, 300, o); break;
      case 'portal': [0, 3, 7, 10, 14].forEach((s, i) => this.osc('sine', mtof(62 + s), 0, 1.6, 0.12, { t: i * 0.09, verb: 0.8 })); break;
      case 'win': [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => this.osc('triangle', mtof(67 + s), 0, 0.5, 0.22, { t: i * 0.08, verb: 0.6 })); break;
      case 'lose': [0, -3, -7, -12].forEach((s, i) => this.osc('sawtooth', mtof(60 + s), 0, 0.6, 0.15, { t: i * 0.22, verb: 0.6 })); break;
      case 'ui': this.osc('triangle', 880, 0, 0.06, 0.12, { verb: 0.1 }); break;
      case 'select': this.osc('triangle', 660, 1320, 0.12, 0.18, { verb: 0.2 }); break;
      case 'barrier': this.noise(0.5, 0.18, 'bandpass', 3000, 3000, { ...o, q: 8 }); this.osc('sawtooth', 60, 60, 0.5, 0.08, o); break;
    }
  }

  // ---------------------------------------------------------------- music sequencer
  music(world) {
    if (!this.ctx) return;
    this.stopMusic();
    const m = WORLD_MUSIC[world] || WORLD_MUSIC.default;
    this.musicOn = true; this.track = m; this.step = 0; this.nextT = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }
  stopMusic() { clearInterval(this.timer); this.musicOn = false; }

  schedule() {
    const c = this.ctx, m = this.track;
    if (!c || !m || c.state !== 'running') { if (c && this.nextT < c.currentTime) this.nextT = c.currentTime + 0.1; return; }
    if (this.nextT < c.currentTime - 0.5) this.nextT = c.currentTime;
    const spb = 60 / m.bpm / 2;          // eighth notes
    while (this.nextT < c.currentTime + 0.12) {
      const s = this.step, bar = Math.floor(s / 8) % m.prog.length, deg = m.prog[bar];
      const chord = [0, 2, 4].map(k => m.root + 12 + m.scale[(deg + k) % 7] + (deg + k >= 7 ? 12 : 0));
      const t = this.nextT - c.currentTime;
      if (s % 8 === 0) chord.forEach(n => this.pad(n, spb * 8, t));
      if (s % 4 === 0) this.osc('triangle', mtof(m.root + m.scale[deg] - 12), 0, spb * 3, 0.22, { t, bus: this.musicBus, verb: 0.1 });
      const arp = chord[[0, 1, 2, 1, 0, 2, 1, 2][s % 8]] + 12;
      if ((s * 7919) % 5 !== 0) this.osc('triangle', mtof(arp), 0, spb * 0.9, 0.06, { t, bus: this.musicBus, verb: 0.5 });
      if (s % 4 === 0) this.kick(t);
      if (s % 2 === 1) this.hat(t);
      this.step++; this.nextT += spb;
    }
  }
  pad(note, dur, t) {
    const c = this.ctx, now = c.currentTime + t, f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(0.05, now + dur * 0.3); g.gain.linearRampToValueAtTime(0.0001, now + dur);
    for (const det of [-7, 7]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(note); o.detune.value = det; o.connect(f); o.start(now); o.stop(now + dur + 0.05); }
    f.connect(g); g.connect(this.musicBus); const v = c.createGain(); v.gain.value = 0.6; g.connect(v); v.connect(this._getVerb());
  }
  kick(t) { this.osc('sine', 120, 40, 0.18, 0.35, { t, bus: this.musicBus, verb: 0 }); }
  hat(t) {
    const c = this.ctx, now = c.currentTime + t, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf; f.type = 'highpass'; f.frequency.value = 7000; this.env(g, now, 0.002, 0.04, 0.05);
    s.connect(f); f.connect(g); g.connect(this.musicBus); s.start(now); s.stop(now + 0.1);
  }
}
