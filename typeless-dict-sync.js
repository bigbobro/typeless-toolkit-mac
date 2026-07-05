#!/usr/bin/env node
/**
 * Typeless 个人词库跨账号同步脚本
 *
 * 作用:让多个 Typeless 账号共享同一份个人词库(含系统自动学习的 auto 词)。
 *   - 导出当前登录账号的全部词库词条 → 合并进主 CSV
 *   - 把主 CSV 中该账号还缺的词 → 批量导入该账号
 *   两个方向都做,结果:所有账号词库 == 主 CSV(并集),换号不丢词。
 *
 * 原理:通过 CDP 连接运行中的 Typeless,借应用启动时的鉴权请求抓取 token
 *   (长效 JWT,约 1 年有效),再用 https://api.typeless.com 的词库 API 操作。
 *   token 每次运行重新抓取,自动适配当前登录的账号。
 *
 * 用法:
 *   1. 用 --remote-debugging-port=9222 启动 Typeless(见「启动Typeless(带调试端口).command」)。
 *   2. node typeless-dict-sync.js
 *
 * 注意:脚本会重载一次主窗口以抓取 token;词库同步对账号无破坏性(只增不删)。
 *
 * 共享逻辑已抽到 ./lib/common.js。
 */
const path = require('path');
// 用绝对路径 require,确保 cwd 无关
const C = require(path.join(__dirname, 'lib', 'common'));
const { curlApi, ensureApp, captureTokenCDP, readMaster, writeMaster, log } = C;

// ---------- 词库 API(基于共享 curlApi) ----------
async function exportWords(token) {
  const r = await curlApi('GET', '/user/dictionary/list?size=500', token);
  if (r.status !== 'OK') throw new Error('导出失败: ' + JSON.stringify(r).slice(0, 200));
  return (r.data.words || []).map(w => w.term).filter(Boolean);
}
async function importWords(token, terms) {
  if (!terms.length) return { skipped: true };
  const r = await curlApi('POST', '/user/dictionary/bulk-import', token, { content: terms.join('\n') });
  if (r.status !== 'OK') throw new Error('导入失败: ' + JSON.stringify(r).slice(0, 200));
  return r.data;
}

// ---------- 主流程 ----------
async function main() {
  log('[sync] 主 CSV:', C.MASTER_CSV);
  // 0. 确保 Typeless 带调试端口运行
  await ensureApp();
  // 1. 抓 token(注入捕获 + 重载 + 读 window.__captured)
  log('[sync] 正在通过 CDP 抓取当前账号 token(会重载一次主窗口)…');
  const { token, origin, user_id } = await captureTokenCDP();
  log('[sync] 已连接:', origin, '账号 user_id:', user_id);

  // 2. 导出当前账号词库
  const accountWords = await exportWords(token);
  log('[sync] 当前账号已有词库:', accountWords.length, '条');

  // 3. 合并进主 CSV(account → master)
  const masterBefore = readMaster();
  const masterMerged = writeMaster([...masterBefore, ...accountWords]);
  log('[sync] 主 CSV 合并后:', masterMerged.length, '条(新增', masterMerged.length - masterBefore.length, ')');

  // 4. 把主 CSV 里该账号缺的词导入(master → account)
  const accountSet = new Set(accountWords);
  const missing = masterMerged.filter(w => !accountSet.has(w));
  log('[sync] 待导入该账号:', missing.length, '条');
  if (missing.length) {
    const res = await importWords(token, missing);
    if (res.skipped) log('[sync]   无需导入');
    else log('[sync]   导入结果: success=', res.success_count, 'failed=', res.failed_count);
  }
  log('[sync] 同步完成。各账号词库已对齐到主 CSV。');
}

main().catch(e => { console.error('[sync] 失败:', e.message); process.exit(1); });
