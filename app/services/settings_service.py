"""서버 설정 (설정 창에서 바꾸는 값): 업로드 최대 크기, 첨부 보관 기간, 뷰어 · 편집 최대 크기.

- 데이터 폴더의 settings.json (권한 600) 에 저장한다. 없는 값은 환경 변수 → 기본값 순서로 쓴다.
- 범위를 벗어난 값은 저장하지 않는다 (pydantic 검사). 읽을 때 파일 수정 시각이 같으면 다시 읽지 않는다.
"""

import json
import os
import secrets
import threading
from pathlib import Path

from pydantic import BaseModel, Field

from app.paths import data_dir

# 큰 파일은 브라우저가 32MB 조각으로 나눠 보내므로(chunk_upload) 프록시 요청 크기 제한과 상관없다.
# 값 검사용 상한만 둔다 (1TB). 실제로는 올릴 때 서버 디스크 남은 공간도 확인한다.
UPLOAD_MAX_MB_LIMIT = 1024 * 1024


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


class ServerSettings(BaseModel):
    upload_max_mb: int = Field(
        ge=1, le=UPLOAD_MAX_MB_LIMIT
    )  # 첨부 · 파일 탐색기 업로드 한 파일 최대
    upload_ttl_days: float = Field(ge=0.5, le=30)  # 프롬프트 첨부 원본 보관 기간
    viewer_max_mb: int = Field(ge=1, le=20)  # 파일 뷰어에서 텍스트로 열 최대 크기
    edit_max_mb: int = Field(ge=1, le=50)  # 편집기에서 저장할 수 있는 최대 크기


def defaults() -> ServerSettings:
    return ServerSettings(
        upload_max_mb=int(
            min(UPLOAD_MAX_MB_LIMIT, max(1, _env_float("UNIVDASH_UPLOAD_MAX_MB", 50)))
        ),
        upload_ttl_days=min(30, max(0.5, _env_float("UNIVDASH_UPLOAD_TTL_DAYS", 1))),
        viewer_max_mb=2,
        edit_max_mb=5,
    )


_lock = threading.Lock()  # 캐시용
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
    """바뀐 값만 받아 검사한 뒤 저장한다. 범위를 벗어나면 ValueError."""
    with _write_lock:  # 동시에 두 요청이 바꿔도 한쪽 변경이 사라지지 않게
        value = ServerSettings(
            **{**get().model_dump(), **changes}
        )  # 범위 검사 (ValidationError 는 ValueError)
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
