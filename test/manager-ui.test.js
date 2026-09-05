'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'manager-ui.js'), 'utf8')
  .replace(/\nbootDetect\(\);\ncheckVersionDrift\(\);/, '');

function loadUi(request, { realLoad = false } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', style: {}, dataset: {},
      classList: { add() {}, remove() {} }, addEventListener() {},
    });
    return elements.get(id);
  };
  const ui = vm.createContext({
    SESSION_SECRET: 'test',
    window: {},
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    fetch: async (url, options) => ({ json: async () => request(url, options) }),
    setTimeout: (callback) => { queueMicrotask(callback); }, clearTimeout() {},
  });
  vm.runInContext(source, ui);
  if (!realLoad) vm.runInContext('loadAccounts=async()=>{};', ui);
  return { ui, element };
}

test('全部同步的请求失败显示错误,不伪装成没有账号,并解除操作锁', async () => {
  for (const reply of [() => ({ status: 'FAIL', msg: '账号文件损坏' }), () => { throw new Error('连接断开'); }]) {
    const { ui, element } = loadUi(reply);
    await assert.doesNotReject(ui.syncAll());
    assert.match(element('syncBody').innerHTML, /账号文件损坏|连接断开/);
    assert.doesNotMatch(element('syncBody').innerHTML, /没有账号可同步/);
    assert.equal(vm.runInContext('BUSY', ui), false);
  }
});

test('失效卡片直接提供重新登录和移除,不显示剩余天数或切换按钮', () => {
  const { ui, element } = loadUi(() => ({}));
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"旧账号",login_status:"expired",has_snapshot:true,token_days_left:283,live:{token_valid:true}}];', ui);
  ui.render();
  const card = element('grid').innerHTML;
  assert.match(card, /登录已失效/);
  assert.match(card, /重新登录/);
  assert.match(card, /移除/);
  assert.doesNotMatch(card, /283|切换到此号/);
});

test('重新登录引导明确更新原账号,读到别的账号时不进入保存步骤', async () => {
  const { ui, element } = loadUi(url => url === '/api/current'
    ? { status: 'OK', data: { user_id: 'other' } }
    : { status: 'OK', data: { user_id: 'other', capture_id: 'wrong' } });
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"原账号",email:"a@example.com"}];', ui);
  ui.addAccount('target');
  assert.match(element('addIntro').textContent, /a@example.com/);
  assert.match(element('addIntro').textContent, /更新原账号/);
  await ui.doCapture();
  assert.equal(element('addStep2').style.display, 'none');
  assert.match(element('addError').textContent, /不是/);
});

test('重新登录后保存会指定原账号,不重复添加或导入词库', async () => {
  const calls = [];
  const { ui, element } = loadUi((url, options) => {
    calls.push({ url, body: options?.body && JSON.parse(options.body) });
    if (url === '/api/accounts') return { status: 'OK' };
    return { status: 'OK', data: { user_id: 'target', email: 'a@example.com', capture_id: 'fresh-capture' } };
  });
  ui.detectCurrent = async () => {};
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"原昵称",email:"a@example.com"}];', ui);
  ui.addAccount('target');
  await ui.doCapture();
  assert.equal(element('addSaveBtn').textContent, '更新原账号');
  await ui.saveAccount();
  const save = calls.find(c => c.url === '/api/accounts');
  assert.equal(save.body.expected_user_id, 'target');
  assert.equal(save.body.nickname, '原昵称');
  assert.ok(!calls.some(c => c.url.includes('import-master')));
});

test('诊断请求断开后显示原因,下一次检查仍会发出请求', async () => {
  let calls = 0;
  const { ui, element } = loadUi(() => {
    calls++;
    if (calls === 1) throw new Error('连接断开');
    return { status: 'FAIL', msg: '服务暂不可用' };
  });
  await assert.doesNotReject(ui.renderDiag());
  assert.match(element('diagBody').innerHTML, /连接断开/);
  await assert.doesNotReject(ui.renderDiag());
  assert.equal(calls, 2);
  assert.match(element('diagBody').innerHTML, /服务暂不可用/);
});

test('同步逐账号列出成功和失败,随后刷新失败不覆盖同步结果', async () => {
  const { ui, element } = loadUi(() => ({ status: 'OK', data: [
    { nickname: '甲', exported: 2, imported: 1, master_count: 3 },
    { nickname: '乙', error: 'token 过期' },
  ] }));
  ui.loadAccounts = async () => { throw new Error('刷新断开'); };
  await assert.doesNotReject(ui.syncAll());
  const result = element('syncBody').innerHTML;
  assert.match(result, /1 个成功，1 个失败/);
  assert.match(result, /甲.*导出 2 \/ 导入 1 \/ 主库 3/);
  assert.match(result, /乙.*token 过期/);
  assert.doesNotMatch(result, /全部同步完成|刷新断开/);
  assert.equal(vm.runInContext('BUSY', ui), false);
});

