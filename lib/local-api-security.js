'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');

const SESSION_HEADER = 'x-typeless-session';
const HTML_SESSION_PLACEHOLDER = '__TYPELESS_MANAGER_SESSION_SECRET__';
const DEFAULT_JSON_LIMIT = 1024 * 1024;

class LocalApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'LocalApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createSessionSecret(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new TypeError('session secret 至少需要 16 个随机字节');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

function injectSessionSecret(html, secret, placeholder = HTML_SESSION_PLACEHOLDER) {
  if (typeof html !== 'string') throw new TypeError('HTML 必须是字符串');
  if (typeof secret !== 'string' || !secret) throw new TypeError('session secret 不能为空');
  if (typeof placeholder !== 'string' || !placeholder || !html.includes(placeholder)) {
    throw new Error('manager HTML 缺少 session secret placeholder');
  }

  // Placeholder is a JavaScript value, not a quoted string. Escape HTML-significant
  // characters too, because JSON.stringify alone would leave </script> executable.
  const literal = JSON.stringify(secret).replace(/[<>&\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return html.split(placeholder).join(literal);
}

function headerValue(req, name) {
  const value = req && req.headers && req.headers[name.toLowerCase()];
  // A joined value is deliberately invalid for all security-sensitive headers.
  return Array.isArray(value) ? value.join(',') : value;
}

function parseLocalEndpoint(raw, field, expectedPort) {
  if (typeof raw !== 'string' || !raw || /[\r\n]/.test(raw)) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 校验失败`);
  }

  let endpoint;
  try {
    endpoint = field === 'origin' ? new URL(raw) : new URL(`http://${raw}`);
  } catch (_) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 校验失败`);
  }

  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 校验失败`);
  }
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 校验失败`);
  }

  const hostname = endpoint.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 不是本机地址`);
  }

  const port = endpoint.port || '80';
  if (expectedPort !== undefined && port !== String(expectedPort)) {
    throw new LocalApiError(403, `INVALID_${field.toUpperCase()}`, `${field} 端口不匹配`);
  }

  return { hostname, port, host: endpoint.host.toLowerCase() };
}

function secretsEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validateLocalRequest(req, options = {}) {
  const expectedPort = options.port;
  const host = parseLocalEndpoint(headerValue(req, 'host'), 'host', expectedPort);
  const originValue = headerValue(req, 'origin');
  if (originValue) {
    const origin = parseLocalEndpoint(originValue, 'origin', expectedPort);
    if (origin.host !== host.host) {
      throw new LocalApiError(403, 'ORIGIN_MISMATCH', 'origin 与 host 不匹配');
    }
  }

  const fetchSite = headerValue(req, 'sec-fetch-site');
  const allowedFetchSites = options.allowNavigation
    ? new Set(['same-origin', 'none'])
    : new Set(['same-origin']);
  if (fetchSite && !allowedFetchSites.has(fetchSite.toLowerCase())) {
    throw new LocalApiError(403, 'CROSS_SITE_REQUEST', '拒绝跨站请求');
  }

  if (options.requireSession !== false) {
    const headerName = (options.headerName || SESSION_HEADER).toLowerCase();
    if (!secretsEqual(headerValue(req, headerName), options.sessionSecret)) {
      throw new LocalApiError(401, 'INVALID_SESSION', '本地管理器会话无效,请刷新页面');
    }
  }
  return true;
}

function applySecurityHeaders(res) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

  for (const name of [
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Credentials',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods',
  ]) {
    if (typeof res.removeHeader === 'function') res.removeHeader(name);
  }
}

function readJsonBody(req, options = {}) {
  const limitBytes = options.limitBytes === undefined ? DEFAULT_JSON_LIMIT : options.limitBytes;
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    return Promise.reject(new TypeError('JSON body limit 必须是正整数'));
  }

  const contentType = headerValue(req, 'content-type');
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    if (typeof req.resume === 'function') req.resume();
    return Promise.reject(new LocalApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须使用 application/json'));
  }

  const contentLength = headerValue(req, 'content-length');
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      if (typeof req.resume === 'function') req.resume();
      return Promise.reject(new LocalApiError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length 不合法'));
    }
    if (Number(contentLength) > limitBytes) {
      if (typeof req.resume === 'function') req.resume();
      return Promise.reject(new LocalApiError(413, 'BODY_TOO_LARGE', 'JSON 请求体过大'));
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      // IncomingMessage can emit an ECONNRESET error after `aborted`.
      req.once('error', () => {});
      if (drain && typeof req.resume === 'function') req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limitBytes) {
        fail(new LocalApiError(413, 'BODY_TOO_LARGE', 'JSON 请求体过大'), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!bytes) {
        reject(new LocalApiError(400, 'EMPTY_JSON_BODY', 'JSON 请求体不能为空'));
        return;
      }

      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch (_) {
        reject(new LocalApiError(400, 'INVALID_JSON_ENCODING', 'JSON 请求体必须是 UTF-8'));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new LocalApiError(400, 'INVALID_JSON', 'JSON 请求体格式不正确'));
      }
    };
    const onAborted = () => fail(new LocalApiError(400, 'REQUEST_ABORTED', '请求体传输已中断'));
    const onError = () => fail(new LocalApiError(400, 'REQUEST_STREAM_ERROR', '读取请求体失败'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

function createLocalApiSecurity(options = {}) {
  const sessionSecret = options.sessionSecret || createSessionSecret();
  const headerName = (options.headerName || SESSION_HEADER).toLowerCase();
  const port = options.port;
  const limitBytes = options.limitBytes === undefined ? DEFAULT_JSON_LIMIT : options.limitBytes;

  return Object.freeze({
    sessionSecret,
    headerName,
    injectHtml(html) {
      return injectSessionSecret(html, sessionSecret, options.placeholder);
    },
    assertPageRequest(req) {
      return validateLocalRequest(req, { port, requireSession: false, allowNavigation: true });
    },
    assertApiRequest(req) {
      return validateLocalRequest(req, { port, sessionSecret, headerName, requireSession: true });
    },
    applyHeaders: applySecurityHeaders,
    readJson(req) {
      return readJsonBody(req, { limitBytes });
    },
  });
}

module.exports = {
  DEFAULT_JSON_LIMIT,
  HTML_SESSION_PLACEHOLDER,
  LocalApiError,
  SESSION_HEADER,
  applySecurityHeaders,
  createLocalApiSecurity,
  createSessionSecret,
  injectSessionSecret,
  readJsonBody,
  validateLocalRequest,
};
