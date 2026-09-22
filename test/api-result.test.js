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
const vm = require('node:vm');
const { issueForError } = require('../lib/rotation-issues');

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

test('客户端被拒绝时优先展示具体原因,保留业务错误码', () => {
  assert.throws(
    () => assertApiOk({ status: 'FAIL', code: 20006, msg: 'HTTPException', detail: 'This client is not supported. Please use the official Typeless app.' }, '读取账号词库'),
    e => e.message.includes('This client is not supported') && e.message.includes('20006') && e.apiCode === 20006,
  );
});

// 只替换联网/CDP依赖，其余仍加载真实 common 实现；数据路径沿用本测试临时目录。
function usageFixture(responses, connected = true) {
  const calls = [], mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib/common.js'), 'utf8'), {
    require(name) {
      if (name === './typeless-api') return {
        createRuntimeSigner: () => async () => ({}),
        createTypelessApi: () => async (method, endpoint) => {
          calls.push([method, endpoint]);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return response;
        },
      };
      if (name === './cdp') return { createCdp: () => ({ portUp: async () => connected }) };
      return require(name.startsWith('./') ? '../lib/' + name.slice(2) : name);
    },
    module: mod, console, process, Buffer, URL, setTimeout,
  });
  return { common: mod.exports, calls };
}

test('读取周用量只有刷新端点明确返回402才判凭证失效，业务402须重新确认来源', async () => {
  const f = usageFixture([{ status: 'FAIL', code: 402 }, { status: 'FAIL', code: 402 }]);
  await assert.rejects(f.common.readAccountUsage({ token: 'fixture-refresh' }), error =>
    error.code === 'ACCOUNT_LOGIN_EXPIRED' && error.apiCode === 402
      && issueForError(error).action === 'update-login');
  assert.deepStrictEqual(f.calls, [['POST', '/user/usage_stats'], ['POST', '/oauth/refresh_access_token']]);

  for (const refresh of [{ access_token: 'fixture-access' }, { code: 401 }, { _error: 'non-json' }]) {
    const retry = usageFixture([{ status: 'FAIL', code: 402 }, refresh]);
    await assert.rejects(retry.common.readAccountUsage({ token: 'fixture-refresh' }), error =>
      error.code === 'AUTH_RETRY_REQUIRED' && issueForError(error).retryable === true);
  }
});

test('401保留暂时认证信号，未知业务拒绝不推断设备限制，正常统计不增加刷新请求', async () => {
  for (const code of [401, 403, 418]) {
    const f = usageFixture([{ status: 'FAIL', code, detail: 'fixture failure' }]);
    await assert.rejects(f.common.readAccountUsage({ token: 'fixture-refresh' }), error => {
      const issue = issueForError(error);
      return error.apiCode === code && issue.code === (code === 401 ? 'AUTH_RETRY_REQUIRED' : 'REQUEST_FAILED')
        && issue.retryable && issue.action !== 'reset-device';
    });
    assert.strictEqual(f.calls.length, 1);
  }
  const ok = usageFixture([{ status: 'OK', data: { voice_transcription: { week_word_usage_value: 123, week_word_usage_limit: 2000 } } }]);
  const usage = await ok.common.readAccountUsage({ token: 'fixture-refresh' });
  assert.strictEqual(usage.week_word_usage_value, 123);
  assert.strictEqual(ok.calls.length, 1);
});

test('当前账号读取缺少调试连接时保留CONNECTION_REQUIRED，不启动应用或调用云端', async () => {
  const f = usageFixture([], false);
  await assert.rejects(f.common.readActiveAccountId(), error =>
    error.code === 'CONNECTION_REQUIRED' && issueForError(error).action === 'connect');
  assert.deepStrictEqual(f.calls, []);
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
