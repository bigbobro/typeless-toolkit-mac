'use strict';

/**
 * 词库去重 / 差集逻辑测试
 *
 * 覆盖两块:
 *  1. termKey() 归一化(大小写折叠 + 去首尾空白 + null/undefined 安全)
 *  2. writeMaster() 的去重(按 trim 后精确匹配去重)+ readMaster() 往返
 *  3. 「已存在的词不应被重复导入」的 have/missing 差集判断
 *
 * 关于 have/missing:该逻辑在源码里是内联两行(未单独导出),分别出现在:
 *   - lib/common.js  syncAccount():
 *       const accountKeys = new Set(accountWords.map(termKey));
 *       const missing = masterMerged.filter(w => !accountKeys.has(termKey(w)));
 *   - manager.js     import-master / account->account 迁移:
 *       const have = new Set((dl.data?.words||[]).map(w => termKey(w.term)));
 *       const missing = master.filter(w => !have.has(termKey(w)));
 * syncAccount 本身要走 curlApi 真实网络请求,不能安全单测,故这里用同一套导出的
 * termKey 复刻其差集表达式,验证「大小写/空白不同但等价的词不会被当成缺失重复导入」。
 *
 * 数据隔离:require lib/common.js 之前把 TYPELESS_DATA_DIR 指向临时目录,
 * writeMaster/readMaster 只会读写临时目录内的主词库 CSV,不碰用户真实数据。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-dict-test-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const C = require('../lib/common.js');

before(() => {
  assert.ok(C.MASTER_CSV.startsWith(DATA_DIR + path.sep), '主词库路径逃逸出临时目录');
});

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- 1. termKey 归一化 ----

test('termKey 折叠大小写、去首尾空白', () => {
  assert.strictEqual(C.termKey('Hello'), 'hello');
  assert.strictEqual(C.termKey('  Foo  '), 'foo');
  assert.strictEqual(C.termKey('\tBar\n'), 'bar');
  assert.strictEqual(C.termKey('WORLD'), 'world');
  // 归一化后等价的词,termKey 相同
  assert.strictEqual(C.termKey('  API '), C.termKey('api'));
});

test('termKey 对空值安全,返回空串', () => {
  assert.strictEqual(C.termKey(null), '');
  assert.strictEqual(C.termKey(undefined), '');
  assert.strictEqual(C.termKey(''), '');
  assert.strictEqual(C.termKey('   '), '');
});

// ---- 2. writeMaster 去重 + readMaster 往返 ----

test('writeMaster 去重(trim 后精确匹配)并过滤空白,readMaster 读回一致', () => {
  const written = C.writeMaster(['  hello  ', 'hello', 'world', '', '   ']);
  // '  hello  ' 与 'hello' trim 后相同 -> 折叠为一条;空白项被过滤
  assert.deepStrictEqual(written.slice().sort(), ['hello', 'world']);
  assert.deepStrictEqual(C.readMaster().slice().sort(), ['hello', 'world']);
});

test('writeMaster 去重是大小写敏感的(与 termKey 归一化不同)', () => {
  // writeMaster 用 trim 后精确匹配去重,不折叠大小写:'Foo' 与 'foo' 都保留
  const written = C.writeMaster(['Foo', 'foo']);
  assert.strictEqual(written.length, 2);
  assert.deepStrictEqual(written.slice().sort(), ['Foo', 'foo']);
});

// ---- 3. have/missing 差集:已存在的词不应被重复导入 ----
// 复刻 syncAccount / import-master 的表达式(见文件顶部说明),用导出的 termKey。

function computeMissing(existingWords, candidateWords) {
  const have = new Set(existingWords.map(C.termKey));
  return candidateWords.filter((w) => !have.has(C.termKey(w)));
}

test('差集:大小写/空白不同但等价的词不算缺失,只有真正的新词才导入', () => {
  const account = ['Hello', ' World '];
  const master = ['hello', 'WORLD', 'new-term'];
  // account 已含 hello/world(大小写、空白无关),只有 new-term 真正缺失
  assert.deepStrictEqual(computeMissing(account, master), ['new-term']);
});

test('差集:候选全部已存在时,missing 为空(不重复导入)', () => {
  const account = ['alpha', 'beta', 'gamma'];
  const master = ['ALPHA', '  beta  ', 'Gamma'];
  assert.deepStrictEqual(computeMissing(account, master), []);
});

test('差集:master 内部大小写重复词都命中已有归一化键,均不重复导入', () => {
  // master 含 'Foo' 与 'foo'(writeMaster 不会折叠),但账号已有 'FOO'
  const account = ['FOO'];
  const master = ['Foo', 'foo'];
  assert.deepStrictEqual(computeMissing(account, master), []);
});

test('差集:空账号时全部候选都算缺失', () => {
  const account = [];
  const master = ['a', 'b', 'c'];
  assert.deepStrictEqual(computeMissing(account, master), ['a', 'b', 'c']);
});
