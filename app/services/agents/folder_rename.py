"""When the working folder an agent runs in is renamed, restart it at the new path with the same conversation.

A process's working folder follows a rename, but Claude · Codex remember the path they were started with, so
commands fail and the conversation history stays tied to the old folder.

Detection: if the start path (environment variable PWD) is gone but the actual working folder exists, it was renamed.
This catches a rename from the dashboard and an `mv` in a terminal alike, and is not missed across a dashboard restart.
The agent is restarted only while it is idle and the screen has been quiet for a moment (work · questions · input
are never interrupted).
"""

import asyncio
import logging
import os
import time
from pathlib import Path

import psutil

from app.services.agents import (
    agent_restart,
    session_move,
    tmux_service,
    transcript_service,
)
from app.services.agents.tmux_service import TmuxError

logger = logging.getLogger(__name__)

TICK_SECONDS = 5
QUIET_SECONDS = 15
RETRY_SECONDS = 60

_launch_dirs: dict[tuple[int, float], str | None] = {}
_retry_at: dict[int, float] = {}


def _launch_dir(proc: psutil.Process) -> str | None:
    key = (proc.pid, proc.create_time())
    if key not in _launch_dirs:
        if len(_launch_dirs) > 512:
            _launch_dirs.clear()
        # Does not change while the process lives
        _launch_dirs[key] = proc.environ().get("PWD")
    return _launch_dirs[key]


def renamed(proc: psutil.Process) -> tuple[str, str] | None:
    """(old path, current path) if renamed. A folder entered through a symlink still has its old path, so it does not match."""
    old = _launch_dir(proc)
    if not old or os.path.exists(old):
        return None
    new = proc.cwd()
    if new == old or not os.path.isdir(new):  # the folder was deleted
        return None
    return old, new


def _changed_roots(old: str, new: str) -> tuple[Path, Path]:
    """For /a/oldname/b → /a/newname/b, returns (/a/oldname, /a/newname)."""
    before, after = Path(old).parts, Path(new).parts
    same = 0
    while same < min(len(before), len(after)) and before[-1 - same] == after[-1 - same]:
        same += 1
    return Path(*before[: len(before) - same]), Path(*after[: len(after) - same])


def _fix_session_dirs(old: str, new: str) -> None:
    """Move the tmux session default folder too, so windows opened later open at the new path."""
    old_root, new_root = _changed_roots(old, new)
    separator = tmux_service.SEP
    listing = tmux_service._run(
        ["list-sessions", "-F", f"#{{session_id}}{separator}#{{session_path}}"]
    )
    for line in listing.splitlines():
        session_id, _, path = line.partition(separator)
        if os.path.exists(path):
            continue
        try:
            target = new_root / Path(path).relative_to(old_root)
        except ValueError:
            continue
        if target.is_dir():
            session_move._set_session_dir(session_id, target)


def _may_restart(window, pane_pid: int, now: float) -> bool:
    return (
        window.status == "idle"
        and not window.starting
        and now - window.activity >= QUIET_SECONDS
        and time.monotonic() >= _retry_at.get(pane_pid, 0)
    )


def _follow(window, pane, old: str, new: str) -> None:
    try:
        _fix_session_dirs(old, new)
    except (TmuxError, OSError) as error:
        logger.warning(
            "Could not move the session default folder · %s · %s", window.key, error
        )
    if not _may_restart(window, pane.pid, time.time()):
        return
    try:
        agent_restart.restart(pane.id, update=False, cwd=Path(new))
    except (ValueError, KeyError, TmuxError, OSError, psutil.Error) as error:
        _retry_at[pane.pid] = time.monotonic() + RETRY_SECONDS
        logger.warning("Could not apply the folder rename · %s · %s", window.key, error)
        return
    _retry_at.pop(pane.pid, None)
    logger.info("Folder rename applied · %s · %s → %s", window.key, old, new)


def tick() -> None:
    for window in tmux_service.cached_windows(TICK_SECONDS):
        for pane in window.panes:
            agent = tmux_service.agent_of(pane.command)
            if agent is None:
                continue
            try:
                proc = transcript_service._agent_process(pane.pid, agent)
                found = renamed(proc) if proc else None
            except psutil.Error:
                continue
            if found:
                _follow(window, pane, *found)


async def loop() -> None:
    while True:
        await asyncio.sleep(TICK_SECONDS)
        try:
            await asyncio.to_thread(tick)
        except Exception:
            logger.exception("Folder rename check failed")
