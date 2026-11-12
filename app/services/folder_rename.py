"""에이전트가 돌고 있는 작업 폴더의 이름이 바뀌면 새 경로에서 같은 대화로 다시 켠다.

프로세스의 작업 폴더는 이름이 바뀌어도 따라가지만, Claude · Codex 는 켤 때의 경로를 기억하고 있어
명령이 실패하고 대화 기록도 옛 폴더에 묶인다.

감지: 켤 때의 경로(환경 변수 PWD)는 사라졌는데 실제 작업 폴더는 있으면 이름이 바뀐 것이다.
대시보드에서 바꿨든 터미널에서 mv 했든 똑같이 잡히고, 대시보드가 재시작돼도 놓치지 않는다.
에이전트가 쉬고 있고 화면이 잠시 조용할 때만 다시 켠다 (작업 · 질문 · 입력을 끊지 않는다).
"""

import asyncio
import logging
import os
import time
from pathlib import Path

import psutil

from app.services import agent_restart, session_move, tmux_service, transcript_service
from app.services.tmux_service import TmuxError

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
        _launch_dirs[key] = proc.environ().get(
            "PWD"
        )  # 프로세스가 사는 동안 바뀌지 않는다
    return _launch_dirs[key]


def renamed(proc: psutil.Process) -> tuple[str, str] | None:
    """이름이 바뀌었으면 (옛 경로, 지금 경로). 심볼릭 링크로 들어간 폴더는 옛 경로가 그대로 있어 걸리지 않는다."""
    old = _launch_dir(proc)
    if not old or os.path.exists(old):
        return None
    new = proc.cwd()
    if new == old or not os.path.isdir(new):  # 폴더를 지운 경우
        return None
    return old, new


def _changed_roots(old: str, new: str) -> tuple[Path, Path]:
    """/a/옛이름/b → /a/새이름/b 면 (/a/옛이름, /a/새이름)."""
    before, after = Path(old).parts, Path(new).parts
    same = 0
    while same < min(len(before), len(after)) and before[-1 - same] == after[-1 - same]:
        same += 1
    return Path(*before[: len(before) - same]), Path(*after[: len(after) - same])


def _fix_session_dirs(old: str, new: str) -> None:
    """tmux 세션 기본 폴더도 옮겨, 이후 여는 창이 새 경로에서 열리게 한다."""
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
        logger.warning("세션 기본 폴더를 옮기지 못함 · %s · %s", window.key, error)
    if not _may_restart(window, pane.pid, time.time()):
        return
    try:
        agent_restart.restart(pane.id, update=False, cwd=Path(new))
    except (ValueError, KeyError, TmuxError, OSError, psutil.Error) as error:
        _retry_at[pane.pid] = time.monotonic() + RETRY_SECONDS
        logger.warning("폴더 이름 변경을 반영하지 못함 · %s · %s", window.key, error)
        return
    _retry_at.pop(pane.pid, None)
    logger.info("폴더 이름 변경 반영 · %s · %s → %s", window.key, old, new)


def tick() -> None:
    for window in tmux_service.cached_windows(TICK_SECONDS):
        for pane in window.panes:
            if pane.command not in tmux_service.AGENTS:
                continue
            try:
                proc = transcript_service._agent_process(pane.pid, pane.command)
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
            logger.exception("폴더 이름 변경 확인 실패")
