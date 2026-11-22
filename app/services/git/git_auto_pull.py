"""Per-repository auto pull. Repositories that have it turned on are pulled at a set interval.

It runs while nobody is watching, so it never does anything that could damage a repository.
- Fast-forward only. It creates no merge commit or rebase and does not touch local changes.
  (`git pull --ff-only` can behave differently depending on configuration, so it is split into fetch and
  `merge --ff-only`)
- When history has diverged or local changes overlap, it changes nothing and only records the reason.
- When it collides with another Git operation, it skips and tries again a little later.
"""

import asyncio
import json
import logging
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir
from app.services.git import git_workflow
from app.services.git.git_service import GitService

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_MINUTES = 15
MIN_INTERVAL_MINUTES = 1
MAX_INTERVAL_MINUTES = 7 * 24 * 60
TICK_SECONDS = 20
MAX_CONCURRENT = 3
MAX_MESSAGE = 300

_lock = threading.Lock()


def _path() -> Path:
    return data_dir() / "git_auto_pull.json"


def _load() -> dict[str, dict]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {key: value for key, value in raw.items() if isinstance(value, dict)}


def _save(entries: dict[str, dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".git_auto_pull.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, ensure_ascii=False, indent=2)
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _public(entry: dict | None) -> dict:
    entry = entry or {}
    enabled = bool(entry.get("enabled"))
    interval = entry.get("interval_minutes", DEFAULT_INTERVAL_MINUTES)
    last_run = entry.get("last_run")
    return {
        "enabled": enabled,
        "interval_minutes": interval,
        "last_run": last_run,
        "next_run": last_run + interval * 60 if enabled and last_run else None,
        "ok": entry.get("ok"),
        "message": entry.get("message", ""),
        "updated_at": entry.get("updated_at"),
        "commits": entry.get("commits", 0),
    }


def overview() -> dict[str, dict]:
    with _lock:
        entries = _load()
    return {key: _public(entry) for key, entry in entries.items()}


def status(repository_id: str) -> dict:
    with _lock:
        return _public(_load().get(repository_id))


def configure(repository_id: str, enabled: bool, interval_minutes: int) -> dict:
    GitService._get_repository(
        repository_id
    )  # only discovered repositories are registered
    with _lock:
        entries = _load()
        entry = entries.setdefault(repository_id, {})
        entry["enabled"] = enabled
        entry["interval_minutes"] = interval_minutes
        _save(entries)
    return _public(entry)


def _due(now: float) -> list[str]:
    with _lock:
        entries = _load()
    return [
        key
        for key, entry in entries.items()
        if entry.get("enabled")
        and now - entry.get("last_run", 0)
        >= entry.get("interval_minutes", DEFAULT_INTERVAL_MINUTES) * 60
    ]


def _record(repository_id: str, result: dict) -> None:
    now = time.time()
    with _lock:
        entries = _load()
        entry = entries.get(repository_id)
        if entry is None:
            return
        entry.update(
            last_run=now,
            ok=result["ok"],
            message=GitService._mask(result["message"])[:MAX_MESSAGE],
        )
        if result.get("commits"):
            entry.update(updated_at=now, commits=result["commits"])
        _save(entries)


def _failed(message: str) -> dict:
    return {"ok": False, "message": message}


def _error_text(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stderr or result.stdout).strip() or _("Git 명령이 실패했습니다.")


def _pull(path: Path) -> dict:
    operation = GitService._operation(path)
    if operation:
        return _failed(
            _("{operation} 작업이 진행 중이라 건너뛰었습니다.", operation=operation)
        )
    if not GitService._text(path, "symbolic-ref", "--quiet", "--short", "HEAD"):
        return _failed(_("브랜치에 있지 않아(detached HEAD) 건너뛰었습니다."))
    upstream = GitService._text(
        path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
    )
    if not upstream:
        return _failed(_("이 브랜치에 upstream 이 없어 받을 곳을 알 수 없습니다."))

    fetched = GitService._run(path, "fetch")
    if fetched.returncode != 0:
        return _failed(_("fetch 실패: {error}", error=_error_text(fetched)))

    counted = GitService._run(
        path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}", timeout=20
    )
    if counted.returncode != 0:
        return _failed(_error_text(counted))
    ahead, behind = (int(part) for part in counted.stdout.split())
    if not behind:
        message = (
            _("이미 최신입니다. (보낼 커밋 {ahead}개 있음)", ahead=ahead)
            if ahead
            else _("이미 최신입니다.")
        )
        return {"ok": True, "message": message}
    if ahead:
        return _failed(
            _(
                "로컬 커밋 {ahead}개와 원격 커밋 {behind}개가 갈라져 있어 건너뛰었습니다. 직접 Pull 해 주십시오.",
                ahead=ahead,
                behind=behind,
            )
        )

    # Auto-stash must stay off here (a scheduled pull never touches local changes). The switch is given as a
    # config value, not as `--no-autostash`: Git older than 2.27 does not know that option and fails with
    # "unknown option `no-autostash'", while an unknown config key is simply ignored.
    merged = GitService._run(
        path, "-c", "merge.autoStash=false", "merge", "--ff-only", "@{upstream}"
    )
    if merged.returncode != 0:
        output = _error_text(merged)
        if "overwritten by merge" in output:
            return _failed(
                _(
                    "로컬 변경과 겹치는 파일이 있어 건너뛰었습니다. 변경을 커밋하거나 스태시해 주십시오."
                )
            )
        return _failed(output)
    return {
        "ok": True,
        "message": _("커밋 {behind}개를 받았습니다.", behind=behind),
        "commits": behind,
    }


def pull(repository_id: str) -> dict | None:
    """Pulls once. None when another Git operation is running."""
    repository = GitService._get_repository(repository_id)
    if git_workflow.running_for(repository_id):
        return None
    lock = GitService._lock_for(repository_id)
    if not lock.acquire(blocking=False):
        return None
    try:
        return _pull(repository.path)
    finally:
        lock.release()


def _run_one(repository_id: str) -> None:
    try:
        result = pull(repository_id)
    except KeyError:
        result = _failed(_("저장소를 찾지 못했습니다."))
    except subprocess.TimeoutExpired:
        result = _failed(_("시간 안에 끝나지 않아 중단했습니다."))
    except (OSError, RuntimeError, ValueError) as error:
        result = _failed(str(error))
    if result is None:
        return
    _record(repository_id, result)
    if result.get("commits"):
        logger.info("auto pull · %s · %s commits", repository_id, result["commits"])
    elif not result["ok"]:
        logger.warning(
            "auto pull failed · %s · %s",
            repository_id,
            GitService._mask(result["message"]),
        )


async def loop() -> None:
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def run(repository_id: str) -> None:
        async with semaphore:
            await asyncio.to_thread(_run_one, repository_id)

    while True:
        await asyncio.sleep(TICK_SECONDS)
        try:
            due = await asyncio.to_thread(_due, time.time())
            await asyncio.gather(*(run(repository_id) for repository_id in due))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("auto pull check failed")
