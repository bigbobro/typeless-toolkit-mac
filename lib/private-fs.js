'use strict';

/**
 * 私有文件原语 —— 运行数据的落盘规矩
 *
 * 这里的每个函数都在维护同一条不变量:管理器写出的任何东西(账号 token、登录态
 * 快照、词库、备份)都只有当前 macOS 用户能读,目录 0700 / 文件 0600,且写入要么
 * 完整生效要么完全没发生。
 *
 * 从 lib/common.js 抽出:common.js、lib/runtime-backup.js 都依赖这一层。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function safeName(s) {
  return String(s || 'backup').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
}

function ensurePrivateDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function secureTree(entryPath) {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) throw new Error(`运行数据不允许符号链接: ${entryPath}`);
  if (stat.isDirectory()) {
    fs.chmodSync(entryPath, 0o700);
    for (const name of fs.readdirSync(entryPath)) secureTree(path.join(entryPath, name));
  } else if (stat.isFile()) {
    fs.chmodSync(entryPath, 0o600);
  } else {
    throw new Error(`运行数据包含不支持的文件类型: ${entryPath}`);
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

module.exports = {
  fileStamp,
  safeName,
  ensurePrivateDirectory,
  secureTree,
  writePrivateFileAtomic,
};
