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
const { pathToFileURL } = require('url');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const {
  hashFile,
  listPatchBackups,
  recoverIncompletePatchTransactions,
  runPatchTransaction,
} = require('./patch-transaction');
const { initializeRuntimeData } = require('./runtime-data');

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
const RUNTIME_BACKUP_MANIFEST = 'manifest.json';
const RUNTIME_BACKUP_TYPE = 'typeless-toolkit-runtime-backup';
const RUNTIME_BACKUP_VERSION = 1;
const RUNTIME_RESTORE_PREFIX = '.runtime-restore-';
const RUNTIME_RESTORE_SUFFIX = '.preparing';
const RUNTIME_RESTORE_MANIFEST = 'restore-manifest.json';
const RUNTIME_RESTORE_TYPE = 'typeless-toolkit-runtime-restore';
const RUNTIME_RESTORE_VERSION = 1;
const PATCH_BACKUPS_DIR = path.join(ROOT, 'patch-backups');
const VERSION_STATE_FILE = path.join(ROOT, 'typeless-version.json');
const SNAPSHOT_FILES = ['app-storage.json', 'user-data.json', 'app-onboarding.json'];

// ---------- 工具 ----------
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const termKey = s => String(s || '').trim().toLocaleLowerCase();
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function safeName(s) {
  return String(s || 'backup').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
}

function ensurePrivateDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function secureTree(entryPath) {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) throw new Error(`运行数据不允许符号链接: ${entryPath}`);
  if (stat.isDirectory()) {
    fs.chmodSync(entryPath, 0o700);
    for (const name of fs.readdirSync(entryPath)) secureTree(path.join(entryPath, name));
  } else if (stat.isFile()) {
    fs.chmodSync(entryPath, 0o600);
  } else {
    throw new Error(`运行数据包含不支持的文件类型: ${entryPath}`);
  }
}

function writePrivateFileAtomic(filePath, content) {
  ensurePrivateDirectory(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

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
    try { fs.copyFileSync(ACCOUNTS_FILE, backup); fs.chmodSync(backup, 0o600); } catch (_) {}
    throw new Error(`accounts.json 解析失败,已保留损坏文件备份: ${backup}`);
  }
}
function writeAccounts(a) {
  if (!Array.isArray(a)) throw new Error('writeAccounts 需要数组');
  ensurePrivateDirectory(ROOT);
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      fs.copyFileSync(ACCOUNTS_FILE, `${ACCOUNTS_FILE}.bak`);
      fs.chmodSync(`${ACCOUNTS_FILE}.bak`, 0o600);
    } catch (_) {}
  }
  writePrivateFileAtomic(ACCOUNTS_FILE, JSON.stringify(a, null, 2));
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
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`运行数据不允许符号链接: ${abs}`);
    if (st.isDirectory()) out.push(...listFilesRecursive(abs, rel));
    else if (st.isFile()) out.push({ abs, rel });
    else throw new Error(`运行数据包含不支持的文件类型: ${abs}`);
  }
  return out;
}

function injectRuntimeFault(options, point, details = {}) {
  if (options && typeof options.faultInjector === 'function') {
    options.faultInjector(point, details);
  }
}

function assertSafeBundlePath(value) {
  if (typeof value !== 'string') throw new Error('备份包包含非法路径');
  const rel = value;
  const parts = rel.split('/');
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')
    || parts.some(part => !part || part === '.' || part === '..')
    || path.posix.normalize(rel) !== rel) {
    throw new Error('备份包包含非法路径:' + rel);
  }
  return rel;
}

function assertUniqueFilePaths(paths, label) {
  const seen = [];
  for (const rel of paths) {
    // macOS 默认文件系统不区分大小写,并会规范化 Unicode;两种拼写也必须视为冲突。
    const key = rel.normalize('NFD').toLocaleLowerCase('en-US');
    for (const previous of seen) {
      if (key === previous.key) throw new Error(`${label}包含重复路径:${rel}`);
      if (key.startsWith(previous.key + '/') || previous.key.startsWith(key + '/')) {
        throw new Error(`${label}包含文件/目录路径冲突:${rel}`);
      }
    }
    seen.push({ key, rel });
  }
}

function decodeBase64Strict(content, rel) {
  if (typeof content !== 'string'
    || content.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('备份包文件 base64 不合法:' + rel);
  }
  const decoded = Buffer.from(content, 'base64');
  if (decoded.toString('base64') !== content) throw new Error('备份包文件 base64 不合法:' + rel);
  return decoded;
}

