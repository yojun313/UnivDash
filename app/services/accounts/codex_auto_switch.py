"""When Codex usage runs out, switch to an account with usage left and continue the stopped windows (with 2 or more accounts, on by default).

- Detection: looks at the turn error (usage_limit_exceeded) Codex writes to the conversation log. The used percentage
  alone cannot reveal that credits ran out, and on-screen text cannot be told apart from conversation content. Only
  turns that stopped just now are handled (so windows that stopped long ago are not woken up).
- Switch: uses the same path as a manual switch (codex_accounts.switch). If other Codex windows are working it waits
  until they finish. No update is done, so Codex does not change while the user is away.
- Resume: the "continue" prompt is sent only to windows that stopped on the limit.
- When every account is exhausted nothing is switched; work resumes once any account resets.
"""

import asyncio
import json
import logging
import os
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from app.i18n import _
from app.paths import data_dir
from app.services.accounts import codex_accounts
from app.services.accounts.ai_usage_service import AIUsageService
from app.services.agents import agent_restart, tmux_service, transcript_service

logger = logging.getLogger(__name__)

INTERVAL = 15.0
EXHAUSTED_PERCENT = 99.0
FAILURE_FRESH = 30 * 60.0  # limit errors older than this are not handled
LOG_TAIL = 512 * 1024
RETRY_UNKNOWN = 30 * 60.0  # retry interval when the reset time is unknown
RECHECK_ALL_OUT = (
    5 * 60.0
)  # interval for re-reading usage while everything is exhausted
RESET_MARGIN = 10.0  # slack between the reset time and the check right after it
RESET_WATCH = (
    10 * 60.0
)  # how long to check often after a reset, until the server reflects it
RESET_POLL = 60.0  # the check interval during that time
RESUME_TIMEOUT = 180.0
SWITCH_COOLDOWN = 120.0
MAX_SWITCHES_PER_HOUR = 6
# Prompt typed into the Codex window on the user's behalf (not translated)
RESUME_TEXT = "사용량 한도로 멈췄던 작업을 이어서 진행해 줘."

_lock = threading.Lock()


# ── Storage ───────────────────────────────────────────────────────────
def _path() -> Path:
    return data_dir() / "codex_auto_switch.json"


def _defaults() -> dict:
    return {
        "enabled": True,  # on by default
        "waiting": {},  # windows stopped on the limit that must be resumed: pane id → window key
        "handled": {},  # limit errors already handled: pane id → turn id
        "retry_at": 0.0,  # when to retry once everything is exhausted
        "next_check": 0.0,
        "reset_at": 0.0,  # the earliest known reset time
        "watch_until": 0.0,  # deadline for checking often after a reset
        "resume": [],  # windows waiting for the input box after a restart: {pane, key, deadline}
        "pending": None,  # the switch in progress: {target, email, seq}
        "switches": [],
        "notified_wait": False,
        "message": "",
        "message_at": 0.0,
    }


def _load() -> dict:
    state = _defaults()
    try:
        saved = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return state
    if isinstance(saved, dict):
        state.update({key: saved[key] for key in state if key in saved})
    return state


