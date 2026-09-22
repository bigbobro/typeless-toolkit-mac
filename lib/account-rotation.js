'use strict';

const fs = require('fs');
const { writePrivateJson } = require('./private-fs');
const { makeRotationIssue, issueForError } = require('./rotation-issues');

const DEFAULT_ROTATION_SETTINGS = Object.freeze({
  enabled: false, mode: 'notify', word_threshold: 2000, warning_words: 100, interval_minutes: 15,
});

function validateRotationSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.enabled !== 'boolean' || !['notify', 'auto'].includes(value.mode)
      || !Number.isSafeInteger(value.word_threshold) || value.word_threshold < 1 || value.word_threshold > 10000000
      || !Number.isSafeInteger(value.warning_words) || value.warning_words < 0 || value.warning_words >= value.word_threshold
      || ![10, 15, 30].includes(value.interval_minutes)) {
    throw new Error('轮动设置无效：阈值须为 1–10000000 的整数，提前提醒词数须小于阈值，检查间隔须为 10、15 或 30 分钟');
  }
  return Object.fromEntries(Object.keys(DEFAULT_ROTATION_SETTINGS).map(key => [key, value[key]]));
}

function createRotationStore(file) {
  return {
    load() {
      if (!fs.existsSync(file)) return null;
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('轮动设置文件过大，请检查 rotation.json');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    save(value) { writePrivateJson(file, value); },
  };
}

// 一个定时器、一轮任务和每个已保存账号的一条记录；通知重试也复用同一个定时器。
function createAccountRotation({
  store, readAccounts, readCurrentAccountId, readUsage, isBusy, rotate, notifier,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let settings = { ...DEFAULT_ROTATION_SETTINGS };
  let records = new Map(), paused = false, active = false, running = false, timer = null, generation = 0;
  let alertedIssueKey = null, failureStreak = 0, pendingNotice = null;
  const status = {
    phase: 'disabled', message: '账号轮动未开启', last_check_at: null, next_check_at: null,
    current_user_id: null, used_words: null, last_result: null,
    issue: null, candidate_issues: [], notification_error: null,
  };
  const brief = value => String(value || '').slice(0, 500);
  const issueKey = issue => issue ? issue.code + ':' + (issue.account_id || '') : '';
  const problemKey = () => [issueKey(status.issue), ...status.candidate_issues.map(issueKey)].join('|');
  function cleanIssue(value, accounts) {
    if (!value || typeof value.code !== 'string') return null;
    const account = accounts.find(item => item.user_id === value.account_id);
    return makeRotationIssue(value.code, { accountId: account?.user_id,
      accountName: account?.nickname || account?.email });
  }
  try {
    const saved = store.load();
    if (saved) {
      if (saved.version !== 1) throw new Error('轮动设置版本不支持');
      settings = validateRotationSettings(saved.settings);
      const accounts = readAccounts(), ids = new Set(accounts.map(account => account.user_id));
      for (const record of Array.isArray(saved.accounts) ? saved.accounts : []) {
        if (ids.has(record.user_id) && Number.isSafeInteger(record.used) && record.used >= 0) {
          records.set(record.user_id, { used: record.used, reminded: record.reminded === true });
        }
      }
      paused = saved.paused === true;
      status.last_result = saved.last_result ? brief(saved.last_result) : null;
      status.issue = cleanIssue(saved.issue, accounts);
      status.candidate_issues = accounts.flatMap(account => {
        const issue = Array.isArray(saved.candidate_issues)
          ? saved.candidate_issues.find(item => item?.account_id === account.user_id) : null;
        return issue ? [cleanIssue(issue, accounts)] : [];
      });
      if (status.issue?.code === 'NO_AVAILABLE_ACCOUNTS') {
        status.issue.retryable = status.candidate_issues.some(issue => issue.retryable);
      }
      alertedIssueKey = typeof saved.alerted_issue_key === 'string' ? saved.alerted_issue_key : null;
      failureStreak = Math.min(2, Math.max(0, Number(saved.failure_streak) || 0));
      status.notification_error = saved.notification_error ? brief(saved.notification_error) : null;
      if (['issue', 'success'].includes(saved.pending_notice?.kind)) {
        pendingNotice = { kind: saved.pending_notice.kind, title: brief(saved.pending_notice.title),
          message: brief(saved.pending_notice.message), key: String(saved.pending_notice.key || '') };
      }
      status.phase = settings.enabled ? (paused ? 'paused' : 'waiting') : 'disabled';
      status.message = status.issue?.message || (paused ? (status.last_result || '轮动已暂停，请检查后重新保存设置')
        : (settings.enabled ? '等待检查' : '账号轮动未开启'));
    }
  } catch (error) {
    settings = { ...DEFAULT_ROTATION_SETTINGS };
    records.clear();
    status.phase = 'error';
    status.message = '轮动设置读取失败，未开启轮动：' + brief(error.message);
  }

  function view() { return structuredClone({ settings, status }); }
  function persist() {
    try {
      store.save({ version: 1, settings, paused, last_result: status.last_result,
        issue: status.issue, candidate_issues: status.candidate_issues, alerted_issue_key: alertedIssueKey,
        failure_streak: failureStreak, notification_error: status.notification_error, pending_notice: pendingNotice,
        accounts: [...records].map(([user_id, record]) => ({ user_id, ...record })),
      });
    } catch (_) { throw Object.assign(new Error('轮动状态无法保存'), { code: 'STATE_SAVE_FAILED' }); }
  }
  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null; status.next_check_at = null;
  }
  function schedule(delay) {
    clearScheduled();
    if (!active || !settings.enabled || running || (paused && !pendingNotice)) return;
    status.next_check_at = new Date(now() + delay).toISOString();
    timer = setTimer(() => { timer = null; status.next_check_at = null; void check(); }, delay);
    timer?.unref?.();
  }
  function observe(id, used) {
    const previous = records.get(id);
    // 用量下降时重新允许提醒，不依赖服务端的重置星期或时区。
    const record = { used, reminded: previous && used >= previous.used ? previous.reminded : false };
    records.set(id, record);
    return record;
  }
  function clearIssue(keepCandidates = false) {
    status.issue = null;
    if (!keepCandidates) status.candidate_issues = [];
    alertedIssueKey = null; failureStreak = 0;
    if (pendingNotice?.kind === 'issue') { pendingNotice = null; status.notification_error = null; }
  }
  // 只保存最近一个待发送通知。发送失败只重试通知，绝不重放已完成的切号。
  async function deliverNotice(valid) {
    const notice = pendingNotice;
    if (!notice || !valid()) return;
    try {
      const answer = notice.kind === 'issue' ? await notifier.guide(notice) : await notifier.notify(notice);
      if (!valid() || pendingNotice !== notice) return;
      if (notice.kind === 'issue' && !['opened', 'later'].includes(answer)) {
        status.notification_error = '系统提示尚未确认，下次检查会再次提醒；也可直接在管理器处理';
      } else {
        if (notice.kind === 'issue') alertedIssueKey = notice.key;
        pendingNotice = null; status.notification_error = null;
      }
    } catch (_) {
      if (!valid() || pendingNotice !== notice) return;
      status.notification_error = '系统提醒发送失败，下次检查会重试提醒；请在管理器查看结果并检查 macOS 通知权限';
    }
    if (valid()) persist();
  }
  async function reportIssue(issue, candidates, valid) {
    const previousKey = problemKey();
    status.issue = issue;
    status.candidate_issues = candidates;
    const key = problemKey();
    failureStreak = key === previousKey ? Math.min(2, failureStreak + 1) : 1;
    status.message = issue.message;
    if (key !== previousKey) { alertedIssueKey = null; pendingNotice = null; status.notification_error = null; }
    // 临时错误先按周期自愈；连续两轮失败，或明确需要用户处理时，才弹恢复引导。
    if (alertedIssueKey !== key && (!issue.retryable || failureStreak >= 2 || paused)) {
      pendingNotice = { kind: 'issue', title: paused ? 'Typeless 轮动已暂停' : 'Typeless 轮动需要处理',
        message: brief(issue.message + ` 正常检查间隔为 ${settings.interval_minutes} 分钟。`
          + (paused ? ' 处理后请重新保存轮动设置以恢复。' : '')
          + ' 选择稍后可关闭同类提醒；90 秒未操作则下次再提醒。'),
        key };
    }
    persist();
    await deliverNotice(valid);
  }

  async function check() {
    if (running || !active || !settings.enabled || (paused && !pendingNotice)) return;
    clearScheduled(); running = true;
    const revision = generation;
    const valid = () => active && settings.enabled && generation === revision;
    const current = () => valid() && !paused;
    let currentId = null, currentAccount = null, switched = false;
    try {
      if (paused) { await deliverNotice(valid); return; }
      if (pendingNotice?.kind === 'success') await deliverNotice(valid);
      if (!current()) return;
      if (isBusy()) { status.phase = 'waiting'; status.message = '管理器正在处理其他操作，下次再检查'; return; }
      status.phase = 'checking'; status.message = '正在检查当前账号词数';
      const accounts = readAccounts();
      const ids = new Set(accounts.map(account => account.user_id));
      for (const id of records.keys()) if (!ids.has(id)) records.delete(id);
      status.candidate_issues = status.candidate_issues.filter(issue => ids.has(issue.account_id));
      if (!accounts.length) throw Object.assign(new Error('没有保存的账号'), { code: 'NO_ACCOUNTS' });
      currentId = await readCurrentAccountId();
      if (!current()) return;
      if (!currentId) throw Object.assign(new Error('Typeless 尚未登录'), { code: 'NOT_LOGGED_IN' });
      const account = accounts.find(value => value.user_id === currentId);
      if (!account) throw Object.assign(new Error('当前登录账号尚未保存'), { code: 'ACCOUNT_NOT_SAVED' });
      currentAccount = account;
      const usage = await readUsage(account);
      if (!current()) return;
      if (isBusy()) { status.phase = 'waiting'; status.message = '账号操作期间的用量结果已忽略，下次再检查'; return; }
      const used = usage.week_word_usage_value;
      if (!Number.isSafeInteger(used) || used < 0) throw new Error('服务端未返回有效周用量');
      const record = observe(currentId, used);
      if (status.current_user_id && status.current_user_id !== currentId) clearIssue();
      // 本轮已证实当前连接/凭证恢复，不继续展示旧故障；候选账号的问题尚未复查。
      const issue = status.issue;
      if (issue && (['NO_ACCOUNTS', 'NOT_LOGGED_IN', 'ACCOUNT_NOT_SAVED', 'CONNECTION_REQUIRED'].includes(issue.code)
        || (['REQUEST_FAILED', 'AUTH_RETRY_REQUIRED', 'ACCOUNT_LOGIN_EXPIRED'].includes(issue.code)
          && (issue.account_id === currentId || (!issue.account_id && !status.candidate_issues.length))))) {
        record.reminded = false;
        clearIssue(true);
      }
      status.current_user_id = currentId; status.used_words = used;
      status.last_check_at = new Date(now()).toISOString();
      status.phase = 'waiting'; status.message = `每 ${settings.interval_minutes} 分钟检查一次；本次用量已更新`;
      const trigger = settings.mode === 'auto' ? settings.word_threshold : settings.word_threshold - settings.warning_words;
      if (used < trigger) { clearIssue(true); persist(); return; }
      if (settings.mode === 'notify' && record.reminded) {
        // 用户明确选择稍后，或候选需要手工修复时，保留原因。修复/保存设置会解除此标记。
        if (status.issue) { status.message = status.issue.message; await deliverNotice(valid); }
        persist(); return;
      }
      persist();

      if (settings.mode === 'notify') {
        status.phase = 'prompting'; status.message = '已显示系统确认框，等待选择切换或稍后';
        let answer;
        try {
          answer = await notifier.confirm({ accountName: account.nickname || account.email || currentId,
            usedWords: used, threshold: settings.word_threshold, intervalMinutes: settings.interval_minutes });
        } catch (_) { throw Object.assign(new Error('系统确认框未能显示'), { code: 'NOTIFICATION_FAILED' }); }
        if (!current()) return;
        record.reminded = answer === 'later';
        status.phase = 'waiting';
        if (answer !== 'switch') {
          if (answer === 'later') clearIssue();
          status.message = answer === 'later' ? '已选择稍后，本账号在用量重置前不再提醒'
            : '本次提示未确认，保持当前账号，下次检查会再次提醒';
          status.last_result = status.message;
          persist(); return;
        }
      }

      if (!current()) return;
      status.phase = 'switching'; status.message = '正在选择并切换下一个可用账号';
      const result = await rotate({ fromId: currentId, settings: { ...settings }, canProceed: current });
      if (!current()) return;
      switched = result.switched === true;
      status.phase = 'waiting'; status.message = brief(result.message); status.last_result = status.message;
      record.reminded = !result.retryable;
      if (result.user_id) status.current_user_id = result.user_id;
      if (switched) {
        clearIssue();
        status.used_words = null;
        status.candidate_issues = result.issues || [];
        pendingNotice = { kind: 'success', title: 'Typeless 账号已切换', message: status.message, key: '' };
        persist();
        await deliverNotice(valid);
      } else if (result.issue) {
        await reportIssue(result.issue, result.issues || [], valid);
      } else {
        clearIssue(); persist();
      }
    } catch (error) {
      if (!valid()) return;
      const switching = status.phase === 'switching';
      paused = paused || switching || error.code === 'STATE_SAVE_FAILED';
      status.phase = paused ? 'paused' : 'error';
      const issue = issueForError(error, { accountId: currentId, accountName: currentAccount?.nickname || currentAccount?.email });
      if (!switched) status.last_result = (paused ? '轮动已暂停。' : '本次未切换。') + issue.message;
      try { await reportIssue(issue, Array.isArray(error.issues) ? error.issues : [], valid); }
      catch (_) {
        // 磁盘失败仍尝试一次原生引导；不能让存盘错误阻断最后的可见恢复入口。
        paused = true; status.phase = 'paused'; status.issue = makeRotationIssue('STATE_SAVE_FAILED');
        status.message = status.issue.message;
        pendingNotice = { kind: 'issue', title: 'Typeless 轮动已暂停', message: status.message, key: issueKey(status.issue) };
        try { await deliverNotice(valid); } catch (_) { /* 内存中的状态和单个通知重试仍保留 */ }
      }
    } finally {
      running = false;
      schedule(generation === revision ? settings.interval_minutes * 60000 : 0);
    }
  }

  function configure(value) {
    const next = validateRotationSettings(value);
    // 先保存候选状态，失败时保持原配置和旧提示。明确保存设置也允许修复后重新提醒。
    const nextRecords = new Map([...records].map(([id, record]) => [id, { ...record, reminded: false }]));
    store.save({ version: 1, settings: next, paused: false, last_result: status.last_result,
      accounts: [...nextRecords].map(([user_id, record]) => ({ user_id, ...record })),
    });
    generation++; clearScheduled(); notifier.cancel();
    settings = next; records = nextRecords; paused = false;
    clearIssue(); pendingNotice = null; status.notification_error = null;
    status.phase = settings.enabled ? 'waiting' : 'disabled';
    status.message = settings.enabled ? '已保存，准备检查' : '账号轮动未开启';
    schedule(0);
    return view();
  }
  function start() { if (active) return; active = true; schedule(0); }
  function stop() { active = false; generation++; clearScheduled(); notifier.cancel(); }
  // 修复账号后重新评估，旧提示不能授权新的切号；仍沿用唯一的低频检查。
  function invalidate() {
    generation++; notifier.cancel();
    if (!paused) {
      clearIssue();
      for (const record of records.values()) record.reminded = false;
    }
    // 修复后的重评不能因下次检查前退出而丢失；暂停只能由明确保存设置解除。
    try { persist(); }
    catch (error) { paused = true; status.phase = 'paused'; status.issue = makeRotationIssue('STATE_SAVE_FAILED');
      status.message = status.issue.message; throw error; }
    if (!running) schedule(settings.interval_minutes * 60000);
  }
  return { view, configure, start, stop, invalidate, check };
}

module.exports = { DEFAULT_ROTATION_SETTINGS, validateRotationSettings, createRotationStore, createAccountRotation };
