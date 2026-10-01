'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLoginFlow, createLoginFlowStore } = require('../lib/login-flow');

function fixture(overrides = {}) {
  let accounts = [
    { user_id: 'a', email: 'a@example.invalid', nickname: 'A', token: 'a-old' },
    { user_id: 'b', email: 'b@example.invalid', nickname: 'B', token: 'b-valid' },
  ];
  let current = { user_id: 'b', token: 'b-valid' }, clock = 1000, stored = null;
  const statuses = new Map([['a-old', 'expired']]);
  const calls = [], events = [];
  const deps = {
    store: { load: () => stored, save: value => { stored = structuredClone(value); } },
    readAccounts: () => accounts, hasSnapshot: () => true,
    connect: async () => { calls.push('connect'); },
    readSession: async () => current,
    openBrowser: async check => { check(current && { user_id: current.user_id, refresh_token: current.token }); calls.push('open'); },
    capture: async () => ({ ...current, email: current.user_id + '@example.invalid', snapshot: { fixture: Buffer.from('private-snapshot') } }),
    checkLogin: async account => {
      calls.push('check:' + account.token);
      const status = statuses.get(account.token) || 'valid';
      return { status, checked_at: new Date(clock).toISOString(), http_status: status === 'valid' ? 200 : status === 'expired' ? 401 : null,
        api_code: status === 'expired' ? 402 : null };
    },
    saveAccount: (candidate, nickname) => {
      calls.push('save:' + candidate.user_id);
      const existing = accounts.some(a => a.user_id === candidate.user_id);
      const account = { user_id: candidate.user_id, token: candidate.token, email: candidate.email, nickname: nickname || candidate.nickname || candidate.email };
      accounts = accounts.filter(a => a.user_id !== candidate.user_id).concat(account);
      return { account, existing };
    },
    importMaster: async () => { calls.push('import'); }, backupCurrent: () => { calls.push('backup'); },
    record: (event, fields) => events.push({ event, ...fields }), now: () => clock,
    ...overrides,
  };
  const flow = createLoginFlow(deps);
  return { flow, calls, events, deps, statuses,
    get accounts() { return accounts; }, get stored() { return stored; },
    setCurrent(value) { current = value; }, advance(ms) { clock += ms; },
    async act(action, extra = {}) { const v = flow.view(); return flow.act({ flow_id: v.flow_id, revision: v.revision, action, ...extra }); },
    async confirmA() {
      await flow.start('a'); await this.act('open_browser');
      current = { user_id: 'a', token: 'a-new' };
      return this.act('check');
    },
  };
}

test('恢复目标账号：拒绝跳步和错误身份，条件满足才确认保存，完成后检查其他账号', async () => {
  const f = fixture();
  assert.equal((await f.flow.start('a')).stage, 'login_required');
  await assert.rejects(f.act('save'), { code: 'LOGIN_FLOW_ACTION_INVALID' });
  assert.equal((await f.act('open_browser')).stage, 'waiting_login');
  f.setCurrent({ user_id: 'c', token: 'c-new' });
  assert.equal((await f.act('check')).reason, 'ACCOUNT_MISMATCH');
  assert.ok(!f.calls.some(c => c.startsWith('save:')));
  f.setCurrent({ user_id: 'a', token: 'a-new' });
  const confirmation = await f.act('check');
  assert.equal(confirmation.stage, 'confirm');
  assert.equal(confirmation.account.email, 'a@example.invalid');
  assert.doesNotMatch(JSON.stringify(confirmation), /a-new|a-old|b-valid|private-snapshot|expiresAt/);
  const done = await f.act('save');
  assert.equal(done.stage, 'done');
  assert.equal(done.active, false);
  assert.equal(f.accounts.find(a => a.user_id === 'a').token, 'a-new');
  assert.equal(f.calls.filter(c => c === 'save:a').length, 1);
  assert.equal(f.calls.includes('import'), false, '更新原账号不重复导入词库');
  assert.ok(f.events.every(e => e.flow_id === confirmation.flow_id));
  assert.equal(f.stored.active, false);
});

test('确认后同一账号换了会话，不能保存旧读取结果', async () => {
  const f = fixture();
  await f.confirmA();
  f.setCurrent({ user_id: 'a', token: 'a-changed' });
  const result = await f.act('save');
  assert.equal(result.reason, 'SESSION_CHANGED');
  assert.ok(!f.calls.includes('save:a'));
  assert.equal((await f.act('check')).stage, 'confirm');
  await f.act('save');
  assert.equal(f.accounts.find(a => a.user_id === 'a').token, 'a-changed');
});

