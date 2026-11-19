import { TICK } from '../game/constants.js';

export const STEP = TICK;
export const MAX_ROLLBACK = 30;       // 500 ms rollback window at 60 Hz
export const REDUNDANCY = 10;         // 10 frames (~167 ms) minimum input history per packet
export const PKT_INPUT = 1;
export const PKT_CHECKSUM = 2;

const BIT_BOMB = 1 << 6;
const BIT_POWER = 1 << 7;
const BIT_BOMB_HELD = 1 << 8;
const BIT_POWER_HELD = 1 << 9;

export const EMPTY_PACK = 0x3f; // dir=-1 (7), secDir=-1 (7), all action bits 0

/** Pack a player input object into a compact 16-bit integer. */
export function packInput(inp) {
  if (!inp) return EMPTY_PACK;
  const d = (inp.dir >= 0 && inp.dir <= 3) ? inp.dir : 7;
  const sd = (inp.secDir >= 0 && inp.secDir <= 3) ? inp.secDir : 7;
  let v = d | (sd << 3);
  if (inp.bomb) v |= BIT_BOMB;
  if (inp.power) v |= BIT_POWER;
  if (inp.bombHeld) v |= BIT_BOMB_HELD;
  if (inp.powerHeld) v |= BIT_POWER_HELD;
  return v & 0xffff;
}

/** Unpack a 16-bit packed integer back into a sim-compatible input object. */
export function unpackInput(v) {
  const d = v & 7;
  const sd = (v >> 3) & 7;
  return {
    dir: d <= 3 ? d : -1,
    secDir: sd <= 3 ? sd : -1,
    bomb: (v & BIT_BOMB) !== 0,
    power: (v & BIT_POWER) !== 0,
    bombHeld: (v & BIT_BOMB_HELD) !== 0,
    powerHeld: (v & BIT_POWER_HELD) !== 0,
  };
}

/** Strip one-shot edge presses so predictions only hold sustained direction/buttons. */
export function holdFromConfirmed(v) {
  return v & ~(BIT_BOMB | BIT_POWER);
}

/**
 * Encode a binary input batch packet:
 * [type=1][slot][matchSeq][u32 startFrame][i32 peerAck][u32 senderFrame][i8 localAdv][u8 count][u16[] packs]
 */
export function encodeInputPacket(slot, matchSeq, startFrame, peerAck, senderFrame, packs, localAdv = 0) {
  const count = Math.min(255, packs.length);
  const buf = new ArrayBuffer(17 + count * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, PKT_INPUT);
  dv.setUint8(1, slot & 0xff);
  dv.setUint8(2, matchSeq & 0xff);
  dv.setUint32(3, startFrame >>> 0, true);
  dv.setInt32(7, peerAck | 0, true);
  dv.setUint32(11, senderFrame >>> 0, true);
  dv.setInt8(15, Math.max(-127, Math.min(127, Math.round(localAdv || 0))));
  dv.setUint8(16, count);
  for (let i = 0; i < count; i++) dv.setUint16(17 + i * 2, packs[i] & 0xffff, true);
  return new Uint8Array(buf);
}

/** Encode a binary checksum packet: [type=2][slot][matchSeq][u32 frame][u32 checksum] */
export function encodeChecksumPacket(slot, matchSeq, frame, checksum) {
  const buf = new ArrayBuffer(11);
  const dv = new DataView(buf);
  dv.setUint8(0, PKT_CHECKSUM);
  dv.setUint8(1, slot & 0xff);
  dv.setUint8(2, matchSeq & 0xff);
  dv.setUint32(3, frame >>> 0, true);
  dv.setUint32(7, checksum >>> 0, true);
  return new Uint8Array(buf);
}

