"""Location of the runtime data the server uses.

Kept outside the project folder (default ~/.univdash/data). Inside the project, pm2's watch would
restart the server every time a session or settings file changes, so a page opened at that moment
shows up without CSS or loses its live connection.
"""

import logging
import os
import shutil
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

LEGACY_DIR = Path(__file__).resolve().parents[1] / "data"  # old location (project/data)
_migrated: set[Path] = set()
_lock = threading.Lock()


def data_dir() -> Path:
    configured = os.getenv("UNIVDASH_DATA_DIR")
    base = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".univdash" / "data"
    )
    if not configured:
        _migrate_legacy(base)
    return base


def _migrate_legacy(target: Path) -> None:
    """Copies the files of the old project/data to the new location once (left alone if already there)."""
    with _lock:
        if target in _migrated:
            return
        _migrated.add(target)
        if not LEGACY_DIR.is_dir():
            return
        for source in LEGACY_DIR.glob("*.json"):
            destination = target / source.name
            if destination.exists():
                continue
            try:
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(source, destination)
                os.chmod(destination, 0o600)
                logger.info("data file migrated · %s → %s", source, destination)
            except OSError as error:
                logger.warning("could not migrate data file · %s: %s", source, error)


# A server started by pm2 does not inherit the login shell's PATH, so it cannot find claude · codex installed in
# places like ~/.local/bin (Codex usage, account switching and updates then fail silently). After PATH, the
# common install locations are checked too.
_EXTRA_BIN_DIRS = (
    "~/.local/bin",
    "~/.codex/packages/standalone/current/bin",
    "~/.claude/local",
    "~/.npm-global/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
)


def find_command(name: str) -> str | None:
    """Path of an executable. If not on PATH, looks in the user install locations."""
    found = shutil.which(name)
    if found:
        return found
    for folder in _EXTRA_BIN_DIRS:
        candidate = Path(folder).expanduser() / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None
