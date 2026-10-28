'use strict';

// 独立窗口登录:用临时浏览器资料打开官方登录页,登录不受默认浏览器里旧网页会话的影响。
//
// 为什么需要:默认浏览器里若还登着别的账号,用户往往会在网页上点「退出」来换号,而网页
// 退出会让该账号已保存的刷新凭证一起失效(402)。临时资料里没有任何旧登录,也就不需要退出。
//
// 链路与官方一致:自己生成 PKCE(verifier 为两段 UUID,challenge = base64url(sha256)),
// 打开 /login/app/auth;网页登录完成后会跳转 typeless://auth/google/success?code&state。
// 本模块经调试协议截下这次跳转并关闭窗口,用授权码换取凭证,再交给 Typeless 的 auth:login。
// 不记录链接、授权码或凭证;临时资料目录用完即删。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WEB_ORIGIN = 'https://www.typeless.com';
const PROFILE_PREFIX = 'typeless-toolkit-login-';
const BROWSER_APPS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];

const MESSAGES = {
  closed: '登录窗口已关闭，尚未完成登录。可点「重新打开官方登录页」再试。',
  timeout: '登录窗口等待超过 15 分钟，已自动关闭。可点「重新打开官方登录页」再试。',
  browser_failed: '独立登录窗口未能正常启动或连接。可点「重新打开官方登录页」重试；若反复失败，请导出日志反馈。',
  state_mismatch: '登录回调校验未通过，已丢弃本次结果。请点「重新打开官方登录页」重新登录。',
  exchange_failed: '网页登录已完成，但换取登录凭证失败。请点「重新打开官方登录页」重试；若反复失败，请导出日志反馈。',
  session_changed: '登录期间 Typeless 的当前会话发生了变化，未写入新的登录。请结束本次流程后重新开始。',
  inject_failed: 'Typeless 未接受新的登录。请点「重新打开官方登录页」重试；若反复失败，请导出日志反馈。',
};

function findBrowser(home = os.homedir(), exists = fs.existsSync) {
  for (const name of BROWSER_APPS) {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      const bin = path.join(root, `${name}.app`, 'Contents', 'MacOS', name);
      if (exists(bin)) return bin;
    }
  }
  return null;
}

function createPkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: crypto.randomUUID() };
}

function loginUrl({ challenge, state }) {
  const url = new URL('/login/app/auth', WEB_ORIGIN);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  url.searchParams.set('next', '/login');
  return url.href;
}

function launchBrowser(bin, profile, url) {
  const child = spawn(bin, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--new-window', url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

// 连接临时浏览器,等待任一页面导航到 typeless://。返回 { url } / { closed } / { timeout }。
async function watchCallback({ profile, timeoutMs, sleep, onReady = () => {} }) {
  let port, wsPath;
  for (let i = 0; i < 60 && !port; i++) {
    try {
      const [first, second] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (/^\d+$/.test(first) && second?.startsWith('/devtools/browser/')) { port = first; wsPath = second.trim(); }
    } catch (_) {}
    if (!port) await sleep(250);
  }
  if (!port) throw new Error('临时浏览器调试端口未就绪');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连接临时浏览器失败'));
  });
  let id = 0, finish;
  const pending = new Map(), attached = new Set();
  const result = new Promise(resolve => { finish = resolve; });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    try { ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { pending.delete(mid); reject(error); }
  });
  const check = url => { if (typeof url === 'string' && url.startsWith('typeless://')) finish({ url }); };
  const attach = async targetId => {
    if (attached.has(targetId)) return;
    attached.add(targetId);
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      await send('Network.enable', {}, sessionId);
    } catch (_) {}
  };
  ws.onmessage = event => {
    let m;
    try { m = JSON.parse(event.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const item = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) item.reject(new Error(String(m.error.message || 'CDP 错误')));
      else item.resolve(m.result || {});
      return;
    }
    const p = m.params || {};
    if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') {
      if (p.targetInfo?.type === 'page') { check(p.targetInfo.url); attach(p.targetInfo.targetId); }
    } else if (m.method === 'Page.frameRequestedNavigation' || m.method === 'Page.frameStartedNavigating') check(p.url);
    else if (m.method === 'Page.frameNavigated') check(p.frame?.url);
    else if (m.method === 'Network.requestWillBeSent') check(p.request?.url);
  };
  ws.onclose = () => finish({ closed: true });
  const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
  try {
    await send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos = [] } = await send('Target.getTargets');
    for (const target of targetInfos) if (target.type === 'page') attach(target.targetId);
    onReady();
    return await result;
  } finally {
    clearTimeout(timer);
    // 截获后立刻关窗,不让浏览器把回调交给 Typeless(那里没有对应的登录请求,只会报错)。
    try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch (_) {}
    ws.onclose = ws.onmessage = null;
    try { ws.close(); } catch (_) {}
  }
}

