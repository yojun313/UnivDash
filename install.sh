#!/usr/bin/env sh
# UnivDash installer.
#
#   curl -fsSL https://raw.githubusercontent.com/yojun313/UnivDash/main/install.sh | sh
#
# What it does, in order:
#   1. checks git and tmux (tells you the one command to install them if missing; never uses sudo itself)
#   2. installs uv (the Python manager) into your home folder if you do not have it
#   3. downloads UnivDash into ~/UnivDash (or updates it if it is already there)
#   4. installs the Python dependencies into ~/UnivDash/.venv
#   5. asks for a login name, password and port, and writes ~/UnivDash/.env
#   6. starts the dashboard in the background
#
# Options (environment variables):
#   UNIVDASH_DIR=/some/path     install somewhere else
#   UNIVDASH_YES=1              ask nothing: user "admin", generated password, first free port from 8000
#   UNIVDASH_NO_START=1         install and configure only, do not start
set -eu

REPO="${UNIVDASH_REPO:-https://github.com/yojun313/UnivDash.git}"
DIR="${UNIVDASH_DIR:-$HOME/UnivDash}"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) ;;
  Darwin) say "Note: UnivDash is developed on Linux. macOS is not tested yet; continuing anyway." ;;
  *) die "UnivDash runs on Linux (on Windows, use WSL)." ;;
esac

step "Checking requirements"
missing=""
command -v git >/dev/null 2>&1 || missing="$missing git"
command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
command -v curl >/dev/null 2>&1 || missing="$missing curl"
if [ -n "$missing" ]; then
  say "Missing:$missing"
  if command -v apt-get >/dev/null 2>&1; then say "Install with:  sudo apt-get install -y$missing"
  elif command -v dnf >/dev/null 2>&1; then say "Install with:  sudo dnf install -y$missing"
  elif command -v pacman >/dev/null 2>&1; then say "Install with:  sudo pacman -S$missing"
  elif command -v brew >/dev/null 2>&1; then say "Install with:  brew install$missing"
  fi
  die "Install the missing tools, then run this installer again."
fi
say "git, tmux and curl are installed."

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  step "Installing uv (Python manager) into your home folder"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  command -v uv >/dev/null 2>&1 || die "uv was installed but is not on PATH. Open a new terminal and run this installer again."
fi

if [ -d "$DIR/.git" ]; then
  step "Updating UnivDash in $DIR"
  git -C "$DIR" pull --ff-only || say "Could not update automatically (local changes?). Continuing with the version on disk."
elif [ -e "$DIR" ]; then
  die "$DIR already exists and is not a UnivDash checkout. Set UNIVDASH_DIR to another folder."
else
  step "Downloading UnivDash into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

step "Installing Python dependencies (first run takes a minute)"
cd "$DIR"
uv sync
chmod +x univdash

step "Setting up your login"
if [ -f .env ]; then
  say ".env already exists. Keeping your current settings."
elif [ "${UNIVDASH_YES:-0}" = "1" ]; then
  uv run --quiet python tools/setup.py --yes
else
  uv run --quiet python tools/setup.py
fi

if [ "${UNIVDASH_NO_START:-0}" = "1" ]; then
  say ""
  say "Installed. Start it with:  $DIR/univdash up"
  exit 0
fi

step "Starting UnivDash"
./univdash up
say ""
say "Open the address above in your browser and log in."
say "Manage it later with:  $DIR/univdash {status|logs|down|update|setup}"
