"""Explorer display settings (stored on the server → shared by phone and PC)."""

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
        if (
            isinstance(value, str)
            and value.startswith("/")
            and "\0" not in value
            and len(value) <= 4096
            and value not in seen
        ):
            seen.add(value)
            result.append(value)
    return result[:limit]


class ExplorerPrefs(BaseModel):
    pinned: list[str] = Field(
        default_factory=list, max_length=50
    )  # pinned folders used as roots
    hidden: list[str] = Field(
        default_factory=list, max_length=2000
    )  # entries hidden by the user (absolute paths)
    orders: dict[str, list[str]] = Field(
        default_factory=dict
    )  # manual order per folder (list of names)
    sort: str = "name"
    show_dotfiles: bool = False  # files starting with .
    show_hidden: bool = False  # also show hidden entries, dimmed

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
            if (
                isinstance(directory, str)
                and directory.startswith("/")
                and isinstance(names, list)
            ):
                cleaned[directory] = [
                    n
                    for n in names
                    if isinstance(n, str) and n and "/" not in n and len(n) <= 255
                ][:5000]
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
