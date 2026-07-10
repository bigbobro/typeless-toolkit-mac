#!/bin/zsh
cd "$(dirname "$0")" || exit 1

if ! PORT=$(node - <<'NODE'
console.log(require('./lib/common').config.manager_port || 7788);
NODE
); then
  echo "管理器初始化失败。请查看上面的配置或数据迁移错误。"
  read -r "?按回车退出"
  exit 1
fi
URL="http://127.0.0.1:${PORT}"
HEALTH_URL="${URL}/api/health"

HEALTH_BODY=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
if [[ "$HEALTH_BODY" == *'"product":"typeless-toolkit-manager"'* ]]; then
  echo "管理器已在运行: $URL"
  open "$URL"
  exit 0
fi

node manager.js &
PID=$!

READY=0
for _ in {1..40}; do
  HEALTH_BODY=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
  if [[ "$HEALTH_BODY" == *'"product":"typeless-toolkit-manager"'* ]]; then
    READY=1
    break
  fi
  if ! kill -0 "$PID" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if [ "$READY" -ne 1 ]; then
  echo "管理器启动失败。"
  wait "$PID"
  exit 1
fi

open "$URL"
echo "管理器运行中: $URL"
echo "关闭此窗口或按 Ctrl+C 可退出管理器。"

trap 'kill "$PID" >/dev/null 2>&1' INT TERM HUP EXIT
wait "$PID"
