// ════════════════════════════════════════════════════════════════
// Tangzon 产品管理 - Electron 主进程 v2
// 含：开机自启、系统托盘、文件关联、桌面通知、拖放支持
// ════════════════════════════════════════════════════════════════
const { app, BrowserWindow, Menu, Tray, dialog, shell, ipcMain, session, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// 自动更新（从 GitHub Release 检测新版本）
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;          // 先问用户，不自动下
  autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
  console.log('electron-updater not available:', e.message);
}

// 单例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      const fileArg = argv.find(a => a.toLowerCase().endsWith('.json'));
      if (fileArg) sendImportFile(fileArg);
    }
  });
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let pendingFileArg = null;

// ── 数据目录管理 ───────────────────────────────────────────
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const configPath = path.join(app.getPath('userData'), 'app-config.json');

function getDefaultDataDir() {
  if (isPortable) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  return path.join(app.getPath('userData'), 'data');
}
function loadConfig() {
  try { if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch (e) { console.error('Config read failed:', e); }
  return {};
}
function saveConfig(cfg) {
  try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('Config save failed:', e); }
}
function getDataDir() { const cfg = loadConfig(); return cfg.dataDir || getDefaultDataDir(); }
function setDataDir(p) { const cfg = loadConfig(); cfg.dataDir = p; saveConfig(cfg); }
function ensureDataDir() { const d = getDataDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }
function getSettings() {
  const cfg = loadConfig();
  return {
    autoStart: cfg.autoStart || false,
    notifyExpiring: cfg.notifyExpiring !== false,
    notifyBackup: cfg.notifyBackup !== false,
    minToTray: cfg.minToTray !== false,
    autoRating: cfg.autoRating || false,
    closeToTrayShown: cfg.closeToTrayShown || false
  };
}
function saveSettings(updates) { const cfg = loadConfig(); Object.assign(cfg, updates); saveConfig(cfg); }

// ── 主窗口 ───────────────────────────────────────────────────
function createWindow(showImmediately = true) {
  const _cfgInit = loadConfig();
  mainWindow = new BrowserWindow({
    alwaysOnTop: !!_cfgInit.alwaysOnTop,
    width: 1400, height: 900, minWidth: 1024, minHeight: 640,
    title: 'Tangzon 产品管理 v' + app.getVersion(),
    backgroundColor: '#f8fafc',
    show: showImmediately,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: false
    },
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'icon.png')
  });
  mainWindow.loadFile(path.join(__dirname, 'Tangzon_产品管理_个人版本.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().minToTray) {
      e.preventDefault();
      mainWindow.hide();
      const s = getSettings();
      if (!s.closeToTrayShown) {
        saveSettings({ closeToTrayShown: true });
        if (Notification.isSupported()) {
          new Notification({
            title: 'Tangzon 已最小化到托盘',
            body: '应用仍在后台运行。右键右下角图标可彻底退出。',
            icon: path.join(__dirname, 'icon.png')
          }).show();
        }
      }
      return false;
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  // Robust external link handling: both setWindowOpenHandler AND will-navigate
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Don't intercept the initial file:// load
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingFileArg) { sendImportFile(pendingFileArg); pendingFileArg = null; }
    setTimeout(checkExpiringPromos, 3000);
  });
}

function showMainWindow() {
  if (!mainWindow) { createWindow(true); }
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
}

