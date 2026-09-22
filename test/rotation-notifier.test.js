'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRotationNotifier } = require('../lib/rotation-notifier');

const DETAILS = { accountName: '工作账号', usedWords: 2050, threshold: 2000, intervalMinutes: 15 };
const MANAGER_URL = 'http://127.0.0.1:7788/#rotation';

function harness() {
  const calls = [];
  const notifier = createRotationNotifier({
    platform: 'darwin',
    managerUrl: MANAGER_URL,
    execFile(file, args, options, callback) {
      const child = { signals: [], kill(signal) { this.signals.push(signal); } };
      calls.push({ file, args, options, callback, child });
      return child;
    },
  });
  return { notifier, calls };
}

test('确认提醒只把账号名和文案传入 argv，脚本默认稍后且 90 秒自动关闭', async () => {
  const { notifier, calls } = harness();
  const accountName = '" & do shell script "touch /tmp/never-run" & "\n$(whoami)`id`';
  const result = notifier.confirm({ ...DETAILS, accountName });
  const { file, args, options, callback } = calls[0];
  assert.equal(file, '/usr/bin/osascript');
  assert.equal(args[0], '-e');
  assert.equal(args[2], '--');
  assert.equal(args[1].includes(accountName), false);
  assert.ok(args[3].includes(accountName));
  assert.match(args[3], /本周已使用 2050 词，已达到你设置的 2000 词轮动阈值/);
  assert.match(args[3], /每 15 分钟/);
  assert.match(args[3], /重启 Typeless/);
  assert.match(args[3], /等待文本输出完成/);
  assert.match(args[1], /default button "稍后" giving up after 90/);
  assert.doesNotMatch(args[1], /cancel button "稍后"/);
  assert.match(args[1], /if gave up of answer then return "timeout"/);
  assert.match(args[1], /if errorNumber is -128 then return "cancelled"/);
  assert.equal(options.timeout, 95000);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.shell, undefined);
  callback(null, 'switch\n');
  assert.equal(await result, 'switch');
});

test('提前提醒说明接近阈值，只有等于或超过阈值才说明已达到', async () => {
  const { notifier, calls } = harness();
  for (const [usedWords, state] of [[1900, '接近'], [2000, '已达到'], [2050, '已达到']]) {
    const result = notifier.confirm({ ...DETAILS, usedWords });
    const call = calls.at(-1);
    assert.ok(call.args[3].includes(`本周已使用 ${usedWords} 词，${state}你设置的 2000 词轮动阈值`));
    if (usedWords < DETAILS.threshold) assert.equal(call.args[3].includes('已达到'), false);
    call.callback(null, 'later');
    assert.equal(await result, 'later');
  }
});

test('确认返回严格枚举，明确稍后、超时和取消互不混淆，未知响应按超时处理', async () => {
  const { notifier, calls } = harness();
  for (const [stdout, expected] of [['later\n', 'later'], ['timeout', 'timeout'], ['cancelled', 'cancelled'], ['', 'timeout'], ['unexpected', 'timeout'], ['open', 'timeout']]) {
    const result = notifier.confirm(DETAILS);
    calls.at(-1).callback(null, stdout);
    assert.equal(await result, expected);
  }
  assert.equal(calls.length, 6);
  notifier.cancel();
  assert.ok(calls.every(call => call.child.signals.length === 0));
});