def _save(state: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".codex_auto_switch.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def status() -> dict:
    with _lock:
        state = _load()
    return {
        "enabled": state["enabled"],
        "message": state["message"],
        "message_at": state["message_at"],
        "waiting": len(state["waiting"]),
    }


def set_enabled(enabled: bool) -> dict:
    with _lock:
        state = _load()
        state["enabled"] = enabled
        if not enabled:
            state["waiting"] = {}
            state["resume"] = []
            state["notified_wait"] = False
        _save(state)
    return status()


# ── Usage ─────────────────────────────────────────────────────────────
def _is_exhausted(limits: dict) -> bool:
    # running out of credits does not show up in the used percentage
    if limits.get("reached_type"):
        return True
    return any(
        window.get("used_percent", 0) >= EXHAUSTED_PERCENT
        for window in limits.get("windows") or []
    )


def _peak(limits: dict) -> float:
    return max(
        (window.get("used_percent", 0) for window in limits.get("windows") or []),
        default=0.0,
    )


def _available_at(limits: dict) -> str | None:
    """When all exhausted limits are released."""
    times = [
        window["resets_at"]
        for window in limits.get("windows") or []
        if window.get("used_percent", 0) >= EXHAUSTED_PERCENT
        and window.get("resets_at")
    ]
    return max(times) if times else None


def _current_limits() -> dict | None:
    return AIUsageService._live_codex_limits(
        codex_accounts.codex_home(), datetime.now().astimezone()
    )


def _saved_limits(account_id: str) -> dict | None:
    return AIUsageService._saved_codex_limits(
        codex_accounts._profile_path(account_id), datetime.now().astimezone()
    )


def _choose(accounts: list[dict]) -> tuple[dict | None, str | None]:
    """The other account with the most usage left. Accounts that could not be read (expired login etc.) are not chosen.

    When there is no account to choose: (None, the earliest release time)."""
    best, best_peak = None, 0.0
    resets = []
    for account in accounts:
        if account["active"]:
            continue
        limits = _saved_limits(account["id"])
        if limits is None:
            continue
        if _is_exhausted(limits):
            at = _available_at(limits)
            if at:
                resets.append(at)
            continue
        if best is None or _peak(limits) < best_peak:
            best, best_peak = account, _peak(limits)
    return best, (min(resets) if resets else None)


# ── Conversation log ──────────────────────────────────────────────────
_log_cache: dict[str, tuple[tuple[int, int], dict | None]] = {}


def _read_failure(log: Path) -> dict | None:
    """{turn, at} if the conversation's last turn ended with a limit error."""
    with log.open("rb") as handle:
        size = handle.seek(0, os.SEEK_END)
        handle.seek(max(0, size - LOG_TAIL))
        raw = handle.read().decode("utf-8", "replace")
    for line in reversed(raw.splitlines()):
        if '"event_msg"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        payload = entry.get("payload")
        kind = payload.get("type") if isinstance(payload, dict) else None
        if kind in ("task_started", "turn_started", "user_message"):
            return None
        if kind != "task_complete":
            continue
        error = payload.get("error")
        if not isinstance(error, dict) or (
            error.get("codex_error_info") != "usage_limit_exceeded"
        ):
            return None
        return {"turn": str(payload.get("turn_id")), "at": entry.get("timestamp")}
    return None


def _log_of(pane) -> Path | None:
    return transcript_service.find_log(pane.pid, "codex", os.path.expanduser(pane.path))


def _failure_of(pane) -> dict | None:
    log = _log_of(pane)
    if not log:
        return None
    info = log.stat()
    version = (info.st_mtime_ns, info.st_size)
    cached = _log_cache.get(str(log))
    if cached and cached[0] == version:
        return cached[1]
    failure = _read_failure(log)
    _log_cache[str(log)] = (version, failure)
    return failure


def _is_recent(failure: dict) -> bool:
    try:
        at = datetime.fromisoformat(failure["at"]).timestamp()
    except (AttributeError, ValueError):
        return False
    return time.time() - at < FAILURE_FRESH


def _stopped_panes() -> dict[str, dict]:
    """Codex windows whose last turn is a limit error: pane id → {key, turn, recent, busy}.

    Whether it is working is decided from the log. The screen state can briefly be misread as busy."""
    stopped = {}
    for window, pane in agent_restart.codex_panes():
        try:
            failure = _failure_of(pane)
        except OSError:
            continue
        if failure:
            stopped[pane.id] = {
                "key": window.key,
                "turn": failure["turn"],
                "recent": _is_recent(failure),
                "busy": window.status == "busy",
            }
    return stopped


def _still_waiting(waiting: dict, stopped: dict) -> dict:
    """Windows to keep waiting for. One is dropped only when the window was closed or the log shows it continued.

    Windows that could not be read because Codex is restarting stay as they were."""
    if all(pane_id in stopped for pane_id in waiting):
        return dict(waiting)
    existing = tmux_service._pane_ids()
    running = {pane.id: (window, pane) for window, pane in agent_restart.codex_panes()}
    kept = {}
    for pane_id, key in waiting.items():
        if pane_id in stopped:
            kept[pane_id] = key
        elif pane_id in existing:
            window, pane = running.get(pane_id, (None, None))
            try:
                resumed = (
                    pane is not None and not window.starting and bool(_log_of(pane))
                )
            except OSError:
                resumed = False
            if not resumed:
                kept[pane_id] = key
    return kept


# ── One check ─────────────────────────────────────────────────────────
def _notice(state: dict, title: str, body: str, url: str = "/ai-usage") -> dict:
    state["message"] = f"{title} {body}".strip()
    state["message_at"] = time.time()
    logger.info("Codex auto-switch · %s · %s", title, body)
    return {
        "title": title,
        "body": body[:200],
        "tag": "univdash-codex-auto-switch",
        "url": url,
    }


def _start_switch(state: dict, target: dict) -> list[dict]:
    now = time.time()
    state["switches"] = [at for at in state["switches"] if now - at < 3600]
    if state["switches"] and now - state["switches"][-1] < SWITCH_COOLDOWN:
        return []
    if len(state["switches"]) >= MAX_SWITCHES_PER_HOUR:
        if state["notified_wait"]:
            return []
        state["notified_wait"] = True
        return [
            _notice(
                state,
                _("Codex 자동 전환을 멈췄습니다"),
                _("1시간에 전환이 너무 많습니다. 계정 상태를 확인해 주십시오."),
            )
        ]
    result = codex_accounts.switch(target["id"], update=False)
    state["switches"].append(now)
    state["notified_wait"] = False
    applied = result.get("applied") or {}
    state["pending"] = {
        "target": target["id"],
        "email": target["email"],
        "seq": applied.get("seq"),
    }
    busy = applied.get("waiting") or []
    body = (
        _(
            "{email} 로 바꿨습니다. 작업 중인 창 {count}개가 끝나면 다시 켭니다.",
            email=target["email"],
            count=len(busy),
        )
        if busy
        else _("{email} 로 바꾸고 멈춘 창을 다시 켭니다.", email=target["email"])
    )
    return [_notice(state, _("Codex 사용량이 다 떨어졌습니다"), body)]


def _follow_switch(state: dict) -> list[dict]:
    pending = state["pending"]
    applied = codex_accounts.apply_status()
    if applied["state"] == "idle":
        # The dashboard restarted and the apply was cut off → schedule it again (the login file is already switched)
        pending["seq"] = codex_accounts.schedule_apply(pending["target"], False)["seq"]
        return []
    if applied["seq"] != pending["seq"]:
        state["pending"] = None  # the user switched to another account meanwhile
        return []
    if applied["state"] in ("waiting", "applying"):
        return []
    state["pending"] = None
    if applied["state"] == "error":
        return [_notice(state, _("Codex 자동 전환 실패"), applied["error"] or "")]
    result = applied["result"] or {}
    relaunched = set(result.get("relaunched") or [])
    deadline = time.time() + RESUME_TIMEOUT
    state["resume"] = [
        {"pane": pane, "key": key, "deadline": deadline}
        for pane, key in state["waiting"].items()
        if key in relaunched
    ]
    missed = [key for key in state["waiting"].values() if key not in relaunched]
    state["waiting"] = {}
    if missed:
        return [
            _notice(
                state,
                _("Codex 창을 다시 켜지 못했습니다"),
                _(
                    "{names} 은(는) 직접 다시 켜 주십시오.",
                    names=", ".join(missed),
                ),
            )
        ]
    return []


def _send_resume(state: dict) -> list[dict]:
    """Send the resume prompt once the input box of a restarted window appears."""
    tmux_service.invalidate_cache()
    windows = {pane.id: window for window, pane in agent_restart.codex_panes()}
    remaining, notices = [], []
    now = time.time()
    for item in state["resume"]:
        window = windows.get(item["pane"])
        lines = agent_restart._screen_lines(item["pane"]) if window else []
        ready = (
            window is not None
            and window.status == "idle"
            and not window.starting
            and agent_restart._ready(lines, "codex")
        )
        if ready:
            tmux_service.send_prompt(item["pane"], RESUME_TEXT)
            continue
        if window is not None and window.status == "busy" and not window.starting:
            continue  # it continued by itself right after starting (goal mode etc.)
        if now < item["deadline"]:
            remaining.append(item)
        else:
            notices.append(
                _notice(
                    state,
                    _("Codex 창을 이어가지 못했습니다"),
                    _(
                        "{key} 입력창이 뜨지 않습니다. 확인해 주십시오.",
                        key=item["key"],
                    ),
                )
            )
    state["resume"] = remaining
    return notices


def _tick(state: dict) -> list[dict]:
    if state["resume"]:
        return _send_resume(state)
    if state["pending"]:
        return _follow_switch(state)
    stopped = _stopped_panes()
    # If the user sent something again meanwhile (the last turn is not a limit error), stop waiting
    state["waiting"] = _still_waiting(state["waiting"], stopped)
    state["handled"] = {
        pane: turn
        for pane, turn in state["handled"].items()
        if pane in stopped or pane in state["waiting"]
    }
    fresh = {
        pane: info
        for pane, info in stopped.items()
        if info["recent"]
        and not info["busy"]
        and state["handled"].get(pane) != info["turn"]
    }
    if not fresh and not state["waiting"]:
        return []
    accounts = codex_accounts.list_accounts()["accounts"]
    if len(accounts) < 2:
        state["waiting"] = {}
        return []
    now = time.time()
    for pane, info in fresh.items():
        state["waiting"][pane] = info["key"]
        state["handled"][pane] = info["turn"]
    if not fresh and now < state["next_check"]:
        return []
    if state["reset_at"] and now >= state["reset_at"]:
        state["watch_until"] = state["reset_at"] + RESET_WATCH
    state["next_check"] = now + (
        RESET_POLL if now < state["watch_until"] else RECHECK_ALL_OUT
    )
    limits = _current_limits()
    if not fresh and now >= state["retry_at"] and limits and not _is_exhausted(limits):
        # The limit we were waiting on was released
        deadline = now + RESUME_TIMEOUT
        state["resume"] = [
            {"pane": pane, "key": key, "deadline": deadline}
            for pane, key in state["waiting"].items()
        ]
        state["waiting"] = {}
        state["notified_wait"] = False
        return [
            _notice(
                state,
                _("Codex 사용량이 초기화됐습니다"),
                _("멈춘 창을 이어서 진행합니다."),
            )
        ] + _send_resume(state)
    target, reset = _choose(accounts)
    if target:
        return _start_switch(state, target)
    own = _available_at(limits) if limits else None
    times = [at for at in (reset, own) if at]
    earliest = min(times) if times else None
    reset_at = datetime.fromisoformat(earliest).timestamp() if earliest else 0.0
    state["reset_at"] = reset_at
    state["retry_at"] = reset_at or now + RETRY_UNKNOWN
    if reset_at:  # check right when it resets
        state["next_check"] = min(state["next_check"], reset_at + RESET_MARGIN)
    if state["notified_wait"]:
        return []
    state["notified_wait"] = True
    body = (
        _(
            "가장 빠른 초기화는 {when} 입니다. 풀리면 이어서 진행합니다.",
            when=f"{datetime.fromisoformat(earliest).astimezone():%m/%d %H:%M}",
        )
        if earliest
        else _("초기화 시각을 알 수 없습니다. 풀리면 이어서 진행합니다.")
    )
    return [_notice(state, _("Codex 계정을 모두 다 썼습니다"), body)]


def tick() -> list[dict]:
    """Run one check. Returns the notifications to send."""
    with _lock:
        state = _load()
        if not state["enabled"]:
            return []
        before = json.dumps(state, sort_keys=True)
        try:
            return _tick(state)
        except (KeyError, OSError, codex_accounts.AccountError) as error:
            return [_notice(state, _("Codex 자동 전환 실패"), str(error))]
        finally:
            if json.dumps(state, sort_keys=True) != before:
                _save(state)


async def loop() -> None:
    from app.services.core import push_service

    try:
        restored = await asyncio.to_thread(
            agent_restart.recover_relaunch, codex_accounts._restart_daemon
        )
        if restored:
            logger.warning(
                "Recovered Codex windows that had not restarted · %s",
                ", ".join(restored),
            )
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Codex window recovery failed")
    while True:
        await asyncio.sleep(INTERVAL)
        try:
            for notice in await asyncio.to_thread(tick):
                await push_service.send(notice, skip_focused=False)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Codex auto-switch check failed")
