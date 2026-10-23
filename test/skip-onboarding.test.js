'use strict';
/**
 * 跳过引导 —— 只改 app-onboarding.json 的三个字段
 *
 * 渲染进程的判断是 `isCompleted ?? false`(见 Typeless 2.8.x 的
 * dist/renderer/static/js/BiP8Ve7n.js:initialize),为真直接进主界面。
 * 这里锁住三件事:
 *   1. 只写 isCompleted / onboardingStep / onboardingMaxReachedStep,其余字段原样保留;
 *   2. 文件缺失或损坏时也能救,而不是直接失败;
 *   3. 读状态不抛错,供 UI 在确认框里显示「当前停在哪一步」。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-onboarding-'));
process.env.TYPELESS_DATA_DIR = root;
process.env.TYPELESS_USER_DATA_DIR = path.join(root, 'live');
const paths = require('../lib/paths');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { readOnboardingState, skipOnboarding } = require('../lib/common');

function seed(data) {
  fs.mkdirSync(paths.USERDATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.USERDATA_DIR, 'app-onboarding.json'),
    typeof data === 'string' ? data : JSON.stringify(data));
}
function live() {
  return JSON.parse(fs.readFileSync(path.join(paths.USERDATA_DIR, 'app-onboarding.json'), 'utf8'));
}

test('文件缺失时读状态不抛错,写回一份最小已完成状态', () => {
  fs.rmSync(paths.USERDATA_DIR, { recursive: true, force: true });
  const before = readOnboardingState();
  assert.equal(before.exists, false);
  assert.equal(before.completed, false);
  const result = skipOnboarding();
  assert.equal(result.changed, true);
  const data = live();
  assert.equal(data.isCompleted, true);
  assert.equal(data.onboardingStep, 'end_page');
  assert.equal(data.onboardingMaxReachedStep, 'end_page');
});

test('只改三个引导字段,其余状态原样保留', () => {
  const seeded = {
    step: 0, setUpStep: 0, tryItStep: 0,
    isCompleted: false,
    onboardingAutoLanguageDetection: false,
    onboardingCompletedFloatingBarStart: true,
    __ONBOARDING_UPGRADE_NOTICE: false,
    __internal__: { migrations: { version: '2.8.3' } },
    onboardingHasShownSelectedTextAlert: '2026-06-14T05:25:30.400Z',
    onboardingStep: 'permissions',
    onboardingMaxReachedStep: 'permissions',
  };
  seed(seeded);
  const result = skipOnboarding();
  assert.equal(result.changed, true);
  assert.deepEqual(result.before, { completed: false, step: 'permissions' });
  assert.deepEqual(result.after, { completed: true, step: 'end_page' });

  const data = live();
  assert.equal(data.isCompleted, true);
  assert.equal(data.onboardingStep, 'end_page');
  assert.equal(data.onboardingMaxReachedStep, 'end_page');
  // 迁移标记与一次性提示都跟服务端/历史绑定,重造会触发额外流程
  assert.deepEqual(data.__internal__, seeded.__internal__);
  assert.equal(data.__ONBOARDING_UPGRADE_NOTICE, false);
  assert.equal(data.onboardingHasShownSelectedTextAlert, seeded.onboardingHasShownSelectedTextAlert);
  assert.equal(data.onboardingCompletedFloatingBarStart, true);
});

test('已跳过时如实报告未变更,不重复写盘', () => {
  seed({ isCompleted: true, onboardingStep: 'end_page', onboardingMaxReachedStep: 'end_page', extra: 1 });
  const file = path.join(paths.USERDATA_DIR, 'app-onboarding.json');
  const mtime = fs.statSync(file).mtimeMs;
  const result = skipOnboarding();
  assert.equal(result.changed, false);
  assert.equal(fs.statSync(file).mtimeMs, mtime, '无变化时不该触碰文件');
});

test('文件损坏时不放弃,按已完成状态重写', () => {
  seed('{ not json');
  assert.deepEqual(readOnboardingState().corrupt, true);
  const result = skipOnboarding();
  assert.equal(result.changed, true);
  assert.equal(live().isCompleted, true);
});

test('isCompleted 只认布尔真值', () => {
  for (const [value, expected] of [[true, true], [false, false], ['true', false], [1, false], [null, false]]) {
    seed({ isCompleted: value, onboardingStep: 'permissions' });
    assert.equal(readOnboardingState().completed, expected, `isCompleted=${JSON.stringify(value)}`);
  }
});

// ---------- 全局开关:save / restore 两条路径都要生效 ----------
const C = require('../lib/common');
const config = require('../lib/paths').config;

test('开关写入 config.local.json,关闭时不留 false 残留', () => {
  fs.rmSync(path.join(paths.ROOT, 'config.local.json'), { force: true });
  assert.equal(C.onboardingPolicy().enabled, false);
  assert.deepEqual(C.setOnboardingPolicy(true), { enabled: true });
  const saved = JSON.parse(fs.readFileSync(path.join(paths.ROOT, 'config.local.json'), 'utf8'));
  assert.equal(saved.skip_onboarding, true);
  assert.equal(config.skip_onboarding, true, '写完后内存里的配置要立刻生效,不用重启管理器');
  assert.deepEqual(C.setOnboardingPolicy(false), { enabled: false });
  const cleared = JSON.parse(fs.readFileSync(path.join(paths.ROOT, 'config.local.json'), 'utf8'));
  assert.ok(!Object.hasOwn(cleared, 'skip_onboarding'), '关闭不该留下 skip_onboarding:false');
  assert.equal(config.skip_onboarding, false);
});

test('开关开启时保存账号快照会自动带上已完成引导', () => {
  C.setOnboardingPolicy(true);
  const live = path.join(paths.USERDATA_DIR);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'app-storage.json'), JSON.stringify({ userData: { user_id: 'skip-save' } }));
  fs.writeFileSync(path.join(live, 'user-data.json'), 'synthetic');
  fs.writeFileSync(path.join(live, 'app-onboarding.json'), JSON.stringify({ isCompleted: false, onboardingStep: 'permissions', keep: 'me' }));

  C.saveAccountWithSnapshot([{ user_id: 'skip-save', token: 't' }], 'skip-save');
  const saved = JSON.parse(fs.readFileSync(path.join(C.PROFILES_DIR, 'skip-save', 'app-onboarding.json'), 'utf8'));
  assert.equal(saved.isCompleted, true, '新加的账号要在保存那一刻就跳过引导');
  assert.equal(saved.onboardingStep, 'end_page');
  assert.equal(saved.keep, 'me', '未涉及的字段原样保留');

  C.setOnboardingPolicy(false);
});

test('开关开启时切号还原会就地纠正旧快照里的未完成引导', () => {
  C.setOnboardingPolicy(true);
  const dir = path.join(C.PROFILES_DIR, 'old-shape');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-storage.json'), JSON.stringify({ userData: { user_id: 'old-shape' } }));
  fs.writeFileSync(path.join(dir, 'user-data.json'), 'synthetic');
  // 老快照:引导未完成
  fs.writeFileSync(path.join(dir, 'app-onboarding.json'), JSON.stringify({ isCompleted: false, onboardingStep: 'permissions' }));

  C.restoreSnapshot('old-shape');
  const afterRestore = JSON.parse(fs.readFileSync(path.join(C.USERDATA_DIR, 'app-onboarding.json'), 'utf8'));
  assert.equal(afterRestore.isCompleted, true, '开关开着的时候切号不该把引导带回来');
  assert.equal(afterRestore.onboardingStep, 'end_page');

  C.setOnboardingPolicy(false);
});

test('开关关闭时保持原样:不改写快照里的引导状态', () => {
  C.setOnboardingPolicy(false);
  const dir = path.join(C.PROFILES_DIR, 'no-skip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-storage.json'), JSON.stringify({ userData: { user_id: 'no-skip' } }));
  fs.writeFileSync(path.join(dir, 'user-data.json'), 'synthetic');
  fs.writeFileSync(path.join(dir, 'app-onboarding.json'), JSON.stringify({ isCompleted: false, onboardingStep: 'permissions' }));

  C.restoreSnapshot('no-skip');
  const restored = JSON.parse(fs.readFileSync(path.join(C.USERDATA_DIR, 'app-onboarding.json'), 'utf8'));
  assert.equal(restored.isCompleted, false, '开关关着就不该偷偷改用户数据');
});
