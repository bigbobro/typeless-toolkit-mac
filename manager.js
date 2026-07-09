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
const { execFileSync } = require('child_process');

const C = require('./lib/common');
const {
  config, CDP_PORT, ASAR_PATH, MAC_INFO_PLIST,
  readAccounts, writeAccounts,
  backupRuntimeData, runtimeDataStatus, createRuntimeBackupBundle, restoreRuntimeBackupBundle,
  saveSnapshot, restoreSnapshot, hasSnapshot,
  killTypeless, launchTypeless, resetDevice,
  readMaster, writeMaster,
  curlApi, ensureApp, captureTokenCDP,
  liveStatus, syncAccount,
  paywallStatus, patchPaywall,
  accountMetaFromUserInfo,
  termKey,
  log, sleep,
} = C;

const PORT = config.manager_port;

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname; const m = req.method;
  try {
    // 前端首页
    if (m === 'GET' && (p === '/' || p === '/index.html' || p === '/manager.html')) {
      const html = fs.readFileSync(path.join(C.CODE_DIR, 'manager.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // 账号列表(含实时状态)
    if (m === 'GET' && p === '/api/accounts') {
      const accs = readAccounts();
      const live = await Promise.all(accs.map(a => liveStatus(a).catch(e => ({ token_valid: false, _err: e.message }))));
      const data = accs.map((a, i) => ({ ...a, live: live[i], has_snapshot: hasSnapshot(a.user_id) }));
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
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return res.end(body);
    }
    // 从备份包恢复运行数据
    if (m === 'POST' && p === '/api/backup-restore') {
      const b = await readBody(req);
      const result = restoreRuntimeBackupBundle(b.bundle || b);
      return send(res, 200, { status: 'OK', msg: '备份已恢复', data: { ...result, ...runtimeDataStatus() } });
    }
    // 当前登录账号探测(不保存,不重启 Typeless:autoRestart=false,端口不通就报未连接)
    if (m === 'GET' && p === '/api/current') {
      try { const c = await captureTokenCDP(null, false); return send(res, 200, { status: 'OK', data: c }); }
      catch (e) { return send(res, 200, { status: 'FAIL', msg: e.message }); }
    }
    // 抓取当前账号(准备添加)
    if (m === 'POST' && p === '/api/capture') {
      try { const c = await captureTokenCDP(); return send(res, 200, { status: 'OK', data: c }); }
      catch (e) { return send(res, 500, { status: 'FAIL', msg: e.message }); }
    }
    // 保存账号
    if (m === 'POST' && p === '/api/accounts') {
      const b = await readBody(req);
      if (!b.user_id || !b.token) return send(res, 400, { status: 'FAIL', msg: '缺少 user_id 或 token,请重新添加当前账号' });
      let meta = accountMetaFromUserInfo(b.user_info, b.user_id);
      if ((!b.email || !b.nickname || !b.role) && b.token) {
        try {
          const ui = await curlApi('GET', '/user/get_user_info', b.token);
          meta = accountMetaFromUserInfo(ui.data || b.user_info, b.user_id);
        } catch (e) {}
      }
      const accs = readAccounts();
      const idx = accs.findIndex(x => x.user_id === b.user_id);
      const rec = {
        user_id: b.user_id,
        nickname: b.nickname || b.email || meta.nickname || (b.user_id || '').slice(0, 8),
        email: b.email || meta.email || '',
        role: b.role || meta.role || '',
        token: b.token, captured_at: b.captured_at,
        added_at: idx >= 0 ? accs[idx].added_at : new Date().toISOString(),
      };
      if (idx >= 0) accs[idx] = rec; else accs.push(rec);
      writeAccounts(accs);
      saveSnapshot(b.user_id); // 保存登录态快照,供切换账号用
      return send(res, 200, { status: 'OK', data: rec });
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
    // 诊断 / 健康检查(只读聚合:路径/端口/登录/补丁状态/数据目录)
    if (m === 'GET' && p === '/api/diagnostics') {
      const ex = (x) => { try { return !!x && fs.existsSync(x); } catch (e) { return false; } };
      let cdpReachable = false;
      try { const rr = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); cdpReachable = rr.ok; } catch (e) {}
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
        cdp: { port: CDP_PORT, reachable: cdpReachable },
        data: {
          dir: C.ROOT, writable,
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
        const r = patchPaywall();
        if (dataBackup) r.manager_data_backup = dataBackup;
        launchTypeless(); // 重启使补丁生效
        return send(res, 200, { status: 'OK', data: r });
      } catch (e) {
        // 失败则从备份还原,避免半改导致闪退
        try { if (fs.existsSync(ASAR_PATH + '.bak')) fs.copyFileSync(ASAR_PATH + '.bak', ASAR_PATH); } catch (_) {}
        try { if (MAC_INFO_PLIST && fs.existsSync(MAC_INFO_PLIST + '.bak')) fs.copyFileSync(MAC_INFO_PLIST + '.bak', MAC_INFO_PLIST); } catch (_) {}
        try { if (C.MAC_APP_PATH) execFileSync('codesign', ['--force', '--deep', '--sign', '-', C.MAC_APP_PATH], { stdio: 'ignore' }); } catch (_) {}
        return send(res, 500, { status: 'FAIL', msg: '打补丁失败:' + e.message + '(已从备份还原)', manager_data_backup: dataBackup });
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
        imported = r.data?.success_count ?? 0;
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
        imported = r.data?.success_count ?? 0;
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
      return send(res, 200, { status: 'OK', data: dl.data || { words: [] } });
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
    // 给账号加单个词
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      const b = await readBody(req);
      const r = await curlApi('POST', '/user/dictionary/add', acc.token, { term: b.term });
      return send(res, 200, { status: 'OK', data: r.data });
    }
    // 删账号单个词(按 term)
    if (m === 'DELETE' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      const term = u.searchParams.get('term');
      const dl = await curlApi('GET', '/user/dictionary/list?size=500', acc.token);
      const w = (dl.data?.words || []).find(x => x.term === term);
      if (!w) return send(res, 404, { status: 'FAIL', msg: '词条不存在' });
      const r = await curlApi('POST', '/user/dictionary/delete', acc.token, { user_dictionary_id: w.user_dictionary_id });
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
      if (stillExists) return send(res, 500, { status: 'FAIL', msg: '删除请求已发送,但词条仍存在', data: r.data });
      return send(res, 200, { status: 'OK', data: r.data });
    }
    // 主 CSV
    if (m === 'GET' && p === '/api/master') return send(res, 200, { status: 'OK', data: readMaster() });
    if (m === 'POST' && p === '/api/master') {
      const b = await readBody(req); const t = writeMaster(b.terms || []);
      return send(res, 200, { status: 'OK', data: t });
    }
    // 启动 Typeless:已带调试端口则不动,否则以调试端口启动(若已开不带端口会重启带端口)
    if (m === 'POST' && p === '/api/launch') {
      await ensureApp();
      return send(res, 200, { status: 'OK', msg: 'Typeless 已就绪(调试端口 ' + CDP_PORT + ')' });
    }
    send(res, 404, { status: 'FAIL', msg: 'not found: ' + p });
  } catch (e) { send(res, 500, { status: 'FAIL', msg: e.message }); }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[mgr] 端口 ${PORT} 已被占用。如果管理器已经打开,直接访问 http://127.0.0.1:${PORT}`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => { log('[mgr] 管理器运行于 http://127.0.0.1:' + PORT); });