/** Decode any binary rollback packet (ArrayBuffer / Uint8Array). Returns null if malformed. */
export function decodePacket(raw) {
  let u8;
  if (raw instanceof Uint8Array) u8 = raw;
  else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
  else if (ArrayBuffer.isView(raw)) u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  else return null;
  if (u8.byteLength < 3) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const type = dv.getUint8(0);
  const slot = dv.getUint8(1);
  const matchSeq = dv.getUint8(2);
  if (type === PKT_INPUT) {
    if (u8.byteLength < 17) return null;
    const startFrame = dv.getUint32(3, true);
    const peerAck = dv.getInt32(7, true);
    const senderFrame = dv.getUint32(11, true);
    const localAdv = dv.getInt8(15);
    const count = dv.getUint8(16);
    if (u8.byteLength < 17 + count * 2) return null;
    const packs = new Array(count);
    for (let i = 0; i < count; i++) packs[i] = dv.getUint16(17 + i * 2, true);
    return { type, slot, matchSeq, startFrame, peerAck, senderFrame, localAdv, packs };
  }
  if (type === PKT_CHECKSUM) {
    if (u8.byteLength < 11) return null;
    return { type, slot, matchSeq, frame: dv.getUint32(3, true), checksum: dv.getUint32(7, true) };
  }
  return null;
}

