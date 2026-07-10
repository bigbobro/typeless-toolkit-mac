#!/usr/bin/env node
/**
 * Typeless 多账号管理器 —— 本地后端服务
 * 提供 HTTP API 供前端 (manager.html) 调用;复用 CDP 抓 token + curl 调 Typeless API。
 * 数据:accounts.json (账号+token,明文) + Typeless词库主清单.csv (主词库)
 *
 * 共享逻辑已抽到 ./lib/common.js,本文件只保留 HTTP 路由层。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const C = require('./lib/common');
const {
  LocalApiError,
  applySecurityHeaders,
  createLocalApiSecurity,
  readJsonBody,
} = require('./lib/local-api-security');
const {
  config, CDP_PORT, ASAR_PATH, MAC_INFO_PLIST,
  readAccounts, writeAccounts,
  backupRuntimeData, runtimeDataStatus, createRuntimeBackupBundle, restoreRuntimeBackupBundle,
  saveSnapshot, restoreSnapshot, hasSnapshot, snapshotMtime, tokenExpiryInfo,
  killTypeless, launchTypeless, resetDevice,
  readMaster, writeMaster,
  curlApi, typelessConnectionStatus, ensureApp, captureTokenCDP,
  liveStatus, syncAccount,
  paywallStatus, patchPaywall,
  getTypelessVersion, versionDriftStatus, writeVersionState,
  accountMetaFromUserInfo,
  termKey, safeCount, assertSafeAccountId,
  log, sleep,
} = C;

const PORT = config.manager_port;
const security = createLocalApiSecurity({ port: PORT });
const pendingCaptures = new Map();
const CAPTURE_TTL_MS = 2 * 60 * 1000;

// ---------- HTTP ----------
function send(res, code, obj) {
  applySecurityHeaders(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limitBytes) {
  return limitBytes
    ? readJsonBody(req, { limitBytes })
    : security.readJson(req);
}

async function readObjectBody(req, limitBytes) {
  const body = await readBody(req, limitBytes);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LocalApiError(400, 'INVALID_INPUT', 'JSON 顶层必须是对象');
  }
  return body;
}

function boundedText(value, max, field) {
  const text = String(value || '').trim();
  if (text.length > max) throw new LocalApiError(400, 'INVALID_INPUT', `${field} 过长`);
  return text;
}

function publicAccount(account, extra = {}) {
  const view = {
    user_id: account.user_id,
    nickname: account.nickname || '',
    email: account.email || '',
    role: account.role || '',
    captured_at: account.captured_at || null,
    added_at: account.added_at || null,
  };
  for (const key of [
    'live', 'has_snapshot', 'snapshot_mtime', 'token_expires_at', 'token_days_left',
  ]) {
    if (Object.hasOwn(extra, key)) view[key] = extra[key];
  }
  return view;
}

function publicLiveStatus(live = {}) {
  const source = live && typeof live === 'object' && !Array.isArray(live) ? live : {};
  const usageSource = source.usage && typeof source.usage === 'object' && !Array.isArray(source.usage)
    ? source.usage
    : null;
  const personalSource = source.personal && typeof source.personal === 'object' && !Array.isArray(source.personal)
    ? source.personal
    : null;
  const usage = usageSource ? {
    week_word_usage_value: Number.isFinite(usageSource.week_word_usage_value) ? usageSource.week_word_usage_value : null,
    week_word_usage_limit: Number.isFinite(usageSource.week_word_usage_limit) ? usageSource.week_word_usage_limit : null,
    total_words: Number.isFinite(usageSource.total_words) ? usageSource.total_words : null,
    total_audio_seconds: Number.isFinite(usageSource.total_audio_seconds) ? usageSource.total_audio_seconds : null,
    mins_saved: Number.isFinite(usageSource.mins_saved) ? usageSource.mins_saved : null,
    avg_wpm: Number.isFinite(usageSource.avg_wpm) ? usageSource.avg_wpm : null,
  } : null;
  const personal = personalSource ? {
    total_learning_ratio: Number.isFinite(personalSource.total_learning_ratio)
      ? personalSource.total_learning_ratio
      : null,
    enabled: personalSource.enabled === true,
    category_count: Number.isFinite(personalSource.category_count)
      ? personalSource.category_count
      : (Array.isArray(personalSource.category_stats) ? personalSource.category_stats.length : null),
  } : null;
  return {
    token_valid: source.token_valid !== false,
    usage,
    personal,
    dict_count: Number.isFinite(source.dict_count) ? source.dict_count : 0,
    ...(source._err ? { error: String(source._err).slice(0, 300) } : {}),
  };
}

function publicDictionary(data = {}) {
  const words = Array.isArray(data?.words) ? data.words : [];
  return {
    words: words
      .filter(word => word && typeof word === 'object' && !Array.isArray(word))
      .map(word => ({
        term: typeof word.term === 'string' ? word.term : '',
        auto: word.auto === true,
      }))
      .filter(word => word.term),
  };
}

function publicCapture(capture, captureId) {
  return {
    ...(captureId ? { capture_id: captureId } : {}),
    user_id: capture.user_id,
    nickname: capture.nickname || '',
    email: capture.email || '',
    role: capture.role || '',
    captured_at: capture.captured_at || null,
  };
}

function putPendingCapture(capture) {
  const now = Date.now();
  for (const [id, item] of pendingCaptures) {
    if (item.expiresAt <= now) pendingCaptures.delete(id);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  pendingCaptures.set(id, { capture, expiresAt: now + CAPTURE_TTL_MS });
  return id;
}

function takePendingCapture(id, consume = false) {
  const item = pendingCaptures.get(String(id || ''));
  if (!item || item.expiresAt <= Date.now()) {
    if (item) pendingCaptures.delete(String(id));
    throw new LocalApiError(400, 'CAPTURE_EXPIRED', '账号抓取结果已过期,请重新抓取');
  }
  if (consume) pendingCaptures.delete(String(id));
  return item.capture;
}

const server = http.createServer(async (req, res) => {
  try {
    let u;
    try { u = new URL(req.url, `http://localhost:${PORT}`); }
    catch (_) { throw new LocalApiError(400, 'INVALID_REQUEST_TARGET', '请求路径无效'); }
    const p = u.pathname; const m = req.method;
    if (m === 'GET' && p === '/api/health') {
      security.assertPageRequest(req);
      return send(res, 200, {
        status: 'OK',
        data: { product: 'typeless-toolkit-manager', state: 'ready', version: '2.3.0' },
      });
    }
    // 前端首页
    if (m === 'GET' && (p === '/' || p === '/index.html' || p === '/manager.html')) {
      security.assertPageRequest(req);
      const html = security.injectHtml(fs.readFileSync(path.join(C.CODE_DIR, 'manager.html'), 'utf8'));
      applySecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (p.startsWith('/api/')) security.assertApiRequest(req);
    // 账号列表(含实时状态)
    if (m === 'GET' && p === '/api/accounts') {
      const accs = readAccounts();
      const live = await Promise.all(accs.map(a => liveStatus(a).catch(e => ({ token_valid: false, _err: e.message }))));
      const data = accs.map((a, i) => publicAccount(a, {
        live: publicLiveStatus(live[i]),
        has_snapshot: hasSnapshot(a.user_id),
        snapshot_mtime: hasSnapshot(a.user_id) ? snapshotMtime(a.user_id) : null,
        ...tokenExpiryInfo(a.token),
      }));
      return send(res, 200, { status: 'OK', data });
    }
    // 本地运行数据备份状态(accounts/profile/主词库)
    if (m === 'GET' && p === '/api/backup-status') {
      return send(res, 200, { status: 'OK', data: runtimeDataStatus() });
    }
    // 手动备份本地运行数据
    if (m === 'POST' && p === '/api/backup-runtime') {
      const backupPath = backupRuntimeData('manual');
      return send(res, 200, {
        status: 'OK',
        data: { backup_path: backupPath, ...runtimeDataStatus() },
        msg: backupPath ? '运行数据已备份' : '暂无运行数据可备份',
      });
    }
    // 导出可迁移的备份包
    if (m === 'GET' && p === '/api/backup-export') {
      backupRuntimeData('export');
      const bundle = createRuntimeBackupBundle();
      const body = JSON.stringify(bundle, null, 2);
      const filename = `typeless-toolkit-backup-${new Date().toISOString().slice(0, 10)}.json`;
      applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return res.end(body);
    }
    // 从备份包恢复运行数据
    if (m === 'POST' && p === '/api/backup-restore') {
      const b = await readObjectBody(req, 128 * 1024 * 1024);
      const result = restoreRuntimeBackupBundle(b.bundle || b);
      return send(res, 200, { status: 'OK', msg: '备份已恢复', data: { ...result, ...runtimeDataStatus() } });
    }
    // 当前登录账号探测(不保存、不自动重启 Typeless;端口不通时返回结构化管理连接状态)
    if (m === 'GET' && p === '/api/current') {
      const connection = await typelessConnectionStatus();
      if (!connection.cdp_reachable) {
        return send(res, 200, {
          status: 'FAIL',
          code: 'MANAGEMENT_CONNECTION_REQUIRED',
          msg: 'Typeless 管理连接未开启',
          data: connection,
        });
      }
      try {
        const c = await captureTokenCDP(null, false);
        return send(res, 200, { status: 'OK', data: publicCapture(c) });
      }
      catch (e) {
        const latest = await typelessConnectionStatus();
        return send(res, 200, {
          status: 'FAIL',
          code: latest.cdp_reachable ? 'CURRENT_ACCOUNT_UNAVAILABLE' : 'MANAGEMENT_CONNECTION_REQUIRED',
          msg: latest.cdp_reachable ? e.message : 'Typeless 管理连接已断开',
          data: latest,
        });
      }
    }
    // 抓取当前账号(准备添加)
    if (m === 'POST' && p === '/api/capture') {
      try {
        const c = await captureTokenCDP();
        if (!c.user_id || !c.token) throw new Error('抓取结果缺少账号标识或 token');
        const captureId = putPendingCapture(c);
        return send(res, 200, { status: 'OK', data: publicCapture(c, captureId) });
      }
      catch (e) { return send(res, 500, { status: 'FAIL', msg: e.message }); }
    }
    // 保存账号
    if (m === 'POST' && p === '/api/accounts') {
      const b = await readObjectBody(req);
      if (!b.capture_id) return send(res, 400, { status: 'FAIL', msg: '账号抓取结果缺失,请重新抓取' });
      const captured = takePendingCapture(b.capture_id);
      assertSafeAccountId(captured.user_id);
      let meta = accountMetaFromUserInfo(captured.user_info, captured.user_id);
      if ((!captured.email || !captured.nickname || !captured.role) && captured.token) {
        try {
          const ui = await curlApi('GET', '/user/get_user_info', captured.token);
          meta = accountMetaFromUserInfo(ui.data || captured.user_info, captured.user_id);
        } catch (e) {}
      }
      const accs = readAccounts();
      const idx = accs.findIndex(x => x.user_id === captured.user_id);
      const nickname = boundedText(b.nickname, 120, '昵称');
      const email = boundedText(b.email, 254, '邮箱');
      const rec = {
        user_id: captured.user_id,
        nickname: nickname || email || meta.nickname || (captured.user_id || '').slice(0, 8),
        email: email || meta.email || '',
        role: captured.role || meta.role || '',
        token: captured.token, captured_at: captured.captured_at,
        added_at: idx >= 0 ? accs[idx].added_at : new Date().toISOString(),
      };
      if (idx >= 0) accs[idx] = rec; else accs.push(rec);
      writeAccounts(accs);
      saveSnapshot(captured.user_id); // 保存登录态快照,供切换账号用
      takePendingCapture(b.capture_id, true);
      return send(res, 200, { status: 'OK', data: publicAccount(rec) });
    }
    // 手动更新当前账号快照(当前 Typeless 登录态 -> 该账号)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/snapshot')) {
      const id = decodeURIComponent(p.split('/')[3]);
      saveSnapshot(id);
      return send(res, 200, { status: 'OK', msg: '快照已保存', has_snapshot: hasSnapshot(id) });
    }
    // 切换到此账号(还原快照 + 重启 Typeless)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/switch')) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!hasSnapshot(id)) return send(res, 400, { status: 'FAIL', msg: '该账号无快照,请先在 Typeless 登录该号后点「更新快照」' });
      killTypeless(); await sleep(1500);
      restoreSnapshot(id);
      launchTypeless();
      return send(res, 200, { status: 'OK', msg: '已切换并重启 Typeless' });
    }
    // 解除设备限制(重置设备 ID,准备注册新账号)
    if (m === 'POST' && p === '/api/reset-device') {
      const dataBackup = backupRuntimeData('reset-device');
      await resetDevice();
      return send(res, 200, { status: 'OK', msg: '设备已重置,Typeless 已以新设备 ID 启动(登录页),可注册新账号', manager_data_backup: dataBackup });
    }
    // 查询去弹窗补丁状态(只读)
    if (m === 'GET' && p === '/api/paywall-status') {
      return send(res, 200, { status: 'OK', data: paywallStatus() });
    }
    // Typeless 版本漂移状态(只读:当前版本 vs 上次见过的版本)
    if (m === 'GET' && p === '/api/version-status') {
      return send(res, 200, { status: 'OK', data: versionDriftStatus() });
    }
    // 确认已复验:把当前 Typeless 版本记为新基线,之后不再提示此版本
    if (m === 'POST' && p === '/api/version-ack') {
      const cur = getTypelessVersion();
      if (cur) writeVersionState(cur);
      return send(res, 200, { status: 'OK', data: versionDriftStatus() });
    }
    // 诊断 / 健康检查(只读聚合:路径/端口/登录/补丁状态/数据目录)
    if (m === 'GET' && p === '/api/diagnostics') {
      const ex = (x) => { try { return !!x && fs.existsSync(x); } catch (e) { return false; } };
      const connection = await typelessConnectionStatus();
      let writable = false; try { fs.accessSync(C.ROOT, fs.constants.W_OK); writable = true; } catch (e) {}
      let accCount = 0; try { accCount = readAccounts().length; } catch (e) {}
      const data = {
        typeless: {
          app_path: C.MAC_APP_PATH || '', app_found: ex(C.MAC_APP_PATH),
          bin_path: C.TYPELESS_BIN || '', bin_found: ex(C.TYPELESS_BIN),
          asar_path: ASAR_PATH || '', asar_found: ex(ASAR_PATH),
          info_plist: MAC_INFO_PLIST || '', info_plist_found: ex(MAC_INFO_PLIST),
          user_data_dir: C.USERDATA_DIR || '', user_data_found: ex(C.USERDATA_DIR),
        },
        cdp: { port: connection.port, reachable: connection.cdp_reachable, state: connection.state },
        data: {
          dir: C.ROOT, code_dir: C.CODE_DIR, writable,
          migration: C.RUNTIME_DATA.migration,
          accounts_file: C.ACCOUNTS_FILE, accounts_count: accCount,
          profiles_dir: C.PROFILES_DIR, runtime_backups_dir: C.RUNTIME_BACKUPS_DIR,
          backup: runtimeDataStatus(),
        },
      };
      return send(res, 200, { status: 'OK', data });
    }
    // 解除升级弹窗(打 app.asar + Info.plist 完整性补丁,失败自动从备份还原)
    if (m === 'POST' && p === '/api/patch-paywall') {
      const dataBackup = backupRuntimeData('patch-paywall');
      killTypeless(); await sleep(1500);
      try {
        const r = await patchPaywall();
        if (dataBackup) r.manager_data_backup = dataBackup;
        launchTypeless(); // 重启使补丁生效
        return send(res, 200, { status: 'OK', data: r });
      } catch (e) {
        // 文件恢复完全由本次补丁事务负责。只有确认不是 recovery_required 时才重启。
        if (e.rollback !== 'failed') {
          try { launchTypeless(); } catch (_) {}
        }
        return send(res, 500, {
          status: 'FAIL',
          msg: '打补丁失败:' + e.message,
          recovery_required: e.rollback === 'failed',
          transaction_id: e.transaction_id || null,
          manager_data_backup: dataBackup,
        });
      }
    }
    // 把主词库导入此账号(单向 master -> account,不导出)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/import-master')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const master = readMaster();
      const dl = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
      const have = new Set((dl.data?.words || []).map(w => termKey(w.term)));
      const missing = master.filter(w => !have.has(termKey(w)));
      let imported = 0;
      if (missing.length) {
        const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: missing.join('\n') });
        imported = safeCount(r.data?.success_count);
      }
      return send(res, 200, { status: 'OK', data: { master: master.length, already: master.length - missing.length, imported } });
    }
    // 从源账号复制词库到此账号
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.includes('/copy-from/')) {
      const parts = p.split('/');
      const dstId = decodeURIComponent(parts[3]);
      const srcId = decodeURIComponent(parts[5]);
      const accs = readAccounts();
      const src = accs.find(x => x.user_id === srcId);
      const dst = accs.find(x => x.user_id === dstId);
      if (!src || !dst) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const sl = await curlApi('GET', '/user/dictionary/list?size=500', src.token);
      const srcWords = (sl.data?.words || []).map(w => w.term).filter(Boolean);
      const dl = await curlApi('GET', '/user/dictionary/list?size=500', dst.token);
      const have = new Set((dl.data?.words || []).map(w => termKey(w.term)));
      const missing = srcWords.filter(w => !have.has(termKey(w)));
      let imported = 0;
      if (missing.length) {
        const r = await curlApi('POST', '/user/dictionary/bulk-import', dst.token, { content: missing.join('\n') });
        imported = safeCount(r.data?.success_count);
      }
      return send(res, 200, { status: 'OK', data: { src_count: srcWords.length, imported, already: srcWords.length - missing.length } });
    }
    // 删除账号
    if (m === 'DELETE' && /^\/api\/accounts\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split('/').pop());
      let accs = readAccounts();
      accs = accs.filter(x => x.user_id !== id);
      writeAccounts(accs);
      return send(res, 200, { status: 'OK' });
    }
    // 单账号词库
    if (m === 'GET' && p.startsWith('/api/accounts/') && p.endsWith('/dictionary')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const dl = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
      return send(res, 200, { status: 'OK', data: publicDictionary(dl.data) });
    }
    // 单账号同步
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/sync')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const r = await syncAccount(acc);
      return send(res, 200, { status: 'OK', data: r });
    }
    // 全部同步
    if (m === 'POST' && p === '/api/sync-all') {
      const accs = readAccounts();
      const results = [];
      for (const a of accs) {
        try { results.push({ user_id: a.user_id, nickname: a.nickname, ...(await syncAccount(a)) }); }
        catch (e) { results.push({ user_id: a.user_id, nickname: a.nickname, error: e.message }); }
      }
      return send(res, 200, { status: 'OK', data: results });
    }
    // 给账号批量加词(多行,复用 bulk-import)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/words')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const b = await readObjectBody(req);
      const terms = Array.isArray(b.terms) ? b.terms.map(s => String(s || '').trim()).filter(Boolean) : [];
      if (!terms.length) return send(res, 400, { status: 'FAIL', msg: '没有可添加的词' });
      const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: terms.join('\n') });
      return send(res, 200, { status: 'OK', data: { requested: terms.length, imported: safeCount(r.data?.success_count) } });
    }
    // 给账号加单个词
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const b = await readObjectBody(req);
      const term = boundedText(b.term, 500, '词条');
      if (!term) return send(res, 400, { status: 'FAIL', msg: '词条不能为空' });
      await curlApi('POST', '/user/dictionary/add', acc.token, { term });
      return send(res, 200, { status: 'OK', data: { term } });
    }
    // 删账号单个词(按 term)
    if (m === 'DELETE' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      const term = u.searchParams.get('term');
      const dl = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
      const w = (dl.data?.words || []).find(x => x.term === term);
      if (!w) return send(res, 404, { status: 'FAIL', msg: '词条不存在' });
      await curlApi('POST', '/user/dictionary/delete', acc.token, { user_dictionary_id: w.user_dictionary_id });
      let stillExists = true;
      let absentHits = 0;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        const check = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
        if (!Array.isArray(check.data?.words)) continue;
        stillExists = check.data.words.some(x => x.term === term);
        absentHits = stillExists ? 0 : absentHits + 1;
        if (absentHits >= 2) break;
      }
      if (stillExists) return send(res, 500, { status: 'FAIL', msg: '删除请求已发送,但词条仍存在' });
      return send(res, 200, { status: 'OK', data: { term } });
    }
    // 主 CSV
    if (m === 'GET' && p === '/api/master') return send(res, 200, { status: 'OK', data: readMaster() });
    if (m === 'POST' && p === '/api/master') {
      const b = await readObjectBody(req);
      if (!Array.isArray(b.terms)) throw new LocalApiError(400, 'INVALID_INPUT', 'terms 必须是数组');
      const t = writeMaster(b.terms.map((term) => String(term || '')));
      return send(res, 200, { status: 'OK', data: t });
    }
    // 启动 Typeless:已带调试端口则不动,否则以调试端口启动(若已开不带端口会重启带端口)
    if (m === 'POST' && p === '/api/launch') {
      const connection = await ensureApp();
      return send(res, 200, { status: 'OK', msg: 'Typeless 管理连接已建立', data: connection });
    }
    send(res, 404, { status: 'FAIL', msg: 'not found: ' + p });
  } catch (e) {
    const code = e instanceof LocalApiError ? e.statusCode : 500;
    send(res, code, { status: 'FAIL', code: e.code || 'INTERNAL_ERROR', msg: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[mgr] 端口 ${PORT} 已被占用。如果管理器已经打开,直接访问 http://127.0.0.1:${PORT}`);
    process.exit(1);
  }
  throw e;
});

server.on('clientError', (_error, socket) => {
  if (!socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

function startServer() {
  server.listen(PORT, '127.0.0.1', () => { log('[mgr] 管理器运行于 http://127.0.0.1:' + PORT); });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  publicAccount,
  publicCapture,
  publicDictionary,
  publicLiveStatus,
  safeCount,
  security,
  server,
  startServer,
};
