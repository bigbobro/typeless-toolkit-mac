'use strict';

/**
 * CDP 管理连接 —— 通过 Typeless 的 IPC 读取主进程登录信息
 *
 * 从 lib/common.js 抽出。这一块自成闭环:端口探测(down / foreign / no-target /
 * ready 四态)→ 必要时重启 → 连 WebSocket → 读取主进程保存的刷新凭证。
 *
 * 连接约束:
 *
 * 1. **端口三分支是必需的,不是防御性编程。** Electron 绑不上已被占用的端口时是
 *    **静默失败** —— 进程带着 --remote-debugging-port 正常跑,却不监听任何端口。
 *    不区分 foreign(端口被别的程序占着)就会变成「反复杀用户的 Typeless 且永远
 *    不可能成功」。probeCdpPort 先读 /json/version 看 UA 里有没有 Typeless/。
 *
 * 2. **目标选择有两道刻意的加固**,不只是按标题匹配:target 的 url 必须以本机
 *    app.asar 的 file:// 为前缀(挡住同名远端页面被注入脚本收割 Authorization),
 *    WebSocket 地址必须是 loopback 且同端口(挡住 /json 返回外部主机)。
 *    ASAR_PATH 解析失败时选择器恒返回 null,会空转到超时后抛一条与真实原因无关的
 *    报错 —— 排查时先确认 asarPath 拿到了值。
 *
 * WebSocket 依赖:优先 require('ws'),没有就用全局 —— 为打包版 Electron 主进程
 * 无全局 WS 的情况兜底。
 *
 * 工厂函数注入依赖,模块本身不持有全局状态(与 runtime-backup / paywall-patch 一致)。
 */
const os = require('os');
const { pathToFileURL } = require('url');

/**
 * @param {object} deps
 * @param {number}   deps.cdpPort      config.cdp_port
 * @param {string}   deps.asarPath     Typeless.app/Contents/Resources/app.asar(目标校验用)
 * @param {string}   deps.apiBase      Typeless API 根地址
 * @param {function} deps.killTypeless
 * @param {function} deps.launchTypeless
 * @param {function} deps.sleep
 * @param {function} deps.log
 * @param {function} deps.curlApi
 * @param {function} deps.accountMetaFromUserInfo
 */
