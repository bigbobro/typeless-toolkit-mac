'use strict';

/**
 * 私有文件原语 —— 运行数据的落盘规矩
 *
 * 这里的每个函数都在维护同一条不变量:管理器写出的任何东西(账号 token、登录态
 * 快照、词库、备份)都只有当前 macOS 用户能读,目录 0700 / 文件 0600,且写入要么
 * 完整生效要么完全没发生。
 *
 * 收编范围:lib/common.js、lib/runtime-data.js、lib/patch-transaction.js、
 * lib/runtime-backup.js 都依赖这一层,不再各自维护平行实现。
 *
 * 本模块只依赖 Node 标准库,不 require 任何上层模块 —— 否则会与 runtime-data 成环。
 * 需要抛特定错误类型的调用方通过 onInvalid / onUnsupported 注入自己的错误工厂。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fileStamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

function safeName(value, fallback = 'backup') {
  return String(value || fallback)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

/**
 * 严格语义:存在则先 lstat 校验,不存在才 mkdir。
 *
 * 此前 private-fs 与 runtime-data 各有一个**同名但契约相反**的 ensurePrivateDirectory:
 * 前者直接 mkdirSync(宽松),后者先校验目标是不是符号链接或非目录(严格)。同名反契约
 * 是真陷阱 —— 读调用点看不出拿到的是哪一个,而两者对「目标是符号链接」的处理完全相反。
 * 统一到严格语义:符号链接指向仓库外时,宽松版会顺着链接把权限改到别处去。
 */
function ensurePrivateDirectory(dirPath, { onInvalid } = {}) {
  if (fs.existsSync(dirPath)) {
    const stat = fs.lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw onInvalid
        ? onInvalid(dirPath)
        : new Error(`运行数据路径不是私有目录: ${dirPath}`);
    }
  } else {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dirPath, 0o700);
}

// 递归收紧权限。runtime-data 此前有一份逐行等价的 secureEntry,差别只在错误类型与文案。
function secureTree(entryPath, { onUnsupported } = {}) {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.lstatSync(entryPath);
  const reject = (kind) => {
    throw onUnsupported
      ? onUnsupported(entryPath, kind)
      : new Error(kind === 'symlink'
        ? `运行数据不允许符号链接: ${entryPath}`
        : `运行数据包含不支持的文件类型: ${entryPath}`);
  };
  if (stat.isSymbolicLink()) reject('symlink');
  if (stat.isFile()) { fs.chmodSync(entryPath, 0o600); return; }
  if (!stat.isDirectory()) reject('unsupported');
  fs.chmodSync(entryPath, 0o700);
  for (const name of fs.readdirSync(entryPath)) {
    secureTree(path.join(entryPath, name), { onUnsupported });
  }
}

function writePrivateFileAtomic(filePath, content) {
  ensurePrivateDirectory(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

function writePrivateJson(filePath, value) {
  writePrivateFileAtomic(filePath, JSON.stringify(value, null, 2));
}

// 「拷一份然后立刻收权限」—— common.js 里手写过三遍。
// 注意不适用于往 Typeless 自己的用户数据目录拷回快照(restoreSnapshot):那不是我们的
// 私有数据,不该被改成 0600。
function copyPrivateFile(src, dst) {
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
}

// 流式 SHA-256(1MB 缓冲)。此前在 runtime-data.js 与 patch-transaction.js 各有一份
// 逐字节相同的实现,还害得 runtime-backup 只为拿这一个函数就去 require 补丁事务模块。
function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

module.exports = {
  fileStamp,
  safeName,
  ensurePrivateDirectory,
  secureTree,
  writePrivateFileAtomic,
  writePrivateJson,
  copyPrivateFile,
  hashFile,
};
