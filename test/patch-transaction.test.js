'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PatchTransactionError,
  hashFile,
  listPatchBackups,
  recoverIncompletePatchTransactions,
  runPatchTransaction,
} = require('../lib/patch-transaction');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-patch-transaction-'));
const LIVE = path.join(ROOT, 'live');
const CANDIDATES = path.join(ROOT, 'candidates');
const BACKUPS = path.join(ROOT, 'backups');

function seed() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(LIVE, { recursive: true });
  fs.mkdirSync(CANDIDATES, { recursive: true });
  fs.writeFileSync(path.join(LIVE, 'app.asar'), 'old-asar');
  fs.writeFileSync(path.join(LIVE, 'Info.plist'), 'old-plist');
  fs.writeFileSync(path.join(CANDIDATES, 'app.asar'), 'new-asar');
  fs.writeFileSync(path.join(CANDIDATES, 'Info.plist'), 'new-plist');
}

function transactionOptions(overrides = {}) {
  return {
    backupRoot: BACKUPS,
    label: 'paywall',
    appVersion: '2.0.0',
    transactionId: overrides.transactionId || 'tx-test',
    now: new Date('2026-07-10T00:00:00.000Z'),
    files: [
      {
        name: 'app.asar',
        livePath: path.join(LIVE, 'app.asar'),
        candidatePath: path.join(CANDIDATES, 'app.asar'),
        expectedOriginalSha256: hashFile(path.join(LIVE, 'app.asar')),
      },
      {
        name: 'Info.plist',
        livePath: path.join(LIVE, 'Info.plist'),
        candidatePath: path.join(CANDIDATES, 'Info.plist'),
        expectedOriginalSha256: hashFile(path.join(LIVE, 'Info.plist')),
      },
    ],
    ...overrides,
  };
}

function writeManifest(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.test-tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}

