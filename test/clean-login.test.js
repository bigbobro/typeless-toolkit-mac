'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCleanLogin, findBrowser, MESSAGES } = require('../lib/clean-login');

const AUTH_USER = { user_id: 'target', email: 'target@example.invalid', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' };

function fixture({ callback = state => `typeless://auth/google/success?code=one-time&state=${state}`, outcome,
  response = { status: 'OK', auth_user: AUTH_USER, _http_status: 200 }, login = 'ok', browser = '/fake/Chrome' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-login-test-'));
  const calls = { launch: [], exchange: [], appLogin: [], records: [], killed: 0 };
  let release;
  const cleanLogin = createCleanLogin({
    tmpDir, sleep: async () => {}, now: () => 0,
    browser: () => browser,
    readSession: async () => ({ user_id: 'current', token: 'current-refresh' }),
    launch: (bin, profile, url) => { calls.launch.push({ bin, profile, url: new URL(url) }); return { kill: () => { calls.killed++; } }; },
    watch: async ({ profile }) => {
      assert.ok(fs.existsSync(profile), '临时资料目录在等待期间存在');
      if (outcome === 'hold') return new Promise(resolve => { release = resolve; });
      if (outcome) return outcome;
      return { url: callback(calls.launch[0].url.searchParams.get('state')) };
    },
    exchange: async body => { calls.exchange.push(body); return response; },
    appLogin: async (user, expected) => { calls.appLogin.push({ user, expected }); return login; },
    record: (event, fields) => calls.records.push({ event, ...fields }),
  });
  return { cleanLogin, calls, tmpDir, release: value => release(value) };
}

test('独立窗口登录:自生成 PKCE 打开官方页,截获回调后换码并交给 Typeless', async () => {
  const f = fixture();
  let checked = null;
  assert.deepEqual(await f.cleanLogin.start(current => { checked = current; }, { flowId: 'f1' }), { mode: 'clean' });
  assert.deepEqual(checked, { user_id: 'current', refresh_token: 'current-refresh' }, '先按当前会话做保存检查');
  await f.cleanLogin.settled();
  const url = f.calls.launch[0].url;
  assert.equal(url.origin + url.pathname, 'https://www.typeless.com/login/app/auth');
  assert.equal(url.searchParams.get('next'), '/login');
  const [body] = f.calls.exchange;
  assert.equal(body.code, 'one-time');
  assert.equal(body.state, url.searchParams.get('state'));
  assert.equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.deepEqual(f.calls.appLogin, [{ user: AUTH_USER, expected: { user_id: 'current', refresh_token: 'current-refresh' } }]);
  assert.equal(f.cleanLogin.issue(), null);
  assert.deepEqual(f.calls.records.map(r => r.step), ['started', 'captured', 'exchanged', 'injected']);
  assert.ok(!JSON.stringify(f.calls.records).includes('one-time'), '日志不含授权码');
  assert.ok(!fs.existsSync(f.calls.launch[0].profile), '用完删除临时资料');
});

test('保存检查未通过或本机没有可用浏览器时不打开窗口', async () => {
  const f = fixture();
  await assert.rejects(f.cleanLogin.start(() => { throw Error('未保存'); }), /未保存/);
  assert.equal(f.calls.launch.length, 0);
  const none = fixture({ browser: null });
  assert.equal(await none.cleanLogin.start(() => {}), null);
  assert.equal(none.calls.launch.length, 0);
});

test('state 不符、换码失败或响应形状不对时不写入 Typeless,并给出可重试说明', async () => {
  const cases = [
    [fixture({ callback: () => 'typeless://auth/google/success?code=x&state=forged' }), MESSAGES.state_mismatch, 0],
    [fixture({ response: { status: 'FAIL', code: -2, _http_status: 400 } }), MESSAGES.exchange_failed, 1],
    [fixture({ response: { status: 'OK', data: { auth_user: AUTH_USER }, _http_status: 200 } }), MESSAGES.exchange_failed, 1],
  ];
  for (const [f, message, exchanges] of cases) {
    await f.cleanLogin.start(() => {});
    await f.cleanLogin.settled();
    assert.equal(f.cleanLogin.issue(), message);
    assert.equal(f.calls.exchange.length, exchanges);
    assert.equal(f.calls.appLogin.length, 0);
  }
});

test('Typeless 会话在登录期间变化、窗口被关闭或超时都如实说明', async () => {
  for (const [options, message] of [
    [{ login: 'session_changed' }, MESSAGES.session_changed],
    [{ login: 'failed' }, MESSAGES.inject_failed],
    [{ outcome: { closed: true } }, MESSAGES.closed],
    [{ outcome: { timeout: true } }, MESSAGES.timeout],
  ]) {
    const f = fixture(options);
    await f.cleanLogin.start(() => {});
    await f.cleanLogin.settled();
    assert.equal(f.cleanLogin.issue(), message);
  }
});

test('结束流程会关闭窗口,之后的回调不再换码或写入', async () => {
  const f = fixture({ outcome: 'hold' });
  await f.cleanLogin.start(() => {});
  const done = f.cleanLogin.settled();
  f.cleanLogin.close();
  assert.equal(f.calls.killed, 1);
  f.release({ url: 'typeless://auth/google/success?code=late&state=any' });
  await done;
  assert.equal(f.calls.exchange.length, 0);
  assert.equal(f.cleanLogin.issue(), null);
});

test('按顺序查找本机 Chromium 内核浏览器', () => {
  const found = new Set(['/home/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  assert.equal(findBrowser('/home/u', p => found.has(p)), [...found][0]);
  assert.equal(findBrowser('/home/u', () => false), null);
});