export function bytesToB64(u8) {
  if (typeof Buffer === 'function') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Choose optimal input delay frames based on measured RTT (keeps controls snappy while slashing rollbacks). */
export function recommendInputDelay(rttMs) {
  if (typeof rttMs !== 'number' || !Number.isFinite(rttMs) || rttMs <= 45) return 0;
  if (rttMs <= 125) return 1;
  if (rttMs <= 225) return 2;
  return 3;
}

function eventKey(frame, e) {
  return `${frame}:${e.t}:${e.id ?? ''}:${e.p ?? ''}:${e.x ?? ''},${e.y ?? ''}:${e.phase ?? ''}:${e.name ?? ''}:${e.kind ?? ''}`;
}

/**
 * Deterministic Fixed-Timestep GGPO-Style Rollback Session.
 * - Symmetric latency-cancelling frame advantage (zero slow-motion at any RTT).
 * - Optional adaptive input delay (0..3 frames) to eliminate visual rollbacks on high-latency links.
 * - Ring-buffer state pooling to avoid 60 Hz typed-array GC pauses.
 * - Supports AI bot slots (deterministic local simulation) and Spectator mode.
 */
export class RollbackSession {
  constructor(game, opts = {}) {
    this.game = game;
    this.spectator = !!opts.spectator;
    this.localSlot = this.spectator ? -1 : (opts.localSlot ?? 0);
    this.matchSeq = (opts.matchSeq ?? 0) & 0xff;
    this.inputDelay = this.spectator ? 0 : Math.max(0, Math.min(4, Math.floor(opts.inputDelay || 0)));
    this.waitingForGo = !!opts.waitForGo;

    const allSlots = [...(opts.slots || game.players.map(p => p.slot))];
    this.botSlots = new Set(opts.botSlots || game.players.filter(p => p.bot).map(p => p.slot));
    this.slots = allSlots.filter(s => !this.botSlots.has(s));
    this.remoteSlots = this.slots.filter(s => s !== this.localSlot);
    this.sendPacket = opts.sendPacket || (() => {});
    this.onEvents = opts.onEvents || (() => {});
    this.onNeedSync = opts.onNeedSync || null;
    this.onDesync = opts.onDesync || null;

    this.localFrame = 0;
    this.confirmedFrame = 0;
    this.acc = 0;
    this.alpha = 0;

    this.stateRing = new Map();        // frame -> pre-frame saveState()
    this._statePool = [];              // recycled state snapshots to avoid TypedArray GC
    this.confirmed = new Map();        // slot -> Map<frame, pack>
    this.localHistory = new Map();     // frame -> local pack (retained for peer gap retransmit)
    this.usedInputs = new Map();       // slot -> Map<frame, pack>
    this.contigFrame = new Map();      // slot -> highest contiguous confirmed frame (-1 initially)
    this.latestRecvFrame = new Map();  // slot -> highest frame seen from peer (-1 initially)
    this.lastRecvWallMs = new Map();   // slot -> Date.now() when last packet arrived
    this.peerReportedAck = new Map();  // slot -> highest peerAck reported by peer
    this.remoteSenderFrame = new Map();// slot -> highest senderFrame seen
    this.remoteAdvEma = new Map();     // slot -> smoothed localAdv reported by peer
    this.localAdvEma = new Map();      // slot -> smoothed our raw advantage vs peer
    this.localChecksums = new Map();   // frame -> checksum
    this.remoteChecksums = new Map();  // frame -> Map<slot, checksum>
    this._fxSeen = new Map();          // eventKey -> frame

    for (const s of this.slots) {
      this.confirmed.set(s, new Map());
      this.usedInputs.set(s, new Map());
      this.contigFrame.set(s, -1);
      this.latestRecvFrame.set(s, -1);
    }

    // Pre-seed neutral frames [0 .. inputDelay-1] for local slot so frame 0 starts immediately with zero wait
    if (!this.spectator && this.inputDelay > 0 && this.confirmed.has(this.localSlot)) {
      const lmap = this.confirmed.get(this.localSlot);
      for (let d = 0; d < this.inputDelay; d++) {
        lmap.set(d, EMPTY_PACK);
        this.localHistory.set(d, EMPTY_PACK);
      }
      this.contigFrame.set(this.localSlot, this.inputDelay - 1);
      this.latestRecvFrame.set(this.localSlot, this.inputDelay - 1);
    }

    // Telemetry & deadlock guards
    this.rollbacks = 0;
    this.maxRollbackDepth = 0;
    this.desyncs = 0;
    this._syncRequestedAtMs = 0;
    this._nextCsSendFrame = 60;
    this._stallStartMs = 0;
    this._lastHeartbeatMs = 0;
  }

  /** Release the synchronized start barrier once all peers are loaded. */
  releaseGo() {
    this.waitingForGo = false;
    this.acc = 0;
  }

  /** Advance wall-clock dt using fixed 60 Hz rollback steps with latency-neutral GGPO time-sync. */
  update(dt, readLocalInputFn) {
    if (this.waitingForGo) {
      this.alpha = 0;
      return 0;
    }
    const clamped = Math.min(0.05, Math.max(0, dt || 0));
    const adv = this.frameAdvantage();
    // Latency-neutral GGPO pacing:
    // - Never slow down due to RTT (one-way latency cancels out symmetrically).
    // - Gently shave 5-15% only when truly ahead of a peer's clock; gently speed up 6% when truly behind.
    let scale = 1.0;
    if (adv <= MAX_ROLLBACK) {
      if (adv > 6) scale = 0.85;
      else if (adv > 2.5) scale = 0.95;
      else if (adv < -5) scale = 1.06;
    }
    this.acc = Math.min(STEP * 4, this.acc + clamped * scale);

    let stepped = 0;
    while (this.acc >= STEP - 1e-7 && stepped < 4) {
      if (this.shouldStall()) {
        this._maybeSendHeartbeat();
        break;
      }
      const localInp = (!this.spectator && readLocalInputFn)
        ? readLocalInputFn()
        : { dir: -1, secDir: -1, bomb: false, power: false };
      this.stepFrame(localInp);
      this.acc = Math.max(0, this.acc - STEP);
      stepped++;
    }
    this.alpha = Math.max(0, Math.min(1, this.acc / STEP));
    return stepped;
  }

  /** Raw frame delta vs slowest active peer (includes one-way latency; shared with peers for symmetric cancellation). */
  _rawLocalAdvantage() {
    if (!this.remoteSlots.length) return 0;
    const now = Date.now();
    let maxRaw = -Infinity;
    for (const s of this.remoteSlots) {
      const p = this.game.players.find(q => q.slot === s);
      if (!p || p.out) continue;
      const lastWall = this.lastRecvWallMs.get(s);
      if (!lastWall || now - lastWall > 1200) continue;
      const sf = this.remoteSenderFrame.get(s);
      if (sf === undefined) continue;
      const raw = this.localFrame - sf;
      const prev = this.localAdvEma.get(s);
      const sm = prev === undefined ? raw : (prev * 0.8 + raw * 0.2);
      this.localAdvEma.set(s, sm);
      if (sm > maxRaw) maxRaw = sm;
    }
    return maxRaw === -Infinity ? 0 : Math.max(-127, Math.min(127, maxRaw));
  }

  /**
   * True symmetric clock advantage over remote peers (GGPO formula: (localAdv - remoteAdv) / 2).
   * Because localAdv = clockDiff + oneWayLatency and remoteAdv = -clockDiff + oneWayLatency,
   * subtracting them cancels network latency completely so high-ping peers NEVER enter slow-motion!
   */
  frameAdvantage() {
    if (!this.remoteSlots.length) return 0;
    const now = Date.now();
    let maxTrueAdv = -Infinity;
    for (const s of this.remoteSlots) {
      const p = this.game.players.find(q => q.slot === s);
      if (!p || p.out) continue;
      const lastWall = this.lastRecvWallMs.get(s);
      if (!lastWall || now - lastWall > 1200) continue;
      const sf = this.remoteSenderFrame.get(s);
      if (sf === undefined) continue;
      const myRaw = this.localFrame - sf;
      const prevMy = this.localAdvEma.get(s);
      const mySm = prevMy === undefined ? myRaw : (prevMy * 0.85 + myRaw * 0.15);
      this.localAdvEma.set(s, mySm);

      const peerSm = this.remoteAdvEma.get(s);
      // Before peer's advantage arrives, assume symmetric latency (0 true advantage) instead of slowing down
      if (peerSm === undefined) continue;
      const trueAdv = (mySm - peerSm) * 0.5;
      if (trueAdv > maxTrueAdv) maxTrueAdv = trueAdv;
    }
    return maxTrueAdv === -Infinity ? 0 : maxTrueAdv;
  }

  /**
   * Guard against overflowing MAX_ROLLBACK on short jitter bursts without EVER deadlocking:
   * wait up to 280ms while sending heartbeats; if a peer is silent/backgrounded past that,
   * fast-fill missing frames up to window edge so gameplay never freezes.
   */
  shouldStall() {
    if (!this.remoteSlots.length) { this._stallStartMs = 0; return false; }
    const now = Date.now();
    const stalledSlots = [];
    for (const s of this.remoteSlots) {
      const p = this.game.players.find(q => q.slot === s);
      if (!p || p.out) continue;
      if ((this.latestRecvFrame.get(s) ?? -1) < 0) continue;
      const cf = this.contigFrame.get(s) ?? -1;
      if (this.localFrame - (cf + 1) >= MAX_ROLLBACK - 2) {
        const lastWall = this.lastRecvWallMs.get(s) || now;
        if (now - lastWall > 900) {
          this._fillSlotGapToWindow(s);
          continue;
        }
        stalledSlots.push(s);
      }
    }
    if (!stalledSlots.length) {
      this._stallStartMs = 0;
      return false;
    }
    if (!this._stallStartMs) this._stallStartMs = now;
    if (now - this._stallStartMs < 280) return true;

    // Stall grace exceeded (e.g., backgrounded tab or long drop burst): unblock cleanly
    for (const s of stalledSlots) this._fillSlotGapToWindow(s);
    this._advanceConfirmed();
    this._stallStartMs = 0;
    return false;
  }

  _fillSlotGapToWindow(slot) {
    const cmap = this.confirmed.get(slot);
    if (!cmap) return;
    const targetContig = Math.max(-1, this.localFrame - (MAX_ROLLBACK - 6));
    let cf = Math.max(this.contigFrame.get(slot) ?? -1, this.confirmedFrame - 1);
    while (cf < targetContig) {
      cf++;
      if (!cmap.has(cf)) cmap.set(cf, this.predictPack(slot, cf));
    }
    while (cmap.has(cf + 1)) cf++;
    this.contigFrame.set(slot, cf);
  }

  _maybeSendHeartbeat() {
    if (this.spectator || this.localFrame <= 0) return;
    const now = Date.now();
    if (now - this._lastHeartbeatMs < 35) return;
    this._lastHeartbeatMs = now;
    this._sendInputBatch(this.localFrame - 1 + this.inputDelay, true);
  }

  _sendInputBatch(headFrame, forceReliable = false) {
    if (this.spectator || headFrame < 0) return;
    let minAck = Infinity;
    for (const s of this.remoteSlots) {
      const a = this.peerReportedAck.get(s);
      if (typeof a === 'number') minAck = Math.min(minAck, a);
    }
    const baseStart = Math.max(0, headFrame - REDUNDANCY + 1);
    const ackStart = minAck < Infinity ? Math.max(0, minAck + 1) : baseStart;
    // Cap batch to 28 frames (~467 ms history, 73 bytes total) — ALWAYS stays on fast unreliable UDP channel
    // unless forceReliable is explicitly requested during a stall heartbeat!
    const start = Math.max(0, headFrame - 27, Math.min(baseStart, ackStart));
    const packs = [];
    for (let k = start; k <= headFrame; k++) {
      packs.push(this.localHistory.get(k) ?? EMPTY_PACK);
    }
    const minContig = this._minRemoteContig();
    const localAdv = this._rawLocalAdvantage();
    this.sendPacket(
      encodeInputPacket(this.localSlot, this.matchSeq, start, minContig, this.localFrame - 1, packs, localAdv),
      forceReliable
    );
  }

  /** Predict a pack for slot at frame f from the latest confirmed input < f. */
  predictPack(slot, f) {
    const map = this.confirmed.get(slot);
    if (!map) return EMPTY_PACK;
    for (let k = f - 1; k >= Math.max(0, this.confirmedFrame - 1); k--) {
      if (map.has(k)) return holdFromConfirmed(map.get(k));
    }
    const lastContig = this.contigFrame.get(slot) ?? -1;
    if (lastContig >= 0 && map.has(lastContig)) return holdFromConfirmed(map.get(lastContig));
    return EMPTY_PACK;
  }

  /** Run exactly one fixed tick at localFrame with configured inputDelay and broadcast redundant batch. */
  stepFrame(localInp) {
    const f = this.localFrame;
    const reuse = this._statePool.length ? this._statePool.pop() : null;
    this.stateRing.set(f, this.game.saveState(reuse));

    if (!this.spectator) {
      const targetFrame = f + this.inputDelay;
      const localPack = packInput(localInp);
      this.confirmed.get(this.localSlot)?.set(targetFrame, localPack);
      this.localHistory.set(targetFrame, localPack);
      if (this.localHistory.size > 72) {
        const dropBefore = targetFrame - 64;
        for (const k of this.localHistory.keys()) if (k < dropBefore) this.localHistory.delete(k);
      }
      this.contigFrame.set(this.localSlot, targetFrame);
      this.latestRecvFrame.set(this.localSlot, targetFrame);
    }

    this._applyInputsAndStep(f, true);
    if (f > 0 && f % 60 === 0) this.localChecksums.set(f, this.game.stateChecksum());
    this.localFrame = f + 1;

    this._advanceConfirmed();
    if (!this.spectator) {
      this._lastHeartbeatMs = Date.now();
      this._sendInputBatch(f + this.inputDelay, false);
    }
    return f;
  }

  _minRemoteContig() {
    if (!this.remoteSlots.length) return this.localFrame - 1;
    let m = Infinity;
    for (const s of this.remoteSlots) m = Math.min(m, this.contigFrame.get(s) ?? -1);
    return m === Infinity ? -1 : m;
  }

  _applyInputsAndStep(f, emitAllNew) {
    for (const p of this.game.players) {
      if (p.bot) continue; // Bots compute their own deterministic input inside game.update(STEP)
      const cmap = this.confirmed.get(p.slot);
      let pack;
      if (cmap && cmap.has(f)) pack = cmap.get(f);
      else pack = this.predictPack(p.slot, f);
      this.usedInputs.get(p.slot)?.set(f, pack);
      p.input = unpackInput(pack);
    }
    this.game.update(STEP);
    const raw = this.game.drainEvents();
    if (raw.length) {
      const fresh = [];
      for (const e of raw) {
        const key = eventKey(f, e);
        if (!this._fxSeen.has(key)) {
          this._fxSeen.set(key, f);
          fresh.push(e);
        }
      }
      if (fresh.length && emitAllNew) this.onEvents(fresh);
      return fresh;
    }
    return [];
  }

  /** Handle an incoming binary packet (or base64 string fallback). */
  onRemotePacket(raw, expectedSlot = null) {
    const bytes = typeof raw === 'string' ? b64ToBytes(raw) : raw;
    const pkt = decodePacket(bytes);
    if (!pkt || pkt.matchSeq !== this.matchSeq) return;
    const slot = (expectedSlot !== null && expectedSlot !== undefined) ? expectedSlot : pkt.slot;
    if (slot === this.localSlot || !this.confirmed.has(slot)) return;

    if (pkt.type === PKT_CHECKSUM) {
      let bySlot = this.remoteChecksums.get(pkt.frame);
      if (!bySlot) { bySlot = new Map(); this.remoteChecksums.set(pkt.frame, bySlot); }
      bySlot.set(slot, pkt.checksum);
      this._checkChecksumMatch(pkt.frame);
      return;
    }

    if (pkt.type !== PKT_INPUT) return;
    this.lastRecvWallMs.set(slot, Date.now());
    if (pkt.peerAck >= 0 && pkt.peerAck > (this.peerReportedAck.get(slot) ?? -1)) {
      this.peerReportedAck.set(slot, pkt.peerAck);
    }
    if (pkt.senderFrame > (this.remoteSenderFrame.get(slot) ?? -1)) {
      this.remoteSenderFrame.set(slot, pkt.senderFrame);
    }
    if (typeof pkt.localAdv === 'number') {
      const prev = this.remoteAdvEma.get(slot);
      this.remoteAdvEma.set(slot, prev === undefined ? pkt.localAdv : (prev * 0.8 + pkt.localAdv * 0.2));
    }
    if (pkt.senderFrame - this.localFrame > MAX_ROLLBACK) {
      const now = Date.now();
      if (now - this._syncRequestedAtMs > 500) {
        this._syncRequestedAtMs = now;
        this.onNeedSync?.({ slot, frame: pkt.senderFrame, localFrame: this.localFrame });
      }
      return;
    }

    const cmap = this.confirmed.get(slot);
    const umap = this.usedInputs.get(slot);
    let earliestMispredict = Infinity;

    for (let i = 0; i < pkt.packs.length; i++) {
      const f = pkt.startFrame + i;
      const pack = pkt.packs[i];
      if (f > (this.latestRecvFrame.get(slot) ?? -1)) this.latestRecvFrame.set(slot, f);
      if (f < this.confirmedFrame || f > this.localFrame + MAX_ROLLBACK * 2) continue;
      if (!cmap.has(f)) {
        cmap.set(f, pack);
        if (f < this.localFrame) {
          const used = umap?.get(f);
          if (used !== pack) earliestMispredict = Math.min(earliestMispredict, f);
        }
      }
    }

    // Advance highest contiguous confirmed frame for this remote slot
    let cf = Math.max(this.contigFrame.get(slot) ?? -1, this.confirmedFrame - 1);
    while (cmap.has(cf + 1)) cf++;
    this.contigFrame.set(slot, cf);

    if (earliestMispredict < this.localFrame) {
      if (!this.stateRing.has(earliestMispredict)) {
        const now = Date.now();
        if (now - this._syncRequestedAtMs > 500) {
          this._syncRequestedAtMs = now;
          this.onNeedSync?.({ slot, frame: earliestMispredict, localFrame: this.localFrame });
        }
        return;
      }
      this._rollbackFrom(earliestMispredict);
    }

    this._advanceConfirmed();
  }

  _rollbackFrom(earliest) {
    const depth = this.localFrame - earliest;
    this.rollbacks++;
    if (depth > this.maxRollbackDepth) this.maxRollbackDepth = depth;

    const snap = this.stateRing.get(earliest);
    this.game.loadState(snap);
    const discovered = [];
    for (let f = earliest; f < this.localFrame; f++) {
      if (f > earliest) {
        const existing = this.stateRing.get(f) || (this._statePool.length ? this._statePool.pop() : null);
        this.stateRing.set(f, this.game.saveState(existing));
      }
      const fresh = this._applyInputsAndStep(f, false);
      if (f > 0 && f % 60 === 0) this.localChecksums.set(f, this.game.stateChecksum());
      if (fresh.length) discovered.push(...fresh);
    }
    if (discovered.length) this.onEvents(discovered);
  }

  _advanceConfirmed() {
    let minC = this.localFrame - 1;
    for (const s of this.slots) minC = Math.min(minC, this.contigFrame.get(s) ?? -1);
    const newConf = Math.max(0, minC + 1);
    if (newConf <= this.confirmedFrame) return;
    this.confirmedFrame = newConf;

    if (!this.spectator) {
      while (this._nextCsSendFrame < newConf) {
        const cf = this._nextCsSendFrame;
        this._nextCsSendFrame += 60;
        const cs = this.localChecksums.get(cf);
        if (cs !== undefined) {
          this._checkChecksumMatch(cf);
          this.sendPacket(encodeChecksumPacket(this.localSlot, this.matchSeq, cf, cs), true);
        }
      }
    }

    // Recycle pruned stateRing snapshots into _statePool to avoid 60 Hz TypedArray GC churn
    for (const [k, snap] of this.stateRing) {
      if (k < newConf) {
        this.stateRing.delete(k);
        if (this._statePool.length < MAX_ROLLBACK + 6) this._statePool.push(snap);
      }
    }
    for (const map of this.usedInputs.values()) for (const k of map.keys()) if (k < newConf) map.delete(k);
    for (const map of this.confirmed.values()) for (const k of map.keys()) if (k < newConf) map.delete(k);
    for (const [key, f] of this._fxSeen) if (f < newConf) this._fxSeen.delete(key);
    for (const f of this.localChecksums.keys()) if (f < newConf - 120) this.localChecksums.delete(f);
    for (const f of this.remoteChecksums.keys()) if (f < newConf - 120) this.remoteChecksums.delete(f);
  }

  _checkChecksumMatch(frame) {
    if (frame >= this.confirmedFrame) return;
    const local = this.localChecksums.get(frame);
    const remotes = this.remoteChecksums.get(frame);
    if (local === undefined || !remotes) return;
    for (const [slot, remote] of remotes) {
      if (remote !== local) {
        this.desyncs++;
        this.onDesync?.({ frame, slot, local, remote });
      }
    }
  }

  /** Align Host confirmed window for a peer that just received rbSync so Host never waits on pre-sync frames. */
  markPeerSynced(slot) {
    const cmap = this.confirmed.get(slot);
    if (!cmap || slot === this.localSlot) return;
    let cf = Math.max(this.contigFrame.get(slot) ?? -1, this.confirmedFrame - 1);
    while (cf < this.localFrame - 1) {
      cf++;
      if (!cmap.has(cf)) cmap.set(cf, EMPTY_PACK);
    }
    this.contigFrame.set(slot, cf);
    this.latestRecvFrame.set(slot, cf);
    this.peerReportedAck.set(slot, cf);
    this.lastRecvWallMs.set(slot, Date.now());
    this._advanceConfirmed();
  }

  /** Export a full state snapshot at localFrame for late join / tab-sleep catchup / spectators. */
  exportSync() {
    return {
      frame: this.localFrame,
      confirmedFrame: this.confirmedFrame,
      state: this.game.exportState(),
    };
  }

  /** Snap local simulation directly to a Host rbSync snapshot cleanly. */
  applySync(sync) {
    if (!sync || typeof sync.frame !== 'number' || !sync.state) return;
    this.game.importState(sync.state);
    for (const snap of this.stateRing.values()) {
      if (this._statePool.length < MAX_ROLLBACK + 6) this._statePool.push(snap);
    }
    this.stateRing.clear();
    this.localHistory.clear();
    this._fxSeen.clear();
    this.remoteAdvEma.clear();
    this.localAdvEma.clear();
    const now = Date.now();
    for (const map of this.confirmed.values()) map.clear();
    for (const map of this.usedInputs.values()) map.clear();
    for (const s of this.slots) {
      this.contigFrame.set(s, sync.frame - 1);
      this.latestRecvFrame.set(s, sync.frame - 1);
      this.peerReportedAck.set(s, sync.frame - 1);
      this.remoteSenderFrame.set(s, sync.frame);
      this.lastRecvWallMs.set(s, now);
    }
    // Re-seed local inputDelay window after sync so local inputs stay aligned
    if (!this.spectator && this.inputDelay > 0 && this.confirmed.has(this.localSlot)) {
      const lmap = this.confirmed.get(this.localSlot);
      for (let d = 0; d < this.inputDelay; d++) {
        lmap.set(sync.frame + d, EMPTY_PACK);
        this.localHistory.set(sync.frame + d, EMPTY_PACK);
      }
      this.contigFrame.set(this.localSlot, sync.frame + this.inputDelay - 1);
      this.latestRecvFrame.set(this.localSlot, sync.frame + this.inputDelay - 1);
    }
    this.localFrame = sync.frame;
    this.confirmedFrame = sync.frame;
    this.acc = 0;
    this._stallStartMs = 0;
    this.waitingForGo = false;
    this._nextCsSendFrame = Math.ceil((sync.frame + 1) / 60) * 60;
  }
}