// ── 系统托盘 ─────────────────────────────────────────────────
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Tangzon 产品管理');
  rebuildTrayMenu();
  tray.on('click', () => showMainWindow());
}
function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '🏠 打开主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '★ 关注列表', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof switchTab==='function')switchTab('watch');`); } },
    { label: '🎯 活动池', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof switchTab==='function')switchTab('promo');`); } },
    { type: 'separator' },
    { label: '📁 打开数据文件夹', click: () => shell.openPath(getDataDir()) },
    { label: '💾 立即备份 JSON', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof exportJson==='function')exportJson();`); } },
    { type: 'separator' },
    { label: '⚙️ 设置...', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof openMo==='function')openMo('mo-app-settings');`); } },
    { type: 'separator' },
    { label: '❌ 退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ── 开机自启 ─────────────────────────────────────────────────
function applyAutoStart(enable) {
  app.setLoginItemSettings({ openAtLogin: enable, args: ['--hidden'] });
}

// ── 桌面通知：检查即将到期活动 ──────────────────────────────
async function checkExpiringPromos() {
  if (!getSettings().notifyExpiring) return;
  if (!mainWindow) return;
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (function(){
        try{
          if(typeof PROMOTIONS==='undefined')return null;
          var today=new Date().toISOString().slice(0,10);
          var tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
          var expiring=[];
          Object.values(PROMOTIONS||{}).forEach(function(p){
            if(p.endDate===today||p.endDate===tomorrow){
              expiring.push({label:p.type+' '+p.startDate.slice(5)+'-'+p.endDate.slice(5),today:p.endDate===today});
            }
          });
          return expiring;
        }catch(e){return null;}
      })();
    `);
    if (result && result.length > 0 && Notification.isSupported()) {
      const todayOnes = result.filter(r => r.today);
      const tomorrowOnes = result.filter(r => !r.today);
      let body = '';
      if (todayOnes.length) body += '今天结束: ' + todayOnes.map(r => r.label).join(', ') + '\n';
      if (tomorrowOnes.length) body += '明天结束: ' + tomorrowOnes.map(r => r.label).join(', ');
      new Notification({
        title: '🎯 活动即将到期',
        body: body.trim(),
        icon: path.join(__dirname, 'icon.png')
      }).on('click', showMainWindow).show();
    }
  } catch (e) {}
}

// ── 文件关联 ─────────────────────────────────────────────────
function sendImportFile(filePath) {
  if (!mainWindow) { pendingFileArg = filePath; return; }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    mainWindow.webContents.send('import-file', { path: filePath, content: content });
  } catch (e) { dialog.showErrorBox('读取失败', '无法读取文件: ' + e.message); }
}
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) sendImportFile(filePath);
  else pendingFileArg = filePath;
});

