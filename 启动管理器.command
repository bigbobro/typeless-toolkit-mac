#!/bin/zsh
cd "$(dirname "$0")" || exit 1

PORT=$(node - <<'NODE'
try {
  console.log(require('./lib/common').config.manager_port || 7788);
} catch (e) {
  console.log(7788);
}
NODE
)
URL="http://127.0.0.1:${PORT}"

if curl -fsS "$URL" >/dev/null 2>&1; then
  echo "管理器已在运行: $URL"
  open "$URL"
  exit 0
fi

node manager.js &
PID=$!
sleep 1

if ! curl -fsS "$URL" >/dev/null 2>&1; then
  echo "管理器启动失败。"
  wait "$PID"
  exit 1
fi

open "$URL"
echo "管理器运行中: $URL"
echo "关闭此窗口或按 Ctrl+C 可退出管理器。"

trap 'kill "$PID" >/dev/null 2>&1' INT TERM HUP EXIT
wait "$PID"
