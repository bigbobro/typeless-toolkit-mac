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
 * 同步本身完全复用 lib/common.js 的 syncAccount()——与管理器走同一套词条归一化
 * (termKey:去首尾空白 + 大小写折叠),避免两份实现对「什么算同一个词」判断不一致。
 */
const path = require('path');
// 用绝对路径 require,确保 cwd 无关
const C = require(path.join(__dirname, 'lib', 'common'));
const { ensureApp, captureTokenCDP, readMaster, syncAccount, log } = C;

// ---------- 主流程 ----------
async function main() {
  log('[sync] 主 CSV:', C.MASTER_CSV);
  // 0. 确保 Typeless 带调试端口运行
  await ensureApp();
  // 1. 抓 token(注入捕获 + 重载 + 读 window.__captured)
  log('[sync] 正在通过 CDP 抓取当前账号 token(会重载一次主窗口)…');
  const { token, origin, user_id } = await captureTokenCDP();
  log('[sync] 已连接:', origin, '账号 user_id:', user_id);

  // 2. 同步(导出账号词库 → 合并进主 CSV → 把主 CSV 里缺的词补回账号)
  const masterBefore = readMaster().length;
  const r = await syncAccount({ token, user_id });
  log('[sync] 当前账号已有词库:', r.exported, '条');
  log('[sync] 主 CSV 合并后:', r.master_count, '条(新增', r.master_count - masterBefore, ')');
  log('[sync] 已补回该账号:', r.imported, '条');
  log('[sync] 同步完成。各账号词库已对齐到主 CSV。');
}

main().catch(e => { console.error('[sync] 失败:', e.message); process.exit(1); });
