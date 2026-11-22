"""Share links: let one file or folder be downloaded without signing in for a set time.

Security
- The link token is a 256-bit random value and the server stores only its SHA-256 hash (data/shares.json, 0600).
  A leaked store cannot be turned into links, and the link is shown only once, at creation.
- One link serves exactly one fixed path. The receiver cannot choose a path or a name.
- The file is re-checked on every download: still inside the allowed range, not replaced by a link
  (O_NOFOLLOW + the actually opened path is re-checked through /proc).
- A folder is packed into a zip with its contents at the moment of sharing. Links inside the folder are included
  only when they point inside that folder, and .env · private keys · .git are left out. The server never
  compresses on a receiver's request.
- Folders that collect secrets (~/.ssh · ~/.claude · ~/.codex · ~/.univdash etc.) and anything inside them, and
  the explorer root (the whole home), cannot be shared.
- Expired, used-up and revoked links answer exactly like links that never existed.
- Optionally (off by default) an access code is created too: a code delivered separately from the link is needed
  to download, and before the code is entered not even the file name or size is shown
  (app/services/sharing/access_code.py).
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

from app.i18n import _
from app.paths import data_dir
from app.services.files import fs_service
from app.services.files.fs_service import FsError
from app.services.sharing import access_code

logger = logging.getLogger(__name__)

MINUTES_MIN = 1
MINUTES_MAX = 7 * 24 * 60
MINUTES_DEFAULT = 15
MAX_ACTIVE = 30  # links alive at the same time
TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32)

# Relative to home — these folders (files), anything inside them and any folder containing them cannot be shared
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
    """Removes expired links with their packed zips, and orphaned zips."""
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
            # A file still being packed (.part) is removed only if it is still there after an hour
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
            logger.exception("share link cleanup failed")
        await asyncio.sleep(60)


def check_target(path: str) -> tuple[Path, str]:
    """Checks that the path may be shared and returns (real path, 'file' | 'dir')."""
    candidate = fs_service.resolve(path)
    real = candidate.resolve(strict=True)
    if not fs_service._inside(real):
        raise FsError(_("허용된 폴더 밖입니다."))
    if real.is_dir():
        kind = "dir"
    elif real.is_file():
        kind = "file"
    else:
        raise FsError(_("파일이나 폴더만 공유할 수 있습니다."))
    if any(real == root for root in fs_service.roots()):
        raise FsError(_("탐색기 맨 위 폴더(홈 전체)는 공유할 수 없습니다."))
    home = Path.home().resolve()
    for rel in SENSITIVE:
        secret = home / rel
        if real == secret or secret in real.parents or real in secret.parents:
            raise FsError(
                _("비밀 정보가 있는 위치(~/{rel})는 공유할 수 없습니다.", rel=rel)
            )
    if ".git" in real.parts:
        raise FsError(_(".git 폴더와 그 안은 공유할 수 없습니다."))
    if kind == "file" and SECRET_NAME.match(real.name):
        raise FsError(_(".env · 개인 키 같은 비밀 파일은 공유할 수 없습니다."))
    return real, kind


def zip_for_share(real: Path, skip_ignored: bool, progress) -> tuple[Path, int]:
    """Packs a folder into a zip for sharing and keeps it in the cache. (zip path, size)"""
    archive, _size = fs_service.zip_folder(
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
    require_code: bool = False,
) -> tuple[str, str | None, dict]:
    """Creates a link. (token, access code or None, public info) — the token and code are only known here.

    With require_code an access code to be delivered separately from the link is created, and downloading needs it.
    """
    minutes = max(MINUTES_MIN, min(MINUTES_MAX, int(minutes)))
    now = time.time()
    token = secrets.token_urlsafe(32)
    code, stored = access_code.make() if require_code else (None, {})
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
        **stored,
    }
    try:
        with _lock:
            shares = _load()
            alive = {h: s for h, s in shares.items() if _alive(s, now)}
            for key in shares.keys() - alive.keys():
                _drop(shares[key])
            if len(alive) >= MAX_ACTIVE:
                raise FsError(
                    _(
                        "공유 링크가 너무 많습니다 (최대 {count}개). 안 쓰는 링크를 지워 주십시오.",
                        count=MAX_ACTIVE,
                    )
                )
            alive[_hash(token)] = share
            _save(alive)
    except BaseException:
        if archive:
            archive.unlink(missing_ok=True)
        raise
    logger.info(
        "share link created · %s · %s · %d min · downloads %s%s",
        share["id"],
        real,
        minutes,
        share["max_downloads"] or "unlimited",
        " · access code required" if code else "",
    )
    return token, code, public(share)


def public(share: dict) -> dict:
    return {
        "has_code": bool(share.get("code_hash")),
        **{
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
        },
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
                access_code.forget(share_id)
                logger.info("share link revoked · %s · %s", share_id, share["path"])
                return True
    return False


def find(token: str) -> dict | None:
    """Info of a live link (None when the token is malformed, unknown or expired)."""
    if not isinstance(token, str) or not TOKEN.match(token):
        return None
    with _lock:
        share = _load().get(_hash(token))
    return share if share and _alive(share, time.time()) else None


def claim(token: str) -> dict | None:
    """Counts one download (inside the lock so the download limit is never exceeded)."""
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
    """Opens the file to serve. (file object, size) — FileNotFoundError when the path changed or left the range."""
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
            # Only a regular file at the same place as when shared (refused if a parent folder or the file became a link)
            source, st = fs_service.open_confined(real, real)
    except (OSError, FsError) as error:
        logger.warning("cannot open shared file · %s · %s", share.get("id"), error)
        raise FileNotFoundError from error
    return source, st.st_size