test('确认后的文件变化或保存失败留在可重试步骤，旧记录不被报告为成功', async () => {
  for (const code of ['SNAPSHOT_CHANGED', 'DISK_FAILURE']) {
    const f = fixture({ saveAccount() { throw Object.assign(Error('fixture'), { code }); } });
    await f.confirmA();
    const result = await f.act('save');
    assert.equal(result.stage, 'retry');
    assert.equal(result.saved, false);
    assert.equal(f.accounts[0].token, 'a-old');
    assert.equal((await f.act('retry')).stage, 'confirm');
  }
});

test('初始状态和目标认证未知都要求重试检测，不要求重新登录', async () => {
  const f = fixture(); f.statuses.set('b-valid', 'unknown');
  const baseline = await f.flow.start('a');
  assert.equal(baseline.reason, 'BASELINE_UNKNOWN');
  assert.ok(!f.calls.includes('open'));
  f.statuses.set('b-valid', 'valid');
  assert.equal((await f.act('retry')).stage, 'login_required');
  await f.act('open_browser'); f.setCurrent({ user_id: 'a', token: 'a-new' }); f.statuses.set('a-new', 'unknown');
  const uncertain = await f.act('check');
  assert.equal(uncertain.stage, 'retry'); assert.equal(uncertain.reason, 'LOGIN_CHECK_UNKNOWN');
  f.statuses.set('a-new', 'valid'); assert.equal((await f.act('retry')).stage, 'confirm');
});

test('保存成功后的网络失败只重试结果校验，不重复写入或导入词库', async () => {
  // 通过可变校验结果，在保存回调后切换为 unknown。
  const g = fixture({
    checkLogin: async a => ({ status: a.token === 'a-old' ? 'expired' : a.token === 'a-new' && uncertain ? 'unknown' : 'valid' }),
    saveAccount: (candidate) => { writes++; uncertain = true; return { account: { user_id: candidate.user_id, token: candidate.token }, existing: true }; },
  });
  let writes = 0, uncertain = false;
  await g.confirmA();
  const pending = await g.act('save');
  assert.equal(pending.stage, 'retry'); assert.equal(pending.saved, true);
  uncertain = false;
  assert.equal((await g.act('retry')).stage, 'done');
  assert.equal(writes, 1);
});

test('其他原本有效账号在登录后或保存后失效时停止流程，不能继续保存/重试绕过', async () => {
  for (const afterSave of [false, true]) {
    let saved = false;
    const f = fixture({
      checkLogin: async a => ({ status: a.token === 'a-old' ? 'expired' : a.user_id === 'b' && shouldExpire ? 'expired' : 'valid' }),
      saveAccount: c => { saved = true; shouldExpire = true; return { account: c, existing: true }; },
    });
    let shouldExpire = false;
    await f.flow.start('a'); await f.act('open_browser'); f.setCurrent({ user_id: 'a', token: 'a-new' });
    if (!afterSave) shouldExpire = true;
    const checked = await f.act('check');
    const result = afterSave ? await f.act('save') : checked;
    assert.equal(result.stage, 'blocked'); assert.equal(result.changed_accounts[0].user_id, 'b');
    assert.equal(saved, afterSave);
    await assert.rejects(f.act('save'), { code: 'LOGIN_FLOW_ACTION_INVALID' });
    await assert.rejects(f.flow.start('b'), { code: 'LOGIN_FLOW_ACTIVE' });
    await f.act('cancel'); assert.equal(f.flow.isActive(), false);
  }
});

test('开始前当前会话未保存时，在同一流程内确认保护后继续原目标', async () => {
  const f = fixture(); f.setCurrent({ user_id: 'b', token: 'b-new' });
  const first = await f.flow.start('a');
  assert.equal(first.stage, 'protect_current'); assert.equal(first.target_id, 'a');
  const next = await f.act('save_current');
  assert.equal(next.stage, 'login_required'); assert.equal(next.target_id, 'a');
  assert.equal(f.accounts.find(a => a.user_id === 'b').token, 'b-new');
  assert.equal((await f.act('open_browser')).stage, 'waiting_login');
});

test('添加当前已经登录的新账号可直接确认；未收录的失效旧会话先备份', async () => {
  const f = fixture(); f.setCurrent({ user_id: 'c', token: 'c-new' });
  assert.equal((await f.flow.start()).stage, 'confirm');
  assert.equal((await f.act('save')).stage, 'done'); assert.equal(f.calls.filter(c => c === 'import').length, 1);
  const g = fixture(); g.setCurrent({ user_id: 'b', token: 'b-expired' }); g.statuses.set('b-expired', 'expired');
  assert.equal((await g.flow.start('a')).stage, 'login_required');
  assert.ok(g.calls.includes('backup'));
  assert.equal((await g.act('open_browser')).stage, 'waiting_login');
});

