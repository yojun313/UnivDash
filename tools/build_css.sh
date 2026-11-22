#!/usr/bin/env bash
# Build Tailwind CSS → app/static/vendor/tailwind.css
# Downloads the Tailwind standalone CLI (v3.4.17) if it is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=.tools/tailwindcss
if [ ! -x "$BIN" ]; then
  mkdir -p .tools
  curl -fsSL -o "$BIN" https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64
  chmod +x "$BIN"
fi
"$BIN" -c tools/tailwind.config.js -i tools/tailwind.input.css -o app/static/vendor/tailwind.css --minify
