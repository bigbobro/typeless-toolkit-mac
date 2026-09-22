'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'manager-ui.js'), 'utf8')
  .replace(/\nbootDetect\(\);\ncheckVersionDrift\(\);/, '');
const settings = { enabled: true, mode: 'notify', word_threshold: 2000, warning_words: 100, interval_minutes: 15 };
const response = (overrides = {}) => ({ status: 'OK', data: {
  settings: { ...settings, ...overrides.settings },
  status: { phase: 'waiting', message: '等待下次检查', last_check_at: null, next_check_at: null,
    current_user_id: 'current', used_words: 1920, last_result: null, ...overrides.status },
} });

function loadUi(request = () => response()) {
  const elements = new Map(), events = {}, requests = [], intervals = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
      classList: { add() {}, remove() {} }, addEventListener() {},
    });
    return elements.get(id);
  };
  const ui = vm.createContext({
    SESSION_SECRET: 'test',
    window: { addEventListener(name, callback) { events[name] = callback; } },
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || 'GET', body: options?.body && JSON.parse(options.body) });
      return { json: async () => request(url, options) };
    },
    setTimeout() {}, clearTimeout() {}, setInterval(callback, ms) { intervals.push(ms); },
  });
  vm.runInContext(source, ui);
  return { ui, element, events, requests, intervals };
}

test('轮动设置读取后台值，明确 15 分钟检查与 macOS 提醒，保存完整设置', async () => {
  const { ui, element, requests } = loadUi();
  await ui.openRotationSettings();
  assert.equal(element('rotationThreshold').value, 2000);
  assert.match(element('rotationCondition').textContent, /1,900 词.*macOS/);
  assert.match(element('rotationCadence').textContent, /每 15 分钟检查一次.*超过/);
  element('rotationThreshold').value = '2500';
  element('rotationWarning').value = '50';
  element('rotationInterval').value = '30';
  await ui.saveRotationSettings();
  assert.deepEqual(requests[1], { url: '/api/rotation', method: 'POST', body: {
    enabled: true, mode: 'notify', word_threshold: 2500, warning_words: 50, interval_minutes: 30,
  } });
  assert.equal(element('rotationSaveBtn').disabled, false);
});

test('空白、小数、越界阈值与无效提前量均阻止保存，不触发后台操作', async () => {
  const { ui, element, requests } = loadUi();
  await ui.openRotationSettings();
  for (const invalid of ['', '0', '1.5', '10000001']) {
    element('rotationThreshold').value = invalid;
    await ui.saveRotationSettings();
    assert.match(element('rotationError').textContent, /阈值须为/);
  }
  element('rotationThreshold').value = '2000';
  for (const invalid of ['', '-1', '2000', '0.5']) {
    element('rotationWarning').value = invalid;
    await ui.saveRotationSettings();
    assert.match(element('rotationError').textContent, /提前提醒词数/);
  }
  assert.equal(requests.length, 1);
});

test('自动模式说明重启风险，隐藏的提前量不会阻挡缩小阈值', async () => {
  const { ui, element, requests } = loadUi();
  await ui.openRotationSettings();
  element('rotationMode').value = 'auto';
  element('rotationThreshold').value = '50';
  ui.updateRotationForm();
  assert.equal(element('rotationAutoWarning').hidden, false);
  assert.equal(element('rotationWarning').disabled, true);
  assert.match(element('rotationCondition').textContent, /50 词后直接切换/);
  await ui.saveRotationSettings();
  assert.equal(requests[1].body.warning_words, 49);
  assert.equal(requests[1].body.mode, 'auto');
  const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
  assert.match(html, /自动切换会重启 Typeless，可能中断正在进行的语音输入/);
});

test('重新聚焦只读本地状态，并合并重叠请求，不建立页面轮询', async () => {
  let resolve;
  const responsePending = new Promise(r => { resolve = r; });
  const { ui, events, requests, intervals, element } = loadUi(() => responsePending);
  const pending = ui.loadRotationStatus();
  events.focus(); events.focus();
  await Promise.resolve();
  assert.deepEqual(requests.map(r => r.url), ['/api/rotation']);
  assert.equal(intervals.length, 0);
  resolve(response({ status: { phase: 'paused', message: '切换失败，请检查后重新保存设置' } }));
  await pending;
  assert.equal(element('rotationBadge').textContent, '已暂停');
  assert.match(element('rotationMessage').textContent, /1,920 词.*切换失败/);
  assert.match(element('rotationTimes').textContent, /上次检查.*下次检查/);
});

