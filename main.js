// ════════════════════════════════════════════════════════════════
// Tangzon 产品管理 - Electron 主进程 v2
// 含：开机自启、系统托盘、文件关联、桌面通知、拖放支持
// ════════════════════════════════════════════════════════════════
const { app, BrowserWindow, Menu, Tray, dialog, shell, ipcMain, session, Notification, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const childProcess = require('child_process');
let cheerio = null;
try { cheerio = require('cheerio'); }
catch (e) { console.log('cheerio not available; Amazon parser will use renderer fallback:', e.message); }

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
let updateProgressWindow = null;
let updateProgressHideTimer = null;
const BUILTIN_HTML_FILE = 'Tangzon_产品管理_个人版本.html';
const HOT_UPDATE_MANIFEST_URL = process.env.TANGZON_HOT_UPDATE_URL || 'https://raw.githubusercontent.com/Jw10303311/tangzon-app/main/hot-update.json';
const HOT_UPDATE_FALLBACK_URLS = [
  HOT_UPDATE_MANIFEST_URL,
  'https://cdn.jsdelivr.net/gh/Jw10303311/tangzon-app@main/hot-update.json'
].filter((url, idx, arr) => url && arr.indexOf(url) === idx);

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
function getBackupDir() {
  const cfg = loadConfig();
  return cfg.backupDir || path.join(app.getPath('documents'), 'Tangzon Backups');
}
function ensureBackupDir() {
  const d = getBackupDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeBackupName(kind) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const label = String(kind || 'manual').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'manual';
  return `Tangzon_${label}_${ts}.json`;
}
function getHotUpdateDir() {
  return path.join(app.getPath('userData'), 'hot-update');
}
function getHotManifestPath() {
  return path.join(getHotUpdateDir(), 'manifest.json');
}
function getHotHtmlPath() {
  return path.join(getHotUpdateDir(), 'current.html');
}
function loadHotManifest() {
  try {
    const p = getHotManifestPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('Hot update manifest read failed:', e);
  }
  return null;
}
function saveHotManifest(manifest) {
  const dir = getHotUpdateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getHotManifestPath(), JSON.stringify(manifest, null, 2));
}
function escProgressText(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}
function progressHtml() {
  const doc = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    '*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei",Segoe UI,sans-serif;background:transparent;color:#0f172a;overflow:hidden}',
    '.box{width:100%;height:100%;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:10px;box-shadow:0 14px 36px rgba(15,23,42,.22);padding:13px 14px}',
    '.title{font-size:13px;font-weight:700;margin-bottom:5px}.detail{font-size:11px;color:#64748b;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:10px}',
    '.row{display:flex;align-items:center;gap:8px}.bar{height:8px;flex:1;border-radius:99px;background:#e2e8f0;overflow:hidden}.fill{height:100%;width:0%;background:#2563eb;border-radius:99px;transition:width .18s ease}.pct{width:42px;text-align:right;font-size:12px;font-weight:700;color:#1d4ed8}.status{margin-top:8px;font-size:10.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '</style></head><body><div class="box"><div class="title" id="t">Tangzon 正在下载更新</div><div class="detail" id="d">准备下载...</div><div class="row"><div class="bar"><div class="fill" id="f"></div></div><div class="pct" id="p">0%</div></div><div class="status" id="s">请保持网络连接，期间可以正常使用软件。</div></div>',
    '<script>window.setProgress=function(data){data=data||{};document.getElementById("t").textContent=data.title||"Tangzon 正在下载更新";document.getElementById("d").textContent=data.detail||"";var pct=Number(data.percent);if(!isFinite(pct))pct=0;pct=Math.max(0,Math.min(100,pct));document.getElementById("f").style.width=pct+"%";document.getElementById("p").textContent=Math.round(pct)+"%";document.getElementById("s").textContent=data.status||"请保持网络连接，期间可以正常使用软件。";};<\/script></body></html>'
  ].join('');
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(doc);
}
function ensureUpdateProgressWindow() {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) return updateProgressWindow;
  const area = screen.getPrimaryDisplay().workArea;
  const width = 340, height = 112;
  updateProgressWindow = new BrowserWindow({
    width, height,
    x: area.x + area.width - width - 18,
    y: area.y + area.height - height - 18,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  updateProgressWindow.on('closed', () => { updateProgressWindow = null; });
  updateProgressWindow.loadURL(progressHtml());
  return updateProgressWindow;
}
function showUpdateProgress(data = {}) {
  clearTimeout(updateProgressHideTimer);
  const win = ensureUpdateProgressWindow();
  const payload = JSON.stringify(data);
  const apply = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript('window.setProgress(' + payload + ')').catch(() => {});
    if (!win.isVisible()) win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', apply);
  else apply();
  const percent = Number(data.percent);
  if (mainWindow && Number.isFinite(percent)) mainWindow.setProgressBar(Math.max(0, Math.min(1, percent / 100)));
}
function finishUpdateProgress(title, detail, ok = true) {
  const percent = ok ? 100 : 0;
  showUpdateProgress({ title, detail, percent, status: ok ? '下载完成。' : '下载失败，可稍后重试。' });
  if (mainWindow) mainWindow.setProgressBar(ok ? 1 : -1);
  clearTimeout(updateProgressHideTimer);
  updateProgressHideTimer = setTimeout(() => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) updateProgressWindow.close();
  }, ok ? 2400 : 4200);
}
function progressDetail(p) {
  const got = fmtBytes(p && p.transferred);
  const total = fmtBytes(p && p.total);
  if (got && total) return got + ' / ' + total;
  if (got) return '已下载 ' + got;
  return '正在连接下载服务器...';
}
function resolveAppHtmlPath() {
  const manifest = loadHotManifest();
  const hotHtml = getHotHtmlPath();
  if (manifest && manifest.active && fs.existsSync(hotHtml)) return hotHtml;
  return path.join(__dirname, BUILTIN_HTML_FILE);
}
function compareVersions(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function fetchHttpsBuffer(url, maxBytes = 1024 * 1024, redirects = 3, onProgress = null) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { reject(new Error('invalid_url')); return; }
    if (parsed.protocol !== 'https:') {
      reject(new Error('only_https_allowed'));
      return;
    }
    const req = https.get(parsed, { headers: { 'User-Agent': `Tangzon/${app.getVersion()}` } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('too_many_redirects')); return; }
        const nextUrl = new URL(res.headers.location, parsed).toString();
        fetchHttpsBuffer(nextUrl, maxBytes, redirects - 1, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`http_${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      const total = Number.parseInt(res.headers['content-length'] || '0', 10) || 0;
      if (typeof onProgress === 'function') onProgress({ transferred: 0, total, percent: total ? 0 : null, url });
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('file_too_large'));
          return;
        }
        chunks.push(chunk);
        if (typeof onProgress === 'function') {
          const percent = total ? Math.min(100, (size / total) * 100) : null;
          onProgress({ transferred: size, total, percent, url });
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
  });
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
async function fetchHotManifestBuffer(preferredUrl) {
  const urls = (preferredUrl && preferredUrl !== HOT_UPDATE_MANIFEST_URL)
    ? [preferredUrl].concat(HOT_UPDATE_FALLBACK_URLS)
    : HOT_UPDATE_FALLBACK_URLS;
  let lastError = null;
  for (const url of urls.filter((item, idx, arr) => item && arr.indexOf(item) === idx)) {
    try {
      return { url, buffer: await fetchHttpsBuffer(url, 512 * 1024) };
    } catch (e) {
      lastError = e;
      console.warn('Hot update manifest fetch failed:', url, e.message);
    }
  }
  throw lastError || new Error('hot_update_unreachable');
}
function friendlyNetworkMessage(err) {
  const msg = String(err && err.message ? err.message : err || '');
  if (/TIMED_OUT|timeout|ENOTFOUND|ECONNRESET|ECONNREFUSED|handshake|SSL|TLS|net::ERR/i.test(msg)) {
    return '暂时连不上 GitHub 更新服务器，软件可以继续正常使用。请稍后重试，或确认网络/代理/VPN 是否可用。';
  }
  return '检查更新时遇到问题，软件可以继续正常使用。';
}
function pickHotHtmlFile(manifest) {
  if (manifest && Array.isArray(manifest.files)) {
    return manifest.files.find(f => f && (f.name === BUILTIN_HTML_FILE || /\.html?$/i.test(String(f.name || ''))));
  }
  if (manifest && manifest.htmlUrl) return { name: BUILTIN_HTML_FILE, url: manifest.htmlUrl, sha256: manifest.sha256 };
  return null;
}
function getHotUpdateInfo() {
  const manifest = loadHotManifest();
  return {
    active: !!(manifest && manifest.active && fs.existsSync(getHotHtmlPath())),
    version: manifest && manifest.version ? manifest.version : '',
    installedAt: manifest && manifest.installedAt ? manifest.installedAt : '',
    source: manifest && manifest.source ? manifest.source : ''
  };
}
async function clearHotUpdate() {
  try {
    const hotHtml = getHotHtmlPath();
    const hotManifest = getHotManifestPath();
    if (fs.existsSync(hotHtml)) fs.unlinkSync(hotHtml);
    if (fs.existsSync(hotManifest)) fs.unlinkSync(hotManifest);
    if (mainWindow) mainWindow.loadFile(path.join(__dirname, BUILTIN_HTML_FILE));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function checkHotUpdate(silent = false) {
  const cfg = loadConfig();
  const manifestUrl = cfg.hotUpdateUrl || HOT_UPDATE_MANIFEST_URL;
  let hotDownloadStarted = false;
  try {
    const manifestResult = await fetchHotManifestBuffer(manifestUrl);
    const manifestBuf = manifestResult.buffer;
    const remote = JSON.parse(manifestBuf.toString('utf-8'));
    if (!remote || remote.enabled === false) return { ok: true, upToDate: true, message: 'hot_update_disabled' };

    const appVersion = app.getVersion();
    if (remote.minAppVersion && compareVersions(appVersion, remote.minAppVersion) < 0) {
      return { ok: true, incompatible: true, message: 'need_full_update' };
    }
    if (remote.maxAppVersion && compareVersions(appVersion, remote.maxAppVersion) > 0) {
      return { ok: true, incompatible: true, message: 'hot_update_not_for_this_version' };
    }

    const local = loadHotManifest();
    if (local && local.version && remote.version && local.version === remote.version && fs.existsSync(getHotHtmlPath())) {
      return { ok: true, upToDate: true, version: local.version };
    }
    if (isHotUpdateSkipped(cfg, appVersion, remote.version) && silent) {
      return { ok: true, skipped: true, version: remote.version, message: 'hot_update_skipped' };
    }
    if (mainWindow) {
      const ans = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['取消本版本', '立即下载'],
        defaultId: 1,
        cancelId: 0,
        title: '发现小更新',
        message: `发现小更新 v${remote.version}`,
        detail: '小更新只替换界面文件，不会清空产品数据。选择取消后，自动检查不会再下载这个小更新版本；你仍可手动检查更新。'
      });
      if (ans.response !== 1) {
        setSkippedHotUpdate(appVersion, remote.version);
        return { ok: true, skipped: true, version: remote.version, message: 'hot_update_skipped' };
      }
    } else if (silent) {
      return { ok: true, updateAvailable: true, version: remote.version, message: 'hot_update_available' };
    }

    const htmlFile = pickHotHtmlFile(remote);
    if (!remote.version || !htmlFile || !htmlFile.url || !htmlFile.sha256) {
      return { ok: false, error: 'hot_update_manifest_incomplete' };
    }

    hotDownloadStarted = true;
    showUpdateProgress({ title: 'Tangzon 小更新下载中', detail: '正在下载界面更新文件...', percent: 0, status: '请保持网络连接，期间可以正常使用软件。' });
    const htmlBuf = await fetchHttpsBuffer(htmlFile.url, 12 * 1024 * 1024, 3, (p) => {
      showUpdateProgress({ title: 'Tangzon 小更新下载中', detail: progressDetail(p), percent: p.percent == null ? 0 : p.percent, status: '请保持网络连接，期间可以正常使用软件。' });
    });
    const actualHash = sha256(htmlBuf);
    if (String(actualHash).toLowerCase() !== String(htmlFile.sha256).toLowerCase()) {
      return { ok: false, error: 'hot_update_hash_mismatch' };
    }
    const htmlText = htmlBuf.toString('utf-8');
    if (!/Tangzon/i.test(htmlText) || !/APP_VERSION\s*=/.test(htmlText)) {
      return { ok: false, error: 'hot_update_html_invalid' };
    }

    const dir = getHotUpdateDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `current.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, htmlBuf);
    const hotHtml = getHotHtmlPath();
    if (fs.existsSync(hotHtml)) fs.unlinkSync(hotHtml);
    fs.renameSync(tmp, hotHtml);
    const installed = {
      active: true,
      version: remote.version,
      minAppVersion: remote.minAppVersion || '',
      maxAppVersion: remote.maxAppVersion || '',
      notes: Array.isArray(remote.notes) ? remote.notes : [],
      source: manifestResult.url,
      installedAt: new Date().toISOString()
    };
    saveHotManifest(installed);
    clearSkippedHotUpdate(appVersion, remote.version);

    if (silent) {
      if (Notification.isSupported()) {
        new Notification({ title: 'Tangzon 小更新已准备好', body: `v${remote.version} 已下载，下次打开后自动生效。` }).show();
      }
    } else if (mainWindow) {
      const ans = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['稍后', '现在刷新'],
        defaultId: 1,
        cancelId: 0,
        title: '小更新已完成',
        message: `已安装小更新 v${remote.version}`,
        detail: '刷新后立即使用新版界面；你的产品数据不会被清空。'
      });
      if (ans.response === 1 && mainWindow) mainWindow.loadFile(resolveAppHtmlPath());
    }
    return { ok: true, applied: true, version: remote.version, notes: installed.notes };
  } catch (e) {
    if (hotDownloadStarted) finishUpdateProgress('Tangzon 小更新下载失败', friendlyNetworkMessage(e), false);
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '小更新检查失败',
        message: friendlyNetworkMessage(e),
        detail: '错误: ' + (e && e.message ? e.message : String(e))
      });
    }
    return { ok: false, error: e.message || String(e) };
  }
}
function parseAmazonHtmlWithCheerio(html) {
  if (!cheerio || !html || html.length < 500) return { ok: false, reason: 'cheerio_unavailable' };
  if (/Robot Check|To discuss automated access|api-services-support@amazon/i.test(html)) {
    return { ok: true, data: { error: 'robot_check' } };
  }
  const $ = cheerio.load(html);
  const data = {};
  const cleanNum = (s) => {
    const m = String(s || '').replace(/&nbsp;/g, ' ').replace(/,/g, '').match(/([0-9]+(?:\.[0-9]{1,2})?)/);
    const n = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const priceFromText = (s) => {
    const txt = String(s || '');
    const patterns = [
      /£\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
      /"displayString"\s*:\s*"£\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
      /"displayPrice"\s*:\s*"[^0-9"]*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
      /"priceAmount"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
      /"amount"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i
    ];
    for (const re of patterns) {
      const m = txt.match(re);
      if (m) {
        const v = cleanNum(m[1]);
        if (v) return v;
      }
    }
    return null;
  };
  const promoTexts = [
    $('#dealBadge_feature_div').text(),
    $('#dealBadgeSupportingText').text(),
    $('#promoPriceBlockMessage_feature_div').text(),
    $('#reinvent_price_desktop_pickupMessage_feature_div').text(),
    $('[id*="dealBadge"]').text(),
    $('.dealBadge, .dealBadgeTextColor, .priceBlockBadge').text()
  ].map(cleanText).filter(Boolean);
  if (!promoTexts.length) {
    const rawMatch = html.match(/limited\s*time\s*deal|prime\s*(?:exclusive\s*)?deal|prime\s*day\s*deal|lightning\s*deal|7[-\s]?day\s*deal|best\s*deal|top\s*deal|deal\s*price/i);
    if (rawMatch && rawMatch.index !== undefined) {
      promoTexts.push(cleanText(html.slice(Math.max(0, rawMatch.index - 500), rawMatch.index + 1500).replace(/<[^>]+>/g, ' ')));
    }
  }
  const promoText = promoTexts.join(' | ');
  const promoTags = [];
  if (/limited\s*time\s*deal/i.test(promoText)) promoTags.push('Limited time deal');
  if (/prime\s*exclusive\s*deal/i.test(promoText)) promoTags.push('Prime Exclusive Deal');
  if (/prime\s*day\s*deal/i.test(promoText)) promoTags.push('Prime Day Deal');
  if (/prime\s*deal/i.test(promoText) && !promoTags.includes('Prime Exclusive Deal')) promoTags.push('Prime Deal');
  if (/\b(lightning|7[-\s]?day|best|top)\s*deal\b/i.test(promoText)) {
    const m = promoText.match(/\b(lightning|7[-\s]?day|best|top)\s*deal\b/i);
    if (m) promoTags.push(cleanText(m[0]).replace(/\b\w/g, c => c.toUpperCase()));
  }
  if (/deal\s*price/i.test(promoText)) promoTags.push('Deal price');
  if (!promoTags.length && /priceblock_dealprice|dealprice|dealBadge_feature_div|dealBadge/i.test(html)) promoTags.push('Deal price');
  if (promoTags.length) data.promoBadge = [...new Set(promoTags)].slice(0, 3).join(' + ');

  const starText =
    $('#averageCustomerReviews .a-icon-alt').first().text() ||
    $('#acrPopover .a-icon-alt').first().text() ||
    $('[data-hook="rating-out-of-text"]').first().text();
  const starMatch = String(starText || '').match(/([0-9.]+)\s*out of 5/i);
  if (starMatch) {
    const v = parseFloat(starMatch[1]);
    if (v >= 1 && v <= 5) data.star = v;
  }
  const reviewText =
    $('#acrCustomerReviewText').first().text() ||
    $('[data-hook="total-review-count"]').first().text();
  const reviewMatch = String(reviewText || '').match(/([0-9,]+)/);
  if (reviewMatch) {
    const r = parseInt(reviewMatch[1].replace(/,/g, ''), 10);
    if (Number.isFinite(r) && r >= 0 && r < 10000000) data.ratings = r;
  }
  if (data.star !== undefined && (data.ratings === undefined || data.ratings === 0)) delete data.star;
  const dealPriceMatch = html.match(/prime\s*day\s*deal|prime\s*(?:exclusive\s*)?deal|limited\s*time\s*deal|lightning\s*deal|7[-\s]?day\s*deal|best\s*deal/i);
  const priceCandidates = [
    dealPriceMatch && dealPriceMatch.index !== undefined ? html.slice(dealPriceMatch.index, dealPriceMatch.index + 4200) : '',
    $('#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen').first().text(),
    $('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen').first().text(),
    $('#corePriceDisplay_mobile_feature_div .a-price .a-offscreen').first().text(),
    $('#corePrice_feature_div .priceToPay .a-offscreen').first().text(),
    $('#corePrice_feature_div .a-offscreen').first().text(),
    $('#apex_desktop .a-offscreen').first().text(),
    $('#buyNewSection .a-offscreen').first().text(),
    $('#qualifiedBuybox .a-offscreen').first().text(),
    $('#newAccordionRow_0 .a-offscreen').first().text(),
    $('[id^="aod-price"] .a-offscreen').first().text(),
    $('.aod-offer-price .a-offscreen').first().text(),
    $('#sns-base-price .a-offscreen').first().text(),
    $('#priceblock_ourprice').first().text(),
    $('#priceblock_dealprice').first().text(),
    $('#priceblock_saleprice').first().text(),
    html.slice(Math.max(0, html.toLowerCase().indexOf('pricetopay') - 800), Math.max(0, html.toLowerCase().indexOf('pricetopay') - 800) + 3600),
    html.slice(Math.max(0, html.toLowerCase().indexOf('aod-offer-price') - 800), Math.max(0, html.toLowerCase().indexOf('aod-offer-price') - 800) + 3600),
    html.slice(Math.max(0, html.toLowerCase().indexOf('twister-plus-buying-options-price-data') - 800), Math.max(0, html.toLowerCase().indexOf('twister-plus-buying-options-price-data') - 800) + 3600)
  ];
  for (const p of priceCandidates) {
    const v = priceFromText(p) || cleanNum(p);
    if (v) { data.price = v; break; }
  }
  const img =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('#landingImage').attr('data-old-hires') ||
    $('#landingImage').attr('src') ||
    $('#imgBlkFront').attr('src') ||
    $('#ebooksImgBlkFront').attr('src');
  if (img && !/placeholder|transparent-pixel/i.test(img)) data.img = img.replace(/&amp;/g, '&');
  return { ok: true, data };
}
const DEFAULT_SETTINGS = {
  autoStart: false,
  notifyExpiring: true,
  notifyBackup: true,
  autoCheckUpdates: true,
  externalBrowser: 'system',
  externalBrowserPath: '',
  minToTray: true,
  lightTrayMode: true,
  autoRating: false,
  ratingScope: 'all',
  ratingOrder: 'oldest',
  ratingMode: 'smart',
  ratingQuota: 100,
  ratingFailPauseMinutes: 30,
  ratingFailPauseHours: 1,
  closeToTrayShown: false
};
function normalizeExternalBrowser(value) {
  const v = String(value || '').toLowerCase();
  return ['system', 'chrome', 'edge', 'ziniao', 'custom'].includes(v) ? v : DEFAULT_SETTINGS.externalBrowser;
}
function existingFile(p) {
  try { return p && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null; }
  catch (e) { return null; }
}
function browserCandidates(kind, cfg = {}) {
  const env = process.env;
  const pf = env.ProgramFiles || 'C:\Program Files';
  const pfx86 = env['ProgramFiles(x86)'] || 'C:\Program Files (x86)';
  const local = env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming');
  if (kind === 'chrome') return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  if (kind === 'edge') return [
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  if (kind === 'ziniao') {
    const direct = [cfg.externalBrowserPath].filter(Boolean);
    const common = [
      path.join(local, 'Programs', 'ZiNiao', 'ZiNiao.exe'),
      path.join(local, 'Programs', 'ZiNiaoBrowser', 'ZiNiaoBrowser.exe'),
      path.join(local, 'Programs', 'ZiniaoBrowser', 'ZiniaoBrowser.exe'),
      path.join(local, 'Programs', 'Zibird', 'Zibird.exe'),
      path.join(pf, 'ZiNiao', 'ZiNiao.exe'),
      path.join(pf, 'ZiNiaoBrowser', 'ZiNiaoBrowser.exe'),
      path.join(pf, 'ZiniaoBrowser', 'ZiniaoBrowser.exe'),
      path.join(pf, 'Zibird', 'Zibird.exe'),
      path.join(pfx86, 'ZiNiao', 'ZiNiao.exe'),
      path.join(pfx86, 'ZiNiaoBrowser', 'ZiNiaoBrowser.exe'),
      path.join(pfx86, 'ZiniaoBrowser', 'ZiniaoBrowser.exe'),
      path.join(pfx86, 'Zibird', 'Zibird.exe'),
      path.join(roaming, 'ZiNiao', 'ZiNiao.exe'),
      path.join(roaming, 'ZiniaoBrowser', 'ZiniaoBrowser.exe')
    ];
    return direct.concat(common);
  }
  if (kind === 'custom') return [cfg.externalBrowserPath].filter(Boolean);
  return [];
}
function findBrowserExecutable(kind, cfg = {}) {
  for (const p of browserCandidates(kind, cfg)) {
    const found = existingFile(p);
    if (found) return found;
  }
  return null;
}
function openExternalUrl(url) {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) return false;
  const cfg = getSettings();
  const mode = normalizeExternalBrowser(cfg.externalBrowser);
  if (mode !== 'system') {
    const exe = findBrowserExecutable(mode, cfg);
    if (exe) {
      try {
        const child = childProcess.spawn(exe, [url], { detached: true, stdio: 'ignore' });
        child.unref();
        return true;
      } catch (e) {
        console.error('Open external browser failed:', e);
      }
    }
  }
  shell.openExternal(url);
  return true;
}
function normalizeSettings(cfg = {}) {
  const quota = Number.parseInt(cfg.ratingQuota, 10);
  let pauseMinutes = Number.parseInt(cfg.ratingFailPauseMinutes, 10);
  if (!Number.isFinite(pauseMinutes) && cfg.ratingFailPauseHours !== undefined) {
    const pauseHours = Number.parseInt(cfg.ratingFailPauseHours, 10);
    if (Number.isFinite(pauseHours)) pauseMinutes = pauseHours * 60;
  }
  return {
    autoStart: cfg.autoStart === undefined ? DEFAULT_SETTINGS.autoStart : !!cfg.autoStart,
    notifyExpiring: cfg.notifyExpiring === undefined ? DEFAULT_SETTINGS.notifyExpiring : !!cfg.notifyExpiring,
    notifyBackup: cfg.notifyBackup === undefined ? DEFAULT_SETTINGS.notifyBackup : !!cfg.notifyBackup,
    autoCheckUpdates: cfg.autoCheckUpdates === undefined ? DEFAULT_SETTINGS.autoCheckUpdates : !!cfg.autoCheckUpdates,
    externalBrowser: normalizeExternalBrowser(cfg.externalBrowser),
    externalBrowserPath: typeof cfg.externalBrowserPath === 'string' ? cfg.externalBrowserPath : '',
    minToTray: cfg.minToTray === undefined ? DEFAULT_SETTINGS.minToTray : !!cfg.minToTray,
    lightTrayMode: cfg.lightTrayMode === undefined ? DEFAULT_SETTINGS.lightTrayMode : !!cfg.lightTrayMode,
    autoRating: cfg.autoRating === undefined ? DEFAULT_SETTINGS.autoRating : !!cfg.autoRating,
    ratingScope: typeof cfg.ratingScope === 'string' && cfg.ratingScope ? cfg.ratingScope : DEFAULT_SETTINGS.ratingScope,
    ratingOrder: typeof cfg.ratingOrder === 'string' && cfg.ratingOrder ? cfg.ratingOrder : DEFAULT_SETTINGS.ratingOrder,
    ratingMode: typeof cfg.ratingMode === 'string' && cfg.ratingMode ? cfg.ratingMode : DEFAULT_SETTINGS.ratingMode,
    ratingQuota: Number.isFinite(quota) ? Math.max(10, Math.min(500, quota)) : DEFAULT_SETTINGS.ratingQuota,
    ratingFailPauseMinutes: Number.isFinite(pauseMinutes) ? Math.max(10, Math.min(180, pauseMinutes)) : DEFAULT_SETTINGS.ratingFailPauseMinutes,
    ratingFailPauseHours: Number.isFinite(pauseMinutes) ? Math.max(1, Math.round(pauseMinutes / 60)) : DEFAULT_SETTINGS.ratingFailPauseHours,
    closeToTrayShown: cfg.closeToTrayShown === undefined ? DEFAULT_SETTINGS.closeToTrayShown : !!cfg.closeToTrayShown
  };
}
function getSettings() {
  return normalizeSettings(loadConfig());
}
function saveSettings(updates) {
  const cfg = loadConfig();
  const next = normalizeSettings(Object.assign({}, cfg, updates || {}));
  Object.assign(cfg, next);
  saveConfig(cfg);
  return next;
}
function hotUpdateSkipKey(appVersion, hotVersion) {
  return String(appVersion || '') + '|' + String(hotVersion || '');
}
function isHotUpdateSkipped(cfg, appVersion, hotVersion) {
  const key = hotUpdateSkipKey(appVersion, hotVersion);
  return cfg && (cfg.skippedHotUpdateKey === key || (!cfg.skippedHotUpdateKey && cfg.skippedHotUpdateVersion === hotVersion));
}
function setSkippedHotUpdate(appVersion, hotVersion) {
  const cfg = loadConfig();
  cfg.skippedHotUpdateKey = hotUpdateSkipKey(appVersion, hotVersion);
  cfg.skippedHotUpdateVersion = hotVersion || '';
  saveConfig(cfg);
}
function clearSkippedHotUpdate(appVersion, hotVersion) {
  const cfg = loadConfig();
  if (isHotUpdateSkipped(cfg, appVersion, hotVersion)) {
    delete cfg.skippedHotUpdateKey;
    delete cfg.skippedHotUpdateVersion;
    saveConfig(cfg);
  }
}
function setSkippedFullUpdate(version) {
  const cfg = loadConfig();
  cfg.skippedFullUpdateVersion = version || '';
  saveConfig(cfg);
}
function clearSkippedFullUpdate(version) {
  const cfg = loadConfig();
  if (cfg.skippedFullUpdateVersion && cfg.skippedFullUpdateVersion === version) {
    delete cfg.skippedFullUpdateVersion;
    saveConfig(cfg);
  }
}

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
  mainWindow.loadFile(resolveAppHtmlPath());

  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().minToTray) {
      e.preventDefault();
      const s = getSettings();
      if (s.lightTrayMode) {
        const win = mainWindow;
        if (win && !win.isDestroyed()) win.destroy();
      } else {
        mainWindow.hide();
      }
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
    if (url.startsWith('http://') || url.startsWith('https://')) openExternalUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Don't intercept the initial file:// load
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) openExternalUrl(url);
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
  return mainWindow;
}

