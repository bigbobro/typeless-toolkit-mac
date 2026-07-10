'use strict';

/**
 * 运行数据备份包往返一致性测试
 *
 * 覆盖:createRuntimeBackupBundle() -> restoreRuntimeBackupBundle(bundle)
 * 这是「出错就会丢数据」的关键路径:候选数据必须先完整 staging,再事务提交。
 *
 * 数据隔离:在 require lib/common.js 之前把 TYPELESS_DATA_DIR 指向 os.tmpdir()
 * 下的临时目录,common.js 顶部的 ROOT / ACCOUNTS_FILE / MASTER_CSV / PROFILES_DIR /
 * RUNTIME_BACKUPS_DIR 全部据此派生,所有读写都落在临时目录里,绝不触碰用户真实数据。
 * 测试结束时删除临时目录。
 *
 * 不触碰:restoreSnapshot / switch / resetDevice / patchPaywall / captureTokenCDP /
 * launchTypeless / killTypeless 等会动真实 Typeless App、真实登录态或网络的函数一律不测。
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 关键:必须在 require common.js 之前设置数据目录
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-backup-test-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const C = require('../lib/common.js');

// 前置断言:确认所有数据路径确实落在临时目录内,否则立即失败(防止误伤真实数据)
before(() => {
  assert.strictEqual(C.ROOT, DATA_DIR, 'ROOT 未指向临时目录');
  for (const p of [C.ACCOUNTS_FILE, C.MASTER_CSV, C.PROFILES_DIR, C.RUNTIME_BACKUPS_DIR]) {
    assert.ok(p.startsWith(DATA_DIR + path.sep), `数据路径逃逸出临时目录: ${p}`);
  }
});

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// 每个用例前:把临时 ROOT 清空重建,保证用例互不干扰
beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

// 播种一套典型运行数据:accounts.json + 主词库 CSV + 两个 profile(含嵌套多文件)
const ACCOUNTS = [
  { user_id: 'u-001', email: 'a@example.com', token: 'tok-aaa', nickname: '甲' },
  { user_id: 'u-002', email: 'b@example.com', token: 'tok-bbb', nickname: '乙' },
];
const MASTER_TEXT = 'hello\nworld\n你好\n';
const PROFILE_FILES = {
  'u-001/user-data.json': '{"session":"one"}',
  'u-001/app-storage.json': '{"userData":{"x":1}}',
  'u-002/user-data.json': '{"session":"two"}',
};

function seedRuntimeData() {
  fs.writeFileSync(C.ACCOUNTS_FILE, JSON.stringify(ACCOUNTS, null, 2));
  fs.writeFileSync(C.MASTER_CSV, MASTER_TEXT);
  for (const [rel, content] of Object.entries(PROFILE_FILES)) {
    const abs = path.join(C.PROFILES_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readRuntimeGeneration() {
  const files = {};
  for (const [name, abs] of [
    ['accounts.json', C.ACCOUNTS_FILE],
    [path.basename(C.MASTER_CSV), C.MASTER_CSV],
  ]) {
    if (fs.existsSync(abs)) files[name] = fs.readFileSync(abs);
  }
  if (fs.existsSync(C.PROFILES_DIR)) {
    const visit = (dir, prefix) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) visit(abs, rel);
        else files[`profiles/${rel}`] = fs.readFileSync(abs);
      }
    };
    visit(C.PROFILES_DIR, '');
  }
  return files;
}

function assertGenerationEqual(actual, expected) {
  assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) {
    assert.ok(actual[key].equals(expected[key]), `运行数据文件不一致:${key}`);
  }
}

function integrityEntries(files) {
  return Object.entries(files).map(([filePath, content]) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return {
      path: filePath,
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function writeRestoreManifestFixture(transactionDir, { phase, targets, original, expected }) {
  fs.writeFileSync(path.join(transactionDir, 'restore-manifest.json'), JSON.stringify({
    type: 'typeless-toolkit-runtime-restore',
    version: 1,
    transaction_id: path.basename(transactionDir),
    phase,
    created_at: new Date().toISOString(),
    targets,
    original_integrity: integrityEntries(original),
    expected_integrity: integrityEntries(expected),
    current_backup: null,
    restored_backup: null,
  }, null, 2));
}

test('bundle 结构正确:type/version/files 齐全,涵盖 accounts + master + profiles', () => {
  seedRuntimeData();
  const bundle = C.createRuntimeBackupBundle();

  assert.strictEqual(bundle.type, 'typeless-toolkit-macos-runtime-backup');
  assert.strictEqual(bundle.version, 1);
  assert.ok(Array.isArray(bundle.files));

  const paths = bundle.files.map((f) => f.path).sort();
  assert.deepStrictEqual(paths, [
    'accounts.json',
    'profiles/u-001/app-storage.json',
    'profiles/u-001/user-data.json',
    'profiles/u-002/user-data.json',
    path.basename(C.MASTER_CSV),
  ].sort());

  for (const f of bundle.files) {
    assert.strictEqual(f.encoding, 'base64');
    assert.strictEqual(typeof f.content, 'string');
  }
});

test('往返一致:恢复后 accounts / master / profiles 与写入时逐字节相同', () => {
  seedRuntimeData();
  const bundle = C.createRuntimeBackupBundle();

  // 破坏现场:改 accounts、改 master、彻底删掉 profiles,并塞入一个备份中不存在的脏 profile
  fs.writeFileSync(C.ACCOUNTS_FILE, JSON.stringify([{ user_id: 'wiped' }]));
  fs.writeFileSync(C.MASTER_CSV, 'garbage\n');
  fs.rmSync(C.PROFILES_DIR, { recursive: true, force: true });
  const junkAbs = path.join(C.PROFILES_DIR, 'u-999/user-data.json');
  fs.mkdirSync(path.dirname(junkAbs), { recursive: true });
  fs.writeFileSync(junkAbs, '{"junk":true}');

  const result = C.restoreRuntimeBackupBundle(bundle);
  assert.strictEqual(result.restored_files, Object.keys(PROFILE_FILES).length + 2); // profiles + accounts + master

  // accounts.json 完整还原
  assert.strictEqual(
    fs.readFileSync(C.ACCOUNTS_FILE, 'utf8'),
    JSON.stringify(ACCOUNTS, null, 2),
  );
  assert.deepStrictEqual(C.readAccounts(), ACCOUNTS);

  // 主词库完整还原
  assert.strictEqual(fs.readFileSync(C.MASTER_CSV, 'utf8'), MASTER_TEXT);

  // 每个 profile 文件逐字节还原
  for (const [rel, content] of Object.entries(PROFILE_FILES)) {
    assert.strictEqual(
      fs.readFileSync(path.join(C.PROFILES_DIR, rel), 'utf8'),
      content,
      `profile 文件未正确还原: ${rel}`,
    );
  }

  // 恢复是「清空重写」语义:备份包里没有的脏 profile 必须被清掉
  assert.ok(!fs.existsSync(junkAbs), '恢复应清空 profiles 目录,脏文件不应残留');
});

test('恢复会先自动备份当前数据(before-restore 落到 runtime-backups/)', () => {
  seedRuntimeData();
  const bundle = C.createRuntimeBackupBundle();
  const result = C.restoreRuntimeBackupBundle(bundle);

  assert.ok(result.current_backup, '应返回 before-restore 备份目录');
  assert.ok(fs.existsSync(result.current_backup), 'before-restore 备份目录应真实存在');
  assert.ok(result.current_backup.startsWith(C.RUNTIME_BACKUPS_DIR));
  // 自动备份里应含 accounts.json,证明恢复前的现场被保住了
  assert.ok(fs.existsSync(path.join(result.current_backup, 'accounts.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.current_backup, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.complete, true);
  assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('运行备份只在 staging 完整复制和校验后发布,并以内容摘要判断状态', () => {
  seedRuntimeData();
  const backupDir = C.backupRuntimeData('manual');
  assert.ok(fs.existsSync(backupDir));
  assert.ok(!path.basename(backupDir).endsWith('.preparing'));
  assert.deepStrictEqual(
    fs.readdirSync(C.RUNTIME_BACKUPS_DIR).filter(name => name.endsWith('.preparing')),
    [],
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.type, 'typeless-toolkit-runtime-backup');
  assert.strictEqual(manifest.complete, true);
  assert.strictEqual(manifest.file_count, Object.keys(PROFILE_FILES).length + 2);
  assert.strictEqual(C.runtimeDataStatus().status, 'backed_up');

  // 即使把 mtime 调回备份前,内容变化也不能误报“已备份”。
  const previous = fs.statSync(C.ACCOUNTS_FILE);
  fs.writeFileSync(C.ACCOUNTS_FILE, JSON.stringify([{ user_id: 'changed' }]));
  fs.utimesSync(C.ACCOUNTS_FILE, previous.atime, previous.mtime);
  assert.strictEqual(C.runtimeDataStatus().status, 'needs_backup');
});

test('备份复制失败会清理 staging,不会留下可见的残缺最终目录', () => {
  seedRuntimeData();
  assert.throws(() => C.backupRuntimeData('fault', {
    faultInjector(point) {
      if (point === 'backup:after-copy') throw new Error('injected copy failure');
    },
  }), /injected copy failure/);

  assert.deepStrictEqual(fs.readdirSync(C.RUNTIME_BACKUPS_DIR), []);
  assert.strictEqual(C.runtimeDataStatus().latest_backup, null);
  assert.strictEqual(C.runtimeDataStatus().status, 'needs_backup');
});

test('状态清理 preparing 并忽略无完整 manifest 的历史或残缺备份', () => {
  seedRuntimeData();
  const legacy = path.join(C.RUNTIME_BACKUPS_DIR, 'legacy-before-manifest');
  const preparing = path.join(C.RUNTIME_BACKUPS_DIR, '.interrupted.preparing');
  const incomplete = path.join(C.RUNTIME_BACKUPS_DIR, 'incomplete-manifest');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'accounts.json'), 'legacy');
  fs.mkdirSync(preparing, { recursive: true });
  fs.writeFileSync(path.join(preparing, 'accounts.json'), 'partial');
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'manifest.json'), '{"complete":false}');

  const status = C.runtimeDataStatus();
  assert.strictEqual(status.latest_backup, null);
  assert.strictEqual(status.backed_up, false);
  assert.strictEqual(status.status, 'needs_backup');
  assert.ok(!fs.existsSync(preparing), '中断 staging 应被清理');
  assert.ok(fs.existsSync(legacy), '无 manifest 的历史备份应保留给人工恢复');
  assert.ok(fs.existsSync(incomplete), '无法验证的最终目录不应被自动删除');
});

test('恢复提交中断会自动回滚 accounts/master/profiles 的原始一代数据', () => {
  seedRuntimeData();
  const incomingBundle = C.createRuntimeBackupBundle();

  fs.writeFileSync(C.ACCOUNTS_FILE, JSON.stringify([{ user_id: 'current', token: 'keep-me' }]));
  fs.writeFileSync(C.MASTER_CSV, 'current-only\n');
  fs.rmSync(C.PROFILES_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(C.PROFILES_DIR, 'current'), { recursive: true });
  fs.writeFileSync(path.join(C.PROFILES_DIR, 'current/user-data.json'), '{"current":true}');
  const original = readRuntimeGeneration();

  assert.throws(() => C.restoreRuntimeBackupBundle(incomingBundle, {
    faultInjector(point) {
      if (point === 'restore:after-install') throw new Error('injected restore interruption');
    },
  }), /injected restore interruption/);

  assertGenerationEqual(readRuntimeGeneration(), original);
  assert.deepStrictEqual(
    fs.readdirSync(DATA_DIR).filter(name => name.startsWith('.runtime-restore-')),
    [],
    '恢复事务 staging 不应残留',
  );
  assert.strictEqual(C.runtimeDataStatus().status, 'backed_up', 'before-restore 应完整备份回滚后的现场');
});

test('恢复中断回滚会保持原本不存在的顶层目标仍然不存在', () => {
  seedRuntimeData();
  const incomingBundle = C.createRuntimeBackupBundle();
  fs.rmSync(C.MASTER_CSV, { force: true });
  fs.rmSync(C.PROFILES_DIR, { recursive: true, force: true });
  fs.writeFileSync(C.ACCOUNTS_FILE, '[{"user_id":"pre-existing"}]');
  const original = readRuntimeGeneration();

  assert.throws(() => C.restoreRuntimeBackupBundle(incomingBundle, {
    faultInjector(point, details) {
      if (point === 'restore:after-install' && details.name === path.basename(C.MASTER_CSV)) {
        throw new Error('injected after absent target install');
      }
    },
  }), /injected after absent target install/);

  assertGenerationEqual(readRuntimeGeneration(), original);
  assert.ok(!fs.existsSync(C.MASTER_CSV));
  assert.ok(!fs.existsSync(C.PROFILES_DIR));
});

test('后续操作会发现 seeded committing 残留并恢复断电前的原始一代', () => {
  const masterName = path.basename(C.MASTER_CSV);
  const original = {
    'accounts.json': '[{"user_id":"before-crash"}]',
    'profiles/original/user-data.json': '{"before":true}',
  };
  const candidate = {
    'accounts.json': '[{"user_id":"candidate"}]',
    [masterName]: 'candidate\n',
    'profiles/imported/user-data.json': '{"candidate":true}',
  };
  const targets = [
    { name: 'accounts.json', kind: 'file', original_present: true },
    { name: masterName, kind: 'file', original_present: false },
    { name: 'profiles', kind: 'dir', original_present: true },
  ];
  const transactionDir = path.join(DATA_DIR, '.runtime-restore-seeded-crash.preparing');
  const beforeDir = path.join(transactionDir, 'before');
  fs.mkdirSync(path.join(beforeDir, 'profiles/original'), { recursive: true });
  fs.writeFileSync(path.join(beforeDir, 'accounts.json'), original['accounts.json']);
  fs.writeFileSync(
    path.join(beforeDir, 'profiles/original/user-data.json'),
    original['profiles/original/user-data.json'],
  );

  fs.writeFileSync(C.ACCOUNTS_FILE, candidate['accounts.json']);
  fs.writeFileSync(C.MASTER_CSV, candidate[masterName]);
  fs.mkdirSync(path.join(C.PROFILES_DIR, 'imported'), { recursive: true });
  fs.writeFileSync(
    path.join(C.PROFILES_DIR, 'imported/user-data.json'),
    candidate['profiles/imported/user-data.json'],
  );
  writeRestoreManifestFixture(transactionDir, {
    phase: 'committing', targets, original, expected: candidate,
  });

  C.runtimeDataStatus();
  assertGenerationEqual(readRuntimeGeneration(), Object.fromEntries(
    Object.entries(original).map(([key, value]) => [key, Buffer.from(value)]),
  ));
  assert.ok(!fs.existsSync(C.MASTER_CSV), '原本不存在的主词库必须移除');
  assert.ok(!fs.existsSync(transactionDir), '成功恢复后应清理事务现场');
});

test('seeded committed 残留只清理事务目录,不回滚已提交的新数据', () => {
  const masterName = path.basename(C.MASTER_CSV);
  const original = { 'accounts.json': '[{"user_id":"old"}]' };
  const candidate = { 'accounts.json': '[{"user_id":"committed"}]' };
  const targets = [
    { name: 'accounts.json', kind: 'file', original_present: true },
    { name: masterName, kind: 'file', original_present: false },
    { name: 'profiles', kind: 'dir', original_present: false },
  ];
  const transactionDir = path.join(DATA_DIR, '.runtime-restore-seeded-committed.preparing');
  fs.mkdirSync(path.join(transactionDir, 'before'), { recursive: true });
  fs.writeFileSync(path.join(transactionDir, 'before/accounts.json'), original['accounts.json']);
  fs.writeFileSync(C.ACCOUNTS_FILE, candidate['accounts.json']);
  writeRestoreManifestFixture(transactionDir, {
    phase: 'committed', targets, original, expected: candidate,
  });

  const recovered = C.recoverIncompleteRuntimeRestores();
  assert.deepStrictEqual(recovered.map(item => item.action), ['cleaned_committed']);
  assert.strictEqual(fs.readFileSync(C.ACCOUNTS_FILE, 'utf8'), candidate['accounts.json']);
  assert.ok(!fs.existsSync(transactionDir));
});

test('恢复事务 manifest 只能声明 canonical 运行数据目标', () => {
  seedRuntimeData();
  const configPath = path.join(DATA_DIR, 'config.local.json');
  fs.writeFileSync(configPath, '{"keep":true}');
  const transactionDir = path.join(DATA_DIR, '.runtime-restore-invalid-target.preparing');
  fs.mkdirSync(path.join(transactionDir, 'before'), { recursive: true });
  writeRestoreManifestFixture(transactionDir, {
    phase: 'committing',
    targets: [
      { name: 'accounts.json', kind: 'file', original_present: true },
      { name: path.basename(C.MASTER_CSV), kind: 'file', original_present: true },
      { name: 'config.local.json', kind: 'file', original_present: true },
    ],
    original: {},
    expected: {},
  });

  assert.throws(() => C.recoverIncompleteRuntimeRestores(), (error) => {
    assert.strictEqual(error.code, 'RUNTIME_RESTORE_RECOVERY_REQUIRED');
    assert.match(error.message, /目标与当前运行数据目标不匹配/);
    return true;
  });
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{"keep":true}');
  assert.ok(fs.existsSync(transactionDir), '无法验证的事务现场必须保留给人工处理');
});

test('多个 committing 残留按 newest-first 恢复 before-image 链', () => {
  const masterName = path.basename(C.MASTER_CSV);
  const targets = [
    { name: 'accounts.json', kind: 'file', original_present: true },
    { name: masterName, kind: 'file', original_present: false },
    { name: 'profiles', kind: 'dir', original_present: false },
  ];
  const generations = {
    oldest: { 'accounts.json': '[{"generation":0}]' },
    middle: { 'accounts.json': '[{"generation":1}]' },
    newest: { 'accounts.json': '[{"generation":2}]' },
  };
  const olderDir = path.join(DATA_DIR, '.runtime-restore-2026-07-10T00-00-00-older.preparing');
  const newerDir = path.join(DATA_DIR, '.runtime-restore-2026-07-10T00-00-01-newer.preparing');
  for (const [dir, original, expected] of [
    [olderDir, generations.oldest, generations.middle],
    [newerDir, generations.middle, generations.newest],
  ]) {
    fs.mkdirSync(path.join(dir, 'before'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'before/accounts.json'), original['accounts.json']);
    writeRestoreManifestFixture(dir, { phase: 'committing', targets, original, expected });
  }
  fs.writeFileSync(C.ACCOUNTS_FILE, generations.newest['accounts.json']);

  const recovered = C.recoverIncompleteRuntimeRestores();
  assert.deepStrictEqual(
    recovered.map(item => path.basename(item.transaction_dir)),
    [path.basename(newerDir), path.basename(olderDir)],
  );
  assert.strictEqual(fs.readFileSync(C.ACCOUNTS_FILE, 'utf8'), generations.oldest['accounts.json']);
  assert.ok(!fs.existsSync(newerDir));
  assert.ok(!fs.existsSync(olderDir));
});

test('备份包缺少某个顶层目标时,成功恢复会以整代语义移除旧目标', () => {
  seedRuntimeData();
  const accountsOnly = {
    type: 'typeless-toolkit-macos-runtime-backup',
    version: 1,
    files: [{
      path: 'accounts.json',
      encoding: 'base64',
      content: Buffer.from('[{"user_id":"only"}]').toString('base64'),
    }],
  };

  C.restoreRuntimeBackupBundle(accountsOnly);
  assert.strictEqual(fs.readFileSync(C.ACCOUNTS_FILE, 'utf8'), '[{"user_id":"only"}]');
  assert.ok(!fs.existsSync(C.MASTER_CSV));
  assert.ok(!fs.existsSync(C.PROFILES_DIR));
});

// ---- 校验失败路径:必须在「清空 profiles」这一破坏性步骤之前抛错,不能丢数据 ----

test('非法/未知备份包被拒:抛错且不破坏现有 profiles', () => {
  const cases = [
    { bundle: null, re: /类型不正确/, desc: 'null' },
    { bundle: { type: 'wrong', version: 1, files: [] }, re: /类型不正确/, desc: '类型错误' },
    { bundle: { type: 'typeless-toolkit-macos-runtime-backup', version: 2, files: [] }, re: /版本/, desc: '版本不支持' },
    { bundle: { type: 'typeless-toolkit-macos-runtime-backup', version: 1, files: 'x' }, re: /缺少 files/, desc: 'files 非数组' },
    {
      bundle: { type: 'typeless-toolkit-macos-runtime-backup', version: 1, files: [{ path: '../evil', encoding: 'base64', content: '' }] },
      re: /非法路径/, desc: '路径穿越',
    },
    {
      bundle: { type: 'typeless-toolkit-macos-runtime-backup', version: 1, files: [{ path: 'random.txt', encoding: 'base64', content: '' }] },
      re: /未知文件/, desc: '未知文件名',
    },
    {
      bundle: { type: 'typeless-toolkit-macos-runtime-backup', version: 1, files: [{ path: 'accounts.json', encoding: 'base64', content: 'YQ' }] },
      re: /base64 不合法/, desc: '非规范 base64',
    },
    {
      bundle: {
        type: 'typeless-toolkit-macos-runtime-backup', version: 1,
        files: [
          { path: 'accounts.json', encoding: 'base64', content: '' },
          { path: 'accounts.json', encoding: 'base64', content: '' },
        ],
      },
      re: /重复路径/, desc: '重复路径',
    },
    {
      bundle: {
        type: 'typeless-toolkit-macos-runtime-backup', version: 1,
        files: [
          { path: 'profiles/u-001', encoding: 'base64', content: '' },
          { path: 'profiles/u-001/user-data.json', encoding: 'base64', content: '' },
        ],
      },
      re: /路径冲突/, desc: '文件和子路径冲突',
    },
  ];

  for (const c of cases) {
    seedRuntimeData();
    assert.throws(() => C.restoreRuntimeBackupBundle(c.bundle), c.re, `用例「${c.desc}」应抛错`);
    // 完整校验在 staging 和提交之前,抛错时现有 profiles 必须原封不动。
    for (const [rel, content] of Object.entries(PROFILE_FILES)) {
      assert.strictEqual(
        fs.readFileSync(path.join(C.PROFILES_DIR, rel), 'utf8'),
        content,
        `用例「${c.desc}」抛错后不应破坏现有 profile: ${rel}`,
      );
    }
  }
});
