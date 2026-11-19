// Fracas 2027 HTTP + WebSocket multiplayer server (zero external dependencies).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './src/net/ws.mjs';
import { RoomManager } from './src/net/rooms.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.raw': 'application/octet-stream',
};

function getLanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        urls.push(`http://${n.address}:${port}`);
      }
    }
  }
  const rank = u => {
    const ip = u.replace(/^http:\/\//, '').split(':')[0];
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    return 2;
  };
  return urls.sort((a, b) => rank(a) - rank(b));
}

function safeFilePath(urlPath) {
  let clean = urlPath.split('?')[0];
  try { clean = decodeURIComponent(clean); } catch { return null; }
  if (clean === '/') clean = '/index.html';
  const rel = path.normalize(clean).replace(/^([/\\])+/, '');
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function checkLoopbackFree(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(true));
  });
}

const COMPRESS_EXT = new Set(['.html', '.js', '.mjs', '.json', '.css', '.svg']);

function buildIceServers() {
  const servers = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const turnUrl = process.env.TURN_URL?.trim();
  if (turnUrl) {
    const entry = { urls: turnUrl.split(',').map(s => s.trim()).filter(Boolean) };
    if (process.env.TURN_USER) entry.username = process.env.TURN_USER;
    if (process.env.TURN_PASS) entry.credential = process.env.TURN_PASS;
    servers.push(entry);
  }
  return servers;
}

export function createFracasServer({ port = 8128, host = '0.0.0.0' } = {}) {
  const levelsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'levels.json'), 'utf8'));
  const lanUrls = getLanUrls(port);
  const iceServers = buildIceServers();
  const rooms = new RoomManager(levelsData, { lanUrls, iceServers });

  const server = http.createServer((req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];
    if (reqUrl === '/health') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Fracas-Server': 'ws',
      });
      res.end('ok');
      return;
    }

    const filePath = safeFilePath(req.url || '/');
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const isMedia = ext === '.png' || ext === '.jpg' || ext === '.webp' || ext === '.raw';
      if (isMedia) {
        const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=3600' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          ETag: etag,
          'Cache-Control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const rs = fs.createReadStream(filePath);
        rs.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
        res.on('close', () => rs.destroy());
        rs.pipe(res);
        return;
      }

      const acceptGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
      const useGzip = acceptGzip && COMPRESS_EXT.has(ext) && st.size >= 1024;
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
      };
      if (useGzip) headers['Content-Encoding'] = 'gzip';
      else headers['Content-Length'] = st.size;

      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const rs = fs.createReadStream(filePath);
      rs.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      if (useGzip) {
        const gz = zlib.createGzip({ level: 6 });
        res.on('close', () => { rs.destroy(); gz.destroy(); });
        rs.pipe(gz).pipe(res);
      } else {
        res.on('close', () => rs.destroy());
        rs.pipe(res);
      }
    });
  });

  const wsServer = attachWebSocketServer(server, {
    path: '/ws',
    onConnection: ws => rooms.attachClient(ws),
  });

  return {
    server,
    rooms,
    wsServer,
    async start() {
      if (port > 0 && host === '0.0.0.0') {
        const free = await checkLoopbackFree(port);
        if (!free) {
          throw new Error(`Port ${port} is already in use on 127.0.0.1 (close any old Python/Node server on port ${port}).`);
        }
      }
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          rooms.lanUrls = getLanUrls(actualPort);
          resolve(actualPort);
        });
      });
    },
    async close() {
      rooms.stop();
      wsServer.closeAll();
      await new Promise(r => server.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.argv[2] || process.env.PORT || 8128);
  const host = process.env.HOST || '0.0.0.0';
  const app = createFracasServer({ port, host });
  app.start().then(actualPort => {
    console.log('');
    console.log(`Fracas 2027 running at:`);
    console.log(`  Local:   http://localhost:${actualPort}`);
    for (const u of app.rooms.lanUrls) {
      console.log(`  Wi-Fi:   ${u}`);
    }
    console.log('');
    console.log('To play with friends on another network (Internet):');
    console.log(`  Run in a second window:  ngrok http ${actualPort}`);
    console.log('  (or: cloudflared tunnel --url http://localhost:' + actualPort + ')');
    console.log('  Then share the https:// link or use Host Room -> Copy Invite Link.');
    console.log('');
  }).catch(err => {
    console.error('Failed to start Fracas 2027 server:', err);
    process.exitCode = 1;
  });
}
