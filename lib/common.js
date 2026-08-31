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
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const {
  fileStamp,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
  copyPrivateFile,
} = require('./private-fs');
const { createRuntimeBackup } = require('./runtime-backup');
const { createPaywallPatch } = require('./paywall-patch');
const { createCdp } = require('./cdp');
// 路径与配置全部来自 lib/paths.js。注意 require 它有副作用:模块加载时会跑
// initializeRuntimeData()(旧运行数据迁移),必须保持在这里、保持只有这一次。
const {
  CODE_DIR, ROOT, RUNTIME_DATA, config,
  TYPELESS_BIN, USERDATA_DIR, DEVICE_CACHE_PATHS,
  MAC_APP_PATH, MAC_INFO_PLIST, ASAR_PATH,
  MAC_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT,
  ACCOUNTS_FILE, PROFILES_DIR, MASTER_CSV,
  RUNTIME_BACKUPS_DIR, PATCH_BACKUPS_DIR, VERSION_STATE_FILE,
  SNAPSHOT_FILES,
  API_BASE, CDP_PORT,
} = require('./paths');

const execFileAsync = promisify(execFile);
// 优先 ws 包(打包版 Electron 主进程可能无可用全局 WebSocket);开发版无 ws 包则用全局
// 代码与运行数据分离:源码/release 可替换,账号和备份固定留在 Application Support。

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
// ---------- CDP 子系统装配 ----------
// 放在这里(而不是文件底部)是因为 liveStatus / manager.js 都要用它导出的 ensureApp
// 等函数,而它反过来要注入本文件上面定义的 curlApi / killTypeless / decodeJwtPayload。
const {
  selectTypelessCdpTarget,
  fetchTypelessCdpTarget,
  probeCdpPort,
  portUp,
  typelessConnectionStatus,
  ensureApp,
  withCDP,
  captureTokenCDP,
} = createCdp({
  cdpPort: CDP_PORT,
  asarPath: ASAR_PATH,
  apiBase: API_BASE,
  killTypeless,
  launchTypeless,
  sleep,
  log,
  curlApi,
  decodeJwtPayload,
  accountMetaFromUserInfo,
});

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