function runInMainWindow(script) {
  const win = showMainWindow();
  if (!win || win.isDestroyed()) return;
  const run = () => {
    if (!win.isDestroyed()) win.webContents.executeJavaScript(script).catch(() => {});
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 50));
  else run();
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
ipcMain.handle('open-external', (event, url) => openExternalUrl(url));
ipcMain.handle('choose-external-browser-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择浏览器程序',
    properties: ['openFile'],
    filters: [{ name: '应用程序', extensions: ['exe'] }]
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});
ipcMain.handle('check-updates', () => checkForUpdates(false));
ipcMain.handle('check-hot-updates', () => checkHotUpdate(false));
ipcMain.handle('get-hot-update-info', () => getHotUpdateInfo());
ipcMain.handle('clear-hot-update', () => clearHotUpdate());
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
ipcMain.handle('get-backup-dir', () => ensureBackupDir());
ipcMain.handle('open-backup-dir', () => shell.openPath(ensureBackupDir()));
ipcMain.handle('is-electron', () => true);
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (event, updates) => {
  const saved = saveSettings(updates);
  if (updates && 'autoStart' in updates) applyAutoStart(saved.autoStart);
  rebuildTrayMenu();
  return saved;
});
ipcMain.handle('send-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title: title || 'Tangzon', body: body || '', icon: path.join(__dirname, 'icon.png') }).on('click', showMainWindow).show();
  }
});
ipcMain.handle('show-window', () => showMainWindow());
ipcMain.handle('quit-app', () => { isQuitting = true; app.quit(); });

