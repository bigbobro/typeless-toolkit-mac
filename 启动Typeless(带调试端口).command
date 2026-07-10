#!/bin/zsh
cd "$(dirname "$0")" || exit 1

node - <<'NODE'
const C = require('./lib/common');

(async () => {
  const result = await C.ensureApp();
  console.log(`Typeless 管理连接已建立（端口 ${result.port}）`);
})().catch((error) => {
  console.error(`Typeless 管理连接失败：${error.message}`);
  process.exitCode = 1;
});
NODE
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "Typeless 工具初始化失败。请查看上面的配置或数据迁移错误。"
  read -r "?按回车退出"
  exit 1
fi
