"""프롬프트 첨부 파일 저장소.

첨부 파일은 에이전트(Claude Code / Codex)가 경로로 읽을 수 있도록 서버 디스크에 저장한다.
- 저장 위치는 프로젝트 저장소 밖(기본 ~/.univdash/uploads)이라 에이전트가 실수로 커밋하지 않는다.
- 파일 이름은 서버가 정한다: "<랜덤 12자리>-<정리된 원래 이름>". 클라이언트 경로는 쓰지 않는다.
- 다시 내려받는 API 는 없다. 업로드와 삭제만 있다.
"""

import os
import re
import secrets
import time
import unicodedata
from pathlib import Path

UPLOAD_ID = re.compile(r"^[0-9a-f]{12}-[\w.\-]{1,120}$")
_UNSAFE = re.compile(r"[^\w.\-]+")


def upload_dir() -> Path:
    configured = os.getenv("UNIVDASH_UPLOAD_DIR")
    base = Path(configured).expanduser() if configured else Path.home() / ".univdash" / "uploads"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    return base.resolve()


def max_bytes() -> int:
    try:
        megabytes = float(os.getenv("UNIVDASH_UPLOAD_MAX_MB", "50"))
    except ValueError:
        megabytes = 50
    return int(max(1, megabytes) * 1024 * 1024)


def ttl_seconds() -> float:
    try:
        days = float(os.getenv("UNIVDASH_UPLOAD_TTL_DAYS", "7"))
    except ValueError:
        days = 7
    return max(0.0, days) * 86400


def safe_name(name: str) -> str:
    """원래 파일 이름에서 경로·제어 문자를 걷어내 셸/프롬프트에 안전한 이름으로 만든다."""
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
    """업로드 ID → 실제 경로. 업로드 폴더 밖이나 없는 파일이면 KeyError."""
    if not isinstance(upload_id, str) or not UPLOAD_ID.match(upload_id):
        raise KeyError("첨부 파일을 찾을 수 없습니다.")
    directory = upload_dir()
    path = (directory / upload_id).resolve()
    if path.parent != directory or not path.is_file():
        raise KeyError("첨부 파일을 찾을 수 없습니다.")
    return path


def remove(upload_id: str) -> None:
    resolve(upload_id).unlink(missing_ok=True)


def cleanup(now: float | None = None) -> int:
    """보관 기간이 지난 첨부 파일을 지운다 (0 이면 지우지 않음)."""
    ttl = ttl_seconds()
    if not ttl:
        return 0
    now = now or time.time()
    removed = 0
    for path in upload_dir().iterdir():
        try:
            if path.is_file() and UPLOAD_ID.match(path.name) and now - path.stat().st_mtime > ttl:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed
