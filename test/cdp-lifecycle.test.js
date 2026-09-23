'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib/cdp.js'), 'utf8');

function harness({ connect = 'open', response = 'success', expires, wsPackage = false, floatingBar = false } = {}) {
  const timers = new Map(), sockets = [];
  let nextTimer = 0;
  const schedule = (fn, ms) => {
    const id = ++nextTimer;
    timers.set(id, { fn, ms });
    if (ms === expires) queueMicrotask(() => {
      const timer = timers.get(id);
      if (timer) { timers.delete(id); timer.fn(); }
    });
    return id;
  };
  class Socket {
    constructor() {
      this.readyState = 0;
      this.shutdowns = 0;
      sockets.push(this);
      if (wsPackage) this.terminate = () => {
        this.shutdowns++;
        this.readyState = 3;
        // ws 在尚未建连时 terminate 会先异步报 error,再发 close。
        queueMicrotask(() => { this.onerror?.({}); this.onclose?.({}); });
      };
      queueMicrotask(() => {
        if (connect === 'open') { this.readyState = 1; this.onopen?.(); }
        if (connect === 'error') this.onerror?.({});
        if (connect === 'close') { this.readyState = 3; this.onclose?.({}); }
      });
    }
    close() { this.shutdowns++; this.readyState = 3; this.onclose?.({}); }
    send(raw) {
      const request = JSON.parse(raw);
      if (response === 'throw') throw new Error('send failed');
      queueMicrotask(() => {
        if (response === 'silent' || response === 'throw') return;
        if (response === 'close') { this.readyState = 3; this.onclose?.({}); return; }
        if (response === 'error') { this.onerror?.({}); return; }
        let data;
        if (response === 'success') data = JSON.stringify({ id: request.id, result: { result: { value: 42 } } });
        else if (response === 'protocol-error') data = JSON.stringify({ id: request.id, error: { code: -32000, message: 'session gone' } });
        else if (response === 'missing-result') data = JSON.stringify({ id: request.id });
        else data = response;
        this.onmessage?.({ data });
      });
    }
  }
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, require: name => name === 'ws' ? Socket : require(name),
    URL, AbortSignal, setTimeout: schedule, clearTimeout: id => timers.delete(id),
    fetch: async () => ({ ok: true, json: async () => [{
      title: floatingBar ? 'Status' : 'Typeless', type: 'page',
      url: 'file:///test/app.asar/dist/renderer/' + (floatingBar ? 'floating-bar.html' : 'hub.html'),
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/test',
    }] }),
  });
  const cdp = mod.exports.createCdp({ cdpPort: 9333, asarPath: '/test/app.asar', sleep: async () => {} });
  return {
    withCDP: cdp.withCDP,
    async assertReleased() {
      await Promise.resolve();
      assert.equal(timers.size, 0, '每轮结束后不得遗留连接或命令 timer');
      for (const socket of sockets) {
        assert.equal(socket.readyState, 3, '连接必须关闭');
        assert.ok(socket.shutdowns <= 1, '同一连接只清理一次');
        for (const name of ['onopen', 'onerror', 'onclose', 'onmessage']) {
          assert.equal(socket[name], null, `${name} 必须解除`);
        }
      }
    },
  };
}

test('CDP 成功返回及业务异常都关闭连接并清理监听和 timer', async () => {
  for (const wsPackage of [false, true]) {
    const h = harness({ wsPackage });
    assert.equal(await h.withCDP((_send, ev) => ev('1 + 1')), 42);
    await assert.rejects(h.withCDP(async () => { throw new Error('callback failed'); }), /callback failed/);
    await h.assertReleased();
  }
});

test('仅剩浮条时仍可执行 CDP 请求，结束后不遗留连接或定时器', async () => {
  const h = harness({ floatingBar: true });
  assert.equal(await h.withCDP((_send, ev) => ev('1 + 1')), 42);
  await h.assertReleased();
});

test('CDP 建连失败、提前关闭和建连超时也走统一清理', async () => {
  for (const wsPackage of [false, true]) {
    for (const [connect, expected] of [['error', /连接.*失败/], ['close', /连接已关闭/], ['silent', /连接.*超时/]]) {
      const h = harness({ connect, expires: 3000, wsPackage });
      await assert.rejects(h.withCDP(() => assert.fail('建连失败不得执行业务')), expected);
      await h.assertReleased();
    }
  }
});

test('CDP send 同步异常清除已经登记的请求和 timer', async () => {
  const h = harness({ response: 'throw' });
  await assert.rejects(h.withCDP(send => send('Runtime.evaluate', {})), /send failed/);
  await h.assertReleased();
});

test('CDP 命令超时、关闭和 error 会拒绝所有等待命令', async () => {
  for (const [response, expected] of [['silent', /命令超时/], ['close', /连接已关闭/], ['error', /连接.*失败/]]) {
    const h = harness({ response, expires: response === 'silent' ? 5000 : undefined });
    const results = await h.withCDP(send => Promise.allSettled([
      send('Runtime.evaluate', {}), send('Runtime.evaluate', {}),
    ]));
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, expected);
    }
    await h.assertReleased();
  }
});

test('CDP 非法 JSON 或响应结构不会逃逸成未捕获异常', async () => {
  for (const response of ['{', 'null', '[]']) {
    const h = harness({ response });
    await assert.rejects(h.withCDP(send => send('Runtime.evaluate', {})), /响应格式无效/);
    await h.assertReleased();
  }
});

test('CDP 协议错误和缺失执行结果返回明确失败并释放资源', async () => {
  for (const [response, expected] of [['protocol-error', /命令失败: session gone/], ['missing-result', /执行结果无效/]]) {
    const h = harness({ response });
    await assert.rejects(h.withCDP((_send, ev) => ev('1 + 1')), expected);
    await h.assertReleased();
  }
});

test('连续 300 轮成功和失败后连接、监听与 timer 均无累积', async () => {
  const ok = harness({ wsPackage: true });
  const failed = harness({ response: 'silent', expires: 5000, wsPackage: true });
  for (let i = 0; i < 300; i++) {
    assert.equal(await ok.withCDP((_send, ev) => ev('1 + 1')), 42);
    await assert.rejects(failed.withCDP(send => send('Runtime.evaluate', {})), /命令超时/);
    await ok.assertReleased();
    await failed.assertReleased();
  }
});