// ── 应用菜单 ─────────────────────────────────────────────────
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '📁 打开数据文件夹', click: () => shell.openPath(getDataDir()) },
        { label: '⚙️ 切换数据文件夹...', click: async () => {
          const r = await dialog.showOpenDialog(mainWindow, { title: '选择新的数据文件夹', properties: ['openDirectory', 'createDirectory'], defaultPath: getDataDir() });
          if (!r.canceled && r.filePaths[0]) {
            const newPath = r.filePaths[0];
            const c = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['取消', '切换并重启'], defaultId: 1, message: '即将切换到:\n' + newPath + '\n\n应用需要重启才能生效。' });
            if (c.response === 1) { setDataDir(newPath); app.relaunch(); isQuitting = true; app.exit(); }
          }
        }},
        { type: 'separator' },
        { label: '⚙️ 设置...', accelerator: 'CmdOrCtrl+,', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof openMo==='function')openMo('mo-app-settings');`); } },
        { type: 'separator' },
        { label: '🔄 重新加载', accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow) mainWindow.reload(); } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } }
      ]
    },
    { label: '编辑', submenu: [ { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' } ] },
    { label: '视图', submenu: [ { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '默认大小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏切换' }, { type: 'separator' }, { label: '开发者工具', accelerator: 'F12', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); } } ] },
    { label: '帮助', submenu: [
      { label: '检查更新...', click: () => checkForUpdates(false) },
      { label: '更新日志', click: () => { showMainWindow(); mainWindow.webContents.executeJavaScript(`if(typeof showChangelog==='function')showChangelog();`); } },
      { type: 'separator' },
      { label: '关于', click: async () => {
        await dialog.showMessageBox(mainWindow, { type: 'info', title: '关于', message: 'Tangzon 产品管理 v' + app.getVersion(), detail: '数据存储位置:\n' + getDataDir() + '\n\n版本: ' + app.getVersion() + '\nElectron: ' + process.versions.electron + '\nChromium: ' + process.versions.chrome });
      } }
    ] }
  ]));
}

// ── IPC ──────────────────────────────────────────────────────
ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.handle('check-updates', () => checkForUpdates(false));
ipcMain.handle('set-always-on-top', (event, on) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(!!on);
    try {
      const cfg = loadConfig();
      cfg.alwaysOnTop = !!on;
      saveConfig(cfg);
    } catch(e){}
    return !!on;
  }
  return false;
});
ipcMain.handle('get-always-on-top', () => {
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-data-dir', () => getDataDir());
ipcMain.handle('open-data-dir', () => shell.openPath(getDataDir()));
ipcMain.handle('is-electron', () => true);
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (event, updates) => {
  saveSettings(updates);
  if ('autoStart' in updates) applyAutoStart(updates.autoStart);
  rebuildTrayMenu();
  return getSettings();
});
ipcMain.handle('send-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title: title || 'Tangzon', body: body || '', icon: path.join(__dirname, 'icon.png') }).on('click', showMainWindow).show();
  }
});
ipcMain.handle('show-window', () => showMainWindow());
ipcMain.handle('quit-app', () => { isQuitting = true; app.quit(); });
ipcMain.handle('read-file', (event, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf-8'), path: filePath }; }
  catch (e) { return { ok: false, error: e.message }; }
});


// ════════════════════════════════════════════════════════════════
// 自动更新
// ════════════════════════════════════════════════════════════════
function setupAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: '有新版本 v' + info.version + ' 可用',
      detail: '是否现在下载更新？下载完成后会提示你重启安装。',
      buttons: ['稍后再说', '立即下载'],
      defaultId: 1,
      cancelId: 0
    }).then((res) => {
      if (res.response === 1) {
        autoUpdater.downloadUpdate();
        if (mainWindow) {
          new Notification({
            title: 'Tangzon 正在后台下载更新',
            body: '下载完成后会通知你，期间可以正常使用。',
            icon: path.join(__dirname, 'icon.png')
          }).show();
        }
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    // 手动检查时给"已是最新"提示；自动检查时静默
    if (_manualUpdateCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本',
        detail: '版本 v' + app.getVersion()
      });
    }
    _manualUpdateCheck = false;
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
    if (_manualUpdateCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新失败',
        message: '检查更新时出错',
        detail: String(err && err.message ? err.message : err)
      });
    }
    _manualUpdateCheck = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: '新版本 v' + info.version + ' 已下载完成',
      detail: '点击"立即重启"完成安装，或稍后退出应用时自动安装。',
      buttons: ['稍后', '立即重启安装'],
      defaultId: 1,
      cancelId: 0
    }).then((res) => {
      if (res.response === 1) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });
}

let _manualUpdateCheck = false;

function checkForUpdates(silent) {
  if (!autoUpdater) {
    if (!silent && mainWindow) {
      dialog.showMessageBox(mainWindow, { type: 'info', title: '检查更新', message: '当前为开发模式，自动更新不可用' });
    }
    return;
  }
  _manualUpdateCheck = !silent;
  try {
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) {
      p.catch((e) => {
        console.error('checkForUpdates failed:', e);
        if (!silent && mainWindow) {
          dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '检查更新失败',
            message: '无法连接到更新服务器',
            detail: '请检查网络连接后重试。\n\n错误: ' + (e && e.message ? e.message : String(e))
          });
        }
      });
    }
  } catch (e) {
    console.error('checkForUpdates exception:', e);
    if (!silent && mainWindow) {
      dialog.showMessageBox(mainWindow, { type: 'warning', title: '检查更新失败', message: String(e) });
    }
  }
}

// ── 启动 ─────────────────────────────────────────────────────
const arg = process.argv.find(a => a.toLowerCase().endsWith('.json') && !a.includes('electron') && fs.existsSync(a));
if (arg) pendingFileArg = arg;
const startHidden = process.argv.includes('--hidden');

app.whenReady().then(() => {
  const dataDir = ensureDataDir();
  app.setPath('userData', dataDir);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [''] } });
  });

  app.setAppUserModelId('com.tangzon.productmanager');

  buildMenu();
  createWindow(!startHidden);
  createTray();

  // 自动更新：启动 8 秒后静默检查一次，之后每 4 小时检查一次
  setupAutoUpdater();
  setTimeout(() => checkForUpdates(true), 8000);
  setInterval(() => checkForUpdates(true), 4 * 60 * 60 * 1000);

  setInterval(checkExpiringPromos, 24 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
app.on('before-quit', () => { isQuitting = true; });
