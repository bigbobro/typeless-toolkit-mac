'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDiagnosticLog } = require('../lib/diagnostic-log');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'logs');
  return { root, dir, log: createDiagnosticLog({ dir, version: '2.9.5', ...options }) };
}

test('日志落盘前过滤敏感字段，匿名标识仅在同一次启动内稳定，重启仍可导出历史', t => {
  const { log, dir } = fixture(t);
  const secret = 'never-log-this-token';
  log.record('login_check', { account_id: 'private-user-id', credential: secret,
    outcome: 'expired', http_status: 401, api_code: 402, email: 'private@example.com',
    message: secret, token: secret, authorization: secret, response: { access_token: secret } });
  log.record('saved', { account_id: 'private-user-id', credential: secret });
  const exported = log.exportLog();
  assert.equal(exported.logging.complete, true);
  assert.equal(exported.events[0].account_ref, log.accountRef('private-user-id'));
  assert.equal(exported.events[0].credential_ref, exported.events[1].credential_ref);
  assert.equal(exported.events[0].http_status, 401);
  assert.equal(exported.events[0].api_code, 402);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'diagnostics.jsonl'), 'utf8'), /never-log|private-user|private@example|authorization|access_token/);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'diagnostics.jsonl')).mode & 0o777, 0o600);
  const restarted = createDiagnosticLog({ dir, version: '2.9.5' });
  assert.notEqual(restarted.accountRef('private-user-id'), log.accountRef('private-user-id'));
  assert.equal(restarted.exportLog().events.length, 2);
});

test('并发操作分别关联请求，失败只保留允许的错误码，不保存错误正文', async t => {
  const { log } = fixture(t);
  await Promise.all([1, 2].map(async n => log.withRequest(async () => {
    log.begin(n === 1 ? 'browser_login' : 'refresh_accounts');
    await new Promise(resolve => setTimeout(resolve, n === 1 ? 10 : 1));
    log.record('login_check', { account_id: 'user-' + n, outcome: 'unknown' });
    log.finish(500, { status: 'FAIL', code: 'SECRET', msg: 'secret-token' });
  })));
  const events = log.exportLog().events;
  for (const n of [1, 2]) {
    const related = events.filter(e => e.request_id === n);
    assert.equal(related.length, 3);
    assert.equal(new Set(related.map(e => e.operation)).size, 1);
    assert.equal(related[2].error_code, 'INTERNAL_ERROR');
  }
  assert.doesNotMatch(JSON.stringify(events), /SECRET|secret-token/);
});

test('日志限额轮转保留最近记录，导出时过滤污染字段并标出损坏行', t => {
  const { log, dir } = fixture(t, { maxBytes: 800 });
  for (let n = 0; n < 20; n++) log.record('saved', { account_count: n });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['diagnostics.jsonl', 'diagnostics.jsonl.1']);
  for (const file of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, file)).size <= 800);
  assert.equal(log.exportLog().events.at(-1).account_count, 19);
  fs.writeFileSync(path.join(dir, 'diagnostics.jsonl'), '{"event":"saved","token":"private"}\nbroken\n', { mode: 0o600 });
  const out = log.exportLog();
  assert.equal(out.logging.complete, false);
  assert.doesNotMatch(JSON.stringify(out), /private|broken/);
});

test('日志路径故障或符号链接不会阻断操作，也不改写或导出链接目标', t => {
  const { log, dir, root } = fixture(t);
  const outside = path.join(root, 'original');
  fs.writeFileSync(outside, 'sensitive-original');
  fs.mkdirSync(dir);
  fs.symlinkSync(outside, path.join(dir, 'diagnostics.jsonl'));
  assert.doesNotThrow(() => log.record('manager_started'));
  assert.equal(log.status().available, false);
  assert.equal(log.status().dropped_events, 1);
  assert.equal(log.exportLog().logging.complete, false);
  assert.doesNotMatch(JSON.stringify(log.exportLog()), /sensitive-original/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sensitive-original');
});

test('跨请求流程标识可关联，状态原因按枚举过滤，不从消息或身份字段构造日志', async t => {
  const { log } = fixture(t);
  for (const reason of ['ACCOUNT_MISMATCH', 'private@example.invalid']) await log.withRequest(async () => {
    log.begin('login_flow'); log.attachFlow('abcdabcdabcdabcd');
    log.record('flow_state', { stage: 'waiting_login', previous_stage: 'login_required', reason,
      target_id: 'private-account', account: { token: 'secret' }, message: 'secret' });
    log.finish(200, { status: 'OK' });
  });
  const events = log.exportLog().events;
  const states = events.filter(e => e.event === 'flow_state');
  assert.equal(states[0].reason, 'ACCOUNT_MISMATCH'); assert.equal(states[1].reason, undefined);
  assert.ok(states.every(e => e.flow_id === 'abcdabcdabcdabcd'));
  assert.ok(events.filter(e => e.event === 'operation_finished').every(e => e.flow_id === 'abcdabcdabcdabcd'));
  assert.doesNotMatch(JSON.stringify(events), /private|secret|target_id/);
});
