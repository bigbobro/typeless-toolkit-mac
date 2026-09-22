'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRotationIssue } = require('../lib/rotation-issues');
const { DEFAULT_ROTATION_SETTINGS, validateRotationSettings, createAccountRotation } = require('../lib/account-rotation');

const settings = changes => ({ ...DEFAULT_ROTATION_SETTINGS, enabled: true, ...changes });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ saved = null, usage = 0, accounts = [{ user_id: 'a', nickname: 'Account A' }, { user_id: 'b' }] } = {}) {
  let timestamp = Date.UTC(2026, 8, 22), timerId = 0, persisted = structuredClone(saved);
  const timers = new Map();
  const calls = { usage: [], rotations: [], confirmations: [], notifications: [], guides: [], saves: [], cancels: 0 };
  const state = {
    accounts, currentId: 'a', usage, busy: false, saveError: null,
    readUsage: async () => ({ week_word_usage_value: state.usage }),
    confirm: async () => 'later',
    guide: async () => 'later',
    notify: async () => {},
    rotate: async () => { state.currentId = 'b'; return { switched: true, user_id: 'b', message: '已切换到 Account B' }; },
  };
  const deps = {
    store: {
      load: () => structuredClone(persisted),
      save(value) {
        if (state.saveError) throw state.saveError;
        persisted = structuredClone(value);
        calls.saves.push(structuredClone(value));
      },
    },
    readAccounts: () => state.accounts,
    readCurrentAccountId: async () => state.currentId,
    readUsage: async account => { calls.usage.push(account.user_id); return state.readUsage(account); },
    isBusy: () => state.busy,
    rotate: async options => { calls.rotations.push(options); return state.rotate(options); },
    notifier: {
      confirm: async value => { calls.confirmations.push(value); return state.confirm(value); },
      notify: async value => { calls.notifications.push(value); return state.notify(value); },
      guide: async value => { calls.guides.push(value); return state.guide(value); },
      cancel: () => { calls.cancels++; },
    },
    now: () => timestamp,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: timestamp + delay, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  };
  const rotation = createAccountRotation(deps);
  return {
    rotation, deps, state, calls, timers,
    get persisted() { return structuredClone(persisted); },
    async tick() {
      assert.equal(timers.size, 1, '每次等待期间只有一个轮询 timer');
      const [id, timer] = [...timers][0];
      timers.delete(id); timestamp = timer.due;
      timer.callback();
      await settle();
    },
    async enable(value = {}) { rotation.configure(settings(value)); rotation.start(); await this.tick(); },
  };
}

test('默认禁用不创建 timer，也不读取账号用量', async () => {
  const h = harness();
  h.rotation.start(); h.rotation.start();
  await h.rotation.check();
  assert.deepEqual(h.rotation.view().settings, DEFAULT_ROTATION_SETTINGS);
  assert.equal(h.rotation.view().status.phase, 'disabled');
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.usage.length, 0);
  assert.equal(h.calls.saves.length, 0);
});

test('启用立即检查，之后每 15 分钟一个 timer；重复启停不累积任务', async () => {
  const h = harness();
  await h.enable();
  assert.deepEqual(h.calls.usage, ['a']);
  assert.equal([...h.timers.values()][0].delay, 15 * 60000);
  assert.match(h.rotation.view().status.message, /每 15 分钟/);
  h.rotation.start(); h.rotation.start();
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(h.calls.usage.length, 2);
  h.rotation.stop(); h.rotation.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.rotation.view().status.next_check_at, null);
  h.rotation.start(); h.rotation.start();
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(h.calls.usage.length, 3);
  assert.equal([...h.timers.values()][0].delay, 15 * 60000);
});

test('慢检查不会并发或排队，完成后才安排下一次检查', async () => {
  const h = harness(), pending = deferred();
  h.state.readUsage = () => pending.promise;
  await h.enable();
  assert.equal(h.calls.usage.length, 1);
  assert.equal(h.timers.size, 0);
  await Promise.all([h.rotation.check(), h.rotation.check(), h.rotation.check()]);
  assert.equal(h.calls.usage.length, 1);
  pending.resolve({ week_word_usage_value: 50 });
  await settle();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 15 * 60000);
});

test('管理器忙时不读取用量，下一周期恢复检查', async () => {
  const h = harness(); h.state.busy = true;
  await h.enable();
  assert.equal(h.calls.usage.length, 0);
  assert.equal(h.calls.rotations.length, 0);
  h.state.busy = false;
  await h.tick();
  assert.equal(h.calls.usage.length, 1);
});

