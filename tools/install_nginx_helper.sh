#!/usr/bin/env bash
# Domains 페이지가 nginx 를 바꿀 수 있게 root 헬퍼를 설치한다. 관리자 비밀번호로 한 번만 실행한다.
#   sudo bash tools/install_nginx_helper.sh
# 헬퍼를 고친 뒤에도 다시 실행해야 적용된다. 지우려면 --uninstall, 변경 비밀번호를 바꾸려면 --reset-passphrase.
set -euo pipefail

TARGET=/usr/local/sbin/univdash-nginx
SUDOERS=/etc/sudoers.d/univdash-nginx
SECRET_DIR=/etc/univdash-nginx
SECRET="$SECRET_DIR/passphrase"

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo 로 실행해 주세요: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$SUDOERS" "$TARGET"
  rm -rf "$SECRET_DIR"
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

# 변경 비밀번호: 도메인을 바꿀 때마다 묻는다. root 만 읽을 수 있는 곳에 해시로 둔다.
if [ ! -f "$SECRET" ] || [ "${1:-}" = "--reset-passphrase" ]; then
  [ -t 0 ] || { echo "터미널에서 직접 실행해 주세요 (변경 비밀번호를 입력해야 합니다)." >&2; exit 1; }
  echo "도메인을 바꿀 때 입력할 변경 비밀번호를 정합니다. 12자 이상, 다른 곳에 쓰지 않는 값으로 정해 주세요."
  while true; do
    read -rsp "변경 비밀번호: " FIRST; echo
    read -rsp "한 번 더: " SECOND; echo
    [ "$FIRST" = "$SECOND" ] || { echo "서로 다릅니다."; continue; }
    [ "${#FIRST}" -ge 12 ] || { echo "12자 이상이어야 합니다."; continue; }
    break
  done
  install -d -o root -g root -m 0700 "$SECRET_DIR"
  printf '%s' "$FIRST" | /usr/bin/python3 -I -c '
import hashlib, os, sys
salt = os.urandom(16)
cost = 15
key = hashlib.scrypt(sys.stdin.buffer.read(), salt=salt, n=2**cost, r=8, p=1, maxmem=256*1024*1024)
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, f"scrypt${cost}${salt.hex()}${key.hex()}".encode())
os.close(fd)
' "$SECRET"
  unset FIRST SECOND
fi
echo "설치했습니다. $OWNER 는 sudo 로 $TARGET 만 실행할 수 있고, 바꾸는 작업에는 변경 비밀번호가 필요해요."
echo "기존 도메인에 보안 설정을 적용하려면: sudo $TARGET harden"
