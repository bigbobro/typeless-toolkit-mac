'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('实时请求被拒绝时保留错误和未知计数,不把接口限制当登录失效', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-live-status-'));
  let dictionaryOk = false;
  const server = http.createServer((req, res) => {
    const ok = dictionaryOk && req.url.startsWith('/user/dictionary/list');
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'OK', data: { words: [], total_count: 0 } } : {
      status: 'FAIL', code: 20006, msg: 'HTTPException',
      detail: 'This client is not supported. Please use the official Typeless app.',
    }));
  });
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify({
    api_base: `http://127.0.0.1:${server.address().port}`,
  }));
  process.env.TYPELESS_DATA_DIR = root;
  const { liveStatus } = require('../lib/common');
  const failed = await liveStatus({ token: 'test-token' });
  assert.equal(failed.token_valid, true);
  assert.equal(failed.dict_count, null);
  assert.equal(failed.usage, null);
  assert.equal(failed.personal, null);
  assert.match(failed._err, /This client is not supported/);
  dictionaryOk = true;
  const partial = await liveStatus({ token: 'test-token' });
  assert.equal(partial.dict_count, 0, '真实空词库仍显示零');
  assert.match(partial._err, /This client is not supported/);
});
