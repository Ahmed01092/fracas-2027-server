// Minimal zero-dependency RFC 6455 WebSocket server for Node.js `http.Server`.
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024; // 1 MiB cap per message

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return len ? Buffer.concat([header, data]) : header;
}

class WebSocketClient {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = 0;
    this._fragParts = [];
    this._handlers = { message: [], binary: [], close: [], error: [] };

    socket.setNoDelay(true);
    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', err => {
      for (const fn of this._handlers.error) { try { fn(err); } catch {} }
      this._finish();
    });
  }

  on(event, fn) {
    this._handlers[event]?.push(fn);
    return this;
  }

  get bufferedAmount() {
    return this.socket?.writableLength || 0;
  }

  send(text) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(encodeFrame(0x1, text));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    try {
      const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength ?? buf.length);
      this.socket.write(encodeFrame(0x2, payload));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  ping() {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(encodeFrame(0x9));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const rBuf = Buffer.from(reason, 'utf8');
      const body = Buffer.allocUnsafe(2 + rBuf.length);
      body.writeUInt16BE(code, 0);
      rBuf.copy(body, 2);
      if (this.socket.writable) this.socket.end(encodeFrame(0x8, body));
      else this.socket.destroy();
    } catch {
      try { this.socket.destroy(); } catch {}
    }
    this._emitClose();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this._emitClose();
  }

  _emitClose() {
    const hs = this._handlers.close.splice(0);
    for (const fn of hs) { try { fn(); } catch {} }
  }

  _onData(chunk) {
    this.alive = true;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    while (this._buf.length >= 2 && !this.closed) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (!masked) { this.close(1002, 'Unmasked client frame'); return; }
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const big = this._buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, 'Frame too large'); return; }
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) { this.close(1009, 'Frame too large'); return; }
      if (this._buf.length < off + 4 + len) return;

      const mask = this._buf.subarray(off, off + 4);
      const raw = this._buf.subarray(off + 4, off + 4 + len);
      this._buf = this._buf.subarray(off + 4 + len);

      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];

      if (opcode === 0x8) {
        if (!this.closed && this.socket.writable) {
          try { this.socket.end(encodeFrame(0x8, payload.subarray(0, 2))); } catch {}
        }
        this._finish();
        return;
      }
      if (opcode === 0x9) {
        if (!this.closed && this.socket.writable) {
          try { this.socket.write(encodeFrame(0xA, payload)); } catch {}
        }
        continue;
      }
      if (opcode === 0xA) {
        this.alive = true;
        continue;
      }

      if (opcode === 0x0) {
        if (!this._fragOpcode) { this.close(1002, 'Unexpected continuation'); return; }
        this._fragParts.push(payload);
        const total = this._fragParts.reduce((s, p) => s + p.length, 0);
        if (total > MAX_PAYLOAD) { this.close(1009, 'Message too large'); return; }
        if (fin) {
          const full = Buffer.concat(this._fragParts);
          const op = this._fragOpcode;
          this._fragOpcode = 0;
          this._fragParts.length = 0;
          if (op === 0x1) this._emitMessage(full.toString('utf8'));
          else if (op === 0x2) this._emitBinary(full);
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this._fragOpcode = opcode;
          this._fragParts = [payload];
        } else if (opcode === 0x1) {
          this._emitMessage(payload.toString('utf8'));
        } else {
          this._emitBinary(payload);
        }
      } else {
        this.close(1003, 'Unsupported opcode');
        return;
      }
    }
  }

  _emitMessage(text) {
    for (const fn of this._handlers.message) { try { fn(text); } catch {} }
  }

  _emitBinary(buf) {
    for (const fn of this._handlers.binary) { try { fn(buf); } catch {} }
  }
}

export function attachWebSocketServer(httpServer, { path = '/ws', onConnection } = {}) {
  const clients = new Set();

  httpServer.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== path) { socket.destroy(); return; }
      const upgrade = (req.headers.upgrade || '').toLowerCase();
      const key = req.headers['sec-websocket-key'];
      if (upgrade !== 'websocket' || typeof key !== 'string' || !key) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      const client = new WebSocketClient(socket, req);
      clients.add(client);
      client.on('close', () => clients.delete(client));
      onConnection?.(client, req, url);
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  const keepalive = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.close(1001, 'Timeout'); continue; }
      c.alive = false;
      c.ping();
    }
  }, 20000);
  keepalive.unref?.();

  return {
    clients,
    closeAll() {
      clearInterval(keepalive);
      for (const c of [...clients]) c.close(1001, 'Server shutting down');
    },
  };
}
