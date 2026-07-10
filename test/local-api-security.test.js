'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');

const {
  HTML_SESSION_PLACEHOLDER,
  LocalApiError,
  SESSION_HEADER,
  applySecurityHeaders,
  createLocalApiSecurity,
  createSessionSecret,
  injectSessionSecret,
  readJsonBody,
  validateLocalRequest,
} = require('../lib/local-api-security');

function request(headers = {}) {
  const req = new PassThrough();
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return req;
}

async function expectHttpError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LocalApiError);
    assert.strictEqual(error.statusCode, statusCode);
    assert.strictEqual(error.code, code);
    return true;
  });
}

test('启动期 secret 使用安全随机值,HTML placeholder 注入为安全 JS 字面量', () => {
  const first = createSessionSecret();
  const second = createSessionSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(first, second);

  const html = `<script>const secret=${HTML_SESSION_PLACEHOLDER};</script>`;
  assert.strictEqual(
    injectSessionSecret(html, 'x"</script>'),
    '<script>const secret="x\\"\\u003c/script\\u003e";</script>',
  );
  assert.throws(() => injectSessionSecret('<html></html>', first), /placeholder/);
});

test('页面请求只接受本机 Host;API 还要求同源元数据和自定义 header secret', () => {
  const secret = 'test-session-secret';
  const validHeaders = {
    host: '127.0.0.1:7788',
    origin: 'http://127.0.0.1:7788',
    'sec-fetch-site': 'same-origin',
    [SESSION_HEADER]: secret,
  };

  assert.strictEqual(validateLocalRequest(request(validHeaders), {
    port: 7788,
    sessionSecret: secret,
  }), true);
  assert.strictEqual(validateLocalRequest(request({
    host: 'localhost:7788',
    'sec-fetch-site': 'none',
  }), { port: 7788, requireSession: false, allowNavigation: true }), true);

  assert.throws(() => validateLocalRequest(request({ ...validHeaders, host: 'evil.example:7788' }), {
    port: 7788, sessionSecret: secret,
  }), (error) => error.statusCode === 403 && error.code === 'INVALID_HOST');
  assert.throws(() => validateLocalRequest(request({ ...validHeaders, origin: 'http://localhost:7788' }), {
    port: 7788, sessionSecret: secret,
  }), (error) => error.statusCode === 403 && error.code === 'ORIGIN_MISMATCH');
  assert.throws(() => validateLocalRequest(request({ ...validHeaders, origin: [
    'http://127.0.0.1:7788',
    'http://evil.example:7788',
  ] }), {
    port: 7788, sessionSecret: secret,
  }), (error) => error.statusCode === 403 && error.code === 'INVALID_ORIGIN');
  assert.throws(() => validateLocalRequest(request({ ...validHeaders, 'sec-fetch-site': 'cross-site' }), {
    port: 7788, sessionSecret: secret,
  }), (error) => error.statusCode === 403 && error.code === 'CROSS_SITE_REQUEST');
  assert.throws(() => validateLocalRequest(request({ ...validHeaders, [SESSION_HEADER]: 'wrong' }), {
    port: 7788, sessionSecret: secret,
  }), (error) => error.statusCode === 401 && error.code === 'INVALID_SESSION');
});

test('createLocalApiSecurity 绑定同一启动期 secret 到页面注入和 API 鉴权', () => {
  const security = createLocalApiSecurity({ port: 7788, sessionSecret: 'bound-secret' });
  assert.strictEqual(security.injectHtml(`const s=${HTML_SESSION_PLACEHOLDER};`), 'const s="bound-secret";');
  assert.strictEqual(security.assertApiRequest(request({
    host: '127.0.0.1:7788',
    [security.headerName]: 'bound-secret',
  })), true);
});

test('安全响应头禁止缓存/嵌入/跨源,并移除所有 CORS 响应头', () => {
  const headers = new Map([
    ['access-control-allow-origin', '*'],
    ['access-control-allow-credentials', 'true'],
  ]);
  const res = {
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
  };
  applySecurityHeaders(res);

  assert.strictEqual(headers.get('cache-control'), 'no-store');
  assert.strictEqual(headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!headers.has('access-control-allow-origin'));
  assert.ok(!headers.has('access-control-allow-credentials'));
});

test('strict JSON 接受 application/json 和 UTF-8 JSON', async () => {
  const req = request({
    'content-type': 'application/json; charset=utf-8',
    'content-length': '17',
  });
  const parsed = readJsonBody(req, { limitBytes: 100 });
  req.end('{"hello":"world"}');
  assert.deepStrictEqual(await parsed, { hello: 'world' });
});

test('strict JSON 对 media type、空 body、坏 JSON 分别返回 415/400', async () => {
  const wrongType = request({ 'content-type': 'text/plain' });
  await expectHttpError(readJsonBody(wrongType), 415, 'UNSUPPORTED_MEDIA_TYPE');

  const empty = request({ 'content-type': 'application/json' });
  const emptyResult = readJsonBody(empty);
  empty.end();
  await expectHttpError(emptyResult, 400, 'EMPTY_JSON_BODY');

  const malformed = request({ 'content-type': 'application/json' });
  const malformedResult = readJsonBody(malformed);
  malformed.end('{oops');
  await expectHttpError(malformedResult, 400, 'INVALID_JSON');
});

test('strict JSON 在声明长度或流入数据超限时返回 413', async () => {
  const declared = request({
    'content-type': 'application/json',
    'content-length': '101',
  });
  await expectHttpError(readJsonBody(declared, { limitBytes: 100 }), 413, 'BODY_TOO_LARGE');

  const streamed = request({ 'content-type': 'application/json' });
  const streamedResult = readJsonBody(streamed, { limitBytes: 5 });
  streamed.write('{"too":');
  await expectHttpError(streamedResult, 413, 'BODY_TOO_LARGE');
});

test('strict JSON 在客户端中断上传时返回 400 aborted', async () => {
  const req = request({ 'content-type': 'application/json' });
  const parsed = readJsonBody(req);
  req.write('{"half":');
  req.emit('aborted');
  await expectHttpError(parsed, 400, 'REQUEST_ABORTED');
});
