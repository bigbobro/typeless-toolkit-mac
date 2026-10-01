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
      classList: { visible:false, add() { this.visible=true; }, remove() { this.visible=false; }, contains() { return this.visible; } }, addEventListener() {},
    });
    return elements.get(id);
  };
  const ui = vm.createContext({
    SESSION_SECRET: 'test',
    window: {},
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    fetch: async (url, options) => ({ json: async () => request(url, options) }),
    setTimeout: (callback, ms) => { if(ms!==3000) queueMicrotask(callback); }, clearTimeout() {},
  });
  vm.runInContext(source, ui);
  if (!realLoad) vm.runInContext('loadAccounts=async()=>{};', ui);
  return { ui, element };
}

function captureDownloads(ui) {
  const blobs = [], downloads = [], revoked = [];
  ui.Blob = Blob;
  ui.URL = {
    createObjectURL(blob) { blobs.push(blob); return 'blob:test-download'; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  ui.document.body = { appendChild() {} };
  ui.document.createElement = () => ({
    click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {},
  });
  return { blobs, downloads, revoked };
}

test('诊断日志一键下载 JSON，导出失败不生成文件，不额外刷新账号', async () => {
  const requests = [];
  const data = { logging: { available: true, complete: true, dropped_events: 0 }, events: [{ event: 'saved' }] };
  const { ui, element } = loadUi(url => { requests.push(url); return { status: 'OK', data }; });
  const captured = captureDownloads(ui);
  await ui.exportDiagnosticLog();
  assert.deepEqual(requests, ['/api/diagnostic-log']);
  assert.equal(captured.downloads.length, 1);
  assert.match(captured.downloads[0].filename, /^Typeless排查日志-.*\.json$/);
  assert.deepEqual(JSON.parse(await captured.blobs[0].text()), data);
  assert.equal(element('btnExportDiagnosticLog').disabled, false);
  assert.deepEqual(captured.revoked, ['blob:test-download']);
  const failed = loadUi(() => ({ status: 'FAIL', msg: '日志读取失败' }));
  const noDownload = captureDownloads(failed.ui);
  await failed.ui.exportDiagnosticLog();
  assert.equal(noDownload.downloads.length, 0);
  assert.equal(failed.element('btnExportDiagnosticLog').disabled, false);
});

test('导出已保存主词库为无表头单列 CSV,保留中文、逗号、引号和换行', async () => {
  const requests = [];
  const { ui, element } = loadUi((url, options) => {
    requests.push({ url, method: options?.method || 'GET' });
    return { status: 'OK', data: ['中文', 'hello,world', 'say "hi"', 'line\nbreak', '00123'] };
  });
  const { blobs, downloads, revoked } = captureDownloads(ui);
  await ui.exportDictionary();
  assert.deepEqual(requests, [{ url: '/api/master', method: 'GET' }]);
  assert.deepEqual(downloads, [{ href: 'blob:test-download', filename: 'Typeless词库.csv' }]);
  const bytes = Buffer.from(await blobs[0].arrayBuffer());
  assert.equal(blobs[0].type, 'text/csv;charset=utf-8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '\uFEFF"中文"\r\n"hello,world"\r\n"say ""hi"""\r\n"line\nbreak"\r\n"00123"\r\n');
  assert.deepEqual(revoked, ['blob:test-download']);
  assert.equal(element('btnExportDictionary').disabled, false);
});

test('主词库为空或读取失败时不下载误导性文件,并恢复导出按钮', async () => {
  for (const reply of [
    () => ({ status: 'OK', data: [] }),
    () => ({ status: 'FAIL', msg: '读取失败' }),
    () => { throw Error('断开'); },
  ]) {
    const { ui, element } = loadUi(reply);
    const { downloads } = captureDownloads(ui);
    const messages = [];
    ui.toast = message => messages.push(message);
    await ui.exportDictionary();
    assert.equal(downloads.length, 0);
    assert.match(messages.join(' '), /主词库为空|导出失败/);
    assert.equal(element('btnExportDictionary').disabled, false);
  }
});

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

test('统计读取被拒绝时显示原因和未知值,不伪装成零用量或未启用', () => {
  const { ui, element } = loadUi(() => ({}));
  const account = { user_id: 'target', login_status: 'valid', live: {
    usage: null, personal: null, dict_count: null, error: '客户端不受支持 <test>',
  } };
  vm.runInContext(`ACCOUNTS=${JSON.stringify([account])};`, ui);
  ui.render();
  const card = element('grid').innerHTML;
  assert.match(card, /客户端不受支持 &lt;test&gt;/);
  assert.doesNotMatch(card, /8,000|>0%<|>0<|<test>/);
  ui.renderUsage(account);
  ui.renderPersonal(account);
  for (const id of ['tab-usage', 'tab-personal']) {
    assert.match(element(id).innerHTML, /读取失败.*客户端不受支持 &lt;test&gt;/);
    assert.doesNotMatch(element(id).innerHTML, /未启用|>0%<|8,000/);
  }
});

test('建立管理连接后重新读取账号统计,清除此前断连留下的占位', async () => {
  const calls = [];
  const { ui } = loadUi(url => {
    calls.push(url);
    return { status: 'OK', data: [] };
  }, { realLoad: true });
  ui.detectCurrent = async () => ({ state: 'connected', account_detected: true });
  await ui.launch();
  assert.ok(calls.indexOf('/api/accounts') > calls.indexOf('/api/launch'));
  assert.equal(calls.filter(url => url === '/api/accounts').length, 1);
});

const waitingFlow = { active: true, flow_id: 'abcdabcdabcdabcd', revision: 2, stage: 'waiting_login', step: 2,
  target_id: 'target', target: { email: 'target@example.invalid' }, message: '正在等待目标账号，当前账号不符',
  action: { id: 'check', label: '检查登录结果' }, auto_check: true, can_reopen_browser: true };

test('向导刷新恢复既有目标，错误账号只显示检测步骤，不开放保存', async () => {
  const calls=[];
  const {ui,element}=loadUi((url,options)=>{calls.push([url,options]);return {status:'OK',data:waitingFlow};});
  await ui.addAccount('other');
  assert.match(element('flowTarget').textContent,/target@example.invalid/);
  assert.equal(element('flowIdentity').hidden,true);
  assert.equal(element('flowPrimary').textContent,'检查登录结果');
  assert.equal(element('loginFlowBanner').style.display,'flex');
  assert.equal(calls.length,1); assert.equal(calls[0][0],'/api/login-flow');
  ui.closeModal('addMask');
  assert.equal(element('loginFlowBanner').style.display,'flex','收起不结束流程');
});

test('服务端决定下一步；过期标签页返回新状态，不重复保存', async () => {
  const calls=[];
  const confirm={...waitingFlow,stage:'confirm',revision:4,action:{id:'save',label:'确认并更新原账号'},account:{email:'target@example.invalid',nickname:'原昵称'}};
  const {ui,element}=loadUi((url,options)=>{
    calls.push([url,options]);
    return options?.method==='POST'?{status:'FAIL',code:'LOGIN_FLOW_CHANGED',msg:'流程状态已更新',data:waitingFlow}:{status:'OK',data:confirm};
  });
  await ui.addAccount('target');
  assert.equal(element('flowIdentity').hidden,false);
  assert.equal(element('addNick').value,'原昵称');
  await ui.loginFlowAction();
  const body=JSON.parse(calls[1][1].body);
  assert.equal(body.action,'save'); assert.equal(body.revision,4); assert.equal(body.nickname,'原昵称');
  assert.equal(element('flowIdentity').hidden,true);
  assert.match(element('addError').textContent,/状态已更新/);
  assert.equal(calls.length,2);
});

test('保存响应丢失后先回读流程，呈现已保存待校验，不重发保存', async () => {
  const calls=[];
  const confirm={...waitingFlow,stage:'confirm',action:{id:'save',label:'保存账号'},account:{email:'target@example.invalid'}};
  const retry={...waitingFlow,stage:'retry',saved:true,auto_check:false,message:'已保存，请重试校验',action:{id:'retry',label:'重试结果校验'}};
  const {ui,element}=loadUi((url,options)=>{
    calls.push(options?.method||'GET');
    if(options?.method==='POST') throw Error('连接断开');
    return {status:'OK',data:calls.length===1?confirm:retry};
  });
  await ui.addAccount(); await ui.loginFlowAction();
  assert.deepEqual(calls,['GET','POST','GET']);
  assert.equal(element('flowPrimary').textContent,'重试结果校验');
  assert.match(element('flowMessage').textContent,/已保存/);
  assert.equal(element('flowPrimary').disabled,false);
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

test('诊断展示最近一次登录校验的时间和两种错误码，不输出凭证或额外刷新账号', async () => {
  const calls = [];
  const { ui, element } = loadUi(url => {
    calls.push(url);
    return { status: 'OK', data: url === '/api/diagnostics'
      ? { typeless: {}, cdp: { port: 9222 }, data: { backup: {}, accounts_count: 2 } } : {} };
  });
  vm.runInContext(`ACCOUNTS=[{
    user_id:'a', token:'synthetic-private-token', login_status:'expired',
    login_check:{http_status:401,api_code:402,checked_at:'2026-10-01T16:23:36.000Z'}
  }, {user_id:'b',login_status:'unknown'}];`, ui);
  await ui.renderDiag();
  const html = element('diagBody').innerHTML;
  assert.match(html, /账号 1 登录校验/);
  assert.match(html, /登录已失效.*HTTP 401.*业务码 402/);
  assert.match(html, /账号 2 登录校验.*尚未检查/);
  assert.match(html, /全部刷新/);
  assert.doesNotMatch(html, /synthetic-private-token|undefined/);
  assert.deepEqual(calls, ['/api/diagnostics', '/api/paywall-status']);
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

test('确认过期回到检测；词库导入失败单独说明，校验成功由完成按钮收尾', async () => {
  let result={...waitingFlow,stage:'retry',auto_check:false,message:'确认已过期，请重新检测',action:{id:'retry',label:'重试当前步骤'}};
  const {ui,element}=loadUi(()=>({status:'OK',data:result}));
  await ui.addAccount();
  assert.equal(element('flowIdentity').hidden,true);
  assert.equal(element('flowPrimary').textContent,'重试当前步骤');
  result={...waitingFlow,stage:'done',active:false,auto_check:false,message:'账号已保存并校验，词库导入未完成',sync_warning:true,action:{id:'finish',label:'完成'}};
  await ui.resumeLoginFlow();
  ui.detectCurrent=async()=>{};ui.loadRotationStatus=async()=>{};
  await ui.loginFlowAction();
  assert.match(element('operationMsg').textContent,/已保存并校验.*词库导入未完成/);
  assert.equal(element('addMask').classList.contains('on'),false);
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
