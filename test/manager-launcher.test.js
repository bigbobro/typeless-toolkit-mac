'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const repo = path.join(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `
const fs = require('node:fs'), http = require('node:http');
const config = require('./fixture.json');
const version = require('./package.json').version;
if (config.failStartup) process.exit(2);
const event = kind => fs.appendFileSync(config.events, JSON.stringify({ kind, pid: process.pid, version, at: Date.now() })+'\\n');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'OK', data: { product: config.product, state: 'ready', version } }));
});
server.listen(config.port, '127.0.0.1', () => event('started'));
process.on('SIGTERM', () => {
  event('stopping');
  if (config.ignoreStop) return;
  server.close();
  setTimeout(() => { event('stopped'); process.exit(0); }, config.stopDelay || 0);
});
`;

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  assert.fail(message());
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-launcher-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const events = path.join(root, 'events.jsonl');
  const opened = path.join(root, 'opened.jsonl');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'open'), `#!/usr/bin/env node
const fs = require('node:fs');
fetch(process.argv[2]+'/api/health').then(r=>r.json()).then(r=>fs.appendFileSync(process.env.TT_OPEN_LOG,JSON.stringify(r.data)+'\\n')).catch(()=>process.exit(1));
`, { mode: 0o755 });
  const children = [];
  const alive = child => child.exitCode === null && child.signalCode === null;
  t.after(async () => {
    for (const child of [...children].reverse()) {
      if (!alive(child)) continue;
      child.kill('SIGTERM');
      const deadline = Date.now() + 3000;
      while (alive(child) && Date.now() < deadline) await pause(20);
      if (alive(child)) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function install(name, version, extra = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repo, '启动管理器.command'), path.join(dir, '启动管理器.command'));
    const launcher = path.join(repo, 'lib/manager-launcher.js');
    if (fs.existsSync(launcher)) fs.copyFileSync(launcher, path.join(dir, 'lib/manager-launcher.js'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typeless-toolkit-macos', version }));
    const configModule = `module.exports = { CODE_DIR: require('node:path').join(__dirname, '..'), config: { manager_port: ${port} } };`;
    fs.writeFileSync(path.join(dir, 'lib/paths.js'), configModule);
    fs.writeFileSync(path.join(dir, 'lib/common.js'), configModule);
    fs.writeFileSync(path.join(dir, 'manager.js'), fixture);
    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ port, events, product: 'typeless-toolkit-manager', ...extra }));
    return dir;
  }
  function run(dir, script = 'manager.js') {
    const command = script.endsWith('.command') ? '/bin/zsh' : process.execPath;
    const child = spawn(command, [script], { cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TT_OPEN_LOG: opened },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.logs = '';
    child.stdout.on('data', chunk => { child.logs += chunk; });
    child.stderr.on('data', chunk => { child.logs += chunk; });
    children.push(child);
    return child;
  }
  const readLines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function health() {
    try { return await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(300) })).json(); }
    catch (_) { return null; }
  }
  return { install, run, alive, health, events: () => readLines(events), opened: () => readLines(opened),
    ready: version => until(async () => (await health())?.data.version === version, () => 'fixture 未就绪'),
    openedVersion: (version, child) => until(() => readLines(opened).some(item => item.version === version), () => `未打开 ${version}：${child.logs}`),
  };
}

test('覆盖原目录后运行 Command 会停止旧后端，验证新版后再打开页面', async t => {
  const h = await setup(t);
  const dir = h.install('同一源码目录', '2.8.0');
  const old = h.run(dir);
  await h.ready('2.8.0');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typeless-toolkit-macos', version: '2.9.1' }));
  const launcher = h.run(dir, '启动管理器.command');
  await h.openedVersion('2.9.1', launcher);
  assert.equal(h.alive(old), false);
  assert.equal((await h.health()).data.version, '2.9.1');
  assert.equal(h.events().filter(item => item.kind === 'started').length, 2);
});

test('从带空格的新目录升级会等待旧进程完全退出，并随 Command 退出停止新进程', async t => {
  const h = await setup(t);
  const old = h.run(h.install('old release', '2.8.0', { stopDelay: 250 }));
  await h.ready('2.8.0');
  const launcher = h.run(h.install('新版本 release', '2.9.1'), '启动管理器.command');
  await h.openedVersion('2.9.1', launcher);
  assert.equal(h.alive(old), false);
  const events = h.events();
  assert.ok(events.find(item => item.version === '2.9.1' && item.kind === 'started').at >= events.find(item => item.version === '2.8.0' && item.kind === 'stopped').at);
  launcher.kill('SIGTERM');
  await until(async () => !h.alive(launcher) && await h.health() === null, () => launcher.logs);
});

test('同版本重复运行只打开已有页面，不停止已有服务或新增进程', async t => {
  const h = await setup(t);
  const dir = h.install('source', '2.9.1');
  const old = h.run(dir);
  await h.ready('2.9.1');
  const launcher = h.run(dir, '启动管理器.command');
  await h.openedVersion('2.9.1', launcher);
  await until(() => !h.alive(launcher), () => launcher.logs);
  assert.equal(launcher.exitCode, 0);
  assert.equal(h.alive(old), true);
  assert.deepEqual(h.events().map(item => item.kind), ['started']);
});

test('未运行管理器时 Command 正常启动并确认版本', async t => {
  const h = await setup(t);
  const launcher = h.run(h.install('source', '2.9.1'), '启动管理器.command');
  await h.openedVersion('2.9.1', launcher);
  assert.equal(h.events().filter(item => item.kind === 'started').length, 1);
});

for (const disguise of [false, true]) test(`端口被${disguise ? '伪装健康响应的其他 Node 程序' : '其他服务'}占用时，不停止它或打开页面`, async t => {
  const h = await setup(t);
  const dir = h.install('other', '2.8.0', disguise ? {} : { product: 'another-service' });
  fs.renameSync(path.join(dir, 'manager.js'), path.join(dir, 'foreign.js'));
  const other = h.run(dir, 'foreign.js');
  await h.ready('2.8.0');
  const launcher = h.run(h.install('new', '2.9.1'), '启动管理器.command');
  await until(() => !h.alive(launcher), () => launcher.logs);
  assert.notEqual(launcher.exitCode, 0);
  assert.equal(h.alive(other), true);
  assert.equal(h.opened().length, 0);
  assert.equal(h.events().filter(item => item.kind === 'started').length, 1);
});

test('新管理器启动失败时明确失败，不打开未就绪的页面', async t => {
  const h = await setup(t);
  const launcher = h.run(h.install('broken', '2.9.1', { failStartup: true }), '启动管理器.command');
  await until(() => !h.alive(launcher), () => launcher.logs);
  assert.notEqual(launcher.exitCode, 0);
  assert.match(launcher.logs, /管理器启动失败/);
  assert.equal(h.opened().length, 0);
  assert.equal(await h.health(), null);
});

test('旧管理器拒绝退出时超时报错，不强杀旧进程或启动新进程', async t => {
  const h = await setup(t);
  const old = h.run(h.install('stuck', '2.8.0', { ignoreStop: true }));
  await h.ready('2.8.0');
  const launcher = h.run(h.install('new', '2.9.1'), '启动管理器.command');
  await until(() => !h.alive(launcher), () => launcher.logs, 35000);
  assert.notEqual(launcher.exitCode, 0);
  assert.match(launcher.logs, /30 秒内未退出/);
  assert.equal(h.alive(old), true);
  assert.equal(h.opened().length, 0);
  assert.equal(h.events().filter(item => item.kind === 'started').length, 1);
});