test('周用量到提前提醒线才提醒，选择稍后后去重，用量下降后允许新周期提醒', async () => {
  const h = harness({ usage: 1899 });
  await h.enable();
  assert.equal(h.calls.confirmations.length, 0);
  h.state.usage = 1900; await h.tick();
  assert.equal(h.calls.confirmations.length, 1);
  assert.equal(h.calls.confirmations[0].intervalMinutes, 15);
  assert.equal(h.calls.confirmations[0].threshold, 2000);
  h.state.usage = 2200; await h.tick();
  assert.equal(h.calls.confirmations.length, 1);
  h.state.usage = 20; await h.tick();
  assert.equal(h.calls.confirmations.length, 1);
  h.state.usage = 1950; await h.tick();
  assert.equal(h.calls.confirmations.length, 2);
  assert.equal(h.calls.rotations.length, 0);
  assert.deepEqual(h.persisted.accounts, [{ user_id: 'a', used: 1950, reminded: true }]);
});

test('用户确认后才切换，自动模式必须达到完整阈值', async () => {
  const prompt = harness({ usage: 1900 });
  prompt.state.confirm = async () => 'switch';
  await prompt.enable();
  assert.equal(prompt.calls.rotations.length, 1);
  assert.equal(prompt.calls.rotations[0].fromId, 'a');
  assert.equal(prompt.rotation.view().status.current_user_id, 'b');
  assert.equal(prompt.rotation.view().status.used_words, null);

  const auto = harness({ usage: 1900 });
  await auto.enable({ mode: 'auto' });
  auto.state.usage = 1999; await auto.tick();
  assert.equal(auto.calls.rotations.length, 0);
  auto.state.usage = 2000; await auto.tick();
  assert.equal(auto.calls.rotations.length, 1);
  assert.equal(auto.calls.confirmations.length, 0);
});

test('网络失败或无效用量不切号，保留下一次检查并能恢复', async () => {
  for (const failed of [new Error('network unavailable'), { week_word_usage_value: -1 }, { week_word_usage_value: null }]) {
    const h = harness({ usage: 2000 });
    h.state.readUsage = async () => { if (failed instanceof Error) throw failed; return failed; };
    await h.enable({ mode: 'auto' });
    assert.equal(h.calls.rotations.length, 0);
    assert.equal(h.rotation.view().status.phase, 'error');
    assert.equal(h.persisted.paused, false);
    assert.equal(h.timers.size, 1);
    h.state.readUsage = async () => ({ week_word_usage_value: 2000 });
    await h.tick();
    assert.equal(h.calls.rotations.length, 1);
  }
});

test('切换失败暂停并持久化，进程重启后仍暂停，重新保存设置才恢复', async () => {
  const h = harness({ usage: 2000 });
  h.state.rotate = async () => { throw new Error('无法恢复目标登录'); };
  await h.enable({ mode: 'auto' });
  assert.equal(h.rotation.view().status.phase, 'paused');
  assert.equal(h.persisted.paused, true);
  assert.equal(h.timers.size, 0);
  await h.rotation.check();
  assert.equal(h.calls.rotations.length, 1);

  const restored = createAccountRotation(h.deps);
  restored.start();
  assert.equal(restored.view().status.phase, 'paused');
  assert.equal(h.timers.size, 0);
  restored.configure(settings({ mode: 'auto' }));
  assert.equal(restored.view().status.phase, 'waiting');
  assert.equal(h.persisted.paused, false);
  assert.equal(h.timers.size, 1);
  restored.stop();
});

test('设置变更或人工账号变更使旧确认失效，迟到的同意不会切换', async () => {
  for (const action of ['configure', 'invalidate']) {
    const h = harness({ usage: 1900 }), answer = deferred();
    h.state.confirm = () => answer.promise;
    await h.enable();
    assert.equal(h.rotation.view().status.phase, 'prompting');
    if (action === 'configure') h.rotation.configure(settings({ word_threshold: 3000 }));
    else h.rotation.invalidate();
    answer.resolve('switch'); await settle();
    assert.equal(h.calls.rotations.length, 0);
    assert.equal(h.timers.size, 1);
    assert.equal(h.persisted.accounts.some(record => record.reminded), false);
  }
});

