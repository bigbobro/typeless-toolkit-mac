'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const rotationModule = require('../lib/account-rotation');

// 不加载 common，避免其运行数据初始化；所有账号、进程、通知和网络依赖均为假对象。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-rotation-integration-'));
const servers = [];
after(() => {
  for (const server of servers) server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function manager(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(root, 'manager-'));
  const accounts = (options.ids || ['a', 'b']).map(user_id => ({
    user_id, nickname: user_id, token: 'fixture-refresh-' + user_id,
  }));
  const calls = [], rotationResults = [], rotationErrors = [], timers = new Map(), recoveries = new Map(), events = new Map();
  let activeId = 'a', engine, handler, timerId = 0, failSave = false;
  const notifier = {
    confirm: async details => { calls.push(['confirm', details]); return 'later'; },
    guide: async details => { calls.push(['guide', details]); return 'later'; },
    notify: async details => { calls.push(['notify', details]); },
    cancel: () => { calls.push(['cancel']); },
    ...options.notifier,
  };
  const deps = {
    CODE_DIR: path.join(__dirname, '..'), ROOT: dataDir, config: { manager_port: 7788 },
    readAccounts: () => accounts,
    readCurrentLogin: () => ({ user_id: activeId }),
    ensureApp: async () => options.ensureApp ? options.ensureApp() : { state: 'connected' },
    readActiveAccountId: async () => options.readActiveAccountId ? options.readActiveAccountId(activeId) : activeId,
    readAccountUsage: async account => {
      calls.push(['usage', account.user_id]);
      if (options.onReadUsage) await options.onReadUsage(account);
      return { week_word_usage_value: account.user_id === 'a' ? 2000 : 0,
        week_word_usage_limit: 2000, ...options.usage?.[account.user_id] };
    },
    hasSnapshot: id => !options.missingSnapshots?.includes(id),
    curlApi: async (_method, _path, token) => {
      const id = accounts.find(account => account.token === token)?.user_id;
      calls.push(['refresh', id]);
      if (options.onRefresh) await options.onRefresh(id);
      if (options.refresh?.[id]) return options.refresh[id];
      return options.expired?.includes(id) ? { code: 402 } : { access_token: 'fixture-access' };
    },
    killTypeless: async () => { calls.push(['stop']); if (options.onStop) await options.onStop(); },
    sleep: async () => {},
    backupCurrentLogin: () => {
      const dir = fs.mkdtempSync(path.join(dataDir, 'recovery-'));
      recoveries.set(dir, activeId);
      return dir;
    },
    readLoginFiles: dir => ({ user_id: recoveries.get(dir) }),
    restoreLoginFiles: value => { activeId = value.user_id; calls.push(['rollback', activeId]); },
    restoreSnapshot: id => { activeId = id; calls.push(['restore', id]); },
    launchTypeless: () => { calls.push(['start']); },
    verifyCurrentLogin: async id => {
      calls.push(['verify', id]);
      if (options.failedLogin === id) throw new Error('目标账号登录校验失败');
      assert.equal(activeId, id);
    },
    syncAccount: async account => {
      calls.push(['sync', account.user_id]);
      if (options.syncFailure) throw new Error('词库请求失败');
    },
    log() {},
  };
  const server = {
    on(event, callback) { events.set(event, callback); return this; },
    listen(_port, _host, callback) { callback(); return this; },
    close() { events.get('close')?.(); },
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'manager.js'), 'utf8'), {
    require(name) {
      if (name === './lib/common') return deps;
      if (name === 'http') return { createServer(fn) { handler = fn; return server; } };
      if (name === './lib/rotation-notifier') return { createRotationNotifier: () => notifier };
      if (name === './lib/account-rotation') return {
        ...rotationModule,
        createRotationStore(file) {
          const store = rotationModule.createRotationStore(file);
          return { load: store.load, save(value) {
            if (failSave) throw new Error('测试数据目录不可写');
            store.save(value);
          } };
        },
        createAccountRotation(dependencies) {
          engine = rotationModule.createAccountRotation({ ...dependencies,
            async rotate(args) {
              try { const result = await dependencies.rotate(args); rotationResults.push(result); return result; }
              catch (error) { rotationErrors.push(error); throw error; }
            },
            setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
            clearTimer(id) { timers.delete(id); },
          });
          return engine;
        },
      };
      if (name === './lib/local-api-security') return {
        ...require('../lib/local-api-security'),
        createLocalApiSecurity: () => ({ assertApiRequest() {}, readJson: req => req.body }),
      };
      return require(name.startsWith('./lib/') ? '../' + name.slice(2) : name);
    },
    module: mod, console, process, Buffer, URL,
  });
  mod.exports.startServer();
  servers.push(server);
  return {
    dataDir, accounts, calls, rotationResults, rotationErrors, timers, engine,
    get activeId() { return activeId; },
    failSave(value) { failSave = value; },
    saved() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'rotation.json'), 'utf8')); },
    async run(method, url, body) {
      let status, result;
      await handler({ method, url, body, headers: { host: '127.0.0.1:7788' } }, {
        setHeader() {}, writeHead(code) { status = code; }, end(data) { result = JSON.parse(data); },
      });
      return { status, body: result };
    },
    async enable(mode = 'auto') {
      const result = await this.run('POST', '/api/rotation', { ...rotationModule.DEFAULT_ROTATION_SETTINGS, enabled: true, mode });
      assert.equal(result.status, 200);
    },
  };
}

