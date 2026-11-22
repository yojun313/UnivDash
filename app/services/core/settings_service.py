"""Server settings (values changed in the Settings window): maximum upload size, attachment retention, maximum viewer · edit size.

- Saved to settings.json (mode 600) in the data folder. A missing value falls back to the environment variable, then the default.
- Out-of-range values are not saved (pydantic validation). On read, the file is not re-read while its modification time is unchanged.
"""

import json
import os
import secrets
import threading
from pathlib import Path

from pydantic import BaseModel, Field

from app.paths import data_dir

# The browser sends large files in 32MB pieces (chunk_upload), so the proxy's request size limit does not matter.
# Only an upper bound for validation is kept (1TB). In practice the server's free disk space is also checked on upload.
UPLOAD_MAX_MB_LIMIT = 1024 * 1024


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


class ServerSettings(BaseModel):
    upload_max_mb: int = Field(
        ge=1, le=UPLOAD_MAX_MB_LIMIT
    )  # maximum per file for attachments · file explorer uploads
    upload_ttl_days: float = Field(
        ge=0.5, le=30
    )  # how long prompt attachment originals are kept
    viewer_max_mb: int = Field(
        ge=1, le=20
    )  # maximum size opened as text in the file viewer
    edit_max_mb: int = Field(ge=1, le=50)  # maximum size the editor can save


def defaults() -> ServerSettings:
    return ServerSettings(
        upload_max_mb=int(
            min(UPLOAD_MAX_MB_LIMIT, max(1, _env_float("UNIVDASH_UPLOAD_MAX_MB", 50)))
        ),
        upload_ttl_days=min(30, max(0.5, _env_float("UNIVDASH_UPLOAD_TTL_DAYS", 1))),
        viewer_max_mb=2,
        edit_max_mb=5,
    )


_lock = threading.Lock()  # for the cache
_write_lock = threading.Lock()
_cache: tuple[float, ServerSettings] | None = None


def _path() -> Path:
    return data_dir() / "settings.json"


def get() -> ServerSettings:
    global _cache
    path = _path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return defaults()
    with _lock:
        if _cache and _cache[0] == mtime:
            return _cache[1]
    base = defaults().model_dump()
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            base.update({k: v for k, v in saved.items() if k in base})
        value = ServerSettings(**base)
    except (OSError, ValueError):
        value = defaults()
    with _lock:
        _cache = (mtime, value)
    return value


def update(changes: dict) -> ServerSettings:
    """Takes only the changed values, validates them and saves. ValueError when out of range."""
    with _write_lock:  # so neither change is lost when two requests write at once
        value = ServerSettings(
            **{**get().model_dump(), **changes}
        )  # range check (ValidationError is a ValueError)
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".settings.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value.model_dump(), handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    return get()


def upload_max_bytes() -> int:
    return get().upload_max_mb * 1024 * 1024


def upload_ttl_seconds() -> float:
    return get().upload_ttl_days * 86400


def viewer_max_bytes() -> int:
    return get().viewer_max_mb * 1024 * 1024


def edit_max_bytes() -> int:
    return get().edit_max_mb * 1024 * 1024
