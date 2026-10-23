'use strict';
/**
 * 启动 Typeless 时必须剔掉 Electron 宿主变量
 *
 * Typeless 是 Electron 应用,会读 ELECTRON_RUN_AS_NODE。这个变量为 1 时主程序
 * 把自己当成 node 解释器跑,`--remote-debugging-port` 就成了未知选项:
 *
 *   /Applications/Typeless.app/Contents/MacOS/Typeless: bad option: --remote-debugging-port=9333
 *   → 进程以 code 9 立刻退出
 *
 * 父进程若本身跑在带该变量的环境里(编辑器内置终端、某些启动器会把 node 以
 * Electron 身份启动),它会原样继承给子进程。表现是「打补丁后/切号后自动重启
 * 失败,但手动从 Finder 打开一切正常」——因为手动启动没有这个变量。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-launch-'));
process.env.TYPELESS_DATA_DIR = root;
process.env.TYPELESS_USER_DATA_DIR = path.join(root, 'live');
const paths = require('../lib/paths');
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** 在隔离环境里跑 lib/common.js,捕获 spawn 收到的参数与环境 */
function loadCommon() {
  const mod = { exports: {} };
  const spawns = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'common.js'), 'utf8'), {
    module: mod, console, Buffer, process, setTimeout: cb => queueMicrotask(cb),
    require: name => {
      if (name === './paths') return { ...paths, TYPELESS_BIN: '/fixture/Typeless' };
      if (name === 'child_process') {
        return {
          execFile: (cmd, args, options, cb) => { (typeof options === 'function' ? options : cb)(Object.assign(Error('no app'), { code: 1 }), ''); },
          execFileSync: () => '',
          spawn: (bin, args, options) => { spawns.push({ bin, args, options }); return { unref() {} }; },
        };
      }
      return require(name.startsWith('./') ? '../lib/' + name.slice(2) : name);
    },
  });
  return { C: mod.exports, spawns };
}

test('启动前剔掉 ELECTRON_RUN_AS_NODE 等宿主变量,其余环境原样保留', () => {
  const original = { ...process.env };
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';
  process.env.ELECTRON_FORCE_IS_PACKAGED = 'true';
  process.env.KEEP_ME = 'yes';
  try {
    const { C, spawns } = loadCommon();
    C.launchTypeless();
    assert.equal(spawns.length, 1);
    const env = spawns[0].options.env;
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, '留着它 Typeless 会以 node 模式启动并立刻退出');
    assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
    assert.equal(env.ELECTRON_FORCE_IS_PACKAGED, undefined);
    assert.equal(env.KEEP_ME, 'yes', '不能顺手把其它环境变量也清掉');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test('仍以 detached + 调试端口启动,与既有行为一致', () => {
  const { C, spawns } = loadCommon();
  C.launchTypeless();
  const call = spawns[0];
  assert.equal(call.bin, '/fixture/Typeless');
  // 参数数组来自 vm 沙箱,跨 realm 的 Array 原型不同,deepEqual 会判定不等。
  assert.equal(JSON.stringify(call.args), JSON.stringify([`--remote-debugging-port=${paths.CDP_PORT}`]));
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
});

test('未配置 Typeless 路径时明确报错,不静默失败', () => {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'common.js'), 'utf8'), {
    module: mod, console, Buffer, process, setTimeout: cb => queueMicrotask(cb),
    require: name => {
      if (name === './paths') return { ...paths, TYPELESS_BIN: '' };
      if (name === 'child_process') return { execFile: () => {}, execFileSync: () => '', spawn: () => assert.fail('不应启动') };
      return require(name.startsWith('./') ? '../lib/' + name.slice(2) : name);
    },
  });
  assert.throws(() => mod.exports.launchTypeless(), /路径未配置/);
});
