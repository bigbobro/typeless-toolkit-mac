'use strict';

/**
 * Typeless 版本漂移探测测试
 *
 * 覆盖:
 *  1. computeVersionDrift() 纯比较逻辑(两个都在且不同才算漂移)
 *  2. writeVersionState() -> readVersionState() 往返一致 + 畸形文件容错
 *
 * 不触碰:getTypelessVersion() 需要真实的 Info.plist + PlistBuddy,不在此单测。
 *
 * 数据隔离:require lib/common.js 之前把 TYPELESS_DATA_DIR 指向临时目录,
 * VERSION_STATE_FILE 据此派生,读写只落在临时目录里,绝不碰用户真实数据。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-version-test-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const C = require('../lib/common.js');

before(() => {
  assert.strictEqual(C.ROOT, DATA_DIR, 'ROOT 未指向临时目录');
});

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- 1. computeVersionDrift 纯比较 ----

test('computeVersionDrift:版本不同才算漂移', () => {
  assert.strictEqual(C.computeVersionDrift('2.0.0', '1.5.0'), true);
});

test('computeVersionDrift:版本相同不算漂移', () => {
  assert.strictEqual(C.computeVersionDrift('2.0.0', '2.0.0'), false);
});

test('computeVersionDrift:缺任一侧都不算漂移(首次无基线 / 读不到版本)', () => {
  assert.strictEqual(C.computeVersionDrift('2.0.0', null), false);
  assert.strictEqual(C.computeVersionDrift(null, '2.0.0'), false);
  assert.strictEqual(C.computeVersionDrift(null, null), false);
  assert.strictEqual(C.computeVersionDrift('2.0.0', ''), false);
});

// ---- 2. writeVersionState / readVersionState 往返 ----

test('writeVersionState -> readVersionState 往返一致', () => {
  const written = C.writeVersionState('2.0.0.114');
  assert.strictEqual(written.version, '2.0.0.114');
  assert.ok(written.recorded_at, '缺 recorded_at 时间戳');
  const read = C.readVersionState();
  assert.strictEqual(read.version, '2.0.0.114');
  assert.strictEqual(read.recorded_at, written.recorded_at);
});

test('readVersionState:无文件返回 null', () => {
  fs.rmSync(C.VERSION_STATE_FILE, { force: true });
  assert.strictEqual(C.readVersionState(), null);
});

test('readVersionState:畸形文件返回 null 而非抛错', () => {
  fs.writeFileSync(C.VERSION_STATE_FILE, '{ not json');
  assert.strictEqual(C.readVersionState(), null);
  fs.writeFileSync(C.VERSION_STATE_FILE, JSON.stringify({ nope: 1 }));
  assert.strictEqual(C.readVersionState(), null);
});
