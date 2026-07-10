'use strict';

/**
 * JWT payload 解码 / token 剩余有效期测试
 *
 * 覆盖:decodeJwtPayload() 对合法/非法 token 的容错,
 * tokenExpiryInfo() 从 payload.exp 算出的过期时间与剩余天数。
 *
 * common.js 启动时会初始化稳定数据目录,因此这里也显式隔离 TYPELESS_DATA_DIR。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-token-test-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const C = require('../lib/common.js');

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function fakeJwt(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

test('decodeJwtPayload 正确解出 payload', () => {
  const token = fakeJwt({ subject: { user_id: 'u1' }, exp: 1234567890 });
  const payload = C.decodeJwtPayload(token);
  assert.strictEqual(payload.subject.user_id, 'u1');
  assert.strictEqual(payload.exp, 1234567890);
});

test('decodeJwtPayload 对畸形 token 安全返回 null', () => {
  assert.strictEqual(C.decodeJwtPayload('not-a-jwt'), null);
  assert.strictEqual(C.decodeJwtPayload(''), null);
  assert.strictEqual(C.decodeJwtPayload(null), null);
});

test('tokenExpiryInfo 无 exp 字段时返回 null/null', () => {
  const token = fakeJwt({ subject: { user_id: 'u1' } });
  assert.deepStrictEqual(C.tokenExpiryInfo(token), { token_expires_at: null, token_days_left: null });
});

test('tokenExpiryInfo 未来 30 天的 exp 算出 days_left 接近 30', () => {
  const futureSec = Math.floor(Date.now() / 1000) + 30 * 86400;
  const token = fakeJwt({ exp: futureSec });
  const info = C.tokenExpiryInfo(token);
  assert.strictEqual(info.token_expires_at, new Date(futureSec * 1000).toISOString());
  // 用 ceil 计算,允许 29~30 的边界误差
  assert.ok(info.token_days_left >= 29 && info.token_days_left <= 30, `days_left=${info.token_days_left}`);
});

test('tokenExpiryInfo 已过期的 exp 算出负数天数', () => {
  const pastSec = Math.floor(Date.now() / 1000) - 5 * 86400;
  const token = fakeJwt({ exp: pastSec });
  const info = C.tokenExpiryInfo(token);
  assert.ok(info.token_days_left < 0, `days_left=${info.token_days_left}`);
});
