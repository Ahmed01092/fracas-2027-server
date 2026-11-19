// Browser-side online lobby, room coordination, and match UI screens.
import { W, FUSE, TICK, TICK_HZ, TEAM } from '../game/constants.js';
import { Game } from '../game/sim.js';
import { NetClient } from './client.js';
import { PeerMesh } from './rtc.js';
import { RollbackSession, bytesToB64, recommendInputDelay } from './rollback.js';
import { createClientGame, applySnapshot, SNAP_TICKS } from './protocol.js';
import { DEFAULT_ONLINE_SERVER, resolveHttpOrigin } from '../config.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NEUTRAL_INPUT = Object.freeze({ dir: -1, secDir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false });

export const EMOTES = [
  { id: 'warn', key: 'Digit1', icon: '⚡', text: 'Watch out!' },
  { id: 'nice', key: 'Digit2', icon: '🔥', text: 'Nice!' },
  { id: 'haha', key: 'Digit3', icon: '😂', text: 'Haha!' },
  { id: 'help', key: 'Digit4', icon: '🆘', text: 'Help!' },
  { id: 'gg',   key: 'Digit5', icon: '🏆', text: 'GG!' },
  { id: 'oops', key: 'Digit6', icon: '💀', text: 'Oops!' },
];
const EMOTE_BY_ID = new Map(EMOTES.map(e => [e.id, e]));

export function computeAwards(rows, isBattle) {
  if (!Array.isArray(rows) || rows.length < 2) return new Map();
  const badges = new Map();
  const give = (slot, label, color) => {
    if (!badges.has(slot)) badges.set(slot, { label, color });
  };
  const byKills = [...rows].sort((a, b) => (b.kills || 0) - (a.kills || 0));
  if ((byKills[0]?.kills || 0) > 0 && byKills[0].kills > (byKills[1]?.kills || 0)) {
    give(byKills[0].slot, isBattle ? 'MVP Hunter' : 'Monster Slayer', '#ffcf5a');
  }
  const bySpells = [...rows].sort((a, b) => (b.spellsCast || 0) - (a.spellsCast || 0));
  if ((bySpells[0]?.spellsCast || 0) >= 3 && !badges.has(bySpells[0].slot)) {
    give(bySpells[0].slot, 'Arcane Master', '#5eead4');
  }
  const byRocks = [...rows].sort((a, b) => (b.rocksBroken || 0) - (a.rocksBroken || 0));
  if ((byRocks[0]?.rocksBroken || 0) >= 6 && !badges.has(byRocks[0].slot)) {
    give(byRocks[0].slot, 'Demolitionist', '#ff9b50');
  }
  const bySelf = [...rows].sort((a, b) => (b.selfKills || 0) - (a.selfKills || 0));
  if ((bySelf[0]?.selfKills || 0) > 0 && !badges.has(bySelf[0].slot)) {
    give(bySelf[0].slot, 'Self-Blast', '#ff6b8a');
  }
  return badges;
}

