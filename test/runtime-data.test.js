'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RuntimeDataError, initializeRuntimeData } = require('../lib/runtime-data');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-runtime-data-'));
const HOME = path.join(ROOT, 'home');
const CODE = path.join(ROOT, 'code');
const DEFAULT_DATA = path.join(HOME, 'Library', 'Application Support', 'Typeless Toolkit');

function reset() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CODE, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(CODE, { recursive: true });
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function seedLegacyData() {
  fs.writeFileSync(path.join(CODE, 'accounts.json'), '[{"id":"u1","token":"secret"}]', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'accounts.json.bak'), '[{"id":"u0","token":"old"}]', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'accounts.json.corrupt-2026-07-10.bak'), '{bad', { mode: 0o644 });
  fs.mkdirSync(path.join(CODE, 'profiles', 'u1', 'nested'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(CODE, 'profiles', 'u1', 'user-data.json'), '{"user":"u1"}', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'profiles', 'u1', 'nested', 'state'), 'profile-state', { mode: 0o644 });
  fs.mkdirSync(path.join(CODE, 'runtime-backups', 'backup-1'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(CODE, 'runtime-backups', 'backup-1', 'accounts.json'), 'backup', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'Typeless词库主清单.csv'), 'term\nhello\n', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'config.local.json'), '{"manager_port":7789}', { mode: 0o644 });
  fs.writeFileSync(path.join(CODE, 'typeless-version.json'), '{"version":"2.0.0"}', { mode: 0o644 });
}

beforeEach(reset);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('default path migrates all legacy runtime state without deleting the source', () => {
  seedLegacyData();
  const result = initializeRuntimeData({
    codeDir: CODE,
    homeDir: HOME,
    env: {},
    now: new Date('2026-07-10T00:00:00.000Z'),
  });

  assert.strictEqual(result.dataDir, DEFAULT_DATA);
  assert.strictEqual(result.overridden, false);
  assert.strictEqual(result.migration.status, 'migrated');
  assert.deepStrictEqual(result.migration.copied.sort(), [
    'Typeless词库主清单.csv',
    'accounts.json',
    'accounts.json.bak',
    'accounts.json.corrupt-2026-07-10.bak',
    'config.local.json',
    'profiles',
    'runtime-backups',
    'typeless-version.json',
  ].sort());

  assert.strictEqual(
    fs.readFileSync(path.join(DEFAULT_DATA, 'profiles', 'u1', 'nested', 'state'), 'utf8'),
    'profile-state',
  );
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"u1","token":"secret"}]');
  assert.ok(fs.existsSync(path.join(CODE, 'accounts.json')), 'legacy source must remain in place');
  assert.ok(fs.existsSync(path.join(CODE, 'profiles', 'u1', 'user-data.json')), 'legacy profile source must remain in place');
});

test('migrated directories are 0700 and files plus marker are 0600', () => {
  seedLegacyData();
  initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });

  assert.strictEqual(mode(DEFAULT_DATA), 0o700);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'profiles')), 0o700);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'profiles', 'u1', 'nested')), 0o700);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'accounts.json')), 0o600);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'accounts.json.bak')), 0o600);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'profiles', 'u1', 'user-data.json')), 0o600);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, '.runtime-data-migration-v1.json')), 0o600);
  assert.strictEqual(mode(path.join(CODE, 'accounts.json')), 0o600, 'legacy recovery copy should also be private');
  assert.strictEqual(mode(path.join(CODE, 'profiles')), 0o700, 'legacy profile recovery copy should also be private');
});

test('completion marker makes migration idempotent even if legacy source later changes', () => {
  seedLegacyData();
  const first = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(first.migration.status, 'migrated');

  fs.writeFileSync(path.join(CODE, 'accounts.json'), '[{"id":"changed"}]');
  const second = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(second.migration.status, 'already_migrated');
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"u1","token":"secret"}]');
});

test('conflicting destination fails closed before any missing item is copied', () => {
  seedLegacyData();
  fs.mkdirSync(DEFAULT_DATA, { recursive: true });
  fs.writeFileSync(path.join(DEFAULT_DATA, 'accounts.json'), '[{"id":"destination"}]');

  assert.throws(
    () => initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} }),
    (error) => {
      assert.ok(error instanceof RuntimeDataError);
      assert.strictEqual(error.code, 'RUNTIME_DATA_CONFLICT');
      assert.strictEqual(error.item, 'accounts.json');
      return true;
    },
  );
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"destination"}]');
  assert.ok(!fs.existsSync(path.join(DEFAULT_DATA, 'profiles')));
  assert.ok(!fs.existsSync(path.join(DEFAULT_DATA, '.runtime-data-migration-v1.json')));
});

test('identical pre-existing destination is reused and migration completes', () => {
  seedLegacyData();
  fs.mkdirSync(DEFAULT_DATA, { recursive: true });
  fs.copyFileSync(path.join(CODE, 'accounts.json'), path.join(DEFAULT_DATA, 'accounts.json'));

  const result = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.deepStrictEqual(result.migration.reused, ['accounts.json']);
  assert.ok(result.migration.copied.includes('profiles'));
  assert.strictEqual(result.migration.status, 'migrated');
});

