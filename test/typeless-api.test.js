'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTypelessApi } = require('../lib/typeless-api');

function token(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return `test.${Buffer.from(JSON.stringify({ subject: JSON.stringify({ user_id: userId }), exp })).toString('base64url')}.test`;
}

test('业务请求使用同账号访问令牌及逐请求签名,刷新请求不签名', async () => {
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
  assert.equal(calls[0][2], refresh);
  assert.equal(calls[0][4], undefined);
  assert.equal(signs.length, 2);
  for (const c of calls.slice(1)) {
    assert.equal(c[2], access);
    assert.match(c[4]['x-authorization'], /^signature-/);
  }
  assert.ok(signs.every(s => s[1] === 'a'));
  assert.equal(signs[0][0], 'https://api.typeless.com/user/dictionary/list?size=500');
  await api('POST', '/oauth/refresh_access_token', refresh, { app: 'typeless_webapp' });
  assert.equal(calls.filter(c => c[1] === '/oauth/refresh_access_token').length, 2, '显式登录校验不能复用已完成的刷新');
});

test('不同账号隔离凭证,失效缓存重新刷新,401 不自动重放写请求', async () => {
  const calls = [], signs = [];
  let time = Date.now();
  const api = createTypelessApi({
    apiBase: 'https://api.typeless.com', now: () => time,
    request: async (...args) => {
      calls.push(args);
      return args[1] === '/oauth/refresh_access_token'
        ? { access_token: token(args[2] === 'refresh-a' ? 'a' : 'b') }
        : { status: 'FAIL', code: 401 };
    },
    sign: async (_url, id) => { signs.push(id); return {}; },
  });
  await api('POST', '/user/dictionary/bulk-import', 'refresh-a', { content: 'hello' });
  await api('GET', '/user/dictionary/list', 'refresh-b');
  await api('GET', '/user/dictionary/list', 'refresh-a');
  assert.deepEqual(signs, ['a', 'b', 'a']);
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
      sign: async () => { throw Error('请连接 Typeless'); },
    });
    if (mode === 'expired') {
      assert.equal((await api('GET', '/user/dictionary/list', token('a'))).code, 402);
    } else {
      await assert.rejects(api('GET', '/user/dictionary/list', token('a')), /身份|连接/);
    }
    assert.equal(calls.length, 1);
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
