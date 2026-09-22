'use strict';

const { execFile: defaultExecFile } = require('child_process');

// AppleScript 保持静态；账号名及提醒文案只经 argv 传入，不能成为脚本代码。
const CONFIRM_SCRIPT = `on run argv
  try
    set answer to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"稍后", "切换账号"} default button "稍后" giving up after 90
    if gave up of answer then return "timeout"
    if button returned of answer is "切换账号" then return "switch"
    return "later"
  on error errorMessage number errorNumber
    if errorNumber is -128 then return "cancelled"
    error errorMessage number errorNumber
  end try
end run`;

const GUIDE_SCRIPT = `on run argv
  try
    set answer to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"稍后", "打开管理器"} default button "稍后" giving up after 90
    if gave up of answer then return "timeout"
    if button returned of answer is "打开管理器" then return "open"
    return "later"
  on error errorMessage number errorNumber
    if errorNumber is -128 then return "cancelled"
    error errorMessage number errorNumber
  end try
end run`;

const NOTIFY_SCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

function createRotationNotifier({ execFile = defaultExecFile, platform = process.platform, managerUrl } = {}) {
  let pending = null;
  let fixedManagerUrl;
  if (managerUrl !== undefined) {
    try {
      const url = new URL(managerUrl);
      if (typeof managerUrl !== 'string' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
          || url.username || url.password || url.pathname !== '/' || url.search || url.hash !== '#rotation') throw new Error();
      fixedManagerUrl = url.href;
    } catch (_) {
      const error = new Error('管理器地址必须是本机 http://127.0.0.1:端口/#rotation');
      error.code = 'ROTATION_MANAGER_URL_INVALID';
      throw error;
    }
  }

  function assertSupported() {
    if (platform === 'darwin') return;
    const error = new Error('原生账号轮动提醒仅支持 macOS，当前系统无法显示提醒。');
    error.code = 'ROTATION_NOTIFICATION_UNSUPPORTED';
    throw error;
  }

  async function confirm({ accountName, usedWords, threshold, intervalMinutes }) {
    assertSupported();
    const thresholdState = usedWords < threshold ? '接近' : '已达到';
    const message = `账号「${accountName}」本周已使用 ${usedWords} 词，${thresholdState}你设置的 ${threshold} 词轮动阈值。\n\n` +
      `管理器每 ${intervalMinutes} 分钟检查一次。切换账号会重启 Typeless，请先结束当前语音输入并等待文本输出完成。\n\n` +
      '选择「稍后」可留在当前账号；90 秒未操作将自动关闭，保持当前账号。';
    return dialog(CONFIRM_SCRIPT, message, 'Typeless 账号轮动', 'switch');
  }

  async function guide({ title, message }) {
    assertSupported();
    if (!fixedManagerUrl) throw new Error('未配置本机管理器地址，无法显示处理入口');
    return dialog(GUIDE_SCRIPT, String(message), String(title), 'open');
  }

  function dialog(script, message, title, action) {
    if (pending) return Promise.resolve('cancelled');
    return new Promise((resolve, reject) => {
      const request = { child: null, settled: false, finish: null, execution: 0 };
      request.finish = (error, outcome) => {
        if (request.settled) return;
        request.settled = true;
        request.child = null;
        if (pending === request) pending = null;
        // execFile 的超时会终止子进程；任何被终止的提示都不能视为用户选择稍后或同意。
        if (error?.killed) resolve('timeout');
        else if (error) reject(error);
        else resolve(outcome);
      };
      pending = request;

      function execute(file, args, timeout, done) {
        const execution = ++request.execution;
        try {
          const child = execFile(file, args, {
            encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16384,
          }, (error, stdout) => {
            if (request.settled || execution !== request.execution) return;
            request.child = null;
            if (error) request.finish(error);
            else done(String(stdout || '').trim());
          });
          // 注入的 execFile 可能同步结束并启动下一阶段，不能重新保留上一阶段进程。
          if (!request.settled && execution === request.execution) request.child = child;
        } catch (error) { request.finish(error); }
      }

      execute('/usr/bin/osascript', ['-e', script, '--', message, title], 95000, outcome => {
        if (outcome === action && action === 'open') {
          execute('/usr/bin/open', [fixedManagerUrl], 5000, () => request.finish(null, 'opened'));
        } else {
          request.finish(null, ['later', 'timeout', 'cancelled', action].includes(outcome) ? outcome : 'timeout');
        }
      });
    });
  }

  async function notify({ title, message }) {
    assertSupported();
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', NOTIFY_SCRIPT, '--', String(title), String(message)], {
        encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384,
      }, (error) => error ? reject(error) : resolve());
    });
  }

  function cancel() {
    if (!pending) return;
    const request = pending;
    const child = request.child;
    request.finish(null, 'cancelled');
    // 完成 Promise 后再终止，防止同步触发的回调把取消判成其他结果。
    try { child?.kill('SIGKILL'); } catch (_) {}
  }

  // 没有自建监听器或计时器；execFile 负责在进程退出时清理其超时计时器。
  return { confirm, guide, notify, cancel };
}

module.exports = { createRotationNotifier };
