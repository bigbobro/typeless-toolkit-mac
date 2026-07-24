'use strict';

/**
 * 去弹窗补丁的纯函数测试 —— 覆盖「决定往 app.asar 里写什么」的全部判断
 *
 * patchPaywall() 本身要真的改 Typeless.app 并重签名,不能单测。但它做的每一个
 * **决定**都来自这里的纯函数,而这些决定一旦错了就是 Typeless 闪退:
 *   - readAsarHeader:数据区起点算错一个字节 → 所有文件偏移集体错位
 *   - findPaywallTarget:选错文件 → 改到无关 bundle
 *   - getEffectivePaywallReplacements:替换串长度不等 → 同样错位
 *
 * 这里用手工构造的 asar buffer 离线验证,不需要装 Typeless。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  readAsarHeader,
  detectPaywallFile,
  getAsarNode,
  scorePaywallCandidate,
  findPaywallTarget,
  getEffectivePaywallReplacements,
} = require('../lib/paywall-patch');

/**
 * 造一个结构合法的 asar buffer。
 * 布局:[0..12) pickle 前缀(代码不读) | [12..16) header JSON 长度
 *      | [16..16+len) header JSON | 4 字节对齐填充 | 数据区
 * @param {Record<string,string>} files 相对路径 -> 文件内容
 */
function buildAsar(files) {
  const entries = Object.entries(files);
  const blobs = entries.map(([, content]) => Buffer.from(content, 'utf8'));

  const root = { files: {} };
  let offset = 0;
  entries.forEach(([rel], i) => {
    const parts = rel.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      node.files[dir] = node.files[dir] || { files: {} };
      node = node.files[dir];
    }
    const hash = crypto.createHash('sha256').update(blobs[i]).digest('hex');
    node.files[parts[parts.length - 1]] = {
      offset: String(offset),
      size: blobs[i].length,
      integrity: { algorithm: 'SHA256', hash, blocks: [hash] },
    };
    offset += blobs[i].length;
  });

  const json = Buffer.from(JSON.stringify(root), 'utf8');
  const headerEnd = 16 + json.length;
  const padding = headerEnd % 4 ? 4 - (headerEnd % 4) : 0;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padding), ...blobs]);
}

const PAYWALL_SRC = "const a=1;if(_0x12ab['type']==='paywall')gn(_0x12ab);else hn(_0x12ab);onImportantNotification();";

test('readAsarHeader 解析头部并按 4 字节对齐算出数据区起点', () => {
  const buf = buildAsar({ 'a.js': 'hello' });
  const { header, headerStart, headerEnd, dataStart } = readAsarHeader(buf);

  assert.strictEqual(headerStart, 16);
  assert.ok(header.files['a.js'], 'header 应含 a.js');
  assert.strictEqual(dataStart % 4, 0, '数据区起点必须 4 字节对齐');
  assert.ok(dataStart >= headerEnd, '数据区不能与头部重叠');
  assert.ok(dataStart - headerEnd < 4, '对齐填充不应超过 3 字节');
  // 按算出的偏移能原样取回文件内容 —— 偏移算错时这里立刻炸
  const node = header.files['a.js'];
  assert.strictEqual(buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size).toString(), 'hello');
});

test('readAsarHeader 对四种 headerEnd%4 余数都能正确取回文件内容', () => {
  // 靠往文件名里塞不同长度的填充,把 header JSON 长度推到四种余数上
  const seen = new Set();
  for (let pad = 0; pad < 8; pad++) {
    const name = 'f' + 'x'.repeat(pad) + '.js';
    const buf = buildAsar({ [name]: 'PAYLOAD', 'z.js': 'ZZ' });
    const { header, headerEnd, dataStart } = readAsarHeader(buf);
    seen.add(headerEnd % 4);
    const node = header.files[name];
    assert.strictEqual(
      buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size).toString(),
      'PAYLOAD',
      `headerEnd%4=${headerEnd % 4} 时取回内容错误`,
    );
  }
  assert.strictEqual(seen.size, 4, '应覆盖到全部四种对齐余数');
});

test('detectPaywallFile 只收 .mjs/.js 叶子节点,并递归子目录', () => {
  const buf = buildAsar({
    'dist/renderer/static/js/main.mjs': 'a',
    'dist/renderer/static/js/vendor.js': 'b',
    'dist/renderer/index.html': 'c',
    'package.json': 'd',
  });
  const { header } = readAsarHeader(buf);
  const found = detectPaywallFile(header).sort();
  assert.deepStrictEqual(found, [
    'dist/renderer/static/js/main.mjs',
    'dist/renderer/static/js/vendor.js',
  ]);
});

test('getAsarNode 按路径数组定位节点,路径不存在返回 null', () => {
  const buf = buildAsar({ 'dist/renderer/static/js/main.mjs': 'a' });
  const { header } = readAsarHeader(buf);
  assert.ok(getAsarNode(header, ['dist', 'renderer', 'static', 'js', 'main.mjs']));
  assert.strictEqual(getAsarNode(header, ['dist', 'nope', 'main.mjs']), null);
  assert.strictEqual(getAsarNode(header, ['main.mjs']), null);
});

