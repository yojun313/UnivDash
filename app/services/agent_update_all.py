"""모든 에이전트 창(Claude Code · Codex)을 최신으로 업데이트하고 같은 대화로 다시 켠다. 백그라운드로 돈다.

에이전트가 돌아가고 있는 창(작업 중 · 질문에 답을 기다리는 중)은 건드리지 않고 빼고, 쉬고 있는 창만 다시 켠다.
- Claude: `claude update` 를 한 번 돌린 뒤, 쉬고 있는 창을 하나씩 끄고 같은 대화로 다시 켠다.
- Codex: 모든 Codex 창이 쉬고 있으면 계정 적용과 같은 흐름으로 한 번에 처리한다
  (모두 끄기 → codex update → 공유 데몬 재시작 → 같은 대화로 다시 켜기).
  돌아가고 있는 창이 있으면 공유 데몬을 다시 켜면 그 작업이 끊기므로, 데몬은 그대로 두고
  `codex update` 뒤 쉬고 있는 창만 하나씩 다시 켠다.
"""

import logging
import shutil
import subprocess
import threading
import time

from app.services import agent_restart, codex_accounts, tmux_service

logger = logging.getLogger(__name__)

UPDATE_TIMEOUT = 300
RUNNING_REASON = {
    "busy": "작업 중이라 뺐어요",
    "waiting": "답을 기다리는 중이라 뺐어요",
}

_lock = threading.Lock()
_job: dict = {
    "state": "idle",  # idle | running | done | error
    "since": 0.0,
    "claude": None,
    "codex": None,
    "error": None,
    "seq": 0,
}


def _update_claude() -> bool | None:
    """claude 를 최신으로. 명령이 없으면 None."""
    binary = shutil.which("claude")
    if not binary:
        return None
    from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

    try:
        result = subprocess.run(
            [binary, "update"],
            env={**_env(), "NO_COLOR": "1"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=UPDATE_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        logger.warning("claude update 실패: %s", (result.stderr or b"")[-500:])
    return result.returncode == 0


def _update_codex() -> bool | None:
    return codex_accounts._update_codex()


def _relaunch_all_codex() -> dict:
    """모든 Codex 창이 쉬고 있을 때: 끄기 → 업데이트 → 데몬 재시작 → 다시 켜기 (계정 적용과 같은 흐름)."""
    current = codex_accounts.sync_current()
    return agent_restart.relaunch_codex(
        after_stop=lambda: codex_accounts._after_stop(current)
    )


def _agent_panes(agent: str) -> list[tuple]:
    tmux_service.invalidate_cache()
    return [
        (window, pane)
        for window in tmux_service.list_windows()
        for pane in window.panes
        if pane.command == agent
    ]


def _restart_idle(agent: str, report: dict) -> None:
    """쉬고 있는 창만 하나씩 다시 켠다. 상태는 창마다 다시 켜기 직전에 새로 본다."""
    for window, pane in _agent_panes(agent):
        fresh = next(
            (
                w
                for w, p in _agent_panes(agent)
                if p.id == pane.id and w.key == window.key
            ),
            None,
        )
        if fresh is None:
            continue  # 그사이 창을 닫았거나 에이전트를 껐다
        if fresh.status != "idle":
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": RUNNING_REASON.get(fresh.status, "쉬고 있지 않아 뺐어요"),
                    "running": True,
                }
            )
            continue
        try:
            agent_restart.restart(pane.id, update=False)
        except ValueError as error:
            running = str(error) == agent_restart.BUSY_MESSAGE
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": RUNNING_REASON["busy"] if running else str(error),
                    "running": running,
                }
            )
        except Exception as error:  # noqa: BLE001 — 한 창이 실패해도 나머지는 계속한다
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": str(error) or "다시 켜지 못했어요.",
                    "running": False,
                }
            )
        else:
            report["restarted"].append(window.key)


def _do_claude() -> dict:
    report = {"updated": _update_claude(), "restarted": [], "skipped": []}
    _restart_idle("claude", report)
    return report


def _do_codex() -> dict:
    panes = _agent_panes("codex")
    if panes and all(window.status == "idle" for window, _ in panes):
        try:
            result = _relaunch_all_codex()
        except ValueError:
            pass  # 그사이 작업을 시작한 창이 있다 → 아래에서 쉬는 창만
        else:
            after = result.get("after_stop") or {}
            return {
                "updated": after.get("updated"),
                "daemon": after.get("daemon"),
                "restarted": result["relaunched"],
                "skipped": [
                    {
                        "window": key,
                        "reason": "직접 다시 켜야 해요 (이어갈 대화를 찾지 못했거나 셸에서 켠 창이 아님)",
                        "running": False,
                    }
                    for key in result["skipped"]
                ],
            }
    report = {
        "updated": _update_codex(),
        "daemon": "kept" if panes else None,
        "restarted": [],
        "skipped": [],
    }
    _restart_idle("codex", report)
    return report


def _worker(seq: int, do_claude: bool, do_codex: bool) -> None:
    try:
        if do_claude:
            claude = _do_claude()
            with _lock:
                if _job["seq"] != seq:
                    return
                _job["claude"] = claude
        if do_codex:
            codex = _do_codex()
            with _lock:
                if _job["seq"] != seq:
                    return
                _job["codex"] = codex
        with _lock:
            if _job["seq"] == seq:
                _job["state"] = "done"
    except Exception as error:  # 상태로 알려 준다
        logger.exception("모든 에이전트 업데이트 실패")
        with _lock:
            if _job["seq"] == seq:
                _job.update(state="error", error=str(error) or "업데이트하지 못했어요.")


def start(claude: bool = True, codex: bool = True) -> dict:
    with _lock:
        if _job["state"] == "running":
            raise ValueError("이미 모든 에이전트를 업데이트하는 중이에요.")
        _job["seq"] += 1
        _job.update(
            state="running", since=time.time(), claude=None, codex=None, error=None
        )
        seq = _job["seq"]
    threading.Thread(
        target=_worker, args=(seq, claude, codex), daemon=True, name="agent-update-all"
    ).start()
    return status()


def status() -> dict:
    with _lock:
        return {
            key: _job[key]
            for key in ("state", "since", "claude", "codex", "error", "seq")
        }
