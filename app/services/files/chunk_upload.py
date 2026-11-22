"""Chunked upload of large files: the browser cuts the file into chunks (32MB) and sends them in order;
the server appends them and then puts the file in place.

Files up to the configured maximum size can be uploaded regardless of the reverse proxy's request size
limit (nginx client_max_body_size etc.).
- Chunks are appended to upload-parts/<token>.part (mode 600) in the data folder. Until everything has
  arrived, the file is not visible to attachments or the file explorer.
- Chunks are accepted only in order (offset must equal the size received so far). Re-sending after a
  network error never overlaps.
- Parts left unfinished for more than a day are cleaned up.
"""

import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir

CHUNK_BYTES = 32 * 1024 * 1024  # max size of one request (well below the proxy limit)
STALE_SECONDS = 24 * 3600
DISK_MARGIN = 1024 * 1024 * 1024  # free disk space to keep after the upload
KINDS = {"attach", "fs"}
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class ChunkError(Exception):
    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _dir() -> Path:
    path = data_dir() / "upload-parts"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _paths(token: str) -> tuple[Path, Path]:
    if not (
        isinstance(token, str)
        and len(token) == 32
        and all(c in "0123456789abcdef" for c in token)
    ):
        raise ChunkError(_("업로드를 찾을 수 없습니다."), 404)
    base = _dir()
    return base / f"{token}.part", base / f"{token}.json"


def _lock(token: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(token, threading.Lock())


def _read_meta(token: str, user: str) -> dict:
    _part, meta_path = _paths(token)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ChunkError(
            _("업로드를 찾을 수 없습니다 (만료되었거나 취소되었습니다)."), 404
        ) from error
    if meta.get("user") != user:
        raise ChunkError(_("업로드를 찾을 수 없습니다."), 404)
    return meta


def _write_meta(token: str, meta: dict) -> None:
    _part, meta_path = _paths(token)
    tmp = meta_path.with_name(f".{meta_path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(meta, handle)
    os.replace(tmp, meta_path)


def check_disk(size: int) -> None:
    free = shutil.disk_usage(_dir()).free
    if size + DISK_MARGIN > free:
        raise ChunkError(
            _(
                "서버 디스크 공간이 부족합니다 (남은 공간 {free}MB).",
                free=free // (1024 * 1024),
            ),
            507,
        )


def start(user: str, size: int, name: str, kind: str, extra: dict) -> dict:
    if kind not in KINDS:
        raise ChunkError(_("잘못된 요청입니다."))
    cleanup()
    check_disk(size)
    token = secrets.token_hex(16)
    part, _meta = _paths(token)
    fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    _write_meta(
        token,
        {
            "user": user,
            "size": size,
            "name": name,
            "kind": kind,
            "received": 0,
            "created": time.time(),
            **extra,
        },
    )
    return {"token": token, "chunk_bytes": CHUNK_BYTES}


async def append(user: str, token: str, offset: int, stream) -> int:
    """Appends one chunk. stream is the request body (async iterable). Returns the total size received."""
    import asyncio

    lock = _lock(token)
    if not lock.acquire(blocking=False):
        raise ChunkError(_("같은 조각을 동시에 보내고 있습니다."), 409)
    try:
        meta = await asyncio.to_thread(_read_meta, token, user)
        if offset != meta["received"]:
            raise ChunkError(
                _("조각 순서가 맞지 않습니다."), 409, received=meta["received"]
            )
        part, _meta = _paths(token)
        limit = min(CHUNK_BYTES, meta["size"] - offset)
        written = 0
        handle = await asyncio.to_thread(open, part, "r+b")
        try:
            handle.seek(offset)
            handle.truncate()  # drop what is left of a chunk that was cut off last time
            async for chunk in stream:
                written += len(chunk)
                if written > limit:
                    raise ChunkError(_("조각이 너무 큽니다."), 413)
                await asyncio.to_thread(handle.write, chunk)
        except BaseException:
            handle.truncate(
                offset
            )  # discard the interrupted chunk and receive it again from the start
            raise
        finally:
            handle.close()
        meta["received"] = offset + written
        meta["touched"] = time.time()
        await asyncio.to_thread(_write_meta, token, meta)
        return meta["received"]
    finally:
        lock.release()


def finish(user: str, token: str) -> tuple[dict, Path]:
    """Once everything has arrived, returns the metadata and the part file path (the caller puts it in place)."""
    meta = _read_meta(token, user)
    if meta["received"] != meta["size"]:
        raise ChunkError(_("아직 다 받지 못했습니다."), 409, received=meta["received"])
    part, _meta = _paths(token)
    return meta, part


def place(part: Path, target: Path, mode: int) -> None:
    """Moves the part file to target. target must not exist yet; it is first created empty to claim the name."""
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        try:
            os.replace(
                part, target
            )  # same disk: move directly (onto the empty file just created)
            os.chmod(target, mode)
            os.close(fd)
            return
        except OSError:
            pass
        with (
            os.fdopen(fd, "wb") as out,
            open(part, "rb") as src,
        ):  # different disk: copy
            shutil.copyfileobj(src, out, 8 * 1024 * 1024)
        part.unlink(missing_ok=True)
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def discard(user: str, token: str) -> None:
    _read_meta(token, user)
    _remove(token)


def discard_quiet(token: str) -> None:
    try:
        _remove(token)
    except ChunkError:
        pass


def _remove(token: str) -> None:
    part, meta_path = _paths(token)
    part.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)
    with _locks_guard:
        _locks.pop(token, None)


def cleanup(now: float | None = None) -> int:
    now = time.time() if now is None else now
    removed = 0
    for meta_path in _dir().glob("*.json"):
        token = meta_path.stem
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            last = meta.get("touched") or meta.get("created") or 0
        except (OSError, ValueError):
            last = 0
        if now - last > STALE_SECONDS:
            try:
                _remove(token)
                removed += 1
            except ChunkError:
                meta_path.unlink(missing_ok=True)
    return removed
