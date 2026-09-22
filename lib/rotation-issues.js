'use strict';

// 仅按已经验证的本地错误语义分类；未知业务拒绝不能推断为设备限制。
const ISSUES = Object.freeze({
  NO_ACCOUNTS: ['还没有保存账号，请先添加当前账号。', 'add-account', false],
  NO_CANDIDATES: ['没有其他已保存账号，请添加可供轮动的账号。', 'add-account', false],
  NOT_LOGGED_IN: ['Typeless 当前未登录，请先在应用中登录并更新登录信息。', 'update-login', false],
  ACCOUNT_NOT_SAVED: ['当前登录账号尚未保存，请先添加当前账号。', 'add-account', false],
  CONNECTION_REQUIRED: ['Typeless 管理连接不可用，请连接 Typeless 后重试。', 'connect', false],
  ACCOUNT_LOGIN_EXPIRED: ['登录凭证已失效，请在 Typeless 重新登录此账号并更新登录。', 'update-login', false],
  SNAPSHOT_INVALID: ['登录快照缺失或不匹配，请登录此账号并更新登录。', 'update-login', false],
  ACCOUNT_QUOTA_EXHAUSTED: ['用量已达到轮动阈值或服务额度，请等待额度重置或使用其他账号。', 'accounts', true],
  AUTH_RETRY_REQUIRED: ['本次认证未通过，将在下次检查重新刷新凭证；持续失败时请更新登录。', 'accounts', true],
  REQUEST_FAILED: ['本次请求未完成，将在下次检查重试；持续失败时请检查连接和账号状态。', 'accounts', true],
  NO_AVAILABLE_ACCOUNTS: ['没有可用的下一个账号，请查看各账号的原因及处理方式。', 'accounts', false],
  SWITCH_ROLLED_BACK: ['切换失败，已恢复切换前的登录状态。请更新目标账号的登录后重试。', 'update-login', false],
  SWITCH_RECOVERY_REQUIRED: ['切换失败且原登录状态未能恢复。请在 Typeless 重新登录，并更新对应账号。', 'update-login', false],
  STATE_SAVE_FAILED: ['轮动状态无法保存，已暂停。请检查数据目录后重新保存设置。', 'settings', false],
  NOTIFICATION_FAILED: ['系统提醒未能发送，请在管理器查看结果并检查系统通知设置。', 'settings', false],
});

function makeRotationIssue(code, { accountId, accountName } = {}) {
  const known = Object.hasOwn(ISSUES, code) ? code : 'REQUEST_FAILED';
  const [message, action, retryable] = ISSUES[known];
  const name = typeof accountName === 'string' ? accountName.trim().slice(0, 120) : '';
  return {
    code: known, message: name ? `「${name}」${message}` : message, action,
    ...(typeof accountId === 'string' && accountId ? { account_id: accountId.slice(0, 128) } : {}),
    retryable,
  };
}

function issueForError(error, context = {}) {
  // 切号事务附带的 issue 已包含目标账号；不要用当前账号覆盖它。
  if (error?.issue && Object.hasOwn(ISSUES, error.issue.code)) return error.issue;
  let code = error?.code;
  if (Object.hasOwn(ISSUES, code)) return makeRotationIssue(code, context);
  if (code === 'LOGIN_CHECK_FAILED') code = 'AUTH_RETRY_REQUIRED';
  else if (code === 'ACCOUNT_NOT_FOUND') code = 'ACCOUNT_NOT_SAVED';
  else if (error?.apiCode === 401) code = 'AUTH_RETRY_REQUIRED';
  return makeRotationIssue(code, context);
}

module.exports = { makeRotationIssue, issueForError };
