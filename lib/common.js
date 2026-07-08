/**
 * Typeless 工具集共享模块
 *
 * 抽出 manager.js / typeless-dict-sync.js 的重复逻辑:
 *   - 路径常量、配置加载、Typeless 可执行文件探测
 *   - curl 调 API(走系统代理,数组传参避免 shell 转义)
 *   - CDP 抓 token(注入 fetch/XHR 捕获 + 重载 + 读 window.__captured)
 *   - 账号存储、登录态快照、主 CSV、kill/launch、实时状态、单账号同步
 *
 * 全部路径来自 config.json + 环境变量,禁止任何硬编码用户目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
// 优先 ws 包(打包版 Electron 主进程可能无可用全局 WebSocket);开发版无 ws 包则用全局
const WebSocket = (() => {
  try { const W = require('ws'); if (typeof W === 'function') return W; } catch (e) {}
  return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : undefined;
})();

// 数据目录:打包后由 TYPELESS_DATA_DIR 指向可写 data/;开发模式用项目根
const ROOT = process.env.TYPELESS_DATA_DIR || path.join(__dirname, '..');
// 代码目录:文件所在目录(asar 内只读),用于读静态资源如 manager.html
const CODE_DIR = path.join(__dirname, '..');

// ---------- 默认配置 ----------
const DEFAULT_CONFIG = {
  typeless_app: '',
  user_data_dir: '',
  device_cache_path: '',
  asar_path: '',
  cdp_port: 9222,
  manager_port: 7788,
  api_base: 'https://api.typeless.com',
  master_csv: 'Typeless词库主清单.csv',
  paywall: {
    // 留空时自动遍历 asar 内含 paywall 的 .mjs 文件
    file_path: [],
    // 留空时自动识别 type==='paywall' 分支中的等长替换点
    replacements: [],
    auto_detect_replacements: true,
    auto_detect_file: true,
  },
};

// ---------- 配置加载 ----------
function loadConfig() {
  // 优先 config.local.json(用户本地覆盖,不进 git),其次 config.json
  const candidates = ['config.json', 'config.local.json'];
  let cfg = {};
  for (const name of candidates) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8') || '{}') }; }
      catch (e) { /* 配置损坏时忽略,用默认 */ }
    }
  }
  // 深合并 paywall
  cfg.paywall = { ...DEFAULT_CONFIG.paywall, ...(cfg.paywall || {}) };
  if (!Array.isArray(cfg.paywall.file_path)) cfg.paywall.file_path = DEFAULT_CONFIG.paywall.file_path;
  if (!Array.isArray(cfg.paywall.replacements)) cfg.paywall.replacements = DEFAULT_CONFIG.paywall.replacements;
  return { ...DEFAULT_CONFIG, ...cfg };
}
const config = loadConfig();

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|\/|\\)/, os.homedir());
}

