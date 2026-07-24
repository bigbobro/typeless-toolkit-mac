'use strict';

/**
 * assertApiOk 测试 —— 「失败不得伪装成空结果」这条不变量的守门人
 *
 * 背景:curlApi 从不抛错。它在解析不出 JSON 时返回 { _error: 'non-json' },
 * 在 API 报错时原样返回错误 JSON。调用方若直接取 `resp.data?.words || []`,
 * 「token 失效 / 断网 / 接口改版」都会被读成「这个账号词库是空的」,于是:
 *   - 词库面板显示空,像是用户自己没加过词
 *   - syncAccount 报告「同步完成:导出 0 条」,像是成功了
 * assertApiOk 把这三种失败拦在数据被误读之前。
 *
 * 数据隔离:require lib/common.js 之前把 TYPELESS_DATA_DIR 指向临时目录。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-apiresult-test-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const { assertApiOk } = require('../lib/common.js');

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('status 为 OK 时原样返回响应', () => {
  const resp = { status: 'OK', data: { words: [{ term: 'a' }] } };
  assert.strictEqual(assertApiOk(resp, '读取账号词库'), resp);
});

test('curlApi 的 non-json 兜底必须抛错,不能当成空结果', () => {
  const resp = { _error: 'non-json', _raw: '<html>502 Bad Gateway</html>', _stderr: '' };
  assert.throws(
    () => assertApiOk(resp, '读取账号词库'),
    (e) => e.message.includes('读取账号词库失败') && e.message.includes('502 Bad Gateway'),
  );
});

test('API 返回业务错误时抛错并带上错误文案', () => {
  assert.throws(
    () => assertApiOk({ status: 'FAIL', msg: 'Unauthorized' }, '导入词库'),
    (e) => e.message.includes('导入词库失败') && e.message.includes('Unauthorized'),
  );
  assert.throws(
    () => assertApiOk({ detail: 'token expired' }, '读取账号词库'),
    (e) => e.message.includes('token expired'),
  );
});

test('null / undefined / 非对象响应都必须抛错', () => {
  for (const bad of [null, undefined, 'OK', 0, []]) {
    assert.throws(() => assertApiOk(bad, '读取账号词库'), /读取账号词库失败/);
  }
});

test('错误详情被截断,不会把整个响应体灌进错误消息', () => {
  const resp = { _error: 'non-json', _raw: 'x'.repeat(5000) };
  try {
    assertApiOk(resp, '读取账号词库');
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e.message.length < 300, `错误消息过长: ${e.message.length}`);
  }
});
