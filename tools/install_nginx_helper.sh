#!/usr/bin/env bash
# Domains 페이지가 nginx 를 바꿀 수 있게 root 헬퍼를 설치한다. 관리자 비밀번호로 한 번만 실행한다.
#   sudo bash tools/install_nginx_helper.sh
# 헬퍼를 고친 뒤에도 다시 실행해야 적용된다. 지우려면 --uninstall.
set -euo pipefail

TARGET=/usr/local/sbin/univdash-nginx
SUDOERS=/etc/sudoers.d/univdash-nginx

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo 로 실행해 주세요: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$SUDOERS" "$TARGET"
  echo "헬퍼와 sudo 권한을 지웠습니다."
  exit 0
fi

OWNER="${SUDO_USER:-}"
if ! [[ "$OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$OWNER" = root ]; then
  echo "대시보드를 실행하는 일반 사용자가 sudo 로 실행해 주세요." >&2
  exit 1
fi
SOURCE="$(cd "$(dirname "$0")/.." && pwd)/app/services/nginx_helper.py"

TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT
echo "$OWNER ALL=(root) NOPASSWD: $TARGET" > "$TEMP"
visudo -cf "$TEMP" > /dev/null

install -o root -g root -m 0755 "$SOURCE" "$TARGET"
install -o root -g root -m 0440 "$TEMP" "$SUDOERS"
echo "설치했습니다. $OWNER 는 sudo 로 $TARGET 만 비밀번호 없이 실행할 수 있어요."
