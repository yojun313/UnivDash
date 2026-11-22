"""Per-window "how far it was read" (activity time last seen). Shared by every device.

Kept on the server so a window checked on the PC does not show as unread (a dot) on the phone; changes are pushed
right away to every connected browser over WebSocket. Values only move forward (max) — so an old value arriving
late does not undo a read.
"""

import json
import os
import tempfile
import threading
import time
from pathlib import Path

from app.paths import data_dir

MAX_KEYS = 2000
SAVE_DELAY = 2.0

_lock = threading.Lock()
_seen: dict[str, float] | None = None
_version = 0
_dirty_since: float | None = None


def _file() -> Path:
    return data_dir() / "seen.json"


def _load() -> dict[str, float]:
    global _seen
    if _seen is None:
        try:
            raw = json.loads(_file().read_text(encoding="utf-8"))
            _seen = {
                k: float(v)
                for k, v in raw.items()
                if isinstance(k, str) and isinstance(v, (int, float))
            }
        except (OSError, ValueError, AttributeError):
            _seen = {}
    return _seen


def version() -> int:
    return _version


def dirty() -> bool:
    return _dirty_since is not None


def snapshot() -> dict[str, float]:
    with _lock:
        return dict(_load())


def mark(items: dict) -> bool:
    """Merge {window key: activity time}. True if anything changed."""
    global _version, _dirty_since
    changed = False
    with _lock:
        seen = _load()
        for key, value in list(items.items())[:500]:
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 200
                or isinstance(value, bool)
                or not isinstance(value, (int, float))
            ):
                continue
            value = float(value)
            if value > seen.get(key, float("-inf")):
                seen[key] = value
                changed = True
        if len(seen) > MAX_KEYS:
            for key in sorted(seen, key=seen.get)[: len(seen) - MAX_KEYS]:
                del seen[key]
        if changed:
            _version += 1
            _dirty_since = _dirty_since or time.monotonic()
    return changed


def rename_session(old: str, new: str) -> None:
    """When a tmux session is renamed, move the "session:window" keys too."""
    global _version, _dirty_since
    prefix = f"{old}:"
    with _lock:
        seen = _load()
        for key in [k for k in seen if k.startswith(prefix)]:
            seen[f"{new}:{key[len(prefix) :]}"] = seen.pop(key)
        _version += 1
        _dirty_since = _dirty_since or time.monotonic()


def flush(force: bool = False) -> None:
    """Collect changes for a moment, then save to the file (so not every read writes to disk)."""
    global _dirty_since
    with _lock:
        if _dirty_since is None or (
            not force and time.monotonic() - _dirty_since < SAVE_DELAY
        ):
            return
        payload = json.dumps(_seen or {}, ensure_ascii=False)
        _dirty_since = None
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".seen.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
