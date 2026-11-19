// Authoritative multiplayer room manager and 60 Hz game simulation loop for Node.js.
import { randomBytes } from 'node:crypto';
import { Game, canExchangeLives, exchangeLife, shareLivesWithAll, giveLifeToSlot, takeLifeFromSlot, idx, doorSync, doorStateAt } from '../game/sim.js';
import { W, H, DIRS, TICK, WALKWAY_SPEED } from '../game/constants.js';
import { serializeGame, SNAP_TICKS } from './protocol.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;

function makeCode(existing) {
  for (let tries = 0; tries < 32; tries++) {
    let code = '';
    const b = randomBytes(4);
    for (let i = 0; i < 4; i++) code += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (!existing.has(code)) return code;
  }
  return randomBytes(3).toString('hex').toUpperCase();
}

function cleanName(raw, fallback) {
  const s = String(raw || '').replace(/[\r\n\t<>]/g, '').trim().slice(0, 14);
  return s || fallback;
}

function checkpoint(n) {
  return Math.floor((n - 1) / 5) * 5 + 1;
}

function findClientPath(g, p, x0, y0, x1, y1) {
  const maxSteps = Math.abs(x1 - x0) + Math.abs(y1 - y0);
  if (maxSteps === 0) return [[x0, y0]];
  if (maxSteps > 4) return null;
  const q = [{ x: x0, y: y0, d: 0, prev: null }];
  const seen = new Set([y0 * W + x0]);
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    if (cur.d >= maxSteps) continue;
    for (let dir = 0; dir < 4; dir++) {
      if (!g.canStep(p, cur.x, cur.y, dir)) continue;
      const nx = cur.x + DIRS[dir][0], ny = cur.y + DIRS[dir][1];
      const next = { x: nx, y: ny, d: cur.d + 1, prev: cur };
      if (nx === x1 && ny === y1) {
        const path = [];
        for (let node = next; node; node = node.prev) path.push([node.x, node.y]);
        return path.reverse();
      }
      const k = ny * W + nx;
      if (!seen.has(k)) { seen.add(k); q.push(next); }
    }
  }
  return null;
}

export class RoomManager {
  constructor(levelsData, { lanUrls = [], iceServers = [] } = {}) {
    this.data = levelsData;
    this.lanUrls = lanUrls;
    this.iceServers = iceServers;
    this.rooms = new Map();
    this.clients = new Map(); // clientId -> client meta
    this._nextClientNum = 1;
  }

  attachClient(ws) {
    const id = 'c' + (this._nextClientNum++);
    const token = randomBytes(12).toString('hex');
    const client = { id, token, ws, roomCode: null, pingMs: null, lastEmoteMs: 0 };
    this.clients.set(id, client);

    ws.sendJson({ t: 'hello', clientId: id, token, lanUrls: this.lanUrls, iceServers: this.iceServers });

    ws.on('message', text => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this.handleMessage(client, msg);
    });

    ws.on('binary', buf => {
      this.handleBinary(client, buf);
    });

    ws.on('close', () => {
      this.handleDisconnect(client);
      this.clients.delete(id);
    });

