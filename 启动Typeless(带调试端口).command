#!/bin/zsh
cd "$(dirname "$0")" || exit 1

INFO=$(node - <<'NODE'
try {
  const C = require('./lib/common');
  console.log(C.TYPELESS_BIN || '');
  console.log(C.CDP_PORT || 9222);
} catch (e) {
  console.log('');
  console.log(9222);
}
NODE
)
TYPELESS_BIN=$(printf "%s\n" "$INFO" | sed -n '1p')
CDP_PORT=$(printf "%s\n" "$INFO" | sed -n '2p')

if [ ! -x "$TYPELESS_BIN" ]; then
  echo "未找到 Typeless 可执行文件。请设置 TYPELESS_APP，或在 config.local.json 里填 typeless_app。"
  read -r "?按回车退出"
  exit 1
fi

"$TYPELESS_BIN" "--remote-debugging-port=${CDP_PORT}" >/tmp/typeless-debug.log 2>&1 &
