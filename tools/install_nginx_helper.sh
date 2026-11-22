#!/usr/bin/env bash
# Installs the root helper that lets the Domains page change nginx. Run once with the administrator password.
#   sudo bash tools/install_nginx_helper.sh
# Run it again after editing the helper for the change to take effect. To remove it use --uninstall; if you forgot the change passphrase use --reset-passphrase (if you know it, change it on the Domains screen).
set -euo pipefail

TARGET=/usr/local/sbin/univdash-nginx
SUDOERS=/etc/sudoers.d/univdash-nginx
SECRET_DIR=/etc/univdash-nginx
SECRET="$SECRET_DIR/passphrase"
FAILURES=/run/univdash-nginx-failures

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$SUDOERS" "$TARGET"
  rm -rf "$SECRET_DIR"
  echo "Removed the helper and its sudo permission."
  exit 0
fi

OWNER="${SUDO_USER:-}"
if ! [[ "$OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$OWNER" = root ]; then
  echo "Please run this with sudo as the regular user that runs the dashboard." >&2
  exit 1
fi
SOURCE="$(cd "$(dirname "$0")/.." && pwd)/app/services/server/nginx_helper.py"

TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT
echo "$OWNER ALL=(root) NOPASSWD: $TARGET" > "$TEMP"
visudo -cf "$TEMP" > /dev/null

install -o root -g root -m 0755 "$SOURCE" "$TARGET"
install -o root -g root -m 0440 "$TEMP" "$SUDOERS"

# Change passphrase: asked every time a domain is changed. Stored as a hash where only root can read it.
if [ ! -f "$SECRET" ] || [ "${1:-}" = "--reset-passphrase" ]; then
  [ -t 0 ] || { echo "Please run this directly in a terminal (the change passphrase has to be typed in)." >&2; exit 1; }
  echo "Choose the change passphrase to enter whenever a domain is changed. Pick a value you do not use anywhere else."
  while true; do
    read -rsp "Change passphrase: " FIRST; echo
    read -rsp "Once more: " SECOND; echo
    [ "$FIRST" = "$SECOND" ] || { echo "They do not match."; continue; }
    [ -n "$FIRST" ] || { echo "It must not be empty."; continue; }
    [ "$(printf '%s' "$FIRST" | wc -c)" -le 1024 ] || { echo "It must not exceed 1024 bytes."; continue; }
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
  rm -f "$FAILURES"  # a newly chosen passphrase also clears the wrong-attempt count and the lock
  unset FIRST SECOND
fi
echo "Installed. $OWNER can run only $TARGET with sudo, and changes require the change passphrase."
echo "To apply the security settings to existing domains: sudo $TARGET harden"
