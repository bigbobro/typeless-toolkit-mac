'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { writePrivateJson } = require('./private-fs');
const { LocalApiError } = require('./local-api-security');

// 只持久化未完成的流程意图。凭证、待确认快照和旧校验结果不能跨重启复用。
function createLoginFlowStore(file) {
  return {
    load() {
      if (!fs.existsSync(file)) return null;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error('Invalid flow record');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.version !== 1 || typeof value.active !== 'boolean') throw Error('Invalid flow record');
      if (!value.active) return null;
      if (!/^[a-f0-9]{16}$/.test(value.flow_id)
          || (value.target_id !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.target_id))) throw Error('Invalid flow record');
      return value;
    },
    save(value) { writePrivateJson(file, value); },
  };
}

const sameSession = (a, b) => Boolean(a?.user_id && a?.token && a.user_id === b?.user_id && a.token === b?.token);
const accountView = a => a ? { user_id: a.user_id, nickname: a.nickname || '', email: a.email || '', role: a.role || '' } : null;
const closed = new Set(['done', 'cancelled']);
const TTL = 30 * 60 * 1000;
const CONFIRM_TTL = 2 * 60 * 1000;

// 唯一的登录流程所有者。页面只提交当前步骤允许的动作，不能自行声明“已登录”。
function createLoginFlow({ store, readAccounts, hasSnapshot, connect, readSession, openBrowser,
  capture, checkLogin, saveAccount, importMaster, backupCurrent, record = () => {}, bindLog = () => {}, now = Date.now }) {
  let flow = null, busy = false;
  const emit = (event, fields = {}) => record(event, { flow_id: flow.id, ...fields });
  function state(stage, message, action, reason, step = flow.step) {
    const previous = flow.stage;
    flow.stage = stage; flow.message = message; flow.action = action; flow.reason = reason; flow.step = step;
    flow.revision++;
    emit('flow_state', { stage, previous_stage: previous, reason });
  }
  function marker(active) {
    store.save({ version: 1, active, flow_id: flow.id, target_id: flow.targetId });
  }
  function fresh(targetId, id = crypto.randomBytes(8).toString('hex')) {
    return { id, targetId, revision: 0, stage: 'preparing', step: 1, message: '正在检查当前状态…',
      action: null, reason: null, deadline: now() + TTL, baseline: [], checks: new Map(),
      candidate: null, pending: null, observed: null, lastRejected: null, lastLoggedSession: undefined,
      changed: [], saved: false, syncWarning: false, retry: 'prepare', expiredBackup: null };
  }
  try {
    const previous = store.load();
    if (previous) {
      flow = fresh(previous.target_id, previous.flow_id);
      // 旧页面的 revision 不能在重启后碰巧匹配。
      flow.revision = crypto.randomInt(1000000, 1000000000);
      state('interrupted', '管理器已重启，上一轮流程尚未完成。需要重新检查当前状态，旧的确认结果不会继续用于保存。',
        { id: 'restart', label: '重新检查当前状态' }, 'MANAGER_RESTARTED', 1);
    }
  } catch (_) {
    flow = fresh(null);
    state('interrupted', '上次流程记录无法读取。请重新检查当前状态；本次不会直接保存账号。',
      { id: 'restart', label: '重新检查当前状态' }, 'FLOW_RECORD_UNREADABLE', 1);
  }
  function expire() {
    if (!busy && flow && !closed.has(flow.stage) && !['expired', 'interrupted'].includes(flow.stage) && now() > flow.deadline) {
      flow.candidate = null; flow.pending = null;
      state('expired', '本次登录流程已超过 30 分钟。请重新检查当前状态后继续，已保存的账号不会删除。',
        { id: 'restart', label: '重新检查当前状态' }, 'FLOW_EXPIRED', 1);
    }
  }
  function isActive() { expire(); return Boolean(flow && !closed.has(flow.stage)); }
  function view() {
    expire();
    if (!flow) return { active: false, stage: 'idle', busy: false };
    const accounts = readAccounts();
    return { flow_id: flow.id, revision: flow.revision, active: !closed.has(flow.stage), busy,
      stage: flow.stage, step: flow.step, message: flow.message, reason: flow.reason,
      action: busy ? null : flow.action, target: accountView(accounts.find(a => a.user_id === flow.targetId)),
      target_id: flow.targetId, account: accountView(flow.candidate || flow.observed),
      changed_accounts: flow.changed.map(accountView), saved: flow.saved, sync_warning: flow.syncWarning,
      auto_check: !busy && flow.stage === 'waiting_login',
      can_reopen_browser: !busy && flow.stage === 'waiting_login' };
  }
  function retry(message, next, reason, step = flow.step) {
    flow.retry = next;
    state('retry', message, { id: 'retry', label: next === 'verify' ? '重试结果校验' : '重试当前步骤' }, reason, step);
  }
  async function session() {
    try {
      const current = await readSession();
      if (flow.lastLoggedSession === undefined || (current ? !sameSession(flow.lastLoggedSession, current) : Boolean(flow.lastLoggedSession))) {
        emit('login_current', { account_id: current?.user_id, credential: current?.token, has_current: Boolean(current) });
        flow.lastLoggedSession = current;
      }
      return current;
    }
    catch (_) { retry('管理连接中断，暂时无法检测 Typeless 的实际登录状态。重试会先恢复连接。', 'prepare', 'CONNECTION_REQUIRED'); return undefined; }
  }
  async function check(account) {
    const result = await checkLogin(account);
    flow.checks.set(account.user_id, { token: account.token, check: result });
    return result.status;
  }
  // 只比较本轮开始时确认有效的其他账号；网络未知不能被当作新增失效。
  async function checkOthers(exceptId) {
    const changed = [], unknown = [];
    for (const account of flow.baseline) {
      if (account.user_id === exceptId || account.status !== 'valid') continue;
      const status = await check(account);
      if (status === 'expired') changed.push(account);
      else if (status !== 'valid') unknown.push(account);
    }
    if (changed.length) {
      flow.changed = changed;
      for (const account of changed) emit('flow_account_changed', { account_id: account.user_id, outcome: 'expired' });
      state('blocked', '检测到其他原本有效的账号新增失效，已停止后续恢复。请导出日志，保留报错截图并反馈。',
        { id: 'export_log', label: '导出排查日志' }, 'OTHER_ACCOUNTS_EXPIRED', 4);
      return false;
    }
    if (unknown.length) {
      retry(flow.saved ? '账号已保存，但其他账号的状态暂时无法确认。请重试校验，不需要再次保存。'
        : '暂时无法确认其他账号是否仍然有效。请检查网络后重试，本次尚未保存目标账号。',
      flow.pending ? 'verify' : 'inspect', 'OTHER_ACCOUNTS_UNKNOWN', flow.saved ? 4 : 2);
      return false;
    }
    return true;
  }
  function loginRequired(reason = 'LOGIN_REQUIRED', message = '已完成准备。请打开官方登录页，登录要添加或恢复的账号。') {
    flow.candidate = null;
    state('login_required', message, { id: 'open_browser', label: '打开官方登录页' }, reason, 2);
  }
  function waitForLogin(current, reason = 'WAITING_FOR_LOGIN') {
    flow.observed = current ? { ...readAccounts().find(a => a.user_id === current.user_id), user_id: current.user_id } : null;
    const target = readAccounts().find(a => a.user_id === flow.targetId);
    const label = flow.observed?.email || flow.observed?.nickname || (current ? '另一个账号' : '未登录');
    const message = target
      ? `正在等待「${target.email || target.nickname}」登录。当前检测到：${label}。完成网页登录并允许返回 Typeless 后，这里会自动检查。`
      : `正在等待要添加的账号登录。当前检测到：${label}。完成网页登录并允许返回 Typeless 后，这里会自动检查。`;
    flow.candidate = null;
    state('waiting_login', message, { id: 'check', label: '检查登录结果' }, reason, 2);
  }
  async function inspect(current, purpose = 'target') {
    if (!current) { loginRequired(); return; }
    const status = await check(current);
    if (status === 'unknown') { retry('暂时无法确认登录凭证是否有效。请检查网络后重试，不需要退出或重新登录。', 'inspect', 'LOGIN_CHECK_UNKNOWN', 2); return; }
    if (status === 'expired') {
      flow.lastRejected = current;
      if (purpose === 'protect' || (!flow.targetId && !readAccounts().some(a => a.user_id === current.user_id))) {
        // 不能保存一个已失效的未收录会话；先保留本机文件，再允许前往目标登录。
        try { backupCurrent(); flow.expiredBackup = current; }
        catch (_) { retry('当前登录已失效，且本地登录备份未能完成。请检查数据目录后重试。', 'prepare', 'BACKUP_FAILED', 1); return; }
      }
      loginRequired('ACCOUNT_LOGIN_EXPIRED', purpose === 'protect'
        ? '当前会话已失效，已保留本地登录备份。可继续登录目标账号。'
        : '当前仍是已失效的登录凭证。请在官方页面重新登录，不要点击网页或 Typeless 的退出登录。');
      return;
    }
    let captured;
    try { captured = await capture(); }
    catch (_) { retry('已检测到登录，但读取当前账号未完成。请检查管理连接后重试。', 'inspect', 'CAPTURE_FAILED', 2); return; }
    if (!sameSession(captured, current)) { waitForLogin(captured, 'SESSION_CHANGED'); return; }
    const saved = readAccounts().find(a => a.user_id === current.user_id);
    captured = { ...captured, nickname: saved?.nickname || captured.nickname, email: captured.email || saved?.email };
    if (!captured.email) { retry('已检测到登录，但尚未读到邮箱，暂时不能确认账号。请检查网络和管理连接后重试。', 'inspect', 'IDENTITY_UNAVAILABLE', 2); return; }
    if (!await checkOthers(current.user_id)) return;
    flow.candidate = { ...captured, purpose, expiresAt: now() + CONFIRM_TTL };
    emit('captured', { account_id: captured.user_id, credential: captured.token });
    state(purpose === 'protect' ? 'protect_current' : 'confirm', purpose === 'protect'
      ? '当前会话尚未妥善保存。先确认并保存这个账号，完成后会继续目标账号的登录。'
      : '已确认当前账号的登录凭证有效。请核对邮箱，确认后保存账号和登录快照。',
    { id: purpose === 'protect' ? 'save_current' : 'save', label: purpose === 'protect' ? '保存当前账号并继续' : saved ? '确认并更新原账号' : '确认并保存账号' },
    purpose === 'protect' ? 'CURRENT_ACCOUNT_NOT_SAVED' : 'ACCOUNT_READY', purpose === 'protect' ? 1 : 3);
  }
  async function routeCurrent(current) {
    if (!current?.user_id || !current.token) { loginRequired(); return; }
    const saved = readAccounts().find(a => a.user_id === current.user_id);
    if (current.user_id === flow.targetId || (!flow.targetId && !saved)) { await inspect(current); return; }
    if (!sameSession(saved, current) || !hasSnapshot(current.user_id)) { await inspect(current, 'protect'); return; }
    loginRequired();
  }
  async function prepare() {
    state('preparing', '正在连接 Typeless 并检查账号状态…', null, 'PREPARING', 1);
    try { marker(true); await connect(); }
    catch (_) { retry('准备未完成。请确认 Typeless 已安装、管理连接可用且数据目录可写，然后重试。', 'prepare', 'PREPARE_FAILED', 1); return; }
    if (!flow.baseline.length) {
      flow.baseline = readAccounts().map(a => ({ ...a, status: null }));
    }
    for (const account of flow.baseline) {
      if (!account.status || account.status === 'unknown') account.status = await check(account);
    }
    if (flow.baseline.some(a => a.status === 'unknown')) { retry('部分账号的初始状态暂时无法确认。请检查网络后重试，尚未打开登录页。', 'prepare', 'BASELINE_UNKNOWN', 1); return; }
    const current = await session();
    if (current !== undefined) await routeCurrent(current);
  }
  async function open() {
    const current = await session();
    if (current === undefined) return;
    const saved = current && readAccounts().find(a => a.user_id === current.user_id);
    if (current && current.user_id !== flow.targetId && !sameSession(flow.expiredBackup, current)
        && (!sameSession(saved, current) || !hasSnapshot(current.user_id))) {
      await routeCurrent(current); return;
    }
    try {
      await openBrowser(actual => {
        const value = actual && { user_id: actual.user_id, token: actual.refresh_token };
        if ((current || value) && !sameSession(current, value)) throw Error('Session changed');
      });
    } catch (_) { retry('未能打开登录页，或准备期间当前会话发生了变化。请重试当前状态检查。', 'prepare', 'BROWSER_OPEN_FAILED', 2); return; }
    flow.lastRejected = current;
    waitForLogin(current);
  }
  async function inspectCurrent(automatic = false) {
    const current = await session();
    if (current === undefined) return;
    if (flow.targetId && current?.user_id !== flow.targetId) {
      if (!automatic || !(sameSession(flow.lastRejected, current) || (!flow.lastRejected && !current))) { flow.lastRejected = current; waitForLogin(current, 'ACCOUNT_MISMATCH'); }
      return;
    }
    if (!flow.targetId && (!current || readAccounts().some(a => a.user_id === current.user_id))) {
      if (!automatic || !(sameSession(flow.lastRejected, current) || (!flow.lastRejected && !current))) { flow.lastRejected = current; waitForLogin(current); }
      return;
    }
    if (automatic && sameSession(flow.lastRejected, current)) return;
    await inspect(current);
  }
  async function verifySaved() {
    const pending = flow.pending;
    if (!pending) { await prepare(); return; }
    state('verifying', '账号已保存，正在确认登录结果和其他账号状态…', null, 'VERIFYING', 4);
    const status = await check(pending.account);
    if (status === 'unknown') { retry('账号已保存，但认证服务暂未给出可确认的结果。重试只做校验，不会重复保存。', 'verify', 'LOGIN_CHECK_UNKNOWN', 4); return; }
    if (!await checkOthers(pending.account.user_id)) return;
    const current = await session();
    if (current === undefined) { flow.retry = 'verify'; return; }
    if (status === 'expired' || !sameSession(current, pending.account)) {
      if (pending.purpose === 'protect') {
        flow.pending = null; flow.candidate = null; flow.saved = false;
        retry('当前账号记录已保存，但登录尚未确认成功。请重新检查当前状态后继续原目标账号。',
          'prepare', status === 'expired' ? 'ACCOUNT_LOGIN_EXPIRED' : 'SESSION_CHANGED', 1); return;
      }
      flow.targetId = pending.account.user_id; flow.pending = null;
      loginRequired(status === 'expired' ? 'ACCOUNT_LOGIN_EXPIRED' : 'SESSION_CHANGED',
        '账号记录已保存，但尚未确认恢复成功。当前凭证被拒绝或会话已变化，请重新登录这个账号。');
      return;
    }
    if (!pending.existing && !pending.importAttempted) {
      pending.importAttempted = true;
      try { await importMaster(pending.account); }
      catch (_) { flow.syncWarning = true; }
    }
    const finalSession = await session();
    if (finalSession === undefined) { flow.retry = 'verify'; return; }
    if (!sameSession(finalSession, pending.account)) {
      if (pending.purpose === 'protect') {
        flow.pending = null; flow.candidate = null; flow.saved = false;
        retry('当前账号记录已保存，但登录会话已变化。请重新检查当前状态后继续原目标账号。',
          'prepare', 'SESSION_CHANGED', 1); return;
      }
      flow.targetId = pending.account.user_id; flow.pending = null;
      waitForLogin(finalSession, 'SESSION_CHANGED'); return;
    }
    flow.pending = null; flow.candidate = null;
    if (pending.purpose === 'protect') {
      flow.saved = false;
      flow.baseline = flow.baseline.filter(a => a.user_id !== pending.account.user_id);
      flow.baseline.push({ ...pending.account, status: 'valid' });
      loginRequired('CURRENT_ACCOUNT_SAVED', '当前会话已保存并验证。现在可以登录目标账号。');
    } else {
      try { marker(false); }
      catch (_) { flow.pending = pending; retry('账号已保存并校验，但流程记录未能完成。请重试，账号不会重复保存。', 'verify', 'FLOW_RECORD_WRITE_FAILED', 4); return; }
      state('done', '账号已保存并校验，其他原本有效的账号未发现新增失效。'
        + (flow.syncWarning ? '词库导入未完成，可在账号详情重试「从主词库导入」。' : ''),
      { id: 'finish', label: '完成' }, 'COMPLETED', 4);
    }
  }
  async function save(nickname) {
    const candidate = flow.candidate;
    if (!candidate || now() > candidate.expiresAt) {
      flow.candidate = null;
      retry('确认结果已过期。请重新检测当前账号，核对后再保存。', 'inspect', 'CAPTURE_EXPIRED', 2); return;
    }
    const current = await session();
    if (current === undefined) return;
    if (!sameSession(current, candidate)) { flow.candidate = null; waitForLogin(current, 'SESSION_CHANGED'); return; }
    const status = await check(candidate);
    if (status !== 'valid') {
      if (status === 'unknown') retry('当前凭证暂时无法校验，尚未保存。请重试检测，不需要退出登录。', 'inspect', 'LOGIN_CHECK_UNKNOWN', 3);
      else loginRequired('ACCOUNT_LOGIN_EXPIRED', '当前凭证已失效，尚未更新记录。请重新登录这个账号。');
      return;
    }
    const latest = await session();
    if (latest === undefined) return;
    if (!sameSession(latest, candidate)) { flow.candidate = null; waitForLogin(latest, 'SESSION_CHANGED'); return; }
    let result;
    try { result = saveAccount(candidate, nickname); }
    catch (error) {
      flow.candidate = null;
      retry(error.code === 'SNAPSHOT_CHANGED' ? '确认后的登录文件已变化，尚未保存。请重新检测并核对账号。'
        : '保存未完成，旧记录或恢复备份已保留。请重试检测；若再次失败，请导出日志反馈。',
      'inspect', error.code === 'SNAPSHOT_CHANGED' ? 'SNAPSHOT_CHANGED' : 'SAVE_FAILED', 3); return;
    }
    flow.saved = true;
    flow.pending = { account: result.account, existing: result.existing, purpose: candidate.purpose };
    if (candidate.purpose !== 'protect') flow.targetId = candidate.user_id;
    emit('saved', { account_id: candidate.user_id, credential: candidate.token, updated_existing: result.existing });
    await verifySaved();
  }
  async function run(fn) {
    if (busy) throw new LocalApiError(409, 'OPERATION_BUSY', '正在检查当前步骤，请稍后重试');
    busy = true;
    try { await fn(); }
    catch (_) { retry('当前步骤未能完成。请重试；若再次失败，请导出日志反馈。', flow.pending ? 'verify' : 'prepare', 'FLOW_OPERATION_FAILED'); }
    finally { busy = false; }
    return view();
  }
  async function start(targetId = null) {
    if (isActive()) throw new LocalApiError(409, 'LOGIN_FLOW_ACTIVE', '已有登录流程尚未完成，请继续或结束当前流程');
    if (targetId !== null && !readAccounts().some(a => a.user_id === targetId)) throw new LocalApiError(404, 'ACCOUNT_NOT_FOUND', '要恢复的账号不存在');
    flow = fresh(targetId); bindLog(flow.id);
    emit('login_target', { account_id: targetId });
    return run(prepare);
  }
  async function act({ flow_id: id, revision, action, nickname, automatic = false }) {
    expire();
    if (!flow || id !== flow.id || revision !== flow.revision) throw new LocalApiError(409, 'LOGIN_FLOW_CHANGED', '流程状态已更新，请按当前步骤继续');
    bindLog(flow.id);
    if (action === 'cancel' && !busy) {
      try { marker(false); }
      catch (_) { retry('无法结束流程记录，请检查数据目录后再次结束。', 'finish', 'FLOW_RECORD_WRITE_FAILED'); return view(); }
      flow.candidate = null; flow.pending = null;
      state('cancelled', '本次流程已结束，已保存的账号和当前登录不会被删除或退出。', null, 'CANCELLED');
      return view();
    }
    if (busy) throw new LocalApiError(409, 'OPERATION_BUSY', '当前步骤正在处理，请稍后重试');
    if (action !== flow.action?.id && !(action === 'open_browser' && flow.stage === 'waiting_login')) {
      throw new LocalApiError(409, 'LOGIN_FLOW_ACTION_INVALID', '当前步骤不能执行该操作，请按页面指引继续');
    }
    if (action === 'restart') {
      const targetId = flow.targetId;
      state('cancelled', '已重新开始状态检查。', null, 'RESTARTED');
      return start(targetId);
    }
    if (action === 'finish') return view();
    return run(async () => {
      if (action === 'open_browser') await open();
      else if (action === 'check') await inspectCurrent(automatic === true);
      else if (action === 'save' || action === 'save_current') await save(nickname);
      else if (action === 'retry') {
        if (flow.retry === 'verify') await verifySaved();
        else if (flow.retry === 'inspect') {
          const current = await session();
          if (current !== undefined) await routeCurrent(current);
        } else if (flow.retry === 'finish') { marker(false); state('cancelled', '本次流程已结束。', null, 'CANCELLED'); }
        else await prepare();
      }
    });
  }
  return { start, act, view, isActive,
    latestCheck(account) { const entry = flow?.checks.get(account.user_id); return entry?.token === account.token ? entry.check : null; } };
}

module.exports = { createLoginFlow, createLoginFlowStore };