function macExecutableFromApp(appPath) {
  if (!appPath || !/\.app$/i.test(appPath)) return null;
  const candidates = [
    path.join(appPath, 'Contents', 'MacOS', 'Typeless'),
    path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app')),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ---------- Typeless 可执行文件探测 ----------
// 优先级: config/env 显式配置 → 平台默认安装路径 → 抛错
function detectTypelessExe() {
  const tryPath = (p) => {
    if (!p) return null;
    const resolved = expandHome(p);
    try {
      if (/\.app$/i.test(resolved)) return macExecutableFromApp(resolved);
      if (fs.existsSync(resolved)) return resolved;
    } catch (e) {}
    return null;
  };
  const explicit = [
    config.typeless_app,
    process.env.TYPELESS_APP,
    process.env.TYPELESS_BIN,
  ];
  for (const item of explicit) {
    const p = tryPath(item);
    if (p) return p;
  }

  const defaults = [
    '/Applications/Typeless.app',
    path.join(os.homedir(), 'Applications', 'Typeless.app'),
  ];
  for (const item of defaults) {
    const p = tryPath(item);
    if (p) return p;
  }
  throw new Error(
    '未找到 Typeless。请在 config.json 里配置 typeless_app 路径。' +
    '默认探测路径:' + defaults.join(', ')
  );
}

function detectUserDataDir() {
  const explicit = expandHome(config.user_data_dir || process.env.TYPELESS_USER_DATA_DIR || '');
  if (explicit) return explicit;
  const base = path.join(os.homedir(), 'Library', 'Application Support');
  const candidates = [
    path.join(base, 'Typeless'),
    path.join(base, 'now.typeless.desktop'),
  ];
  return candidates.find(p => fs.existsSync(path.join(p, 'user-data.json'))) || candidates[0];
}

function detectDeviceCachePaths() {
  const explicit = expandHome(config.device_cache_path || process.env.TYPELESS_DEVICE_CACHE_PATH || '');
  if (explicit) return [explicit];
  const base = path.join(os.homedir(), 'Library', 'Application Support');
  return [
    path.join(base, 'now.typeless.desktop', 'device.cache'),
    path.join(base, 'Typeless', 'Cache', 'device.cache'),
  ];
}

function detectAsarPath(binPath) {
  const explicit = expandHome(config.asar_path || process.env.TYPELESS_ASAR_PATH || '');
  if (explicit) return explicit;
  if (!binPath) return '';
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const i = binPath.indexOf(marker);
  if (i >= 0) return path.join(binPath.slice(0, i), 'Contents', 'Resources', 'app.asar');
  return path.join(path.dirname(binPath), '..', 'Resources', 'app.asar');
}

function macAppPathFromBin(binPath) {
  if (!binPath) return '';
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const i = binPath.indexOf(marker);
  return i >= 0 ? binPath.slice(0, i) : '';
}

// ---------- 常量(供 manager / sync 脚本共用) ----------
const TYPELESS_BIN = (() => { try { return detectTypelessExe(); } catch (e) { return ''; } })();
const USERDATA_DIR = detectUserDataDir();
const DEVICE_CACHE_PATHS = detectDeviceCachePaths();
const MAC_KEYCHAIN_SERVICE = 'now.typeless.desktop.deviceIdentifier';
const MAC_KEYCHAIN_ACCOUNT = 'now.typeless.desktop.security.auth_key';
const MAC_APP_PATH = macAppPathFromBin(TYPELESS_BIN);
const MAC_INFO_PLIST = MAC_APP_PATH ? path.join(MAC_APP_PATH, 'Contents', 'Info.plist') : '';
const ASAR_PATH = detectAsarPath(TYPELESS_BIN);
const API_BASE = config.api_base;
const CDP_PORT = config.cdp_port;
const MASTER_CSV = path.join(ROOT, config.master_csv);
const PROFILES_DIR = path.join(ROOT, 'profiles');
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const RUNTIME_BACKUPS_DIR = path.join(ROOT, 'runtime-backups');
const SNAPSHOT_FILES = ['app-storage.json', 'user-data.json', 'app-onboarding.json'];

// ---------- 工具 ----------
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const termKey = s => String(s || '').trim().toLocaleLowerCase();
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function safeName(s) {
  return String(s || 'backup').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
}

// ---------- 账号存储 ----------
function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
  if (!raw.trim()) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('accounts.json 顶层不是数组');
    return data;
  } catch (e) {
    const backup = `${ACCOUNTS_FILE}.corrupt-${fileStamp()}.bak`;
    try { fs.copyFileSync(ACCOUNTS_FILE, backup); } catch (_) {}
    throw new Error(`accounts.json 解析失败,已保留损坏文件备份: ${backup}`);
  }
}
function writeAccounts(a) {
  if (!Array.isArray(a)) throw new Error('writeAccounts 需要数组');
  fs.mkdirSync(ROOT, { recursive: true });
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try { fs.copyFileSync(ACCOUNTS_FILE, `${ACCOUNTS_FILE}.bak`); } catch (_) {}
  }
  const tmp = `${ACCOUNTS_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

function newestMtimeMs(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const item of fs.readdirSync(p)) {
    newest = Math.max(newest, newestMtimeMs(path.join(p, item)));
  }
  return newest;
}

function listFilesRecursive(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const item of fs.readdirSync(dir)) {
    const abs = path.join(dir, item);
    const rel = prefix ? path.posix.join(prefix, item) : item;
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...listFilesRecursive(abs, rel));
    else if (st.isFile()) out.push({ abs, rel });
  }
  return out;
}

function latestRuntimeBackup() {
  if (!fs.existsSync(RUNTIME_BACKUPS_DIR)) return null;
  const dirs = fs.readdirSync(RUNTIME_BACKUPS_DIR)
    .map(name => {
      const p = path.join(RUNTIME_BACKUPS_DIR, name);
      try {
        const st = fs.statSync(p);
        return st.isDirectory() ? { name, path: p, mtime_ms: st.mtimeMs, mtime: st.mtime.toISOString() } : null;
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime_ms - a.mtime_ms);
  return dirs[0] || null;
}

function runtimeDataStatus() {
  const sources = [
    { key: 'accounts', label: 'accounts.json', path: ACCOUNTS_FILE },
    { key: 'profiles', label: 'profiles/', path: PROFILES_DIR },
    { key: 'master_csv', label: config.master_csv, path: MASTER_CSV },
  ].map(s => {
    const exists = fs.existsSync(s.path);
    return { ...s, exists, mtime_ms: exists ? newestMtimeMs(s.path) : 0 };
  });
  const existing = sources.filter(s => s.exists);
  const latestDataMtime = existing.reduce((m, s) => Math.max(m, s.mtime_ms), 0);
  const latestBackup = latestRuntimeBackup();
  const hasData = existing.length > 0;
  const backedUp = hasData && latestBackup && latestBackup.mtime_ms >= latestDataMtime;
  return {
    status: !hasData ? 'no_data' : backedUp ? 'backed_up' : 'needs_backup',
    backed_up: Boolean(backedUp),
    has_data: hasData,
    sources,
    latest_data_mtime: latestDataMtime ? new Date(latestDataMtime).toISOString() : null,
    latest_backup: latestBackup,
    backup_dir: RUNTIME_BACKUPS_DIR,
  };
}

function backupRuntimeData(reason) {
  const items = [
    { path: ACCOUNTS_FILE, name: 'accounts.json', kind: 'file' },
    { path: PROFILES_DIR, name: 'profiles', kind: 'dir' },
    { path: MASTER_CSV, name: path.basename(MASTER_CSV), kind: 'file' },
  ].filter(item => fs.existsSync(item.path));
  if (!items.length) return null;
  const dir = path.join(RUNTIME_BACKUPS_DIR, `${fileStamp()}-${safeName(reason)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of items) {
    const dst = path.join(dir, item.name);
    if (item.kind === 'dir') fs.cpSync(item.path, dst, { recursive: true });
    else fs.copyFileSync(item.path, dst);
  }
  return dir;
}

