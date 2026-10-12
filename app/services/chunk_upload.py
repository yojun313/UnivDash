"""큰 파일 나눠 올리기: 브라우저가 파일을 조각(32MB)으로 잘라 차례로 보내고, 서버가 이어 붙인 뒤 제자리에 둔다.

리버스 프록시(nginx client_max_body_size 등)의 요청 크기 제한과 상관없이 설정한 최대 크기까지 올릴 수 있다.
- 조각은 데이터 폴더의 upload-parts/<token>.part (권한 600) 에 이어 쓴다. 다 받기 전에는 첨부 · 파일 탐색기에 보이지 않는다.
- 조각은 순서대로만 받는다 (offset 이 지금까지 받은 크기와 같아야 함). 네트워크 오류로 다시 보내도 겹치지 않는다.
- 하루 넘게 끝나지 않은 조각은 정리한다.
"""

import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path

from app.paths import data_dir

CHUNK_BYTES = 32 * 1024 * 1024  # 한 요청의 최대 크기 (프록시 제한보다 충분히 작게)
STALE_SECONDS = 24 * 3600
DISK_MARGIN = 1024 * 1024 * 1024  # 올린 뒤에도 디스크에 남겨 둘 여유 공간
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
        raise ChunkError("업로드를 찾을 수 없어요.", 404)
    base = _dir()
    return base / f"{token}.part", base / f"{token}.json"


def _lock(token: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(token, threading.Lock())


def _read_meta(token: str, user: str) -> dict:
    _, meta_path = _paths(token)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ChunkError(
            "업로드를 찾을 수 없어요 (만료됐거나 취소됐어요).", 404
        ) from error
    if meta.get("user") != user:
        raise ChunkError("업로드를 찾을 수 없어요.", 404)
    return meta


def _write_meta(token: str, meta: dict) -> None:
    _, meta_path = _paths(token)
    tmp = meta_path.with_name(f".{meta_path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(meta, handle)
    os.replace(tmp, meta_path)


def check_disk(size: int) -> None:
    free = shutil.disk_usage(_dir()).free
    if size + DISK_MARGIN > free:
        raise ChunkError(
            f"서버 디스크 공간이 모자라요 (남은 공간 {free // (1024 * 1024)}MB).", 507
        )


def start(user: str, size: int, name: str, kind: str, extra: dict) -> dict:
    if kind not in KINDS:
        raise ChunkError("잘못된 요청입니다.")
    cleanup()
    check_disk(size)
    token = secrets.token_hex(16)
    part, _ = _paths(token)
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
    """조각 하나를 이어 쓴다. stream 은 요청 본문 (async 반복). 받은 전체 크기를 돌려준다."""
    import asyncio

    lock = _lock(token)
    if not lock.acquire(blocking=False):
        raise ChunkError("같은 조각을 동시에 보내고 있어요.", 409)
    try:
        meta = await asyncio.to_thread(_read_meta, token, user)
        if offset != meta["received"]:
            raise ChunkError("조각 순서가 맞지 않아요.", 409, received=meta["received"])
        part, _ = _paths(token)
        limit = min(CHUNK_BYTES, meta["size"] - offset)
        written = 0
        handle = await asyncio.to_thread(open, part, "r+b")
        try:
            handle.seek(offset)
            handle.truncate()  # 지난번에 끊긴 조각의 남은 부분 정리
            async for chunk in stream:
                written += len(chunk)
                if written > limit:
                    raise ChunkError("조각이 너무 커요.", 413)
                await asyncio.to_thread(handle.write, chunk)
        except BaseException:
            handle.truncate(offset)  # 끊긴 조각은 버리고 처음부터 다시 받는다
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
    """다 받았으면 메타 정보와 조각 파일 경로를 돌려준다 (제자리에 두는 것은 호출한 쪽)."""
    meta = _read_meta(token, user)
    if meta["received"] != meta["size"]:
        raise ChunkError("아직 다 받지 못했어요.", 409, received=meta["received"])
    part, _ = _paths(token)
    return meta, part


def place(part: Path, target: Path, mode: int) -> None:
    """조각 파일을 target 으로 옮긴다. target 은 없는 이름이어야 하며 먼저 비워 만들어 선점한다."""
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        try:
            os.replace(
                part, target
            )  # 같은 디스크면 바로 옮긴다 (방금 만든 빈 파일 자리)
            os.chmod(target, mode)
            os.close(fd)
            return
        except OSError:
            pass
        with os.fdopen(fd, "wb") as out, open(part, "rb") as src:  # 다른 디스크면 복사
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
