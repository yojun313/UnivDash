#!/usr/bin/env bash
# Tailwind CSS 빌드 → app/static/vendor/tailwind.css
# Tailwind 독립 실행 CLI(v3.4.17)가 없으면 내려받는다.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=.tools/tailwindcss
if [ ! -x "$BIN" ]; then
  mkdir -p .tools
  curl -fsSL -o "$BIN" https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64
  chmod +x "$BIN"
fi
"$BIN" -c tools/tailwind.config.js -i tools/tailwind.input.css -o app/static/vendor/tailwind.css --minify
