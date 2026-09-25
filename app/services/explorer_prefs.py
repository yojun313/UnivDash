"""Explorer 표시 설정 (서버에 저장 → 휴대폰 · PC 가 같이 쓴다)."""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.paths import data_dir

SORT_MODES = {"name", "mixed", "type", "modified", "size", "manual"}


def _paths(values: list[str], limit: int = 500) -> list[str]:
    seen, result = set(), []
    for value in values:
        if isinstance(value, str) and value.startswith("/") and "\0" not in value and len(value) <= 4096 and value not in seen:
            seen.add(value)
            result.append(value)
    return result[:limit]


class ExplorerPrefs(BaseModel):
    pinned: list[str] = Field(default_factory=list, max_length=50)       # 루트로 쓸 고정 폴더
    hidden: list[str] = Field(default_factory=list, max_length=2000)     # 사용자가 가린 항목(절대 경로)
    orders: dict[str, list[str]] = Field(default_factory=dict)           # 폴더별 직접 지정 순서 (이름 목록)
    sort: str = "name"
    show_dotfiles: bool = False                                          # . 으로 시작하는 파일
    show_hidden: bool = False                                            # 가린 항목도 흐리게 보기

    @field_validator("pinned", "hidden")
    @classmethod
    def validate_paths(cls, value: list[str]) -> list[str]:
        return _paths(value)

    @field_validator("sort")
    @classmethod
    def validate_sort(cls, value: str) -> str:
        return value if value in SORT_MODES else "name"

    @field_validator("orders")
    @classmethod
    def validate_orders(cls, value: dict[str, list[str]]) -> dict[str, list[str]]:
        cleaned = {}
        for directory, names in list(value.items())[:500]:
            if isinstance(directory, str) and directory.startswith("/") and isinstance(names, list):
                cleaned[directory] = [n for n in names if isinstance(n, str) and n and "/" not in n and len(n) <= 255][:5000]
        return cleaned


class ExplorerPrefsStore:
    _lock = threading.Lock()

    @staticmethod
    def _path() -> Path:
        return data_dir() / "explorer.json"

    @classmethod
    def load(cls) -> ExplorerPrefs:
        with cls._lock:
            try:
                raw: Any = json.loads(cls._path().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return ExplorerPrefs()
        try:
            return ExplorerPrefs.model_validate(raw)
        except ValueError:
            return ExplorerPrefs()

    @classmethod
    def save(cls, prefs: ExplorerPrefs) -> ExplorerPrefs:
        path = cls._path()
        payload = json.dumps(prefs.model_dump(), ensure_ascii=False)
        with cls._lock:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".explorer.")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                os.chmod(temp, 0o600)
                os.replace(temp, path)
            except BaseException:
                Path(temp).unlink(missing_ok=True)
                raise
        return prefs
