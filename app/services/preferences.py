"""창 목록 정리 설정 (폴더, 순서, 숨김, 별칭).

창은 tmux 서버가 재시작돼도 유지되도록 "세션이름:창번호" 키로 저장한다.
"""

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from app.paths import data_dir
from pydantic import BaseModel, Field, field_validator

WINDOW_KEY = re.compile(r"^[\w\-가-힣]{1,50}:\d{1,4}$")
FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
FOLDER_COLORS = {"blue", "purple", "emerald", "amber", "rose", "cyan", "slate"}
# Workspace 목록 정렬: 상태(작업 중 에이전트 먼저) / 최근 활동 / 이름 / 직접 지정(창 정리 순서)
SORT_MODES = {"status", "activity", "name", "manual"}
MAX_ITEMS = 500


def _unique_keys(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values:
        if isinstance(value, str) and WINDOW_KEY.match(value) and value not in seen:
            seen.add(value)
            result.append(value)
    return result


class Folder(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=40)
    color: str = "blue"
    collapsed: bool = False
    items: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not FOLDER_ID.match(value):
            raise ValueError("잘못된 폴더 ID")
        return value

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("폴더 이름이 비었습니다.")
        return value

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        return value if value in FOLDER_COLORS else "blue"

    @field_validator("items")
    @classmethod
    def validate_items(cls, value: list[str]) -> list[str]:
        return _unique_keys(value)


class Preferences(BaseModel):
    folders: list[Folder] = Field(default_factory=list, max_length=100)
    order: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)  # 폴더 밖 창 순서
    hidden: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)
    aliases: dict[str, str] = Field(default_factory=dict)
    sort: str = "status"

    @field_validator("sort")
    @classmethod
    def validate_sort(cls, value: str) -> str:
        return value if value in SORT_MODES else "status"

    @field_validator("order", "hidden")
    @classmethod
    def validate_keys(cls, value: list[str]) -> list[str]:
        return _unique_keys(value)

    @field_validator("aliases")
    @classmethod
    def validate_aliases(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {}
        for key, alias in list(value.items())[:MAX_ITEMS]:
            alias = " ".join(str(alias).split())[:60]
            if WINDOW_KEY.match(key) and alias:
                cleaned[key] = alias
        return cleaned

    def normalized(self) -> "Preferences":
        """한 창이 여러 폴더에 들어가지 않게 하고, 폴더 ID 중복을 없앤다."""
        placed: set[str] = set()
        folders = []
        folder_ids: set[str] = set()
        for folder in self.folders:
            if folder.id in folder_ids:
                continue
            folder_ids.add(folder.id)
            items = [key for key in folder.items if key not in placed]
            placed.update(items)
            folders.append(folder.model_copy(update={"items": items}))
        order = [key for key in self.order if key not in placed]
        return self.model_copy(update={"folders": folders, "order": order})


def rename_session_keys(prefs: "Preferences", old: str, new: str) -> "Preferences":
    """세션 이름이 바뀌면 "이전이름:N" 키를 "새이름:N" 으로 옮긴다 (폴더 · 순서 · 숨김 유지, 별칭은 지움)."""
    prefix = f"{old}:"

    def move(key: str) -> str:
        return f"{new}:{key[len(prefix):]}" if key.startswith(prefix) else key

    data = prefs.model_dump()
    for folder in data["folders"]:
        folder["items"] = [move(k) for k in folder["items"]]
    data["order"] = [move(k) for k in data["order"]]
    data["hidden"] = [move(k) for k in data["hidden"]]
    data["aliases"] = {k: v for k, v in data["aliases"].items() if not k.startswith(prefix)}
    return Preferences.model_validate(data)


class PreferencesStore:
    _lock = threading.Lock()

    @staticmethod
    def _path() -> Path:
        return data_dir() / "preferences.json"

    @classmethod
    def load(cls) -> Preferences:
        path = cls._path()
        with cls._lock:
            try:
                raw: Any = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return Preferences()
        try:
            return Preferences.model_validate(raw).normalized()
        except ValueError:
            return Preferences()

    @classmethod
    def save(cls, preferences: Preferences) -> Preferences:
        preferences = preferences.normalized()
        path = cls._path()
        payload = json.dumps(preferences.model_dump(), ensure_ascii=False, indent=2)
        with cls._lock:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # 원자적 교체: 쓰는 도중 서버가 죽어도 기존 설정이 깨지지 않는다.
            fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".preferences.")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                os.chmod(temp_name, 0o600)
                os.replace(temp_name, path)
            except BaseException:
                Path(temp_name).unlink(missing_ok=True)
                raise
        return preferences
