'use strict';

// 只记录有类型的诊断字段；不接收任意消息、响应正文或请求头。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { ensurePrivateDirectory } = require('./private-fs');

const EVENTS = new Set(['manager_started', 'operation_started', 'operation_finished',
  'login_check', 'login_target', 'login_current', 'current_detected', 'captured', 'saved', 'removed']);
const OPERATIONS = new Set(['refresh_accounts', 'browser_login', 'capture', 'save_account',
  'remove_account', 'switch_account', 'reset_device', 'connect', 'restore_backup', 'rotation_settings']);
const ERRORS = new Set(['ACCOUNT_NOT_FOUND', 'CURRENT_ACCOUNT_NOT_SAVED', 'ACCOUNT_MISMATCH',
  'CURRENT_ACCOUNT_CHANGED', 'ACCOUNT_LOGIN_EXPIRED', 'LOGIN_CHECK_FAILED', 'CAPTURE_EXPIRED',
  'SNAPSHOT_INVALID', 'SWITCH_RECOVERY_REQUIRED', 'SWITCH_ROLLED_BACK', 'OPERATION_BUSY',
  'MANAGEMENT_CONNECTION_REQUIRED', 'CURRENT_ACCOUNT_UNAVAILABLE', 'INVALID_INPUT', 'INTERNAL_ERROR']);

function cleanEvent(input) {
  if (!input || !EVENTS.has(input.event)) return null;
  const out = { event: input.event };
  for (const key of ['at']) {
    if (typeof input[key] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input[key])) out[key] = input[key];
  }
  for (const key of ['session', 'account_ref', 'credential_ref']) {
    if (typeof input[key] === 'string' && /^[a-f0-9]{16}$/.test(input[key])) out[key] = input[key];
  }
  if (typeof input.version === 'string' && /^\d+\.\d+\.\d+$/.test(input.version)) out.version = input.version;
  if (OPERATIONS.has(input.operation)) out.operation = input.operation;
  if (ERRORS.has(input.error_code)) out.error_code = input.error_code;
  if (['started', 'ok', 'failed', 'valid', 'expired', 'unknown'].includes(input.outcome)) out.outcome = input.outcome;
  for (const key of ['request_id', 'duration_ms', 'account_count']) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0) out[key] = input[key];
  }
  if (Number.isInteger(input.http_status) && input.http_status >= 100 && input.http_status <= 599) out.http_status = input.http_status;
  if (Number.isSafeInteger(input.api_code)) out.api_code = input.api_code;
  for (const key of ['updated_existing', 'has_current']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

function createDiagnosticLog({ dir, version, maxBytes = 1024 * 1024 }) {
  const file = path.join(dir, 'diagnostics.jsonl');
  const previous = file + '.1';
  const session = crypto.randomBytes(8).toString('hex');
  const key = crypto.randomBytes(32);
  const context = new AsyncLocalStorage();
  let sequence = 0, dropped = 0, writeOk = true;
  const reference = (kind, value) => typeof value === 'string' && value
    ? crypto.createHmac('sha256', key).update(kind + '\0' + value).digest('hex').slice(0, 16) : undefined;
  function checkFile(target) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Unsafe log file');
    return stat;
  }
  function record(event, fields = {}) {
    const active = context.getStore();
    const entry = cleanEvent({ ...fields, event, version, session, at: new Date().toISOString(),
      request_id: active?.id, operation: active?.operation,
      account_ref: reference('account', fields.account_id), credential_ref: reference('credential', fields.credential) });
    if (!entry) return;
    try {
      ensurePrivateDirectory(dir);
      const line = JSON.stringify(entry) + '\n';
      const stat = checkFile(file);
      if (stat && stat.size + Buffer.byteLength(line) > maxBytes) {
        checkFile(previous);
        fs.renameSync(file, previous);
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, line); } finally { fs.closeSync(fd); }
      writeOk = true;
    } catch (_) { writeOk = false; dropped++; }
  }
  function status() { return { available: writeOk, dropped_events: dropped, max_bytes: maxBytes * 2, session }; }
  function exportLog() {
    const events = [];
    let complete = true;
    for (const target of [previous, file]) {
      try {
        // 不读取符号链接、超大文件或任意正文；导出前再次做字段筛选。
        const directory = fs.lstatSync(dir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe log directory');
        const stat = checkFile(target);
        if (!stat) continue;
        if (stat.size > maxBytes) throw Error('Oversized log');
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let contents;
        try { contents = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
        for (const line of contents.split('\n').filter(Boolean)) {
          try {
            const entry = cleanEvent(JSON.parse(line));
            if (entry) events.push(entry); else complete = false;
          } catch (_) { complete = false; }
        }
      } catch (_) { complete = false; }
    }
    return { format: 'typeless-toolkit-diagnostics-v1', version, exported_at: new Date().toISOString(),
      logging: { ...status(), complete }, events };
  }
  return {
    record, status, exportLog,
    accountRef: value => reference('account', value),
    withRequest: fn => context.run({ id: ++sequence }, fn),
    begin(operation) {
      const active = context.getStore();
      if (!active || !OPERATIONS.has(operation)) return;
      active.operation = operation; active.started = Date.now();
      record('operation_started', { outcome: 'started' });
    },
    finish(httpStatus, response) {
      const active = context.getStore();
      if (!active?.operation || active.finished) return;
      active.finished = true;
      record('operation_finished', { http_status: httpStatus,
        outcome: response.status === 'OK' ? 'ok' : 'failed',
        error_code: response.status === 'OK' ? undefined : ERRORS.has(response.code) ? response.code : 'INTERNAL_ERROR',
        duration_ms: Date.now() - active.started });
    },
  };
}

module.exports = { createDiagnosticLog };