function currentRuntimeTargetDefinitions() {
  return [
    { name: 'accounts.json', kind: 'file' },
    { name: path.basename(MASTER_CSV), kind: 'file' },
    { name: 'profiles', kind: 'dir' },
  ];
}

function runtimeGenerationTargets(baseDir, definitions = currentRuntimeTargetDefinitions()) {
  return definitions.map(target => ({ ...target, path: path.join(baseDir, target.name) }));
}

function runtimeGenerationFiles(baseDir, definitions = currentRuntimeTargetDefinitions()) {
  const out = [];
  for (const target of runtimeGenerationTargets(baseDir, definitions)) {
    if (!fs.existsSync(target.path)) continue;
    const stat = fs.lstatSync(target.path);
    if (stat.isSymbolicLink()) throw new Error(`运行数据不允许符号链接: ${target.path}`);
    if (target.kind === 'file') {
      if (!stat.isFile()) throw new Error(`运行数据类型不正确: ${target.path}`);
      out.push({ abs: target.path, rel: target.name });
    } else {
      if (!stat.isDirectory()) throw new Error(`运行数据类型不正确: ${target.path}`);
      out.push(...listFilesRecursive(target.path, target.name));
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function describeRuntimeGeneration(baseDir, definitions = currentRuntimeTargetDefinitions()) {
  return runtimeGenerationFiles(baseDir, definitions).map(file => {
    const stat = fs.statSync(file.abs);
    return { path: file.rel, size: stat.size, sha256: hashFile(file.abs) };
  });
}

function integrityListsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.path === other.path && entry.size === other.size && entry.sha256 === other.sha256;
  });
}

function assertSafeTopLevelTargetName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')
    || path.basename(value) !== value) {
    throw new Error('恢复事务包含非法目标名');
  }
  return value;
}

function pathBelongsToTargets(rel, definitions) {
  return definitions.some(target => (
    target.kind === 'file' ? rel === target.name : rel.startsWith(target.name + '/')
  ));
}