test('轮动 API 默认关闭且不访问账号服务，设置持久化且返回值不含凭证', async () => {
  const m = manager();
  const initial = await m.run('GET', '/api/rotation');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.settings.enabled, false);
  assert.equal(m.timers.size, 0);
  await m.engine.check();
  assert.deepEqual(m.calls, []);

  await m.enable();
  assert.equal(m.saved().settings.mode, 'auto');
  assert.equal(m.timers.size, 1);
  const saved = await m.run('GET', '/api/rotation');
  const publicJson = JSON.stringify(saved.body);
  for (const account of m.accounts) assert.equal(publicJson.includes(account.token), false);
  assert.equal(publicJson.includes('access_token'), false);
  assert.equal(fs.statSync(path.join(m.dataDir, 'rotation.json')).mode & 0o777, 0o600);

  const restarted = manager({ dataDir: m.dataDir });
  const loaded = await restarted.run('GET', '/api/rotation');
  assert.deepEqual(loaded.body.data.settings, saved.body.data.settings);
  assert.equal(restarted.timers.size, 1);
  assert.deepEqual(restarted.calls, []);
});

test('断连后通过连接入口恢复，状态等待复查且成功检查替换旧失败结果', async () => {
  let connected = true;
  const m = manager({
    usage: { a: { week_word_usage_value: 186 } },
    readActiveAccountId: async id => {
      if (!connected) throw Object.assign(new Error('offline'), { code: 'CONNECTION_REQUIRED' });
      return id;
    },
    ensureApp: async () => { connected = true; return { state: 'connected' }; },
  });
  await m.enable('notify');
  await m.engine.check();
  connected = false;
  await m.engine.check();
  assert.equal(m.engine.view().status.phase, 'error');
  assert.match(m.engine.view().status.last_result, /管理连接不可用/);

  const reconnected = await m.run('POST', '/api/launch');
  assert.equal(reconnected.status, 200);
  const pending = (await m.run('GET', '/api/rotation')).body.data.status;
  assert.equal(pending.phase, 'waiting');
  assert.equal(pending.issue, null);
  assert.match(pending.message, /等待重新检查/);
  assert.equal(m.timers.size, 1);
  assert.equal([...m.timers.values()][0].delay, 15 * 60000);
  assert.equal(m.calls.filter(([name]) => name === 'usage').length, 1, '读取状态不立即检查用量');

  const [timerId, timer] = [...m.timers][0];
  m.timers.delete(timerId);
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  const recovered = (await m.run('GET', '/api/rotation')).body.data.status;
  assert.equal(recovered.phase, 'waiting');
  assert.equal(recovered.used_words, 186);
  assert.equal(recovered.issue, null);
  assert.match(recovered.last_result, /本次检查成功/);
  assert.doesNotMatch(recovered.last_result, /管理连接不可用/);
  assert.equal(m.saved().last_result, recovered.last_result);
  assert.equal(m.calls.filter(([name]) => name === 'usage').length, 2);
  assert.equal(m.calls.some(([name]) => ['confirm', 'stop', 'restore'].includes(name)), false);
  assert.equal(m.timers.size, 1);
});

