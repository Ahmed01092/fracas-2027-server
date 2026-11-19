// Fracas 2027 Native Desktop Launcher (Electron)
// Runs the built-in HTTP + WebSocket LAN/local server cleanly inside the .exe with zero terminal windows.
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFracasServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let mainWin = null;
let serverApp = null;
let serverPort = 8128;

async function startEmbeddedServer() {
  // Prefer 8128 so LAN players get a predictable port; fall back to any free port if another instance is open.
  try {
    const s = createFracasServer({ port: 8128, host: '0.0.0.0' });
    serverPort = await s.start();
    return s;
  } catch {
    const s = createFracasServer({ port: 0, host: '0.0.0.0' });
    serverPort = await s.start();
    return s;
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Fracas 2027',
    backgroundColor: '#060810',
    icon: path.join(ROOT, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWin.once('ready-to-show', () => {
    mainWin?.show();
  });

  // Native PC game shortcuts: F11 or Alt+Enter toggles true fullscreen
  mainWin.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isAltEnter = input.key === 'Enter' && input.alt;
    if (input.key === 'F11' || isAltEnter) {
      event.preventDefault();
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.setFullScreen(!mainWin.isFullScreen());
      }
    }
  });

  // Open external http/https links in the system browser instead of navigating the game window
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  mainWin.loadURL(`http://127.0.0.1:${serverPort}/`);
}

ipcMain.handle('fracas:quit', () => {
  app.quit();
});

ipcMain.handle('fracas:toggleFullscreen', () => {
  if (!mainWin || mainWin.isDestroyed()) return false;
  const next = !mainWin.isFullScreen();
  mainWin.setFullScreen(next);
  return next;
});

ipcMain.handle('fracas:isFullscreen', () => {
  if (!mainWin || mainWin.isDestroyed()) return false;
  return mainWin.isFullScreen();
});

ipcMain.handle('fracas:info', () => ({
  port: serverPort,
  lanUrls: serverApp?.rooms?.lanUrls || [],
  version: app.getVersion(),
}));

app.whenReady().then(async () => {
  serverApp = await startEmbeddedServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  console.error('Failed to start Fracas 2027 Desktop:', err);
  app.quit();
});

app.on('window-all-closed', async () => {
  if (serverApp) {
    try { await serverApp.close(); } catch {}
    serverApp = null;
  }
  app.quit();
});