test('后台状态刷新不覆盖未保存表单，错误原样以文本显示', async () => {
  const { ui, events, element } = loadUi(() => response({ status: { phase: 'error', message: '<script>失败</script>' } }));
  await ui.openRotationSettings();
  element('rotationThreshold').value = '3000';
  events.focus(); await ui.loadRotationStatus();
  assert.equal(element('rotationThreshold').value, '3000');
  assert.match(element('rotationMessage').textContent, /<script>失败<\/script>/);
  assert.equal(element('rotationMessage').innerHTML, '');
  assert.equal(element('rotationBadge').textContent, '检查异常');
});

test('保存失败保留错误与表单并释放按钮，过期 GET 不覆盖保存后的状态', async () => {
  let phase = 'initial', resolveOld;
  const { ui, element } = loadUi((url, options) => {
    if (options?.method === 'POST') return phase === 'failed'
      ? { status: 'FAIL', msg: '配置写入失败' }
      : response({ settings: { enabled: false }, status: { phase: 'disabled' } });
    if (phase === 'pending') return new Promise(r => { resolveOld = r; });
    return response();
  });
  await ui.openRotationSettings();
  phase = 'failed'; await ui.saveRotationSettings();
  assert.equal(element('rotationError').textContent, '配置写入失败');
  assert.equal(element('rotationSaveBtn').disabled, false);
  phase = 'pending'; const old = ui.loadRotationStatus();
  await Promise.resolve();
  element('rotationEnabled').checked = false;
  await ui.saveRotationSettings();
  resolveOld(response()); await old;
  assert.equal(element('rotationBadge').textContent, '未启用');
});

test('轮动异常、候选原因与账号名安全呈现，最近结果和通知失败分别保留', () => {
  const { ui, element } = loadUi();
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"<img src=x onerror=alert(1)>"}];', ui);
  ui.renderRotationStatus(response({ status: {
    phase: 'error', issue: { code: 'CONNECTION_ERROR', message: '管理连接断开 <script>', action: 'connect' },
    candidate_issues: [{ code: 'LOGIN_EXPIRED', message: '登录失效 "请重登"', action: 'update-login', account_id: 'target' }],
    last_result: '已切换到测试账号', notification_error: '<b>通知被拒绝</b>',
  } }).data);
  const html = element('rotationIssues').innerHTML;
  assert.match(html, /连接 Typeless/);
  assert.match(html, /更新登录/);
  assert.match(html, /请先在 Typeless 登录/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(element('rotationLastResult').textContent, /已切换到测试账号/);
  assert.equal(element('rotationLastResult').hidden, false);
  assert.match(element('rotationNotificationError').textContent, /<b>通知被拒绝<\/b>/);
  assert.match(element('rotationNotificationError').textContent, /^系统提醒：/);
  assert.equal(element('rotationNotificationError').innerHTML, '');
  ui.renderRotationStatus(response({ status: { last_result: '已切换到测试账号' } }).data);
  assert.equal(element('rotationIssues').hidden, true);
  assert.equal(element('rotationNotificationError').hidden, true);
  assert.equal(element('rotationLastResult').hidden, false);
});