test('刷新页面可读取同一状态；旧版本点击、并行开始和重复保存均被拒绝', async () => {
  const f = fixture(); const old = await f.flow.start('a');
  assert.equal(f.flow.view().flow_id, old.flow_id);
  await f.act('open_browser');
  await assert.rejects(f.flow.act({ flow_id: old.flow_id, revision: old.revision, action: 'open_browser' }), { code: 'LOGIN_FLOW_CHANGED' });
  await assert.rejects(f.flow.start('b'), { code: 'LOGIN_FLOW_ACTIVE' });
  f.setCurrent({ user_id: 'a', token: 'a-new' }); await f.act('check');
  const before = f.flow.view();
  await f.act('save');
  await assert.rejects(f.flow.act({ flow_id: before.flow_id, revision: before.revision, action: 'save' }), { code: 'LOGIN_FLOW_CHANGED' });
  assert.equal(f.calls.filter(c => c.startsWith('save:')).length, 1);
});

test('确认超时要求重新检测，流程超时仍阻止轮动直到用户重新开始或结束', async () => {
  const f = fixture(); await f.confirmA(); f.advance(120001);
  assert.equal((await f.act('save')).reason, 'CAPTURE_EXPIRED');
  assert.ok(!f.calls.includes('save:a'));
  f.advance(30 * 60000); assert.equal(f.flow.view().stage, 'expired'); assert.equal(f.flow.isActive(), true);
  assert.equal((await f.act('restart')).stage, 'confirm');
});

test('管理器重启只恢复流程意图，要求重新检查，不复用确认结果或凭证', () => {
  const f = fixture();
  const restored = createLoginFlow({ ...f.deps, store: { load: () => ({ version: 1, active: true, target_id: 'a', flow_id: 'abcdabcdabcdabcd' }), save() {} } });
  assert.equal(restored.view().stage, 'interrupted');
  assert.equal(restored.isActive(), true); assert.equal(restored.view().action.id, 'restart');
  assert.equal(restored.view().account, null);
});

test('自动等待只读客户端会话，未变化时不重复请求认证服务', async () => {
  const f = fixture(); await f.flow.start('a'); await f.act('open_browser');
  const before = f.calls.length;
  for (let i = 0; i < 3; i++) await f.act('check', { automatic: true });
  assert.equal(f.calls.length, before);
});

test('磁盘流程记录只包含意图，私有权限；损坏记录不能当成没有进行中的流程', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-flow-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login-flow.json'), store = createLoginFlowStore(file);
  store.save({ version: 1, active: true, target_id: 'a', flow_id: 'abcdabcdabcdabcd' });
  assert.equal(store.load().target_id, 'a'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'broken');
  const f = fixture({ store }); assert.equal(f.flow.view().stage, 'interrupted'); assert.equal(f.flow.isActive(), true);
});

test('新账号词库导入期间会话改变时，不把已保存误报为恢复完成', async () => {
  const f = fixture({ importMaster: async () => f.setCurrent({ user_id: 'b', token: 'b-valid' }) });
  f.setCurrent({ user_id: 'c', token: 'c-new' });
  await f.flow.start();
  const result = await f.act('save');
  assert.equal(result.reason, 'SESSION_CHANGED');
  assert.equal(result.active, true); assert.equal(result.saved, true);
});

test('添加入口遇到未收录且已失效的当前会话，备份后允许重新打开登录', async () => {
  const f = fixture(); f.setCurrent({ user_id: 'c', token: 'c-expired' }); f.statuses.set('c-expired', 'expired');
  assert.equal((await f.flow.start()).stage, 'login_required');
  assert.ok(f.calls.includes('backup'));
  assert.equal((await f.act('open_browser')).stage, 'waiting_login');
  f.setCurrent(null);
  await f.act('check', { automatic: true });
  const revision = f.flow.view().revision;
  await f.act('check', { automatic: true });
  assert.equal(f.flow.view().revision, revision, '未登录且状态未变时不重复记录状态切换');
});

test('保护当前账号保存后会话变化，重试仍保留原来的恢复目标', async () => {
  const f = fixture({ saveAccount: candidate => {
    f.setCurrent({ user_id: 'c', token: 'c-new' });
    return { account: candidate, existing: true };
  } });
  f.setCurrent({ user_id: 'b', token: 'b-new' });
  assert.equal((await f.flow.start('a')).stage, 'protect_current');
  const result = await f.act('save_current');
  assert.equal(result.target_id, 'a');
  assert.equal(result.stage, 'retry');
  const next = await f.act('retry');
  assert.equal(next.target_id, 'a');
  assert.equal(next.stage, 'protect_current');
});
