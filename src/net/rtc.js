const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export const HAS_WEBRTC = typeof RTCPeerConnection === 'function';

/**
 * Full-mesh WebRTC DataChannel manager with per-peer automatic WebSocket fallback.
 * Uses an unreliable/unordered channel ('in') for zero-HoL 60 Hz rollback inputs
 * and a reliable channel ('ctl') for checksums and state recovery.
 */
export class PeerMesh {
  constructor(opts = {}) {
    this.myId = opts.myId || null;
    this.sendSignal = opts.sendSignal || (() => {});
    this.onPacket = opts.onPacket || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.iceServers = opts.iceServers?.length ? opts.iceServers : DEFAULT_ICE_SERVERS;
    this.peers = new Map(); // peerId -> { id, slot, pc, dcFast, dcCtl, pendingIce, remoteSet, makingOffer, iceRestarts }
  }

  setIceServers(servers) {
    if (Array.isArray(servers) && servers.length) this.iceServers = servers;
  }

  setSelfId(id) {
    if (this.myId === id) return;
    this.myId = id;
  }

  /** Reconcile active room members against open peer connections. */
  syncPeers(members = []) {
    if (!this.myId) return;
    const active = new Map();
    for (const m of members) {
      if (!m || !m.id || m.id === this.myId || m.connected === false) continue;
      active.set(m.id, m.slot);
    }

    for (const [id] of [...this.peers]) {
      if (!active.has(id)) this._closePeer(id);
    }

    for (const [id, slot] of active) {
      const existing = this.peers.get(id);
      if (existing) {
        existing.slot = slot;
        continue;
      }
      this._createPeer(id, slot);
    }
    this._emitStatus();
  }

  _createPeer(id, slot) {
    const peer = {
      id,
      slot,
      pc: null,
      dcFast: null,
      dcCtl: null,
      pendingIce: [],
      remoteSet: false,
      makingOffer: false,
      iceRestarts: 0,
    };
    this.peers.set(id, peer);
    if (!HAS_WEBRTC || !this.myId) return peer;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
    peer.pc = pc;
    const isOfferer = String(this.myId) < String(id);

    pc.onicecandidate = ev => {
      if (ev.candidate) this.sendSignal(id, 'ice', ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate);
    };

    pc.ondatachannel = ev => this._attachChannel(peer, ev.channel);

    pc.onconnectionstatechange = () => {
      this._emitStatus();
      if (isOfferer && (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') && peer.iceRestarts < 2) {
        peer.iceRestarts++;
        this._negotiate(peer, true);
      }
    };

    if (isOfferer) {
      this._attachChannel(peer, pc.createDataChannel('in', { ordered: false, maxRetransmits: 0 }));
      this._attachChannel(peer, pc.createDataChannel('ctl', { ordered: true }));
      this._negotiate(peer, false);
    }

    return peer;
  }

  async _negotiate(peer, iceRestart = false) {
    const { pc, id } = peer;
    if (!pc || peer.makingOffer) return;
    peer.makingOffer = true;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.sendSignal(id, 'offer', pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
    } catch (_) {
      // Ignore transient close/glare; WS binary relay handles packets seamlessly
    } finally {
      peer.makingOffer = false;
    }
  }

  _attachChannel(peer, dc) {
    if (!dc) return;
    dc.binaryType = 'arraybuffer';
    if (dc.label === 'in') peer.dcFast = dc;
    else if (dc.label === 'ctl') peer.dcCtl = dc;

    dc.onopen = () => this._emitStatus();
    dc.onclose = () => this._emitStatus();
    dc.onerror = () => this._emitStatus();
    dc.onmessage = ev => {
      if (typeof Blob === 'function' && ev.data instanceof Blob) {
        ev.data.arrayBuffer().then(buf => this.onPacket(buf, peer.slot, peer.id)).catch(() => {});
        return;
      }
      this.onPacket(ev.data, peer.slot, peer.id);
    };
  }

  /** Process an incoming WebRTC signaling message forwarded by RoomManager. */
  async handleSignal(fromId, kind, data, slot = null) {
    if (!HAS_WEBRTC || !fromId || fromId === this.myId) return;
    let peer = this.peers.get(fromId);
    if (!peer) peer = this._createPeer(fromId, slot);
    if (slot !== null && slot !== undefined) peer.slot = slot;
    const { pc } = peer;
    if (!pc) return;

    try {
      if (kind === 'offer') {
        const polite = String(this.myId) > String(fromId);
        if (pc.signalingState !== 'stable') {
          if (!polite) return;
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        peer.remoteSet = true;
        await this._flushIce(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(fromId, 'answer', pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
      } else if (kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          peer.remoteSet = true;
          await this._flushIce(peer);
        }
      } else if (kind === 'ice' && data) {
        if (peer.remoteSet) await pc.addIceCandidate(new RTCIceCandidate(data));
        else peer.pendingIce.push(data);
      }
    } catch (_) {
      // Leave peer on automatic WS relay if ICE/SDP fails due to restrictive NAT
    }
  }

  async _flushIce(peer) {
    if (!peer.pc || !peer.pendingIce.length) return;
    const queued = peer.pendingIce.splice(0, peer.pendingIce.length);
    for (const cand of queued) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
    }
  }

  /**
   * Send a binary packet to every peer over direct P2P DataChannel if open,
   * otherwise invoke relayFallbackFn(peerId, bytes, reliable) for that peer only.
   */
  sendAll(bytes, reliable = false, relayFallbackFn = null) {
    const needRelay = [];
    for (const peer of this.peers.values()) {
      const ch = reliable ? (peer.dcCtl || peer.dcFast) : (peer.dcFast || peer.dcCtl);
      if (ch && ch.readyState === 'open') {
        try {
          ch.send(bytes);
          continue;
        } catch (_) {}
      }
      needRelay.push(peer.id);
    }
    if (needRelay.length && relayFallbackFn) relayFallbackFn(needRelay, bytes, reliable);
  }

  /** Summary of current P2P direct vs WebSocket relay links. */
  getTransportSummary() {
    let total = 0, p2p = 0;
    for (const peer of this.peers.values()) {
      total++;
      if (peer.dcFast?.readyState === 'open' || peer.dcCtl?.readyState === 'open') p2p++;
    }
    return { total, p2p, relay: total - p2p };
  }

  _emitStatus() {
    this.onStatus(this.getTransportSummary());
  }

  _closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    try { peer.dcFast?.close(); } catch (_) {}
    try { peer.dcCtl?.close(); } catch (_) {}
    try { peer.pc?.close(); } catch (_) {}
    this.peers.delete(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    this._emitStatus();
  }
}
