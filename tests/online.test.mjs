// node tests/online.test.mjs — end-to-end tests for HTTP/WebSocket server, rooms, snapshots, and host transfer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFracasServer } from '../server.mjs';
import { createClientGame, applySnapshot, SNAP_TICKS } from '../src/net/protocol.js';
import { OnlineController } from '../src/net/lobby.js';
import { Game } from '../src/game/sim.js';
import { RollbackSession, packInput, unpackInput, encodeInputPacket, encodeChecksumPacket, decodePacket, bytesToB64, b64ToBytes, recommendInputDelay } from '../src/net/rollback.js';
import { DIRS, TICK } from '../src/game/constants.js';

const levelsData = JSON.parse(readFileSync(new URL('../data/levels.json', import.meta.url)));

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const msgs = [];
    const waiters = [];

    const dispatch = msg => {
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (w.pred(msg)) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      msgs.push(msg);
    };

    ws.addEventListener('message', ev => {
      if (ev.data instanceof ArrayBuffer) {
        dispatch({ t: '_bin', data: new Uint8Array(ev.data) });
        return;
      }
      const msg = JSON.parse(ev.data);
      dispatch(msg);
    });
    ws.addEventListener('error', err => reject(err));

    const next = (pred, timeoutMs = 4000) => {
      const idx = msgs.findIndex(pred);
      if (idx >= 0) return Promise.resolve(msgs.splice(idx, 1)[0]);
      const err = new Error(`Timed out waiting for WebSocket message (queued: ${msgs.map(m => m.t).join(',')})`);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          rej(err);
        }, timeoutMs);
        const entry = { pred, resolve: res, timer };
        waiters.push(entry);
      });
    };

    next(m => m.t === 'hello').then(hello => {
      resolve({
        ws,
        hello,
        next,
        send(obj) { ws.send(JSON.stringify(obj)); },
        close() {
          return new Promise(r => {
            if (ws.readyState >= WebSocket.CLOSING) { r(); return; }
            ws.addEventListener('close', () => r(), { once: true });
            ws.close();
          });
        },
      });
    }, reject);
  });
}