test('无效设置及存储错误返回失败，并保留已生效设置和唯一计时器', async () => {
  const m = manager();
  await m.enable();
  const previous = m.saved();
  const invalid = await m.run('POST', '/api/rotation', { ...previous.settings, word_threshold: 0 });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'ROTATION_SETTINGS_FAILED');
  assert.deepEqual(m.saved(), previous);
  m.failSave(true);
  const failed = await m.run('POST', '/api/rotation', { ...previous.settings, interval_minutes: 30 });
  assert.equal(failed.status, 400);
  assert.match(failed.body.msg, /不可写/);
  assert.deepEqual(m.engine.view().settings, previous.settings);
  assert.deepEqual(m.saved(), previous);
  assert.equal(m.timers.size, 1);
});

test('自动轮动按保存顺序跳过缺快照、额度已满和凭证失效账号，找到可用账号即停止', async () => {
  const m = manager({ ids: ['a', 'missing', 'full', 'expired', 'ready', 'later'],
    missingSnapshots: ['missing'], expired: ['expired'],
    usage: { full: { week_word_usage_value: 1999, week_word_usage_limit: 1999 } },
  });
  await m.enable();
  await m.engine.check();
  assert.equal(m.activeId, 'ready');
  assert.deepEqual(m.calls.filter(call => call[0] === 'usage').map(call => call[1]), ['a', 'a', 'full', 'expired', 'ready']);
  assert.deepEqual(m.calls.filter(call => call[0] === 'refresh').map(call => call[1]), ['expired', 'ready']);
  assert.deepEqual(m.calls.filter(call => call[0] === 'restore'), [['restore', 'ready']]);
  assert.deepEqual(m.calls.filter(call => call[0] === 'sync'), [['sync', 'ready']]);
  assert.equal(m.engine.view().status.current_user_id, 'ready');
  const result = m.rotationResults[0];
  assert.equal(result.switched, true);
  assert.match(result.message, /^已切换到「ready」/);
  assert.deepEqual(Array.from(result.issues, issue => [issue.account_id, issue.code]), [
    ['missing', 'SNAPSHOT_INVALID'], ['full', 'ACCOUNT_QUOTA_EXHAUSTED'], ['expired', 'ACCOUNT_LOGIN_EXPIRED'],
  ]);
  assert.equal(m.timers.size, 1);
});

test('候选混合失败保留每账号原因，临时请求失败允许下周期重试且不暴露凭证', async () => {
  let offline = true;
  const m = manager({ ids: ['a', 'missing', 'full', 'expired', 'network'],
    missingSnapshots: ['missing'], expired: ['expired'],
    usage: { full: { week_word_usage_value: 2000 } },
    onReadUsage: async account => { if (account.user_id === 'network' && offline) throw new Error('fixture-refresh-network'); },
  });
  await m.enable();
  await m.engine.check();
  const result = m.rotationResults[0];
  assert.equal(result.switched, false);
  assert.equal(result.retryable, true);
  assert.equal(result.issue.code, 'NO_AVAILABLE_ACCOUNTS');
  assert.equal(result.issue.action, 'accounts');
  assert.deepEqual(Array.from(result.issues, issue => [issue.account_id, issue.code]), [
    ['missing', 'SNAPSHOT_INVALID'], ['full', 'ACCOUNT_QUOTA_EXHAUSTED'],
    ['expired', 'ACCOUNT_LOGIN_EXPIRED'], ['network', 'REQUEST_FAILED'],
  ]);
  assert.equal(m.calls.some(call => call[0] === 'stop'), false);
  for (const account of m.accounts) assert.equal(JSON.stringify(result).includes(account.token), false);
  offline = false;
  await m.engine.check();
  assert.equal(m.activeId, 'network');
});

test('候选认证暂时失败与明确过期分别保留重试和更新登录动作，无第二账号则引导添加', async () => {
  for (const [options, expected] of [
    [{ refresh: { b: { code: 401 } } }, ['AUTH_RETRY_REQUIRED', 'accounts', true]],
    [{ expired: ['b'] }, ['ACCOUNT_LOGIN_EXPIRED', 'update-login', false]],
    [{ ids: ['a'] }, ['NO_CANDIDATES', 'add-account', false]],
  ]) {
    const m = manager(options);
    await m.enable();
    await m.engine.check();
    const result = m.rotationResults[0];
    assert.deepEqual([result.issue.code, result.issue.action, result.retryable], expected);
    assert.equal(m.calls.some(call => call[0] === 'stop'), false);
  }
});