test('关闭后迟到的用量或确认结果不会继续存盘、切号或安排下一轮', async () => {
  for (const stage of ['usage', 'prompt']) {
    const h = harness({ usage: 1900 }), pending = deferred();
    if (stage === 'usage') h.state.readUsage = () => pending.promise;
    else h.state.confirm = () => pending.promise;
    await h.enable();
    const saves = h.calls.saves.length;
    h.rotation.stop();
    pending.resolve(stage === 'usage' ? { week_word_usage_value: 2000 } : 'switch');
    await settle();
    assert.equal(h.calls.saves.length, saves);
    assert.equal(h.calls.rotations.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.rotation.view().status.next_check_at, null);
  }
});

test('已移除账号的历史状态在加载和后续检查时裁剪', async () => {
  const h = harness({ saved: {
    version: 1, settings: settings(), paused: false,
    accounts: [{ user_id: 'removed', used: 100, reminded: true }, { user_id: 'a', used: 50, reminded: false }],
  } });
  h.rotation.start(); await h.tick();
  assert.deepEqual(h.persisted.accounts.map(record => record.user_id), ['a']);
  h.state.currentId = 'b'; h.state.accounts = [{ user_id: 'b' }];
  await h.tick();
  assert.deepEqual(h.persisted.accounts.map(record => record.user_id), ['b']);
});

test('设置拒绝无效值，允许的间隔及边界可保存', () => {
  for (const value of [null, [], {}, settings({ enabled: 'yes' }), settings({ mode: 'other' }),
    settings({ word_threshold: 0 }), settings({ word_threshold: 10000001 }), settings({ word_threshold: 1.5 }),
    settings({ warning_words: -1 }), settings({ warning_words: 2000 }), settings({ interval_minutes: 1 })]) {
    assert.throws(() => validateRotationSettings(value), /轮动设置无效/);
  }
  for (const interval_minutes of [10, 15, 30]) {
    const value = settings({ interval_minutes, word_threshold: 1, warning_words: 0, ignored: 'discard' });
    assert.deepEqual(validateRotationSettings(value), settings({ interval_minutes, word_threshold: 1, warning_words: 0 }));
  }
});

test('配置验证或存盘失败保持原配置、原 timer 和提示记录', async () => {
  const h = harness({ usage: 1900 });
  await h.enable();
  const before = h.rotation.view(), saved = h.persisted, timers = [...h.timers], cancels = h.calls.cancels;
  assert.throws(() => h.rotation.configure(settings({ interval_minutes: 2 })), /轮动设置无效/);
  h.state.saveError = new Error('disk full');
  assert.throws(() => h.rotation.configure(settings({ mode: 'auto', interval_minutes: 30 })), /disk full/);
  assert.deepEqual(h.rotation.view(), before);
  assert.deepEqual(h.persisted, saved);
  assert.deepEqual([...h.timers], timers);
  assert.equal(h.calls.cancels, cancels);
});

test('旧提示等待期间连续保存设置，旧结果不能覆盖最后一次配置或触发切换', async () => {
  const h = harness({ usage: 1900 }), answer = deferred();
  h.state.confirm = () => answer.promise;
  await h.enable();
  h.rotation.configure(settings({ word_threshold: 3000, interval_minutes: 10 }));
  const latest = settings({ word_threshold: 4000, interval_minutes: 30 });
  h.rotation.configure(latest);
  answer.resolve('switch'); await settle();
  assert.deepEqual(h.rotation.view().settings, latest);
  assert.deepEqual(h.persisted.settings, latest);
  assert.equal(h.calls.rotations.length, 0);
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal([...h.timers.values()][0].delay, 30 * 60000);
  assert.equal(h.calls.confirmations.length, 1);
});

test('配置保存失败不作废仍有效的用户确认', async () => {
  const h = harness({ usage: 1900 }), answer = deferred();
  h.state.confirm = () => answer.promise;
  await h.enable();
  const cancels = h.calls.cancels;
  h.state.saveError = new Error('disk full');
  assert.throws(() => h.rotation.configure(settings({ word_threshold: 3000 })), /disk full/);
  assert.equal(h.calls.cancels, cancels);
  assert.equal(h.rotation.view().status.phase, 'prompting');
  h.state.saveError = null;
  answer.resolve('switch'); await settle();
  assert.equal(h.calls.rotations.length, 1);
  assert.equal(h.calls.rotations[0].settings.word_threshold, 2000);
});

