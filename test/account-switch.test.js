'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-switch-'));
process.env.TYPELESS_DATA_DIR = root;
process.env.TYPELESS_USER_DATA_DIR = path.join(root, 'live');
const common = require('../lib/common');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function manager(refresh, verified = true, overrides = {}) {
  const calls = [];
  let handler;
  let accounts = [{ user_id: 'target', nickname: '旧昵称', token: 'saved-refresh', added_at: 'original-date' }];
  const deps = {
    ...common,
    readAccounts: () => accounts,
    writeAccounts: (value) => { accounts = value; },
    liveStatus: async () => ({ token_valid: true }),
    captureTokenCDP: async () => ({ user_id: 'target', token: 'new-refresh', nickname: '新昵称', email: 'test@example.com', role: 'free' }),
    readCurrentLogin: () => ({ user_id: 'target' }),
    saveAccountWithSnapshot: (value) => { accounts = value; calls.push(['snapshot']); },
    backupCurrentLogin: () => fs.mkdtempSync(path.join(root, 'recovery-')),
    readLoginFiles: () => ({ 'user-data.json': Buffer.from('previous') }),
    restoreLoginFiles: () => { calls.push(['rollback']); },
    hasSnapshot: () => true,
    curlApi: async (...args) => { calls.push(['refresh', ...args]); return refresh; },
    killTypeless: async () => { calls.push(['stop']); },
    sleep: async () => {},
    restoreSnapshot: () => { calls.push(['restore']); },
    launchTypeless: () => { calls.push(['start']); },
    verifyCurrentLogin: async (id) => {
      calls.push(['verify', id]);
      if (!verified && calls.filter(c=>c[0]==='verify').length===1) throw new Error('Typeless 未能登录目标账号');
    },
    ...overrides,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'manager.js'), 'utf8'), {
    require: (name) => {
      if (name === './lib/common') return deps;
      if (name === 'http') return { createServer(fn) { handler = fn; return { on() {} }; } };
      if (name === './lib/local-api-security') {
        return { ...require('../lib/local-api-security'), createLocalApiSecurity: () => ({ assertApiRequest() {}, readJson: req => req.body }) };
      }
      return require(name);
    },
    module: { exports: {} }, console, process, Buffer, URL,
  });
  return {
    calls,
    get accounts() { return accounts; },
    async run(method = 'POST', url = '/api/accounts/target/switch', body) {
      let status, result;
      await handler({ method, url, body, headers: { host: '127.0.0.1:7788' } }, {
        setHeader() {}, writeHead(code) { status = code; }, end(data) { result = JSON.parse(data); },
      });
      return { status, body: result };
    },
  };
}

test('列表区分服务器拒绝的登录凭证和网络异常,不依赖资料接口或 JWT 剩余天数', async () => {
  for (const [response, expected] of [[{ code: 402 }, 'expired'], [{ access_token: 'access' }, 'valid'], [{ _error: 'non-json' }, 'unknown']]) {
    const m = manager(response);
    const result = await m.run('GET', '/api/accounts');
    assert.equal(result.body.data[0].login_status, expected);
    assert.ok(!JSON.stringify(result.body).includes('saved-refresh'));
  }
});

test('重新添加同一个账号会更新原记录和快照,保留最初添加时间', async () => {
  const m = manager({ access_token: 'access' });
  const captured = await m.run('POST', '/api/capture');
  const result = await m.run('POST', '/api/accounts', { capture_id: captured.body.data.capture_id, expected_user_id: 'target' });
  assert.equal(result.body.status, 'OK');
  assert.equal(m.accounts.length, 1);
  assert.equal(m.accounts[0].token, 'new-refresh');
  assert.equal(m.accounts[0].added_at, 'original-date');
  assert.ok(m.calls.some(c => c[0] === 'snapshot'));
});