function createRuntimeBackupBundle() {
  const files = [];
  const addFile = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    files.push({
      path: rel,
      encoding: 'base64',
      content: fs.readFileSync(abs).toString('base64'),
    });
  };

  addFile(ACCOUNTS_FILE, 'accounts.json');
  addFile(MASTER_CSV, path.basename(MASTER_CSV));
  for (const item of listFilesRecursive(PROFILES_DIR, 'profiles')) addFile(item.abs, item.rel);

  return {
    type: 'typeless-toolkit-macos-runtime-backup',
    version: 1,
    created_at: new Date().toISOString(),
    files,
  };
}

function restoreRuntimeBackupBundle(bundle) {
  if (!bundle || bundle.type !== 'typeless-toolkit-macos-runtime-backup') throw new Error('备份包类型不正确');
  if (bundle.version !== 1) throw new Error('不支持的备份包版本:' + bundle.version);
  if (!Array.isArray(bundle.files)) throw new Error('备份包缺少 files');

  const currentBackup = backupRuntimeData('before-restore');
  const writes = [];
  for (const file of bundle.files) {
    const rel = String(file.path || '');
    if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\\')) throw new Error('备份包包含非法路径:' + rel);
    let dst = null;
    if (rel === 'accounts.json') dst = ACCOUNTS_FILE;
    else if (rel === path.basename(MASTER_CSV)) dst = MASTER_CSV;
    else if (rel.startsWith('profiles/')) dst = path.join(ROOT, rel);
    else throw new Error('备份包包含未知文件:' + rel);
    if (file.encoding !== 'base64') throw new Error('备份包文件编码不支持:' + rel);
    writes.push({ dst, content: Buffer.from(String(file.content || ''), 'base64') });
  }

  fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
  for (const item of writes) {
    fs.mkdirSync(path.dirname(item.dst), { recursive: true });
    fs.writeFileSync(item.dst, item.content);
  }
  const restoredBackup = backupRuntimeData('after-restore');
  return { current_backup: currentBackup, restored_backup: restoredBackup, restored_files: writes.length };
}

