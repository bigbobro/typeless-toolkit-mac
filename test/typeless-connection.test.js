'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-connection-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const {
  CDP_PORT,
  ensureApp,
  selectTypelessCdpTarget,
  typelessConnectionStatus,
} = require('../lib/common');

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('CDP 只接受当前 Typeless app.asar 的主窗口,不回退到任意 page', () => {
  const asarPath = '/Applications/Typeless.app/Contents/Resources/app.asar';
  const typelessUrl = pathToFileURL(asarPath).href + '/dist/renderer/hub.html';
  const targets = [
    {
      type: 'page', title: 'Typeless', url: 'https://typeless.com/',
      webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/chrome-tab`,
    },
    {
      type: 'page', title: 'Status', url: typelessUrl,
      webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/floating-bar`,
    },
    {
      type: 'page', title: 'Typeless', url: typelessUrl,
      webSocketDebuggerUrl: 'ws://evil.example/devtools/page/remote',
    },
    {
      type: 'page', title: 'Typeless', url: typelessUrl,
      webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/typeless`,
    },
  ];

  assert.strictEqual(
    selectTypelessCdpTarget(targets, { port: CDP_PORT, asarPath }),
    targets[3],
  );
  assert.strictEqual(
    selectTypelessCdpTarget(targets.slice(0, 3), { port: CDP_PORT, asarPath }),
    null,
  );
});

test('连接状态只区分管理端口是否可达', async () => {
  assert.deepStrictEqual(await typelessConnectionStatus({ portUp: async () => false }), {
    state: 'disconnected',
    port: CDP_PORT,
    cdp_reachable: false,
  });
  assert.deepStrictEqual(await typelessConnectionStatus({ portUp: async () => true }), {
    state: 'connected',
    port: CDP_PORT,
    cdp_reachable: true,
  });
});

test('管理端口已连接时不重启 Typeless', async () => {
  const result = await ensureApp({
    portUp: async () => true,
    killTypeless: () => assert.fail('不应关闭 Typeless'),
    launchTypeless: () => assert.fail('不应启动 Typeless'),
  });
  assert.deepStrictEqual(result, {
    state: 'connected',
    port: CDP_PORT,
    cdp_reachable: true,
    restarted: false,
  });
});

test('管理端口未连接时重启并等待端口就绪', async () => {
  let probes = 0;
  let stops = 0;
  let starts = 0;
  const result = await ensureApp({
    portUp: async () => ++probes >= 3,
    killTypeless: () => { stops++; },
    launchTypeless: () => { starts++; },
    sleep: async () => {},
    attempts: 3,
    restartDelayMs: 0,
    pollDelayMs: 0,
  });
  assert.strictEqual(stops, 1);
  assert.strictEqual(starts, 1);
  assert.strictEqual(probes, 3);
  assert.strictEqual(result.restarted, true);
  assert.strictEqual(result.cdp_reachable, true);
});

test('管理端口等待超时必须失败，不能误报已就绪', async () => {
  let probes = 0;
  let stops = 0;
  let starts = 0;
  await assert.rejects(
    ensureApp({
      portUp: async () => { probes++; return false; },
      killTypeless: () => { stops++; },
      launchTypeless: () => { starts++; },
      sleep: async () => {},
      attempts: 2,
      restartDelayMs: 0,
      pollDelayMs: 0,
    }),
    (error) => error.code === 'CDP_START_TIMEOUT' && /管理端口/.test(error.message),
  );
  assert.strictEqual(probes, 3);
  assert.strictEqual(stops, 1);
  assert.strictEqual(starts, 1);
});
