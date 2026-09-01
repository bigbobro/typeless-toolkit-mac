'use strict';

/**
 * readCurrentLogin —— 「Typeless 现在登录的是谁」的磁盘读取
 *
 * 这条路径替代了原来的 captureTokenCDP(false):后者为了拿 Authorization 头必须
 * Page.reload 主窗口再等 6 秒,而注册向导每 4 秒轮询一次,会把用户正在填的注册页
 * 反复刷掉。改成读 app-storage.json 后不再碰 Typeless。
 *
 * 本文件锁住的核心是**登出判定**:漏判会让向导永远停在第一步。按 resetDevice 的
 * 既定语义,user-data.json 不存在 或 app-storage.json 里没有 userData.user_id
 * 都算登出。
 *
 * 隔离:require lib/common.js 之前把 TYPELESS_DATA_DIR 与 TYPELESS_USER_DATA_DIR
 * 指向临时目录,绝不触碰真实 Typeless 数据。
 */
const { test, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cur-data-'));
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cur-user-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;
process.env.TYPELESS_USER_DATA_DIR = USER_DIR;

const C = require('../lib/common.js');

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(USER_DIR, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of ['app-storage.json', 'user-data.json']) {
    fs.rmSync(path.join(USER_DIR, f), { force: true });
  }
});

// Typeless 真实写出的 userData 形状(截取相关字段;与 /user/get_user_info 同构)
function seed(userData) {
  fs.writeFileSync(path.join(USER_DIR, 'user-data.json'), 'encrypted-blob-not-json');
  fs.writeFileSync(path.join(USER_DIR, 'app-storage.json'), JSON.stringify(
    userData === undefined ? { currentRoute: null } : { currentRoute: null, userData },
  ));
}

test('登录中:从 app-storage.json 读出 user_id / email / role', () => {
  seed({
    user_id: '855ec90e-4a11-4499-8aaf-d9019771b72e',
    email: 'someone@example.com',
    name: null,
    roles: [{ name: 'free' }],
  });
  const cur = C.readCurrentLogin();
  assert.strictEqual(cur.user_id, '855ec90e-4a11-4499-8aaf-d9019771b72e');
  assert.strictEqual(cur.email, 'someone@example.com');
  assert.strictEqual(cur.role, 'free');
  // name 为 null 时 nickname 回落到 email(accountMetaFromUserInfo 的既有约定)
  assert.strictEqual(cur.nickname, 'someone@example.com');
  assert.ok(cur.captured_at, 'captured_at 应为 app-storage.json 的 mtime');
});

test('subscription_plan_name 优先于 roles(与 accountMetaFromUserInfo 一致)', () => {
  seed({ user_id: 'u1', email: 'a@b.c', subscription_plan_name: 'pro', roles: [{ name: 'free' }] });
  assert.strictEqual(C.readCurrentLogin().role, 'pro');
});

test('登出判定一:user-data.json 不存在即视为已登出', () => {
  seed({ user_id: 'u1', email: 'a@b.c' });
  fs.rmSync(path.join(USER_DIR, 'user-data.json'));   // 只删凭证,app-storage 仍有 userData
  assert.strictEqual(C.readCurrentLogin(), null,
    'resetDevice 会删这个文件;漏判会让注册向导永远停在第一步');
});

test('登出判定二:app-storage.json 里没有 userData 即视为已登出', () => {
  seed(undefined);                                    // 凭证还在,但 userData 被清掉
  assert.strictEqual(C.readCurrentLogin(), null,
    'resetDevice 会 delete a.userData;这是第二个登出信号');
});

test('userData 存在但没有 user_id 不算登录', () => {
  seed({ email: 'a@b.c' });
  assert.strictEqual(C.readCurrentLogin(), null);
});

test('app-storage.json 损坏时返回 null 而不是抛错', () => {
  fs.writeFileSync(path.join(USER_DIR, 'user-data.json'), 'blob');
  fs.writeFileSync(path.join(USER_DIR, 'app-storage.json'), '{ 半个文件');
  assert.strictEqual(C.readCurrentLogin(), null,
    'Typeless 正在写这个文件时可能读到半截,不能让轮询整个报错');
});

test('两个文件都不存在时返回 null', () => {
  assert.strictEqual(C.readCurrentLogin(), null);
});

test('userData 是数组/标量等非对象时返回 null', () => {
  seed([{ user_id: 'u1' }]);
  assert.strictEqual(C.readCurrentLogin(), null);
});
