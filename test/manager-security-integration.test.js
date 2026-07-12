'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(origin, child, logs) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`manager 提前退出: ${logs.join('')}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`manager 启动超时: ${logs.join('')}`);
}

function rawHttp(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.end(request));
  });
}

test('真实 manager 只接受页面注入的本机会话,无 CORS,坏 JSON 不改主词库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-manager-security-'));
  const port = await freePort();
  const cdpPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const master = path.join(dataDir, 'Typeless词库主清单.csv');
  fs.writeFileSync(path.join(dataDir, 'config.local.json'), JSON.stringify({ manager_port: port, cdp_port: cdpPort }));
  fs.writeFileSync(master, 'keep\n');

  const logs = [];
  const child = spawn(process.execPath, ['manager.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TYPELESS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const health = await waitForHealth(origin, child, logs);
  assert.strictEqual(health.headers.get('access-control-allow-origin'), null);
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.deepStrictEqual(await health.json(), {
    status: 'OK',
    data: { product: 'typeless-toolkit-manager', state: 'ready', version: '2.4.1' },
  });

  const malformedTarget = await rawHttp(port,
    `GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(malformedTarget, /^HTTP\/1\.1 400 /);
  assert.strictEqual(child.exitCode, null, '畸形 request-target 不应终止管理器');
  assert.strictEqual((await fetch(`${origin}/api/health`)).status, 200);

  const denied = await fetch(`${origin}/api/backup-status`);
  assert.strictEqual(denied.status, 401);
  assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);

  const page = await fetch(`${origin}/`);
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(!html.includes('__TYPELESS_MANAGER_SESSION_SECRET__'));
  const match = html.match(/const SESSION_SECRET = ("[A-Za-z0-9_-]+");/);
  assert.ok(match, '页面应包含本次启动的 session secret');
  const secret = JSON.parse(match[1]);
  assert.match(html, /id="launchBtn"[^>]*>⏻ 连接 Typeless<\/button>/);
  assert.match(html, /const current=await detectCurrent\(true\)/);
  assert.ok(!html.includes("el.style.opacity='.55'"), '连接恢复后不应残留内联透明度');

  const current = await fetch(`${origin}/api/current`, {
    headers: { 'x-typeless-session': secret },
  });
  assert.strictEqual(current.status, 200);
  assert.deepStrictEqual(await current.json(), {
    status: 'FAIL',
    code: 'MANAGEMENT_CONNECTION_REQUIRED',
    msg: 'Typeless 管理连接未开启',
    data: { state: 'disconnected', port: cdpPort, cdp_reachable: false },
  });

  const allowed = await fetch(`${origin}/api/backup-status`, {
    headers: { 'x-typeless-session': secret },
  });
  assert.strictEqual(allowed.status, 200);

  const crossSite = await fetch(`${origin}/api/backup-status`, {
    headers: {
      'x-typeless-session': secret,
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
    },
  });
  assert.strictEqual(crossSite.status, 403);

  const badJson = await fetch(`${origin}/api/master`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-typeless-session': secret,
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: '{bad json',
  });
  assert.strictEqual(badJson.status, 400);
  assert.strictEqual(fs.readFileSync(master, 'utf8'), 'keep\n');

  for (const invalidBody of [null, []]) {
    const invalidObject = await fetch(`${origin}/api/master`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-typeless-session': secret,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify(invalidBody),
    });
    assert.strictEqual(invalidObject.status, 400);
    assert.deepStrictEqual(await invalidObject.json(), {
      status: 'FAIL',
      code: 'INVALID_INPUT',
      msg: 'JSON 顶层必须是对象',
    });
    assert.strictEqual(fs.readFileSync(master, 'utf8'), 'keep\n');
  }
});
