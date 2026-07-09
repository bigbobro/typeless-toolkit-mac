'use strict';

/**
 * 运行数据备份包往返一致性测试
 *
 * 覆盖:createRuntimeBackupBundle() -> restoreRuntimeBackupBundle(bundle)
 * 这是「出错就会丢数据」的关键路径:恢复前会先备份、再清空 profiles、再写回。
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
  ];

  for (const c of cases) {
    seedRuntimeData();
    assert.throws(() => C.restoreRuntimeBackupBundle(c.bundle), c.re, `用例「${c.desc}」应抛错`);
    // 关键:破坏性的 rmSync(PROFILES_DIR) 在校验之后,抛错时现有 profiles 必须原封不动
    for (const [rel, content] of Object.entries(PROFILE_FILES)) {
      assert.strictEqual(
        fs.readFileSync(path.join(C.PROFILES_DIR, rel), 'utf8'),
        content,
        `用例「${c.desc}」抛错后不应破坏现有 profile: ${rel}`,
      );
    }
  }
});