async function run() {
  const srv = createFracasServer({ port: 0, host: '127.0.0.1' });
  const port = await srv.start();
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}/ws`;

  let c1, c2;
  try {
    // 1. HTTP static + health + gzip + asset ETag + traversal guard
    const hRes = await fetch(`${baseHttp}/health`);
    assert.equal(hRes.status, 200);
    assert.equal(hRes.headers.get('x-fracas-server'), 'ws');
    assert.equal(await hRes.text(), 'ok');

    const idxRes = await fetch(`${baseHttp}/index.html`);
    assert.equal(idxRes.status, 200);
    assert.match(idxRes.headers.get('cache-control') || '', /no-store/);

    const lvRes = await fetch(`${baseHttp}/data/levels.json`);
    assert.equal(lvRes.status, 200);
    const lvJson = await lvRes.json();
    assert.ok(Array.isArray(lvJson.normal) && lvJson.normal.length > 0);

    const pngRes = await fetch(`${baseHttp}/assets/atlas.png`);
    assert.equal(pngRes.status, 200);
    const etag = pngRes.headers.get('etag');
    assert.ok(etag, 'media assets include ETag');
    assert.match(pngRes.headers.get('cache-control') || '', /max-age=3600/);
    const png304 = await fetch(`${baseHttp}/assets/atlas.png`, { headers: { 'If-None-Match': etag } });
    assert.equal(png304.status, 304);

    const travRes = await fetch(`${baseHttp}/../Windows/win.ini`);
    assert.ok(travRes.status === 403 || travRes.status === 404, 'path traversal blocked');

    // 2. WebSocket handshake + host/join + slot switch + config
    c1 = await connectClient(baseWs);
    c2 = await connectClient(baseWs);
    assert.ok(c1.hello.clientId && c1.hello.token);

    c1.send({ t: 'host', name: 'Ahmed' });
    const j1 = await c1.next(m => m.t === 'joined');
    assert.equal(j1.slot, 0);
    assert.equal(j1.isHost, true);
    const r1 = await c1.next(m => m.t === 'room');
    assert.equal(r1.phase, 'lobby');
    const code = r1.code;

    c2.send({ t: 'join', code: 'ZZZZ', name: 'Guest' });
    const errMsg = await c2.next(m => m.t === 'err');
    assert.equal(errMsg.code, 'NOT_FOUND');

    c2.send({ t: 'join', code, name: 'Omar' });
    const j2 = await c2.next(m => m.t === 'joined');
    assert.equal(j2.slot, 1);
    assert.equal(j2.isHost, false);

    c2.send({ t: 'slot', slot: 2 });
    const switched = await c1.next(m => m.t === 'room' && m.players.some(p => p.id === c2.hello.clientId && p.slot === 2));
    assert.ok(switched);

    c1.send({ t: 'cfg', password: 'EARTH' });
    const pwRoom = await c1.next(m => m.t === 'room' && m.cfg.level === 6);
    assert.equal(pwRoom.cfg.level, 6);

    c1.send({ t: 'cfg', level: 1 });
    await c1.next(m => m.t === 'room' && m.cfg.level === 1);

    // 3. Start Normal Co-op match & sync inputs + snapshots
    c1.send({ t: 'start' });
    const ls1 = await c1.next(m => m.t === 'levelStart');
    const ls2 = await c2.next(m => m.t === 'levelStart');
    assert.deepEqual(ls1.slots, [0, 2]);
    assert.equal(ls2.level, 1);

    const g1 = createClientGame(levelsData.normal[0], { mode: 'normal', players: ls1.slots });
    const g2 = createClientGame(levelsData.normal[0], { mode: 'normal', players: ls2.slots });

    const s1 = await c1.next(m => m.t === 'snap');
    const s2 = await c2.next(m => m.t === 'snap');
    assert.equal(s1.terrain.length, 21 * 15);
    applySnapshot(g1, s1, 1);
    applySnapshot(g2, s2, 1);
    assert.equal(g2.players.length, 2);
    assert.ok(g2.monsters.length > 0, 'monsters synced to client');

    // Clear initial freeze directly on authoritative room game so we can test immediate action without waiting 2.2s
    const serverRoom = srv.rooms.rooms.get(code);
    serverRoom.game.freeze = 0;

    c1.send({ t: 'in', seq: 7, dir: 0, bomb: true, power: false, bombHeld: true, powerHeld: false });
    const bombSnap = await c2.next(m => m.t === 'snap' && m.bombs.length > 0, 4000);
    assert.equal(bombSnap.terrain, undefined, 'unchanged terrain omitted in delta snapshot');
    applySnapshot(g2, bombSnap, 1);
    assert.equal(g2.bombs.length, 1);
    assert.equal(g2.bombs[0].owner, 0);
    assert.ok(g2.players.find(p => p.slot === 0)._netAck >= 7, 'server acknowledges latest input seq');

    // Verify 30 Hz snapshot cadence, client-validated position sync, jitter hold, and interpolation buffer
    assert.equal(SNAP_TICKS, 2, 'regular snapshots run at 30 Hz while urgent events flush immediately');

    // Verify local movement prediction doesn't emit events or mutate doors
    const localP = g1.players.find(p => p.slot === 0);
    const startX = localP.fx;
    localP.input.dir = 0;
    g1.movePlayer(localP, 1 / 60, true);
    assert.ok(localP.fx >= startX, 'predicted move advances or respects wall');
    assert.equal(g1.drainEvents().length, 0, 'predicted move emits no events');

    // Client-validated position sync (valid move accepted; solid wall jump rejected)
    const srvP0 = serverRoom.game.players.find(p => p.slot === 0);
    let openD = 0;
    for (let d = 0; d < 4; d++) {
      if (serverRoom.game.canStep(srvP0, srvP0.cx, srvP0.cy, d)) { openD = d; break; }
    }
    const targetX = srvP0.fx + DIRS[openD][0] * 0.35;
    const targetY = srvP0.fy + DIRS[openD][1] * 0.35;
    c1.send({
      t: 'in', seq: 8, dir: openD, secDir: (openD + 1) % 4,
      bomb: false, power: false, bombHeld: false, powerHeld: false,
      x: targetX, y: targetY, mov: true, fdir: openD,
    });
    const syncSnap = await c2.next(m => m.t === 'snap' && m.players.find(sp => sp[0] === 0)?.[25] >= 8, 4000);
    assert.ok(typeof syncSnap.st === 'number', 'snapshot carries monotonic server timestamp st');
    const syncedP0 = syncSnap.players.find(sp => sp[0] === 0);
    assert.ok(Math.hypot(syncedP0[2] - targetX, syncedP0[3] - targetY) < 0.02, 'server accepted valid client position');

    // Jitter hold: stepping 5 ticks without new client position holds exact position (zero ping-pong drift)
    for (let k = 0; k < 5; k++) srv.rooms.stepRoom(serverRoom, 1 / 60);
    assert.ok(Math.hypot(srvP0.fx - targetX, srvP0.fy - targetY) < 0.005, 'server holds client-driven player during short jitter');

    // Attempt invalid move into outer corner wall (0.5, 0.5): server must reject
    c1.send({
      t: 'in', seq: 9, dir: 2, secDir: -1,
      bomb: false, power: false, bombHeld: false, powerHeld: false,
      x: 0.5, y: 0.5, mov: true,
    });
    const rejSnap = await c2.next(m => m.t === 'snap' && m.players.find(sp => sp[0] === 0)?.[25] >= 9, 4000);
    const rejP0 = rejSnap.players.find(sp => sp[0] === 0);
    assert.ok(Math.hypot(rejP0[2] - 0.5, rejP0[3] - 0.5) > 0.5, 'server rejected out-of-bounds/wall client position');

    // OnlineController adaptive interpolation buffer smooths remote players & monsters without teleporting
    const mockApp = {
      data: levelsData,
      save: {},
      cheats: {},
      audio: { play() {}, rude: false },
      renderer: { setGame() {}, handle() {}, psycho: false },
      syncMusic() {},
      buildHud() {},
      onEvents() {},
    };
    const oc = new OnlineController(mockApp, { innerHTML: '' });
    oc.net.slot = 0;
    oc.onLevelStart({ mode: 'normal', level: 1, round: 0, slots: [0, 2], carry: {}, cheats: {} });
    const baseMon = [901, 3, 4.0, 1.5, 0, 3, 1, 1, 0, 0, 0, null, 0, 0];
    const baseP0 = [0, 1, 1.5, 1.5, 0, 2, 3, 0, 0, 0, 1, 1, null, 0, 1, 0, 0, 0, 0, null, 0, 0, 0, 0, 0, 1];
    const baseP2 = [2, 2, 10.0, 1.5, 0, 3, 3, 0, 0, 0, 1, 1, null, 0, 1, 0, 0, 0, 0, null, 0, 0, 0, 0, 0, 0];
    oc.onSnap({ ...syncSnap, st: 1000, players: [baseP0, baseP2], monsters: [baseMon], bombs: [], flames: [], projs: [], winds: [], events: undefined });
    const mon2 = [901, 3, 4.2, 1.5, 0, 3, 1, 1, 0, 0, 0, null, 0, 0];
    const p2_2 = [2, 2, 10.2, 1.5, 0, 3, 3, 0, 0, 0, 1, 1, null, 0, 1, 0, 0, 0, 0, null, 0, 0, 0, 0, 0, 0];
    oc.onSnap({ ...syncSnap, st: 1033, players: [baseP0, p2_2], monsters: [mon2], bombs: [], flames: [], projs: [], winds: [], events: undefined });
    oc.renderServerMs = 1016.5;
    oc.sampleSnapBuffer(0);
    const interpMon = mockApp.game.monsters.find(m => m.id === 901);
    const interpRemote = mockApp.game.players.find(p => p.slot === 2);
    assert.ok(Math.abs(interpMon.x - 4.1) < 0.01, `interpolated monster midway at 4.1, got ${interpMon.x}`);
    assert.ok(Math.abs(interpRemote.fx - 10.1) < 0.01, `interpolated remote player midway at 10.1, got ${interpRemote.fx}`);

    // Bounded extrapolation keeps moving smoothly if next packet is late instead of freezing
    oc.renderServerMs = 1050;
    oc.sampleSnapBuffer(0);
    assert.ok(interpMon.x > 4.2 && interpMon.x < 4.45, `bounded extrapolation advances smoothly: ${interpMon.x}`);

    // Predicted bomb reconciliation: unacked predicted bomb survives until server confirms or ack passes
    const predGame = createClientGame(levelsData.normal[0], { mode: 'normal', players: [0] });
    applySnapshot(predGame, syncSnap, 1);
    const predUntil = performance.now() + 5000;
    predGame.bombs.push({
      id: -1, x: 5, y: 5, cx: 5, cy: 5, owner: 0, range: 1, fuse: 4, age: 0, kind: 'fire', vent: -1,
      rx: 5, ry: 5, prx: 5, pry: 5, _pred: true, _predSeq: 99, _predUntil: predUntil,
    });
    applySnapshot(predGame, { ...syncSnap, bombs: [] }, 1);
    assert.equal(predGame.bombs.length, 1, 'unacked predicted bomb persists before server ack');
    assert.equal(predGame.bombs[0].id, -1);

    // Matching authoritative bomb replaces predicted bomb without duplication
    applySnapshot(predGame, {
      ...syncSnap,
      bombs: [[777, 5, 5, 5, 5, 0, 1, 4.1, 0.1, 'fire', -1, 5, 5]],
    }, 1);
    assert.equal(predGame.bombs.length, 1, 'matching server bomb replaces predicted bomb cleanly');
    assert.equal(predGame.bombs[0].id, 777);

    // Stale predicted bomb whose seq is already acknowledged is pruned if absent from server snapshot
    predGame.bombs.push({
      id: -2, x: 6, y: 5, cx: 6, cy: 5, owner: 0, range: 1, fuse: 4, age: 0, kind: 'fire', vent: -1,
      rx: 6, ry: 5, prx: 6, pry: 5, _pred: true, _predSeq: 8, _predUntil: predUntil,
    });
    applySnapshot(predGame, { ...syncSnap, bombs: [] }, 1);
    assert.equal(predGame.bombs.length, 0, 'acked predicted bomb absent on server is pruned');

    // 4. Pause & Resume & Back to Lobby & Battle Mode & Host Promotion
    c1.send({ t: 'pause', paused: true });
    const pausedRoom = await c2.next(m => m.t === 'room' && m.phase === 'paused');
    assert.equal(pausedRoom.phase, 'paused');

    c1.send({ t: 'pause', paused: false });
    const resumedRoom = await c2.next(m => m.t === 'room' && m.phase === 'play');
    assert.equal(resumedRoom.phase, 'play');

    c1.send({ t: 'lobby' });
    const lobbyRoom = await c2.next(m => m.t === 'room' && m.phase === 'lobby');
    assert.equal(lobbyRoom.phase, 'lobby');

    c1.send({ t: 'cfg', mode: 'battle', arena: 0, wins: 2 });
    await c2.next(m => m.t === 'room' && m.cfg.mode === 'battle');

    c1.send({ t: 'start' });
    const battleStart = await c2.next(m => m.t === 'levelStart' && m.mode === 'battle');
    assert.equal(battleStart.round, 1);

    // Host disconnects -> Client 2 automatically promoted to Host
    await c1.close();
    const promoted = await c2.next(m => m.t === 'room' && m.hostId === c2.hello.clientId);
    assert.equal(promoted.hostId, c2.hello.clientId);

    // 5. Life Exchange flow on server room
    c2.send({ t: 'lobby' });
    await c2.next(m => m.t === 'room' && m.phase === 'lobby');
    const c3 = await connectClient(baseWs);
    c3.send({ t: 'join', code, name: 'Sara' });
    await c3.next(m => m.t === 'joined');
    c2.send({ t: 'cfg', mode: 'normal', level: 1 });
    await c2.next(m => m.t === 'room' && m.cfg.mode === 'normal');
    c2.send({ t: 'start' });
    await c2.next(m => m.t === 'levelStart');
    await c3.next(m => m.t === 'levelStart');

    // Simulate player 3 out of lives while player 2 has 3 lives and all monsters dead -> portal exit -> lifeExchange
    const g = serverRoom.game;
    const pDonor = g.players[0];
    const pFallen = g.players[1];
    pDonor.lives = 3;
    pFallen.lives = 0; pFallen.alive = false; pFallen.out = true;
    g.state = 'won';
    g.stateTime = 2.5;
    srv.rooms.stepRoom(serverRoom, 1 / 60);

    const lxRoom = await c2.next(m => m.t === 'room' && m.phase === 'lifeExchange');
    await c3.next(m => m.t === 'room' && m.phase === 'lifeExchange');
    assert.ok(lxRoom.lx);
    c2.send({ t: 'lx', op: 'give' });
    const lxAfter = await c3.next(m => m.t === 'room' && m.phase === 'lifeExchange' && m.lx.flashR > 0);
    assert.ok(lxAfter.lx);
    assert.equal(pDonor.lives, 2);
    assert.equal(pFallen.lives, 1);

    c2.send({ t: 'lx', op: 'confirm' });
    const endRoom = await c2.next(m => m.t === 'room' && m.phase === 'levelEnd');
    assert.equal(endRoom.summary.nextLevel, 2);

    await c2.close();
    await c3.close();

    // 6. Rollback binary packet codec, 2-peer simulation with packet drops & mispredictions, event dedup & rbSync
    {
      const sampleInp = { dir: 2, secDir: 3, bomb: true, power: false, bombHeld: true, powerHeld: false };
      const packed = packInput(sampleInp);
      assert.deepEqual(unpackInput(packed), sampleInp, 'packInput/unpackInput preserves all bits');
      assert.deepEqual(unpackInput(packInput({ dir: -1, secDir: -1, bomb: false, power: false })), {
        dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false,
      });

      const pktBytes = encodeInputPacket(1, 7, 100, 98, 105, [packed, packed & ~0x40]);
      const decoded = decodePacket(b64ToBytes(bytesToB64(pktBytes)));
      assert.equal(decoded.slot, 1);
      assert.equal(decoded.matchSeq, 7);
      assert.equal(decoded.startFrame, 100);
      assert.equal(decoded.peerAck, 98);
      assert.equal(decoded.senderFrame, 105);
      assert.deepEqual(decoded.packs, [packed, packed & ~0x40]);

      const csBytes = encodeChecksumPacket(0, 7, 120, 0xdeadbeef);
      const csDec = decodePacket(csBytes);
      assert.equal(csDec.type, 2);
      assert.equal(csDec.frame, 120);
      assert.equal(csDec.checksum, 0xdeadbeef);

      // Two peers simulate 180 frames (3 seconds) with realistic 4-frame latency + burst packet drops
      const seed = 424242;
      const lv = levelsData.normal[4];
      const g0 = new Game(lv, { mode: 'normal', players: [0, 1], seed });
      const g1 = new Game(lv, { mode: 'normal', players: [0, 1], seed });
      const wire0to1 = [];
      const wire1to0 = [];
      const ev0 = [], ev1 = [];

      const rb0 = new RollbackSession(g0, {
        localSlot: 0, matchSeq: 3, slots: [0, 1],
        sendPacket: bytes => wire0to1.push({ at: rb0.localFrame + 3, bytes: new Uint8Array(bytes) }),
        onEvents: list => ev0.push(...list),
      });
      const rb1 = new RollbackSession(g1, {
        localSlot: 1, matchSeq: 3, slots: [0, 1],
        sendPacket: bytes => wire1to0.push({ at: rb1.localFrame + 4, bytes: new Uint8Array(bytes) }),
        onEvents: list => ev1.push(...list),
      });

      const script0 = f => ({
        dir: f < 160 ? 0 : (f < 260 ? 1 : -1), secDir: -1,
        bomb: f === 130 || f === 395, power: false, bombHeld: false, powerHeld: false,
      });
      const script1 = f => ({
        dir: f < 170 ? 2 : (f < 250 ? 3 : 0), secDir: -1,
        bomb: f === 138 || f === 402, power: false, bombHeld: false, powerHeld: false,
      });

      // Simulate 415 active frames (~6.9s, covering freeze end, movement, explosions & reload) + UDP drops
      for (let f = 0; f < 415; f++) {
        // Stale wrong-matchSeq packet must be ignored silently
        if (f === 10) rb1.onRemotePacket(encodeInputPacket(0, 99, 0, -1, 50, [0x01]));

        rb0.stepFrame(script0(f));
        rb1.stepFrame(script1(f));

        for (let i = wire0to1.length - 1; i >= 0; i--) {
          if (wire0to1[i].at <= f) {
            const p = wire0to1.splice(i, 1)[0];
            if (p.at % 5 !== 0 && p.at % 7 !== 0) rb1.onRemotePacket(p.bytes);
          }
        }
        for (let i = wire1to0.length - 1; i >= 0; i--) {
          if (wire1to0[i].at <= f) {
            const p = wire1to0.splice(i, 1)[0];
            if (p.at % 4 !== 0 && p.at % 6 !== 0) rb0.onRemotePacket(p.bytes);
          }
        }
      }
      // Drain final in-flight redundant packets so both converge cleanly
      while (wire0to1.length) rb1.onRemotePacket(wire0to1.shift().bytes);
      while (wire1to0.length) rb0.onRemotePacket(wire1to0.shift().bytes);

      assert.ok(rb0.rollbacks > 0 && rb1.rollbacks > 0, `expected rollbacks to fire (rb0=${rb0.rollbacks}, rb1=${rb1.rollbacks})`);
      assert.equal(rb0.desyncs, 0, 'checksum verification observed 0 desyncs');
      assert.equal(rb1.desyncs, 0);
      assert.equal(g0.stateChecksum(), g1.stateChecksum(), 'both peers converge to identical deterministic checksum after rollbacks & packet drops');

      // Events from bomb placements and explosions are identical & deduplicated (no double SFX on rollback)
      const bombs0 = ev0.filter(e => e.t === 'bomb');
      const bombs1 = ev1.filter(e => e.t === 'bomb');
      assert.ok(bombs0.length >= 3, `expected at least 3 bombs placed across players (got ${bombs0.length})`);
      assert.deepEqual(bombs0.map(b => b.id).sort(), bombs1.map(b => b.id).sort(), 'both peers emitted identical unique bomb IDs with zero duplicates');
      const booms0 = ev0.filter(e => e.t === 'boom');
      const booms1 = ev1.filter(e => e.t === 'boom');
      assert.ok(booms0.length >= 2 && booms0.length === booms1.length, `matching deduplicated explosions (${booms0.length} vs ${booms1.length})`);

      // Tab-sleep / rejoin snapshot catchup (exportSync -> applySync) restores exact state and lets play continue synced
      const gLate = new Game(lv, { mode: 'normal', players: [0, 1], seed: 1 });
      const rbLate = new RollbackSession(gLate, { localSlot: 1, matchSeq: 3, slots: [0, 1] });
      rbLate.applySync(JSON.parse(JSON.stringify(rb0.exportSync())));
      assert.equal(gLate.stateChecksum(), g0.stateChecksum(), 'applySync catches up peer cleanly');

      // Anti-deadlock test: if Peer 1 stops sending completely for 120 frames (e.g. background tab),
      // Peer 0 unblocks past the stall window cleanly without freezing, and resyncs seamlessly when Peer 1 wakes up.
      let needSyncFired = false;
      const wWake = [], wWakeBack = [];
      const gWakeH = new Game(levelsData.normal[0], { mode: 'normal', players: [0, 1], seed: 77777 });
      const gWakeC = new Game(levelsData.normal[0], { mode: 'normal', players: [0, 1], seed: 77777 });
      const rbWH = new RollbackSession(gWakeH, {
        localSlot: 0, matchSeq: 4, slots: [0, 1],
        sendPacket: b => wWake.push(new Uint8Array(b)),
      });
      const rbWC = new RollbackSession(gWakeC, {
        localSlot: 1, matchSeq: 4, slots: [0, 1],
        sendPacket: b => wWakeBack.push(new Uint8Array(b)),
        onNeedSync: () => { needSyncFired = true; },
      });
      // Exchange frame 0..10 cleanly, then Peer 1 sleeps completely while Peer 0 advances 2.5 seconds (150 frames!)
      for (let f = 0; f <= 10; f++) {
        rbWH.stepFrame({ dir: -1 }); rbWC.stepFrame({ dir: -1 });
      }
      while (wWake.length) rbWC.onRemotePacket(wWake.shift());
      while (wWakeBack.length) rbWH.onRemotePacket(wWakeBack.shift());
      // Backdate stall timestamps cleanly to simulate 400ms wall-clock wait during Peer 1 sleep
      const p0StartX = gWakeH.players[0].fx;
      for (let f = 11; f < 165; f++) {
        if (rbWH._stallStartMs) rbWH._stallStartMs -= 400;
        rbWH.lastRecvWallMs.set(1, Date.now() - 2000);
        rbWH.update(TICK, () => ({ dir: f >= 125 ? 0 : -1, secDir: -1, bomb: false, power: false }));
      }
      assert.ok(rbWH.localFrame >= 160, `Host must never deadlock on missing peer (reached frame ${rbWH.localFrame})`);
      assert.ok(gWakeH.players[0].fx > p0StartX + 0.5, `Host player moved smoothly despite sleeping peer (fx=${gWakeH.players[0].fx})`);

      // When waking Peer 1 receives Host packet far ahead, onNeedSync triggers -> rbSync -> exact parity resumes
      if (wWake.length) rbWC.onRemotePacket(wWake[wWake.length - 1]);
      assert.equal(needSyncFired, true, 'far-behind client triggers onNeedSync cleanly');
      rbWC.applySync(JSON.parse(JSON.stringify(rbWH.exportSync())));
      rbWH.markPeerSynced(1);
      assert.equal(gWakeC.stateChecksum(), gWakeH.stateChecksum(), 'Host and waking client resume with identical checksum');
      wWake.length = 0; wWakeBack.length = 0;
      for (let f = 0; f < 40; f++) {
        rbWH.stepFrame({ dir: 0 });
        rbWC.stepFrame({ dir: 2 });
        while (wWake.length) rbWC.onRemotePacket(wWake.shift());
        while (wWakeBack.length) rbWH.onRemotePacket(wWakeBack.shift());
      }
      assert.equal(gWakeC.stateChecksum(), gWakeH.stateChecksum(), 'peers remain synced after resuming from stall');
    }

    // 7. End-to-end WebSocket RoomManager rollback workflow (rtc signaling, pin fallback relay, rbSync, rbEnd -> lifeExchange -> levelEnd)
    {
      const rHost = await connectClient(baseWs);
      const rPeer = await connectClient(baseWs);
      try {
        rHost.send({ t: 'host', name: 'P2PHost', rb: true });
        const joinedH = await rHost.next(m => m.t === 'joined');
        const rbCode = joinedH.code;

        rPeer.send({ t: 'join', code: rbCode, name: 'P2PPeer', rb: true });
        const joinedP = await rPeer.next(m => m.t === 'joined');

        rHost.send({ t: 'start' });
        const lsH = await rHost.next(m => m.t === 'levelStart');
        const lsP = await rPeer.next(m => m.t === 'levelStart');
        assert.equal(lsH.rollback, true, 'rb:true room enables rollback mode');
        assert.equal(lsP.rollback, true);
        assert.equal(lsH.seed, lsP.seed, 'server distributes shared deterministic seed');
        assert.equal(typeof lsH.matchSeq, 'number');

        const rbRoom = srv.rooms.rooms.get(rbCode);
        assert.equal(rbRoom.rollback, true);

        // Verify server relays WebRTC signaling ('rtc') between peers
        rHost.send({ t: 'rtc', to: joinedP.clientId, kind: 'offer', data: { type: 'offer', sdp: 'v=0-mock' } });
        const relayedRtc = await rPeer.next(m => m.t === 'rtc');
        assert.equal(relayedRtc.from, joinedH.clientId);
        assert.equal(relayedRtc.slot, 0);
        assert.equal(relayedRtc.kind, 'offer');

        // Verify WebSocket 'pin' relay fallback forwards binary input batch payload to targeted peer
        const sampleB64 = bytesToB64(encodeInputPacket(0, lsH.matchSeq, 0, -1, 0, [packInput({ dir: 1 })]));
        rHost.send({ t: 'pin', to: [joinedP.clientId], d: sampleB64 });
        const relayedPin = await rPeer.next(m => m.t === 'pin');
        assert.equal(relayedPin.slot, 0);
        assert.equal(relayedPin.d, sampleB64);

        // Verify Host 'rbEnd' cleanly drives Life Exchange and Level End without running server-side physics
        rHost.send({
          t: 'rbEnd',
          outcome: 'won',
          players: [
            { slot: 0, lives: 4, score: 350, kills: 5, wins: 0, out: true },
            { slot: 1, lives: 0, score: 120, kills: 1, wins: 0, out: true },
          ],
        });
        const rbLx = await rPeer.next(m => m.t === 'room' && m.phase === 'lifeExchange');
        assert.ok(rbLx.lx, 'rbEnd transitioned cleanly to lifeExchange when donor had >1 life and peer had 0');
        rHost.send({ t: 'lx', op: 'give' });
        await rPeer.next(m => m.t === 'room' && m.phase === 'lifeExchange' && m.lx.flashR > 0);
        rHost.send({ t: 'lx', op: 'confirm' });
        const rbEndRoom = await rPeer.next(m => m.t === 'room' && m.phase === 'levelEnd');
        assert.equal(rbEndRoom.summary.rows[0].lives, 3);
        assert.equal(rbEndRoom.summary.rows[1].lives, 1);

        // 8. Verify symmetric GGPO frame advantage (NO slow-motion at 200ms RTT!), UDP non-reliable channel retention,
        //    inputDelay=2 determinism, AI Bot determinism, and Friendly Fire mutator
        {
          assert.equal(recommendInputDelay(25), 0);
          assert.equal(recommendInputDelay(90), 1);
          assert.equal(recommendInputDelay(180), 2);
          assert.equal(recommendInputDelay(260), 3);

          const lvB = levelsData.battle[0];
          const mut = { startMax: true, fuseScale: 0.65, suddenDeath: 'fast' };
          const bots = { 2: 'master' };
          const gA = new Game(lvB, { mode: 'battle', players: [0, 1, 2], bots, mutators: mut, seed: 999001 });
          const gB = new Game(lvB, { mode: 'battle', players: [0, 1, 2], bots, mutators: mut, seed: 999001 });
          assert.equal(gA.players[0].bombsMax, 5, 'startMax mutator sets bombsMax=5');
          assert.equal(gA.players[0].range, 5, 'startMax mutator sets range=5');

          const wAtoB = [], wBtoA = [];
          let forcedReliableInputs = 0;
          const rbA = new RollbackSession(gA, {
            localSlot: 0, matchSeq: 9, slots: [0, 1, 2], botSlots: [2], inputDelay: 2,
            sendPacket: (bytes, rel) => {
              if (bytes[0] === 1 && rel) forcedReliableInputs++;
              wAtoB.push({ at: rbA.localFrame + 6, bytes: new Uint8Array(bytes) }); // 6 frames one-way = 200ms RTT!
            },
          });
          const rbB = new RollbackSession(gB, {
            localSlot: 1, matchSeq: 9, slots: [0, 1, 2], botSlots: [2], inputDelay: 2,
            sendPacket: (bytes, rel) => {
              if (bytes[0] === 1 && rel) forcedReliableInputs++;
              wBtoA.push({ at: rbB.localFrame + 6, bytes: new Uint8Array(bytes) });
            },
          });

          // Simulate 240 frames (4 seconds) at 200ms RTT using update(TICK) so frameAdvantage() pacing is exercised!
          for (let f = 0; f < 240; f++) {
            rbA.update(TICK, () => ({ dir: f % 60 < 30 ? 0 : 1, secDir: -1, bomb: f === 150, power: false }));
            rbB.update(TICK, () => ({ dir: f % 50 < 25 ? 2 : 3, secDir: -1, bomb: f === 155, power: false }));
            while (wAtoB.length && wAtoB[0].at <= f) rbB.onRemotePacket(wAtoB.shift().bytes);
            while (wBtoA.length && wBtoA[0].at <= f) rbA.onRemotePacket(wBtoA.shift().bytes);
          }
          while (wAtoB.length) rbB.onRemotePacket(wAtoB.shift().bytes);
          while (wBtoA.length) rbA.onRemotePacket(wBtoA.shift().bytes);

          // Both peers must advance full ~240 frames without slow-motion slowdown!
          assert.ok(rbA.localFrame >= 235 && rbB.localFrame >= 235, `Zero slow-motion at 200ms RTT (A=${rbA.localFrame}, B=${rbB.localFrame})`);
          assert.equal(forcedReliableInputs, 0, 'normal 200ms RTT input batches stay on fast unreliable UDP channel');
          assert.equal(gA.stateChecksum(), gB.stateChecksum(), 'AI Bot + inputDelay=2 rollback peers converge to bit-identical checksum');

          // Verify Friendly Fire OFF protects teammate in Co-op while still hurting self
          const gFF = new Game(levelsData.normal[0], { mode: 'normal', players: [0, 1], mutators: { friendlyFire: false }, freeze: 0, seed: 123 });
          const p0 = gFF.players[0], p1 = gFF.players[1];
          p0.invuln = 0; p1.invuln = 0;
          gFF.hurtPlayer(p1, 'blast', 0);
          assert.equal(p1.alive, true, 'friendlyFire:false protects teammate from blast');
          gFF.hurtPlayer(p0, 'blast', 0);
          assert.equal(p0.alive, false, 'friendlyFire:false still applies self-damage');
        }

        // 9. Verify Binary WebSocket Relay (0x50), Ready Barrier (rbReady -> rbGo), AI Bot lobby toggle, Emotes & Spectator mid-match join
        {
          rHost.send({ t: 'lobby' });
          await rPeer.next(m => m.t === 'room' && m.phase === 'lobby');

          rHost.send({ t: 'bot', slot: 2, diff: 'master' });
          const botRoom = await rPeer.next(m => m.t === 'room' && m.cfg.bots?.[2] === 'master');
          assert.equal(botRoom.cfg.bots[2], 'master');

          rHost.send({ t: 'emote', id: 'gg' });
          const em = await rPeer.next(m => m.t === 'emote' && m.id === 'gg');
          assert.equal(em.slot, 0);

          rHost.send({ t: 'start' });
          const lsH2 = await rHost.next(m => m.t === 'levelStart');
          const lsP2 = await rPeer.next(m => m.t === 'levelStart');
          assert.equal(lsH2.waitForGo, true, '2-player rollback match enables ready barrier');
          assert.deepEqual(lsH2.slots, [0, 1, 2], 'AI bot slot included in match slots');

          // Both send rbReady -> server broadcasts rbGo
          rHost.send({ t: 'rbReady', matchSeq: lsH2.matchSeq });
          rPeer.send({ t: 'rbReady', matchSeq: lsP2.matchSeq });
          const goH = await rHost.next(m => m.t === 'rbGo');
          const goP = await rPeer.next(m => m.t === 'rbGo');
          assert.equal(goH.matchSeq, lsH2.matchSeq);
          assert.equal(goP.matchSeq, lsP2.matchSeq);

          // Binary WebSocket relay forwards raw rollback packet with zero JSON/Base64
          const rawPkt = encodeInputPacket(0, lsH2.matchSeq, 0, -1, 0, [packInput({ dir: 0 })], 0);
          const wireFrame = new Uint8Array(2 + rawPkt.byteLength);
          wireFrame[0] = 0x50;
          wireFrame[1] = 1 << 1; // target slot 1
          wireFrame.set(rawPkt, 2);
          rHost.ws.send(wireFrame.buffer);
          const binRecv = await rPeer.next(m => m.t === '_bin');
          assert.equal(binRecv.data[0], 0x50);
          assert.equal(binRecv.data[1], 0, 'binary relay stamps sender slot');
          const decBin = decodePacket(binRecv.data.subarray(2));
          assert.equal(decBin.slot, 0);
          assert.equal(decBin.matchSeq, lsH2.matchSeq);

          // 3rd client joins mid-match -> enters Spectator Mode cleanly, then auto-promotes on lobby return
          const rSpec = await connectClient(baseWs);
          try {
            rSpec.send({ t: 'join', code: rbCode, name: 'Watcher', rb: true });
            const jSpec = await rSpec.next(m => m.t === 'joined');
            assert.equal(jSpec.spectator, true, 'mid-match joiner enters as spectator');
            assert.equal(jSpec.slot, -1);
            const lsSpec = await rSpec.next(m => m.t === 'levelStart');
            assert.equal(lsSpec.spectator, true);
            const syncReq = await rHost.next(m => m.t === 'rbSyncReq' && m.to === jSpec.clientId);
            assert.equal(syncReq.spectator, true);

            rHost.send({ t: 'lobby' });
            const lobbySpec = await rSpec.next(m => m.t === 'room' && m.phase === 'lobby');
            assert.ok(lobbySpec.players.some(p => p.id === jSpec.clientId && p.slot >= 0), 'spectator auto-promoted to wizard slot on lobby return');
          } finally {
            await rSpec.close();
          }
        }
      } finally {
        await rHost.close();
        await rPeer.close();
      }
    }

    console.log('online multiplayer tests passed');
  } finally {
    if (c1) await c1.close();
    if (c2) await c2.close();
    await srv.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
