'use strict';

/**
 * 去弹窗补丁 —— 对 Typeless.app 的 app.asar 做等长字节替换
 *
 * 全项目风险最高的一段:直接改一个已签名的 macOS 应用。要同时骗过三道校验,
 * 少改一处 Typeless 就闪退:
 *   1. asar 头里该文件的 per-file SHA-256(integrity.hash 与 blocks[0],共 2 处)
 *   2. Info.plist 的 ElectronAsarIntegrity —— 整个 asar 头的 SHA-256
 *   3. macOS 代码签名 —— 改完必须 ad-hoc 重签
 *
 * 「等长」是硬约束:替换串与原串必须字节数完全相等(gn(x) 与 (0,x) 都是 5 字节)。
 * 失败模式不是偏移错位 —— 替换是定长 buffer 内的原地覆写(to.copy(content, i)),
 * 写回时 size 与 offset 都不变。长度不等的真实后果是:短了留半截旧串、长了吃掉相邻
 * 代码,而随后的 per-file hash、asar 头 hash、重签名全部按损坏后的内容重算并通过
 * —— 补丁报「已打好」,renderer 其实已经坏了。所以等长必须在写入前就挡住。
 *
 * 所有写入都先在 os.tmpdir() 的候选文件上完成,再由 lib/patch-transaction.js
 * 以 before-image + 原子替换 + 验证 + 精确回滚的事务方式提交。
 *
 * 从 lib/common.js 抽出。除 readAsarHeader 由两处重复代码合并而来外,逻辑未变。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  hashFile,
  listPatchBackups,
  recoverIncompletePatchTransactions,
  runPatchTransaction,
} = require('./patch-transaction');

// asar 布局:[0..8) pickle 头 | [8..12) header 大小 | [12..16) header JSON 长度
//           | [16..16+jsonLength) header JSON | 4 字节对齐后是数据区
// 这里算错一个字节,写回去的 app.asar 内所有文件偏移都会错位 → Typeless 闪退。
function readAsarHeader(buf) {
  const jsonLength = buf.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + jsonLength;
  const dataStart = headerEnd + (headerEnd % 4 ? 4 - (headerEnd % 4) : 0);
  return {
    header: JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8')),
    headerStart,
    headerEnd,
    dataStart,
  };
}

// ---------- 弹窗补丁(两层 asar 完整性) ----------
// 自动探测 asar 内可能包含 paywall 分支的 renderer 目标文件
function detectPaywallFile(header) {
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) { walk(child, p); }
      else if (child.offset !== undefined && /\.(mjs|js)$/i.test(name)) found.push(p);
    }
  };
  walk(header, '');
  return found; // 相对路径数组(用 / 分隔)
}

function getAsarNode(header, filePath) {
  let node = header;
  for (const k of filePath) {
    if (!node || !node.files) return null;
    node = node.files[k];
  }
  return node || null;
}

function scorePaywallCandidate(rel, content) {
  const text = content.toString('utf8');
  let score = 0;
  if (/dist\/renderer\/static\/js\//.test(rel)) score += 10;
  if (/\[['"]type['"]\]\s*===\s*['"]paywall['"]/.test(text)) score += 100;
  if (/onImportantNotification|onSessionInterrupt|ImportantNotification|SessionInterrupt/.test(text)) score += 50;
  if (/paywall/i.test(text)) score += 1;
  return score;
}

function findPaywallTarget(header, buf, dataStart) {
  let best = null;
  for (const rel of detectPaywallFile(header)) {
    const parts = rel.split('/');
    const node = getAsarNode(header, parts);
    if (!node) continue;
    const off = dataStart + (+node.offset), sz = node.size;
    const content = buf.subarray(off, off + sz);
    const score = scorePaywallCandidate(rel, content);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { parts, node, score };
  }
  return best;
}

// 等长必须在写入前挡住(原因见文件头注释)。
// 自动识别分支扫到不等长的候选时 continue 跳过就够了 —— 那只是没选中它;
// 但 config 显式配置的不等长替换必须报错:静默丢弃会让用户以为配置生效了,
// 最终要么被自动识别的结果顶替、要么报「未配置且未自动识别到」这种答非所问的错。
function assertEqualByteLength(pairs) {
  for (const [from, to] of pairs) {
    const fromBytes = Buffer.byteLength(from, 'utf8');
    const toBytes = Buffer.byteLength(to, 'utf8');
    if (fromBytes !== toBytes) {
      throw new Error(
        'paywall 替换必须等长:"' + from + '"(' + fromBytes + ' 字节) → "' + to + '"(' + toBytes + ' 字节)。'
        + '长度不等会原地写坏 renderer,而补丁仍会报成功。'
        + '请修正稳定数据目录 config.local.json 里的 paywall.replacements。'
      );
    }
  }
  return pairs;
}

function getEffectivePaywallReplacements(content, paywallConfig) {
  const config = { paywall: paywallConfig };
  const configured = assertEqualByteLength(
    (config.paywall.replacements || []).filter(x => x && x.length === 2)
  );
  if (configured.length) {
    const allConfiguredExist = configured.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    if (allConfiguredExist) return { replacements: configured, source: 'config' };
  }
  if (!config.paywall.auto_detect_replacements) return { replacements: configured, source: 'config' };

  const text = content.toString('utf8');
  const re = /if\(([$_A-Za-z][$_A-Za-z0-9]*)\['type'\]==='paywall'\)(?:([$_A-Za-z][$_A-Za-z0-9]*)\(\1\)|\(0,\1\));else/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const from = m[2] ? `${m[2]}(${m[1]})` : `__already_patched_paywall__(${m[1]})`;
    const to = `(0,${m[1]})`;
    if (m[2] && from.length !== to.length) continue;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push([from, to]);
  }
  if (out.length) return { replacements: out, source: 'auto' };
  return { replacements: configured, source: 'config' };
}


/**
 * @param {object} deps 由 lib/common.js 注入的路径与配置
 * @param {object} deps.paywallConfig  config.paywall(file_path / replacements / auto_detect_*)
 * @param {string} deps.asarPath       Typeless.app/Contents/Resources/app.asar
 * @param {string} deps.infoPlist      Typeless.app/Contents/Info.plist
 * @param {string} deps.appPath        Typeless.app
 * @param {string} deps.typelessBin    Typeless 可执行文件
 * @param {string} deps.patchBackupsDir  patch-backups/(事务 before-image 落点)
 * @param {function(): (string|null)} deps.getAppVersion  读当前 Typeless 版本,用于给备份打标
 */