function createCleanLogin({ readSession, exchange, appLogin, record = () => {}, sleep,
  browser = () => findBrowser(), launch = launchBrowser, watch = watchCallback,
  tmpDir = os.tmpdir(), timeoutMs = 15 * 60 * 1000, now = Date.now }) {
  let attempt = null;

  function cleanupProfiles(keep) {
    let names = [];
    try { names = fs.readdirSync(tmpDir); } catch (_) {}
    for (const name of names) {
      const dir = path.join(tmpDir, name);
      if (name.startsWith(PROFILE_PREFIX) && dir !== keep) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  function stopBrowser(current) {
    if (current.child && !current.stopped) {
      current.stopped = true;
      const pid = current.child.pid;
      // 浏览器以独立进程组启动;关不掉进程组时退回只结束主进程。
      try { if (!Number.isInteger(pid) || pid <= 0) throw Error(); process.kill(-pid, 'SIGTERM'); }
      catch (_) { try { current.child.kill(); } catch (__) {} }
    }
  }
  function fail(current, step, fields = {}) {
    current.state = 'failed';
    current.issue = MESSAGES[step];
    record('clean_login', { step, flow_id: current.flowId, duration_ms: now() - current.started, ...fields });
  }

  async function finish(current, callback) {
    const url = new URL(callback);
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.get('state') !== current.pkce.state) { fail(current, 'state_mismatch'); return; }
    record('clean_login', { step: 'captured', flow_id: current.flowId, duration_ms: now() - current.started });
    let response;
    try { response = await exchange({ code, code_verifier: current.pkce.verifier, state: current.pkce.state }); }
    catch (_) { fail(current, 'exchange_failed'); return; }
    // 官方客户端读取响应正文顶层的 auth_user。
    const user = response?.auth_user;
    if (!user?.user_id || !user.refresh_token || !user.access_token) {
      fail(current, 'exchange_failed', { http_status: response?._http_status, api_code: response?.code });
      return;
    }
    record('clean_login', { step: 'exchanged', flow_id: current.flowId, account_id: user.user_id,
      credential: user.refresh_token, http_status: response._http_status });
    if (current !== attempt) return;
    let result;
    try { result = await appLogin(user, current.expected); } catch (_) { result = 'failed'; }
    if (result !== 'ok') { fail(current, result === 'session_changed' ? 'session_changed' : 'inject_failed', { account_id: user.user_id }); return; }
    current.state = 'done';
    record('clean_login', { step: 'injected', flow_id: current.flowId, account_id: user.user_id, credential: user.refresh_token });
  }

  async function run(current) {
    try {
      const outcome = await watch({ profile: current.profile, timeoutMs, sleep });
      stopBrowser(current);
      if (current !== attempt || current.state === 'cancelled') return;
      if (outcome.url) await finish(current, outcome.url);
      else fail(current, outcome.timeout ? 'timeout' : 'closed');
    } catch (_) {
      stopBrowser(current);
      if (current === attempt && current.state === 'waiting') fail(current, 'browser_failed');
    } finally {
      await sleep(500);
      fs.rmSync(current.profile, { recursive: true, force: true });
    }
  }

  // 返回 null 表示本机不可用(未开启或没有 Chromium 内核浏览器),由调用方退回官方入口。
  async function start(checkSaved, { flowId } = {}) {
    const bin = browser();
    if (!bin) return null;
    const session = await readSession();
    const expected = session ? { user_id: session.user_id, refresh_token: session.token } : null;
    await checkSaved(expected);
    close();
    cleanupProfiles();
    const profile = fs.mkdtempSync(path.join(tmpDir, PROFILE_PREFIX));
    const pkce = createPkce();
    const current = attempt = { flowId, profile, pkce, expected, state: 'waiting', issue: null, started: now() };
    try { current.child = launch(bin, profile, loginUrl(pkce)); }
    catch (error) {
      attempt = null;
      fs.rmSync(profile, { recursive: true, force: true });
      throw error;
    }
    record('clean_login', { step: 'started', flow_id: flowId });
    current.done = run(current);
    return { mode: 'clean' };
  }

  function close() {
    if (!attempt) return;
    if (attempt.state === 'waiting') attempt.state = 'cancelled';
    stopBrowser(attempt);
    attempt = null;
  }

  return {
    start, close,
    issue: () => attempt?.state === 'failed' ? attempt.issue : null,
    // 仅供测试等待后台流程结束。
    settled: () => attempt?.done || Promise.resolve(),
  };
}

module.exports = { createCleanLogin, findBrowser, createPkce, loginUrl, watchCallback, MESSAGES };
