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
  probeCdpPort,
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

test('Typeless 登录页仍是可连接的管理窗口', () => {
  const asarPath = '/Applications/Typeless.app/Contents/Resources/app.asar';
  const target = {
    type: 'page', title: 'Typeless Login',
    url: pathToFileURL(asarPath).href + '/dist/renderer/login.html',
    webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/login`,
  };
  assert.strictEqual(selectTypelessCdpTarget([target], { asarPath }), target);
  assert.strictEqual(selectTypelessCdpTarget([{ ...target, url: 'https://typeless.com/login' }], { asarPath }), null);
});

test('管理端口已连接时不重启 Typeless', async () => {
  const result = await ensureApp({
    probePort: async () => ({ status: 'ready' }),
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
    probePort: async () => ({ status: ++probes >= 3 ? 'ready' : 'down' }),
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
      probePort: async () => { probes++; return { status: 'down' }; },
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

test('probeCdpPort:没人监听算 down,别的程序占用算 foreign', async () => {
  const refused = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.strictEqual((await probeCdpPort(CDP_PORT, refused)).status, 'down');

  // Chrome 占用时的真实表现:端口通,但 /json/version 返回 404
  const notFound = async () => ({ ok: false, status: 404 });
  assert.strictEqual((await probeCdpPort(CDP_PORT, notFound)).status, 'foreign');

  // 监听的是 CDP,但 User-Agent 不是 Typeless
  const otherElectron = async () => ({
    ok: true,
    json: async () => ({ 'User-Agent': 'Mozilla/5.0 SomeOtherApp/1.0 Chrome/130 Electron/33' }),
  });
  assert.strictEqual((await probeCdpPort(CDP_PORT, otherElectron)).status, 'foreign');

  // 回应的根本不是 JSON
  const notJson = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  assert.strictEqual((await probeCdpPort(CDP_PORT, notJson)).status, 'foreign');
});

test('管理端口被别的程序占用时必须报错,不能杀 Typeless 反复重启', async () => {
  let stops = 0;
  let starts = 0;
  await assert.rejects(
    ensureApp({
      probePort: async () => ({ status: 'foreign', detail: '该端口回应 HTTP 404' }),
      killTypeless: () => { stops++; },
      launchTypeless: () => { starts++; },
      sleep: async () => {},
    }),
    (error) => error.code === 'CDP_PORT_CONFLICT' && /被其它程序占用/.test(error.message),
  );
  assert.strictEqual(stops, 0, '端口冲突时不应关闭 Typeless');
  assert.strictEqual(starts, 0, '端口冲突时不应重启 Typeless');
});