// ---------- 登录态快照(切换账号用) ----------
function profileDir(uid) { return path.join(PROFILES_DIR, uid); }
function saveSnapshot(uid) {
  const dir = profileDir(uid); fs.mkdirSync(dir, { recursive: true });
  for (const f of SNAPSHOT_FILES) {
    const src = path.join(USERDATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
}
function restoreSnapshot(uid) {
  const dir = profileDir(uid);
  fs.mkdirSync(USERDATA_DIR, { recursive: true });
  for (const f of SNAPSHOT_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(USERDATA_DIR, f));
  }
}
function hasSnapshot(uid) { return fs.existsSync(path.join(profileDir(uid), 'user-data.json')); }

// ---------- kill / launch ----------
function killTypeless() {
  try { execFileSync('osascript', ['-e', 'quit app "Typeless"'], { stdio: 'ignore' }); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    try { execFileSync('pgrep', ['-f', 'Typeless.app'], { stdio: 'ignore' }); }
    catch (e) { return; }
    try { execFileSync('sleep', ['0.5'], { stdio: 'ignore' }); } catch (e) {}
  }
  const names = [...new Set([path.basename(TYPELESS_BIN || ''), 'Typeless'].filter(Boolean))];
  for (const name of names) {
    try { execFileSync('pkill', ['-x', name], { stdio: 'ignore' }); } catch (e) {}
  }
}
function launchTypeless() {
  if (!TYPELESS_BIN) throw new Error('Typeless 路径未配置,无法启动');
  spawn(TYPELESS_BIN, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore' }).unref();
}

function deleteDeviceCredential() {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', MAC_KEYCHAIN_SERVICE,
      '-a', MAC_KEYCHAIN_ACCOUNT,
    ], { stdio: 'ignore' });
  } catch (e) {}
}

// ---------- 解除设备限制 ----------
async function resetDevice() {
  killTypeless(); await sleep(1500);
  // 1) 删 Keychain 里的设备 ID
  deleteDeviceCredential();
  // 2) 删 device.cache
  for (const p of DEVICE_CACHE_PATHS) {
    try { fs.unlinkSync(p); } catch (e) {}
  }
  // 3) 删 user-data.json(加密登录凭证,含设备绑定)
  try { fs.unlinkSync(path.join(USERDATA_DIR, 'user-data.json')); } catch (e) {}
  // 4) 清 app-storage 的 userData / quotaUsage
  try {
    const ap = path.join(USERDATA_DIR, 'app-storage.json');
    const a = JSON.parse(fs.readFileSync(ap, 'utf8'));
    delete a.userData; delete a.quotaUsage;
    fs.writeFileSync(ap, JSON.stringify(a, null, '\t'));
  } catch (e) {}
  // 5) 清 Local Storage / Cookies(登录残留)
  for (const sub of ['Local Storage', 'Network']) {
    try { fs.rmSync(path.join(USERDATA_DIR, sub), { recursive: true, force: true }); } catch (e) {}
  }
  for (const f of ['Cookies', 'Cookies-journal']) {
    try { fs.unlinkSync(path.join(USERDATA_DIR, f)); } catch (e) {}
  }
  launchTypeless();
}

