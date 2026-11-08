"""Codex 사용량이 다 떨어지면 남은 계정으로 바꾸고 멈춘 창을 이어서 진행한다 (계정이 2개 이상일 때, 기본 켜짐).

- 판단: Codex 가 대화 로그에 남기는 턴 오류(usage_limit_exceeded)를 본다. 사용 퍼센트만으로는 크레딧 소진을 알 수 없고,
  화면 문구는 대화 내용과 구별되지 않기 때문이다. 방금 멈춘 턴만 다룬다 (오래전에 멈춘 창을 깨우지 않게).
- 전환: 수동 전환과 같은 길(codex_accounts.switch)을 쓴다. 다른 Codex 창이 작업 중이면 끝날 때까지 기다린다.
  자리를 비운 사이 Codex 가 바뀌지 않도록 업데이트는 하지 않는다.
- 이어가기: 한도로 멈췄던 창에만 "이어서 진행" 을 보낸다.
- 모든 계정이 소진되면 바꾸지 않고, 어느 계정이든 초기화되면 그때 이어간다.
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

from app.paths import data_dir
from app.services import agent_restart, codex_accounts, tmux_service, transcript_service
from app.services.ai_usage_service import AIUsageService

logger = logging.getLogger(__name__)

INTERVAL = 15.0
EXHAUSTED_PERCENT = 99.0
FAILURE_FRESH = 30 * 60.0  # 이보다 오래된 한도 오류는 다루지 않는다
LOG_TAIL = 512 * 1024
RETRY_UNKNOWN = 30 * 60.0  # 초기화 시각을 모를 때 다시 해 보는 간격
RECHECK_ALL_OUT = 5 * 60.0  # 모두 소진된 동안 사용량을 다시 읽는 간격
RESET_MARGIN = 10.0  # 초기화 시각 직후 확인까지의 여유
RESET_WATCH = 10 * 60.0  # 초기화 뒤 서버에 반영될 때까지 자주 확인하는 시간
RESET_POLL = 60.0  # 그동안의 확인 간격
RESUME_TIMEOUT = 180.0
SWITCH_COOLDOWN = 120.0
MAX_SWITCHES_PER_HOUR = 6
RESUME_TEXT = "사용량 한도로 멈췄던 작업을 이어서 진행해 줘."

_lock = threading.Lock()


# ── 저장 ──────────────────────────────────────────────────────────────
def _path() -> Path:
    return data_dir() / "codex_auto_switch.json"


def _defaults() -> dict:
    return {
        "enabled": True,  # 기본 켜짐
        "waiting": {},  # 한도로 멈춰 이어가야 하는 창: pane id → 창 키
        "handled": {},  # 이미 다룬 한도 오류: pane id → 턴 id
        "retry_at": 0.0,  # 모두 소진됐을 때 다시 해 볼 시각
        "next_check": 0.0,
        "reset_at": 0.0,  # 알고 있는 가장 빠른 초기화 시각
        "watch_until": 0.0,  # 초기화 뒤 자주 확인하는 마감
        "resume": [],  # 다시 켠 뒤 입력창을 기다리는 창: {pane, key, deadline}
        "pending": None,  # 진행 중인 전환: {target, email, seq}
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


# ── 사용량 ────────────────────────────────────────────────────────────
def _is_exhausted(limits: dict) -> bool:
    if limits.get("reached_type"):  # 크레딧 소진은 사용 퍼센트에 나타나지 않는다
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
    """소진된 한도가 모두 풀리는 시각."""
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
    """남은 양이 가장 많은 다른 계정. 읽지 못한 계정(로그인 만료 등)은 고르지 않는다.

    고를 계정이 없으면 (None, 가장 빨리 풀리는 시각)."""
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


# ── 대화 로그 ─────────────────────────────────────────────────────────
_log_cache: dict[str, tuple[tuple[int, int], dict | None]] = {}


def _read_failure(log: Path) -> dict | None:
    """대화의 마지막 턴이 한도 오류로 끝났으면 {turn, at}."""
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
    """마지막 턴이 한도 오류인 Codex 창: pane id → {key, turn, recent, busy}.

    작업 여부는 로그로 판단한다. 화면 상태는 잠깐 busy 로 잘못 읽힐 수 있다."""
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
    """계속 기다릴 창. 창이 닫혔거나 로그에 이어진 흔적이 있을 때만 뺀다.

    Codex 가 재시작 중이라 읽지 못한 창은 기다리던 그대로 둔다."""
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


# ── 한 번 확인 ────────────────────────────────────────────────────────
def _notice(state: dict, title: str, body: str, url: str = "/ai-usage") -> dict:
    state["message"] = f"{title} {body}".strip()
    state["message_at"] = time.time()
    logger.info("Codex 자동 전환 · %s · %s", title, body)
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
                "Codex 자동 전환을 멈췄어요",
                "1시간에 전환이 너무 많아요. 계정 상태를 확인해 주세요.",
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
        f"{target['email']} 로 바꿨어요. 작업 중인 창 {len(busy)}개가 끝나면 다시 켜요."
        if busy
        else f"{target['email']} 로 바꾸고 멈춘 창을 다시 켜요."
    )
    return [_notice(state, "Codex 사용량이 다 떨어졌어요", body)]


def _follow_switch(state: dict) -> list[dict]:
    pending = state["pending"]
    applied = codex_accounts.apply_status()
    if applied["state"] == "idle":
        # 대시보드가 재시작돼 적용이 끊겼다 → 다시 건다 (로그인 파일은 이미 바뀌어 있다)
        pending["seq"] = codex_accounts.schedule_apply(pending["target"], False)["seq"]
        return []
    if applied["seq"] != pending["seq"]:
        state["pending"] = None  # 사람이 그사이 다른 계정으로 바꿨다
        return []
    if applied["state"] in ("waiting", "applying"):
        return []
    state["pending"] = None
    if applied["state"] == "error":
        return [_notice(state, "Codex 자동 전환 실패", applied["error"] or "")]
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
                "Codex 창을 다시 켜지 못했어요",
                f"{', '.join(missed)} 은(는) 직접 다시 켜 주세요.",
            )
        ]
    return []


def _send_resume(state: dict) -> list[dict]:
    """다시 켠 창의 입력창이 뜨면 이어가기를 보낸다."""
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
            continue  # 켜지자마자 스스로 이어갔다 (목표 모드 등)
        if now < item["deadline"]:
            remaining.append(item)
        else:
            notices.append(
                _notice(
                    state,
                    "Codex 창을 이어가지 못했어요",
                    f"{item['key']} 입력창이 뜨지 않아요. 확인해 주세요.",
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
    # 사람이 그사이 다시 보냈으면(마지막 턴이 한도 오류가 아님) 기다리지 않는다
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
        # 기다리던 한도가 풀렸다
        deadline = now + RESUME_TIMEOUT
        state["resume"] = [
            {"pane": pane, "key": key, "deadline": deadline}
            for pane, key in state["waiting"].items()
        ]
        state["waiting"] = {}
        state["notified_wait"] = False
        return [
            _notice(state, "Codex 사용량이 초기화됐어요", "멈춘 창을 이어서 진행해요.")
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
    if reset_at:  # 초기화되는 때에 맞춰 확인한다
        state["next_check"] = min(state["next_check"], reset_at + RESET_MARGIN)
    if state["notified_wait"]:
        return []
    state["notified_wait"] = True
    when = (
        f"가장 빠른 초기화는 {datetime.fromisoformat(earliest).astimezone():%m/%d %H:%M} 이에요."
        if earliest
        else "초기화 시각을 알 수 없어요."
    )
    return [
        _notice(state, "Codex 계정을 모두 다 썼어요", f"{when} 풀리면 이어서 진행해요.")
    ]


def tick() -> list[dict]:
    """한 번 확인한다. 보낼 알림을 돌려준다."""
    with _lock:
        state = _load()
        if not state["enabled"]:
            return []
        before = json.dumps(state, sort_keys=True)
        try:
            return _tick(state)
        except (KeyError, OSError, codex_accounts.AccountError) as error:
            return [_notice(state, "Codex 자동 전환 실패", str(error))]
        finally:
            if json.dumps(state, sort_keys=True) != before:
                _save(state)


async def loop() -> None:
    from app.services import push_service

    try:
        restored = await asyncio.to_thread(
            agent_restart.recover_relaunch, codex_accounts._restart_daemon
        )
        if restored:
            logger.warning("다시 켜지 못했던 Codex 창 복구 · %s", ", ".join(restored))
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Codex 창 복구 실패")
    while True:
        await asyncio.sleep(INTERVAL)
        try:
            for notice in await asyncio.to_thread(tick):
                await push_service.send(notice, skip_focused=False)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Codex 자동 전환 확인 실패")