test('人工切号占用互斥时后台不查用量，自动切号占用互斥时人工写请求被拒绝', async () => {
  const manualEntered = deferred(), releaseManual = deferred();
  const manual = manager({ onRefresh: async () => { manualEntered.resolve(); await releaseManual.promise; } });
  await manual.enable();
  const manualWork = manual.run('POST', '/api/accounts/b/switch');
  await manualEntered.promise;
  await manual.engine.check();
  assert.equal(manual.calls.some(call => call[0] === 'usage'), false);
  const conflict = await manual.run('POST', '/api/accounts/a/switch');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'OPERATION_BUSY');
  releaseManual.resolve();
  assert.equal((await manualWork).status, 200);

  const autoEntered = deferred(), releaseAuto = deferred();
  const auto = manager({ onStop: async () => { autoEntered.resolve(); await releaseAuto.promise; } });
  await auto.enable();
  const autoWork = auto.engine.check();
  await autoEntered.promise;
  const rejected = await auto.run('POST', '/api/accounts/a/switch');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'OPERATION_BUSY');
  releaseAuto.resolve();
  await autoWork;
  assert.equal(auto.activeId, 'b');
  assert.equal(auto.calls.filter(call => call[0] === 'stop').length, 1);
});

test('确认框未完成时人工切号或关闭轮动都会作废之后到达的同意结果', async () => {
  for (const action of ['manual', 'disable']) {
    const entered = deferred(), accepted = deferred();
    const m = manager({ notifier: { confirm: async () => { entered.resolve(); return accepted.promise; } } });
    await m.enable('notify');
    const check = m.engine.check();
    await entered.promise;
    const cancels = m.calls.filter(call => call[0] === 'cancel').length;
    const result = action === 'manual'
      ? await m.run('POST', '/api/accounts/b/switch')
      : await m.run('POST', '/api/rotation', { ...rotationModule.DEFAULT_ROTATION_SETTINGS, enabled: false });
    assert.equal(result.status, 200);
    assert.equal(m.calls.filter(call => call[0] === 'cancel').length, cancels + 1);
    // 模拟取消与用户确认交错：即使旧提示最终返回 switch，也不能再执行轮动。
    accepted.resolve('switch');
    await check;
    assert.equal(m.calls.filter(call => call[0] === 'stop').length, action === 'manual' ? 1 : 0);
    assert.equal(m.calls.some(call => call[0] === 'sync'), false);
    if (action === 'disable') {
      assert.equal(m.engine.view().status.phase, 'disabled');
      assert.equal(m.timers.size, 0);
    }
  }
});

test('切号前身份复核等待期间停止调度，即使读回同一账号也不能关闭应用', async () => {
  const entered = deferred(), readIdentity = deferred();
  let reads = 0;
  const m = manager({ readActiveAccountId: async id => {
    // 第一次是 scheduler，第二次是 rotate 入口，第三次是 beforeSwitch。
    if (++reads === 3) { entered.resolve(); return readIdentity.promise; }
    return id;
  } });
  await m.enable();
  const check = m.engine.check();
  await entered.promise;
  m.engine.stop();
  readIdentity.resolve('a');
  await check;
  assert.equal(reads, 3);
  assert.equal(m.calls.some(call => call[0] === 'stop' || call[0] === 'restore'), false);
  assert.equal(m.activeId, 'a');
  assert.equal(m.timers.size, 0);
});

test('切号前用量复查或最后身份读取失败只重试，不关闭应用、不暂停调度', async () => {
  for (const failure of ['usage', 'identity']) {
    let reads = 0;
    const options = failure === 'usage'
      ? { onReadUsage: async () => { if (++reads === 2) throw new Error('用量复查暂时断网'); } }
      : { readActiveAccountId: async id => {
        if (++reads === 3) throw new Error('身份读取暂时失败');
        return id;
      } };
    const m = manager(options);
    await m.enable();
    await m.engine.check();
    assert.equal(m.activeId, 'a');
    assert.equal(m.calls.some(call => call[0] === 'stop' || call[0] === 'restore'), false);
    assert.equal(m.engine.view().status.phase, 'waiting');
    assert.match(m.engine.view().status.last_result, /切号前检查未完成.*下次检查重试/);
    assert.equal(m.saved().paused, false);
    assert.equal(m.timers.size, 1);
    assert.equal([...m.timers.values()][0].delay, 15 * 60000);

    // 读服务恢复后无需重新保存设置，下一轮即可重新检查并切号。
    await m.engine.check();
    assert.equal(m.activeId, 'b');
    assert.equal(m.calls.filter(call => call[0] === 'stop').length, 1);
  }
});