test('切换准备期间设置改变使 canProceed 失效，迟到的切换结果不覆盖新设置', async () => {
  const h = harness({ usage: 2000 }), result = deferred();
  h.state.rotate = () => result.promise;
  await h.enable({ mode: 'auto' });
  const pending = h.calls.rotations[0];
  assert.equal(pending.canProceed(), true);
  const latest = settings({ word_threshold: 4000, interval_minutes: 30 });
  h.rotation.configure(latest);
  assert.equal(pending.canProceed(), false);
  result.resolve({ switched: false, message: '旧检查已经取消' });
  await settle();
  assert.deepEqual(h.rotation.view().settings, latest);
  assert.equal(h.rotation.view().status.last_result, null);
  assert.equal(h.calls.notifications.length, 0);
  assert.equal(h.timers.size, 1);
});

test('成功切号后的通知失败不能覆盖成功结果或被报告为切号失败', async () => {
  const h = harness({ usage: 2000 });
  h.state.notify = async () => { throw new Error('notifications unavailable'); };
  await h.enable({ mode: 'auto' });
  assert.equal(h.calls.rotations.length, 1);
  assert.equal(h.rotation.view().status.phase, 'waiting');
  assert.equal(h.rotation.view().status.current_user_id, 'b');
  assert.match(h.rotation.view().status.last_result, /已切换到 Account B/);
  assert.doesNotMatch(h.rotation.view().status.last_result, /检查未完成|切换失败|已暂停/);
  assert.equal(h.persisted.paused, false);
  assert.equal(h.timers.size, 1);
});

test('没有账号、没有登录、当前账号未保存分别给准确的处理入口，且不读取用量', async () => {
  for (const [accounts, currentId, code, action] of [
    [[], 'a', 'NO_ACCOUNTS', 'add-account'],
    [[{ user_id: 'a' }], null, 'NOT_LOGGED_IN', 'update-login'],
    [[{ user_id: 'a' }], 'other', 'ACCOUNT_NOT_SAVED', 'add-account'],
  ]) {
    const h = harness({ accounts }); h.state.currentId = currentId;
    await h.enable();
    assert.equal(h.rotation.view().status.issue.code, code);
    assert.equal(h.rotation.view().status.issue.action, action);
    assert.equal(h.calls.usage.length, 0);
    assert.equal(h.calls.guides.length, 1);
    await h.tick();
    assert.equal(h.calls.guides.length, 1, '同类问题不重复打扰');
  }
});

test('瞬时请求失败先自愈，连续失败才引导；恢复后新一轮异常可以再次提醒', async () => {
  const h = harness();
  h.state.readUsage = async () => { throw new Error('transient'); };
  await h.enable();
  assert.equal(h.calls.guides.length, 0);
  await h.tick(); await h.tick();
  assert.equal(h.calls.guides.length, 1);
  assert.equal(h.rotation.view().status.issue.retryable, true);
  h.state.readUsage = async () => ({ week_word_usage_value: 20 });
  await h.tick();
  assert.equal(h.rotation.view().status.issue, null);
  h.state.readUsage = async () => { throw new Error('transient again'); };
  await h.tick(); await h.tick();
  assert.equal(h.calls.guides.length, 2);
});

test('凭证明确失效立即引导，原因与去重跨进程重启保留', async () => {
  const h = harness();
  h.state.readUsage = async () => { throw Object.assign(new Error('expired'), { code: 'ACCOUNT_LOGIN_EXPIRED' }); };
  await h.enable();
  assert.equal(h.calls.guides.length, 1);
  assert.equal(h.persisted.issue.action, 'update-login');
  h.rotation.stop();
  const restored = createAccountRotation(h.deps);
  restored.start();
  await h.tick();
  assert.equal(restored.view().status.issue.code, 'ACCOUNT_LOGIN_EXPIRED');
  assert.equal(h.calls.guides.length, 1);
  restored.stop();
});

test('提醒超时或取消不记为稍后，下轮重新提醒且不执行切号', async () => {
  for (const outcome of ['timeout', 'cancelled', undefined]) {
    const h = harness({ usage: 2000 }); h.state.confirm = async () => outcome;
    await h.enable(); await h.tick();
    assert.equal(h.calls.confirmations.length, 2);
    assert.equal(h.calls.rotations.length, 0);
    assert.equal(h.persisted.accounts[0].reminded, false);
    assert.match(h.rotation.view().status.last_result, /未确认/);
  }
});

