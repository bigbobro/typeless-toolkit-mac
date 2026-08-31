'use strict';

/**
 * 路径探测与配置加载 —— 启动时一次性算出全部路径常量
 *
 * 从 lib/common.js 抽出。优先级一律是:**config/env 显式 → 平台默认探测 → 抛错/空**,
 * 禁止任何硬编码用户目录。
 *
 * 三点必须知道的:
 *
 * 1. **本文件必须留在 lib/ 下。** `CODE_DIR = path.join(__dirname, '..')` 依赖文件
 *    所在层级 —— 挪到仓库根或任何别的深度,CODE_DIR 会被静默算错,而它决定去哪里读
 *    config.json 和 manager.html。
 *
 * 2. **require 本模块有副作用。** `initializeRuntimeData()` 在模块加载时执行,会做
 *    旧运行数据的迁移(staging + SHA-256 校验 + marker)。它必须且只能发生一次,
 *    且要早于任何人读 ROOT 下的文件 —— lib/common.js 在顶部 require 本模块,时机与
 *    拆分前完全一致。不要把它改成惰性求值。
 *
 * 3. 探测顺序里 `detectUserDataDir` 选的是「含 user-data.json 的那个候选」,用来兼容
 *    不同 Typeless 版本的目录名(Typeless / now.typeless.desktop)。
 *
 * DEFAULT_CONFIG、loadConfig、五个 detect* 与两个 mac* 辅助都是模块私有,不对外导出:
 * 外部只需要算好的结果。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { initializeRuntimeData } = require('./runtime-data');

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

module.exports = {
  // 目录与配置
  CODE_DIR, ROOT, RUNTIME_DATA, config,
  // Typeless 安装位置(由 TYPELESS_BIN 反推)
  TYPELESS_BIN, USERDATA_DIR, DEVICE_CACHE_PATHS,
  MAC_APP_PATH, MAC_INFO_PLIST, ASAR_PATH,
  MAC_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT,
  // 运行数据落点(全部在 ROOT 下)
  ACCOUNTS_FILE, PROFILES_DIR, MASTER_CSV,
  RUNTIME_BACKUPS_DIR, PATCH_BACKUPS_DIR, VERSION_STATE_FILE,
  SNAPSHOT_FILES,
  // 来自 config 的常用值
  API_BASE, CDP_PORT,
};