    return client;
  }

  /** Fast zero-JSON binary relay for rollback input/checksum packets: [0x50][targetMask][...payload] */
  handleBinary(client, buf) {
    if (!buf || buf.length < 5 || buf[0] !== 0x50) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.phase !== 'play' || !room.rollback) return;
    const member = room.members.get(client.id);
    if (!member || member.spectator) return;

    const targetMask = buf[1];
    const out = Buffer.allocUnsafe(buf.length);
    out[0] = 0x50;
    out[1] = member.slot & 0xff;
    buf.copy(out, 2, 2);

    for (const t of room.members.values()) {
      if (!t.connected || !t.ws || t.id === client.id) continue;
      if (t.spectator || targetMask === 0xff || (t.slot >= 0 && (targetMask & (1 << t.slot)))) {
        t.ws.sendBinary(out);
      }
    }
  }

  handleMessage(client, msg) {
    switch (msg.t) {
      case 'ping':
        client.ws.sendJson({ t: 'pong', ts: msg.ts });
        if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) {
          client.pingMs = Math.max(0, Math.min(9999, Math.round(msg.rtt)));
          const room = this.rooms.get(client.roomCode);
          const m = room?.members.get(client.id);
          if (m) m.pingMs = client.pingMs;
        }
        return;
      case 'host':
        this.createRoom(client, msg);
        return;
      case 'join':
        this.joinRoom(client, msg);
        return;
      case 'leave':
        this.leaveRoom(client);
        return;
    }

    const room = this.rooms.get(client.roomCode);
    if (!room) return;
    const member = room.members.get(client.id);
    if (!member) return;

    switch (msg.t) {
      case 'pin': {
        if (room.phase !== 'play' || !room.rollback) return;
        const raw = JSON.stringify({ t: 'pin', from: client.id, slot: member.slot, d: msg.d });
        if (Array.isArray(msg.to)) {
          for (const tid of msg.to) {
            const t = room.members.get(tid);
            if (t && t.connected && t.ws && t.id !== client.id) t.ws.send(raw);
          }
        } else {
          for (const t of room.members.values()) {
            if (t.connected && t.ws && t.id !== client.id) t.ws.send(raw);
          }
        }
        return;
      }
      case 'rtc': {
        const target = room.members.get(msg.to);
        if (target && target.connected && target.ws) {
          target.ws.sendJson({ t: 'rtc', from: client.id, slot: member.slot, kind: msg.kind, data: msg.data });
        }
        return;
      }
      case 'rbSyncReq': {
        if (room.phase !== 'play' || !room.rollback) return;
        const host = room.members.get(room.hostId);
        if (host && host.connected && host.ws && host.id !== client.id) {
          host.ws.sendJson({ t: 'rbSyncReq', to: client.id, slot: member.slot });
        }
        return;
      }
      case 'rbSync': {
        if (room.hostId !== client.id || !room.rollback) return;
        const target = room.members.get(msg.to);
        if (target && target.connected && target.ws) {
          target.ws.sendJson({ t: 'rbSync', sync: msg.sync });
        }
        return;
      }
      case 'rbReady': {
        if (room.phase !== 'play' || !room.rollback || room.rbGoSent) return;
        if (typeof msg.matchSeq === 'number' && msg.matchSeq !== room.matchSeq) return;
        room.rbReadySet?.add(client.id);
        this._checkRbGo(room);
        return;
      }
      case 'emote': {
        const now = Date.now();
        if (now - (client.lastEmoteMs || 0) < 450) return;
        client.lastEmoteMs = now;
        const eid = String(msg.id || '').slice(0, 16);
        if (!eid) return;
        this._broadcastJson(room, { t: 'emote', from: client.id, slot: member.slot, name: member.name, id: eid });
        return;
      }
      case 'bot': {
        if (room.phase !== 'lobby' || room.hostId !== client.id) return;
        this._toggleBot(room, msg.slot, msg.diff);
        return;
      }
      case 'rbEnd': {
        if (!room.rollback || room.hostId !== client.id || room.phase !== 'play' || room.endedSent) return;
        const g = room.game;
        if (!g) return;
        if (msg.outcome !== 'won' && msg.outcome !== 'lost' && msg.outcome !== 'roundOver') return;
        room.endedSent = true;
        if (Array.isArray(msg.players)) {
          for (const rp of msg.players) {
            const p = g.players.find(q => q.slot === rp.slot);
            if (!p) continue;
            if (typeof rp.lives === 'number') p.lives = rp.lives;
            if (typeof rp.score === 'number') p.score = rp.score;
            if (typeof rp.kills === 'number') p.kills = rp.kills;
            if (typeof rp.wins === 'number') p.wins = rp.wins;
            if (typeof rp.selfKills === 'number') p.selfKills = rp.selfKills;
            if (typeof rp.spellsCast === 'number') p.spellsCast = rp.spellsCast;
            if (typeof rp.rocksBroken === 'number') p.rocksBroken = rp.rocksBroken;
            if (typeof rp.out === 'boolean') p.out = rp.out;
            p.alive = !p.out;
          }
        }
        this._completeOutcome(room, msg.outcome);
        return;
      }
      case 'in':
        if (room.phase !== 'play') return;
        this._applyInput(room, member.slot, msg);
        break;
      case 'slot':
        if (room.phase !== 'lobby') return;
        this._switchSlot(room, member, msg.slot);
        break;
      case 'ready':
        if (room.phase !== 'lobby') return;
        member.ready = !!msg.ready;
        this.broadcastRoom(room);
        break;
      case 'name':
        member.name = cleanName(msg.name, `Wizard ${member.slot + 1}`);
        this.broadcastRoom(room);
        break;
      case 'cfg':
        if (room.phase !== 'lobby' || room.hostId !== client.id) return;
        this._updateCfg(room, msg);
        break;
      case 'start':
        if (room.phase !== 'lobby' || room.hostId !== client.id) return;
        this.startMatch(room, client);
        break;
      case 'pause':
        if (room.hostId !== client.id) return;
        if (room.phase === 'play' && msg.paused) {
          room.phase = 'paused';
          this.broadcastRoom(room);
        } else if (room.phase === 'paused' && !msg.paused) {
          room.phase = 'play';
          room.acc = 0;
          room.lastStepMs = Date.now();
          this.broadcastRoom(room);
        }
        break;
      case 'restart':
        if (room.hostId !== client.id) return;
        if (room.phase === 'paused' || room.phase === 'play') {
          if (room.run.mode === 'battle') {
            room.run.round = Math.max(0, room.run.round - 1);
            this._nextBattleRound(room);
          } else {
            this._loadStoryLevel(room);
          }
        }
        break;
      case 'next':
        if (room.hostId !== client.id) return;
        this._advanceAfterRound(room);
        break;
      case 'lx': {
        if (room.phase !== 'lifeExchange') return;
        const donorLives = room.game?.players?.find(p => p.slot === member.slot)?.lives ?? 0;
        if (room.hostId !== client.id && member.slot !== room.lx?.leftSlot && donorLives <= 1) return;
        this._handleLifeExchange(room, msg);
        break;
      }
      case 'lobby':
        if (room.hostId !== client.id) return;
        this._returnToLobby(room);
        break;
    }
  }

  createRoom(client, msg) {
    this.leaveRoom(client);
    const code = makeCode(this.rooms);
    const name = cleanName(msg.name, 'Wizard 1');
    const room = {
      code,
      hostId: client.id,
      phase: 'lobby',
      cfg: {
        mode: 'normal', level: 1, arena: 0, wins: 3, random: false, rude: false, psycho: false,
        delayMode: 'auto',
        bots: {},
        mutators: { friendlyFire: true, fuseScale: 1, speedScale: 1, startMax: false, suddenDeath: 'normal' },
      },
      members: new Map(),
      rejoinTokens: new Map(), // token -> { slot, name }
      run: null,
      game: null,
      inputs: {},
      pendingEvents: [],
      snapCache: null,
      tickCount: 0,
      acc: 0,
      lastStepMs: Date.now(),
      lx: null,
      emptySince: null,
      rbReadySet: null,
      rbGoSent: true,
      rbGoTimer: null,
    };
    room.members.set(client.id, {
      id: client.id, token: client.token, name, slot: 0, ready: true, spectator: false,
      ws: client.ws, connected: true, pingMs: client.pingMs, rb: !!msg.rb,
    });
    this.rooms.set(code, room);
    client.roomCode = code;
    this._ensureTimer();
    client.ws.sendJson({ t: 'joined', code, slot: 0, isHost: true, clientId: client.id });
    this.broadcastRoom(room);
  }

  joinRoom(client, msg) {
    const code = String(msg.code || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      client.ws.sendJson({ t: 'err', code: 'NOT_FOUND', message: `Room "${code}" not found` });
      return;
    }

    // Allow reconnect with prior session token if player dropped mid-match
    const saved = msg.token && room.rejoinTokens.get(msg.token);
    if (saved) {
      this.leaveRoom(client);
      const existing = [...room.members.values()].find(m => m.slot === saved.slot);
      if (existing && existing.connected) {
        client.ws.sendJson({ t: 'err', code: 'IN_USE', message: 'That wizard slot is already active' });
        return;
      }
      if (existing) room.members.delete(existing.id);
      room.rejoinTokens.delete(msg.token);
      room.members.set(client.id, {
        id: client.id, token: client.token, name: cleanName(msg.name, saved.name),
        slot: saved.slot, ready: true, ws: client.ws, connected: true, pingMs: client.pingMs, rb: !!msg.rb,
      });
      if (!room.members.has(room.hostId)) room.hostId = client.id;
      client.roomCode = code;
      room.emptySince = null;
      client.ws.sendJson({
        t: 'joined', code, slot: saved.slot, isHost: room.hostId === client.id, clientId: client.id,
      });
      if (room.game && room.phase !== 'lobby') {
        this._sendLevelStart(room, client.ws);
        if (room.rollback) {
          const host = room.members.get(room.hostId);
          if (host && host.connected && host.ws && host.id !== client.id) {
            host.ws.sendJson({ t: 'rbSyncReq', to: client.id, slot: saved.slot });
          }
        } else {
          const { snap } = serializeGame(room.game, [], { full: true });
          client.ws.sendJson(snap);
        }
      }
      this.broadcastRoom(room);
      return;
    }

    if (room.phase !== 'lobby') {
      const specs = [...room.members.values()].filter(m => m.spectator && m.connected).length;
      if (specs >= 4) {
        client.ws.sendJson({ t: 'err', code: 'FULL', message: 'Match in progress and spectator slots are full' });
        return;
      }
      this.leaveRoom(client);
      const name = cleanName(msg.name, `Spectator ${specs + 1}`);
      room.members.set(client.id, {
        id: client.id, token: client.token, name, slot: -1, ready: true, spectator: true,
        ws: client.ws, connected: true, pingMs: client.pingMs, rb: !!msg.rb,
      });
      client.roomCode = code;
      room.emptySince = null;
      client.ws.sendJson({ t: 'joined', code, slot: -1, spectator: true, isHost: false, clientId: client.id });
      if (room.game) {
        this._sendLevelStart(room, client.ws, true);
        if (room.rollback) {
          const host = room.members.get(room.hostId);
          if (host && host.connected && host.ws && host.id !== client.id) {
            host.ws.sendJson({ t: 'rbSyncReq', to: client.id, slot: -1, spectator: true });
          }
        } else {
          const { snap } = serializeGame(room.game, [], { full: true });
          client.ws.sendJson(snap);
        }
      }
      this.broadcastRoom(room, { note: `${name} joined as spectator` });
      return;
    }
    const usedSlots = new Set([...room.members.values()].filter(m => !m.spectator && m.slot >= 0).map(m => m.slot));
    let freeSlot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (!usedSlots.has(s)) { freeSlot = s; break; }
    }
    if (freeSlot < 0) {
      client.ws.sendJson({ t: 'err', code: 'FULL', message: 'Room is full (4 players max)' });
      return;
    }
    if (room.cfg.bots?.[freeSlot]) delete room.cfg.bots[freeSlot];

    this.leaveRoom(client);
    const name = cleanName(msg.name, `Wizard ${freeSlot + 1}`);
    room.members.set(client.id, {
      id: client.id, token: client.token, name, slot: freeSlot, ready: false, spectator: false,
      ws: client.ws, connected: true, pingMs: client.pingMs, rb: !!msg.rb,
    });
    client.roomCode = code;
    room.emptySince = null;
    client.ws.sendJson({ t: 'joined', code, slot: freeSlot, spectator: false, isHost: false, clientId: client.id });
    this.broadcastRoom(room);
  }

  leaveRoom(client) {
    const code = client.roomCode;
    if (!code) return;
    client.roomCode = null;
    const room = this.rooms.get(code);
    if (!room) return;
    const m = room.members.get(client.id);
    if (m) {
      room.members.delete(client.id);
      if (room.inputs[m.slot]) {
        room.inputs[m.slot] = { dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false, seq: 0, x: null, y: null, mov: false, hasPos: false };
      }
    }
    if (room.members.size === 0) {
      if (room.rbGoTimer) { clearTimeout(room.rbGoTimer); room.rbGoTimer = null; }
      this.rooms.delete(code);
      return;
    }
    if (room.hostId === client.id) {
      const next = [...room.members.values()].find(x => x.connected && !x.spectator)
        || [...room.members.values()].find(x => x.connected)
        || [...room.members.values()][0];
      if (next) {
        room.hostId = next.id;
        if (room.phase === 'lobby') next.ready = true;
      }
    }
    this._checkRbGo(room);
    this.broadcastRoom(room);
  }

  handleDisconnect(client) {
    const code = client.roomCode;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) { client.roomCode = null; return; }
    if (room.phase === 'lobby') {
      this.leaveRoom(client);
      return;
    }
    const m = room.members.get(client.id);
    if (m) {
      m.connected = false;
      m.ws = null;
      room.rejoinTokens.set(m.token, { slot: m.slot, name: m.name });
      if (room.inputs[m.slot]) {
        room.inputs[m.slot] = { dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false, seq: 0, x: null, y: null, mov: false, hasPos: false };
      }
    }
    client.roomCode = null;
    const anyConnected = [...room.members.values()].some(x => x.connected);
    if (!anyConnected) {
      room.emptySince = Date.now();
      return;
    }
    if (room.hostId === client.id) {
      const next = [...room.members.values()].find(x => x.connected && !x.spectator)
        || [...room.members.values()].find(x => x.connected);
      if (next) room.hostId = next.id;
    }
    this._checkRbGo(room);
    this.broadcastRoom(room);
  }

  _switchSlot(room, member, wanted) {
    if (member.spectator) return;
    const slot = Number(wanted);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
    if ([...room.members.values()].some(m => !m.spectator && m.slot === slot)) return;
    if (room.cfg.bots?.[slot]) delete room.cfg.bots[slot];
    member.slot = slot;
    this.broadcastRoom(room);
  }

  _toggleBot(room, wantedSlot, explicitDiff) {
    const slot = Number(wantedSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
    if ([...room.members.values()].some(m => !m.spectator && m.slot === slot)) return;
    room.cfg.bots = room.cfg.bots || {};
    const valid = ['easy', 'normal', 'master'];
    if (explicitDiff === null || explicitDiff === 'off') {
      delete room.cfg.bots[slot];
    } else if (valid.includes(explicitDiff)) {
      room.cfg.bots[slot] = explicitDiff;
    } else {
      const cur = room.cfg.bots[slot];
      const next = !cur ? 'normal' : cur === 'normal' ? 'master' : cur === 'master' ? 'easy' : null;
      if (next) room.cfg.bots[slot] = next;
      else delete room.cfg.bots[slot];
    }
    this.broadcastRoom(room);
  }

  _updateCfg(room, msg) {
    const c = room.cfg;
    if (msg.mode === 'normal' || msg.mode === 'battle') c.mode = msg.mode;
    if (msg.level != null) {
      const lv = Math.max(1, Math.min(this.data.normal.length, Math.floor(Number(msg.level) || 1)));
      c.level = lv;
    }
    if (msg.arena != null) {
      const ar = Math.max(0, Math.min(this.data.battle.length - 1, Math.floor(Number(msg.arena) || 0)));
      c.arena = ar;
    }
    if (msg.wins != null) {
      c.wins = Math.max(1, Math.min(9, Math.floor(Number(msg.wins) || 3)));
    }
    if (typeof msg.random === 'boolean') c.random = msg.random;
    if (msg.delayMode === 'auto' || (Number.isInteger(msg.delayMode) && msg.delayMode >= 0 && msg.delayMode <= 3)) {
      c.delayMode = msg.delayMode;
    }
    if (msg.mutators && typeof msg.mutators === 'object') {
      c.mutators = c.mutators || { friendlyFire: true, fuseScale: 1, speedScale: 1, startMax: false, suddenDeath: 'normal' };
      if (typeof msg.mutators.friendlyFire === 'boolean') c.mutators.friendlyFire = msg.mutators.friendlyFire;
      if (typeof msg.mutators.startMax === 'boolean') c.mutators.startMax = msg.mutators.startMax;
      if ([1, 0.65, 0.45].includes(Number(msg.mutators.fuseScale))) c.mutators.fuseScale = Number(msg.mutators.fuseScale);
      if ([1, 1.25, 1.5].includes(Number(msg.mutators.speedScale))) c.mutators.speedScale = Number(msg.mutators.speedScale);
      if (msg.mutators.suddenDeath === 'normal' || msg.mutators.suddenDeath === 'fast') c.mutators.suddenDeath = msg.mutators.suddenDeath;
    }
    if (typeof msg.password === 'string') {
      const w = msg.password.trim().toUpperCase();
      if (w === 'RUDE') { c.rude = !c.rude; this.broadcastRoom(room, { note: `Rude mode ${c.rude ? 'on' : 'off'}` }); return; }
      if (w === 'PSYCHO') { c.psycho = !c.psycho; this.broadcastRoom(room, { note: `Psycho mode ${c.psycho ? 'on' : 'off'}` }); return; }
      const lv = this.data.passwords?.[w];
      if (lv) { c.mode = 'normal'; c.level = lv; this.broadcastRoom(room, { note: `Password accepted: Level ${lv}` }); return; }
      this.broadcastRoom(room, { note: 'Wrong password', noteErr: true });
      return;
    }
    this.broadcastRoom(room);
  }

  startMatch(room, requester) {
    const members = [...room.members.values()].filter(m => m.connected && !m.spectator).sort((a, b) => a.slot - b.slot);
    const humanSlotSet = new Set(members.map(m => m.slot));
    const bots = {};
    for (const [k, diff] of Object.entries(room.cfg.bots || {})) {
      const s = Number(k);
      if (Number.isInteger(s) && s >= 0 && s < MAX_PLAYERS && !humanSlotSet.has(s) && diff) bots[s] = diff;
    }
    const slots = [...new Set([...members.map(m => m.slot), ...Object.keys(bots).map(Number)])].sort((a, b) => a - b);
    const need = room.cfg.mode === 'battle' ? 2 : 1;
    if (slots.length < need) {
      requester.ws.sendJson({
        t: 'err', code: 'NEED_PLAYERS',
        message: room.cfg.mode === 'battle' ? 'Battle requires at least 2 wizards (add a friend or AI bot)' : 'Need at least 1 player',
      });
      return;
    }
    room.rollback = members.length > 0 && members.every(m => m.rb);
    room.rejoinTokens.clear();
    if (room.cfg.mode === 'battle') {
      room.run = { mode: 'battle', slots, bots, carry: {}, round: 0 };
      this._nextBattleRound(room);
    } else {
      room.run = { mode: 'normal', level: room.cfg.level, slots, bots, carry: {}, _exchangedDone: false };
      this._loadStoryLevel(room);
    }
  }

  _loadStoryLevel(room) {
    const r = room.run;
    const lv = this.data.normal[r.level - 1];
    if (!lv) { this._returnToLobby(room); return; }
    r._exchangedDone = false;
    const seed = Math.floor(Math.random() * 0x100000000);
    r.seed = seed;
    room.game = new Game(lv, {
      mode: 'normal',
      players: r.slots,
      bots: r.bots || {},
      mutators: room.cfg.mutators,
      carry: r.carry,
      cheats: { rude: room.cfg.rude, psycho: room.cfg.psycho },
      seed,
    });
    this._beginPlay(room);
  }

  _nextBattleRound(room) {
    const r = room.run, c = room.cfg;
    r.round++;
    const arenaIdx = c.random ? Math.floor(Math.random() * this.data.battle.length) : c.arena;
    const lv = this.data.battle[arenaIdx] || this.data.battle[0];
    r.arenaIdx = arenaIdx;
    const seed = Math.floor(Math.random() * 0x100000000);
    r.seed = seed;
    room.game = new Game(lv, {
      mode: 'battle',
      players: r.slots,
      bots: r.bots || {},
      mutators: room.cfg.mutators,
      carry: r.carry,
      cheats: { rude: room.cfg.rude, psycho: room.cfg.psycho },
      seed,
    });
    this._beginPlay(room);
  }

  _checkRbGo(room) {
    if (!room || !room.rollback || room.rbGoSent || room.phase !== 'play') return;
    const active = [...room.members.values()].filter(m => m.connected && !m.spectator);
    if (!active.length || active.every(m => room.rbReadySet?.has(m.id))) {
      room.rbGoSent = true;
      if (room.rbGoTimer) { clearTimeout(room.rbGoTimer); room.rbGoTimer = null; }
      this._broadcastJson(room, { t: 'rbGo', matchSeq: room.matchSeq || 0 });
    }
  }

  _beginPlay(room) {
    room.phase = 'play';
    room.endedSent = false;
    room.matchSeq = ((room.matchSeq || 0) + 1) & 0xff;
    room.lx = null;
    if (room.rbGoTimer) { clearTimeout(room.rbGoTimer); room.rbGoTimer = null; }
    const activeHumans = [...room.members.values()].filter(m => m.connected && !m.spectator);
    const useBarrier = !!room.rollback && activeHumans.length > 1;
    room.rbReadySet = new Set();
    room.rbGoSent = !useBarrier;

    room.inputs = {};
    for (const s of room.run.slots) {
      room.inputs[s] = {
        dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false,
        seq: 0, x: null, y: null, mov: false, hasPos: false,
      };
    }
    room.pendingEvents = [];
    room.snapCache = null;
    room.tickCount = 0;
    room.acc = 0;
    room.lastStepMs = Date.now();
    for (const m of room.members.values()) {
      if (m.connected && m.ws) this._sendLevelStart(room, m.ws, !!m.spectator, useBarrier);
    }
    if (useBarrier) {
      const seq = room.matchSeq;
      room.rbGoTimer = setTimeout(() => {
        if (room.matchSeq === seq && !room.rbGoSent) {
          room.rbGoSent = true;
          room.rbGoTimer = null;
          this._broadcastJson(room, { t: 'rbGo', matchSeq: seq });
        }
      }, 2500);
      room.rbGoTimer.unref?.();
    }
    if (!room.rollback) {
      const { snap, cache } = serializeGame(room.game, [], { full: true });
      room.snapCache = cache;
      this._broadcastJson(room, snap);
    }
    this.broadcastRoom(room);
  }

  _sendLevelStart(room, ws, spectator = false, waitForGo = false) {
    const r = room.run, g = room.game;
    ws.sendJson({
      t: 'levelStart',
      mode: r.mode,
      level: r.level || 1,
      arenaIdx: r.arenaIdx ?? room.cfg.arena,
      round: r.round || 0,
      winsNeeded: room.cfg.wins,
      slots: r.slots,
      bots: r.bots || {},
      mutators: room.cfg.mutators,
      delayMode: room.cfg.delayMode ?? 'auto',
      carry: r.carry,
      cheats: { rude: room.cfg.rude, psycho: room.cfg.psycho },
      hudLevel: r.mode === 'battle' ? r.round : g.level.id,
      seed: r.seed,
      matchSeq: room.matchSeq || 0,
      rollback: !!room.rollback,
      spectator: !!spectator,
      waitForGo: !spectator && !!waitForGo,
    });
  }

  _returnToLobby(room) {
    if (room.rbGoTimer) { clearTimeout(room.rbGoTimer); room.rbGoTimer = null; }
    room.rbGoSent = true;
    room.phase = 'lobby';
    room.game = null;
    room.run = null;
    room.lx = null;
    room.pendingEvents = [];
    for (const m of [...room.members.values()]) {
      if (!m.connected) room.members.delete(m.id);
      else m.ready = m.id === room.hostId;
    }
    // Promote waiting spectators into open wizard slots automatically!
    const used = new Set([...room.members.values()].filter(m => !m.spectator && m.slot >= 0).map(m => m.slot));
    for (const m of room.members.values()) {
      if (!m.spectator) continue;
      let free = -1;
      for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) { free = s; break; }
      if (free >= 0) {
        m.spectator = false;
        m.slot = free;
        m.ready = m.id === room.hostId;
        used.add(free);
        if (room.cfg.bots?.[free]) delete room.cfg.bots[free];
      }
    }
    room.rejoinTokens.clear();
    this.broadcastRoom(room);
  }

  _applyInput(room, slot, msg) {
    const inp = room.inputs[slot];
    if (!inp) return;
    const d = Number(msg.dir);
    inp.dir = (Number.isInteger(d) && d >= 0 && d <= 3) ? d : -1;
    const sd = Number(msg.secDir);
    inp.secDir = (Number.isInteger(sd) && sd >= 0 && sd <= 3) ? sd : -1;
    inp.bombHeld = !!msg.bombHeld;
    inp.powerHeld = !!msg.powerHeld;
    if (msg.bomb) inp.bomb = true;
    if (msg.power) inp.power = true;
    if (typeof msg.x === 'number' && typeof msg.y === 'number' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      inp.x = msg.x;
      inp.y = msg.y;
      inp.mov = !!msg.mov;
      const fd = Number(msg.fdir);
      inp.fdir = (Number.isInteger(fd) && fd >= 0 && fd <= 3) ? fd : -1;
      inp.hasPos = true;
    }
    if (typeof msg.seq === 'number' && Number.isFinite(msg.seq) && msg.seq > inp.seq) {
      inp.seq = msg.seq;
    }
  }

  _handleLifeExchange(room, msg) {
    const g = room.game, lx = room.lx;
    if (!g || !lx) return;
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

    lx.flashL = 0;
    lx.flashR = 0;
    lx.transfers = lx.transfers || [];
    const pushTransfer = (from, to) => {
      room._lxSeq = (room._lxSeq || 0) + 1;
      lx.transfers.push({ from, to, seq: room._lxSeq });
      if (lx.transfers.length > 16) lx.transfers.shift();
    };

    let sound = null;
    if (msg.op === 'give') {
      const d = leftP(), r = rightP();
      if (exchangeLife(d, r)) { lx.flashR = 0.16; sound = 'pickup'; pushTransfer(d.slot, r.slot); }
    } else if (msg.op === 'take') {
      const d = rightP(), r = leftP();
      if (exchangeLife(d, r)) { lx.flashL = 0.16; sound = 'pickup'; pushTransfer(d.slot, r.slot); }
    } else if (msg.op === 'giveTo') {
      const tr = giveLifeToSlot(g, lx, Number(msg.slot));
      if (tr) { lx.flashR = 0.16; sound = 'pickup'; pushTransfer(tr.from, tr.to); }
    } else if (msg.op === 'takeFrom') {
      const tr = takeLifeFromSlot(g, lx, Number(msg.slot));
      if (tr) { lx.flashL = 0.16; sound = 'pickup'; pushTransfer(tr.from, tr.to); }
    } else if (msg.op === 'shareAll') {
      const list = shareLivesWithAll(g);
      if (list.length) {
        lx.flashR = 0.16; sound = 'pickup';
        for (const tr of list) pushTransfer(tr.from, tr.to);
      }
    } else if (msg.op === 'cycleLeft') {
      cycleSlot('leftSlot', 1); sound = 'ui';
    } else if (msg.op === 'cycleRight') {
      cycleSlot('rightSlot', 1); sound = 'ui';
    } else if (msg.op === 'tab') {
      const slot = Number(msg.slot);
      const p = g.players.find(q => q.slot === slot);
      if (p) {
        if (p.lives > 1 && slot !== lx.rightSlot) { lx.leftSlot = slot; sound = 'ui'; }
        else if (slot !== lx.leftSlot) { lx.rightSlot = slot; sound = 'ui'; }
      }
    } else if (msg.op === 'confirm') {
      for (const p of g.players) p.out = p.lives <= 0;
      this._finishStoryLevel(room);
      return;
    }

    const { snap, cache } = serializeGame(g, [], { full: false, cache: room.snapCache });
    room.snapCache = cache;
    this._broadcastJson(room, snap);
    this.broadcastRoom(room, sound ? { sound } : {});
  }

  _completeOutcome(room, outcome) {
    const g = room.game;
    if (!g) return;
    if (outcome === 'won') {
      if (!room.run._exchangedDone && canExchangeLives(g)) {
        room.run._exchangedDone = true;
        const sorted = [...g.players].sort((a, b) => b.lives - a.lives);
        const fallen = g.players.find(p => p.lives <= 0) || g.players[1];
        const leftSlot = g.players.length === 2 ? g.players[0].slot : sorted[0].slot;
        const rightSlot = g.players.length === 2
          ? g.players[1].slot
          : (fallen.slot !== leftSlot ? fallen.slot : g.players.find(p => p.slot !== leftSlot).slot);
        room.lx = { leftSlot, rightSlot, hover: null, flashL: 0, flashR: 0, transfers: [] };
        room.phase = 'lifeExchange';
        this.broadcastRoom(room);
      } else {
        this._finishStoryLevel(room);
      }
      return;
    }
    if (outcome === 'lost') {
      room.phase = 'gameOver';
      this.broadcastRoom(room);
      return;
    }
    if (outcome === 'roundOver') {
      for (const p of g.players) room.run.carry[p.slot] = { wins: p.wins };
      room.phase = 'roundEnd';
      this.broadcastRoom(room);
    }
  }

  _finishStoryLevel(room) {
    const g = room.game, r = room.run;
    for (const p of g.players) r.carry[p.slot] = p.carry();
    const next = r.level + 1;
    room.lx = null;
    room.phase = next > this.data.normal.length ? 'victory' : 'levelEnd';
    this.broadcastRoom(room);
  }

  _advanceAfterRound(room) {
    const r = room.run, g = room.game;
    if (!r || !g) return;
    if (room.phase === 'levelEnd') {
      r.level++;
      this._loadStoryLevel(room);
    } else if (room.phase === 'gameOver') {
      r.level = checkpoint(r.level);
      r.carry = {};
      this._loadStoryLevel(room);
    } else if (room.phase === 'roundEnd') {
      const champ = g.players.find(p => p.wins >= room.cfg.wins);
      if (champ) {
        r.carry = {};
        r.round = 0;
      }
      this._nextBattleRound(room);
    } else if (room.phase === 'victory') {
      this._returnToLobby(room);
    }
  }

  stepAll(nowMs = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.emptySince && nowMs - room.emptySince > 30000) {
        this.rooms.delete(code);
        continue;
      }
      if (room.phase !== 'play' || !room.game || room.rollback) continue;
      const dt = Math.min(0.05, Math.max(0, (nowMs - room.lastStepMs) / 1000));
      if (room.acc + dt < TICK) continue;
      room.lastStepMs = nowMs;
      this.stepRoom(room, dt);
    }
  }

  stepRoom(room, dt) {
    const g = room.game;
    if (!g || room.phase !== 'play') return;
    room.acc = Math.min(room.acc + dt, TICK * 4);
    let n = 0;
    const prevTick = room.tickCount;
    let urgent = false;
    while (room.acc >= TICK && n++ < 4) {
      for (const p of g.players) {
        const inp = room.inputs[p.slot];
        if (!inp) continue;
        p.input.dir = inp.dir;
        p.input.secDir = inp.secDir ?? -1;
        p.input.bombHeld = inp.bombHeld;
        p.input.powerHeld = inp.powerHeld;
        if (inp.bomb) { p.input.bomb = true; inp.bomb = false; }
        if (inp.power) { p.input.power = true; inp.power = false; }
        p._netAck = inp.seq || 0;
        p._moveBudget = Math.min(3.0, (p._moveBudget ?? 0.8) + TICK * (p.speed + WALKWAY_SPEED + 1.5));
        const clientDriveOk = p.alive && !p.out && !p.tpPhase && p.stun <= 0 && !p.push &&
          g.freeze <= 0 && (g.state === 'play' || g.state === 'clear');
        if (!clientDriveOk) {
          p._usesClientPos = false;
          p._clientStaleTicks = 0;
        }
        if (inp.hasPos) {
          inp.hasPos = false;
          if (clientDriveOk) {
            p._usesClientPos = true;
            p._clientStaleTicks = 0;
            const x = inp.x, y = inp.y;
            const cx = Math.floor(x), cy = Math.floor(y);
            const prevCx = p.cx, prevCy = p.cy;
            const inBounds = x >= 0.5 && x <= W - 0.5 && y >= 0.5 && y <= H - 0.5;
            const dist = Math.hypot(x - p.fx, y - p.fy);
            const cellPath = (inBounds && dist <= Math.max(0.6, p._moveBudget) && !g.solid(cx, cy) && !g.barriers.has(idx(cx, cy)))
              ? findClientPath(g, p, prevCx, prevCy, cx, cy)
              : null;
            if (cellPath) {
              p._moveBudget = Math.max(0, p._moveBudget - dist);
              for (let si = 0; si < cellPath.length - 1; si++) {
                const [ax, ay] = cellPath[si], [bx, by] = cellPath[si + 1];
                const df = g.feat[idx(ax, ay)];
                if (df?.k === 'door') {
                  const ed = bx > ax ? 0 : by > ay ? 1 : bx < ax ? 2 : 3;
                  if ((ed % 2 === 1) === df.ns) g.flipDoor(idx(ax, ay), ed <= 1 ? 4 : 0, true);
                }
              }
              p.fx = x; p.fy = y;
              p.tx = cx; p.ty = cy;
              p.moving = !!inp.mov;
              const applyDir = (inp.fdir >= 0 && inp.fdir <= 3) ? inp.fdir : inp.dir;
              if (applyDir >= 0) { p.dir = applyDir; p.lastDir = applyDir; }
              const curFeat = g.feat[idx(cx, cy)];
              if (curFeat?.k === 'door') {
                curFeat.state = doorStateAt(curFeat, p.fx, p.fy);
                doorSync(curFeat);
              }
              p._clientMoved = true;
            }
          }
        } else if (clientDriveOk && p._usesClientPos) {
          p._clientStaleTicks = (p._clientStaleTicks || 0) + 1;
          if (p._clientStaleTicks <= 15) {
            if (p._clientStaleTicks >= 4) p.moving = false;
            p._clientMoved = true;
          } else {
            p._usesClientPos = false;
          }
        }
      }
      g.update(TICK);
      room.acc -= TICK;
      room.tickCount++;
      const ev = g.drainEvents();
      if (ev.length) {
        room.pendingEvents.push(...ev);
        for (const e of ev) {
          if (e.t === 'bomb' || e.t === 'boom' || e.t === 'rock' || e.t === 'cast' || e.t === 'ignite' ||
              e.t === 'die' || e.t === 'mdie' || e.t === 'pickup' || e.t === 'zap' ||
              e.t === 'portal' || e.t === 'portalEnter') {
            urgent = true;
          }
        }
      }

      if (g.state === 'won' && g.stateTime > 2.2) {
        this._flushSnapshot(room);
        this._completeOutcome(room, 'won');
        return;
      }
      if (g.state === 'lost' && g.stateTime > 2.4) {
        this._flushSnapshot(room);
        this._completeOutcome(room, 'lost');
        return;
      }
      if (g.state === 'roundOver' && g.stateTime > 2.4) {
        this._flushSnapshot(room);
        this._completeOutcome(room, 'roundOver');
        return;
      }
    }

    if (urgent || (room.tickCount !== prevTick && Math.floor(room.tickCount / SNAP_TICKS) !== Math.floor(prevTick / SNAP_TICKS))) {
      this._flushSnapshot(room);
    }
  }

  _flushSnapshot(room) {
    const events = room.pendingEvents.splice(0);
    const { snap, cache } = serializeGame(room.game, events, { cache: room.snapCache });
    room.snapCache = cache;
    const critical = !!(snap.events || snap.terrain || snap.doors || snap.spikes || snap.items || snap.barriers);
    this._broadcastJson(room, snap, critical);
  }

  _broadcastJson(room, obj, critical = true) {
    const raw = JSON.stringify(obj);
    for (const m of room.members.values()) {
      if (!m.connected || !m.ws) continue;
      if (!critical && m.ws.bufferedAmount > 24576) continue;
      m.ws.send(raw);
    }
  }

  roomState(room) {
    const g = room.game, r = room.run;
    const players = [...room.members.values()]
      .filter(m => !m.spectator)
      .sort((a, b) => a.slot - b.slot)
      .map(m => ({
        id: m.id, name: m.name, slot: m.slot, ready: m.ready,
        connected: m.connected, isHost: m.id === room.hostId, pingMs: m.pingMs,
      }));
    const spectators = [...room.members.values()]
      .filter(m => m.spectator && m.connected)
      .map(m => ({ id: m.id, name: m.name, pingMs: m.pingMs }));
    let summary = null;
    if (g && ['levelEnd', 'gameOver', 'victory', 'roundEnd'].includes(room.phase)) {
      const next = (r?.level || 1) + 1;
      const pw = Object.entries(this.data.passwords || {}).find(([, v]) => v === next)?.[0] || null;
      const champ = r?.mode === 'battle' ? g.players.find(p => p.wins >= room.cfg.wins)?.slot ?? -1 : -1;
      const roundWinner = r?.mode === 'battle' ? g.players.find(p => p.alive)?.slot ?? -1 : -1;
      summary = {
        mode: r?.mode || 'normal',
        level: r?.level || 1,
        nextLevel: next,
        checkpoint: checkpoint(r?.level || 1),
        round: r?.round || 1,
        winsNeeded: room.cfg.wins,
        password: pw,
        champ,
        roundWinner,
        rows: g.players.map(p => ({
          slot: p.slot, score: p.score, kills: p.kills, lives: p.lives, wins: p.wins,
          selfKills: p.selfKills || 0, spellsCast: p.spellsCast || 0, rocksBroken: p.rocksBroken || 0,
          bot: p.bot || null,
        })),
      };
    }
    return {
      t: 'room',
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      cfg: room.cfg,
      players,
      spectators,
      lx: room.lx,
      summary,
    };
  }

  broadcastRoom(room, extra = {}) {
    const payload = { ...this.roomState(room), ...extra };
    this._broadcastJson(room, payload);
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this.rooms.size === 0) {
        clearInterval(this._timer);
        this._timer = null;
        return;
      }
      this.stepAll(Date.now());
    }, 4);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
