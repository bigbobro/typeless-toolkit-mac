'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ opened = true } = {}) {
  let current = { user_id: 'a', refresh_token: 'synthetic-refresh-a' };
  const calls = [];
  class Socket {
    constructor() { queueMicrotask(() => this.onopen()); }
    close() {}
    async send(raw) {
      const request = JSON.parse(raw);
      let result;
      try {
        const value = await vm.runInNewContext(request.params.expression, {
          window: { ipcRenderer: { invoke: async (channel, provider) => {
            calls.push([channel, provider]);
            if (channel === 'auth:get-current') return current;
            if (channel === 'auth:start-app-login') return opened;
            throw Error('不得注销当前账号或调用其他 IPC: ' + channel);
          } } },
        });
        result = { result: { value } };
      } catch (error) {
        result = { exceptionDetails: { exception: { description: error.message } } };
      }
      this.onmessage({ data: JSON.stringify({ id: request.id, result }) });
    }
  }
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/cdp.js'), 'utf8'), {
    module: mod, require: name => name === 'ws' ? Socket : require(name),
    URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => [{
      title: 'Typeless', type: 'page', url: 'file:///test/app.asar/dist/renderer/hub.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/test',
    }] }),
  });
  return {
    cdp: mod.exports.createCdp({ cdpPort: 9333, asarPath: '/test/app.asar', sleep: async () => {} }),
    calls,
    setCurrent(value) { current = value; },
  };
}

test('先确认当前会话已保存，再通过官方入口打开浏览器，不调用退出登录', async () => {
  const f = fixture();
  let checked = false;
  await f.cdp.startAppLogin(current => {
    assert.equal(current.user_id, 'a');
    assert.equal(current.refresh_token, 'synthetic-refresh-a');
    assert.equal(f.calls.length, 1, '保存检查必须先于浏览器登录');
    checked = true;
  });
  assert.equal(checked, true);
  assert.deepEqual(f.calls, [
    ['auth:get-current', undefined], ['auth:get-current', undefined], ['auth:start-app-login', 'login'],
  ]);
});

test('当前登录未保存或检查期间会话变化时，不打开浏览器', async () => {
  const f = fixture();
  await assert.rejects(f.cdp.startAppLogin(() => { throw Error('未保存'); }), /未保存/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.cdp.startAppLogin(() => {
    f.setCurrent({ user_id: 'a', refresh_token: 'different-session' });
  }), /当前登录.*变化/);
  assert.equal(f.calls.filter(([name]) => name === 'auth:start-app-login').length, 0);
});

test('未登录也能使用官方入口，客户端不支持时明确失败', async () => {
  const f = fixture();
  f.setCurrent(null);
  await f.cdp.startAppLogin(current => assert.equal(current, null));
  const unsupported = fixture({ opened: false });
  await assert.rejects(unsupported.cdp.startAppLogin(() => {}), /浏览器登录/);
});