test('TYPELESS_DATA_DIR override is used without legacy migration or marker', () => {
  seedLegacyData();
  const custom = path.join(ROOT, 'custom-data');
  const result = initializeRuntimeData({
    codeDir: CODE,
    homeDir: HOME,
    env: { TYPELESS_DATA_DIR: custom },
  });

  assert.strictEqual(result.dataDir, custom);
  assert.strictEqual(result.overridden, true);
  assert.strictEqual(result.migration.status, 'skipped_override');
  assert.strictEqual(mode(custom), 0o700);
  assert.ok(!fs.existsSync(path.join(custom, 'accounts.json')));
  assert.ok(!fs.existsSync(path.join(custom, '.runtime-data-migration-v1.json')));
});

test('TYPELESS_DATA_DIR 指向源码目录时只收紧运行数据,保留 command 可执行位', () => {
  seedLegacyData();
  const launcher = path.join(CODE, '启动管理器.command');
  fs.writeFileSync(launcher, '#!/bin/zsh\n', { mode: 0o755 });

  const result = initializeRuntimeData({
    codeDir: CODE,
    homeDir: HOME,
    env: { TYPELESS_DATA_DIR: CODE },
  });

  assert.strictEqual(result.dataDir, CODE);
  assert.strictEqual(mode(path.join(CODE, 'accounts.json')), 0o600);
  assert.strictEqual(mode(path.join(CODE, 'profiles')), 0o700);
  assert.strictEqual(mode(launcher), 0o755);
});

test('legacy symbolic links are rejected and no marker is written', (t) => {
  fs.writeFileSync(path.join(CODE, 'outside.json'), 'secret');
  try {
    fs.symlinkSync(path.join(CODE, 'outside.json'), path.join(CODE, 'accounts.json'));
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symbolic links are unavailable');
    throw error;
  }

  assert.throws(
    () => initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} }),
    (error) => error instanceof RuntimeDataError && error.code === 'RUNTIME_DATA_ENTRY_UNSUPPORTED',
  );
  assert.ok(!fs.existsSync(path.join(DEFAULT_DATA, 'accounts.json')));
  assert.ok(!fs.existsSync(path.join(DEFAULT_DATA, '.runtime-data-migration-v1.json')));
});

test('empty first run still writes a valid idempotence marker', () => {
  const first = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(first.migration.status, 'no_legacy_data');
  assert.ok(fs.existsSync(path.join(DEFAULT_DATA, '.runtime-data-migration-v1.json')));
  const second = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(second.migration.status, 'already_migrated');
});

test('空目录首次启动后,稳定目录仍为空时可从后来找到的旧目录补做迁移', () => {
  const first = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(first.migration.status, 'no_legacy_data');

  seedLegacyData();
  const second = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(second.migration.status, 'migrated');
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"u1","token":"secret"}]');
});

test('空 marker 后稳定目录已有导入数据时,不再采用后来出现的旧目录', () => {
  initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  fs.writeFileSync(path.join(DEFAULT_DATA, 'accounts.json'), '[{"id":"imported"}]', { mode: 0o600 });
  seedLegacyData();

  const second = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(second.migration.status, 'already_migrated');
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"imported"}]');
});

test('空 marker 只迁过 config 时,之后仍可补迁真正的账号数据', () => {
  initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  fs.writeFileSync(path.join(CODE, 'config.local.json'), '{"manager_port":7789}');
  const configOnly = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(configOnly.migration.status, 'migrated');

  fs.rmSync(path.join(CODE, 'config.local.json'));
  fs.writeFileSync(path.join(CODE, 'accounts.json'), '[{"id":"late-user"}]');
  fs.mkdirSync(path.join(CODE, 'profiles', 'late-user'), { recursive: true });
  fs.writeFileSync(path.join(CODE, 'profiles', 'late-user', 'user-data.json'), '{}');
  fs.writeFileSync(path.join(CODE, 'Typeless词库主清单.csv'), 'late\n');

  const withAccounts = initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(withAccounts.migration.status, 'migrated');
  assert.strictEqual(fs.readFileSync(path.join(DEFAULT_DATA, 'accounts.json'), 'utf8'), '[{"id":"late-user"}]');
  assert.ok(fs.existsSync(path.join(DEFAULT_DATA, 'config.local.json')));
});

test('existing stable-only data also has private permissions enforced', () => {
  fs.mkdirSync(DEFAULT_DATA, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(DEFAULT_DATA, 'accounts.json'), '[]', { mode: 0o644 });

  initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} });
  assert.strictEqual(mode(DEFAULT_DATA), 0o700);
  assert.strictEqual(mode(path.join(DEFAULT_DATA, 'accounts.json')), 0o600);
});

test('invalid marker fails closed instead of silently repeating migration', () => {
  seedLegacyData();
  fs.mkdirSync(DEFAULT_DATA, { recursive: true });
  fs.writeFileSync(path.join(DEFAULT_DATA, '.runtime-data-migration-v1.json'), '{bad json');

  assert.throws(
    () => initializeRuntimeData({ codeDir: CODE, homeDir: HOME, env: {} }),
    (error) => error instanceof RuntimeDataError && error.code === 'RUNTIME_DATA_MARKER_INVALID',
  );
  assert.ok(!fs.existsSync(path.join(DEFAULT_DATA, 'accounts.json')));
});