ipcMain.handle('save-backup-json', (event, payload) => {
  try {
    const dir = ensureBackupDir();
    const filePath = path.join(dir, safeBackupName(payload && payload.kind));
    const data = payload && payload.data ? payload.data : {};
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { ok: true, path: filePath, dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('list-backups', () => {
  try {
    const dir = ensureBackupDir();
    const files = fs.readdirSync(dir)
      .filter(name => /^Tangzon_.*\.json$/i.test(name))
      .map(name => {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        return { name, path: p, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir, files };
  } catch (e) {
    return { ok: false, error: e.message, files: [] };
  }
});
ipcMain.handle('read-backup-json', (event, filePath) => {
  try {
    const dir = path.resolve(ensureBackupDir());
    const p = path.resolve(String(filePath || ''));
    const rel = path.relative(dir, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'Invalid backup path' };
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, error: 'Invalid backup path' };
    return { ok: true, content: fs.readFileSync(p, 'utf-8'), path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('parse-amazon-html', (event, html) => {
  try { return parseAmazonHtmlWithCheerio(String(html || '')); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('get-spapi-settings', () => {
  const cfg = loadConfig();
  return cfg.spApi || { enabled: false, region: 'eu', marketplaceId: 'A1F83G8C2ARO7P' };
});
ipcMain.handle('save-spapi-settings', (event, updates) => {
  const cfg = loadConfig();
  cfg.spApi = Object.assign({ enabled: false, region: 'eu', marketplaceId: 'A1F83G8C2ARO7P' }, cfg.spApi || {}, updates || {});
  saveConfig(cfg);
  return cfg.spApi;
});


// ════════════════════════════════════════════════════════════════
// 自动更新
// ════════════════════════════════════════════════════════════════
function setupAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    const version = info && info.version ? String(info.version) : '';
    const cfg = loadConfig();
    if (!_manualUpdateCheck && version && cfg.skippedFullUpdateVersion === version) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: '有新版本 v' + version + ' 可用',
      detail: '是否现在下载更新？选择稍后后，自动检查不会再反复提示这个版本；你仍可手动检查更新。',
      buttons: ['稍后再说', '立即下载'],
      defaultId: 1,
      cancelId: 0
    }).then((res) => {
      if (res.response === 1) {
        clearSkippedFullUpdate(version);
        showUpdateProgress({ title: 'Tangzon 正在下载完整更新', detail: '准备下载完整安装包...', percent: 0, status: '下载完成后会提示你重启安装。' });
        autoUpdater.downloadUpdate();
        if (mainWindow) {
          new Notification({
            title: 'Tangzon 正在后台下载更新',
            body: '下载完成后会通知你，期间可以正常使用。',
            icon: path.join(__dirname, 'icon.png')
          }).show();
        }
      } else if (version) {
        setSkippedFullUpdate(version);
      }
      _manualUpdateCheck = false;
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
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) finishUpdateProgress('Tangzon 完整更新下载失败', friendlyNetworkMessage(err), false);
    if (_manualUpdateCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新失败',
        message: friendlyNetworkMessage(err),
        detail: '错误: ' + String(err && err.message ? err.message : err)
      });
    }
    _manualUpdateCheck = false;
  });

  autoUpdater.on('download-progress', (info) => {
    const percent = Number(info && info.percent) || 0;
    const transferred = Number(info && info.transferred) || 0;
    const total = Number(info && info.total) || 0;
    showUpdateProgress({
      title: 'Tangzon 正在下载完整更新',
      detail: progressDetail({ transferred, total }),
      percent,
      status: '下载完成后会提示你重启安装。'
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    finishUpdateProgress('Tangzon 完整更新下载完成', '新版本 v' + info.version + ' 已下载完成。', true);
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
            message: friendlyNetworkMessage(e),
            detail: '错误: ' + (e && e.message ? e.message : String(e))
          });
        }
      });
    }
  } catch (e) {
    console.error('checkForUpdates exception:', e);
    if (!silent && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新失败',
        message: friendlyNetworkMessage(e),
        detail: '错误: ' + String(e && e.message ? e.message : e)
      });
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
  setTimeout(() => { if (getSettings().autoCheckUpdates) checkHotUpdate(true); }, 5000);
  setInterval(() => { if (getSettings().autoCheckUpdates) checkHotUpdate(true); }, 2 * 60 * 60 * 1000);
  setTimeout(() => { if (getSettings().autoCheckUpdates) checkForUpdates(true); }, 8000);
  setInterval(() => { if (getSettings().autoCheckUpdates) checkForUpdates(true); }, 4 * 60 * 60 * 1000);

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
