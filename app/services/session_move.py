"""tmux 세션의 작업 폴더를 바꾼다. 실행 중인 에이전트는 새 폴더에서 같은 대화로 다시 켠다.

- 세션 기본 폴더: 이후 tmux 에서 새로 여는 창이 새 폴더에서 열린다.
- Claude Code · Codex 창: 끄고 → 새 폴더로 cd → 같은 대화로 다시 켠다 (agent_restart.restart).
- 셸만 있는 창: cd 만 한다.
- 다른 프로그램이 돌고 있는 창(서버 등)은 건드리지 않고 알려 준다.
작업 중이거나 응답을 기다리는 에이전트가 있으면 아무것도 하지 않고 거절한다.
"""

import logging
import os
import shlex
from pathlib import Path

from app.services import agent_restart, tmux_service

logger = logging.getLogger(__name__)


def _directory(path: str) -> Path:
    if not isinstance(path, str) or not path.strip() or "\n" in path or "\0" in path:
        raise ValueError("작업 폴더가 올바르지 않습니다.")
    directory = Path(os.path.expanduser(path.strip())).resolve()
    if not directory.is_dir():
        raise ValueError("작업 폴더가 존재하지 않습니다.")
    if not os.access(directory, os.R_OK | os.X_OK):
        raise ValueError("작업 폴더에 들어갈 수 없습니다.")
    return directory


def _set_session_dir(session_id: str, directory: Path) -> None:
    # tmux 는 세션 기본 폴더를 attach -c 로만 바꿀 수 있다. 제어 모드로 붙었다가 바로 떨어진다
    # (제어 모드 클라이언트는 창 크기에 영향을 주지 않는다).
    tmux_service._run(
        ["-C", "attach-session", "-t", session_id, "-c", str(directory)],
        input_text="",
    )


def move(session_id: str, path: str) -> dict:
    if not isinstance(session_id, str) or not tmux_service.SESSION_ID.match(session_id):
        raise KeyError("존재하지 않는 세션입니다.")
    directory = _directory(path)
    windows = [w for w in tmux_service.list_windows() if w.session_id == session_id]
    if not windows:
        raise KeyError("존재하지 않는 세션입니다.")

    agents, shells, skipped = [], [], []
    for window in windows:
        for pane in window.panes:
            if pane.command in tmux_service.AGENTS:
                if window.status == "busy":
                    raise ValueError(
                        f"{window.key} 이(가) 작업 중이에요. 끝난 뒤에 옮기세요."
                    )
                if window.status == "waiting":
                    raise ValueError(
                        f"{window.key} 이(가) 응답을 기다리고 있어요. 답한 뒤에 옮기세요."
                    )
                info = agent_restart.plan(pane.id)  # 다시 켤 수 없는 창이면 여기서 거절
                if info["agent"] == "claude":
                    agent_restart.claude_project_dir(directory)
                agents.append((window, pane))
            elif pane.command in agent_restart.SHELLS:
                shells.append((window, pane))
            else:
                skipped.append(f"{window.key} ({pane.command})")

    _set_session_dir(session_id, directory)
    for _window, pane in shells:
        tmux_service.send_literal(pane.id, f"cd -- {shlex.quote(str(directory))}")
        tmux_service.send_keys(pane.id, ["Enter"])

    moved, failed = [], []
    for window, pane in agents:
        try:
            agent_restart.restart(pane.id, update=False, cwd=directory)
            moved.append(window.key)
        except (ValueError, RuntimeError, KeyError, OSError) as error:
            failed.append(f"{window.key}: {error}")
    tmux_service.invalidate_cache()
    logger.info(
        "세션 폴더 변경 · %s → %s (에이전트 %d · 셸 %d · 그대로 %d · 실패 %d)",
        windows[0].session,
        directory,
        len(moved),
        len(shells),
        len(skipped),
        len(failed),
    )
    return {
        "session": windows[0].session,
        "path": str(directory),
        "agents": moved,
        "shells": len(shells),
        "skipped": skipped,
        "failed": failed,
    }
