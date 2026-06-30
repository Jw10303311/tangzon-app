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
  getBackupDir: () => ipcRenderer.invoke('get-backup-dir'),
  openBackupDir: () => ipcRenderer.invoke('open-backup-dir'),
  saveBackupJson: (kind, data) => ipcRenderer.invoke('save-backup-json', { kind, data }),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  readBackupJson: (filePath) => ipcRenderer.invoke('read-backup-json', filePath),
  parseAmazonHtml: (html) => ipcRenderer.invoke('parse-amazon-html', html),
  getSpApiSettings: () => ipcRenderer.invoke('get-spapi-settings'),
  saveSpApiSettings: (updates) => ipcRenderer.invoke('save-spapi-settings', updates),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (updates) => ipcRenderer.invoke('save-settings', updates),
  sendNotification: (title, body) => ipcRenderer.invoke('send-notification', { title, body }),
  showWindow: () => ipcRenderer.invoke('show-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  checkHotUpdates: () => ipcRenderer.invoke('check-hot-updates'),
  getHotUpdateInfo: () => ipcRenderer.invoke('get-hot-update-info'),
  clearHotUpdate: () => ipcRenderer.invoke('clear-hot-update'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('set-always-on-top', on),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onImportFile: (callback) => ipcRenderer.on('import-file', (event, payload) => callback(payload))
});

// Standard flag
window.__ELECTRON__ = true;