test('最后身份复核发现用户已换号是普通取消，不伪装为需恢复的账号问题', async () => {
  let reads = 0;
  const m = manager({ readActiveAccountId: async id => ++reads === 3 ? 'another' : id });
  await m.enable();
  await m.engine.check();
  const result = m.rotationResults[0];
  assert.equal(result.switched, false);
  assert.equal(result.issue, undefined);
  assert.equal(result.issues, undefined);
  assert.equal(m.calls.some(call => call[0] === 'stop'), false);
});

test('同意后预检读取失败不保留旧同意，下轮重新确认选择稍后便不切号', async () => {
  let usageReads = 0, prompts = 0;
  const m = manager({
    onReadUsage: async () => { if (++usageReads === 2) throw new Error('用量复查暂时失败'); },
    notifier: { confirm: async () => ++prompts === 1 ? 'switch' : 'later' },
  });
  await m.enable('notify');
  await m.engine.check();
  assert.equal(prompts, 1);
  assert.equal(m.saved().accounts.find(account => account.user_id === 'a').reminded, false);
  assert.equal(m.saved().paused, false);
  assert.equal(m.timers.size, 1);
  assert.equal(m.calls.some(call => call[0] === 'stop'), false);

  await m.engine.check();
  assert.equal(prompts, 2);
  assert.equal(m.activeId, 'a');
  assert.equal(m.calls.some(call => call[0] === 'stop' || call[0] === 'restore'), false);
  assert.equal(m.saved().accounts.find(account => account.user_id === 'a').reminded, true);
  await m.engine.check();
  assert.equal(prompts, 2);
  assert.equal(m.activeId, 'a');
});

test('永久候选问题只引导一次，账号修复并invalidate后重新确认并恢复轮动', async () => {
  let prompts = 0;
  const missing = ['b'];
  const m = manager({ missingSnapshots: missing,
    notifier: { confirm: async () => { prompts++; return 'switch'; } },
  });
  await m.enable('notify');
  await m.engine.check();
  assert.equal(m.engine.view().status.issue.code, 'SNAPSHOT_INVALID');
  assert.equal(m.saved().accounts.find(account => account.user_id === 'a').reminded, true);
  assert.equal(prompts, 1);
  assert.equal(m.calls.filter(call => call[0] === 'guide').length, 1);
  await m.engine.check();
  assert.equal(prompts, 1);
  assert.equal(m.calls.filter(call => call[0] === 'guide').length, 1);
  assert.equal(m.activeId, 'a');

  missing.length = 0;
  m.engine.invalidate();
  await m.engine.check();
  assert.equal(prompts, 2);
  assert.equal(m.activeId, 'b');
  assert.equal(m.engine.view().status.issue, null);
  assert.equal(m.calls.filter(call => call[0] === 'stop').length, 1);
});

test('自动切号登录校验失败恢复原账号并暂停，后续检查不重试破坏性事务', async () => {
  const m = manager({ failedLogin: 'b' });
  await m.enable();
  await m.engine.check();
  assert.equal(m.activeId, 'a');
  assert.deepEqual(m.calls.filter(call => call[0] === 'verify'), [['verify', 'b'], ['verify', 'a']]);
  assert.deepEqual(m.calls.filter(call => call[0] === 'rollback'), [['rollback', 'a']]);
  assert.equal(m.rotationErrors[0].issue.code, 'SWITCH_ROLLED_BACK');
  assert.equal(m.rotationErrors[0].issue.account_id, 'b');
  assert.equal(m.rotationErrors[0].issue.action, 'update-login');
  assert.equal(m.engine.view().status.phase, 'paused');
  assert.match(m.engine.view().status.last_result, /已恢复切换前/);
  assert.equal(m.saved().paused, true);
  assert.equal(m.timers.size, 0);
  const calls = m.calls.length;
  await m.engine.check();
  assert.equal(m.calls.length, calls);
});

test('词库同步失败保留切号成功，明确提示可重试同步而不回滚账号', async () => {
  const m = manager({ syncFailure: true });
  await m.enable();
  await m.engine.check();
  assert.equal(m.activeId, 'b');
  const status = m.engine.view().status;
  assert.equal(status.phase, 'waiting');
  assert.equal(status.current_user_id, 'b');
  assert.match(status.last_result, /已切换到「b」.*词库同步未完成/);
  assert.equal(m.calls.some(call => call[0] === 'rollback'), false);
  assert.equal(m.saved().paused, false);
  const notices = m.calls.filter(call => call[0] === 'notify');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1].title, 'Typeless 账号已切换');
});
