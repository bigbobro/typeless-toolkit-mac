'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTypelessApi } = require('../lib/typeless-api');

function token(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return `test.${Buffer.from(JSON.stringify({ subject: JSON.stringify({ user_id: userId }), exp })).toString('base64url')}.test`;
}

test('刷新请求与业务请求都带逐请求签名,同一签名不复用', async () => {
  const calls = [], signs = [];
  const refresh = token('a', 9999999999), access = token('a');
  const api = createTypelessApi({
    apiBase: 'https://api.typeless.com',
    request: async (...args) => {
      calls.push(args);
      return args[1] === '/oauth/refresh_access_token' ? { access_token: access } : { status: 'OK' };
    },
    sign: async (url, id) => { signs.push([url, id]); return { 'x-authorization': `signature-${signs.length}` }; },
  });
  await Promise.all([
    api('GET', '/user/dictionary/list?size=500', refresh),
    api('POST', '/user/usage_stats', refresh, {}),
    api('POST', '/oauth/refresh_access_token', refresh, { app: 'typeless_webapp' }),
  ]);
  assert.equal(calls.filter(c => c[1] === '/oauth/refresh_access_token').length, 1);
  // 刷新请求也必须携带校验头;服务端从 2026-10 起对不带签名的刷新返回 403/20006。
  const refreshCall = calls.find(c => c[1] === '/oauth/refresh_access_token');
  assert.equal(refreshCall[2], refresh);
  assert.match(refreshCall[4]['x-authorization'], /^signature-/);
  // 刷新一次 + 两个业务请求 = 三次签名,各自独立(重放会得到 418)。
  assert.equal(signs.length, 3);
  assert.equal(new Set(calls.map(c => c[4]['x-authorization'])).size, 3, '每个请求必须使用不同的签名');
  for (const c of calls.filter(x => x[1] !== '/oauth/refresh_access_token')) {
    assert.equal(c[2], access);
    assert.match(c[4]['x-authorization'], /^signature-/);
  }
  assert.ok(signs.every(s => s[1] === 'a'));
  assert.equal(signs[0][0], 'https://api.typeless.com/oauth/refresh_access_token');
  assert.ok(signs.some(s => s[0] === 'https://api.typeless.com/user/dictionary/list?size=500'));
  await api('POST', '/oauth/refresh_access_token', refresh, { app: 'typeless_webapp' });
  assert.equal(calls.filter(c => c[1] === '/oauth/refresh_access_token').length, 2, '显式登录校验不能复用已完成的刷新');
});

test('不同账号隔离凭证,失效缓存重新刷新,401 不自动重放写请求', async () => {
  const calls = [], signs = [];
  let time = Date.now();
  const refreshA = token('a', 9999999999), refreshB = token('b', 9999999999);
  const api = createTypelessApi({
    apiBase: 'https://api.typeless.com', now: () => time,
    request: async (...args) => {
      calls.push(args);
      return args[1] === '/oauth/refresh_access_token'
        ? { access_token: token(args[2] === refreshA ? 'a' : 'b') }
        : { status: 'FAIL', code: 401 };
    },
    sign: async (url, id) => { signs.push(id); return { 'x-authorization': 'sig-' + signs.length }; },
  });
  await api('POST', '/user/dictionary/bulk-import', refreshA, { content: 'hello' });
  await api('GET', '/user/dictionary/list', refreshB);
  await api('GET', '/user/dictionary/list', refreshA);
  // 401 会丢弃该账号的访问令牌缓存,所以第三次调用重新刷新:
  // 每次刷新签一次 + 每个业务请求签一次,共 6 次,且互不复用。
  assert.deepEqual(signs, ['a', 'a', 'b', 'b', 'a', 'a']);
  assert.equal(calls.filter(c => c[1].endsWith('bulk-import')).length, 1);
  assert.equal(calls.filter(c => c[1] === '/oauth/refresh_access_token').length, 3);
});

test('过期访问令牌不会从缓存继续使用', async () => {
  let time = Date.now(), refreshes = 0;
  const api = createTypelessApi({
    apiBase: 'https://api.typeless.com', now: () => time,
    request: async (_m, p) => p === '/oauth/refresh_access_token'
      ? (refreshes++, { access_token: token('a', Math.floor(time / 1000) + 60) }) : { status: 'OK' },
    sign: async () => ({}),
  });
  await api('GET', '/user/dictionary/list', 'refresh');
  await api('GET', '/user/dictionary/list', 'refresh');
  assert.equal(refreshes, 1);
  time += 40000;
  await api('GET', '/user/dictionary/list', 'refresh');
  assert.equal(refreshes, 2);
});

test('刷新失败、身份不符、签名不可用时不发送业务请求', async () => {
  for (const mode of ['expired', 'wrong-user', 'no-signer']) {
    const calls = [];
    const api = createTypelessApi({
      apiBase: 'https://api.typeless.com',
      request: async (...args) => {
        calls.push(args);
        return mode === 'expired' ? { code: 402, detail: 'Invalid refresh token' }
          : { access_token: token(mode === 'wrong-user' ? 'other' : 'a') };
      },
      // 签名不可用时连刷新请求都不该发出(客户端没连上,发了也只会得到 403/20006)。
      sign: async () => { if (mode === 'no-signer') throw Object.assign(Error('请连接 Typeless'), { code: 'CONNECTION_REQUIRED' }); return { 'x-authorization': 'sig' }; },
    });
    if (mode === 'expired') {
      assert.equal((await api('GET', '/user/dictionary/list', token('a'))).code, 402);
      assert.equal(calls.length, 1);
    } else if (mode === 'wrong-user') {
      await assert.rejects(api('GET', '/user/dictionary/list', token('a')), /身份/);
      assert.equal(calls.length, 1);
    } else {
      await assert.rejects(api('GET', '/user/dictionary/list', token('a')), /连接/);
      assert.equal(calls.length, 0, '签名不可用时不应发出刷新请求');
    }
  }
});

test('自定义 API 地址保持原传输,不会向它附加官方客户端签名', async () => {
  const calls = [];
  const api = createTypelessApi({
    apiBase: 'http://127.0.0.1:1234',
    request: async (...args) => { calls.push(args); return { status: 'OK' }; },
    sign: async () => { throw Error('不应调用'); },
  });
  await api('GET', '/user/dictionary/list', 'test-token');
  assert.deepEqual(calls, [['GET', '/user/dictionary/list', 'test-token', undefined]]);
});