test('超时杀掉的提醒返回 timeout，运行失败则抛错，两者均释放并发占用', async () => {
  const { notifier, calls } = harness();
  const timeoutResult = notifier.confirm(DETAILS);
  calls[0].callback(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' }));
  assert.equal(await timeoutResult, 'timeout');

  const failedResult = notifier.confirm(DETAILS);
  const failure = Object.assign(new Error('osascript permission denied'), { code: 'EACCES' });
  calls[1].callback(failure);
  await assert.rejects(failedResult, error => error === failure);

  const nextResult = notifier.confirm(DETAILS);
  calls[2].callback(null, 'switch');
  assert.equal(await nextResult, 'switch');
});

test('并发确认最多启动一个子进程；取消关闭提示且过期回调不影响新提示', async () => {
  const { notifier, calls } = harness();
  const firstResult = notifier.confirm(DETAILS);
  assert.equal(await notifier.confirm(DETAILS), 'cancelled');
  assert.equal(calls.length, 1);
  notifier.cancel();
  notifier.cancel();
  assert.equal(await firstResult, 'cancelled');
  assert.deepEqual(calls[0].child.signals, ['SIGKILL']);

  const nextResult = notifier.confirm(DETAILS);
  calls[0].callback(null, 'switch');
  assert.equal(await notifier.confirm(DETAILS), 'cancelled');
  assert.equal(calls.length, 2);
  calls[1].callback(null, 'switch');
  assert.equal(await nextResult, 'switch');
  notifier.cancel();
  assert.deepEqual(calls[1].child.signals, []);
});

test('同步完成和启动时抛错都不会留下可被 cancel 杀掉的旧进程', async () => {
  let calls = 0;
  const notifier = createRotationNotifier({
    platform: 'darwin',
    execFile(_file, _args, _options, callback) {
      calls++;
      if (calls === 1) throw new Error('spawn failed');
      callback(null, 'switch');
      return { kill() { assert.fail('已完成的子进程不能被保留'); } };
    },
  });
  await assert.rejects(notifier.confirm(DETAILS), /spawn failed/);
  assert.equal(await notifier.confirm(DETAILS), 'switch');
  notifier.cancel();
  assert.equal(await notifier.confirm(DETAILS), 'switch');
});

test('异常引导仅在明确点击打开时打开固定管理器地址，标题正文不进入脚本', async () => {
  const { notifier, calls } = harness();
  const title = '异常 " & do shell script "id"';
  const message = '请重新登录\n$(touch /tmp/never-run)';
  const result = notifier.guide({ title, message });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(2), ['--', message, title]);
  assert.equal(calls[0].args[1].includes(message), false);
  assert.equal(calls[0].args[1].includes(title), false);
  assert.match(calls[0].args[1], /buttons \{"稍后", "打开管理器"\}/);
  assert.match(calls[0].args[1], /giving up after 90/);
  calls[0].callback(null, 'open');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, '/usr/bin/open');
  assert.deepEqual(calls[1].args, [MANAGER_URL]);
  assert.equal(calls[1].options.timeout, 5000);
  assert.equal(calls[1].options.shell, undefined);
  calls[1].callback(null);
  assert.equal(await result, 'opened');
  notifier.cancel();
  assert.ok(calls.every(call => call.child.signals.length === 0));
});

test('引导稍后、超时、取消或未知响应均不开浏览器', async () => {
  const { notifier, calls } = harness();
  for (const [stdout, expected] of [['later', 'later'], ['timeout', 'timeout'], ['cancelled', 'cancelled'], ['', 'timeout'], ['switch', 'timeout']]) {
    const result = notifier.guide({ title: '需处理', message: '请检查登录' });
    calls.at(-1).callback(null, stdout);
    assert.equal(await result, expected);
  }
  assert.ok(calls.every(call => call.file === '/usr/bin/osascript'));
});

test('引导和轮动确认共用一个 pending，取消后过期响应不能打开浏览器', async () => {
  const { notifier, calls } = harness();
  const first = notifier.guide({ title: '需处理', message: '请检查登录' });
  assert.equal(await notifier.confirm(DETAILS), 'cancelled');
  assert.equal(await notifier.guide({ title: '重复', message: '' }), 'cancelled');
  assert.equal(calls.length, 1);
  notifier.cancel();
  assert.equal(await first, 'cancelled');
  assert.deepEqual(calls[0].child.signals, ['SIGKILL']);
  const next = notifier.confirm(DETAILS);
  calls[0].callback(null, 'open');
  assert.equal(calls.length, 2);
  assert.equal(await notifier.guide({ title: '重复', message: '' }), 'cancelled');
  calls[1].callback(null, 'later');
  assert.equal(await next, 'later');
});

