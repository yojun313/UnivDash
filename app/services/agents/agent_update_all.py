"""Update every agent window (Claude Code · Codex) to the latest version and restart it with the same conversation. Runs in the background.

Windows where an agent is running (working · waiting for an answer to a question) are left out untouched; only idle windows are restarted.
- Claude: run `claude update` once, then stop the idle windows one by one and restart them with the same conversation.
- Codex: if every Codex window is idle, handle them all at once with the same flow as applying an account
  (stop all → codex update → restart the shared daemon → restart with the same conversation).
  If any window is running, restarting the shared daemon would cut that work off, so the daemon is left alone and
  after `codex update` only the idle windows are restarted one by one.
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from app.i18n import N_, _
from app.paths import data_dir, find_command
from app.services.accounts import codex_accounts
from app.services.agents import agent_restart, tmux_service

logger = logging.getLogger(__name__)

UPDATE_TIMEOUT = 300
RUNNING_REASON = {
    "busy": N_("작업 중이라 제외했습니다"),
    "waiting": N_("답을 기다리는 중이라 제외했습니다"),
}

_lock = threading.Lock()
_job: dict = {
    "state": "idle",  # idle | running | done | error
    "since": 0.0,
    "claude": None,
    "codex": None,
    "gemini": None,
    "error": None,
    "seq": 0,
}


def _update_claude(command: str = "claude") -> bool | None:
    """Update claude (or agy) to the latest version. None if the command is missing."""
    binary = find_command(command)
    if not binary:
        return None
    # Environment without the dashboard's secrets
    from app.services.agents.pty_service import _env

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
        logger.warning("%s update failed: %s", command, (result.stderr or b"")[-500:])
    return result.returncode == 0


def _update_codex() -> bool | None:
    return codex_accounts._update_codex()


# ── Codex windows showing the update notice: update without asking, then restart with the same conversation ──
# Choosing "Update now" in the notice makes Codex exit, so the notice is dismissed and the dashboard installs
# the update and restarts it.
# The notice appears only right after start-up, so no conversation in progress is interrupted.
PROMPT_INTERVAL = 5.0
UPDATE_RETRY = 3600.0
_update_tried: dict[str, float] = {}
_prompt_restarted: set[tuple[str, str]] = set()


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])


def _installed_codex() -> str | None:
    binary = find_command("codex")
    if not binary:
        return None
    try:
        result = subprocess.run(
            [binary, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.findall(r"\d+\.\d+[\w.\-]*", result.stdout)
    return found[-1] if found else None


def _is_installed(version: str) -> bool:
    installed = _installed_codex()
    return bool(
        installed and version and _version_key(installed) >= _version_key(version)
    )


def _dismiss_update_prompts() -> list[tuple[str, str, str]]:
    """Dismiss the update notices that are showing. List of (pane id, window key, new version)."""
    found = []
    for window, pane in _agent_panes("codex"):
        if window.status == "busy":
            continue
        version = agent_restart.update_prompt_version(
            agent_restart._screen_lines(pane.id)
        )
        if version is None:
            continue
        tmux_service.send_keys(pane.id, ["Escape"])
        found.append((pane.id, window.key, version))
    if found:
        time.sleep(0.5)
        tmux_service.invalidate_cache()
    return found


def _ensure_installed(version: str) -> bool:
    if _is_installed(version):
        return True
    now = time.monotonic()
    tried = _update_tried.get(version)
    if tried is not None and now - tried < UPDATE_RETRY:
        return False
    _update_tried[version] = now
    logger.info("Installing Codex %s", version)
    _update_codex()
    return _is_installed(version)


def _pending_file() -> Path:
    return data_dir() / "codex-update-pending.json"


def _read_pending() -> list[dict]:
    try:
        data = json.loads(_pending_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _write_pending(items: list[dict]) -> None:
    path = _pending_file()
    if not items:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".codex-update-pending.")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=False)
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def _restart_pending(items: list[dict]) -> tuple[list[dict], list[str]]:
    """Restart the idle windows. A working one is kept until it finishes."""
    panes = {pane.id: (window, pane) for window, pane in _agent_panes("codex")}
    left, restarted = [], []
    for item in items:
        found = panes.get(item.get("pane"))
        if found is None or found[0].key != item.get("key"):
            continue  # the window was closed or Codex was stopped
        if found[0].status != "idle":
            left.append(item)
            continue
        try:
            agent_restart.restart(item["pane"], update=False)
        except agent_restart.BusyError:
            left.append(item)
        except ValueError as error:
            logger.warning(
                "Could not restart the Codex window · %s · %s", item["key"], error
            )
        except Exception as error:  # noqa: BLE001 — one failing window does not stop the rest
            logger.warning(
                "Could not restart the Codex window · %s · %s", item["key"], error
            )
        else:
            restarted.append(item["key"])
            logger.info("Restarted after the Codex update · %s", item["key"])
    return left, restarted


def sweep_update_prompts() -> list[str]:
    """Handle the windows showing the update notice. List of restarted window keys."""
    with _lock:
        if _job["state"] == "running":
            return []  # the update-all job handles them itself
    if codex_accounts.apply_status()["state"] == "applying":
        return []
    items = _read_pending()
    for pane_id, key, version in _dismiss_update_prompts():
        if not _ensure_installed(version):
            logger.warning(
                "Could not install Codex %s, only dismissed the notice · %s",
                version,
                key,
            )
            continue
        if (pane_id, version) in _prompt_restarted:
            continue  # restarted and it showed again → do not repeat
        _prompt_restarted.add((pane_id, version))
        if not any(item.get("pane") == pane_id for item in items):
            items.append({"pane": pane_id, "key": key})
    if not items:
        return []
    # So the restarts continue even if the dashboard restarts midway
    _write_pending(items)
    left, restarted = _restart_pending(items)
    _write_pending(left)
    return restarted


async def update_prompt_loop() -> None:
    while True:
        await asyncio.sleep(PROMPT_INTERVAL)
        try:
            await asyncio.to_thread(sweep_update_prompts)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Handling the Codex update notice failed")


def _relaunch_all_codex() -> dict:
    """When every Codex window is idle: stop → update → restart the daemon → restart (same flow as applying an account)."""
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
        if tmux_service.agent_of(pane.command) == agent
    ]


def _restart_idle(agent: str, report: dict) -> None:
    """Restart only the idle windows, one by one. The status is checked afresh right before each restart."""
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
            continue  # meanwhile the window was closed or the agent was stopped
        if fresh.status != "idle":
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": _(RUNNING_REASON[fresh.status])
                    if fresh.status in RUNNING_REASON
                    else _("쉬고 있지 않아 제외했습니다"),
                    "running": True,
                }
            )
            continue
        try:
            agent_restart.restart(pane.id, update=False)
        except ValueError as error:
            running = isinstance(error, agent_restart.BusyError)
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": _(RUNNING_REASON["busy"]) if running else str(error),
                    "running": running,
                }
            )
        except Exception as error:  # noqa: BLE001 — one failing window does not stop the rest
            report["skipped"].append(
                {
                    "window": window.key,
                    "reason": str(error) or _("다시 켜지 못했습니다."),
                    "running": False,
                }
            )
        else:
            report["restarted"].append(window.key)


def _do_claude() -> dict:
    report = {"updated": _update_claude(), "restarted": [], "skipped": []}
    _restart_idle("claude", report)
    return report


def _do_gemini() -> dict:
    """Gemini (Antigravity CLI): after `agy update`, restart the idle windows with the same conversation."""
    report = {"updated": _update_claude("agy"), "restarted": [], "skipped": []}
    _restart_idle("gemini", report)
    return report


def _do_codex() -> dict:
    # A window showing the update notice is idle, not "waiting for an answer"
    _dismiss_update_prompts()
    panes = _agent_panes("codex")
    if panes and all(window.status == "idle" for window, _pane in panes):
        try:
            result = _relaunch_all_codex()
        except ValueError:
            pass  # a window started working meanwhile → only the idle ones, below
        else:
            after = result.get("after_stop") or {}
            return {
                "updated": after.get("updated"),
                "daemon": after.get("daemon"),
                "restarted": result["relaunched"],
                "skipped": [
                    {
                        "window": key,
                        "reason": _(
                            "직접 다시 켜야 합니다 (이어갈 대화를 찾지 못했거나 셸에서 켠 창이 아님)"
                        ),
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


def _worker(seq: int, do_claude: bool, do_codex: bool, do_gemini: bool = False) -> None:
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
        if do_gemini:
            gemini = _do_gemini()
            with _lock:
                if _job["seq"] != seq:
                    return
                _job["gemini"] = gemini
        with _lock:
            if _job["seq"] == seq:
                _job["state"] = "done"
    except Exception as error:  # reported through the status
        logger.exception("Update of all agents failed")
        with _lock:
            if _job["seq"] == seq:
                _job.update(
                    state="error", error=str(error) or _("업데이트하지 못했습니다.")
                )


def start(claude: bool = True, codex: bool = True, gemini: bool = False) -> dict:
    with _lock:
        if _job["state"] == "running":
            raise ValueError(_("이미 모든 에이전트를 업데이트하는 중입니다."))
        _job["seq"] += 1
        _job.update(
            state="running",
            since=time.time(),
            claude=None,
            codex=None,
            gemini=None,
            error=None,
        )
        seq = _job["seq"]
    threading.Thread(
        target=_worker,
        args=(seq, claude, codex, gemini),
        daemon=True,
        name="agent-update-all",
    ).start()
    return status()


def status() -> dict:
    with _lock:
        return {
            key: _job[key]
            for key in ("state", "since", "claude", "codex", "gemini", "error", "seq")
        }
