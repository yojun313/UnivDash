"""Storage for prompt attachments.

Attachments are saved on the server disk so the agent (Claude Code / Codex) can read them by path.
- They live outside the project repository (default ~/.univdash/uploads), so the agent cannot commit them by mistake.
- The server chooses the file name: "<12 random characters>-<sanitized original name>". Client paths are never used.
- There is no API to download them again. Only upload and delete.
"""

import asyncio
import logging
import os
import re
import secrets
import time
import unicodedata
from pathlib import Path

from app.i18n import _

UPLOAD_ID = re.compile(r"^[0-9a-f]{12}-[\w.\-]{1,120}$")
_UNSAFE = re.compile(r"[^\w.\-]+")
logger = logging.getLogger(__name__)
CLEANUP_INTERVAL = 300  # Expired attachment originals are cleaned up every 5 minutes, even without uploads.


def upload_dir() -> Path:
    configured = os.getenv("UNIVDASH_UPLOAD_DIR")
    base = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".univdash" / "uploads"
    )
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    return base.resolve()


def max_bytes() -> int:
    # Value changed in Settings (otherwise the environment variable · default 50MB)
    from app.services.core import settings_service

    return settings_service.upload_max_bytes()


def ttl_seconds() -> float:
    from app.services.core import settings_service

    return settings_service.upload_ttl_seconds()


def safe_name(name: str) -> str:
    """Strips path and control characters from the original file name so it is safe in a shell/prompt."""
    name = unicodedata.normalize("NFC", name or "")
    name = name.replace("\\", "/").split("/")[-1]
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = _UNSAFE.sub("_", stem).strip("._-")[:80] or "file"
    ext = _UNSAFE.sub("", ext)[:12]
    return f"{stem}.{ext}" if ext else stem


def new_path(original_name: str) -> Path:
    return upload_dir() / f"{secrets.token_hex(6)}-{safe_name(original_name)}"


def resolve(upload_id: str) -> Path:
    """Upload ID → real path. KeyError when it is outside the upload folder or missing."""
    if not isinstance(upload_id, str) or not UPLOAD_ID.match(upload_id):
        raise KeyError(_("첨부 파일을 찾을 수 없습니다."))
    directory = upload_dir()
    path = (directory / upload_id).resolve()
    if path.parent != directory or not path.is_file():
        raise KeyError(_("첨부 파일을 찾을 수 없습니다."))
    return path


def remove(upload_id: str) -> None:
    resolve(upload_id).unlink(missing_ok=True)


def cleanup(now: float | None = None) -> int:
    """Deletes attachments past their retention period (0 = never delete)."""
    ttl = ttl_seconds()
    if not ttl:
        return 0
    now = time.time() if now is None else now
    removed = 0
    for path in upload_dir().iterdir():
        try:
            if (
                path.is_file()
                and UPLOAD_ID.match(path.name)
                and now - path.stat().st_mtime >= ttl
            ):
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


async def cleanup_loop() -> None:
    """Cleans up at server start and periodically afterwards, whether or not a browser is connected."""
    while True:
        try:
            removed = await asyncio.to_thread(cleanup)
            if removed:
                logger.info("Deleted %d expired attachment originals", removed)
            # Chunked-upload parts left unfinished for more than a day
            from app.services.files import chunk_upload

            await asyncio.to_thread(chunk_upload.cleanup)
        except OSError:
            logger.exception("Automatic attachment cleanup failed")
        await asyncio.sleep(CLEANUP_INTERVAL)