test('切号被拒绝时显示原因,不宣告成功也不同步词库', async () => {
  const requests = [], messages = [];
  const { ui } = loadUi((url) => {
    requests.push(url);
    return { status: 'FAIL', msg: '登录凭证已失效,请重新登录' };
  });
  ui.toast = (message) => messages.push(message);
  ui.confirmModal = async () => true;
  ui.detectCurrent = async () => {};
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"测试账号"}];', ui);
  await ui.switchTo('target');
  assert.deepEqual(requests, ['/api/accounts/target/switch']);
  assert.ok(messages.some(m => m.includes('重新登录')));
  assert.ok(messages.every(m => !m.includes('已切换')));
  assert.equal(vm.runInContext('BUSY', ui), false);
});


test('账号加载断网结束占位并给出常驻重试,已有账号不会消失', async () => {
  const { ui, element } = loadUi(() => { throw new Error('连接断开'); }, { realLoad: true });
  await assert.doesNotReject(ui.loadAccounts());
  assert.match(element('accountsError').innerHTML, /重试/);
  assert.doesNotMatch(element('grid').innerHTML, /class="skel"/);
  vm.runInContext('ACCOUNTS=[{user_id:"target",nickname:"保留账号",live:{}}];ACCOUNTS_LOADED=true;', ui);
  ui.render();
  await ui.loadAccounts();
  assert.match(element('grid').innerHTML, /保留账号/);
});

test('读取结果过期后回到读取步骤,不困在无法保存的表单', async () => {
  const { ui, element } = loadUi(url => url === '/api/accounts'
    ? { status: 'FAIL', code: 'CAPTURE_EXPIRED', msg: '读取结果已过期,请重新读取' }
    : { status: 'OK', data: { user_id: 'target', capture_id: 'expired', email: 'a@example.com' } });
  ui.addAccount(); await ui.doCapture(); await ui.saveAccount();
  assert.equal(element('addStep1').style.display, 'block');
  assert.equal(element('addStep2').style.display, 'none');
  assert.match(element('addError').textContent, /重新读取/);
});

test('保存成功后词库导入和列表刷新断网,已保存账号仍显示且说明导入未完成', async () => {
  const { ui, element } = loadUi((url, options) => {
    if(url === '/api/accounts' && options?.method === 'POST') return { status: 'OK', data: { user_id:'target', nickname:'已保存账号' } };
    if(url === '/api/accounts' || url.includes('import-master')) throw new Error('连接断开');
    return { status: 'OK', data: { user_id:'target', capture_id:'capture', nickname:'已保存账号', email:'a@example.com' } };
  }, { realLoad: true });
  ui.detectCurrent = async () => {};
  ui.addAccount(); await ui.doCapture(); await ui.saveAccount();
  assert.match(element('grid').innerHTML, /已保存账号/);
  assert.match(element('operationMsg').textContent, /已添加.*词库导入/);
});

test('备份请求断开时不能误报文件格式错误,词库写入断开也有失败提示', async () => {
  const { ui, element } = loadUi(() => { throw new Error('连接断开'); });
  ui.confirmModal = async () => true;
  const messages=[]; ui.toast=m=>messages.push(m);
  await assert.doesNotReject(ui.backupNow());
  await ui.restoreBackupFile({ files: ['fixture'] });
  assert.ok(messages.some(m=>m.includes('连接')));
  assert.ok(messages.every(m=>!m.includes('格式不正确')));
  vm.runInContext('curDetail={user_id:"target"};',ui);
  element('wordInput').value='保留词条';
  await assert.doesNotReject(ui.addWord());
  assert.equal(element('wordInput').value,'保留词条');
  assert.ok(messages.some(m=>m.includes('添加失败')));
});


test('原生操作失败时保留原因并解除按钮锁,不继续等待成功路径',async()=>{
  const {ui,element}=loadUi(()=>({status:'FAIL',msg:'操作失败，需要重新登录后重试'}));
  ui.confirmModal=async()=>true;
  for(const action of ['resetDevice','patchPaywall']){
    await ui[action]();
    assert.match(element('operationMsg').textContent,/操作失败/);
    assert.equal(vm.runInContext('BUSY',ui),false);
  }
});