test('打开管理器阶段仍占用唯一 pending，可取消且不遗留子进程引用', async () => {
  const { notifier, calls } = harness();
  const result = notifier.guide({ title: '需处理', message: '请检查登录' });
  calls[0].callback(null, 'open');
  assert.equal(await notifier.confirm(DETAILS), 'cancelled');
  notifier.cancel();
  assert.equal(await result, 'cancelled');
  assert.deepEqual(calls[0].child.signals, []);
  assert.deepEqual(calls[1].child.signals, ['SIGKILL']);
  calls[1].callback(null);
  const next = notifier.confirm(DETAILS);
  calls[2].callback(null, 'switch');
  assert.equal(await next, 'switch');
});

test('引导执行失败与打开失败如实返回，超时保持为 timeout', async () => {
  const { notifier, calls } = harness();
  for (const file of ['/usr/bin/osascript', '/usr/bin/open']) {
    const result = notifier.guide({ title: '需处理', message: '请检查登录' });
    if (file === '/usr/bin/open') calls.at(-1).callback(null, 'open');
    const failure = new Error(file + ' failed');
    calls.at(-1).callback(failure);
    await assert.rejects(result, error => error === failure);
  }
  const timeout = notifier.guide({ title: '需处理', message: '请检查登录' });
  calls.at(-1).callback(Object.assign(new Error('timeout'), { killed: true }));
  assert.equal(await timeout, 'timeout');
});

test('管理器地址限制为 HTTP loopback 根路径及 rotation 锚点，拒绝任意 URL', async () => {
  for (const managerUrl of ['https://127.0.0.1:7788/#rotation', 'http://example.com/#rotation',
    'http://127.0.0.1.evil.test/#rotation', 'http://user:pass@127.0.0.1:7788/#rotation',
    'http://127.0.0.1:7788/other#rotation', 'http://127.0.0.1:7788/?url=evil#rotation',
    'http://127.0.0.1:7788/#other', 'file:///tmp/anything', 'javascript:alert(1)', '--args', null]) {
    assert.throws(() => createRotationNotifier({ platform: 'darwin', managerUrl }), error => error.code === 'ROTATION_MANAGER_URL_INVALID');
  }
  const missing = createRotationNotifier({ platform: 'darwin', execFile() { assert.fail('地址未配置不能弹窗'); } });
  await assert.rejects(missing.guide({ title: '', message: '' }), /未配置本机管理器地址/);
});

test('同步完成的引导不能覆盖异步打开阶段的进程引用', async () => {
  const opened = { signals: [], kill(signal) { this.signals.push(signal); } };
  const notifier = createRotationNotifier({
    platform: 'darwin', managerUrl: MANAGER_URL,
    execFile(file, _args, _options, callback) {
      if (file === '/usr/bin/osascript') {
        callback(null, 'open');
        return { kill() { assert.fail('不能杀掉已完成的提示进程'); } };
      }
      return opened;
    },
  });
  const result = notifier.guide({ title: '需处理', message: '请检查登录' });
  notifier.cancel();
  assert.equal(await result, 'cancelled');
  assert.deepEqual(opened.signals, ['SIGKILL']);
});

test('通知通过 argv 传递标题和正文，成功、超时和执行失败都如实返回', async () => {
  const { notifier, calls } = harness();
  const title = '" & do shell script "id"';
  const message = '--message\n$(whoami)';
  const result = notifier.notify({ title, message });
  assert.deepEqual(calls[0].args.slice(2), ['--', title, message]);
  assert.equal(calls[0].args[1].includes(title), false);
  assert.equal(calls[0].args[1].includes(message), false);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  calls[0].callback(null);
  assert.equal(await result, undefined);

  for (const error of [new Error('notification failed'), Object.assign(new Error('timeout'), { killed: true })]) {
    const failed = notifier.notify({ title: '轮动失败', message: '请重试' });
    calls.at(-1).callback(error);
    await assert.rejects(failed, actual => actual === error);
  }
});

test('非 macOS 明确报告不支持，不假装提醒已送达', async () => {
  const notifier = createRotationNotifier({ platform: 'linux', execFile() { assert.fail('不能启动 osascript'); } });
  for (const action of [() => notifier.confirm(DETAILS), () => notifier.guide({ title: 't', message: 'm' }), () => notifier.notify({ title: 't', message: 'm' })]) {
    await assert.rejects(action(), error => error.code === 'ROTATION_NOTIFICATION_UNSUPPORTED' && /macOS/.test(error.message));
  }
  notifier.cancel();
});