test('恢复指定账号时不能误保存另一个账号;移除后列表不再显示', async () => {
  const m = manager({ access_token: 'access' });
  const captured = await m.run('POST', '/api/capture');
  const result = await m.run('POST', '/api/accounts', { capture_id: captured.body.data.capture_id, expected_user_id: 'other' });
  assert.equal(result.body.status, 'FAIL');
  assert.equal(m.accounts[0].token, 'saved-refresh');
  assert.ok(!m.calls.some(c => c[0] === 'snapshot'));
  await m.run('DELETE', '/api/accounts/target');
  const list = await m.run('GET', '/api/accounts');
  assert.deepEqual(list.body.data, []);
});

test('刷新凭证失效时切号失败,不能关闭应用或覆盖登录态', async () => {
  const m = manager({ status: 'FAIL', code: 402, detail: 'Invalid refresh token.' });
  const result = await m.run();
  assert.equal(result.body.status, 'FAIL');
  assert.match(result.body.msg, /重新登录/);
  assert.deepEqual(m.calls.map(c => c[0]), ['refresh']);
});

test('网络或异常刷新响应不能继续切号', async () => {
  for (const response of [{ _error: 'non-json' }, null, {}]) {
    const m = manager(response);
    const result = await m.run();
    assert.equal(result.body.status, 'FAIL');
    assert.match(result.body.msg, /无法验证/);
    assert.deepEqual(m.calls.map(c => c[0]), ['refresh']);
  }
});

test('应用登录校验读取主进程身份和访问令牌,不会把其他账号或空登录态算成功', async () => {
  const ipcCalls = [];
  let user = null, token = null;
  class Socket {
    constructor() { queueMicrotask(() => this.onopen()); }
    close() {}
    async send(raw) {
      const request = JSON.parse(raw);
      if (request.method !== 'Runtime.evaluate') {
        this.onmessage({ data: JSON.stringify({ id: request.id, result: { identifier: 'script' } }) });
        return;
      }
      const value = await vm.runInNewContext(request.params.expression, {
        window: { ipcRenderer: { invoke: async (channel) => {
          ipcCalls.push(channel);
          if (channel === 'auth:get-current') return user;
          if (channel === 'auth:get-access-token') return token;
          assert.fail('登录校验不得调用其他 IPC');
        } } },
      });
      this.onmessage({ data: JSON.stringify({ id: request.id, result: { result: { value } } }) });
    }
  }
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib/cdp.js'), 'utf8'), {
    module: mod, require: name => name === 'ws' ? Socket : require(name),
    URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/json/version') ? { 'User-Agent': 'Typeless/2.5.0' } : [{
      title: 'Typeless', type: 'page', url: 'file:///test/app.asar/dist/renderer/hub.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/test',
    }] }),
  });
  const cdp = mod.exports.createCdp({
    cdpPort: 9333, asarPath: '/test/app.asar', sleep: async () => {},
    apiBase: 'https://api.typeless.com', curlApi: async () => ({ data: {} }),
    decodeJwtPayload: common.decodeJwtPayload, accountMetaFromUserInfo: common.accountMetaFromUserInfo,
  });
  await assert.rejects(cdp.verifyCurrentLogin('target'), /未能登录/);
  user = { user_id: 'other' }; token = 'access';
  await assert.rejects(cdp.verifyCurrentLogin('target'), /未能登录/);
  user = { user_id: 'target' }; token = null;
  await assert.rejects(cdp.verifyCurrentLogin('target'), /未能登录/);
  token = 'access';
  await assert.doesNotReject(cdp.verifyCurrentLogin('target'));
  assert.equal(ipcCalls.length, 8);
  user = { user_id: 'target', refresh_token: 'new-refresh' };
  const captured = await cdp.captureTokenCDP();
  assert.equal(captured.token, 'new-refresh', '重新添加必须保存主进程的刷新凭证');
  assert.equal(captured.user_id, 'target');
});

test('恢复快照后应用仍未登录时不能报告成功', async () => {
  const m = manager({ access_token: 'fresh-access' }, false);
  const result = await m.run();
  assert.equal(result.body.status, 'FAIL');
  assert.match(result.body.msg, /未能登录/);
});

