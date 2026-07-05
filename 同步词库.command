#!/bin/zsh
cd "$(dirname "$0")" || exit 1
node typeless-dict-sync.js
echo
read -r "?按回车退出"

