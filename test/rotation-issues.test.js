'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRotationIssue, issueForError } = require('../lib/rotation-issues');

test('已知问题给出具体处理入口，额度与暂时请求故障可以重新检查', () => {
  for (const [code, action, retryable] of [
    ['NO_ACCOUNTS', 'add-account', false], ['NO_CANDIDATES', 'add-account', false],
    ['NOT_LOGGED_IN', 'update-login', false], ['ACCOUNT_NOT_SAVED', 'add-account', false],
    ['CONNECTION_REQUIRED', 'connect', false], ['ACCOUNT_LOGIN_EXPIRED', 'update-login', false],
    ['SNAPSHOT_INVALID', 'update-login', false], ['ACCOUNT_QUOTA_EXHAUSTED', 'accounts', true],
    ['AUTH_RETRY_REQUIRED', 'accounts', true], ['REQUEST_FAILED', 'accounts', true],
    ['SWITCH_ROLLED_BACK', 'update-login', false], ['SWITCH_RECOVERY_REQUIRED', 'update-login', false],
    ['STATE_SAVE_FAILED', 'settings', false], ['NOTIFICATION_FAILED', 'settings', false],
  ]) {
    const issue = makeRotationIssue(code, { accountId: 'target', accountName: '工作账号' });
    assert.equal(issue.code, code);
    assert.equal(issue.action, action);
    assert.equal(issue.retryable, retryable);
    assert.equal(issue.account_id, 'target');
    assert.match(issue.message, /工作账号/);
  }
});

test('401 仅作暂时认证重试，未知 402/403/418 及设备限制文案不猜成永久失效或设备问题', () => {
  assert.equal(issueForError({ apiCode: 401 }).code, 'AUTH_RETRY_REQUIRED');
  for (const error of [
    { apiCode: 402 }, { apiCode: 403 }, { apiCode: 418 },
    new Error('device limit; token=fixture-private-token'), { code: 'DEVICE_LIMIT' },
  ]) {
    const issue = issueForError(error);
    assert.equal(issue.code, 'REQUEST_FAILED');
    assert.equal(issue.retryable, true);
    assert.notEqual(issue.action, 'reset-device');
    assert.equal(JSON.stringify(issue).includes('fixture-private-token'), false);
  }
});

test('保留事务附带的目标账号问题，不被当前账号上下文覆盖', () => {
  const issue = makeRotationIssue('SWITCH_ROLLED_BACK', { accountId: 'target', accountName: '目标账号' });
  assert.strictEqual(issueForError({ issue }, { accountId: 'current', accountName: '当前账号' }), issue);
  assert.equal(issueForError({ code: 'LOGIN_CHECK_FAILED' }).code, 'AUTH_RETRY_REQUIRED');
});