function createPaywallPatch({
  paywallConfig, asarPath, infoPlist, appPath, typelessBin, patchBackupsDir, getAppVersion,
}) {
  const config = { paywall: paywallConfig };
  const ASAR_PATH = asarPath;
  const MAC_INFO_PLIST = infoPlist;
  const MAC_APP_PATH = appPath;
  const TYPELESS_BIN = typelessBin;
  const PATCH_BACKUPS_DIR = patchBackupsDir;
  const getTypelessVersion = getAppVersion;

  function updateMacAsarIntegrityHash(newHeaderHash, plistPath = MAC_INFO_PLIST) {
    if (!plistPath || !fs.existsSync(plistPath)) throw new Error('Info.plist 未找到,无法更新 macOS asar 完整性');
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHeaderHash}`,
      plistPath,
    ]);
  }

  function readMacAsarIntegrityHash(plistPath = MAC_INFO_PLIST) {
    if (!plistPath || !fs.existsSync(plistPath)) return null;
    try {
      return execFileSync('/usr/libexec/PlistBuddy', [
        '-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', plistPath,
      ], { encoding: 'utf8' }).trim() || null;
    } catch (_) { return null; }
  }

  function resignMacApp(appPath = MAC_APP_PATH) {
    if (!appPath || !fs.existsSync(appPath)) throw new Error('Typeless.app 未找到,无法重新签名');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' });
  }

  function verifyMacApp(appPath = MAC_APP_PATH) {
    if (!appPath || !fs.existsSync(appPath)) throw new Error('Typeless.app 未找到,无法验证签名');
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
  }

  function asarToTmp() {
    const tmp = path.join(os.tmpdir(), `tt_asar_${process.pid}_${Date.now()}.bin`);
    fs.copyFileSync(ASAR_PATH, tmp);
    return tmp;
  }

  // 只读检测:app.asar 内目标文件是否已打过补丁
  function paywallStatus() {
    if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) return { exists: false, error: 'app.asar 未找到(Typeless.app 路径未配置?)' };
    let tmpAsar = null;
    try {
      tmpAsar = asarToTmp();
      const buf = fs.readFileSync(tmpAsar);
      const { header, dataStart } = readAsarHeader(buf);

      // 确定目标文件路径:先用 config 的 file_path,找不到则自动探测
      let filePath = config.paywall.file_path;
      let detected = false;
      let node = filePath.length ? getAsarNode(header, filePath) : null;
      if (!node && config.paywall.auto_detect_file) {
        const target = findPaywallTarget(header, buf, dataStart);
        if (target) { filePath = target.parts; node = target.node; detected = true; }
      }
      if (!node) {
        return {
          exists: true, patched: false,
          error: 'asar 内未找到目标文件(config.paywall.file_path 不匹配,且自动探测未找到含 paywall 的 .mjs)。' +
                 '请阅读 README「去升级 / 会员弹窗」一节,并在稳定数据目录的 config.local.json 里配置 paywall.file_path / paywall.replacements',
        };
      }
      const foff = dataStart + (+node.offset), size = node.size;
      const content = buf.subarray(foff, foff + size);
      // 检查所有替换标记
      const effective = getEffectivePaywallReplacements(content, config.paywall);
      const repls = effective.replacements;
      if (!repls.length) {
        return {
          exists: true,
          patched: false,
          detected_file: detected ? filePath.join('/') : null,
          file_path: filePath.join('/'),
          replacements_source: effective.source,
          replacements: repls,
          has_backup: listPatchBackups(PATCH_BACKUPS_DIR).length > 0
            || (fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak')),
          error: '未配置且未自动识别到 paywall 替换标记',
        };
      }
      const hasOld = repls.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
      const hasNew = repls.every(([, to]) => content.includes(Buffer.from(to, 'utf8')));
      return {
        exists: true,
        patched: !hasOld && hasNew,
        detected_file: detected ? filePath.join('/') : null,
        file_path: filePath.join('/'),
        replacements_source: effective.source,
        replacements: repls,
        has_backup: listPatchBackups(PATCH_BACKUPS_DIR).length > 0
          || (fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(MAC_INFO_PLIST + '.bak')),
      };
    } catch (e) { return { exists: false, error: e.message }; }
    finally { if (tmpAsar) try { fs.unlinkSync(tmpAsar); } catch (e) {} }
  }

  // 执行补丁:内容替换 + 同步 per-file SHA256 + 同步平台完整性记录
  function patchPaywall() {
    if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) throw new Error('app.asar 未找到(Typeless 路径未配置?)');
    if (!TYPELESS_BIN || !fs.existsSync(TYPELESS_BIN)) throw new Error('Typeless 可执行文件未找到');
    if (!MAC_INFO_PLIST || !fs.existsSync(MAC_INFO_PLIST)) throw new Error('Info.plist 未找到,无法同步 macOS asar 完整性');
    const originalAsarHash = hashFile(ASAR_PATH);
    const originalPlistHash = hashFile(MAC_INFO_PLIST);
    const appVersion = getTypelessVersion();
    // 在临时非 .asar 文件上准备候选,原 App 在事务提交前保持不变。
    const tmpAsar = asarToTmp();
    const tmpPlist = path.join(os.tmpdir(), `tt_plist_${process.pid}_${Date.now()}.plist`);
    let fd = null;
    try {
      fs.copyFileSync(MAC_INFO_PLIST, tmpPlist);
      fd = fs.openSync(tmpAsar, 'r+');
      const fsize = fs.statSync(tmpAsar).size;
      const buf = Buffer.alloc(fsize);
      fs.readSync(fd, buf, 0, fsize, 0);
      const { header, headerStart, headerEnd, dataStart } = readAsarHeader(buf);

      // 定位目标文件(同 paywallStatus 逻辑)
      let filePath = config.paywall.file_path;
      let node = filePath.length ? getAsarNode(header, filePath) : null;
      if (!node && config.paywall.auto_detect_file) {
        const target = findPaywallTarget(header, buf, dataStart);
        if (target) { filePath = target.parts; node = target.node; }
      }
      if (!node) throw new Error('asar 内未找到目标文件,请阅读 README「去升级 / 会员弹窗」一节,并在稳定数据目录的 config.local.json 里配置 paywall.file_path / paywall.replacements');

      const foff = dataStart + (+node.offset), size = node.size;
      const oldHash = node.integrity.hash;
      const content = Buffer.from(buf.subarray(foff, foff + size));

      const effective = getEffectivePaywallReplacements(content, config.paywall);
      const repls = effective.replacements.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
      if (!repls.length) throw new Error('未配置且未自动识别到 paywall 替换标记');
      // 幂等:已打过则跳过
      const alreadyPatched = repls.every(([from], i) => !content.includes(from) && content.includes(repls[i][1]));
      if (alreadyPatched) {
        return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
      }

      // 1) 内容补丁(等长替换)
      for (const [from, to] of repls) {
        const i = content.indexOf(from);
        if (i < 0) throw new Error(
          '未找到标记 ' + from.toString() + ',你的 Typeless 版本可能不同。' +
          '请阅读 README「去升级 / 会员弹窗」一节,并在稳定数据目录的 config.local.json 里配置 paywall.file_path / paywall.replacements'
        );
        if (i !== content.lastIndexOf(from)) throw new Error('标记不唯一(异常):' + from.toString());
        to.copy(content, i);
      }
      const newHash = crypto.createHash('sha256').update(content).digest('hex');

      // 2) 旧 asar 头 SHA256,也就是 Info.plist 里现存的 ElectronAsarIntegrity hash
      const oldHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

      // 3) 头里替换 per-file hash(integrity.hash 与 blocks[0],共 2 处,等长 64 hex)
      const headerBuf = buf.subarray(headerStart, headerEnd);
      const oldHB = Buffer.from(oldHash, 'utf8'), newHB = Buffer.from(newHash, 'utf8');
      if (oldHB.length !== newHB.length) throw new Error('hash 长度不一致(异常)');
      let cnt = 0, idxs = [], p = headerBuf.indexOf(oldHB);
      while (p >= 0) { cnt++; idxs.push(p); p = headerBuf.indexOf(oldHB, p + 1); }
      if (cnt !== 2) throw new Error('头里旧 per-file hash 出现 ' + cnt + ' 次,预期 2 次(asar 结构异常)');
      for (const pp of idxs) newHB.copy(headerBuf, pp);

      // 4) 新整头 SHA256(头里 per-file 已改)
      const newHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

      // 5) 写回临时 asar 的内容区 + 头区
      fs.writeSync(fd, content, 0, size, foff);
      fs.writeSync(fd, headerBuf, 0, headerBuf.length, headerStart);
      fs.closeSync(fd);
      fd = null;

      // 6) 先把 Info.plist 候选准备好,再通过本次事务统一替换、签名和验证。
      updateMacAsarIntegrityHash(newHeaderHash, tmpPlist);
      const transaction = runPatchTransaction({
        backupRoot: PATCH_BACKUPS_DIR,
        label: 'paywall',
        appVersion,
        files: [
          {
            name: 'app.asar',
            livePath: ASAR_PATH,
            candidatePath: tmpAsar,
            expectedOriginalSha256: originalAsarHash,
          },
          {
            name: 'Info.plist',
            livePath: MAC_INFO_PLIST,
            candidatePath: tmpPlist,
            expectedOriginalSha256: originalPlistHash,
          },
        ],
        afterReplace: () => resignMacApp(),
        verify: () => {
          if (readMacAsarIntegrityHash() !== newHeaderHash) throw new Error('Info.plist asar 完整性校验失败');
          verifyMacApp();
          const status = paywallStatus();
          if (!status.patched) throw new Error(status.error || '补丁标记验证失败');
        },
        afterRollback: () => resignMacApp(),
        verifyAfterRollback: () => verifyMacApp(),
        retention: 3,
      });

      return {
        already: false, done: true,
        transaction_id: transaction.transaction_id,
        transaction_backup: transaction.backup_dir,
        replacements_source: effective.source,
        replacements: effective.replacements,
        plist: MAC_INFO_PLIST,
        signed: true,
        file_hash: { old: oldHash, new: newHash },
        header_hash: { old: oldHeaderHash, new: newHeaderHash },
        msg: '补丁已打好,升级/会员弹窗将不再弹出(重启 Typeless 生效)',
      };
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(tmpAsar); } catch (_) {}
      try { fs.unlinkSync(tmpPlist); } catch (_) {}
    }
  }

  // 模块加载时处理上次被 SIGKILL / 断电打断的补丁事务,再对外提供任何能力。
  function recoverInterruptedPatches() {
    return recoverIncompletePatchTransactions({
      backupRoot: PATCH_BACKUPS_DIR,
      afterRecovery: () => resignMacApp(),
      verifyAfterRecovery: () => verifyMacApp(),
    });
  }

  return { paywallStatus, patchPaywall, recoverInterruptedPatches };
}

module.exports = {
  createPaywallPatch,
  // 纯函数,导出供单测直接验证
  readAsarHeader,
  detectPaywallFile,
  getAsarNode,
  scorePaywallCandidate,
  findPaywallTarget,
  getEffectivePaywallReplacements,
};
