'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-curl-request-'));
process.env.TYPELESS_DATA_DIR = path.join(root, 'data');
process.env.TYPELESS_USER_DATA_DIR = path.join(root, 'live');
const paths = require('../lib/paths');
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture(t, { disconnect = false, denied = false, missingCurl = false } = {}) {
  const temp = fs.mkdtempSync(path.join(root, 'requests-'));
  const filesWritten = [];
  const server = http.createServer(async (req, res) => {
    if (disconnect) { req.socket.destroy(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (denied) {
      res.writeHead(401);
      res.end(JSON.stringify({ status: 'FAIL', code: 402, detail: 'Invalid refresh token.' }));
      return;
    }
    res.end(JSON.stringify({ status: 'OK', data: {
      endpoint: req.url, authorization: req.headers.authorization,
      ...(req.headers['x-authorization'] ? { signature: req.headers['x-authorization'] } : {}),
      body: body ? JSON.parse(body) : null,
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const requests = [];
  const execFile = (command, args, options, callback) => {
    // 固定「多个子进程尚未读取输入」的合法时序，使用真实 curl 发往本机服务。
    const stdin = new PassThrough();
    requests.push(args);
    ready.then(() => {
      const child = childProcess.execFile(missingCurl ? 'tt-missing-curl-test' : command, args, options, callback);
      child.stdin.on('error', () => {});
      stdin.pipe(child.stdin);
    });
    return { stdin };
  };
  execFile[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  const mod = { exports: {} };
  let request;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/common.js'), 'utf8'), {
    module: mod, console, Buffer, process, URL, setTimeout,
    Date: class extends Date { static now() { return 1790866800000; } },
    require(name) {
      if (name === './paths') return { ...paths, API_BASE: `http://127.0.0.1:${server.address().port}` };
      if (name === 'os') return { ...os, tmpdir: () => temp };
      if (name === 'child_process') return { ...childProcess, execFile };
      if (name === './cdp') return { createCdp: () => ({}) };
      if (name === './typeless-api') {
        const actual = require('../lib/typeless-api');
        return { ...actual, createTypelessApi(deps) {
          request = deps.request;
          return actual.createTypelessApi(deps);
        } };
      }
      if (name === 'fs') return { ...fs, writeFileSync(file, ...args) {
        if (file.startsWith(temp + path.sep)) filesWritten.push(file);
        return fs.writeFileSync(file, ...args);
      } };
      return require(name.startsWith('./') ? '../lib/' + name.slice(2) : name);
    },
  });
  return { api: mod.exports.curlApi, request, release, requests, temp, filesWritten };
}

test('同一毫秒并发校验七个账号和读取统计，各请求的凭证与正文保持配对', async t => {
  const f = await fixture(t);
  const inputs = Array.from({ length: 7 }, (_, i) => [
    { endpoint: '/oauth/refresh_access_token', authorization: `Bearer synthetic-${i}`, body: { app: 'typeless_webapp' } },
    { endpoint: '/user/usage_stats', authorization: `Bearer synthetic-${i}`, body: {} },
  ]).flat();
  const pending = inputs.map(input => f.api('POST', input.endpoint, input.authorization.slice(7), input.body));
  f.release();
  const results = await Promise.all(pending);
  assert.deepEqual(JSON.parse(JSON.stringify(results)).map(result => result.data || { transportError: result._error }), inputs);
  assert.deepEqual(fs.readdirSync(f.temp), [], '完成后不残留含请求正文的临时文件');
});

test('凭证、签名和正文只经内存管道传输，特殊字符原样到达且不进入参数或文件', async t => {
  const f = await fixture(t);
  const token = 'synthetic-private-token', signature = 'synthetic-"signature"\\value';
  const body = { content: '中文\n"词条"\\路径\t\r\v\b\f', literal: '@private-file', option: '\nurl = "http://unexpected.invalid"' };
  const pending = f.request('POST', '/user/dictionary/bulk-import', token, body, { 'x-authorization': signature });
  f.release();
  const result = await pending;
  assert.equal(result.data.authorization, 'Bearer ' + token);
  assert.equal(result.data.signature, signature);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.body)), body);
  assert.doesNotMatch(JSON.stringify(f.requests), /synthetic-private-token|synthetic-|中文|private-file/);
  assert.deepEqual(f.filesWritten, [], '正文不能短暂落盘后再删除');
  await f.api('GET', '/user/get_user_info', 'synthetic');
  assert.equal(f.requests.length, 2, '正文中的换行不能注入额外 curl 选项');
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('HTTP 401 与 JSON 业务码 402 分别保留，不把认证拒绝当网络错误', async t => {
  const f = await fixture(t, { denied: true });
  const pending = f.api('POST', '/oauth/refresh_access_token', 'synthetic', { app: 'typeless_webapp' });
  f.release();
  const result = await pending;
  assert.equal(result._http_status, 401);
  assert.equal(result.code, 402);
  assert.equal(result.detail, 'Invalid refresh token.');
});

test('连接中断或 curl 无法启动时正常返回错误，不残留文件或暴露凭证', async t => {
  for (const options of [{ disconnect: true }, { missingCurl: true }]) {
    const f = await fixture(t, options);
    const pending = f.api('POST', '/user/usage_stats', 'synthetic-private-token', {});
    f.release();
    const result = await pending;
    assert.equal(result._error, 'non-json');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token/);
    assert.deepEqual(f.filesWritten, []);
    assert.deepEqual(fs.readdirSync(f.temp), []);
  }
});