function createCdp({
  cdpPort, asarPath, apiBase,
  killTypeless, launchTypeless, sleep, log,
  curlApi, accountMetaFromUserInfo,
}) {
  const CDP_PORT = cdpPort;
  const ASAR_PATH = asarPath;
  const API_BASE = apiBase;

  const WebSocket = (() => {
    try { const W = require('ws'); if (typeof W === 'function') return W; } catch (e) {}
    return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : undefined;
  })();


  // ---------- CDP ----------
  function selectTypelessCdpTarget(targets, options = {}) {
    const port = options.port || CDP_PORT;
    const asarPath = options.asarPath || ASAR_PATH;
    if (!Array.isArray(targets) || !asarPath) return null;
    const expectedUrlPrefix = pathToFileURL(asarPath).href + '/';
    return targets.find(target => {
      if (!target || target.type !== 'page' || !['Typeless', 'Typeless Login'].includes(target.title)
        || typeof target.url !== 'string' || !target.url.startsWith(expectedUrlPrefix)
        || typeof target.webSocketDebuggerUrl !== 'string') return false;
      try {
        const ws = new URL(target.webSocketDebuggerUrl);
        return ws.protocol === 'ws:'
          && (ws.hostname === '127.0.0.1' || ws.hostname === '::1' || ws.hostname === 'localhost')
          && Number(ws.port) === Number(port);
      } catch (_) { return false; }
    }) || null;
  }
  async function fetchTypelessCdpTarget(port = CDP_PORT, fetchFn = fetch) {
    const response = await fetchFn(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    return selectTypelessCdpTarget(await response.json(), { port });
  }
  // 探测管理端口现状。区分「没人监听」和「被别的程序占着」很重要:
  // 后者杀多少次 Typeless 都没用(Electron 绑不上已占用的端口,而且是静默失败)。
  //   down     - 没有进程监听,重启 Typeless 有意义
  //   foreign  - 有进程在监听,但不是 Typeless 的调试端口
  //   no-target- 是 Typeless 的调试端口,但还没有可用的主窗口
  //   ready    - 是 Typeless,且主窗口可连
  async function probeCdpPort(port = CDP_PORT, fetchFn = fetch) {
    let response;
    try {
      response = await fetchFn(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch (e) {
      return { status: 'down' };
    }
    if (!response.ok) return { status: 'foreign', detail: `该端口回应 HTTP ${response.status}` };
    let version;
    try { version = await response.json(); }
    catch (e) { return { status: 'foreign', detail: '该端口回应的不是 CDP 协议' }; }
    if (!/Typeless\//.test(String(version?.['User-Agent'] || ''))) {
      return { status: 'foreign', detail: '该端口属于另一个程序的调试端口' };
    }
    return await fetchTypelessCdpTarget(port, fetchFn)
      ? { status: 'ready' }
      : { status: 'no-target' };
  }
  async function portUp(port = CDP_PORT, fetchFn = fetch) {
    try { return (await probeCdpPort(port, fetchFn)).status === 'ready'; }
    catch (e) { return false; }
  }
  async function typelessConnectionStatus(options = {}) {
    const checkPort = options.portUp || portUp;
    const cdpReachable = Boolean(await checkPort());
    return {
      state: cdpReachable ? 'connected' : 'disconnected',
      port: CDP_PORT,
      cdp_reachable: cdpReachable,
    };
  }
  async function ensureApp(options = {}) {
    const probe = options.probePort || probeCdpPort;
    const stopApp = options.killTypeless || killTypeless;
    const startApp = options.launchTypeless || launchTypeless;
    const wait = options.sleep || sleep;
    const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 40;
    const restartDelayMs = Number.isFinite(options.restartDelayMs) ? options.restartDelayMs : 1200;
    const pollDelayMs = Number.isFinite(options.pollDelayMs) ? options.pollDelayMs : 500;

    const first = await probe();
    if (first.status === 'ready') {
      return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: false };
    }
    if (first.status === 'foreign') {
      const error = new Error(
        `管理端口 ${CDP_PORT} 已被其它程序占用(${first.detail}),Typeless 无法绑定它。` +
        `请退出占用该端口的程序,或在 config.local.json 里把 cdp_port 改成别的端口。`
      );
      error.code = 'CDP_PORT_CONFLICT';
      throw error;
    }
    log('Typeless 未带调试端口,正在以调试端口重启…');
    await stopApp();
    await wait(restartDelayMs);
    startApp();
    for (let i = 0; i < attempts; i++) {
      if ((await probe()).status === 'ready') {
        return { state: 'connected', port: CDP_PORT, cdp_reachable: true, restarted: true };
      }
      if (i < attempts - 1) await wait(pollDelayMs);
    }
    const error = new Error(`Typeless 启动后仍无法连接管理端口 ${CDP_PORT}`);
    error.code = 'CDP_START_TIMEOUT';
    throw error;
  }
  async function withCDP(fn) {
    let target;
    for (let i = 0; i < 40; i++) {
      try { target = await fetchTypelessCdpTarget(CDP_PORT); } catch (e) {}
      if (target) break;
      await sleep(500);
    }
    if (!target) throw new Error('找不到 Typeless 管理窗口,请确认 Typeless 已用 --remote-debugging-port=' + CDP_PORT + ' 启动');
    if (typeof WebSocket !== 'function') throw new Error('当前 Node.js 缺少 WebSocket 支持,请使用 Node.js 22+');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        reject(new Error('连接 Typeless WebSocket 超时'));
      }, 3000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('连接 Typeless WebSocket 失败')); };
    });
    let id = 0; const pending = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const item = pending.get(m.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(m.id);
        item.resolve(m);
      }
    };
    const send = (method, params) => new Promise((resolve, reject) => {
      id++;
      const requestId = id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Typeless CDP 命令超时: ${method}`));
      }, 5000);
      pending.set(requestId, { resolve, timer });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('JS 错误: ' + (r.result.exceptionDetails.exception?.description?.slice(0, 300)));
      return r.result.result.value;
    };
    try { return await fn(send, ev); }
    finally {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      ws.close();
    }
  }

  async function verifyCurrentLogin(uid) {
    // 读取主进程的真实鉴权结果;还原到磁盘的 userData 不能证明应用已经登录。
    const login = await withCDP((_send, ev) => ev(`(async () => {
      const token = await window.ipcRenderer.invoke('auth:get-access-token');
      const user = await window.ipcRenderer.invoke('auth:get-current');
      return { user_id: user?.user_id, has_access_token: Boolean(token) };
    })()`));
    if (!login?.has_access_token || login.user_id !== uid) {
      throw new Error('Typeless 未能登录目标账号。请重新登录该账号,再添加当前账号以更新凭证和快照。');
    }
  }

  // 直接读取主进程保存的刷新凭证,不重载页面或截取短期请求令牌。
  async function captureTokenCDP(autoRestart = true) {
    // 检查端口是否就绪
    let ready = false;
    try { ready = await portUp(); } catch (e) {}
    if (!ready) {
      // autoRestart=false(如打开管理器时的自动检测)不杀 Typeless,避免一打开就打断用户正在用的 Typeless
      if (!autoRestart) throw new Error('Typeless 未以调试端口运行');
      await ensureApp();
    }
    return withCDP(async (_send, ev) => {
      const current = await ev(`(async () => {
        if (!await window.ipcRenderer.invoke('auth:get-access-token')) return null;
        const user = await window.ipcRenderer.invoke('auth:get-current');
        return user && { user_id: user.user_id, refresh_token: user.refresh_token };
      })()`);
      if (!current?.user_id || !current.refresh_token) throw new Error('未读取到有效登录凭证,请先在 Typeless 登录账号');
      const token = current.refresh_token;
      const origin = API_BASE;
      // 附带 user_info(若失败不阻断)
      let user_info = null;
      try {
        const ui = await curlApi('GET', '/user/get_user_info', token);
        user_info = ui.data || null;
      } catch (e) {}
      const user_id = current.user_id;
      return { token, origin, user_id, user_info, ...accountMetaFromUserInfo(user_info, user_id), captured_at: new Date().toISOString() };
    });
  }

  return {
    selectTypelessCdpTarget,
    fetchTypelessCdpTarget,
    probeCdpPort,
    portUp,
    typelessConnectionStatus,
    ensureApp,
    withCDP,
    verifyCurrentLogin,
    captureTokenCDP,
  };
}

module.exports = { createCdp };
