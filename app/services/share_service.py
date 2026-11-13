"""공유 링크: 파일 · 폴더 하나를 정해진 시간 동안 로그인 없이 받을 수 있게 한다.

보안
- 링크 토큰은 256비트 임의 값이고, 서버에는 SHA-256 해시만 저장한다 (data/shares.json, 0600).
  저장 파일이 새어도 링크를 만들 수 없고, 링크는 만들 때 한 번만 보여 준다.
- 링크 하나는 정해진 경로 하나만 내려준다. 받는 쪽은 경로 · 이름을 고를 수 없다.
- 파일은 받을 때마다 다시 확인한다: 허용 범위 안인지, 링크로 바뀌지 않았는지
  (O_NOFOLLOW + 실제로 연 경로를 /proc 에서 다시 확인).
- 폴더는 공유하는 순간의 내용을 zip 으로 묶어 둔다. 폴더 안의 링크는 그 폴더 안을 가리킬 때만 넣고,
  .env · 개인 키 · .git 은 뺀다. 받는 쪽 요청으로 서버가 압축 작업을 하지 않는다.
- 비밀이 모여 있는 폴더(~/.ssh · ~/.claude · ~/.codex · ~/.univdash 등)와 그 안, 탐색기 루트(홈 전체)는 공유할 수 없다.
- 만료 · 횟수 소진 · 취소된 링크는 없는 링크와 똑같이 응답한다.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

from app.paths import data_dir
from app.services import fs_service
from app.services.fs_service import FsError

logger = logging.getLogger(__name__)

MINUTES_MIN = 1
MINUTES_MAX = 7 * 24 * 60
MINUTES_DEFAULT = 15
MAX_ACTIVE = 30  # 동시에 살아 있는 링크 수
TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32)

# 홈 기준 — 이 폴더(파일) 자체와 그 안, 그리고 이것을 품은 폴더는 공유할 수 없다
SENSITIVE = (
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config",
    ".claude",
    ".claude.json",
    ".codex",
    ".univdash",
    ".pki",
    ".password-store",
    ".local/share/keyrings",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".bash_history",
    ".zsh_history",
    ".python_history",
    ".mysql_history",
    ".psql_history",
    ".lesshst",
    ".viminfo",
    "ecosystem.config.js",
)
SECRET_NAME = re.compile(
    r"^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.+\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)|\.git|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.pgpass)$",
    re.IGNORECASE,
)

_lock = threading.Lock()


def _path() -> Path:
    return data_dir() / "shares.json"


def cache_dir() -> Path:
    return Path.home() / ".univdash" / "cache" / "share"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _load() -> dict[str, dict]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(shares: dict[str, dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".shares.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(shares, handle)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _archive(share: dict) -> Path | None:
    name = share.get("archive")
    return cache_dir() / name if name else None


def _alive(share: dict, now: float) -> bool:
    limit = share.get("max_downloads") or 0
    return now < share["expires"] and not (limit and share["downloads"] >= limit)


def _drop(share: dict) -> None:
    archive = _archive(share)
    if archive:
        archive.unlink(missing_ok=True)


def cleanup() -> None:
    """만료된 링크와 묶어 둔 zip, 주인 없는 zip 을 지운다."""
    now = time.time()
    with _lock:
        shares = _load()
        dead = [h for h, s in shares.items() if not _alive(s, now)]
        for key in dead:
            _drop(shares.pop(key))
        if dead:
            _save(shares)
        keep = {s.get("archive") for s in shares.values()}
    folder = cache_dir()
    if folder.is_dir():
        for item in folder.iterdir():
            # 묶는 중인 파일(.part)은 1시간 지나도 남아 있을 때만 지운다
            if item.name in keep:
                continue
            try:
                if item.suffix != ".part" or now - item.stat().st_mtime > 3600:
                    item.unlink()
            except OSError:
                pass


async def cleanup_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(cleanup)
        except Exception:
            logger.exception("공유 링크 정리 실패")
        await asyncio.sleep(60)


def check_target(path: str) -> tuple[Path, str]:
    """공유해도 되는 경로인지 확인하고 (실제 경로, 'file' | 'dir')."""
    candidate = fs_service.resolve(path)
    real = candidate.resolve(strict=True)
    if not fs_service._inside(real):
        raise FsError("허용된 폴더 밖입니다.")
    if real.is_dir():
        kind = "dir"
    elif real.is_file():
        kind = "file"
    else:
        raise FsError("파일이나 폴더만 공유할 수 있어요.")
    if any(real == root for root in fs_service.roots()):
        raise FsError("탐색기 맨 위 폴더(홈 전체)는 공유할 수 없어요.")
    home = Path.home().resolve()
    for rel in SENSITIVE:
        secret = home / rel
        if real == secret or secret in real.parents or real in secret.parents:
            raise FsError(f"비밀 정보가 있는 위치(~/{rel})는 공유할 수 없어요.")
    if ".git" in real.parts:
        raise FsError(".git 폴더와 그 안은 공유할 수 없어요.")
    if kind == "file" and SECRET_NAME.match(real.name):
        raise FsError(".env · 개인 키 같은 비밀 파일은 공유할 수 없어요.")
    return real, kind


def zip_for_share(real: Path, skip_ignored: bool, progress) -> tuple[Path, int]:
    """폴더를 공유용 zip 으로 묶어 캐시에 둔다. (zip 경로, 크기)"""
    archive, _ = fs_service.zip_folder(
        str(real),
        skip_ignored,
        progress,
        confine=True,
        exclude=lambda name: bool(SECRET_NAME.match(name)),
    )
    folder = cache_dir()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = folder / f"{secrets.token_hex(16)}.zip"
    try:
        os.replace(archive, target)
        os.chmod(target, 0o600)
    except BaseException:
        archive.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise
    return target, target.stat().st_size


def create(
    real: Path,
    kind: str,
    minutes: int,
    max_downloads: int,
    archive: Path | None = None,
    size: int | None = None,
) -> tuple[str, dict]:
    """링크를 만든다. (토큰, 공개 정보) — 토큰은 이때만 알 수 있다."""
    minutes = max(MINUTES_MIN, min(MINUTES_MAX, int(minutes)))
    now = time.time()
    token = secrets.token_urlsafe(32)
    share = {
        "id": secrets.token_hex(8),
        "path": str(real),
        "kind": kind,
        "name": f"{real.name}.zip" if kind == "dir" else real.name,
        "size": size if size is not None else real.stat().st_size,
        "created": now,
        "expires": now + minutes * 60,
        "max_downloads": max(0, int(max_downloads)),
        "downloads": 0,
        "archive": archive.name if archive else None,
    }
    try:
        with _lock:
            shares = _load()
            alive = {h: s for h, s in shares.items() if _alive(s, now)}
            for key in shares.keys() - alive.keys():
                _drop(shares[key])
            if len(alive) >= MAX_ACTIVE:
                raise FsError(
                    f"공유 링크가 너무 많아요 (최대 {MAX_ACTIVE}개). 안 쓰는 링크를 지워 주세요."
                )
            alive[_hash(token)] = share
            _save(alive)
    except BaseException:
        if archive:
            archive.unlink(missing_ok=True)
        raise
    logger.info(
        "공유 링크 만듦 · %s · %s · %d분 · 횟수 %s",
        share["id"],
        real,
        minutes,
        share["max_downloads"] or "제한 없음",
    )
    return token, public(share)


def public(share: dict) -> dict:
    return {
        key: share[key]
        for key in (
            "id",
            "path",
            "kind",
            "name",
            "size",
            "created",
            "expires",
            "max_downloads",
            "downloads",
        )
    }


def active() -> list[dict]:
    now = time.time()
    with _lock:
        shares = _load()
    items = [public(s) for s in shares.values() if _alive(s, now)]
    return sorted(items, key=lambda s: s["created"], reverse=True)


def revoke(share_id: str) -> bool:
    with _lock:
        shares = _load()
        for key, share in list(shares.items()):
            if share.get("id") == share_id:
                _drop(shares.pop(key))
                _save(shares)
                logger.info("공유 링크 취소 · %s · %s", share_id, share["path"])
                return True
    return False


def find(token: str) -> dict | None:
    """살아 있는 링크 정보 (토큰 모양이 틀리거나 없거나 만료면 None)."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    with _lock:
        share = _load().get(_hash(token))
    return share if share and _alive(share, time.time()) else None


def claim(token: str) -> dict | None:
    """내려받기 한 번을 센다 (횟수 제한을 넘지 않게 잠금 안에서)."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    key = _hash(token)
    with _lock:
        shares = _load()
        share = shares.get(key)
        if not share or not _alive(share, time.time()):
            return None
        share["downloads"] += 1
        _save(shares)
    return dict(share)


def open_shared(share: dict):
    """내려줄 파일을 연다. (파일 객체, 크기) — 경로가 바뀌었거나 범위를 벗어나면 FileNotFoundError."""
    try:
        if share["kind"] == "dir":
            archive = _archive(share)
            if archive is None:
                raise FileNotFoundError
            source, st = fs_service.open_confined(archive, cache_dir().resolve())
        else:
            real = Path(share["path"])
            if not fs_service._inside(real) or real.resolve(strict=True) != real:
                raise FileNotFoundError
            # 공유할 때와 같은 위치의 일반 파일만 (중간 폴더나 파일이 링크로 바뀌면 거부)
            source, st = fs_service.open_confined(real, real)
    except (OSError, FsError) as error:
        logger.warning("공유 파일을 열 수 없음 · %s · %s", share.get("id"), error)
        raise FileNotFoundError from error
    return source, st.st_size