test('同一主问题与候选问题合并展示并保留恢复动作，已带账号名的原因不重复加名', () => {
  const { ui, element } = loadUi();
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"工作账号"}];', ui);
  const issue = { code: 'ACCOUNT_LOGIN_EXPIRED', message: '「工作账号」登录凭证失效', account_id: 'target' };
  ui.renderRotationStatus(response({ status: {
    issue, candidate_issues: [{ ...issue, action: 'update-login' }],
    notification_error: '系统提示尚未确认，下次检查会再次提醒',
  } }).data);
  let html = element('rotationIssues').innerHTML;
  assert.equal((html.match(/登录凭证失效/g) || []).length, 1);
  assert.equal((html.match(/recoverRotationIssue\(/g) || []).length, 1);
  assert.match(html, /更新登录/);
  assert.doesNotMatch(html, /候选账号需要处理/);
  assert.match(element('rotationNotificationError').textContent, /^系统提醒：系统提示尚未确认/);
  assert.doesNotMatch(element('rotationNotificationError').textContent, /未送达/);
  ui.renderRotationStatus(response({ status: { candidate_issues: [{ ...issue, action: 'accounts' }] } }).data);
  html = element('rotationIssues').innerHTML;
  assert.equal((html.match(/「工作账号」/g) || []).length, 1);
});

test('更新指定账号登录沿用现有引导，先登录提示和目标账号保持一致', async () => {
  const { ui, element, requests } = loadUi();
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"工作账号",email:"test@example.com"}];', ui);
  ui.renderRotationStatus(response({ status: {
    issue: { message: '没有可用的下一个账号', action: 'accounts' },
    candidate_issues: [{ message: '登录凭证失效', action: 'update-login', account_id: 'target' }],
  } }).data);
  await ui.recoverRotationIssue(1);
  assert.equal(vm.runInContext('ADD_TARGET_ID', ui), 'target');
  assert.match(element('addIntro').textContent, /先在 Typeless 登录.*test@example.com/);
  assert.deepEqual(requests.map(r => r.url), ['/api/rotation']);
});

test('恢复动作只复用指定入口，账号列表为空时提供添加，完成后仅刷新状态', async () => {
  const { ui, element, requests } = loadUi();
  const actions = [];
  ui.addAccount = id => actions.push(['add', id]);
  ui.launch = async () => actions.push(['connect']);
  ui.openRotationSettings = async () => actions.push(['settings']);
  element('grid').scrollIntoView = options => actions.push(['accounts', options.block]);
  for (const action of ['add-account', 'connect', 'settings', 'accounts']) {
    ui.renderRotationStatus(response({ status: { issue: { message: '需要处理', action } } }).data);
    await ui.recoverRotationIssue(0);
  }
  vm.runInContext('ACCOUNTS=[{user_id:"target"}];', ui);
  ui.renderRotationStatus(response({ status: { issue: { message: '候选额度不足', action: 'accounts' } } }).data);
  await ui.recoverRotationIssue(0);
  assert.deepEqual(actions, [['add', undefined], ['connect'], ['settings'], ['add', undefined], ['accounts', 'start']]);
  assert.ok(requests.every(r => r.url === '/api/rotation' && r.method === 'GET'));
});

test('未知异常不推断设备限制，只有明确动作才能进入既有重置确认且取消不写入', async () => {
  const { ui, element, requests } = loadUi();
  let confirmations = 0;
  ui.confirmModal = async message => { confirmations++; assert.match(message, /重置设备/); return false; };
  for (const action of [undefined, 'toString']) {
    ui.renderRotationStatus(response({ status: { issue: { message: '可能设备限制，也可能网络失败', action } } }).data);
    assert.doesNotMatch(element('rotationIssues').innerHTML, /解除设备限制|<button/);
    await ui.recoverRotationIssue(0);
  }
  assert.equal(confirmations, 0);
  ui.renderRotationStatus(response({ status: { issue: { message: '已确认设备限制', action: 'reset-device' } } }).data);
  assert.match(element('rotationIssues').innerHTML, /解除设备限制/);
  await ui.recoverRotationIssue(0);
  assert.equal(confirmations, 1);
  assert.ok(requests.every(r => r.method === 'GET' && r.url === '/api/rotation'));
});

test('设置区明确区分主动稍后与超时下轮提醒，并支持轮动区锚点', async () => {
  const { ui, element } = loadUi();
  await ui.openRotationSettings();
  assert.match(element('rotationCondition').textContent, /选择「稍后」后，用量重置前不重复提醒/);
  assert.match(element('rotationCondition').textContent, /90 秒未操作.*下次检查再提醒/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
  assert.match(html, /<section[^>]+id="rotation"/);
});
