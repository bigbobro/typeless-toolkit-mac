'use strict';

/**
 * 运行数据备份 / 恢复事务
 *
 * 管的是三样东西的整体一致性:`accounts.json`(含明文 token)、`profiles/`(登录态
 * 快照)、主词库 CSV。它们必须作为**一代数据**整体备份与整体恢复——恢复了旧的
 * accounts.json 却留着新的 profiles,登录态和 token 就对不上了。
 *
 * 因此这里的每次备份/恢复都是事务:
 *   - 备份:先写 staging 目录 → 生成含每文件 SHA-256 的 manifest → 自校验 → rename 发布。
 *     半途崩溃只会留下 `.preparing` 目录,不会被当成有效备份。
 *   - 恢复:staging → 校验 → 先备份现状 → 写 journal(phase=committing) → 移开旧数据
 *     → 装入新数据 → 校验 → phase=committed。任何一步崩溃,下次启动由
 *     recoverIncompleteRuntimeRestores() 按 journal 回滚或清理。
 *   - 回滚失败不静默:抛 RUNTIME_RESTORE_RECOVERY_REQUIRED 并保留现场目录。
 *
 * 从 lib/common.js 抽出,逻辑未变。用工厂函数注入路径,模块本身不持有全局状态。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { hashFile } = require('./patch-transaction');
const {
  fileStamp,
  safeName,
  ensurePrivateDirectory,
  secureTree,
  writePrivateFileAtomic,
} = require('./private-fs');

/**
 * @param {object} paths 由 lib/common.js 统一计算后注入,避免两处各算一遍
 * @param {string} paths.root            稳定数据目录 ROOT
 * @param {string} paths.accountsFile    accounts.json 绝对路径
 * @param {string} paths.profilesDir     profiles/ 绝对路径
 * @param {string} paths.masterCsv       主词库 CSV 绝对路径
 * @param {string} paths.masterCsvLabel  主词库文件名(状态展示用)
 * @param {string} paths.backupsDir      runtime-backups/ 绝对路径
 */
function createRuntimeBackup({ root, accountsFile, profilesDir, masterCsv, masterCsvLabel, backupsDir }) {
  const ROOT = root;
  const ACCOUNTS_FILE = accountsFile;
  const PROFILES_DIR = profilesDir;
  const MASTER_CSV = masterCsv;
  const RUNTIME_BACKUPS_DIR = backupsDir;
  const RUNTIME_BACKUP_MANIFEST = 'manifest.json';
  const RUNTIME_BACKUP_TYPE = 'typeless-toolkit-runtime-backup';
  const RUNTIME_BACKUP_VERSION = 1;
  const RUNTIME_RESTORE_PREFIX = '.runtime-restore-';
  const RUNTIME_RESTORE_SUFFIX = '.preparing';
  const RUNTIME_RESTORE_MANIFEST = 'restore-manifest.json';
  const RUNTIME_RESTORE_TYPE = 'typeless-toolkit-runtime-restore';
  const RUNTIME_RESTORE_VERSION = 1;

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

  function runtimeDataStatus() {
    recoverIncompleteRuntimeRestores();
    const sources = [
      { key: 'accounts', label: 'accounts.json', path: ACCOUNTS_FILE },
      { key: 'profiles', label: 'profiles/', path: PROFILES_DIR },
      { key: 'master_csv', label: masterCsvLabel, path: MASTER_CSV },
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

  return {
    runtimeDataStatus,
    backupRuntimeData,
    createRuntimeBackupBundle,
    restoreRuntimeBackupBundle,
    recoverIncompleteRuntimeRestores,
  };
}

module.exports = { createRuntimeBackup };
