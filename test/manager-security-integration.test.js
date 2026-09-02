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
  // 版本号断言跟着 package.json 走,发版时不必再改测试
  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ).version;
  assert.deepStrictEqual(await health.json(), {
    status: 'OK',
    data: { product: 'typeless-toolkit-manager', state: 'ready', version: expectedVersion },
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
  assert.match(html, /<link rel="stylesheet" href="\/manager\.css">/);
  assert.match(html, /<script src="\/manager-ui\.js"><\/script>/);

  // 页面的样式与脚本是独立静态文件:同一套安全头、精确的 Content-Type(nosniff 之下类型错了浏览器直接拒载)、
  // 不含会话密钥(密钥只注入 HTML)。脚本文件里的两条断言是历史回归守卫,随脚本一起搬过来。
  const css = await fetch(`${origin}/manager.css`);
  assert.strictEqual(css.status, 200);
  assert.strictEqual(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(css.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(css.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await css.text(), /:root\s*\{/);

  const js = await fetch(`${origin}/manager-ui.js`);
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(js.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const script = await js.text();
  assert.ok(!script.includes(secret), '脚本文件不应含会话密钥');
  assert.ok(!script.includes('__TYPELESS_MANAGER_SESSION_SECRET__'));
  assert.match(script, /const current=await detectCurrent\(true\)/);
  assert.ok(!script.includes("el.style.opacity='.55'"), '连接恢复后不应残留内联透明度');

  const crossSiteAsset = await fetch(`${origin}/manager-ui.js`, {
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.strictEqual(crossSiteAsset.status, 403);
  assert.strictEqual((await fetch(`${origin}/manager.html.bak`)).status, 404);
  assert.strictEqual((await fetch(`${origin}/lib/common.js`)).status, 404);

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
