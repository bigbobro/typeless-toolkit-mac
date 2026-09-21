'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findSigningModule, headersInRenderer, createRuntimeSigner } = require('../lib/typeless-api');

function archive(names) {
  const source = Buffer.from('getAPIEncryptHeaders TypelessRequestSecurityMiddleware');
  const files = Object.fromEntries(names.map((name, i) => [name, { offset: String(i * source.length), size: source.length }]));
  const json = Buffer.from(JSON.stringify({ files: { dist: { files: { renderer: { files: { static: { files: { js: { files } } } } } } } } }));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc((4 - (16 + json.length) % 4) % 4), ...names.map(() => source)]);
}

test('从安装包能力定位模块,不绑定打包文件名;缺失或歧义时中止', () => {
  assert.equal(findSigningModule(archive(['new-hash.js'])), 'dist/renderer/static/js/new-hash.js');
  assert.throws(() => findSigningModule(archive([])), /无法唯一定位/);
  assert.throws(() => findSigningModule(archive(['one.js', 'two.js'])), /无法唯一定位/);
  assert.throws(() => findSigningModule(archive(['one.js']).subarray(0, -1)), /边界/);
});

test('调用官方导出对象时只传 URL 和账号身份,只返回白名单头', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-signing-module-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'client.mjs');
  fs.writeFileSync(file, `export const arbitraryExportName = {
    async getAPIEncryptHeaders(url, options) {
      if (url !== 'https://api.typeless.com/user/test' || options.extraData.authInfo.userId !== 'account-b') throw Error('参数不符');
      return { headers: new Headers({ 'X-Authorization': 'test-signature', 'X-App-Version': 'test-version', 'Authorization': 'must-not-return' }), encryptData: { internal: 'must-not-return' } };
    }
  };`);
  const headers = await headersInRenderer(pathToFileURL(file).href, 'https://api.typeless.com/user/test', 'account-b');
  assert.deepEqual(headers, { 'x-authorization': 'test-signature', 'x-app-version': 'test-version' });
  const broken = path.join(dir, 'broken.mjs');
  fs.writeFileSync(broken, 'export const signer={getAPIEncryptHeaders:async()=>({headers:new Headers()})};');
  await assert.rejects(headersInRenderer(pathToFileURL(broken).href, 'https://api.typeless.com/user/test', 'a'), /未能生成/);
});

test('运行时签名不自动重启应用;非官方来源及刷新路径不得调用签名器', async () => {
  const sign = createRuntimeSigner({ asarPath: '/not-used', portUp: async () => false, withCDP: () => assert.fail('不应调用') });
  await assert.rejects(sign('https://api.typeless.com/user/test', 'a'), /连接 Typeless/);
  await assert.rejects(sign('https://other.example/user/test', 'a'), /不应调用/);
  await assert.rejects(sign('https://api.typeless.com/oauth/refresh_access_token', 'a'), /不应调用/);
});

test('安装包变化后重新定位模块,签名每次调用官方运行时', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-signing-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asarPath = path.join(dir, 'app.asar'), expressions = [];
  fs.writeFileSync(asarPath, archive(['old.js']));
  const sign = createRuntimeSigner({ asarPath, portUp: async () => true,
    withCDP: fn => fn(null, async expression => { expressions.push(expression); return {}; }),
  });
  await sign('https://api.typeless.com/user/test', 'a');
  fs.writeFileSync(asarPath, archive(['new-build-name.js']));
  await sign('https://api.typeless.com/user/test', 'b');
  assert.match(expressions[0], /old\.js/);
  assert.match(expressions[1], /new-build-name\.js/);
  assert.equal(expressions.length, 2);
});