// ---------- 主 CSV ----------
function readMaster() {
  if (!fs.existsSync(MASTER_CSV)) return [];
  return fs.readFileSync(MASTER_CSV, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function writeMaster(terms) {
  const uniq = [...new Set(terms.map(t => t.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  fs.writeFileSync(MASTER_CSV, uniq.join('\n') + '\n');
  return uniq;
}

// ---------- curl 调 Typeless API(走系统代理,数组传参避免 shell 转义) ----------
async function curlApi(method, p, token, body) {
  const tmp = path.join(os.tmpdir(), `typeless_${process.pid}_${Date.now()}.json`);
  const args = [
    '-s', '-m', '20', '-X', method,
    `${API_BASE}${p}`,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body !== undefined) {
    fs.writeFileSync(tmp, JSON.stringify(body));
    args.push('--data-binary', `@${tmp}`);
  }
  let out, errOut = '';
  try {
    const r = await execFileAsync('curl', args, { maxBuffer: 1 << 26 });
    out = r.stdout || ''; errOut = r.stderr || '';
  } catch (e) { out = (e.stdout || '') + ''; errOut = (e.stderr || '') + ''; }
  try { if (body !== undefined) fs.unlinkSync(tmp); } catch (e) {}
  try { return JSON.parse(out); }
  catch (e) { return { _error: 'non-json', _raw: out.slice(0, 200), _stderr: errOut.slice(0, 200) }; }
}

// ---------- CDP ----------
async function portUp() {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return r.ok; }
  catch (e) { return false; }
}
async function ensureApp() {
  if (await portUp()) return;
  log('Typeless 未带调试端口,正在以调试端口重启…');
  killTypeless();
  await sleep(1200);
  launchTypeless();
  for (let i = 0; i < 40; i++) { if (await portUp()) return; await sleep(500); }
}
async function withCDP(fn) {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      targets = await r.json();
      if (targets.length) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!targets || !targets.length) throw new Error('CDP 无响应,请确认 Typeless 已用 --remote-debugging-port=' + CDP_PORT + ' 启动');
  const t = targets.find(x => x.title === 'Typeless') || targets.find(x => x.type === 'page');
  if (!t) throw new Error('找不到 Typeless 渲染窗口');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    id++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('JS 错误: ' + (r.result.exceptionDetails.exception?.description?.slice(0, 300)));
    return r.result.result.value;
  };
  try { return await fn(send, ev); } finally { ws.close(); }
}

// 注入 fetch/XHR 捕获脚本(已验证逻辑)
const CAPTURE_SCRIPT = `(function(){
  window.__captured=[];
  const of=window.fetch;
  window.fetch=function(u,o){
    try{
      const a=o&&(o.headers&&(o.headers.Authorization||o.headers.authorization))
        ||((o&&o.headers&&o.headers.get)?o.headers.get('Authorization'):null);
      if(a)window.__captured.push({url:String(u),auth:String(a)});
    }catch(e){}
    return of.apply(this,arguments);
  };
  const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return oo.apply(this,arguments);};
  XMLHttpRequest.prototype.setRequestHeader=function(k,v){
    if(/authorization/i.test(k))window.__captured.push({url:String(this.__u),auth:String(v)});
    return os.apply(this,arguments);
  };
})();`;

function accountMetaFromUserInfo(userInfo, fallbackId) {
  const email = userInfo?.email || '';
  const name = userInfo?.name || '';
  const role = userInfo?.subscription_plan_name
    || userInfo?.subscription_type
    || userInfo?.roles?.[0]?.name
    || userInfo?.roles?.[0]
    || '';
  return {
    email,
    nickname: name || email || (fallbackId || '').slice(0, 8),
    role,
  };
}

// 抓 token: 注入捕获 → 重载 → 读 window.__captured 里的 Bearer
async function captureTokenCDP(port, autoRestart = true) {
  const usePort = port || CDP_PORT;
  // 检查端口是否就绪
  let ready = false;
  try { ready = (await fetch(`http://127.0.0.1:${usePort}/json/version`)).ok; } catch (e) {}
  if (!ready) {
    // autoRestart=false(如打开管理器时的自动检测)不杀 Typeless,避免一打开就打断用户正在用的 Typeless
    if (!autoRestart) throw new Error('Typeless 未以调试端口运行');
    await ensureApp();
  }
  return withCDP(async (send, ev) => {
    await send('Page.enable');
    const sid = (await send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT })).result.identifier;
    await send('Page.reload');
    await sleep(6000);
    const captured = JSON.parse(await ev('JSON.stringify(window.__captured||[])') || '[]');
    try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch (e) {}
    const hit = captured.find(c => /Bearer\s+\S+/.test(c.auth));
    if (!hit) throw new Error('未抓到 token,请确认 Typeless 已登录账号后再试');
    const token = hit.auth.replace(/^Bearer\s+/, '');
    const origin = (() => { try { return new URL(hit.url).origin; } catch (e) { return API_BASE; } })();
    // 附带 user_info(若失败不阻断)
    let user_info = null;
    try {
      const ui = await curlApi('GET', '/user/get_user_info', token);
      user_info = ui.data || null;
    } catch (e) {}
    // 解 JWT payload 取 user_id
    let user_id = null, payload = null;
    try {
      payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      user_id = payload.subject?.user_id;
    } catch (e) {}
    return { token, origin, user_id, user_info, ...accountMetaFromUserInfo(user_info, user_id), captured_at: new Date().toISOString() };
  });
}

// ---------- 实时状态 ----------
async function liveStatus(acc) {
  const out = { token_valid: true, usage: null, personal: null, dict_count: 0, user_info: null };
  try {
    const [ui, us, ps, dl] = await Promise.all([
      curlApi('GET', '/user/get_user_info', acc.token),
      curlApi('POST', '/user/usage_stats', acc.token, {}),
      curlApi('POST', '/user/personal_stats', acc.token, {}),
      curlApi('GET', '/user/dictionary/list?size=500', acc.token),
    ]);
    out.user_info = ui.data || null;
    out.usage = us.data?.voice_transcription || null;
    out.personal = ps.data || null;
    out.dict_count = dl.data?.total_count ?? 0;
    if (ui.detail && /Unauthorized|invalid|expired/i.test(JSON.stringify(ui))) out.token_valid = false;
  } catch (e) { out.token_valid = false; out._err = e.message; }
  return out;
}