test('候选临时失败后需要新的用户确认，恢复后可以正常切换', async () => {
  const h = harness({ usage: 2000 }); h.state.confirm = async () => 'switch';
  const success = h.state.rotate;
  const issue = makeRotationIssue('REQUEST_FAILED', { accountId: 'b' });
  h.state.rotate = async () => ({ switched: false, retryable: true, issue, issues: [issue], message: issue.message });
  await h.enable();
  assert.equal(h.persisted.accounts[0].reminded, false);
  h.state.rotate = success;
  await h.tick();
  assert.equal(h.calls.confirmations.length, 2);
  assert.equal(h.calls.rotations.length, 2);
  assert.equal(h.calls.notifications.length, 1);
  assert.equal(h.rotation.view().status.issue, null);
});

test('需要修复候选时持续显示原因，修复操作使旧抑制失效并允许重新轮动', async () => {
  const h = harness({ usage: 2000 }); h.state.confirm = async () => 'switch';
  const success = h.state.rotate;
  const issue = makeRotationIssue('SNAPSHOT_INVALID', { accountId: 'b' });
  h.state.rotate = async () => ({ switched: false, retryable: false, issue, issues: [issue], message: issue.message });
  await h.enable(); await h.tick();
  assert.equal(h.calls.confirmations.length, 1);
  assert.equal(h.calls.guides.length, 1);
  assert.match(h.rotation.view().status.message, /快照/);
  assert.equal(h.rotation.view().status.candidate_issues.length, 1);
  h.state.rotate = success; h.rotation.invalidate();
  await h.tick();
  assert.equal(h.calls.confirmations.length, 2);
  assert.equal(h.rotation.view().status.current_user_id, 'b');
});

test('自动模式没有候选也弹引导，同类问题去重，恢复操作后可以再次提醒', async () => {
  const h = harness({ usage: 2000 });
  const issue = makeRotationIssue('NO_CANDIDATES');
  h.state.rotate = async () => ({ switched: false, retryable: false, issue, message: issue.message });
  await h.enable({ mode: 'auto' }); await h.tick();
  assert.equal(h.calls.guides.length, 1);
  assert.match(h.calls.guides[0].message, /添加/);
  h.rotation.invalidate(); await h.tick();
  assert.equal(h.calls.guides.length, 2);
});

test('暂停后的引导超时只安排通知重试，不读取用量或重复切号；确认后停止 timer', async () => {
  const h = harness({ usage: 2000 });
  h.state.rotate = async () => { throw Object.assign(new Error('rollback'), { code: 'SWITCH_ROLLED_BACK' }); };
  h.state.guide = async () => 'timeout';
  await h.enable({ mode: 'auto' });
  assert.equal(h.rotation.view().status.phase, 'paused');
  assert.equal(h.timers.size, 1);
  assert.equal(h.persisted.pending_notice.kind, 'issue');
  h.state.guide = async () => 'opened';
  await h.tick();
  assert.equal(h.calls.guides.length, 2);
  assert.equal(h.calls.rotations.length, 1);
  assert.equal(h.calls.usage.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.persisted.pending_notice, null);
});

test('发送成功通知失败时，下轮重发结果通知并保留真实成功，不重放切号', async () => {
  const h = harness({ usage: 2000 });
  h.state.notify = async () => { throw new Error('notification denied'); };
  await h.enable({ mode: 'auto' });
  assert.equal(h.persisted.pending_notice.kind, 'success');
  assert.match(h.rotation.view().status.notification_error, /发送失败/);
  h.state.notify = async () => {}; h.state.usage = 0;
  await h.tick();
  assert.equal(h.calls.notifications.length, 2);
  assert.equal(h.calls.rotations.length, 1);
  assert.equal(h.rotation.view().status.notification_error, null);
  assert.match(h.rotation.view().status.last_result, /已切换到 Account B/);
});

test('旧异常引导迟到的结果不能覆盖新配置，也不会留下额外 timer', async () => {
  const h = harness({ accounts: [] }), answer = deferred();
  h.state.guide = () => answer.promise;
  await h.enable();
  h.rotation.configure(settings({ enabled: false }));
  const before = h.persisted;
  answer.resolve('opened'); await settle();
  assert.deepEqual(h.persisted, before);
  assert.equal(h.rotation.view().status.phase, 'disabled');
  assert.equal(h.rotation.view().status.issue, null);
  assert.equal(h.timers.size, 0);
});

