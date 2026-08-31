/**
 * Typeless 工具集共享模块
 *
 * manager.js 与 typeless-dict-sync.js 的共同底座,自己负责:
 *   - 路径常量、配置加载、Typeless 可执行文件探测
 *   - curl 调 API(走系统代理,数组传参避免 shell 转义)
 *   - CDP 抓 token(注入 fetch/XHR 捕获 + 重载 + 读 window.__captured)
 *   - 账号存储、登录态快照、主 CSV、kill/launch、实时状态、单账号同步、版本漂移
 *
 * 三个自成闭环的子系统已各自独立,由本文件在底部装配并统一对外转发:
 *   - lib/private-fs.js       0700/0600 私有文件原语
 *   - lib/runtime-backup.js   运行数据备份 / 恢复事务
 *   - lib/paywall-patch.js    去弹窗补丁(app.asar + Info.plist + 重签名)
 *
 * 全部路径来自 config.json + 环境变量,禁止任何硬编码用户目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { initializeRuntimeData } = require('./runtime-data');
const {
  fileStamp,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
  copyPrivateFile,
} = require('./private-fs');
const { createRuntimeBackup } = require('./runtime-backup');
const { createPaywallPatch } = require('./paywall-patch');

const execFileAsync = promisify(execFile);
// 优先 ws 包(打包版 Electron 主进程可能无可用全局 WebSocket);开发版无 ws 包则用全局
const WebSocket = (() => {
  try { const W = require('ws'); if (typeof W === 'function') return W; } catch (e) {}
  return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : undefined;
})();

// 代码与运行数据分离:源码/release 可替换,账号和备份固定留在 Application Support。
const CODE_DIR = path.join(__dirname, '..');
function migrationMasterCsvName() {
  let name = 'Typeless词库主清单.csv';
  const override = typeof process.env.TYPELESS_DATA_DIR === 'string' && process.env.TYPELESS_DATA_DIR.trim()
    ? process.env.TYPELESS_DATA_DIR.trim().replace(/^~(?=$|\/|\\)/, os.homedir())
    : null;
  const prospectiveRoot = path.resolve(
    override || path.join(os.homedir(), 'Library', 'Application Support', 'Typeless Toolkit'),
  );
  const stableLocal = path.join(prospectiveRoot, 'config.local.json');
  const localConfig = fs.existsSync(stableLocal) ? stableLocal : path.join(CODE_DIR, 'config.local.json');
  for (const file of [path.join(CODE_DIR, 'config.json'), localConfig]) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`配置文件解析失败: ${file}: ${e.message}`); }
    if (parsed && typeof parsed.master_csv === 'string' && parsed.master_csv.trim()) name = parsed.master_csv.trim();
  }
  if (path.basename(name) !== name) throw new Error('master_csv 只能是数据目录内的文件名');
  return name;
}
const RUNTIME_DATA = initializeRuntimeData({
  codeDir: CODE_DIR,
  masterCsvName: migrationMasterCsvName(),
});
const ROOT = RUNTIME_DATA.dataDir;

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
  // 仓库内 config.json 是默认值;稳定数据目录里的 config.local.json 是本机覆盖。
  const candidates = [path.join(CODE_DIR, 'config.json'), path.join(ROOT, 'config.local.json')];
  let cfg = {};
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8') || '{}') }; }
      catch (e) { throw new Error(`配置文件解析失败: ${p}: ${e.message}`); }
    }
  }
  // 深合并 paywall
  cfg.paywall = { ...DEFAULT_CONFIG.paywall, ...(cfg.paywall || {}) };
  if (!Array.isArray(cfg.paywall.file_path)) cfg.paywall.file_path = DEFAULT_CONFIG.paywall.file_path;
  if (!Array.isArray(cfg.paywall.replacements)) cfg.paywall.replacements = DEFAULT_CONFIG.paywall.replacements;
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  if (!merged.master_csv || path.basename(merged.master_csv) !== merged.master_csv) {
    throw new Error('master_csv 只能是稳定数据目录内的文件名');
  }
  return merged;
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
const PATCH_BACKUPS_DIR = path.join(ROOT, 'patch-backups');
const VERSION_STATE_FILE = path.join(ROOT, 'typeless-version.json');
const SNAPSHOT_FILES = ['app-storage.json', 'user-data.json', 'app-onboarding.json'];

// ---------- 工具 ----------
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const termKey = s => String(s || '').trim().toLocaleLowerCase();
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function assertSafeAccountId(uid) {
  const value = String(uid || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('账号 ID 格式不安全');
  return value;
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
    try { copyPrivateFile(ACCOUNTS_FILE, backup); } catch (_) {}
    throw new Error(`accounts.json 解析失败,已保留损坏文件备份: ${backup}`);
  }
}
function writeAccounts(a) {
  if (!Array.isArray(a)) throw new Error('writeAccounts 需要数组');
  ensurePrivateDirectory(ROOT);
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      copyPrivateFile(ACCOUNTS_FILE, `${ACCOUNTS_FILE}.bak`);
    } catch (_) {}
  }
  writePrivateFileAtomic(ACCOUNTS_FILE, JSON.stringify(a, null, 2));
}

// ---------- 登录态快照(切换账号用) ----------
function profileDir(uid) { return path.join(PROFILES_DIR, assertSafeAccountId(uid)); }
function saveSnapshot(uid) {
  const dir = profileDir(uid); ensurePrivateDirectory(dir);
  for (const f of SNAPSHOT_FILES) {
    const src = path.join(USERDATA_DIR, f);
    if (fs.existsSync(src)) {
      copyPrivateFile(src, path.join(dir, f));
    }
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
function snapshotMtime(uid) {
  const p = path.join(profileDir(uid), 'user-data.json');
  try { return fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null; }
  catch (e) { return null; }
}

// ---------- kill / launch ----------
// 全程异步。此前用 execFileSync('sleep', ['0.5']) 起一个子进程什么都不干只为等半秒,
// 最多 10 轮就是最多 20 个子进程,并把 Node 事件循环整块阻塞最长约 5 秒。管理器是单线程
// HTTP 服务,阻塞期间任何请求都排在后面 —— 切号、重置设备、打补丁、以及 ensureApp
// 经 stopApp 的那条路径都会踩到。
async function killTypeless() {
  try { await execFileAsync('osascript', ['-e', 'quit app "Typeless"']); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    try { await execFileAsync('pgrep', ['-f', 'Typeless.app']); }
    catch (e) { return; }
    await sleep(500);
  }
  const names = [...new Set([path.basename(TYPELESS_BIN || ''), 'Typeless'].filter(Boolean))];
  for (const name of names) {
    try { await execFileAsync('pkill', ['-x', name]); } catch (e) {}
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
  await killTypeless(); await sleep(1500);
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
  writePrivateFileAtomic(MASTER_CSV, uniq.join('\n') + '\n');
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
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
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

// Typeless API 约定:成功返回 { status: 'OK', data: ... }。curlApi 解析不出 JSON 时
// 返回 { _error: 'non-json' },两种失败都不能当成「空结果」继续往下走,否则
// 「token 失效 / 断网」会被伪装成「词库为空、同步完成 0 条」。
// 只用在用户显式触发的操作上;liveStatus 那种批量轮询仍然容错(单个账号失败不该拖垮整个列表)。
function assertApiOk(resp, what) {
  if (resp && resp.status === 'OK') return resp;
  let detail;
  if (resp && resp._error === 'non-json') detail = `响应不是 JSON:${String(resp._raw || '').slice(0, 120)}`;
  else if (resp && (resp.msg || resp.detail)) detail = String(resp.msg || resp.detail).slice(0, 200);
  else detail = JSON.stringify(resp ?? null).slice(0, 200);
  throw new Error(`${what}失败:${detail}`);
}

// ---------- CDP ----------
function selectTypelessCdpTarget(targets, options = {}) {
  const port = options.port || CDP_PORT;
  const asarPath = options.asarPath || ASAR_PATH;
  if (!Array.isArray(targets) || !asarPath) return null;
  const expectedUrlPrefix = pathToFileURL(asarPath).href + '/';
  return targets.find(target => {
    if (!target || target.type !== 'page' || target.title !== 'Typeless'
      || typeof target.url !== 'string' || !target.url.startsWith(expectedUrlPrefix)
      || typeof target.webSocketDebuggerUrl !== 'string') return false;
    try {
      const ws = new URL(target.webSocketDebuggerUrl);
      return ws.protocol === 'ws:'
        && (ws.hostname === '127.0.0.1' || ws.hostname === '::1' || ws.hostname === 'localhost')
        && Number(ws.port) === Number(port);
    } catch (_) { return false; }
  }) || null;
}
async function fetchTypelessCdpTarget(port = CDP_PORT, fetchFn = fetch) {
  const response = await fetchFn(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) return null;
  return selectTypelessCdpTarget(await response.json(), { port });
}
// 探测管理端口现状。区分「没人监听」和「被别的程序占着」很重要:
// 后者杀多少次 Typeless 都没用(Electron 绑不上已占用的端口,而且是静默失败)。
//   down     - 没有进程监听,重启 Typeless 有意义
//   foreign  - 有进程在监听,但不是 Typeless 的调试端口
//   no-target- 是 Typeless 的调试端口,但还没有可用的主窗口
//   ready    - 是 Typeless,且主窗口可连
async function probeCdpPort(port = CDP_PORT, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
  } catch (e) {
    return { status: 'down' };
  }
  if (!response.ok) return { status: 'foreign', detail: `该端口回应 HTTP ${response.status}` };
  let version;
  try { version = await response.json(); }
  catch (e) { return { status: 'foreign', detail: '该端口回应的不是 CDP 协议' }; }
  if (!/Typeless\//.test(String(version?.['User-Agent'] || ''))) {
    return { status: 'foreign', detail: '该端口属于另一个程序的调试端口' };
  }
  return await fetchTypelessCdpTarget(port, fetchFn)
    ? { status: 'ready' }
    : { status: 'no-target' };
}
async function portUp(port = CDP_PORT, fetchFn = fetch) {
  try { return (await probeCdpPort(port, fetchFn)).status === 'ready'; }
  catch (e) { return false; }
}
async function typelessConnectionStatus(options = {}) {
  const checkPort = options.portUp || portUp;
  const cdpReachable = Boolean(await checkPort());
  return {
    state: cdpReachable ? 'connected' : 'disconnected',
    port: CDP_PORT,
    cdp_reachable: cdpReachable,
  };
}
async function ensureApp(options = {}) {
  const probe = options.probePort || probeCdpPort;
  const stopApp = options.killTypeless || killTypeless;
  const startApp = options.launchTypeless || launchTypeless;
  const wait = options.sleep || sleep;
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 40;
  const restartDelayMs = Number.isFinite(options.restartDelayMs) ? options.restartDelayMs : 1200;
  const pollDelayMs = Number.isFinite(options.pollDelayMs) ? options.pollDelayMs : 500;

  const first = await probe();
  if (first.status === 'ready') {
    return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: false };
  }
  if (first.status === 'foreign') {
    const error = new Error(
      `管理端口 ${CDP_PORT} 已被其它程序占用(${first.detail}),Typeless 无法绑定它。` +
      `请退出占用该端口的程序,或在 config.local.json 里把 cdp_port 改成别的端口。`
    );
    error.code = 'CDP_PORT_CONFLICT';
    throw error;
  }
  log('Typeless 未带调试端口,正在以调试端口重启…');
  await stopApp();
  await wait(restartDelayMs);
  startApp();
  for (let i = 0; i < attempts; i++) {
    if ((await probe()).status === 'ready') {
      return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: true };
    }
    if (i < attempts - 1) await wait(pollDelayMs);
  }
  const error = new Error(`Typeless 启动后仍无法连接管理端口 ${CDP_PORT}`);
  error.code = 'CDP_START_TIMEOUT';
  throw error;
}
async function withCDP(fn) {
  let target;
  for (let i = 0; i < 40; i++) {
    try { target = await fetchTypelessCdpTarget(CDP_PORT); } catch (e) {}
    if (target) break;
    await sleep(500);
  }
  if (!target) throw new Error('找不到 Typeless 管理窗口,请确认 Typeless 已用 --remote-debugging-port=' + CDP_PORT + ' 启动');
  if (typeof WebSocket !== 'function') throw new Error('当前 Node.js 缺少 WebSocket 支持,请使用 Node.js 22+');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('连接 Typeless WebSocket 超时'));
    }, 3000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连接 Typeless WebSocket 失败')); };
  });
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const item = pending.get(m.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(m.id);
      item.resolve(m);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    id++;
    const requestId = id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Typeless CDP 命令超时: ${method}`));
    }, 5000);
    pending.set(requestId, { resolve, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('JS 错误: ' + (r.result.exceptionDetails.exception?.description?.slice(0, 300)));
    return r.result.result.value;
  };
  try { return await fn(send, ev); }
  finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    ws.close();
  }
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

// 解 JWT payload(base64url 中段),失败返回 null
function decodeJwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
  catch (e) { return null; }
}

// token 剩余有效期(取 JWT payload.exp,单位秒)
function tokenExpiryInfo(token) {
  const payload = decodeJwtPayload(token);
  const expSec = payload?.exp;
  if (!expSec) return { token_expires_at: null, token_days_left: null };
  const expMs = expSec * 1000;
  return {
    token_expires_at: new Date(expMs).toISOString(),
    token_days_left: Math.ceil((expMs - Date.now()) / 86400000),
  };
}

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
async function captureTokenCDP(autoRestart = true) {
  // 检查端口是否就绪
  let ready = false;
  try { ready = await portUp(); } catch (e) {}
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
    const payload = decodeJwtPayload(token);
    const user_id = payload?.subject?.user_id || null;
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
  // 读词库失败必须抛错:否则会被当成「该账号词库为空」,进而把整个主词库回灌一遍,
  // 并对用户报告「同步完成,导出 0 条」——一次静默的假成功。
  const dl = assertApiOk(await curlApi('GET', '/user/dictionary/list?size=500', acc.token), '读取账号词库');
  const accountWords = (dl.data?.words || []).map(w => w.term).filter(Boolean);
  const masterBefore = readMaster();
  const masterMerged = writeMaster([...masterBefore, ...accountWords]);
  const accountKeys = new Set(accountWords.map(termKey));
  const missing = masterMerged.filter(w => !accountKeys.has(termKey(w)));
  let imported = 0;
  if (missing.length) {
    const r = assertApiOk(
      await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: missing.join('\n') }),
      '导入词库',
    );
    imported = safeCount(r.data?.success_count);
  }
  return { exported: accountWords.length, imported, master_count: masterMerged.length };
}

// ---------- Typeless 版本漂移探测 ----------
// 只做一件事:记录「上次见过的 Typeless 版本」,升级后提示可能需要复验抓 token / 补丁 / 路径等能力。
// 不自动跑任何复验,只检测 + 提示。
function getTypelessVersion() {
  if (!MAC_INFO_PLIST || !fs.existsSync(MAC_INFO_PLIST)) return null;
  try {
    const out = execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', MAC_INFO_PLIST], { encoding: 'utf8' });
    return out.trim() || null;
  } catch (e) { return null; }
}
function readVersionState() {
  try {
    if (!fs.existsSync(VERSION_STATE_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(VERSION_STATE_FILE, 'utf8'));
    return d && typeof d.version === 'string' ? d : null;
  } catch (e) { return null; }
}
function writeVersionState(version) {
  const data = { version, recorded_at: new Date().toISOString() };
  writePrivateFileAtomic(VERSION_STATE_FILE, JSON.stringify(data, null, 2));
  return data;
}
// 纯比较:两个都在且不同才算漂移(首次无基线 / 读不到版本都不算)
function computeVersionDrift(current, lastSeen) {
  return Boolean(current && lastSeen && current !== lastSeen);
}
function versionDriftStatus() {
  const current = getTypelessVersion();
  const state = readVersionState();
  const last_seen = state?.version || null;
  return { current, last_seen, drifted: computeVersionDrift(current, last_seen), recorded_at: state?.recorded_at || null };
}

// ---------- 子系统装配 ----------
// 备份/恢复事务与弹窗补丁各自独立成模块,路径统一在这里算好后注入,避免两处各算一遍。
const {
  runtimeDataStatus,
  backupRuntimeData,
  createRuntimeBackupBundle,
  restoreRuntimeBackupBundle,
  recoverIncompleteRuntimeRestores,
} = createRuntimeBackup({
  root: ROOT,
  accountsFile: ACCOUNTS_FILE,
  profilesDir: PROFILES_DIR,
  masterCsv: MASTER_CSV,
  masterCsvLabel: config.master_csv,
  backupsDir: RUNTIME_BACKUPS_DIR,
});

const { paywallStatus, patchPaywall, recoverInterruptedPatches } = createPaywallPatch({
  paywallConfig: config.paywall,
  asarPath: ASAR_PATH,
  infoPlist: MAC_INFO_PLIST,
  appPath: MAC_APP_PATH,
  typelessBin: TYPELESS_BIN,
  patchBackupsDir: PATCH_BACKUPS_DIR,
  getAppVersion: getTypelessVersion,
});

// 模块加载时先处理上次被 SIGKILL/断电打断的事务,再提供任何管理能力。
recoverInterruptedPatches();
recoverIncompleteRuntimeRestores();

// 首次从旧 release 目录迁移完成后,立刻在稳定目录内留一份完整快照。
// 旧源仍保留,这份 post-migration 备份用于新的固定备份状态检测。
if (RUNTIME_DATA.migration.status === 'migrated') backupRuntimeData('post-migration');

module.exports = {
  // 常量
  ROOT, CODE_DIR, RUNTIME_DATA, config,
  TYPELESS_BIN, USERDATA_DIR, MAC_APP_PATH, MAC_INFO_PLIST, ASAR_PATH,
  CDP_PORT, MASTER_CSV, PROFILES_DIR, ACCOUNTS_FILE, RUNTIME_BACKUPS_DIR, VERSION_STATE_FILE,
  // 工具
  log, sleep, termKey, safeCount, assertSafeAccountId, accountMetaFromUserInfo,
  // 账号 / 快照
  readAccounts, writeAccounts, backupRuntimeData, runtimeDataStatus, createRuntimeBackupBundle,
  restoreRuntimeBackupBundle, recoverIncompleteRuntimeRestores,
  saveSnapshot, restoreSnapshot, hasSnapshot, snapshotMtime,
  decodeJwtPayload, tokenExpiryInfo,
  // kill / launch / 设备
  killTypeless, launchTypeless, resetDevice,
  // 主 CSV
  readMaster, writeMaster,
  // API + CDP
  curlApi, assertApiOk, selectTypelessCdpTarget, probeCdpPort, typelessConnectionStatus, ensureApp, captureTokenCDP,
  // 状态 + 同步
  liveStatus, syncAccount,
  // 弹窗补丁
  paywallStatus, patchPaywall,
  // Typeless 版本漂移
  getTypelessVersion, versionDriftStatus, writeVersionState, readVersionState, computeVersionDrift,
};
