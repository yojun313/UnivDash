"""Change the working folder of a tmux session. Running agents are restarted in the new folder with the same conversation.

- Session default folder: windows opened later in tmux open in the new folder.
- Claude Code · Codex windows: stop → cd to the new folder → restart with the same conversation (agent_restart.restart).
- Shell-only windows: just cd.
- Windows running another program (a server, etc.) are left alone and reported.
If any agent is working or waiting for an answer, nothing is done and the request is refused.
"""

import logging
import os
import shlex
from pathlib import Path

from app.i18n import _
from app.services.agents import agent_restart, tmux_service

logger = logging.getLogger(__name__)


def _directory(path: str) -> Path:
    if not isinstance(path, str) or not path.strip() or "\n" in path or "\0" in path:
        raise ValueError(_("작업 폴더가 올바르지 않습니다."))
    directory = Path(os.path.expanduser(path.strip())).resolve()
    if not directory.is_dir():
        raise ValueError(_("작업 폴더가 존재하지 않습니다."))
    if not os.access(directory, os.R_OK | os.X_OK):
        raise ValueError(_("작업 폴더에 들어갈 수 없습니다."))
    return directory


def _set_session_dir(session_id: str, directory: Path) -> None:
    # tmux can change a session's default folder only through attach -c. Attach in control mode and detach right away
    # (a control-mode client does not affect the window size).
    tmux_service._run(
        ["-C", "attach-session", "-t", session_id, "-c", str(directory)],
        input_text="",
    )


def move(session_id: str, path: str) -> dict:
    if not isinstance(session_id, str) or not tmux_service.SESSION_ID.match(session_id):
        raise KeyError(_("존재하지 않는 세션입니다."))
    directory = _directory(path)
    windows = [w for w in tmux_service.list_windows() if w.session_id == session_id]
    if not windows:
        raise KeyError(_("존재하지 않는 세션입니다."))

    agents, shells, skipped = [], [], []
    for window in windows:
        for pane in window.panes:
            if tmux_service.agent_of(pane.command):
                if window.status == "busy":
                    raise ValueError(
                        _(
                            "{key} 이(가) 작업 중입니다. 끝난 뒤에 옮기십시오.",
                            key=window.key,
                        )
                    )
                if window.status == "waiting":
                    raise ValueError(
                        _(
                            "{key} 이(가) 응답을 기다리고 있습니다. 답한 뒤에 옮기십시오.",
                            key=window.key,
                        )
                    )
                # Refused here if the window cannot be restarted
                info = agent_restart.plan(pane.id)
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
        "Session folder changed · %s → %s (agents %d · shells %d · untouched %d · failed %d)",
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