// ---------- 同步(单账号:导出→合并主 CSV→补齐缺失) ----------
async function syncAccount(acc) {
  const dl = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
  const accountWords = (dl.data?.words || []).map(w => w.term).filter(Boolean);
  const masterBefore = readMaster();
  const masterMerged = writeMaster([...masterBefore, ...accountWords]);
  const accountKeys = new Set(accountWords.map(termKey));
  const missing = masterMerged.filter(w => !accountKeys.has(termKey(w)));
  let imported = 0;
  if (missing.length) {
    const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: missing.join('\n') });
    imported = r.data?.success_count ?? 0;
  }
  return { exported: accountWords.length, imported, master_count: masterMerged.length };
}

// ---------- 弹窗补丁(两层 asar 完整性) ----------
// 自动探测 asar 内可能包含 paywall 分支的 renderer 目标文件
function detectPaywallFile(header) {
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) { walk(child, p); }
      else if (child.offset !== undefined && /\.(mjs|js)$/i.test(name)) found.push(p);
    }
  };
  walk(header, '');
  return found; // 相对路径数组(用 / 分隔)
}

function getAsarNode(header, filePath) {
  let node = header;
  for (const k of filePath) {
    if (!node || !node.files) return null;
    node = node.files[k];
  }
  return node || null;
}