function normalizeIntegrityList(entries, label, definitions) {
  if (!Array.isArray(entries)) throw new Error(`${label}缺少完整性清单`);
  const normalized = entries.map(entry => {
    const rel = assertSafeBundlePath(entry && entry.path);
    if (!pathBelongsToTargets(rel, definitions)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`${label}文件摘要无效:${rel}`);
    }
    return { path: rel, size: entry.size, sha256: entry.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  assertUniqueFilePaths(normalized.map(entry => entry.path), label);
  return normalized;
}

function normalizeRuntimeRestoreManifest(manifest) {
  if (!manifest || manifest.type !== RUNTIME_RESTORE_TYPE
    || manifest.version !== RUNTIME_RESTORE_VERSION
    || !['preparing', 'prepared', 'committing', 'committed'].includes(manifest.phase)
    || !Array.isArray(manifest.targets)) {
    throw new Error('恢复事务 manifest 不完整');
  }
  const suppliedDefinitions = manifest.targets.map(target => {
    const name = assertSafeTopLevelTargetName(target && target.name);
    if (!target || !['file', 'dir'].includes(target.kind) || typeof target.original_present !== 'boolean') {
      throw new Error('恢复事务目标记录无效:' + name);
    }
    return { name, kind: target.kind, original_present: target.original_present };
  });
  assertUniqueFilePaths(suppliedDefinitions.map(target => target.name), '恢复事务目标');
  const canonicalDefinitions = currentRuntimeTargetDefinitions();
  if (suppliedDefinitions.length !== canonicalDefinitions.length) {
    throw new Error('恢复事务目标与当前运行数据目标不匹配');
  }
  const definitions = canonicalDefinitions.map(canonical => {
    const supplied = suppliedDefinitions.find(target => target.name === canonical.name);
    if (!supplied || supplied.kind !== canonical.kind) {
      throw new Error(`恢复事务目标与当前运行数据目标不匹配:${canonical.name}`);
    }
    return supplied;
  });
  const integrityDefinitions = definitions.map(({ name, kind }) => ({ name, kind }));
  return {
    ...manifest,
    targets: definitions,
    original_integrity: normalizeIntegrityList(
      manifest.original_integrity,
      '恢复事务原数据',
      integrityDefinitions,
    ),
    expected_integrity: normalizeIntegrityList(
      manifest.expected_integrity || [],
      '恢复事务候选数据',
      integrityDefinitions,
    ),
  };
}

function writeRuntimeRestoreManifest(transactionDir, manifest) {
  writePrivateFileAtomic(
    path.join(transactionDir, RUNTIME_RESTORE_MANIFEST),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

function readRuntimeRestoreManifest(transactionDir) {
  const manifestPath = path.join(transactionDir, RUNTIME_RESTORE_MANIFEST);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { throw new Error('恢复事务 manifest 无法解析:' + e.message); }
  return normalizeRuntimeRestoreManifest(parsed);
}

function verifyRuntimeBackupDirectory(dir) {
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('备份目录类型不正确');
  const manifestPath = path.join(dir, RUNTIME_BACKUP_MANIFEST);
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('备份 manifest 缺失');

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { throw new Error('备份 manifest 无法解析:' + e.message); }
  if (!manifest || manifest.type !== RUNTIME_BACKUP_TYPE
    || manifest.version !== RUNTIME_BACKUP_VERSION || manifest.complete !== true
    || !Array.isArray(manifest.files)) {
    throw new Error('备份 manifest 不完整');
  }
  const completedMs = Date.parse(manifest.completed_at);
  if (!Number.isFinite(completedMs)) throw new Error('备份 manifest 完成时间无效');

  const expected = normalizeIntegrityList(
    manifest.files,
    '备份 manifest',
    currentRuntimeTargetDefinitions(),
  );
  if (manifest.file_count !== expected.length) throw new Error('备份 manifest 文件数量不匹配');

  const actual = listFilesRecursive(dir, '')
    .filter(file => file.rel !== RUNTIME_BACKUP_MANIFEST)
    .map(file => {
      const stat = fs.statSync(file.abs);
      return { path: file.rel, size: stat.size, sha256: hashFile(file.abs) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!integrityListsEqual(actual, expected)) throw new Error('备份文件完整性校验失败');
  return { ...manifest, files: expected };
}

function listVerifiedRuntimeBackups() {
  if (!fs.existsSync(RUNTIME_BACKUPS_DIR)) return [];
  const backups = [];
  for (const name of fs.readdirSync(RUNTIME_BACKUPS_DIR)) {
    const entryPath = path.join(RUNTIME_BACKUPS_DIR, name);
    if (name.endsWith('.preparing')) {
      try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch (_) {}
      continue;
    }
    try {
      const manifest = verifyRuntimeBackupDirectory(entryPath);
      const mtimeMs = Date.parse(manifest.completed_at);
      backups.push({
        name,
        path: entryPath,
        mtime_ms: mtimeMs,
        mtime: new Date(mtimeMs).toISOString(),
        reason: typeof manifest.reason === 'string' ? manifest.reason : null,
        manifest,
      });
    } catch (_) {
      // v2.3.0 之前没有 manifest 的历史目录保留给人工恢复,但不计入“已备份”。
    }
  }
  return backups.sort((a, b) => b.mtime_ms - a.mtime_ms);
}

function publicRuntimeBackup(backup) {
  if (!backup) return null;
  return {
    name: backup.name,
    path: backup.path,
    mtime_ms: backup.mtime_ms,
    mtime: backup.mtime,
    reason: backup.reason,
  };
}

function latestRuntimeBackup() {
  return publicRuntimeBackup(listVerifiedRuntimeBackups()[0] || null);
}

function runtimeDataStatus() {
  recoverIncompleteRuntimeRestores();
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
  const verifiedBackups = listVerifiedRuntimeBackups();
  const verifiedBackup = verifiedBackups[0] || null;
  const latestBackup = publicRuntimeBackup(verifiedBackup);
  const hasData = existing.length > 0;
  let backedUp = false;
  if (hasData && verifiedBackups.length) {
    try {
      const currentIntegrity = describeRuntimeGeneration(ROOT);
      backedUp = verifiedBackups.some(backup => integrityListsEqual(currentIntegrity, backup.manifest.files));
    }
    catch (_) { backedUp = false; }
  }
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

function backupRuntimeData(reason, options = {}) {
  if (!options.skipRestoreRecovery) recoverIncompleteRuntimeRestores();
  const items = runtimeGenerationTargets(ROOT).filter(item => fs.existsSync(item.path));
  if (!items.length) return null;
  ensurePrivateDirectory(RUNTIME_BACKUPS_DIR);
  const baseName = `${fileStamp()}-${safeName(reason)}-${crypto.randomBytes(3).toString('hex')}`;
  const finalDir = path.join(RUNTIME_BACKUPS_DIR, baseName);
  const stagingDir = path.join(RUNTIME_BACKUPS_DIR, `.${baseName}.preparing`);
  ensurePrivateDirectory(stagingDir);
  try {
    for (const item of items) {
      injectRuntimeFault(options, 'backup:before-copy', { reason, name: item.name });
      const dst = path.join(stagingDir, item.name);
      if (item.kind === 'dir') fs.cpSync(item.path, dst, { recursive: true, errorOnExist: true, force: false });
      else fs.copyFileSync(item.path, dst, fs.constants.COPYFILE_EXCL);
      injectRuntimeFault(options, 'backup:after-copy', { reason, name: item.name });
    }
    secureTree(stagingDir);
    const files = describeRuntimeGeneration(stagingDir);
    const manifest = {
      type: RUNTIME_BACKUP_TYPE,
      version: RUNTIME_BACKUP_VERSION,
      project: 'Typeless Toolkit',
      complete: true,
      reason: String(reason || 'backup'),
      completed_at: new Date().toISOString(),
      file_count: files.length,
      files,
    };
    writePrivateFileAtomic(
      path.join(stagingDir, RUNTIME_BACKUP_MANIFEST),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    secureTree(stagingDir);
    verifyRuntimeBackupDirectory(stagingDir);
    injectRuntimeFault(options, 'backup:before-publish', { reason, staging_dir: stagingDir, final_dir: finalDir });
    fs.renameSync(stagingDir, finalDir);
    return finalDir;
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function createRuntimeBackupBundle() {
  recoverIncompleteRuntimeRestores();
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

function validateRuntimeBackupBundle(bundle) {
  if (!bundle || bundle.type !== 'typeless-toolkit-macos-runtime-backup') throw new Error('备份包类型不正确');
  if (bundle.version !== 1) throw new Error('不支持的备份包版本:' + bundle.version);
  if (!Array.isArray(bundle.files)) throw new Error('备份包缺少 files');

  const writes = [];
  for (const file of bundle.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('备份包文件记录不正确');
    const rel = assertSafeBundlePath(file.path);
    if (rel === 'accounts.json') {
      // allowed
    } else if (rel === path.basename(MASTER_CSV)) {
      // allowed
    } else if (rel.startsWith('profiles/')) {
      // allowed
    }
    else throw new Error('备份包包含未知文件:' + rel);
    if (file.encoding !== 'base64') throw new Error('备份包文件编码不支持:' + rel);
    const content = decodeBase64Strict(file.content, rel);
    writes.push({ rel, content, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  assertUniqueFilePaths(writes.map(item => item.rel), '备份包');
  return writes.sort((a, b) => a.rel.localeCompare(b.rel));
}

function rollbackRuntimeRestore(transactionDir, targetDefinitions, originalIntegrity) {
  const beforeDir = path.join(transactionDir, 'before');
  const errors = [];
  const allowedNames = new Set(targetDefinitions.map(target => target.name));
  try {
    for (const name of fs.readdirSync(beforeDir)) {
      if (!allowedNames.has(name)) errors.push(`before 目录包含未知目标:${name}`);
    }
  } catch (e) { errors.push('无法检查 before 目录:' + e.message); }

  for (const target of runtimeGenerationTargets(ROOT, targetDefinitions)) {
    const beforePath = path.join(beforeDir, target.name);
    if (!fs.existsSync(beforePath)) continue;
    if (!target.original_present) {
      errors.push(`目标 ${target.name} 标记为原本不存在,但 before-image 存在`);
      continue;
    }
    try {
      const beforeStat = fs.lstatSync(beforePath);
      if (beforeStat.isSymbolicLink()
        || (target.kind === 'file' && !beforeStat.isFile())
        || (target.kind === 'dir' && !beforeStat.isDirectory())) {
        throw new Error('before-image 类型不正确');
      }
    } catch (e) { errors.push(`检查旧 ${target.name} 失败:${e.message}`); }
  }

  if (errors.length) throw new Error(errors.join('; '));
  for (const target of runtimeGenerationTargets(ROOT, targetDefinitions)) {
    const beforePath = path.join(beforeDir, target.name);
    if (fs.existsSync(beforePath)) {
      try {
        fs.rmSync(target.path, { recursive: true, force: true });
        fs.renameSync(beforePath, target.path);
      } catch (e) { errors.push(`恢复旧 ${target.name} 失败:${e.message}`); }
    } else if (!target.original_present) {
      try { fs.rmSync(target.path, { recursive: true, force: true }); }
      catch (e) { errors.push(`移除原本不存在的 ${target.name} 失败:${e.message}`); }
    }
  }
  try {
    for (const target of runtimeGenerationTargets(ROOT, targetDefinitions)) {
      const exists = fs.existsSync(target.path);
      if (exists !== target.original_present) errors.push(`回滚后 ${target.name} 存在性不匹配`);
    }
    if (!integrityListsEqual(describeRuntimeGeneration(ROOT, targetDefinitions), originalIntegrity)) {
      errors.push('回滚后运行数据摘要不匹配');
    }
  } catch (e) { errors.push('回滚后无法校验:' + e.message); }
  if (errors.length) throw new Error(errors.join('; '));
}

function recoverIncompleteRuntimeRestores() {
  if (!fs.existsSync(ROOT)) return [];
  const recovered = [];
  const transactionNames = fs.readdirSync(ROOT)
    .filter(name => name.startsWith(RUNTIME_RESTORE_PREFIX) && name.endsWith(RUNTIME_RESTORE_SUFFIX))
    // 多次中断会形成 before-image 链;必须从最新事务向最旧事务依次反向恢复。
    .sort((a, b) => b.localeCompare(a));
  for (const name of transactionNames) {
    const transactionDir = path.join(ROOT, name);
    const manifestPath = path.join(transactionDir, RUNTIME_RESTORE_MANIFEST);
    try {
      const transactionStat = fs.lstatSync(transactionDir);
      if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
        throw new Error('恢复事务路径不是普通目录');
      }
      if (!fs.existsSync(manifestPath)) {
        const beforeDir = path.join(transactionDir, 'before');
        const hasBeforeImages = fs.existsSync(beforeDir) && fs.readdirSync(beforeDir).length > 0;
        if (hasBeforeImages) throw new Error('缺少 manifest 且存在 before-image');
        fs.rmSync(transactionDir, { recursive: true, force: true });
        recovered.push({ transaction_dir: transactionDir, action: 'discarded_unjournaled_staging' });
        continue;
      }

      const manifest = readRuntimeRestoreManifest(transactionDir);
      if (manifest.phase === 'committing') {
        rollbackRuntimeRestore(transactionDir, manifest.targets, manifest.original_integrity);
        fs.rmSync(transactionDir, { recursive: true, force: true });
        recovered.push({ transaction_dir: transactionDir, action: 'rolled_back' });
      } else if (manifest.phase === 'committed') {
        fs.rmSync(transactionDir, { recursive: true, force: true });
        recovered.push({ transaction_dir: transactionDir, action: 'cleaned_committed' });
      } else {
        const beforeDir = path.join(transactionDir, 'before');
        if (fs.existsSync(beforeDir) && fs.readdirSync(beforeDir).length > 0) {
          throw new Error(`${manifest.phase} 阶段不应包含 before-image`);
        }
        fs.rmSync(transactionDir, { recursive: true, force: true });
        recovered.push({ transaction_dir: transactionDir, action: 'discarded_staging' });
      }
    } catch (error) {
      const recoveryError = new Error(
        `检测到未完成的运行数据恢复事务,自动恢复失败:${error.message}; 恢复现场:${transactionDir}`,
        { cause: error },
      );
      recoveryError.code = 'RUNTIME_RESTORE_RECOVERY_REQUIRED';
      recoveryError.recovery_path = transactionDir;
      throw recoveryError;
    }
  }
  return recovered;
}

function restoreRuntimeBackupBundle(bundle, options = {}) {
  recoverIncompleteRuntimeRestores();
  const writes = validateRuntimeBackupBundle(bundle);
  ensurePrivateDirectory(ROOT);
  const targetDefinitions = currentRuntimeTargetDefinitions().map(target => ({
    ...target,
    original_present: fs.existsSync(path.join(ROOT, target.name)),
  }));
  const originalIntegrity = describeRuntimeGeneration(ROOT, targetDefinitions);
  const transactionDir = path.join(
    ROOT,
    `.runtime-restore-${fileStamp()}-${crypto.randomBytes(3).toString('hex')}.preparing`,
  );
  const nextDir = path.join(transactionDir, 'next');
  const beforeDir = path.join(transactionDir, 'before');
  const restoreManifest = {
    type: RUNTIME_RESTORE_TYPE,
    version: RUNTIME_RESTORE_VERSION,
    transaction_id: path.basename(transactionDir),
    phase: 'preparing',
    created_at: new Date().toISOString(),
    targets: targetDefinitions,
    original_integrity: originalIntegrity,
    expected_integrity: [],
    current_backup: null,
    restored_backup: null,
  };
  ensurePrivateDirectory(transactionDir);
  writeRuntimeRestoreManifest(transactionDir, restoreManifest);
  ensurePrivateDirectory(nextDir);
  ensurePrivateDirectory(beforeDir);

  let commitStarted = false;
  let preserveTransaction = false;
  let restoredBackup = null;
  let currentBackup = null;
  try {
    for (const item of writes) {
      const dst = path.join(nextDir, ...item.rel.split('/'));
      ensurePrivateDirectory(path.dirname(dst));
      fs.writeFileSync(dst, item.content, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(dst, 0o600);
      injectRuntimeFault(options, 'restore:after-stage-file', { path: item.rel });
    }
    secureTree(nextDir);
    const stagedIntegrity = describeRuntimeGeneration(nextDir);
    const expectedIntegrity = writes.map(({ rel, size, sha256 }) => ({ path: rel, size, sha256 }));
    if (!integrityListsEqual(stagedIntegrity, expectedIntegrity)) throw new Error('恢复 staging 完整性校验失败');
    restoreManifest.phase = 'prepared';
    restoreManifest.expected_integrity = expectedIntegrity;
    restoreManifest.updated_at = new Date().toISOString();
    writeRuntimeRestoreManifest(transactionDir, restoreManifest);
    injectRuntimeFault(options, 'restore:after-stage-verify', { file_count: writes.length });

    const internalBackupOptions = { ...options, skipRestoreRecovery: true };
    currentBackup = backupRuntimeData('before-restore', internalBackupOptions);
    injectRuntimeFault(options, 'restore:after-before-backup', { backup_dir: currentBackup });
    restoreManifest.phase = 'committing';
    restoreManifest.current_backup = currentBackup;
    restoreManifest.updated_at = new Date().toISOString();
    writeRuntimeRestoreManifest(transactionDir, restoreManifest);
    commitStarted = true;
    injectRuntimeFault(options, 'restore:after-commit-journal', { transaction_dir: transactionDir });

    for (const target of runtimeGenerationTargets(ROOT, targetDefinitions)) {
      if (!fs.existsSync(target.path)) continue;
      fs.renameSync(target.path, path.join(beforeDir, target.name));
      injectRuntimeFault(options, 'restore:after-live-move', { name: target.name });
    }
    for (const target of runtimeGenerationTargets(nextDir, targetDefinitions)) {
      if (!fs.existsSync(target.path)) continue;
      const livePath = path.join(ROOT, target.name);
      fs.renameSync(target.path, livePath);
      injectRuntimeFault(options, 'restore:after-install', { name: target.name });
    }

    if (!integrityListsEqual(describeRuntimeGeneration(ROOT, targetDefinitions), expectedIntegrity)) {
      throw new Error('恢复提交后完整性校验失败');
    }
    injectRuntimeFault(options, 'restore:after-commit-verify', { file_count: writes.length });
    restoredBackup = backupRuntimeData('after-restore', internalBackupOptions);
    injectRuntimeFault(options, 'restore:after-backup', { backup_dir: restoredBackup });
    restoreManifest.phase = 'committed';
    restoreManifest.restored_backup = restoredBackup;
    restoreManifest.updated_at = new Date().toISOString();
    writeRuntimeRestoreManifest(transactionDir, restoreManifest);

    try { fs.rmSync(transactionDir, { recursive: true, force: true }); } catch (_) {}
    return { current_backup: currentBackup, restored_backup: restoredBackup, restored_files: writes.length };
  } catch (error) {
    if (commitStarted) {
      try {
        rollbackRuntimeRestore(transactionDir, targetDefinitions, originalIntegrity);
      } catch (rollbackError) {
        preserveTransaction = true;
        const recoveryError = new Error(
          `恢复事务失败且自动回滚未完成:${error.message}; ${rollbackError.message}; 恢复现场:${transactionDir}`,
          { cause: error },
        );
        recoveryError.code = 'RUNTIME_RESTORE_RECOVERY_REQUIRED';
        recoveryError.recovery_path = transactionDir;
        throw recoveryError;
      }
      if (restoredBackup) {
        try { fs.rmSync(restoredBackup, { recursive: true, force: true }); } catch (_) {}
      }
    }
    throw error;
  } finally {
    if (!preserveTransaction) {
      try { fs.rmSync(transactionDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// ---------- 登录态快照(切换账号用) ----------
function profileDir(uid) { return path.join(PROFILES_DIR, assertSafeAccountId(uid)); }
function saveSnapshot(uid) {
  const dir = profileDir(uid); ensurePrivateDirectory(dir);
  for (const f of SNAPSHOT_FILES) {
    const src = path.join(USERDATA_DIR, f);
    if (fs.existsSync(src)) {
      const dst = path.join(dir, f);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
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
async function portUp(port = CDP_PORT, fetchFn = fetch) {
  try { return Boolean(await fetchTypelessCdpTarget(port, fetchFn)); }
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
  const checkPort = options.portUp || portUp;
  const stopApp = options.killTypeless || killTypeless;
  const startApp = options.launchTypeless || launchTypeless;
  const wait = options.sleep || sleep;
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 40;
  const restartDelayMs = Number.isFinite(options.restartDelayMs) ? options.restartDelayMs : 1200;
  const pollDelayMs = Number.isFinite(options.pollDelayMs) ? options.pollDelayMs : 500;

  if (await checkPort()) {
    return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: false };
  }
  log('Typeless 未带调试端口,正在以调试端口重启…');
  stopApp();
  await wait(restartDelayMs);
  startApp();
  for (let i = 0; i < attempts; i++) {
    if (await checkPort()) {
      return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: true };
    }
    if (i < attempts - 1) await wait(pollDelayMs);
  }
  const error = new Error(`Typeless 启动后仍无法连接管理端口 ${CDP_PORT}`);
  error.code = 'CDP_START_TIMEOUT';
  throw error;
}
async function withCDP(fn, port = CDP_PORT) {
  let target;
  for (let i = 0; i < 40; i++) {
    try { target = await fetchTypelessCdpTarget(port); } catch (e) {}
    if (target) break;
    await sleep(500);
  }
  if (!target) throw new Error('找不到 Typeless 管理窗口,请确认 Typeless 已用 --remote-debugging-port=' + port + ' 启动');
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
async function captureTokenCDP(port, autoRestart = true) {
  const usePort = port || CDP_PORT;
  // 检查端口是否就绪
  let ready = false;
  try { ready = await portUp(usePort); } catch (e) {}
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
  }, usePort);
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
    imported = safeCount(r.data?.success_count);
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

function updateMacAsarIntegrityHash(newHeaderHash, plistPath = MAC_INFO_PLIST) {
  if (!plistPath || !fs.existsSync(plistPath)) throw new Error('Info.plist 未找到,无法更新 macOS asar 完整性');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHeaderHash}`,
    plistPath,
  ]);
}

function readMacAsarIntegrityHash(plistPath = MAC_INFO_PLIST) {
  if (!plistPath || !fs.existsSync(plistPath)) return null;
  try {
    return execFileSync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', plistPath,
    ], { encoding: 'utf8' }).trim() || null;
  } catch (_) { return null; }
}

function resignMacApp(appPath = MAC_APP_PATH) {
  if (!appPath || !fs.existsSync(appPath)) throw new Error('Typeless.app 未找到,无法重新签名');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' });
}

function verifyMacApp(appPath = MAC_APP_PATH) {
  if (!appPath || !fs.existsSync(appPath)) throw new Error('Typeless.app 未找到,无法验证签名');
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
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
               '请阅读 README「去弹窗补丁」的“自动识别失败时”说明,并在稳定数据目录的 config.local.json 中适配',
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
        has_backup: listPatchBackups(PATCH_BACKUPS_DIR).length > 0
          || (fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak')),
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
      has_backup: listPatchBackups(PATCH_BACKUPS_DIR).length > 0
        || (fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak')),
    };
  } catch (e) { return { exists: false, error: e.message }; }
  finally { if (tmpAsar) try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 执行补丁:内容替换 + 同步 per-file SHA256 + 同步平台完整性记录
function patchPaywall() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) throw new Error('app.asar 未找到(Typeless 路径未配置?)');
  if (!TYPELESS_BIN || !fs.existsSync(TYPELESS_BIN)) throw new Error('Typeless 可执行文件未找到');
  if (!MAC_INFO_PLIST || !fs.existsSync(MAC_INFO_PLIST)) throw new Error('Info.plist 未找到,无法同步 macOS asar 完整性');
  const originalAsarHash = hashFile(ASAR_PATH);
  const originalPlistHash = hashFile(MAC_INFO_PLIST);
  const appVersion = getTypelessVersion();
  // 在临时非 .asar 文件上准备候选,原 App 在事务提交前保持不变。
  const tmpAsar = asarToTmp();
  const tmpPlist = path.join(os.tmpdir(), `tt_plist_${process.pid}_${Date.now()}.plist`);
  let fd = null;
  try {
    fs.copyFileSync(MAC_INFO_PLIST, tmpPlist);
    fd = fs.openSync(tmpAsar, 'r+');
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
    if (!node) throw new Error('asar 内未找到目标文件,请阅读 README「去弹窗补丁」的“自动识别失败时”说明并更新 config.local.json');

    const foff = dataStart + (+node.offset), size = node.size;
    const oldHash = node.integrity.hash;
    const content = Buffer.from(buf.subarray(foff, foff + size));

    const effective = getEffectivePaywallReplacements(content);
    const repls = effective.replacements.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
    if (!repls.length) throw new Error('未配置且未自动识别到 paywall 替换标记');
    // 幂等:已打过则跳过
    const alreadyPatched = repls.every(([from], i) => !content.includes(from) && content.includes(repls[i][1]));
    if (alreadyPatched) {
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }

    // 1) 内容补丁(等长替换)
    for (const [from, to] of repls) {
      const i = content.indexOf(from);
      if (i < 0) throw new Error(
        '未找到标记 ' + from.toString() + ',你的 Typeless 版本可能不同。' +
        '请阅读 README「去弹窗补丁」的“自动识别失败时”说明并更新 config.local.json'
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
    fd = null;

    // 6) 先把 Info.plist 候选准备好,再通过本次事务统一替换、签名和验证。
    updateMacAsarIntegrityHash(newHeaderHash, tmpPlist);
    const transaction = runPatchTransaction({
      backupRoot: PATCH_BACKUPS_DIR,
      label: 'paywall',
      appVersion,
      files: [
        {
          name: 'app.asar',
          livePath: ASAR_PATH,
          candidatePath: tmpAsar,
          expectedOriginalSha256: originalAsarHash,
        },
        {
          name: 'Info.plist',
          livePath: MAC_INFO_PLIST,
          candidatePath: tmpPlist,
          expectedOriginalSha256: originalPlistHash,
        },
      ],
      afterReplace: () => resignMacApp(),
      verify: () => {
        if (readMacAsarIntegrityHash() !== newHeaderHash) throw new Error('Info.plist asar 完整性校验失败');
        verifyMacApp();
        const status = paywallStatus();
        if (!status.patched) throw new Error(status.error || '补丁标记验证失败');
      },
      afterRollback: () => resignMacApp(),
      verifyAfterRollback: () => verifyMacApp(),
      retention: 3,
    });

    return {
      already: false, done: true,
      transaction_id: transaction.transaction_id,
      transaction_backup: transaction.backup_dir,
      replacements_source: effective.source,
      replacements: effective.replacements,
      plist: MAC_INFO_PLIST,
      signed: true,
      file_hash: { old: oldHash, new: newHash },
      header_hash: { old: oldHeaderHash, new: newHeaderHash },
      msg: '补丁已打好,升级/会员弹窗将不再弹出(重启 Typeless 生效)',
    };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmpAsar); } catch (_) {}
    try { fs.unlinkSync(tmpPlist); } catch (_) {}
  }
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

// 模块加载时先处理上次被 SIGKILL/断电打断的事务,再提供任何管理能力。
const INITIAL_PATCH_RECOVERY = recoverIncompletePatchTransactions({
  backupRoot: PATCH_BACKUPS_DIR,
  afterRecovery: () => resignMacApp(),
  verifyAfterRecovery: () => verifyMacApp(),
});
const INITIAL_RUNTIME_RESTORE_RECOVERY = recoverIncompleteRuntimeRestores();

// 首次从旧 release 目录迁移完成后,立刻在稳定目录内留一份完整快照。
// 旧源仍保留,这份 post-migration 备份用于新的固定备份状态检测。
const INITIAL_MIGRATION_BACKUP = RUNTIME_DATA.migration.status === 'migrated'
  ? backupRuntimeData('post-migration')
  : null;

module.exports = {
  // 常量
  ROOT, CODE_DIR, RUNTIME_DATA, INITIAL_PATCH_RECOVERY, INITIAL_RUNTIME_RESTORE_RECOVERY,
  INITIAL_MIGRATION_BACKUP, config, DEFAULT_CONFIG,
  TYPELESS_BIN, USERDATA_DIR, DEVICE_CACHE_PATHS,
  MAC_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT, MAC_APP_PATH, MAC_INFO_PLIST, ASAR_PATH,
  API_BASE, CDP_PORT, MASTER_CSV, PROFILES_DIR, ACCOUNTS_FILE, RUNTIME_BACKUPS_DIR, PATCH_BACKUPS_DIR, VERSION_STATE_FILE, SNAPSHOT_FILES,
  // 工具
  log, sleep, execFileAsync, termKey, safeCount, assertSafeAccountId,
  detectTypelessExe, loadConfig, detectUserDataDir, detectAsarPath, accountMetaFromUserInfo,
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
  curlApi, selectTypelessCdpTarget, typelessConnectionStatus, ensureApp, captureTokenCDP,
  // 状态 + 同步
  liveStatus, syncAccount,
  // 弹窗补丁
  paywallStatus, patchPaywall,
  // Typeless 版本漂移
  getTypelessVersion, versionDriftStatus, writeVersionState, readVersionState, computeVersionDrift,
};
