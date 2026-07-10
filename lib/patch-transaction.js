'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const activeTransactions = new Set();

class PatchTransactionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PatchTransactionError';
    this.code = details.code || 'PATCH_TRANSACTION_FAILED';
    this.phase = details.phase || 'unknown';
    this.transaction_id = details.transactionId || null;
    this.backup_dir = details.backupDir || null;
    this.rollback = details.rollback || 'not_needed';
    this.manifest_error = details.manifestError
      ? (details.manifestError.message || String(details.manifestError))
      : null;
    if (details.cause) this.cause = details.cause;
  }
}

function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeName(value, fallback = 'patch') {
  return String(value || fallback)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function writePrivateJson(filePath, value) {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function copyVerified(source, destination, mode = 0o600) {
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile()) throw new Error(`事务源文件不是普通文件: ${source}`);
  const sourceHash = hashFile(source);
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, mode);
  const copiedHash = hashFile(destination);
  if (copiedHash !== sourceHash) throw new Error(`事务副本校验失败: ${source}`);
  return { sha256: sourceHash, size: sourceStat.size, mode: sourceStat.mode & 0o777 };
}

function atomicReplace(source, destination, mode, transactionId) {
  const expectedHash = hashFile(source);
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.typeless-${transactionId}.tmp`,
  );
  try {
    fs.copyFileSync(source, temp);
    fs.chmodSync(temp, mode || 0o644);
    if (hashFile(temp) !== expectedHash) throw new Error(`候选文件复制校验失败: ${destination}`);
    fs.renameSync(temp, destination);
    if (hashFile(destination) !== expectedHash) throw new Error(`替换后校验失败: ${destination}`);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
  }
  return expectedHash;
}

function createBackup({
  backupRoot,
  label,
  appVersion,
  files,
  transactionId,
  now,
  manifestWriter = writePrivateJson,
}) {
  ensurePrivateDir(backupRoot);
  const versionPart = safeName(appVersion || 'unknown', 'unknown');
  const finalDir = path.join(
    backupRoot,
    `${fileStamp(now)}-${safeName(label)}-${versionPart}-${transactionId}`,
  );
  const stagingDir = `${finalDir}.preparing`;
  ensurePrivateDir(stagingDir);
  const manifestFiles = [];
  try {
    for (const file of files) {
      if (!file || !file.name || !file.livePath || !file.candidatePath) {
        throw new Error('补丁事务文件描述不完整');
      }
      if (!fs.existsSync(file.livePath)) throw new Error(`补丁事务源文件不存在: ${file.livePath}`);
      if (!fs.existsSync(file.candidatePath)) throw new Error(`补丁候选文件不存在: ${file.candidatePath}`);
      const backupName = safeName(file.name);
      const backupPath = path.join(stagingDir, backupName);
      const meta = copyVerified(file.livePath, backupPath, 0o600);
      if (file.expectedOriginalSha256 && file.expectedOriginalSha256 !== meta.sha256) {
        throw new Error(`补丁前文件已变化: ${file.name}`);
      }
      manifestFiles.push({
        name: file.name,
        live_path: file.livePath,
        backup_file: backupName,
        sha256: meta.sha256,
        size: meta.size,
        mode: meta.mode,
      });
    }
    const manifest = {
      type: 'typeless-toolkit-patch-transaction',
      version: 1,
      transaction_id: transactionId,
      label,
      app_version: appVersion || null,
      created_at: now.toISOString(),
      status: 'prepared',
      files: manifestFiles,
    };
    manifestWriter(path.join(stagingDir, 'manifest.json'), manifest);
    fs.renameSync(stagingDir, finalDir);
    return { dir: finalDir, manifest };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function updateManifest(backup, patch, manifestWriter = writePrivateJson) {
  const manifest = { ...backup.manifest, ...patch, updated_at: new Date().toISOString() };
  manifestWriter(path.join(backup.dir, 'manifest.json'), manifest);
  backup.manifest = manifest;
}

function verifyRollback(backup) {
  for (const file of backup.manifest.files) {
    if (!fs.existsSync(file.live_path)) throw new Error(`回滚后文件缺失: ${file.name}`);
    if (hashFile(file.live_path) !== file.sha256) throw new Error(`回滚后校验失败: ${file.name}`);
  }
}

function validateBeforeImages(backup) {
  if (!Array.isArray(backup.manifest.files) || !backup.manifest.files.length) {
    throw new Error('补丁事务 before-image 清单无效');
  }
  for (const file of backup.manifest.files) {
    const backupFile = path.join(backup.dir, file.backup_file || '');
    if (!fs.existsSync(backupFile) || !fs.statSync(backupFile).isFile()) {
      throw new Error(`补丁事务 before-image 缺失: ${file.name}`);
    }
    if (hashFile(backupFile) !== file.sha256) {
      throw new Error(`补丁事务 before-image 校验失败: ${file.name}`);
    }
  }
}

function restoreBeforeImages(backup, transactionId) {
  validateBeforeImages(backup);
  for (const original of [...backup.manifest.files].reverse()) {
    const backupFile = path.join(backup.dir, original.backup_file);
    atomicReplace(backupFile, original.live_path, original.mode, transactionId);
  }
  verifyRollback(backup);
}

function verifyPreparedLiveUnchanged(backup) {
  validateBeforeImages(backup);
  for (const file of backup.manifest.files) {
    if (!fs.existsSync(file.live_path)) {
      throw new Error(`prepared 事务后 live 文件缺失，拒绝覆盖: ${file.name}`);
    }
    if (hashFile(file.live_path) !== file.sha256) {
      throw new Error(`prepared 事务后 live 文件已变化，拒绝覆盖: ${file.name}`);
    }
  }
}

function listPatchBackups(backupRoot) {
  if (!backupRoot || !fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot)
    .map((name) => {
      const dir = path.join(backupRoot, name);
      const manifestPath = path.join(dir, 'manifest.json');
      try {
        if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) return null;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.type !== 'typeless-toolkit-patch-transaction') return null;
        return { dir, manifest };
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.manifest.created_at).localeCompare(String(a.manifest.created_at)));
}

function prunePatchBackups(backupRoot, keep = 3) {
  const backups = listPatchBackups(backupRoot);
  for (const old of backups.slice(Math.max(1, keep))) {
    fs.rmSync(old.dir, { recursive: true, force: true });
  }
}

function backupRootLockKey(backupRoot) {
  return `backup-root:${path.resolve(backupRoot)}`;
}

function recoverIncompletePatchTransactionsCore({
  backupRoot,
  manifestWriter = writePrivateJson,
  afterRecovery = () => {},
  verifyAfterRecovery = () => {},
}) {
  const incomplete = listPatchBackups(backupRoot)
    .filter((backup) => ['prepared', 'committing', 'rollback_failed'].includes(backup.manifest.status));
  const recovered = [];

  // Newest first preserves the before-image chain if more than one interrupted
  // transaction is present from an older implementation.
  for (const backup of incomplete) {
    const previousStatus = backup.manifest.status;
    const transactionId = backup.manifest.transaction_id || safeName(path.basename(backup.dir));
    try {
      if (previousStatus === 'prepared') {
        // No live write is allowed before `committing` is durable. Therefore a
        // prepared transaction may be closed only if live still matches its
        // before-image; external app updates must never be overwritten here.
        verifyPreparedLiveUnchanged(backup);
      } else {
        restoreBeforeImages(backup, transactionId);
        afterRecovery({
          transactionId,
          backupDir: backup.dir,
          previousStatus,
        });
        verifyAfterRecovery({
          transactionId,
          backupDir: backup.dir,
          previousStatus,
        });
      }
    } catch (cause) {
      let manifestError = null;
      try {
        // Keep the incomplete status so every later operation retries recovery.
        updateManifest(backup, {
          status: previousStatus,
          recovery_error: cause.message,
          recovery_attempted_at: new Date().toISOString(),
        }, manifestWriter);
      } catch (error) {
        manifestError = error;
      }
      throw new PatchTransactionError(
        `未完成的补丁事务自动恢复失败: ${cause.message}`,
        {
          code: 'PATCH_RECOVERY_REQUIRED',
          phase: 'recovery',
          transactionId,
          backupDir: backup.dir,
          rollback: 'failed',
          cause,
          manifestError,
        },
      );
    }

    try {
      updateManifest(backup, {
        status: 'rolled_back',
        recovery: 'recovered',
        recovered_from: previousStatus,
        recovered_at: new Date().toISOString(),
        recovery_error: null,
      }, manifestWriter);
    } catch (manifestError) {
      throw new PatchTransactionError('未完成的补丁事务已恢复并校验，但无法记录恢复状态', {
        code: 'PATCH_RECOVERY_REQUIRED',
        phase: 'recovery',
        transactionId,
        backupDir: backup.dir,
        rollback: 'verified',
        cause: manifestError,
        manifestError,
      });
    }

    recovered.push({
      transaction_id: transactionId,
      backup_dir: backup.dir,
      status: 'rolled_back',
      recovery: 'recovered',
    });
  }

  return recovered;
}

/**
 * Restore every interrupted transaction under one backup root before another
 * patch is allowed to start.
 */
function recoverIncompletePatchTransactions(options) {
  const { backupRoot } = options || {};
  if (!backupRoot) {
    throw new PatchTransactionError('补丁恢复参数不完整', {
      code: 'PATCH_TRANSACTION_INVALID',
      phase: 'recovery',
    });
  }

  const lockKey = backupRootLockKey(backupRoot);
  if (activeTransactions.has(lockKey)) {
    throw new PatchTransactionError('已有补丁事务正在执行', { code: 'PATCH_BUSY', phase: 'lock' });
  }
  activeTransactions.add(lockKey);
  try {
    return recoverIncompletePatchTransactionsCore(options);
  } finally {
    activeTransactions.delete(lockKey);
  }
}

/**
 * Commit a prepared set of patch candidates as one recoverable transaction.
 * Files are replaced atomically one-by-one; any later failure restores every
 * file from this transaction's verified before-image.
 */
function runPatchTransaction(options) {
  const {
    backupRoot,
    label = 'patch',
    appVersion = null,
    files,
    afterReplace = () => {},
    verify = () => {},
    afterRollback = () => {},
    verifyAfterRollback = () => {},
    afterRecovery = afterRollback,
    verifyAfterRecovery = verifyAfterRollback,
    manifestWriter = writePrivateJson,
    retention = 3,
    now = new Date(),
    transactionId = crypto.randomBytes(6).toString('hex'),
  } = options || {};

  if (!backupRoot || !Array.isArray(files) || !files.length) {
    throw new PatchTransactionError('补丁事务参数不完整', { code: 'PATCH_TRANSACTION_INVALID', phase: 'prepare' });
  }

  const lockKeys = [
    backupRootLockKey(backupRoot),
    `live-files:${files.map((file) => path.resolve(file.livePath || '')).sort().join('|')}`,
  ];
  if (lockKeys.some((lockKey) => activeTransactions.has(lockKey))) {
    throw new PatchTransactionError('已有补丁事务正在执行', { code: 'PATCH_BUSY', phase: 'lock' });
  }
  for (const lockKey of lockKeys) activeTransactions.add(lockKey);

  let backup = null;
  try {
    recoverIncompletePatchTransactionsCore({
      backupRoot,
      manifestWriter,
      afterRecovery,
      verifyAfterRecovery,
    });

    try {
      backup = createBackup({
        backupRoot,
        label,
        appVersion,
        files,
        transactionId,
        now,
        manifestWriter,
      });
    } catch (cause) {
      throw new PatchTransactionError(`创建本次补丁备份失败: ${cause.message}`, {
        code: 'PATCH_BACKUP_FAILED', phase: 'backup', transactionId, cause,
      });
    }

    try {
      // Persist intent before the first live write. A process exit after this
      // point is recoverable from the verified before-images on next startup.
      updateManifest(backup, {
        status: 'committing',
        committing_at: new Date().toISOString(),
      }, manifestWriter);
      for (const file of files) {
        const original = backup.manifest.files.find((item) => item.name === file.name);
        atomicReplace(file.candidatePath, file.livePath, original.mode, transactionId);
      }
      afterReplace({ transactionId, backupDir: backup.dir });
      verify({ transactionId, backupDir: backup.dir });
      updateManifest(backup, {
        status: 'committed',
        committed_at: new Date().toISOString(),
      }, manifestWriter);
      prunePatchBackups(backupRoot, retention);
      return {
        transaction_id: transactionId,
        backup_dir: backup.dir,
        rollback: 'not_needed',
      };
    } catch (cause) {
      let rollback = 'verified';
      let rollbackError = null;
      try {
        restoreBeforeImages(backup, transactionId);
        afterRollback({ transactionId, backupDir: backup.dir, cause });
        verifyRollback(backup);
        verifyAfterRollback({ transactionId, backupDir: backup.dir, cause });
      } catch (error) {
        rollback = 'failed';
        rollbackError = error;
      }

      let manifestError = null;
      try {
        updateManifest(backup, {
          status: rollback === 'verified' ? 'rolled_back' : 'rollback_failed',
          failed_phase: 'commit',
          error: cause.message,
          rollback_error: rollbackError ? rollbackError.message : null,
        }, manifestWriter);
      } catch (error) {
        manifestError = error;
      }
      const suffix = rollback === 'verified'
        ? '；已从本次事务备份恢复并校验'
        : `；自动恢复失败: ${rollbackError.message}`;
      throw new PatchTransactionError(`补丁事务失败: ${cause.message}${suffix}`, {
        code: rollback === 'verified' ? 'PATCH_FAILED_ROLLED_BACK' : 'PATCH_RECOVERY_REQUIRED',
        phase: 'commit',
        transactionId,
        backupDir: backup.dir,
        rollback,
        cause,
        manifestError,
      });
    }
  } finally {
    for (const lockKey of lockKeys) activeTransactions.delete(lockKey);
  }
}

module.exports = {
  PatchTransactionError,
  hashFile,
  listPatchBackups,
  recoverIncompletePatchTransactions,
  runPatchTransaction,
};