function scorePaywallCandidate(rel, content) {
  const text = content.toString('utf8');
  let score = 0;
  if (/dist\/renderer\/static\/js\//.test(rel)) score += 10;
  if (/\[['"]type['"]\]\s*===\s*['"]paywall['"]/.test(text)) score += 100;
  if (/onImportantNotification|onSessionInterrupt|ImportantNotification|SessionInterrupt/.test(text)) score += 50;
  if (/paywall/i.test(text)) score += 1;
  return score;
}

function findPaywallTarget(header, buf, dataStart) {
  let best = null;
  for (const rel of detectPaywallFile(header)) {
    const parts = rel.split('/');
    const node = getAsarNode(header, parts);
    if (!node) continue;
    const off = dataStart + (+node.offset), sz = node.size;
    const content = buf.subarray(off, off + sz);
    const score = scorePaywallCandidate(rel, content);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { parts, node, score };
  }
  return best;
}

function getEffectivePaywallReplacements(content) {
  const configured = (config.paywall.replacements || []).filter(x => x && x.length === 2);
  if (configured.length) {
    const allConfiguredExist = configured.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    if (allConfiguredExist) return { replacements: configured, source: 'config' };
  }
  if (!config.paywall.auto_detect_replacements) return { replacements: configured, source: 'config' };

  const text = content.toString('utf8');
  const re = /if\(([$_A-Za-z][$_A-Za-z0-9]*)\['type'\]==='paywall'\)(?:([$_A-Za-z][$_A-Za-z0-9]*)\(\1\)|\(0,\1\));else/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const from = m[2] ? `${m[2]}(${m[1]})` : `__already_patched_paywall__(${m[1]})`;
    const to = `(0,${m[1]})`;
    if (m[2] && from.length !== to.length) continue;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push([from, to]);
  }
  if (out.length) return { replacements: out, source: 'auto' };
  return { replacements: configured, source: 'config' };
}

function updateMacAsarIntegrityHash(newHeaderHash) {
  if (!MAC_INFO_PLIST || !fs.existsSync(MAC_INFO_PLIST)) throw new Error('Info.plist 未找到,无法更新 macOS asar 完整性');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHeaderHash}`,
    MAC_INFO_PLIST,
  ]);
}

function resignMacApp() {
  if (!MAC_APP_PATH || !fs.existsSync(MAC_APP_PATH)) throw new Error('Typeless.app 未找到,无法重新签名');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', MAC_APP_PATH], { stdio: 'ignore' });
}

function asarToTmp() {
  const tmp = path.join(os.tmpdir(), `tt_asar_${process.pid}_${Date.now()}.bin`);
  fs.copyFileSync(ASAR_PATH, tmp);
  return tmp;
}

function tmpToAsar(tmp) {
  fs.copyFileSync(tmp, ASAR_PATH);
}

// 只读检测:app.asar 内目标文件是否已打过补丁
function paywallStatus() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) return { exists: false, error: 'app.asar 未找到(Typeless.app 路径未配置?)' };
  let tmpAsar = null;
  try {
    tmpAsar = asarToTmp();
    const buf = fs.readFileSync(tmpAsar);
    const jl = buf.readUInt32LE(12);
    const dataStart = 16 + jl + ((16 + jl) % 4 ? (4 - ((16 + jl) % 4)) : 0);
    const header = JSON.parse(buf.subarray(16, 16 + jl).toString('utf8'));

    // 确定目标文件路径:先用 config 的 file_path,找不到则自动探测
    let filePath = config.paywall.file_path;
    let detected = false;
    let node = filePath.length ? getAsarNode(header, filePath) : null;
    if (!node && config.paywall.auto_detect_file) {
      const target = findPaywallTarget(header, buf, dataStart);
      if (target) { filePath = target.parts; node = target.node; detected = true; }
    }
    if (!node) {
      return {
        exists: true, patched: false,
        error: 'asar 内未找到目标文件(config.paywall.file_path 不匹配,且自动探测未找到含 paywall 的 .mjs)。' +
               '请阅读 README「弹窗补丁适配」章节,定位你版本的文件后填入 config.json',
      };
    }
    const foff = dataStart + (+node.offset), size = node.size;
    const content = buf.subarray(foff, foff + size);
    // 检查所有替换标记
    const effective = getEffectivePaywallReplacements(content);
    const repls = effective.replacements;
    if (!repls.length) {
      return {
        exists: true,
        patched: false,
        detected_file: detected ? filePath.join('/') : null,
        file_path: filePath.join('/'),
        replacements_source: effective.source,
        replacements: repls,
        has_backup: fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak'),
        error: '未配置且未自动识别到 paywall 替换标记',
      };
    }
    const hasOld = repls.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    const hasNew = repls.every(([, to]) => content.includes(Buffer.from(to, 'utf8')));
    return {
      exists: true,
      patched: !hasOld && hasNew,
      detected_file: detected ? filePath.join('/') : null,
      file_path: filePath.join('/'),
      replacements_source: effective.source,
      replacements: repls,
      has_backup: fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak'),
    };
  } catch (e) { return { exists: false, error: e.message }; }
  finally { if (tmpAsar) try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 执行补丁:内容替换 + 同步 per-file SHA256 + 同步平台完整性记录
function patchPaywall() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) throw new Error('app.asar 未找到(Typeless 路径未配置?)');
  if (!TYPELESS_BIN || !fs.existsSync(TYPELESS_BIN)) throw new Error('Typeless 可执行文件未找到');
  if (!MAC_INFO_PLIST || !fs.existsSync(MAC_INFO_PLIST)) throw new Error('Info.plist 未找到,无法同步 macOS asar 完整性');
  const asarBak = ASAR_PATH + '.bak', plistBak = MAC_INFO_PLIST + '.bak';
  // 首次备份
  if (!fs.existsSync(asarBak)) {
    try { fs.copyFileSync(ASAR_PATH, asarBak); } catch (e) {}
  }
  if (!fs.existsSync(plistBak)) fs.copyFileSync(MAC_INFO_PLIST, plistBak);

  // 复制到临时非 .asar 文件操作,绕过 asar hook;最后覆盖回原 asar
  const tmpAsar = asarToTmp();
  try {
    const fd = fs.openSync(tmpAsar, 'r+');
    const fsize = fs.statSync(tmpAsar).size;
    const buf = Buffer.alloc(fsize);
    fs.readSync(fd, buf, 0, fsize, 0);
    const jl = buf.readUInt32LE(12);
    const dataStart = 16 + jl + ((16 + jl) % 4 ? (4 - ((16 + jl) % 4)) : 0);
    const headerStart = 16, headerEnd = 16 + jl;
    const header = JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8'));

    // 定位目标文件(同 paywallStatus 逻辑)
    let filePath = config.paywall.file_path;
    let node = filePath.length ? getAsarNode(header, filePath) : null;
    if (!node && config.paywall.auto_detect_file) {
      const target = findPaywallTarget(header, buf, dataStart);
      if (target) { filePath = target.parts; node = target.node; }
    }
    if (!node) throw new Error('asar 内未找到目标文件,请阅读 README「弹窗补丁适配」章节定位你版本的文件后填入 config.json');

    const foff = dataStart + (+node.offset), size = node.size;
    const oldHash = node.integrity.hash;
    const content = Buffer.from(buf.subarray(foff, foff + size));

    const effective = getEffectivePaywallReplacements(content);
    const repls = effective.replacements.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
    if (!repls.length) throw new Error('未配置且未自动识别到 paywall 替换标记');
    // 幂等:已打过则跳过
    const alreadyPatched = repls.every(([from], i) => !content.includes(from) && content.includes(repls[i][1]));
    if (alreadyPatched) {
      fs.closeSync(fd);
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }

    // 1) 内容补丁(等长替换)
    for (const [from, to] of repls) {
      const i = content.indexOf(from);
      if (i < 0) throw new Error(
        '未找到标记 ' + from.toString() + ',你的 Typeless 版本可能不同。' +
        '请阅读 README「弹窗补丁适配」章节,用 DevTools 定位你版本的函数名后填入 config.json'
      );
      if (i !== content.lastIndexOf(from)) throw new Error('标记不唯一(异常):' + from.toString());
      to.copy(content, i);
    }
    const newHash = crypto.createHash('sha256').update(content).digest('hex');

    // 2) 旧 asar 头 SHA256,也就是 Info.plist 里现存的 ElectronAsarIntegrity hash
    const oldHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

    // 3) 头里替换 per-file hash(integrity.hash 与 blocks[0],共 2 处,等长 64 hex)
    const headerBuf = buf.subarray(headerStart, headerEnd);
    const oldHB = Buffer.from(oldHash, 'utf8'), newHB = Buffer.from(newHash, 'utf8');
    if (oldHB.length !== newHB.length) throw new Error('hash 长度不一致(异常)');
    let cnt = 0, idxs = [], p = headerBuf.indexOf(oldHB);
    while (p >= 0) { cnt++; idxs.push(p); p = headerBuf.indexOf(oldHB, p + 1); }
    if (cnt !== 2) throw new Error('头里旧 per-file hash 出现 ' + cnt + ' 次,预期 2 次(asar 结构异常)');
    for (const pp of idxs) newHB.copy(headerBuf, pp);

    // 4) 新整头 SHA256(头里 per-file 已改)
    const newHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

    // 5) 写回临时 asar 的内容区 + 头区
    fs.writeSync(fd, content, 0, size, foff);
    fs.writeSync(fd, headerBuf, 0, headerBuf.length, headerStart);
    fs.closeSync(fd);

    // 6) 覆盖 app.asar,同步 Info.plist 完整性,并用 ad-hoc 签名让本机可运行
    tmpToAsar(tmpAsar);
    updateMacAsarIntegrityHash(newHeaderHash);
    resignMacApp();

    return {
      already: false, done: true,
      replacements_source: effective.source,
      replacements: effective.replacements,
      plist: MAC_INFO_PLIST,
      signed: true,
      file_hash: { old: oldHash, new: newHash },
      header_hash: { old: oldHeaderHash, new: newHeaderHash },
      msg: '补丁已打好,升级/会员弹窗将不再弹出(重启 Typeless 生效)',
    };
  } catch (e) {
    // 失败:尽量从备份还原应用完整性相关文件
    try { if (fs.existsSync(asarBak)) fs.copyFileSync(asarBak, ASAR_PATH); } catch (_) {}
    try { if (plistBak && fs.existsSync(plistBak)) fs.copyFileSync(plistBak, MAC_INFO_PLIST); } catch (_) {}
    throw e;
  } finally { try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

module.exports = {
  // 常量
  ROOT, CODE_DIR, config, DEFAULT_CONFIG,
  TYPELESS_BIN, USERDATA_DIR, DEVICE_CACHE_PATHS,
  MAC_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT, MAC_APP_PATH, MAC_INFO_PLIST, ASAR_PATH,
  API_BASE, CDP_PORT, MASTER_CSV, PROFILES_DIR, ACCOUNTS_FILE, RUNTIME_BACKUPS_DIR, SNAPSHOT_FILES,
  // 工具
  log, sleep, execFileAsync, termKey,
  detectTypelessExe, loadConfig, detectUserDataDir, detectAsarPath, accountMetaFromUserInfo,
  // 账号 / 快照
  readAccounts, writeAccounts, backupRuntimeData, runtimeDataStatus, createRuntimeBackupBundle, restoreRuntimeBackupBundle,
  saveSnapshot, restoreSnapshot, hasSnapshot,
  // kill / launch / 设备
  killTypeless, launchTypeless, resetDevice,
  // 主 CSV
  readMaster, writeMaster,
  // API + CDP
  curlApi, ensureApp, captureTokenCDP,
  // 状态 + 同步
  liveStatus, syncAccount,
  // 弹窗补丁
  paywallStatus, patchPaywall,
};
