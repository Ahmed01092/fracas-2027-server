// Online server configuration for Fracas 2027 Desktop (.exe) & Web.
//
// Once you deploy `server.mjs` to Render, Fly.io, or Railway (see DEPLOY_ONLINE_SERVER.md),
// paste your server URL here (e.g. 'https://fracas-2027.onrender.com') and rebuild the .exe!
// Players can also type or change the server address directly inside Play Online -> Server Address.
export const DEFAULT_ONLINE_SERVER = '';

/**
 * Normalize a user-provided server address into a WebSocket URL (`ws://.../ws` or `wss://.../ws`).
 * Empty input uses the current page host (built-in local/LAN server in the Desktop .exe).
 */
export function resolveWsUrl(rawServer = '') {
  const s = String(rawServer || '').trim();
  if (!s) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  let u = s;
  if (!/^[a-z]+:\/\//i.test(u)) {
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(u);
    u = (isLocal ? 'ws://' : 'wss://') + u;
  }
  u = u.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  u = u.replace(/\/+$/, '');
  if (!u.endsWith('/ws')) u += '/ws';
  return u;
}

/** Normalize a server address into an HTTP/HTTPS invite base URL (empty if local). */
export function resolveHttpOrigin(rawServer = '') {
  const s = String(rawServer || '').trim();
  if (!s) return '';
  let u = s;
  if (!/^[a-z]+:\/\//i.test(u)) {
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(u);
    u = (isLocal ? 'http://' : 'https://') + u;
  }
  u = u.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  return u.replace(/\/ws$/i, '').replace(/\/+$/, '');
}