test('状态存盘失败暂停轮动，仍尝试显示恢复引导', async () => {
  const h = harness();
  await h.enable();
  h.state.saveError = new Error('disk full');
  await h.tick();
  assert.equal(h.rotation.view().status.phase, 'paused');
  assert.equal(h.rotation.view().status.issue.code, 'STATE_SAVE_FAILED');
  assert.equal(h.calls.guides.length, 1);
  assert.equal(h.calls.rotations.length, 0);
});

test('切号事务失败保留此前跳过候选的原因和目标账号恢复入口', async () => {
  const h = harness({ usage: 2000, accounts: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }] });
  const skipped = makeRotationIssue('SNAPSHOT_INVALID', { accountId: 'b' });
  const target = makeRotationIssue('SWITCH_ROLLED_BACK', { accountId: 'c' });
  h.state.rotate = async () => { throw Object.assign(new Error('rollback'), { issue: target, issues: [skipped, target] }); };
  await h.enable({ mode: 'auto' });
  assert.equal(h.rotation.view().status.issue.account_id, 'c');
  assert.deepEqual(h.rotation.view().status.candidate_issues.map(issue => issue.account_id), ['b', 'c']);
});

test('暂停期间人工操作不会清除尚未送达的恢复引导，重启后仍仅重试通知', async () => {
  const h = harness({ usage: 2000 });
  h.state.rotate = async () => { throw Object.assign(new Error('rollback'), { code: 'SWITCH_ROLLED_BACK' }); };
  h.state.guide = async () => { throw new Error('osascript temporarily unavailable'); };
  await h.enable({ mode: 'auto' });
  h.rotation.invalidate();
  assert.equal(h.persisted.issue.code, 'SWITCH_ROLLED_BACK');
  assert.equal(h.persisted.pending_notice.kind, 'issue');
  h.rotation.stop();
  h.state.guide = async () => 'opened';
  const restored = createAccountRotation(h.deps); restored.start();
  await h.tick();
  assert.equal(h.calls.rotations.length, 1);
  assert.equal(h.calls.guides.length, 2);
  assert.equal(h.timers.size, 0);
  assert.equal(restored.view().status.phase, 'paused');
  restored.stop();
});

test('修复使提醒抑制失效后立即持久化，下轮前重启也会重新确认', async () => {
  const h = harness({ usage: 2000 });
  await h.enable();
  assert.equal(h.persisted.accounts[0].reminded, true);
  h.rotation.invalidate();
  assert.equal(h.persisted.accounts[0].reminded, false);
  h.rotation.stop();
  const restored = createAccountRotation(h.deps); restored.start();
  await h.tick();
  assert.equal(h.calls.confirmations.length, 2);
  restored.stop();
});

test('当前凭证故障已恢复且词数仍超阈值时，超时确认不会保留旧故障', async () => {
  const h = harness({ usage: 2000 });
  h.state.readUsage = async () => { throw Object.assign(new Error('expired'), { code: 'ACCOUNT_LOGIN_EXPIRED' }); };
  await h.enable();
  assert.equal(h.rotation.view().status.issue.code, 'ACCOUNT_LOGIN_EXPIRED');
  h.state.readUsage = async () => ({ week_word_usage_value: 2000 });
  h.state.confirm = async () => 'timeout';
  await h.tick();
  assert.equal(h.rotation.view().status.issue, null);
  assert.equal(h.persisted.pending_notice, null);
  assert.equal(h.calls.rotations.length, 0);
});

test('确认框显示失败被准确标记为通知问题，不能当成账号失效', async () => {
  const h = harness({ usage: 2000 });
  h.state.confirm = async () => { throw new Error('permission denied'); };
  await h.enable();
  assert.equal(h.rotation.view().status.issue.code, 'NOTIFICATION_FAILED');
  assert.equal(h.calls.rotations.length, 0);
  assert.equal(h.calls.guides.length, 1);
});

test('确认后的当前连接预检故障自行恢复时，不再被故障留下的提醒标记阻挡', async () => {
  const h = harness({ usage: 1950 }); h.state.confirm = async () => 'switch';
  const success = h.state.rotate;
  const issue = makeRotationIssue('CONNECTION_REQUIRED', { accountId: 'a' });
  h.state.rotate = async () => ({ switched: false, retryable: false, issue, message: issue.message });
  await h.enable();
  assert.equal(h.persisted.accounts[0].reminded, true);
  h.state.rotate = success;
  await h.tick();
  assert.equal(h.calls.confirmations.length, 2);
  assert.equal(h.calls.rotations.length, 2);
  assert.equal(h.calls.notifications.length, 1);
});