test('仅在刷新成功且应用确认目标登录后返回切号成功', async () => {
  const m = manager({ access_token: 'fresh-access' });
  const result = await m.run();
  assert.equal(result.body.status, 'OK');
  assert.deepEqual(m.calls.map(c => c[0]), ['refresh', 'stop', 'restore', 'start', 'verify']);
  assert.equal(m.calls[0][1], 'POST');
  assert.equal(m.calls[0][2], '/oauth/refresh_access_token');
  assert.equal(m.calls[0][4].app, 'typeless_webapp');
});


test('切换后登录校验失败会恢复之前的登录态并明确返回失败', async () => {
  const m = manager({ access_token: 'access' }, false);
  const result = await m.run();
  assert.equal(result.body.status, 'FAIL');
  assert.equal(result.body.code, 'SWITCH_ROLLED_BACK');
  assert.ok(m.calls.some(c=>c[0]==='rollback'));
  assert.match(result.body.msg, /已恢复/);
});

test('已删除单独写快照入口,不能把当前账号写入另一个账号', async () => {
  const m = manager({ access_token:'access' });
  const result = await m.run('POST','/api/accounts/other/snapshot');
  assert.equal(result.status,404);
  assert.ok(!m.calls.some(c=>c[0]==='snapshot'));
});

test('账号或快照保存失败不会提前覆盖旧账号记录', async () => {
  const m=manager({ access_token:'access' },true,{ saveAccountWithSnapshot:()=>{throw new Error('磁盘写入失败');} });
  const captured=await m.run('POST','/api/capture');
  const r=await m.run('POST','/api/accounts',{ capture_id:captured.body.data.capture_id });
  assert.equal(r.body.status,'FAIL');
  assert.equal(m.accounts[0].token,'saved-refresh');
});

test('切换等待验证期间拒绝另一项写操作,完成后解除互斥', async () => {
  let release, entered;
  const started=new Promise(r=>entered=r);
  const wait=new Promise(r=>release=r);
  const m=manager({},true,{curlApi:async()=>{entered();await wait;return {access_token:'access'};}});
  const switching=m.run(); await started;
  const deletion=await m.run('DELETE','/api/accounts/target');
  release(); await switching;
  assert.equal(deletion.status,409);
  assert.equal(m.accounts.length,1);
  const after=await m.run('DELETE','/api/accounts/target');
  assert.equal(after.body.status,'OK');
});


test('全部同步一次就让前后账号都获得并集,读取失败账号单独报告',async()=>{
  const words={a:['Alpha'],b:['Beta']}; let master=[];
  const m=manager({},true,{
    readAccounts:()=>[{user_id:'a',token:'a'},{user_id:'b',token:'b'},{user_id:'broken',token:'broken'}],
    readMaster:()=>master,
    writeMaster:terms=>master=[...new Set(terms)],
    listDictionary:async token=>{if(token==='broken')throw Error('读取失败');return {words:words[token].map(term=>({term}))};},
    importMissingTerms:async(token,terms)=>{words[token].push(...terms);return terms.length;},
    syncAccount:async a=>{if(a.token==='broken')throw Error('读取失败');master=[...new Set([...master,...words[a.token]])];words[a.token]=[...master];return {};},
  });
  const r=await m.run('POST','/api/sync-all');
  assert.deepEqual([...words.a].sort(),['Alpha','Beta']);
  assert.deepEqual([...words.b].sort(),['Alpha','Beta']);
  assert.match(r.body.data.find(a=>a.user_id==='broken').error,/读取失败/);
});


test('重新读取到的刷新凭证仍已失效时不能报告更新完成或覆盖原记录',async()=>{
  const m=manager({code:402});
  const captured=await m.run('POST','/api/capture');
  const r=await m.run('POST','/api/accounts',{capture_id:captured.body.data.capture_id});
  assert.equal(r.body.code,'ACCOUNT_LOGIN_EXPIRED');
  assert.equal(m.accounts[0].token,'saved-refresh');
  assert.ok(!m.calls.some(c=>c[0]==='snapshot'));
});
