'use strict';

// 业务接口边界:刷新凭证换取访问令牌,再由本机官方运行时生成请求校验头。
// 不读取签名密钥,不实现官方加密协议,不把访问令牌持久化。
const fs = require('fs');
const { pathToFileURL } = require('url');
const { readAsarHeader } = require('./paywall-patch');

const API_ORIGIN = 'https://api.typeless.com';
const REFRESH_PATH = '/oauth/refresh_access_token';

function identity(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const subject = typeof claims.subject === 'string' ? JSON.parse(claims.subject) : claims.subject;
    return { userId: subject?.user_id, expires: claims.exp * 1000 };
  } catch (_) { return {}; }
}

function createTypelessApi({ apiBase, request, sign, now = Date.now }) {
  const sessions = new Map();
  function refresh(token, force = false) {
    const cached = sessions.get(token);
    if (cached && (cached.running || (!force && cached.expires > now()))) return cached.pending;
    const entry = { expires: Infinity, running: true };
    entry.pending = Promise.resolve().then(async () => {
      const response = await request('POST', REFRESH_PATH, token, { app: 'typeless_webapp' });
      if (typeof response?.access_token !== 'string' || !response.access_token) {
        sessions.delete(token);
        return response;
      }
      const access = identity(response.access_token), saved = identity(token);
      if (typeof access.userId !== 'string' || !access.userId || (saved.userId && saved.userId !== access.userId)) {
        throw new Error('刷新后的账号身份不匹配,请重新读取并保存账号');
      }
      // 短期内合并列表的并发请求,在实际过期前刷新;缺少有效期时不复用。
      entry.expires = Number.isFinite(access.expires) ? Math.min(now() + 300000, access.expires - 30000) : 0;
      return response;
    }).catch(error => { sessions.delete(token); throw error; }).finally(() => { entry.running = false; });
    sessions.set(token, entry);
    // 丢弃已过期的其他账号缓存,不让已移除账号的凭证长期滞留。
    for (const [key, value] of sessions) if (key !== token && value.expires <= now()) sessions.delete(key);
    return entry.pending;
  }

  return async (method, p, token, body) => {
    // 配置的本地测试/代理端点保持原有传输,不向其它来源发送官方签名。
    if (new URL(apiBase).origin !== API_ORIGIN) return request(method, p, token, body);
    const url = new URL(p, apiBase);
    if (url.origin !== API_ORIGIN) throw new Error('Typeless API 请求来源不匹配');
    if (url.pathname === REFRESH_PATH) {
      // 保存和切号的显式登录校验仍访问服务端,仅合并正在进行的刷新。
      if (method === 'POST' && body?.app === 'typeless_webapp') return refresh(token, true);
      return request(method, p, token, body);
    }
    const refreshed = await refresh(token);
    if (!refreshed?.access_token) return refreshed;
    const access = refreshed.access_token;
    const headers = await sign(url.href, identity(access).userId);
    const response = await request(method, p, access, body, headers);
    // 不重放写请求;本次失败如实返回,下次操作重新刷新凭证。
    if (response?.code === 401 || response?.code === 402) sessions.delete(token);
    return response;
  };
}

// 只定位提供该能力的 renderer 模块,不依赖混淆变量名、字符串池索引或版本号。
function findSigningModule(buf) {
  const { header, dataStart } = readAsarHeader(buf);
  const files = header.files?.dist?.files?.renderer?.files?.static?.files?.js?.files || {};
  const matches = [];
  for (const [name, entry] of Object.entries(files)) {
    if (!/^[\w.-]+\.m?js$/.test(name) || entry.offset === undefined) continue;
    const start = dataStart + Number(entry.offset);
    if (!Number.isSafeInteger(start) || start < dataStart || !Number.isSafeInteger(entry.size)
        || entry.size < 0 || start + entry.size > buf.length) throw new Error('Typeless 模块文件边界无效');
    const source = buf.subarray(start, start + entry.size).toString('utf8');
    if (source.includes('getAPIEncryptHeaders') && source.includes('TypelessRequestSecurityMiddleware')) {
      matches.push(`dist/renderer/static/js/${name}`);
    }
  }
  if (matches.length !== 1) throw new Error('无法唯一定位 Typeless 请求校验模块,当前客户端版本可能不兼容');
  return matches[0];
}

// 在已校验的官方页面内执行。只取发送请求必需的头,不取 encryptData 或其它内部数据。
async function headersInRenderer(moduleUrl, url, userId) {
  const module = await import(moduleUrl);
  const signers = Object.values(module).filter(value => value && typeof value.getAPIEncryptHeaders === 'function');
  if (signers.length !== 1) throw new Error('Typeless 请求校验接口不可用');
  const result = await signers[0].getAPIEncryptHeaders(url, { extraData: { authInfo: { userId } } });
  const allowed = ['x-authorization', 'x-app-version', 'x-browser-name', 'x-browser-version', 'x-browser-major'];
  const headers = Object.fromEntries([...result.headers].filter(([name]) => allowed.includes(name.toLowerCase())));
  if (!headers['x-authorization'] || !headers['x-app-version']) throw new Error('Typeless 未能生成请求校验信息');
  return headers;
}

function createRuntimeSigner({ asarPath, withCDP, portUp }) {
  let cached;
  return async (url, userId) => {
    if (new URL(url).origin !== API_ORIGIN || new URL(url).pathname === REFRESH_PATH) {
      throw new Error('此请求不应调用 Typeless 客户端签名');
    }
    if (!await portUp()) throw new Error('读取词库和统计需要管理连接，请先点「连接 Typeless」');
    const stat = fs.statSync(asarPath);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cached?.stamp !== stamp) {
      cached = { stamp, moduleUrl: pathToFileURL(asarPath).href + '/' + findSigningModule(fs.readFileSync(asarPath)) };
    }
    const args = [cached.moduleUrl, url, userId].map(value => JSON.stringify(value)).join(',');
    return withCDP((_send, ev) => ev(`(${headersInRenderer.toString()})(${args})`));
  };
}

module.exports = { createTypelessApi, createRuntimeSigner, findSigningModule, headersInRenderer };