test('scorePaywallCandidate:paywall 分支权重最高,路径与通知处理器为加分项', () => {
  const withBranch = scorePaywallCandidate('x.mjs', Buffer.from("if(a['type']==='paywall')b(a);else"));
  const onlyWord = scorePaywallCandidate('x.mjs', Buffer.from('just the word paywall here'));
  const rightPath = scorePaywallCandidate('dist/renderer/static/js/x.mjs', Buffer.from('nothing'));
  const unrelated = scorePaywallCandidate('x.mjs', Buffer.from('nothing at all'));

  assert.ok(withBranch > onlyWord, 'type==="paywall" 分支必须压过单纯出现 paywall 一词');
  assert.ok(rightPath > unrelated, 'renderer bundle 路径应加分');
  assert.strictEqual(unrelated, 0, '完全无关的文件必须是 0 分,才会被 findPaywallTarget 跳过');
});

test('findPaywallTarget 在多个候选中选出得分最高的那个', () => {
  const buf = buildAsar({
    'dist/renderer/static/js/unrelated.mjs': 'console.log(1)',
    'dist/renderer/static/js/target.mjs': PAYWALL_SRC,
    'other/paywall-mention.js': 'a word: paywall',
  });
  const { header, dataStart } = readAsarHeader(buf);
  const best = findPaywallTarget(header, buf, dataStart);
  assert.deepStrictEqual(best.parts, ['dist', 'renderer', 'static', 'js', 'target.mjs']);
});

test('findPaywallTarget 在没有任何正分候选时返回 null', () => {
  const buf = buildAsar({ 'a.js': 'console.log(1)', 'b.js': 'const x=2' });
  const { header, dataStart } = readAsarHeader(buf);
  assert.strictEqual(findPaywallTarget(header, buf, dataStart), null);
});

const AUTO = { file_path: [], replacements: [], auto_detect_replacements: true, auto_detect_file: true };

test('自动识别出的替换必须严格等长 —— 这是不写坏 asar 的前提', () => {
  const { replacements, source } = getEffectivePaywallReplacements(Buffer.from(PAYWALL_SRC), AUTO);
  assert.strictEqual(source, 'auto');
  assert.deepStrictEqual(replacements, [['gn(_0x12ab)', '(0,_0x12ab)']]);
  for (const [from, to] of replacements) {
    assert.strictEqual(
      Buffer.byteLength(from, 'utf8'),
      Buffer.byteLength(to, 'utf8'),
      `替换长度不等会让 asar 内所有文件偏移错位: ${from} -> ${to}`,
    );
  }
});

test('调用处函数名过长(替换会改变字节数)时必须跳过,不能硬替', () => {
  const src = "if(_0xab['type']==='paywall')handlePaywall(_0xab);else next(_0xab);";
  const { replacements } = getEffectivePaywallReplacements(Buffer.from(src), AUTO);
  assert.deepStrictEqual(replacements, [], 'handlePaywall(x) 比 (0,x) 长,必须被跳过');
});

test('已打过补丁的内容识别为 sentinel,使 paywallStatus 判定为 patched', () => {
  const patched = "if(_0x12ab['type']==='paywall')(0,_0x12ab);else hn(_0x12ab);";
  const { replacements } = getEffectivePaywallReplacements(Buffer.from(patched), AUTO);
  assert.strictEqual(replacements.length, 1);
  const [from, to] = replacements[0];
  // from 是一个永不会出现在文件里的哨兵 → hasOld=false;to 确实在文件里 → hasNew=true
  assert.match(from, /^__already_patched_paywall__\(/);
  assert.ok(!patched.includes(from), 'sentinel 不得真的出现在内容里');
  assert.ok(patched.includes(to), '已打补丁内容里应能找到替换后的形式');
});

test('同一替换出现多次只保留一条,多个不同变量各保留一条', () => {
  const src = PAYWALL_SRC + PAYWALL_SRC
    + "if(_0xcd['type']==='paywall')qq(_0xcd);else rr(_0xcd);";
  const { replacements } = getEffectivePaywallReplacements(Buffer.from(src), AUTO);
  assert.deepStrictEqual(replacements, [
    ['gn(_0x12ab)', '(0,_0x12ab)'],
    ['qq(_0xcd)', '(0,_0xcd)'],
  ]);
});

test('config 显式配置的替换存在于内容时优先于自动识别', () => {
  const cfg = { ...AUTO, replacements: [['gn(_0x12ab)', '(0,_0x12ab)']] };
  const { source } = getEffectivePaywallReplacements(Buffer.from(PAYWALL_SRC), cfg);
  assert.strictEqual(source, 'config');
});

test('config 配置的替换在内容里找不到时回落到自动识别', () => {
  const cfg = { ...AUTO, replacements: [['zz(_0xNOPE)', '(0,_0xNOPE)']] };
  const { replacements, source } = getEffectivePaywallReplacements(Buffer.from(PAYWALL_SRC), cfg);
  assert.strictEqual(source, 'auto');
  assert.deepStrictEqual(replacements, [['gn(_0x12ab)', '(0,_0x12ab)']]);
});

test('关闭自动识别后不再扫描内容,只认 config', () => {
  const cfg = { ...AUTO, auto_detect_replacements: false };
  const { replacements, source } = getEffectivePaywallReplacements(Buffer.from(PAYWALL_SRC), cfg);
  assert.deepStrictEqual(replacements, []);
  assert.strictEqual(source, 'config');
});
