// Safe Electron preload bridge exposing minimal desktop game controls to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fracasDesktop', {
  isDesktop: true,
  quit: () => ipcRenderer.invoke('fracas:quit'),
  toggleFullscreen: () => ipcRenderer.invoke('fracas:toggleFullscreen'),
  isFullscreen: () => ipcRenderer.invoke('fracas:isFullscreen'),
  getInfo: () => ipcRenderer.invoke('fracas:info'),
});
