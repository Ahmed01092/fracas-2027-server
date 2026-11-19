// Browser & Desktop WebSocket client for Fracas 2027 online multiplayer.
import { resolveWsUrl } from '../config.js';

export class NetClient {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.serverUrl = '';
    this.clientId = null;
    this.token = null;
    this.lanUrls = [];
    this.iceServers = [];
    this.roomCode = null;
    this.slot = 0;
    this.spectator = false;
    this.isHost = false;
    this.rtt = null;
    this._pingTimer = null;
    this._lastSent = null;
    this._lastSentAt = 0;
    this._seq = 0;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.clientId;
  }

  connect(serverUrl = '') {
    const url = resolveWsUrl(serverUrl);
    if (this.connected && this.serverUrl === url) return Promise.resolve(this);
    this.disconnect();
    this.serverUrl = url;

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        reject(new Error('Could not connect to multiplayer server. Check the server address.'));
        return;
      }
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.disconnect();
          reject(new Error('Connection timed out. Verify the server is online and reachable.'));
        }
      }, 7000);

      ws.addEventListener('message', ev => {
        if (ev.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(ev.data);
          if (u8.byteLength >= 5 && u8[0] === 0x50) {
            this.handlers.onPeerBinary?.(u8.subarray(2), u8[1]);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'hello') {
          this.clientId = msg.clientId;
          this.token = msg.token;
          this.lanUrls = msg.lanUrls || [];
          this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
          this._startPing();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(this);
          }
          return;
        }
        this._handleMessage(msg);
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Could not connect to multiplayer server. Start the game with node server.mjs / Play Fracas 2027.bat.'));
        }
      });

      ws.addEventListener('close', () => {
        this._stopPing();
        const wasConnected = !!this.clientId;
        this.ws = null;
        this.clientId = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Disconnected from multiplayer server.'));
          return;
        }
        if (wasConnected) this.handlers.onClose?.();
      });
    });
  }

  disconnect() {
    this._stopPing();
    const ws = this.ws;
    this.ws = null;
    this.clientId = null;
    this.roomCode = null;
    this._lastSent = null;
    if (ws && ws.readyState < WebSocket.CLOSING) {
      try { ws.close(1000, 'Client leave'); } catch {}
    }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  hostRoom(name) { return this.send({ t: 'host', name, rb: true }); }
  joinRoom(code, name, token = null) { return this.send({ t: 'join', code, name, token, rb: true }); }
  sendRtc(to, kind, data) { return this.send({ t: 'rtc', to, kind, data }); }
  sendPeerInput(to, d) { return this.send({ t: 'pin', to, d }); }
  sendPeerInputBinary(targetMask, bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const out = new Uint8Array(2 + bytes.byteLength);
    out[0] = 0x50;
    out[1] = targetMask & 0xff;
    out.set(bytes, 2);
    this.ws.send(out.buffer);
    return true;
  }
  sendRbReady(matchSeq) { return this.send({ t: 'rbReady', matchSeq }); }
  sendRbSyncReq() { return this.send({ t: 'rbSyncReq' }); }
  sendRbSync(to, sync) { return this.send({ t: 'rbSync', to, sync }); }
  sendRbEnd(outcome, players) { return this.send({ t: 'rbEnd', outcome, players }); }
  toggleBot(slot, diff) { return this.send({ t: 'bot', slot, diff }); }
  sendEmote(id) { return this.send({ t: 'emote', id }); }
  leaveRoom() {
    this.roomCode = null;
    this._lastSent = null;
    return this.send({ t: 'leave' });
  }
  switchSlot(slot) { return this.send({ t: 'slot', slot }); }
  setReady(ready) { return this.send({ t: 'ready', ready: !!ready }); }
  setName(name) { return this.send({ t: 'name', name }); }
  setCfg(cfg) { return this.send({ t: 'cfg', ...cfg }); }
  startMatch() { return this.send({ t: 'start' }); }
  setPaused(paused) { return this.send({ t: 'pause', paused: !!paused }); }
  restartRound() { return this.send({ t: 'restart' }); }
  nextRound() { return this.send({ t: 'next' }); }
  sendLifeEx(op, slot) { return this.send({ t: 'lx', op, slot }); }
  backToLobby() { return this.send({ t: 'lobby' }); }

  sendInput(input, explicitSeq = null) {
    const now = performance.now();
    const prev = this._lastSent;
    const secDir = input.secDir ?? -1;
    const changed = !prev || prev.dir !== input.dir || prev.secDir !== secDir ||
      prev.bombHeld !== !!input.bombHeld || prev.powerHeld !== !!input.powerHeld;
    const edge = !!(input.bomb || input.power || input.force);
    const hasPos = typeof input.x === 'number' && typeof input.y === 'number';
    const posChanged = hasPos && (!prev || typeof prev.x !== 'number' ||
      Math.abs(prev.x - input.x) > 1e-4 || Math.abs(prev.y - input.y) > 1e-4);
    const keepaliveMs = (input.dir >= 0 || posChanged) ? 20 : 140;
    if (!changed && !edge && now - this._lastSentAt < keepaliveMs) return explicitSeq ?? this._seq;
    const seq = typeof explicitSeq === 'number' ? explicitSeq : ++this._seq;
    this._seq = seq;
    this._lastSent = {
      dir: input.dir,
      secDir,
      bombHeld: !!input.bombHeld,
      powerHeld: !!input.powerHeld,
      x: hasPos ? input.x : null,
      y: hasPos ? input.y : null,
    };
    this._lastSentAt = now;
    const msg = {
      t: 'in',
      seq,
      dir: input.dir,
      secDir,
      bomb: !!input.bomb,
      power: !!input.power,
      bombHeld: !!input.bombHeld,
      powerHeld: !!input.powerHeld,
    };
    if (hasPos) {
      msg.x = Math.round(input.x * 1000) / 1000;
      msg.y = Math.round(input.y * 1000) / 1000;
      msg.mov = !!input.mov;
      if (typeof input.faceDir === 'number' && input.faceDir >= 0 && input.faceDir <= 3) msg.fdir = input.faceDir;
    }
    this.send(msg);
    return seq;
  }

  _handleMessage(msg) {
    switch (msg.t) {
      case 'pong':
        if (typeof msg.ts === 'number') this.rtt = Math.max(0, Math.round(Date.now() - msg.ts));
        break;
      case 'joined':
        this.roomCode = msg.code;
        this.slot = msg.slot;
        this.spectator = !!msg.spectator;
        this.isHost = !!msg.isHost;
        try {
          if (!this.spectator) {
            sessionStorage.setItem('fracas_rejoin', JSON.stringify({
              code: msg.code, token: this.token, slot: msg.slot,
            }));
          }
        } catch {}
        this.handlers.onJoined?.(msg);
        break;
      case 'room':
        this.roomCode = msg.code;
        this.isHost = msg.hostId === this.clientId;
        {
          const me = msg.players?.find(p => p.id === this.clientId);
          if (me) { this.slot = me.slot; this.spectator = false; }
          else if (msg.spectators?.some(s => s.id === this.clientId)) { this.slot = -1; this.spectator = true; }
        }
        this.handlers.onRoom?.(msg);
        break;
      case 'levelStart':
        this._lastSent = null;
        this._seq = 0;
        this.handlers.onLevelStart?.(msg);
        break;
      case 'snap':
        this.handlers.onSnap?.(msg);
        break;
      case 'rtc':
        this.handlers.onRtc?.(msg);
        break;
      case 'pin':
        this.handlers.onPeerInput?.(msg);
        break;
      case 'rbSyncReq':
        this.handlers.onRbSyncReq?.(msg);
        break;
      case 'rbSync':
        this.handlers.onRbSync?.(msg);
        break;
      case 'rbGo':
        this.handlers.onRbGo?.(msg);
        break;
      case 'emote':
        this.handlers.onEmote?.(msg);
        break;
      case 'err':
        this.handlers.onError?.(msg);
        break;
    }
  }

  _startPing() {
    this._stopPing();
    this.send({ t: 'ping', ts: Date.now() });
    this._pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: Date.now(), rtt: this.rtt });
    }, 1000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}