function seedIncompleteTransaction({
  status = 'committing',
  transactionId = 'tx-interrupted',
  liveValues = { 'app.asar': 'partially-new-asar', 'Info.plist': 'old-plist' },
} = {}) {
  const dir = path.join(BACKUPS, `2026-07-09-${transactionId}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = ['app.asar', 'Info.plist'].map((name) => {
    const livePath = path.join(LIVE, name);
    const backupPath = path.join(dir, name);
    fs.copyFileSync(livePath, backupPath);
    const stat = fs.statSync(livePath);
    return {
      name,
      live_path: livePath,
      backup_file: name,
      sha256: hashFile(backupPath),
      size: stat.size,
      mode: stat.mode & 0o777,
    };
  });
  writeManifest(path.join(dir, 'manifest.json'), {
    type: 'typeless-toolkit-patch-transaction',
    version: 1,
    transaction_id: transactionId,
    label: 'paywall',
    app_version: '2.0.0',
    created_at: '2026-07-09T00:00:00.000Z',
    status,
    files,
  });
  for (const [name, value] of Object.entries(liveValues)) {
    fs.writeFileSync(path.join(LIVE, name), value);
  }
  return dir;
}

beforeEach(seed);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('成功提交:本次 before-image 已校验保存,live 原子替换为候选文件', () => {
  let verified = false;
  const result = runPatchTransaction(transactionOptions({
    verify() {
      assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'new-asar');
      assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'new-plist');
      verified = true;
    },
  }));

  assert.ok(verified);
  assert.strictEqual(result.rollback, 'not_needed');
  assert.strictEqual(fs.readFileSync(path.join(result.backup_dir, 'app.asar'), 'utf8'), 'old-asar');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backup_dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.status, 'committed');
  assert.strictEqual(manifest.app_version, '2.0.0');
});

test('首次写入 live 前必须先持久化 committing 状态', () => {
  let sawCommitting = false;
  runPatchTransaction(transactionOptions({
    transactionId: 'tx-ordering',
    manifestWriter(filePath, manifest) {
      if (manifest.status === 'committing') {
        assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'old-asar');
        assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
        sawCommitting = true;
      }
      writeManifest(filePath, manifest);
    },
  }));
  assert.ok(sawCommitting);
});

test('committing 中断:显式恢复使用校验过的 before-image 并记录 recovered', () => {
  const dir = seedIncompleteTransaction();
  const recovered = recoverIncompletePatchTransactions({ backupRoot: BACKUPS });

  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].transaction_id, 'tx-interrupted');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'old-asar');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.status, 'rolled_back');
  assert.strictEqual(manifest.recovery, 'recovered');
  assert.strictEqual(manifest.recovered_from, 'committing');
});

test('prepared 残留:下一次补丁先自动恢复,再创建新事务', () => {
  const nextOptions = transactionOptions({ transactionId: 'tx-next' });
  const interruptedDir = seedIncompleteTransaction({
    status: 'prepared',
    liveValues: {},
  });
  let recoveredFirst = false;

  const result = runPatchTransaction({
    ...nextOptions,
    afterRecovery() {
      assert.fail('prepared 未写 live,不应触发恢复后的重签名钩子');
    },
    verify() {
      const interrupted = JSON.parse(fs.readFileSync(path.join(interruptedDir, 'manifest.json'), 'utf8'));
      assert.strictEqual(interrupted.status, 'rolled_back');
      assert.strictEqual(interrupted.recovered_from, 'prepared');
      recoveredFirst = true;
    },
  });

  assert.ok(recoveredFirst);
  assert.strictEqual(result.transaction_id, 'tx-next');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'new-asar');
  const interrupted = JSON.parse(fs.readFileSync(path.join(interruptedDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(interrupted.status, 'rolled_back');
  assert.strictEqual(interrupted.recovery, 'recovered');
});

test('prepared 残留后 live 已被外部更新:保留外部变化并阻止新补丁', () => {
  const nextOptions = transactionOptions({ transactionId: 'tx-after-external-update' });
  const interruptedDir = seedIncompleteTransaction({
    status: 'prepared',
    liveValues: { 'app.asar': 'updated-by-typeless' },
  });

  assert.throws(() => runPatchTransaction(nextOptions), (error) => {
    assert.ok(error instanceof PatchTransactionError);
    assert.strictEqual(error.code, 'PATCH_RECOVERY_REQUIRED');
    assert.strictEqual(error.phase, 'recovery');
    assert.strictEqual(error.rollback, 'failed');
    assert.match(error.message, /live 文件已变化，拒绝覆盖/);
    return true;
  });

  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'updated-by-typeless');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
  assert.strictEqual(listPatchBackups(BACKUPS).length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(interruptedDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.status, 'prepared');
  assert.match(manifest.recovery_error, /live 文件已变化/);
});

test('未完成事务的 before-image 损坏:恢复失败并阻止新补丁', () => {
  const nextOptions = transactionOptions({ transactionId: 'tx-must-not-start' });
  const dir = seedIncompleteTransaction();
  fs.writeFileSync(path.join(dir, 'app.asar'), 'corrupt-before-image');

  assert.throws(() => recoverIncompletePatchTransactions({ backupRoot: BACKUPS }), (error) => {
    assert.ok(error instanceof PatchTransactionError);
    assert.strictEqual(error.code, 'PATCH_RECOVERY_REQUIRED');
    assert.strictEqual(error.phase, 'recovery');
    assert.strictEqual(error.rollback, 'failed');
    return true;
  });
  assert.throws(() => runPatchTransaction(nextOptions), (error) => {
    assert.strictEqual(error.code, 'PATCH_RECOVERY_REQUIRED');
    assert.strictEqual(error.rollback, 'failed');
    return true;
  });

  assert.strictEqual(listPatchBackups(BACKUPS).length, 1);
  assert.ok(!listPatchBackups(BACKUPS).some((backup) => backup.manifest.transaction_id === 'tx-must-not-start'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.status, 'committing');
  assert.match(manifest.recovery_error, /before-image/);
});

test('提交后验证失败:只恢复本次 before-image,并验证恢复结果', () => {
  let rollbackHook = false;
  assert.throws(() => runPatchTransaction(transactionOptions({
    verify() { throw new Error('模拟签名验证失败'); },
    afterRollback() { rollbackHook = true; },
  })), (error) => {
    assert.ok(error instanceof PatchTransactionError);
    assert.strictEqual(error.code, 'PATCH_FAILED_ROLLED_BACK');
    assert.strictEqual(error.rollback, 'verified');
    return true;
  });

  assert.ok(rollbackHook);
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'old-asar');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
  const [backup] = listPatchBackups(BACKUPS);
  assert.strictEqual(backup.manifest.status, 'rolled_back');
});

test('回滚已校验时 manifest 写失败:保留原事务错误和 verified 结论', () => {
  assert.throws(() => runPatchTransaction(transactionOptions({
    transactionId: 'tx-verified-manifest-failure',
    verify() { throw new Error('原始补丁验证失败'); },
    manifestWriter(filePath, manifest) {
      if (manifest.status === 'rolled_back') throw new Error('无法记录已回滚');
      writeManifest(filePath, manifest);
    },
  })), (error) => {
    assert.ok(error instanceof PatchTransactionError);
    assert.strictEqual(error.code, 'PATCH_FAILED_ROLLED_BACK');
    assert.strictEqual(error.rollback, 'verified');
    assert.strictEqual(error.cause.message, '原始补丁验证失败');
    assert.strictEqual(error.manifest_error, '无法记录已回滚');
    return true;
  });

  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'old-asar');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
});

test('回滚已失败时 manifest 写失败:始终返回 recovery_required 和 failed', () => {
  assert.throws(() => runPatchTransaction(transactionOptions({
    transactionId: 'tx-failed-manifest-failure',
    verify() { throw new Error('原始补丁验证失败'); },
    verifyAfterRollback() { throw new Error('回滚验证失败'); },
    manifestWriter(filePath, manifest) {
      if (manifest.status === 'rollback_failed') throw new Error('无法记录回滚失败');
      writeManifest(filePath, manifest);
    },
  })), (error) => {
    assert.ok(error instanceof PatchTransactionError);
    assert.strictEqual(error.code, 'PATCH_RECOVERY_REQUIRED');
    assert.strictEqual(error.rollback, 'failed');
    assert.strictEqual(error.cause.message, '原始补丁验证失败');
    assert.strictEqual(error.manifest_error, '无法记录回滚失败');
    assert.match(error.message, /自动恢复失败: 回滚验证失败/);
    return true;
  });
});

test('恢复后的外部验证失败:明确返回 recovery_required,绝不声称已恢复', () => {
  assert.throws(() => runPatchTransaction(transactionOptions({
    afterReplace() { throw new Error('模拟 codesign 失败'); },
    verifyAfterRollback() { throw new Error('模拟回滚签名失败'); },
  })), (error) => {
    assert.strictEqual(error.code, 'PATCH_RECOVERY_REQUIRED');
    assert.strictEqual(error.rollback, 'failed');
    assert.match(error.message, /自动恢复失败/);
    return true;
  });

  // 文件 before-image 已恢复,但外部签名验证失败,所以事务仍必须标记 recovery_required。
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'old-asar');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
});

test('补丁准备后原文件发生变化:备份阶段 fail closed,不覆盖 live', () => {
  const options = transactionOptions();
  fs.writeFileSync(path.join(LIVE, 'app.asar'), 'updated-by-app');
  assert.throws(() => runPatchTransaction(options), (error) => {
    assert.strictEqual(error.code, 'PATCH_BACKUP_FAILED');
    assert.strictEqual(error.rollback, 'not_needed');
    return true;
  });
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'app.asar'), 'utf8'), 'updated-by-app');
  assert.strictEqual(fs.readFileSync(path.join(LIVE, 'Info.plist'), 'utf8'), 'old-plist');
});
