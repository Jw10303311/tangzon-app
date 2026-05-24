// ════════════════════════════════════════════════════════════════
// Preload — 桥接主进程和 HTML 页面
// ════════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  version: process.versions.electron,
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (updates) => ipcRenderer.invoke('save-settings', updates),
  sendNotification: (title, body) => ipcRenderer.invoke('send-notification', { title, body }),
  showWindow: () => ipcRenderer.invoke('show-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onImportFile: (callback) => ipcRenderer.on('import-file', (event, payload) => callback(payload))
});

// Standard flag
window.__ELECTRON__ = true;