export class OnlineController {
  constructor(app, uiEl) {
    this.app = app;
    this.ui = uiEl;
    this.room = null;
    this.error = '';
    this.prefillCode = '';
    this.localPaused = false;
    this.rb = null;
    this._rbEndSent = false;
    this._rbGoFallback = null;
    this._reconnecting = false;
    this._hudEl = null;
    this._hudAcc = 0;
    this.transportSummary = { total: 0, p2p: 0, relay: 0 };
    this.pendingInputs = [];
    this.predAcc = 0;
    this.clientTick = 0;
    this.smoothOffX = 0;
    this.smoothOffY = 0;
    this._predBombId = 0;
    this._lastPredBombAt = 0;
    this._lastPredSpeedAt = 0;
    this._lastAckSeq = 0;
    this._lastAckX = 0;
    this._lastAckY = 0;
    this.snapBuf = [];
    this.renderServerMs = null;
    this.interpDelayMs = 45;
    this._lastRecvMs = 0;
    this._jitterEmaMs = 0;
    this._lastSnapSt = -1;
    this.mesh = new PeerMesh({
      sendSignal: (to, kind, data) => this.net.sendRtc(to, kind, data),
      onPacket: (data, slot) => this.rb?.onRemotePacket(data, slot),
      onStatus: sum => {
        this.transportSummary = sum;
        const badge = this.ui?.querySelector?.('#net-p2p-badge');
        if (badge) badge.textContent = this._transportLabel(sum);
        this._updateLiveBadge();
      },
    });
    this.net = new NetClient({
      onJoined: () => {
        this.error = '';
        this._reconnecting = false;
        this.mesh.setSelfId(this.net.clientId);
        if (this.net.iceServers?.length) this.mesh.setIceServers(this.net.iceServers);
      },
      onRoom: room => this.onRoom(room),
      onLevelStart: msg => this.onLevelStart(msg),
      onSnap: snap => this.onSnap(snap),
      onRtc: msg => {
        this.mesh.setSelfId(this.net.clientId);
        this.mesh.handleSignal(msg.from, msg.kind, msg.data, msg.slot);
      },
      onPeerInput: msg => {
        if (this.rb) this.rb.onRemotePacket(msg.d, msg.slot);
      },
      onPeerBinary: (bytes, slot) => {
        if (this.rb) this.rb.onRemotePacket(bytes, slot);
      },
      onRbGo: msg => {
        if (this.rb && (typeof msg.matchSeq !== 'number' || msg.matchSeq === this.rb.matchSeq)) {
          if (this._rbGoFallback) { clearTimeout(this._rbGoFallback); this._rbGoFallback = null; }
          this.rb.releaseGo();
          this._updateLiveBadge();
        }
      },
      onEmote: msg => this.onEmote(msg),
      onRbSyncReq: msg => {
        if (this.rb && this.room?.hostId === this.net.clientId) {
          const sync = this.rb.exportSync();
          const peerSlot = typeof msg.slot === 'number'
            ? msg.slot
            : this.room?.players?.find(p => p.id === msg.to)?.slot;
          if (typeof peerSlot === 'number' && peerSlot >= 0) this.rb.markPeerSynced(peerSlot);
          this.net.sendRbSync(msg.to, sync);
        }
      },
      onRbSync: msg => {
        if (this.rb && msg.sync) {
          this.rb.applySync(msg.sync);
          this._updateLiveBadge();
        }
      },
      onError: msg => this.onError(msg),
      onClose: () => this.onDisconnect(),
    });
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.rb && this.room?.phase === 'play' && this.room?.hostId !== this.net.clientId) {
          this.net.sendRbSyncReq();
        }
      });
    }
  }

  _transportLabel(sum = this.transportSummary) {
    if (!sum || sum.total === 0) return 'WebRTC P2P + GGPO';
    if (sum.p2p === sum.total) return 'Direct P2P UDP · Low-Latency';
    if (sum.p2p > 0) return `P2P ${sum.p2p}/${sum.total} + Binary WS`;
    return 'Binary WS Relay (P2P connecting)';
  }

  _clearLiveHud() {
    if (this._hudEl?.remove) this._hudEl.remove();
    this._hudEl = null;
  }

  _ensureLiveHud() {
    if (typeof document === 'undefined' || !this.ui?.appendChild) return;
    if (this._hudEl && this._hudEl.parentNode === this.ui) return;
    const el = document.createElement('div');
    el.id = 'net-hud';
    el.className = 'net-hud';
    el.innerHTML = `<div class="net-hud-pill" id="net-hud-status"></div>
      <div class="net-emote-strip" id="net-emote-strip">${EMOTES.map((e, i) => `<button type="button" data-em="${e.id}" title="${e.text} (${i + 1})">${e.icon}</button>`).join('')}</div>`;
    el.querySelectorAll('[data-em]').forEach(btn => {
      btn.onclick = ev => {
        ev.stopPropagation();
        this.net.sendEmote(btn.dataset.em);
      };
    });
    this.ui.appendChild(el);
    this._hudEl = el;
    this._updateLiveBadge();
  }

  _updateLiveBadge() {
    const pill = this._hudEl?.querySelector?.('#net-hud-status');
    if (!pill) return;
    if (this.rb?.waitingForGo) {
      pill.className = 'net-hud-pill warn';
      pill.textContent = 'Syncing players…';
      return;
    }
    const rtt = typeof this.net.rtt === 'number' ? this.net.rtt : null;
    const sum = this.transportSummary;
    const modeTxt = sum.total === 0 ? 'Solo Online' : (sum.p2p === sum.total ? 'P2P UDP' : sum.p2p > 0 ? `P2P ${sum.p2p}/${sum.total}` : 'Binary WS');
    const delayTxt = this.rb ? ` · ${this.rb.inputDelay}f` : '';
    const specTxt = this.net.spectator ? '👁 SPECTATING · ' : '';
    const pingTxt = rtt !== null ? ` · ${rtt}ms` : '';
    const cls = rtt === null || rtt <= 90 ? 'good' : (rtt <= 180 ? 'warn' : 'bad');
    pill.className = `net-hud-pill ${cls}`;
    pill.textContent = `${specTxt}${modeTxt}${pingTxt}${delayTxt}`;
  }

  onEmote(msg) {
    const em = EMOTE_BY_ID.get(msg?.id);
    if (!em) return;
    const a = this.app;
    a.audio.play('ui');
    if (a.state === 'play' && a.renderer?.addEmote && typeof msg.slot === 'number' && msg.slot >= 0) {
      a.renderer.addEmote(msg.slot, `${em.icon} ${em.text}`);
    } else {
      const col = (typeof msg.slot === 'number' && TEAM[msg.slot]?.light) || '#5eead4';
      a.toast(`${msg.name || 'Wizard'}: ${em.icon} ${em.text}`, col);
    }
  }

  _resetMatchState() {
    if (this._rbGoFallback) { clearTimeout(this._rbGoFallback); this._rbGoFallback = null; }
    this._clearLiveHud();
    this.rb = null;
    this._rbEndSent = false;
    this.snapBuf = [];
    this.renderServerMs = null;
  }

  _leaveAndReset() {
    this.localPaused = false;
    this._resetMatchState();
    this.mesh.closeAll();
    this.net.leaveRoom();
    this.room = null;
    this.app.netActive = false;
  }

  get active() {
    return !!this.net.roomCode;
  }

  defaultName() {
    return this.app.save.onlineName || 'Wizard';
  }

  defaultServer() {
    const saved = typeof this.app.save.onlineServer === 'string' ? this.app.save.onlineServer.trim() : '';
    return saved || DEFAULT_ONLINE_SERVER || '';
  }

  saveServer(raw) {
    const clean = String(raw || '').trim().slice(0, 160);
    this.app.save.onlineServer = clean;
    this.app.persist();
    return clean;
  }

  saveName(raw) {
    const clean = String(raw || '').replace(/[\r\n\t<>]/g, '').trim().slice(0, 14);
    if (clean) {
      this.app.save.onlineName = clean;
      this.app.persist();
    }
    return clean || 'Wizard';
  }

  inviteUrl(code) {
    const remoteOrigin = resolveHttpOrigin(this.defaultServer());
    if (remoteOrigin) return `${remoteOrigin}/?room=${code}`;
    const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isLocalHost || !this.net.lanUrls?.length) {
      return `${location.origin}${location.pathname}?room=${code}`;
    }
    return `${this.net.lanUrls[0]}/?room=${code}`;
  }

  openMenu({ code = '', error = '', autoJoin = false } = {}) {
    const a = this.app;
    a._clearLifeEx?.();
    a.classic?.close();
    a.game = null;
    a.run = null;
    a.netActive = false;
    a.paused = false;
    a.orbit = true;
    a.audio.stopMusic();
    this.localPaused = false;
    this._resetMatchState();
    this.mesh.closeAll();
    this.error = error;
    if (code) this.prefillCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

    let rejoin = null;
    try { rejoin = JSON.parse(sessionStorage.getItem('fracas_rejoin') || 'null'); } catch {}

    const nameVal = esc(this.defaultName());
    const srvVal = esc(this.defaultServer());
    const codeVal = esc(this.prefillCode);
    const isDesktop = !!(typeof window !== 'undefined' && window.fracasDesktop?.isDesktop);
    const rejoinHtml = rejoin?.code && rejoin?.token
      ? `<button class="net-btn teal" id="net-rejoin" type="button">Rejoin ${esc(rejoin.code)}</button>`
      : '';

    this.ui.innerHTML = `<div class="screen"><div class="card">
      <div class="brand-pill"><span class="dot"></span>${isDesktop ? 'FRACAS 2027 · PC EDITION' : 'FRACAS 2027'}</div>
      <div class="heading"><h2>Play Online</h2></div>
      <p class="hint">Play Story Co-op or Battle with up to 4 friends over the Internet or LAN.</p>
      <div class="net-col">
        <div class="net-row">
          <input class="net-inp" id="net-name" maxlength="14" placeholder="Your wizard name" value="${nameVal}">
        </div>
        <div class="net-row">
          <input class="net-inp" id="net-server" maxlength="160" placeholder="Online Server URL or Friend IP (blank = Built-in LAN)" value="${srvVal}" style="font-size:13px">
          <button class="net-btn" id="net-lan-btn" type="button" title="Use Built-in Local / LAN Server">LAN</button>
        </div>
        <div class="net-row">
          <button class="net-btn pri" id="net-host" type="button" style="flex:1">Create Room (Host)</button>
          ${rejoinHtml}
        </div>
        <div class="net-row">
          <input class="net-inp code" id="net-code" maxlength="6" placeholder="CODE" value="${codeVal}">
          <button class="net-btn" id="net-join" type="button" style="flex:1">Join Room</button>
        </div>
        <div class="net-err" id="net-err">${esc(this.error)}</div>
      </div>
      <button class="net-btn" id="net-back" type="button" style="width:100%">Back to Title</button>
    </div>
    <div class="footer"><span><kbd>Esc</kbd>Back to Title</span></div></div>`;
    a.state = 'onlineMenu';

    const nameEl = this.ui.querySelector('#net-name');
    const srvEl = this.ui.querySelector('#net-server');
    const codeEl = this.ui.querySelector('#net-code');
    const errEl = this.ui.querySelector('#net-err');
    const setErr = txt => { if (errEl) errEl.textContent = txt || ''; };

    this.ui.querySelector('#net-lan-btn').onclick = () => {
      a.audio.play('ui');
      if (srvEl) srvEl.value = '';
      this.saveServer('');
      setErr('Using built-in Local / LAN server');
    };

    const goBack = () => {
      a.audio.play('ui');
      this.net.disconnect();
      a.title();
    };

    a.menuUpdate = () => {
      if (a.input.pressed.has('Escape')) goBack();
    };

    const doConnect = async fn => {
      a.audio.init();
      const targetSrv = this.saveServer(srvEl?.value);
      setErr(targetSrv ? `Connecting to ${targetSrv}…` : 'Connecting…');
      try {
        await this.net.connect(targetSrv);
        fn(this.saveName(nameEl?.value));
      } catch (err) {
        setErr(err?.message || 'Connection failed');
      }
    };

    this.ui.querySelector('#net-host').onclick = () => {
      a.audio.play('select');
      doConnect(nm => this.net.hostRoom(nm));
    };

    const submitJoin = () => {
      const c = (codeEl?.value || '').trim().toUpperCase();
      if (!c) { setErr('Enter a room code first'); return; }
      this.prefillCode = c;
      a.audio.play('select');
      doConnect(nm => this.net.joinRoom(c, nm));
    };
    this.ui.querySelector('#net-join').onclick = submitJoin;
    codeEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitJoin();
      else if (e.key === 'Escape') goBack();
    });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Escape') goBack(); });

    const rjBtn = this.ui.querySelector('#net-rejoin');
    if (rjBtn && rejoin) {
      rjBtn.onclick = () => {
        a.audio.play('select');
        doConnect(nm => this.net.joinRoom(rejoin.code, nm, rejoin.token));
      };
    }

    this.ui.querySelector('#net-back').onclick = goBack;

    if (autoJoin && this.prefillCode) {
      doConnect(nm => this.net.joinRoom(this.prefillCode, nm));
    }
  }

  renderLobby(room) {
    const a = this.app;
    a._clearLifeEx?.();
    if (a.renderer) a.renderer.lifeEx = null;
    a.classic?.close();
    a.game = null;
    a.run = null;
    a.netActive = false;
    a.paused = false;
    a.orbit = true;
    a.audio.stopMusic();
    this.localPaused = false;
    this._resetMatchState();

    const isHost = room.hostId === this.net.clientId;
    const me = room.players.find(p => p.id === this.net.clientId);
    const inv = this.inviteUrl(room.code);
    const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const bySlot = new Map(room.players.map(p => [p.slot, p]));

    const bots = room.cfg?.bots || {};
    const slotsHtml = [0, 1, 2, 3].map(s => {
      const tm = TEAM[s];
      const pl = bySlot.get(s);
      if (!pl) {
        const botDiff = bots[s];
        if (botDiff) {
          const diffLbl = botDiff === 'master' ? 'Master' : botDiff === 'easy' ? 'Easy' : 'Normal';
          return `<div class="net-slot bot" data-slot="${s}" style="--c:${tm.color}">
            <div class="orb" style="width:32px;height:32px;opacity:.85"></div>
            <div class="wnm">${tm.name}</div>
            <div class="pnm">🤖 AI Bot (${diffLbl})</div>
            <div class="meta">${isHost ? 'Click to cycle / remove' : 'AI Wizard'}</div>
            ${isHost ? `<button class="net-mini-btn" data-take="${s}" type="button">Take Slot</button>` : `<button class="net-mini-btn" data-take="${s}" type="button">Switch Here</button>`}
          </div>`;
        }
        return `<div class="net-slot open" data-slot="${s}" style="--c:${tm.color}">
          <div class="orb" style="width:32px;height:32px;opacity:.26;box-shadow:none"></div>
          <div class="wnm">${tm.name}</div>
          <div class="meta">Empty · Click to switch</div>
          ${isHost ? `<button class="net-mini-btn" data-bot="${s}" type="button">+ Add AI Bot</button>` : ''}
        </div>`;
      }
      const tags = [pl.isHost ? 'Host' : (pl.ready ? 'Ready ✓' : 'Waiting')];
      if (pl.id === this.net.clientId) tags.push('You');
      if (typeof pl.pingMs === 'number') tags.push(`${pl.pingMs}ms`);
      return `<div class="net-slot on" style="--c:${tm.color}">
        <div class="orb" style="width:32px;height:32px"></div>
        <div class="wnm">${tm.name}</div>
        <div class="pnm">${esc(pl.name)}</div>
        <div class="meta">${tags.join(' · ')}</div>
      </div>`;
    }).join('');

    const c = room.cfg;
    const mut = c.mutators || { friendlyFire: true, fuseScale: 1, speedScale: 1, startMax: false, suddenDeath: 'normal' };
    const delayMode = c.delayMode ?? 'auto';
    const isBattle = c.mode === 'battle';
    const need = isBattle ? 2 : 1;
    const totalWizards = room.players.filter(p => p.connected).length + Object.keys(bots).filter(k => !bySlot.has(Number(k))).length;
    const canLaunch = totalWizards >= need;
    const fuseLabel = mut.fuseScale <= 0.5 ? 'Chaos (1.9s)' : mut.fuseScale < 0.9 ? 'Quick (2.7s)' : 'Classic';
    const spdLabel = mut.speedScale >= 1.4 ? 'Turbo 1.5×' : mut.speedScale > 1.1 ? 'Fast 1.25×' : 'Classic 1×';
    const delayLabel = delayMode === 'auto' ? 'Auto (Best)' : `${delayMode}f (${Math.round(delayMode * 16.7)}ms)`;

    const activeMutPills = [];
    if (!isBattle && mut.friendlyFire === false) activeMutPills.push('No Friendly Fire');
    if (mut.startMax) activeMutPills.push('Start MAX (5+5)');
    if (mut.fuseScale !== 1) activeMutPills.push(`Fuse: ${fuseLabel}`);
    if (mut.speedScale !== 1) activeMutPills.push(`Speed: ${spdLabel}`);
    if (isBattle && mut.suddenDeath === 'fast') activeMutPills.push('Fast Sudden Death');
    if (delayMode !== 'auto') activeMutPills.push(`Delay: ${delayMode}f`);

    const cfgHtml = isHost ? `
      <div class="net-cfg-grid">
        <div class="net-cfg-card">
          <div class="net-sec-title">MATCH SETUP</div>
          <div class="net-col" style="gap:10px">
            <div class="net-row" style="justify-content:space-between">
              <span class="net-lbl">Game Mode</span>
              <div class="net-seg">
                <button class="net-btn ${!isBattle ? 'pri' : ''}" id="cfg-normal" type="button">Story Co-op</button>
                <button class="net-btn ${isBattle ? 'pri' : ''}" id="cfg-battle" type="button">Battle</button>
              </div>
            </div>
            ${!isBattle ? `
              <div class="net-row" style="justify-content:space-between">
                <span class="net-lbl">Start Level</span>
                <div class="net-row" style="width:auto;gap:6px">
                  <button class="net-btn sq" id="cfg-lvl-dn" type="button">‹</button>
                  <span class="net-val-pill">${String(c.level).padStart(2, '0')} / ${a.data.normal.length}</span>
                  <button class="net-btn sq" id="cfg-lvl-up" type="button">›</button>
                </div>
              </div>
              <div class="net-row" style="justify-content:space-between">
                <span class="net-lbl">Password</span>
                <div class="net-row" style="width:auto;gap:6px">
                  <input class="net-inp pw-mini" id="cfg-pw" maxlength="10" placeholder="CODE">
                  <button class="net-btn" id="cfg-pw-go" type="button">Apply</button>
                </div>
              </div>
            ` : `
              <div class="net-row" style="justify-content:space-between">
                <span class="net-lbl">Arena</span>
                <div class="net-row" style="width:auto;gap:6px">
                  <button class="net-btn sq" id="cfg-ar-dn" type="button">‹</button>
                  <span class="net-val-pill">${String(c.arena + 1).padStart(2, '0')} / ${a.data.battle.length}</span>
                  <button class="net-btn sq" id="cfg-ar-up" type="button">›</button>
                </div>
              </div>
              <div class="net-row" style="justify-content:space-between">
                <span class="net-lbl">First to <b style="color:var(--gold)">${c.wins}</b></span>
                <div class="net-row" style="width:auto;gap:6px">
                  <button class="net-btn sq" id="cfg-w-dn" type="button">−</button>
                  <button class="net-btn sq" id="cfg-w-up" type="button">+</button>
                  <button class="net-btn ${c.random ? 'teal' : ''}" id="cfg-rand" type="button">Random: ${c.random ? 'On' : 'Off'}</button>
                </div>
              </div>
            `}
          </div>
        </div>
        <div class="net-cfg-card">
          <div class="net-sec-title">RULES &amp; NETCODE</div>
          <div class="net-mut-grid">
            ${!isBattle
              ? `<button class="net-btn ${mut.friendlyFire === false ? 'teal' : ''}" id="mut-ff" type="button">Friendly Fire: <b>${mut.friendlyFire === false ? 'Off' : 'On'}</b></button>`
              : `<button class="net-btn ${mut.suddenDeath === 'fast' ? 'teal' : ''}" id="mut-sd" type="button">Sudden Death: <b>${mut.suddenDeath === 'fast' ? 'Fast' : 'Normal'}</b></button>`}
            <button class="net-btn ${mut.startMax ? 'teal' : ''}" id="mut-max" type="button">Start MAX: <b>${mut.startMax ? 'On' : 'Off'}</b></button>
            <button class="net-btn ${mut.fuseScale !== 1 ? 'teal' : ''}" id="mut-fuse" type="button">Fuse: <b>${fuseLabel}</b></button>
            <button class="net-btn ${mut.speedScale !== 1 ? 'teal' : ''}" id="mut-spd" type="button">Speed: <b>${spdLabel}</b></button>
            <button class="net-btn ${delayMode !== 'auto' ? 'teal' : ''}" id="cfg-delay" type="button" style="grid-column:1/-1">Net Input Delay: <b>${delayLabel}</b></button>
          </div>
        </div>
      </div>
    ` : `
      <div class="net-cfg-card" style="text-align:center">
        <div class="net-sec-title" style="justify-content:center">MATCH CONFIGURATION</div>
        <div style="font:700 17px var(--font-disp);color:var(--gold);margin-top:2px">
          ${isBattle ? `Battle Mode · Arena ${c.arena + 1}${c.random ? ' (Random)' : ''} · First to ${c.wins}` : `Story Co-op · Level ${c.level}`}
        </div>
        ${activeMutPills.length ? `<div class="net-mut-pills">${activeMutPills.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="hint" style="margin-top:6px">Waiting for Host to launch the match…</div>
      </div>
    `;

    const isRemoteSrv = !!this.defaultServer();
    const isDesktop = !!(typeof window !== 'undefined' && window.fracasDesktop?.isDesktop);
    const tunnelNote = (!isRemoteSrv && isLocalHost)
      ? `<div class="net-note">${isDesktop
          ? `Wi-Fi / LAN address: <code>${esc((this.net.lanUrls?.[0] || '').replace(/^https?:\/\//, '') || `localhost:${location.port || 8128}`)}</code> · Friends on another network? Paste a Cloud Server URL in Play Online (see <code>DEPLOY_ONLINE_SERVER.md</code>).`
          : `Same Wi-Fi link above. For friends on another network, run <code>ngrok http ${location.port || 8128}</code> and send them that link + <code>?room=${esc(room.code)}</code>.`}</div>`
      : '';

    this.ui.innerHTML = `<div class="screen ultra"><div class="card lobby-card">
      <div class="lobby-head">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="brand-pill"><span class="dot"></span>LOBBY</span>
          <h2>Online Room</h2>
        </div>
        <span id="net-p2p-badge" class="status-pill">${esc(this._transportLabel())}</span>
      </div>
      <div class="net-codebox">
        <div>
          <div class="net-micro-lbl">ROOM CODE</div>
          <div class="net-code">${esc(room.code)}</div>
        </div>
        <div style="flex:1;min-width:180px">
          <div class="net-micro-lbl">INVITE LINK</div>
          <div class="net-url" id="net-inv">${esc(inv)}</div>
        </div>
        <button class="net-btn teal" id="net-copy" type="button">Copy Invite</button>
      </div>
      ${tunnelNote}
      <div class="net-slots">${slotsHtml}</div>
      ${cfgHtml}
      ${(room.note || this.error) ? `<div class="net-err" style="color:${room.noteErr ? 'var(--danger)' : 'var(--accent)'}">${esc(room.note || this.error)}</div>` : ''}
      <div class="lobby-dock">
        <button class="net-btn" id="net-leave" type="button">‹ Leave</button>
        <div class="net-emote-lobby">${EMOTES.map(e => `<button class="net-btn em-chip" data-em="${e.id}" type="button" title="${e.text}">${e.icon}</button>`).join('')}</div>
        ${isHost
          ? `<button class="net-btn pri launch-cta" id="net-start" type="button" ${canLaunch ? '' : 'disabled'}>${canLaunch ? 'Launch Match ›' : 'Need 2+ Wizards'}</button>`
          : `<button class="net-btn ${me?.ready ? 'teal' : 'pri'} launch-cta" id="net-ready" type="button">${me?.ready ? 'Ready ✓' : 'Mark Ready'}</button>`}
      </div>
    </div></div>`;

    a.state = 'onlineLobby';
    a.menuUpdate = null;

    this.ui.querySelector('#net-copy').onclick = async () => {
      a.audio.play('ui');
      try { await navigator.clipboard?.writeText(inv); a.toast('Invite link copied!', '#5eead4'); }
      catch { a.toast('Select and copy the invite link above', '#ffcf5a'); }
    };

    this.ui.querySelectorAll('.net-emote-lobby [data-em]').forEach(el => {
      el.onclick = () => this.net.sendEmote(el.dataset.em);
    });

    this.ui.querySelectorAll('[data-bot]').forEach(el => {
      el.onclick = ev => { ev.stopPropagation(); a.audio.play('ui'); this.net.toggleBot(+el.dataset.bot); };
    });
    this.ui.querySelectorAll('[data-take]').forEach(el => {
      el.onclick = ev => { ev.stopPropagation(); a.audio.play('ui'); this.net.switchSlot(+el.dataset.take); };
    });
    this.ui.querySelectorAll('.net-slot.bot').forEach(el => {
      if (isHost) el.onclick = () => { a.audio.play('ui'); this.net.toggleBot(+el.dataset.slot); };
    });
    this.ui.querySelectorAll('.net-slot.open').forEach(el => {
      el.onclick = () => { a.audio.play('ui'); this.net.switchSlot(+el.dataset.slot); };
    });

    this.ui.querySelector('#net-leave').onclick = () => {
      a.audio.play('ui');
      try { sessionStorage.removeItem('fracas_rejoin'); } catch {}
      this._leaveAndReset();
      this.openMenu();
    };

    if (isHost) {
      this.ui.querySelector('#cfg-normal').onclick = () => { a.audio.play('ui'); this.net.setCfg({ mode: 'normal' }); };
      this.ui.querySelector('#cfg-battle').onclick = () => { a.audio.play('ui'); this.net.setCfg({ mode: 'battle' }); };
      if (!isBattle) {
        const nLv = a.data.normal.length;
        this.ui.querySelector('#cfg-lvl-dn').onclick = () => { a.audio.play('ui'); this.net.setCfg({ level: ((c.level - 2 + nLv) % nLv) + 1 }); };
        this.ui.querySelector('#cfg-lvl-up').onclick = () => { a.audio.play('ui'); this.net.setCfg({ level: (c.level % nLv) + 1 }); };
        const pwIn = this.ui.querySelector('#cfg-pw');
        const applyPw = () => { if (pwIn?.value.trim()) { a.audio.play('ui'); this.net.setCfg({ password: pwIn.value.trim() }); } };
        this.ui.querySelector('#cfg-pw-go').onclick = applyPw;
        pwIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyPw(); });
      } else {
        const nAr = a.data.battle.length;
        this.ui.querySelector('#cfg-ar-dn').onclick = () => { a.audio.play('ui'); this.net.setCfg({ arena: (c.arena - 1 + nAr) % nAr }); };
        this.ui.querySelector('#cfg-ar-up').onclick = () => { a.audio.play('ui'); this.net.setCfg({ arena: (c.arena + 1) % nAr }); };
        this.ui.querySelector('#cfg-w-dn').onclick = () => { a.audio.play('ui'); this.net.setCfg({ wins: Math.max(1, c.wins - 1) }); };
        this.ui.querySelector('#cfg-w-up').onclick = () => { a.audio.play('ui'); this.net.setCfg({ wins: Math.min(9, c.wins + 1) }); };
        this.ui.querySelector('#cfg-rand').onclick = () => { a.audio.play('ui'); this.net.setCfg({ random: !c.random }); };
      }
      const ffBtn = this.ui.querySelector('#mut-ff');
      if (ffBtn) ffBtn.onclick = () => { a.audio.play('ui'); this.net.setCfg({ mutators: { friendlyFire: mut.friendlyFire === false } }); };
      const sdBtn = this.ui.querySelector('#mut-sd');
      if (sdBtn) sdBtn.onclick = () => { a.audio.play('ui'); this.net.setCfg({ mutators: { suddenDeath: mut.suddenDeath === 'fast' ? 'normal' : 'fast' } }); };
      const maxBtn = this.ui.querySelector('#mut-max');
      if (maxBtn) maxBtn.onclick = () => { a.audio.play('ui'); this.net.setCfg({ mutators: { startMax: !mut.startMax } }); };
      const fuseBtn = this.ui.querySelector('#mut-fuse');
      if (fuseBtn) fuseBtn.onclick = () => {
        a.audio.play('ui');
        const nextFuse = mut.fuseScale === 1 ? 0.65 : (mut.fuseScale === 0.65 ? 0.45 : 1);
        this.net.setCfg({ mutators: { fuseScale: nextFuse } });
      };
      const spdBtn = this.ui.querySelector('#mut-spd');
      if (spdBtn) spdBtn.onclick = () => {
        a.audio.play('ui');
        const nextSpd = mut.speedScale === 1 ? 1.25 : (mut.speedScale === 1.25 ? 1.5 : 1);
        this.net.setCfg({ mutators: { speedScale: nextSpd } });
      };
      const delBtn = this.ui.querySelector('#cfg-delay');
      if (delBtn) delBtn.onclick = () => {
        a.audio.play('ui');
        const seq = ['auto', 0, 1, 2, 3];
        const nextDel = seq[(seq.indexOf(delayMode) + 1) % seq.length];
        this.net.setCfg({ delayMode: nextDel });
      };
      const startBtn = this.ui.querySelector('#net-start');
      if (startBtn) startBtn.onclick = () => { a.audio.play('select'); this.net.startMatch(); };
    } else {
      const readyBtn = this.ui.querySelector('#net-ready');
      if (readyBtn) readyBtn.onclick = () => { a.audio.play('ui'); this.net.setReady(!me?.ready); };
    }
  }

  onLevelStart(msg) {
    const a = this.app;
    a._clearLifeEx?.();
    if (a.renderer) a.renderer.lifeEx = null;
    a.classic?.close();
    this.localPaused = false;
    a.netActive = true;
    a.paused = false;
    if (this.room) this.room.phase = 'play';
    a.cheats = msg.cheats || { rude: false, psycho: false };
    a.audio.rude = !!a.cheats.rude;
    a.run = { mode: msg.mode, level: msg.level, round: msg.round, slots: msg.slots, carry: msg.carry || {} };
    const lv = msg.mode === 'battle'
      ? (a.data.battle[msg.arenaIdx] || a.data.battle[0])
      : a.data.normal[msg.level - 1];
    this._resetMatchState();
    this.mesh.setSelfId(this.net.clientId);
    if (this.room?.players) this.mesh.syncPeers(this.room.players);

    if (msg.rollback) {
      const bots = msg.bots || {};
      const botSlots = Object.keys(bots).map(Number);
      let inputDelay = 0;
      if (!msg.spectator) {
        if (typeof msg.delayMode === 'number') {
          inputDelay = msg.delayMode;
        } else {
          let maxRtt = typeof this.net.rtt === 'number' ? this.net.rtt : 0;
          for (const pl of this.room?.players || []) {
            if (typeof pl.pingMs === 'number' && pl.pingMs > maxRtt) maxRtt = pl.pingMs;
          }
          inputDelay = recommendInputDelay(maxRtt);
        }
      }
      a.game = new Game(lv, {
        mode: msg.mode,
        players: msg.slots,
        bots,
        mutators: msg.mutators,
        carry: msg.carry,
        cheats: a.cheats,
        seed: msg.seed,
      });
      this.rb = new RollbackSession(a.game, {
        localSlot: msg.spectator ? -1 : this.net.slot,
        spectator: !!msg.spectator,
        matchSeq: msg.matchSeq ?? 0,
        slots: msg.slots,
        botSlots,
        inputDelay,
        waitForGo: !!msg.waitForGo,
        sendPacket: (bytes, reliable) => {
          this.mesh.sendAll(bytes, reliable, needRelayIds => {
            let mask = 0;
            for (const tid of needRelayIds) {
              const peer = this.mesh.peers.get(tid);
              if (peer && typeof peer.slot === 'number' && peer.slot >= 0 && peer.slot < 4) mask |= (1 << peer.slot);
              else mask = 0xff;
            }
            if (this.room?.spectators?.length) mask = 0xff;
            if (mask && !this.net.sendPeerInputBinary(mask, bytes)) {
              this.net.sendPeerInput(needRelayIds, bytesToB64(bytes));
            }
          });
        },
        onEvents: ev => {
          a.renderer.handle(ev);
          a.onEvents(ev);
        },
        onNeedSync: () => {
          if (this.room?.hostId !== this.net.clientId) this.net.sendRbSyncReq();
        },
        onDesync: () => {
          if (this.room?.hostId !== this.net.clientId) this.net.sendRbSyncReq();
        },
      });
    } else {
      a.game = createClientGame(lv, { mode: msg.mode, players: msg.slots, carry: msg.carry, cheats: a.cheats });
    }
    a.renderer.psycho = !!a.cheats.psycho;
    a.renderer.setGame(a.game);
    if (this.rb && msg.waitForGo) {
      this.net.sendRbReady(msg.matchSeq ?? 0);
      const seq = msg.matchSeq ?? 0;
      this._rbGoFallback = setTimeout(() => {
        if (this.rb && this.rb.matchSeq === seq && this.rb.waitingForGo) {
          this.rb.releaseGo();
          this._updateLiveBadge();
        }
      }, 3200);
    }
    a.orbit = false;
    a.acc = 0;
    a.netSnapAge = 0;
    this.pendingInputs = [];
    this.predAcc = 0;
    this.clientTick = 0;
    this.smoothOffX = 0;
    this.smoothOffY = 0;
    this._predBombId = 0;
    this._lastPredBombAt = 0;
    this._lastPredSpeedAt = 0;
    this._lastAckSeq = 0;
    this._lastAckX = 0;
    this._lastAckY = 0;
    this._lastRecvMs = 0;
    this._jitterEmaMs = 0;
    this._lastSnapSt = -1;
    const lp = a.game?.players?.find(p => p.slot === this.net.slot);
    if (lp && !this.rb) { lp._predX = lp.fx; lp._predY = lp.fy; lp._predLastDir = -1; lp._predDir = lp.dir; lp._predMoving = false; }
    a.state = 'play';
    a.menuUpdate = null;
    this.ui.innerHTML = '';
    a.syncMusic();
    a.audio.play('getReady');
    a.buildHud();
    this._ensureLiveHud();
  }

  _pushSnapFrame(snap, nowMs) {
    const st = typeof snap.st === 'number' ? snap.st : Math.round((snap.time || 0) * 1000);
    if (st < this._lastSnapSt) return;
    if (this._lastRecvMs > 0 && st > this._lastSnapSt) {
      const dtRecv = nowMs - this._lastRecvMs;
      const dtSrv = st - this._lastSnapSt;
      const jitter = Math.abs(dtRecv - dtSrv);
      const rate = jitter > this._jitterEmaMs ? 0.35 : 0.05;
      this._jitterEmaMs += (jitter - this._jitterEmaMs) * rate;
      const targetDelay = Math.max(28, Math.min(130, (SNAP_TICKS * TICK * 1000) * 0.9 + this._jitterEmaMs * 1.6));
      const dRate = targetDelay > this.interpDelayMs ? 0.25 : 0.03;
      this.interpDelayMs += (targetDelay - this.interpDelayMs) * dRate;
    }
    this._lastRecvMs = nowMs;
    this._lastSnapSt = st;

    const players = new Map();
    for (const sp of snap.players || []) {
      const [slot, , x, y, dir, flags, , , , , , , , , , , , , , tpPhase] = sp;
      players.set(slot, { x, y, dir, moving: !!(flags & 1), alive: !!(flags & 2), tpPhase });
    }
    const monsters = new Map();
    for (const sm of snap.monsters || []) {
      const [id, , x, y, dir, flags, , , , , , tpPhase] = sm;
      monsters.set(id, { x, y, dir, moving: !!(flags & 1), alive: !!(flags & 2), tpPhase });
    }
    const bombs = new Map();
    for (const sb of snap.bombs || []) {
      bombs.set(sb[0], { rx: sb[11] ?? sb[1], ry: sb[12] ?? sb[2] });
    }
    const projs = new Map();
    for (const sq of snap.projs || []) {
      projs.set(sq[0], { x: sq[1], y: sq[2], d: sq[3], spell: sq[4], moving: true });
    }

    const frame = { st, recvMs: nowMs, players, monsters, bombs, projs };
    if (this.snapBuf.length && this.snapBuf[this.snapBuf.length - 1].st === st) {
      this.snapBuf[this.snapBuf.length - 1] = frame;
    } else {
      this.snapBuf.push(frame);
      if (this.snapBuf.length > 24) this.snapBuf.shift();
    }
  }

  sampleSnapBuffer(dt = 0) {
    const g = this.app.game;
    const buf = this.snapBuf;
    if (!g || !buf.length) return;
    const nowMs = performance.now();
    const latest = buf[buf.length - 1];
    const estServerMs = latest.st + Math.min(250, Math.max(0, nowMs - latest.recvMs));
    const targetServerMs = estServerMs - this.interpDelayMs;

    if (this.renderServerMs === null) {
      this.renderServerMs = latest.st;
    } else if (dt > 0) {
      this.renderServerMs += dt * 1000;
      const err = targetServerMs - this.renderServerMs;
      if (Math.abs(err) > 220) {
        this.renderServerMs = targetServerMs;
      } else {
        this.renderServerMs += err * Math.min(1, dt * 3.5);
      }
    }

    while (buf.length > 2 && buf[1].st <= this.renderServerMs) {
      buf.shift();
    }

    const a = buf[0];
    const b = buf.length > 1 ? buf[1] : null;
    if (b && this.renderServerMs >= a.st) {
      if (this.renderServerMs <= b.st) {
        const alpha = (this.renderServerMs - a.st) / Math.max(1, b.st - a.st);
        this._applySampledEntities(g, a, b, 'interp', alpha);
        return;
      }
      const refB = buf[buf.length - 1];
      const refA = buf.length > 1 ? buf[buf.length - 2] : null;
      const overMs = Math.min(110, Math.max(0, this.renderServerMs - refB.st));
      if (refA && overMs > 0) {
        this._applySampledEntities(g, refA, refB, 'extrap', overMs / 1000);
        return;
      }
    }
    this._applySampledEntities(g, b || a, null, 'single', 0);
  }

  _applySampledEntities(g, fA, fB, mode, param) {
    const evalPos = (eA, eB, xKey, yKey, maxJump = 1.5, allowExtrap = true) => {
      if (mode === 'interp') {
        if (eA && eB) {
          if (Math.hypot(eB[xKey] - eA[xKey], eB[yKey] - eA[yKey]) > maxJump) {
            return { x: eB[xKey], y: eB[yKey], dir: eB.dir, moving: eB.moving };
          }
          return {
            x: eA[xKey] + (eB[xKey] - eA[xKey]) * param,
            y: eA[yKey] + (eB[yKey] - eA[yKey]) * param,
            dir: eB.dir,
            moving: eB.moving,
          };
        }
        const s = eB || eA;
        return s ? { x: s[xKey], y: s[yKey], dir: s.dir, moving: s.moving } : null;
      }
      if (mode === 'extrap') {
        const s = eB || eA;
        if (!s) return null;
        if (eB && eA && allowExtrap && eB.moving !== false) {
          const dtPair = Math.max(0.01, (fB.st - fA.st) / 1000);
          const dx = eB[xKey] - eA[xKey], dy = eB[yKey] - eA[yKey];
          if (Math.hypot(dx, dy) <= maxJump) {
            const ex = (dx / dtPair) * param, ey = (dy / dtPair) * param;
            const nx = eB[xKey] + ex, ny = eB[yKey] + ey;
            if (Math.hypot(ex, ey) <= 0.45 && !g.solid(Math.floor(nx), Math.floor(ny))) {
              return { x: nx, y: ny, dir: eB.dir, moving: eB.moving };
            }
          }
        }
        return { x: s[xKey], y: s[yKey], dir: s.dir, moving: s.moving };
      }
      return eA ? { x: eA[xKey], y: eA[yKey], dir: eA.dir, moving: eA.moving } : null;
    };

    for (const p of g.players) {
      if (p.slot === this.net.slot || !p.alive || p.tpPhase) continue;
      const res = evalPos(fA.players.get(p.slot), fB?.players.get(p.slot), 'x', 'y');
      if (!res) continue;
      p.fx = res.x; p.fy = res.y;
      p.px = res.x; p.py = res.y;
      if (res.dir >= 0) p.dir = res.dir;
      p._forceMoving = !!res.moving;
    }

    for (const m of g.monsters) {
      if (!m.alive || m.tpPhase) continue;
      const res = evalPos(fA.monsters.get(m.id), fB?.monsters.get(m.id), 'x', 'y');
      if (!res) continue;
      m.x = res.x; m.y = res.y;
      m.px = res.x; m.py = res.y;
      if (res.dir >= 0) m.dir = res.dir;
      m.moving = !!res.moving;
    }

    for (const b of g.bombs) {
      if (b._pred) continue;
      const res = evalPos(fA.bombs.get(b.id), fB?.bombs.get(b.id), 'rx', 'ry');
      if (!res) continue;
      b.rx = res.x; b.ry = res.y;
      b.prx = res.x; b.pry = res.y;
    }

    for (const pr of g.projs) {
      const res = evalPos(fA.projs.get(pr.id), fB?.projs.get(pr.id), 'x', 'y', 2.0, true);
      if (!res) continue;
      pr.x = res.x; pr.y = res.y;
      pr.px = res.x; pr.py = res.y;
    }
  }

  onSnap(snap) {
    const a = this.app;
    if (!a.game || !a.netActive) return;
    const g = a.game;
    if (this.rb) {
      if (this.room?.phase === 'lifeExchange' && Array.isArray(snap.players)) {
        for (const sp of snap.players) {
          const p = g.players.find(q => q.slot === sp[0]);
          if (p && typeof sp[6] === 'number') p.lives = sp[6];
        }
      }
      return;
    }
    const nowMs = performance.now();
    const wasInit = !!g._netInitialized;
    const localP = g.players.find(p => p.slot === this.net.slot);
    const visX = localP ? localP.fx : 0;
    const visY = localP ? localP.fy : 0;
    const wasAlive = localP ? localP.alive : false;

    this._pushSnapFrame(snap, nowMs);
    applySnapshot(g, snap, 1);
    a.netSnapAge = 0;

    if (localP) {
      if (this._lastPredSpeedAt && nowMs - this._lastPredSpeedAt < 600 && localP.power === 'foot') {
        localP.sprint = true;
      }
      const canPred = wasInit && wasAlive && localP.alive && !localP.out && !localP.tpPhase && localP.stun <= 0 && !localP.push && g.freeze <= 0 && (g.state === 'play' || g.state === 'clear');
      if (!canPred) {
        this.pendingInputs.length = 0;
        this.smoothOffX = 0;
        this.smoothOffY = 0;
        this._lastAckSeq = 0;
        localP._predX = localP.fx;
        localP._predY = localP.fy;
        localP._predLastDir = -1;
        localP._predDir = localP.dir;
        localP._predMoving = localP.moving;
        delete localP._forceMoving;
      } else {
        const ack = localP._netAck || 0;
        let ackEntry = null;
        while (this.pendingInputs.length && this.pendingInputs[0].seq <= ack) {
          const item = this.pendingInputs.shift();
          if (item.seq === ack) ackEntry = item;
        }
        const serverX = localP.fx, serverY = localP.fy;
        const ackAccepted = !!(ackEntry && Math.hypot(serverX - ackEntry.x, serverY - ackEntry.y) <= 0.15);
        const sameAckNoShift = !ackEntry && ack > 0 && ack === this._lastAckSeq &&
          Math.hypot(serverX - this._lastAckX, serverY - this._lastAckY) <= 0.05;
        if (ack > 0) {
          this._lastAckSeq = ack;
          this._lastAckX = serverX;
          this._lastAckY = serverY;
        }
        if ((ackAccepted || sameAckNoShift) && typeof localP._predX === 'number' && typeof localP._predY === 'number') {
          localP.fx = localP._predX + this.smoothOffX;
          localP.fy = localP._predY + this.smoothOffY;
          localP.px = localP.fx;
          localP.py = localP.fy;
          if (typeof localP._predDir === 'number' && localP._predDir >= 0) localP.dir = localP._predDir;
          localP._forceMoving = !!localP._predMoving;
        } else {
          localP.lastDir = localP.dir;
          for (let i = 0; i < this.pendingInputs.length; i++) {
            const item = this.pendingInputs[i];
            localP.input.dir = item.dir;
            localP.input.secDir = item.secDir ?? -1;
            g.movePlayer(localP, item.dt, true);
          }
          localP._predX = localP.fx;
          localP._predY = localP.fy;
          localP._predLastDir = localP.lastDir;
          localP._predDir = localP.dir;

          const dx = visX - localP._predX;
          const dy = visY - localP._predY;
          const dist = Math.hypot(dx, dy);
          if (dist > 1.5) {
            this.smoothOffX = 0;
            this.smoothOffY = 0;
          } else if (dist > 0.04) {
            this.smoothOffX = dx;
            this.smoothOffY = dy;
          } else {
            this.smoothOffX = 0;
            this.smoothOffY = 0;
          }
          localP.fx = localP._predX + this.smoothOffX;
          localP.fy = localP._predY + this.smoothOffY;
          localP.px = localP.fx;
          localP.py = localP.fy;
          localP._forceMoving = !!localP._predMoving;
        }
      }
    }

    this.sampleSnapBuffer(0);

    if (snap.events?.length) {
      a.renderer.handle(snap.events);
      const filtered = snap.events.filter(e => {
        if (e.p !== this.net.slot) return true;
        if (e.t === 'bomb' && nowMs - (this._lastPredBombAt || 0) < 600) {
          this._lastPredBombAt = 0;
          return false;
        }
        if (e.t === 'cast' && e.spell === 'speed' && nowMs - (this._lastPredSpeedAt || 0) < 600) {
          this._lastPredSpeedAt = 0;
          return false;
        }
        return true;
      });
      if (filtered.length) a.onEvents(filtered);
    }
  }

  onRoom(room) {
    this.room = room;
    this.error = '';
    const a = this.app;
    this.mesh.setSelfId(this.net.clientId);
    if (room.players) this.mesh.syncPeers(room.players);
    if (room.sound) a.audio.play(room.sound);

    switch (room.phase) {
      case 'lobby':
        this.renderLobby(room);
        break;
      case 'play':
        if (a.state === 'onlineServerPause' || a.state === 'onlineLifeEx' || a.state === 'levelEnd' || a.state === 'roundEnd' || a.state === 'gameOver') {
          a._clearLifeEx?.();
          if (a.renderer) a.renderer.lifeEx = null;
          this.ui.innerHTML = '';
          a.state = 'play';
          a.menuUpdate = null;
          a.buildHud();
          this._ensureLiveHud();
        }
        break;
      case 'paused':
        this.showServerPaused(room);
        break;
      case 'lifeExchange':
        this.showLifeExchange(room);
        break;
      case 'levelEnd':
      case 'gameOver':
      case 'victory':
      case 'roundEnd':
        this.showSummary(room);
        break;
    }
  }

  onError(msg) {
    this.error = msg?.message || 'Error';
    if (this.app.state === 'onlineMenu') {
      const el = this.ui.querySelector('#net-err');
      if (el) el.textContent = this.error;
    } else {
      this.app.toast(this.error, '#ff5c77');
    }
  }

  onDisconnect() {
    const a = this.app;
    const wasInRoom = !!this.room;
    const prevCode = this.room?.code || this.prefillCode;
    let rejoin = null;
    try { rejoin = JSON.parse(sessionStorage.getItem('fracas_rejoin') || 'null'); } catch {}

    this.room = null;
    this._resetMatchState();
    this.mesh.closeAll();
    a.netActive = false;
    a._clearLifeEx?.();
    if (a.renderer) a.renderer.lifeEx = null;

    if (wasInRoom && rejoin?.code && rejoin?.token && !this._reconnecting) {
      this._reconnecting = true;
      a.toast('Connection interrupted — reconnecting…', '#ffcf5a');
      setTimeout(async () => {
        try {
          await this.net.connect(this.defaultServer());
          this.net.joinRoom(rejoin.code, this.defaultName(), rejoin.token);
        } catch {
          this._reconnecting = false;
          this.openMenu({ code: prevCode, error: 'Connection to server lost — click Rejoin to retry' });
        }
      }, 900);
      return;
    }
    this._reconnecting = false;
    if (wasInRoom || a.state?.startsWith('online') || a.state === 'play') {
      this.openMenu({ code: prevCode, error: 'Connection to server lost' });
    }
  }

  _sampleRawInput() {
    const a = this.app;
    const inp = a.input;
    const r0 = inp.read('kb0');
    const r1 = inp.read('kb1');
    const rp = inp.pads.length ? inp.read('pad0') : { dir: -1, secDir: -1 };
    const rt = a.readTouch();

    let dir = -1, secDir = -1;
    if (rt.dir >= 0) { dir = rt.dir; secDir = rt.secDir ?? -1; }
    else if (rp.dir >= 0) { dir = rp.dir; secDir = rp.secDir ?? -1; }
    else if (r0.dir >= 0) { dir = r0.dir; secDir = r0.secDir ?? -1; }
    else if (r1.dir >= 0) { dir = r1.dir; secDir = r1.secDir ?? -1; }

    return {
      pauseReq: !!(r0.start || r1.start || rp.start || inp.pressed.has('Escape') || inp.pressed.has('KeyP')),
      dir,
      secDir,
      bomb: !!(r0.bomb || r1.bomb || rp.bomb || rt.bomb),
      power: !!(r0.power || r1.power || rp.power || rt.power),
      bombHeld: !!(r0.bombHeld || r1.bombHeld || rp.bombHeld || rt.bombHeld),
      powerHeld: !!(r0.powerHeld || r1.powerHeld || rp.powerHeld || rt.powerHeld),
    };
  }

  updateRollback(dt) {
    if (!this.rb || this.room?.phase !== 'play') return;
    // Quick emote hotkeys 1..6 during online play
    const pressed = this.app.input?.pressed;
    if (pressed && !this.localPaused) {
      for (const em of EMOTES) {
        if (pressed.has(em.key)) { this.net.sendEmote(em.id); break; }
      }
    }
    this._hudAcc += dt;
    if (this._hudAcc >= 0.5) {
      this._hudAcc = 0;
      this._updateLiveBadge();
    }
    let first = true;
    let firstRaw = null;
    this.rb.update(dt, () => {
      if (first) {
        first = false;
        firstRaw = this._sampleRawInput();
        if (firstRaw.pauseReq && !this.localPaused) {
          this.openPause();
          return NEUTRAL_INPUT;
        }
        if (this.localPaused || this.net.spectator) return NEUTRAL_INPUT;
        return firstRaw;
      }
      if (this.localPaused || this.net.spectator || !firstRaw || firstRaw.pauseReq) return NEUTRAL_INPUT;
      return {
        dir: firstRaw.dir,
        secDir: firstRaw.secDir,
        bomb: false,
        power: false,
        bombHeld: firstRaw.bombHeld,
        powerHeld: firstRaw.powerHeld,
      };
    });

    const g = this.app.game;
    if (g && this.room?.hostId === this.net.clientId && !this._rbEndSent) {
      const done =
        (g.state === 'won' && g.stateTime > 2.2) ||
        (g.state === 'lost' && g.stateTime > 2.4) ||
        (g.state === 'roundOver' && g.stateTime > 2.4);
      if (done) {
        this._rbEndSent = true;
        this.net.sendRbEnd(g.state, g.players.map(p => ({
          slot: p.slot,
          lives: p.lives,
          score: p.score,
          kills: p.kills,
          wins: p.wins,
          selfKills: p.selfKills || 0,
          spellsCast: p.spellsCast || 0,
          rocksBroken: p.rocksBroken || 0,
          out: !!p.out,
        })));
      }
    }
  }

  readLocalInput(dt = TICK) {
    const a = this.app;
    const raw = this._sampleRawInput();
    if (raw.pauseReq) {
      this.openPause();
      return;
    }
    const { dir, secDir, bomb, power, bombHeld, powerHeld } = raw;

    const g = a.game;
    const localP = g?.players?.find(p => p.slot === this.net.slot);
    if (!g || !localP) {
      this.net.sendInput({ dir, secDir, bomb, power, bombHeld, powerHeld });
      return;
    }
    if (g.freeze > 0 || !localP.alive || localP.out || localP.tpPhase || localP.stun > 0 || localP.push || (g.state !== 'play' && g.state !== 'clear')) {
      this.net.sendInput({ dir, secDir, bomb, power, bombHeld, powerHeld });
      this.predAcc = 0;
      this.pendingInputs.length = 0;
      delete localP._forceMoving;
      return;
    }

    if (localP._predX === undefined) {
      localP._predX = localP.fx;
      localP._predY = localP.fy;
      localP._predLastDir = localP.dir;
    }

    const bombActive = !!(bomb || bombHeld);
    const powerActive = !!(power || powerHeld);
    const suppressBomb = powerActive && localP.power && localP.power !== 'foot';
    if (powerActive && localP.power === 'foot' && !localP.sprint && localP.cooldown <= 0) {
      localP.sprint = true;
      a.audio.play('power', localP._predX);
      this._lastPredSpeedAt = performance.now();
    }

    const decay = Math.min(1, dt * 18);
    this.smoothOffX *= (1 - decay);
    this.smoothOffY *= (1 - decay);
    if (Math.hypot(this.smoothOffX, this.smoothOffY) < 0.002) {
      this.smoothOffX = 0;
      this.smoothOffY = 0;
    }

    localP.fx = localP._predX;
    localP.fy = localP._predY;
    localP.lastDir = localP._predLastDir ?? localP.dir;
    localP.input.dir = dir;
    localP.input.secDir = secDir;
    if (dt > 0) g.movePlayer(localP, dt, true);
    localP._predX = localP.fx;
    localP._predY = localP.fy;
    localP._predLastDir = localP.lastDir;
    localP._predDir = localP.dir;
    localP._predMoving = localP.moving;

    let predBomb = null;
    if (bombActive && !suppressBomb && localP.stun <= 0) {
      const bx = Math.floor(localP._predX), by = Math.floor(localP._predY);
      const mine = g.bombs.filter(b => b.owner === localP.slot).length;
      const ci = by * W + bx;
      if (mine < localP.bombsMax && !g.anyBombAt(bx, by) && !g.solid(bx, by) && !g.flames.has(ci)) {
        const f = g.feat[ci];
        const onVent = f?.k === 'vent';
        predBomb = {
          id: -(++this._predBombId),
          x: bx, y: by, cx: bx, cy: by,
          owner: localP.slot,
          range: onVent ? 1 : localP.range,
          fuse: localP.power === 'ignitor' ? 3600 / TICK_HZ : FUSE,
          age: 0,
          kind: 'fire',
          vent: onVent ? (f.g ?? 0) : -1,
          rx: bx, ry: by, prx: bx, pry: by,
          _pred: true,
          _predSeq: this.net._seq + 1,
          _predUntil: performance.now() + 500,
        };
        g.bombs.push(predBomb);
        a.audio.play(onVent ? 'bombVent' : 'bomb', bx);
        this._lastPredBombAt = performance.now();
      }
    }

    const prevSeq = this.net._seq;
    const seq = this.net.sendInput({
      dir, secDir, bomb, power, bombHeld, powerHeld,
      x: localP._predX, y: localP._predY, mov: localP._predMoving, faceDir: localP.dir,
      force: !!predBomb,
    });
    if (predBomb) predBomb._predSeq = seq;
    if (seq > prevSeq || dir >= 0 || localP._predMoving) {
      const entrySeq = seq > prevSeq ? seq : seq + 1;
      this.pendingInputs.push({ seq: entrySeq, x: localP._predX, y: localP._predY, dir, secDir, dt });
      if (this.pendingInputs.length > 180) this.pendingInputs.shift();
    }

    localP.fx = localP._predX + this.smoothOffX;
    localP.fy = localP._predY + this.smoothOffY;
    localP.px = localP.fx;
    localP.py = localP.fy;
    localP._forceMoving = !!localP._predMoving;
  }

  openPause() {
    const a = this.app;
    if (this.localPaused) return;
    this.localPaused = true;
    a.audio.play('pause');
    this.net.sendInput({ dir: -1, bomb: false, power: false, bombHeld: false, powerHeld: false });

    const isHost = this.room?.hostId === this.net.clientId;
    const resume = () => {
      this.localPaused = false;
      this.ui.innerHTML = '';
      if (this.room?.phase === 'paused') { this.showServerPaused(this.room); return; }
      a.buildHud();
      this._ensureLiveHud();
      a.state = 'play';
      a.menuUpdate = null;
    };

    const items = [{ label: 'Resume', ok: resume }];
    if (isHost) {
      items.push({ label: 'Pause Match for All', ok: () => { this.localPaused = false; this.net.setPaused(true); } });
      items.push({ label: a.run?.mode === 'battle' ? 'Restart Round' : 'Restart Level', ok: () => { this.localPaused = false; this.net.restartRound(); } });
    }
    items.push({ label: 'Options', ok: () => a.options(() => { this.localPaused = false; this.openPause(); }) });
    items.push({ label: 'Controls', ok: () => a.controls(() => { this.localPaused = false; this.openPause(); }) });
    if (isHost) items.push({ label: 'Back to Lobby', ok: () => { this.localPaused = false; this.net.backToLobby(); } });
    items.push({ label: 'Disconnect', ok: () => { this._leaveAndReset(); a.title(); } });

    a.menu('onlinePause', 'Online Menu', items, { back: resume });
    const mu = a.menuUpdate;
    a.menuUpdate = dt => {
      if (a.input.pressed.has('KeyP') || a.input.pads.some((_, i) => a.input.padButton(i, 9, true))) {
        a.audio.play('ui');
        resume();
        return;
      }
      mu(dt);
    };
  }

  showServerPaused(room) {
    const a = this.app;
    if (a.state === 'options' || a.state === 'controls') return;
    const isHost = room.hostId === this.net.clientId;
    const items = [];
    if (isHost) {
      items.push({ label: 'Resume Match', ok: () => this.net.setPaused(false) });
      items.push({ label: a.run?.mode === 'battle' ? 'Restart Round' : 'Restart Level', ok: () => this.net.restartRound() });
      items.push({ label: 'Back to Lobby', ok: () => this.net.backToLobby() });
    }
    items.push({ label: 'Options', ok: () => a.options(() => this.showServerPaused(this.room || room)) });
    items.push({ label: 'Disconnect', ok: () => { this._leaveAndReset(); a.title(); } });

    a.menu('onlineServerPause', 'Match Paused', items, {
      sub: isHost ? 'You paused the match for all players.' : 'Host paused the match. Waiting to resume…',
    });
  }

  showLifeExchange(room) {
    const a = this.app, g = a.game;
    if (!g || !room.lx) return;
    const prevHover = a.renderer?.lifeEx?.hover ?? null;
    a._clearLifeEx?.();
    const lx = room.lx;
    if (prevHover && !lx.hover) lx.hover = prevHover;
    const isHost = room.hostId === this.net.clientId;
    const myLives = g.players.find(p => p.slot === this.net.slot)?.lives ?? 0;
    const canControl = isHost || this.net.slot === lx.leftSlot || myLives > 1;
    const canvas = a.renderer.canvas;

    const onMove = e => {
      const h = a.renderer.lifeExchangeHit(e.clientX, e.clientY);
      lx.hover = h ? (h.slot !== undefined ? `${h.kind}:${h.slot}` : h.kind) : null;
      canvas.style.cursor = h && canControl ? 'pointer' : 'default';
    };
    const onDown = e => {
      if (!canControl || (e.button && e.button !== 0)) return;
      a.audio.init();
      const h = a.renderer.lifeExchangeHit(e.clientX, e.clientY);
      if (!h) return;
      if (h.kind === 'leftArrow') this.net.sendLifeEx('take');
      else if (h.kind === 'rightArrow') this.net.sendLifeEx('give');
      else if (h.kind === 'giveTo') this.net.sendLifeEx('giveTo', h.slot);
      else if (h.kind === 'takeFrom') this.net.sendLifeEx('takeFrom', h.slot);
      else if (h.kind === 'shareAll') this.net.sendLifeEx('shareAll');
      else if (h.kind === 'leftWiz') this.net.sendLifeEx('cycleLeft');
      else if (h.kind === 'rightWiz') this.net.sendLifeEx('cycleRight');
      else if (h.kind === 'tab') this.net.sendLifeEx('tab', h.slot);
      else if (h.kind === 'confirm') this.net.sendLifeEx('confirm');
    };

    a._clearLifeEx = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.style.cursor = 'default';
      if (a.renderer) a.renderer.lifeEx = null;
      a._clearLifeEx = null;
    };

    this.ui.innerHTML = '';
    a.renderer.lifeEx = lx;
    a.state = 'onlineLifeEx';
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);

    let prevShareKey = a.input.pressed.has('KeyR');
    a.menuUpdate = dt => {
      lx.flashL = Math.max(0, (lx.flashL || 0) - dt);
      lx.flashR = Math.max(0, (lx.flashR || 0) - dt);
      if (!canControl) return;
      const m = a.input.menu();
      const rDown = a.input.pressed.has('KeyR');
      const triggerShare = rDown && !prevShareKey && g.players.length > 2;
      prevShareKey = rDown;
      if (triggerShare) this.net.sendLifeEx('shareAll');
      else if (m.dx < 0) this.net.sendLifeEx('take');
      else if (m.dx > 0) this.net.sendLifeEx('give');
      else if (m.dy < 0 && g.players.length > 2) this.net.sendLifeEx('cycleLeft');
      else if (m.dy > 0 && g.players.length > 2) this.net.sendLifeEx('cycleRight');
      else if (m.ok || a.input.pressed.has('Space')) this.net.sendLifeEx('confirm');
    };
  }

  showSummary(room) {
    const a = this.app;
    a._clearLifeEx?.();
    if (a.renderer) a.renderer.lifeEx = null;
    const s = room.summary;
    if (!s) return;
    const isHost = room.hostId === this.net.clientId;
    const isBattle = s.mode === 'battle';

    const awards = computeAwards(s.rows, isBattle);
    const rows = (s.rows || []).map(p => {
      const tm = TEAM[p.slot] || TEAM[0];
      const botTag = p.bot ? ` <span class="award-tag" style="--ac:#98a4be">BOT</span>` : '';
      const aw = awards.get(p.slot);
      const awTag = aw ? ` <span class="award-tag" style="--ac:${aw.color}">${esc(aw.label)}</span>` : '';
      const fourth = isBattle
        ? `${'★'.repeat(p.wins)}${'☆'.repeat(Math.max(0, s.winsNeeded - p.wins))}`
        : (p.lives > 0 ? '♥'.repeat(p.lives) : '<span style="color:var(--muted);font-size:12px;letter-spacing:.12em">OUT</span>');
      return `<div class="t-name" style="color:${tm.light}"><span class="t-dot" style="--c:${tm.color}"></span>${tm.name}${botTag}${awTag}</div>
        <div class="t-score">${isBattle ? fourth : p.score.toLocaleString()}</div>
        <div class="t-kills">${p.kills} kills</div>
        <div class="${isBattle ? '' : 't-lives'}">${isBattle ? '' : fourth}</div>`;
    }).join('');

    const extra = `<div class="panel"><div class="table">
      <div class="h">Wizard</div><div class="h">${isBattle ? 'Wins' : 'Score'}</div><div class="h">Kills</div><div class="h">${isBattle ? '' : 'Lives'}</div>
      ${rows}</div>
      ${room.phase === 'levelEnd' && s.password ? `<div class="pwbox"><span>Password for Level ${s.nextLevel}</span><b>${s.password}</b></div>` : ''}
    </div>`;

    let title = `Level ${s.level} cleared!`;
    let sub = isHost ? '' : 'Waiting for Host…';
    if (room.phase === 'gameOver') {
      title = 'All wizards have fallen';
      sub = `Reached level ${s.level}.${isHost ? '' : ' Waiting for Host…'}`;
    } else if (room.phase === 'victory') {
      a.audio.play('win');
      title = 'Fracas Omega is defeated!';
      sub = 'All 100 levels cleared!';
    } else if (room.phase === 'roundEnd') {
      if (s.champ >= 0) title = `${TEAM[s.champ].name} wins the match!`;
      else title = s.roundWinner >= 0 ? `${TEAM[s.roundWinner].name} takes round ${s.round}` : `Round ${s.round}: nobody survived`;
    }

    const items = [];
    if (isHost) {
      if (room.phase === 'levelEnd') items.push({ label: `Continue to level ${s.nextLevel}`, ok: () => this.net.nextRound() });
      else if (room.phase === 'gameOver') items.push({ label: `Try again from level ${s.checkpoint}`, ok: () => this.net.nextRound() });
      else if (room.phase === 'roundEnd') items.push({ label: s.champ >= 0 ? 'Rematch' : 'Next round', ok: () => this.net.nextRound() });
      items.push({ label: 'Back to Lobby', ok: () => this.net.backToLobby() });
    } else {
      items.push({ label: 'Leave Room', ok: () => { this._leaveAndReset(); a.title(); } });
    }

    a.menu(room.phase, title, items, { extra, wide: true, sub });
  }
}
