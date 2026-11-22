"""Window list organize settings (folders, order, hidden, aliases).

Windows are stored under a "session-name:window-number" key so they survive a tmux server restart.
"""

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.i18n import _
from app.paths import data_dir

WINDOW_KEY = re.compile(r"^[\w\-가-힣]{1,50}:\d{1,4}$")
FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
FOLDER_COLORS = {"blue", "purple", "emerald", "amber", "rose", "cyan", "slate"}
# Workspace list sorting: status (working agents first) / recent activity / name / manual (the organize order)
SORT_MODES = {"status", "activity", "name", "manual"}
MAX_ITEMS = 500
NAV_ORDER_DEFAULT = ("workspace", "git", "ai_usage", "server", "domains")


def _unique_keys(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values:
        if isinstance(value, str) and WINDOW_KEY.match(value) and value not in seen:
            seen.add(value)
            result.append(value)
    return result


NOTE_MAX = 120


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
            raise ValueError(_("잘못된 폴더 ID"))
        return value

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError(_("폴더 이름이 비었습니다."))
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
    # Order of the windows outside folders
    order: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)
    hidden: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)
    aliases: dict[str, str] = Field(default_factory=dict)
    # One-line note under the window name (when empty, the task title set by the agent is used as is)
    notes: dict[str, str] = Field(default_factory=dict)
    sort: str = "status"
    nav_order: list[str] = Field(
        default_factory=lambda: list(NAV_ORDER_DEFAULT), max_length=20
    )

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

    @field_validator("notes")
    @classmethod
    def validate_notes(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {}
        for key, note in list(value.items())[:MAX_ITEMS]:
            note = " ".join(str(note).split())[:NOTE_MAX]
            if WINDOW_KEY.match(key) and note:
                cleaned[key] = note
        return cleaned

    @field_validator("nav_order")
    @classmethod
    def validate_nav_order(cls, value: list[str]) -> list[str]:
        allowed = set(NAV_ORDER_DEFAULT)
        ordered = list(dict.fromkeys(key for key in value if key in allowed))
        # An order saved earlier has no Domains → put it right below Servers
        if "domains" not in ordered and "server" in ordered:
            ordered.insert(ordered.index("server") + 1, "domains")
        return ordered + [key for key in NAV_ORDER_DEFAULT if key not in ordered]

    def normalized(self) -> "Preferences":
        """Keep a window from being in several folders and remove duplicate folder IDs."""
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
    """When a session is renamed, move "oldname:N" keys to "newname:N" (folders · order · hidden · notes kept, aliases removed)."""
    prefix = f"{old}:"

    def move(key: str) -> str:
        return f"{new}:{key[len(prefix) :]}" if key.startswith(prefix) else key

    data = prefs.model_dump()
    for folder in data["folders"]:
        folder["items"] = [move(k) for k in folder["items"]]
    data["order"] = [move(k) for k in data["order"]]
    data["hidden"] = [move(k) for k in data["hidden"]]
    data["aliases"] = {
        k: v for k, v in data["aliases"].items() if not k.startswith(prefix)
    }
    # Notes follow the window as they are
    data["notes"] = {move(k): v for k, v in data["notes"].items()}
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
            # Atomic replace: the existing settings stay intact even if the server dies mid-write.
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
