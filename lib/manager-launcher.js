'use strict';

// Command 的进程生命周期入口：复用同版本，替换不同版本，并等自己的子进程退出。
// 旧版没有停止 API，通过端口、进程身份和源码目录确认后发送 SIGTERM。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const PRODUCT = 'typeless-toolkit-manager';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child = null, childResult = null, childExited = null, cancelled = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cancelled = true;
    if (child && !childResult) child.kill('SIGTERM');
  });
}

function checkCancelled() {
  if (cancelled) throw new Error('管理器启动已取消。');
}

function listeners(port) {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return [];
    throw new Error('无法检查管理器端口，未停止任何进程。');
  }
}

function managerIdentity(pid) {
  try {
    const owner = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,comm='], { encoding: 'utf8' }).trim().match(/^(\d+)\s+(.+)$/);
    if (!owner || Number(owner[1]) !== process.getuid() || path.basename(owner[2]) !== 'node') throw new Error();
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd || ![ 'manager.js', path.join(cwd, 'manager.js') ].some(script => command.endsWith(' ' + script))) throw new Error();
    if (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name !== 'typeless-toolkit-macos') throw new Error();
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    return JSON.stringify({ pid, command, cwd, started });
  } catch (_) {
    throw new Error('端口进程无法确认为当前用户的 Typeless 管理器，未停止它。请先检查端口占用。');
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function health(url) {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    return response.ok && body.status === 'OK' && body.data?.product === PRODUCT ? body.data : null;
  } catch (_) { return null; }
}

function openPage(url) {
  if (spawnSync('open', [url], { stdio: 'ignore' }).status !== 0) console.error('无法自动打开浏览器，请访问：' + url);
}

async function main() {
  const { config, CODE_DIR } = require('./paths');
  const version = JSON.parse(fs.readFileSync(path.join(CODE_DIR, 'package.json'), 'utf8')).version;
  const port = config.manager_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('manager_port 必须是有效端口。');
  const url = `http://127.0.0.1:${port}`;
  const existing = await health(url);
  checkCancelled();
  if (existing?.version === version) {
    console.log(`管理器 v${version} 已在运行：${url}`);
    openPage(url);
    return;
  }
  const pids = listeners(port);
  if (pids.length) {
    if (!existing || pids.length !== 1) throw new Error(`端口 ${port} 已被其他或无法识别的服务占用，未停止任何进程。`);
    const pid = pids[0], identity = managerIdentity(pid);
    const confirmed = await health(url);
    checkCancelled();
    if (!confirmed || confirmed.version !== existing.version || listeners(port).join() !== String(pid) || managerIdentity(pid) !== identity) {
      throw new Error('管理器进程在检查期间发生变化，请重新运行 Command。');
    }
    console.log(`检测到管理器 v${existing.version || '未知'}，正在停止旧进程并启动 v${version}…`);
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 30000;
    while (isAlive(pid)) {
      checkCancelled();
      if (Date.now() >= deadline) throw new Error('旧管理器 30 秒内未退出，未强制终止或启动新进程。请检查旧管理器终端后重试。');
      await pause(100);
    }
  }
  checkCancelled();
  if (listeners(port).length) throw new Error(`端口 ${port} 尚未释放，请稍后重新运行 Command。`);
  child = spawn(process.execPath, [path.join(CODE_DIR, 'manager.js')], { cwd: CODE_DIR, stdio: 'inherit' });
  childExited = new Promise(resolve => {
    child.once('error', error => { childResult = { error }; resolve(childResult); });
    child.once('exit', (code, signal) => { childResult = { code, signal }; resolve(childResult); });
  });
  const deadline = Date.now() + 10000;
  while (true) {
    checkCancelled();
    if (childResult) throw new Error('管理器启动失败，请查看上面的错误。');
    const ready = await health(url);
    if (ready?.version === version && listeners(port).join() === String(child.pid)) break;
    if (Date.now() >= deadline) throw new Error('管理器启动后未能确认版本，请查看上面的错误。');
    await pause(100);
  }
  checkCancelled();
  console.log(`管理器 v${version} 运行中：${url}`);
  console.log('关闭此窗口或按 Ctrl+C 可退出管理器。');
  openPage(url);
  const result = await childExited;
  if (!cancelled && (result.error || result.code !== 0)) throw new Error('管理器已异常退出，请查看上面的错误。');
}

main().catch(async error => {
  console.error(error.message);
  if (child && !childResult) { child.kill('SIGTERM'); await childExited; }
  process.exitCode = cancelled ? 130 : 1;
});
