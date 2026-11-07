"""저장소별 자동 Pull. 켜 둔 저장소를 정해진 주기마다 받아 온다.

사람이 보지 않는 동안 돌기 때문에 저장소를 망가뜨릴 수 있는 일은 하지 않는다.
- fast-forward 만 한다. 머지 커밋이나 rebase 를 만들지 않고, 로컬 변경을 건드리지 않는다.
  (`git pull --ff-only` 는 설정에 따라 동작이 달라질 수 있어 fetch 와 `merge --ff-only` 로 나눈다)
- 갈라졌거나 겹치는 로컬 변경이 있으면 아무것도 바꾸지 않고 이유만 남긴다.
- 다른 Git 작업과 겹치면 건너뛰고 잠시 뒤 다시 시도한다.
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

from app.paths import data_dir
from app.services import git_workflow
from app.services.git_service import GitService

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
    GitService._get_repository(repository_id)  # 찾아낸 저장소만 등록한다
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
    return (result.stderr or result.stdout).strip() or "Git 명령이 실패했어요."


def _pull(path: Path) -> dict:
    operation = GitService._operation(path)
    if operation:
        return _failed(f"{operation} 작업이 진행 중이라 건너뛰었어요.")
    if not GitService._text(path, "symbolic-ref", "--quiet", "--short", "HEAD"):
        return _failed("브랜치에 있지 않아(detached HEAD) 건너뛰었어요.")
    upstream = GitService._text(
        path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
    )
    if not upstream:
        return _failed("이 브랜치에 upstream 이 없어 받을 곳을 모르겠어요.")

    fetched = GitService._run(path, "fetch")
    if fetched.returncode != 0:
        return _failed(f"fetch 실패: {_error_text(fetched)}")

    counted = GitService._run(
        path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}", timeout=20
    )
    if counted.returncode != 0:
        return _failed(_error_text(counted))
    ahead, behind = (int(part) for part in counted.stdout.split())
    if not behind:
        extra = f" (보낼 커밋 {ahead}개 있음)" if ahead else ""
        return {"ok": True, "message": f"이미 최신이에요.{extra}"}
    if ahead:
        return _failed(
            f"로컬 커밋 {ahead}개와 원격 커밋 {behind}개가 갈라져 있어 건너뛰었어요. 직접 Pull 해 주세요."
        )

    merged = GitService._run(
        path, "merge", "--ff-only", "--no-autostash", "@{upstream}"
    )
    if merged.returncode != 0:
        output = _error_text(merged)
        if "overwritten by merge" in output:
            return _failed(
                "로컬 변경과 겹치는 파일이 있어 건너뛰었어요. 변경을 커밋하거나 스태시해 주세요."
            )
        return _failed(output)
    return {"ok": True, "message": f"커밋 {behind}개를 받았어요.", "commits": behind}


def pull(repository_id: str) -> dict | None:
    """한 번 받아 온다. 다른 Git 작업이 돌고 있으면 None."""
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
        result = _failed("저장소를 찾지 못했어요.")
    except subprocess.TimeoutExpired:
        result = _failed("시간 안에 끝나지 않아 중단했어요.")
    except (OSError, RuntimeError, ValueError) as error:
        result = _failed(str(error))
    if result is None:
        return
    _record(repository_id, result)
    if result.get("commits"):
        logger.info("자동 Pull · %s · 커밋 %s개", repository_id, result["commits"])
    elif not result["ok"]:
        logger.warning(
            "자동 Pull 실패 · %s · %s",
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
            logger.exception("자동 Pull 확인 실패")
