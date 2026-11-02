"""서버 재부팅 뒤 tmux 세션 복원.

- 스냅숏: 대시보드가 떠 있는 동안 주기적으로 tmux 세션 · 창 · pane 구성(이름, 순서, 폴더, 분할 모양)과
  pane 마다 돌던 에이전트(Claude Code · Codex)의 대화 ID · 실행 옵션을 data/tmux-snapshot.json 에 적는다.
- 복원: 대시보드가 켜졌을 때 스냅숏이 '이전 부팅'에서 찍힌 것이고 이번 부팅에 아직 복원하지 않았으면,
  없는 세션만 같은 이름 · 같은 창 번호로 다시 만들고 에이전트는 같은 대화로 이어서 켠다
  (claude --resume <ID> · codex resume <ID>). 세션 이름이 같아서 폴더 · 순서 · 별칭 설정도 그대로 맞는다.
- 에이전트가 아닌 pane 은 그 폴더의 셸만 연다 (예전에 돌던 임의 명령은 다시 실행하지 않는다).
- 부팅 구분은 /proc/sys/kernel/random/boot_id 로 한다. 대시보드만 재시작했을 때는 복원하지 않는다.
- 기록: 세션 목록(이름)이 바뀔 때마다 data/tmux-history.json 에 최근 HISTORY_LIMIT 개를 남긴다.
  tmux 서버가 통째로 죽어 세션이 하나도 없을 때는 기록하지 않으므로 죽기 직전 구성이 남는다.
  화면의 '세션 복구'에서 기록 하나를 골라 지금 없는 세션만 다시 만든다 (restore_from_history).
- 대시보드에서 직접 닫은 세션은 '닫힘'으로 적어 두고 복구 알림에서 뺀다.
"""

import json
import logging
import os
import secrets
import shlex
import threading
import time
from pathlib import Path

import psutil

from app.paths import data_dir
from app.services import agent_restart, tmux_service, transcript_service

logger = logging.getLogger(__name__)

SNAPSHOT_INTERVAL = 20.0
VERSION = 1
HISTORY_LIMIT = 40
ALERT_WINDOW = 12 * 3600  # 이보다 오래된 기록은 '세션이 사라졌어요' 알림에 쓰지 않는다
_FIELDS = [
    "#{session_name}",
    "#{session_active}",
    "#{window_index}",
    "#{window_name}",
    "#{automatic-rename}",
    "#{window_layout}",
    "#{window_active}",
    "#{pane_index}",
    "#{pane_active}",
    "#{pane_pid}",
    "#{pane_current_command}",
    "#{pane_current_path}",
]
_started = False
_start_lock = threading.Lock()
_history_lock = threading.Lock()
_job_lock = threading.Lock()
_job: dict = {"running": False, "result": None, "at": 0.0}


def _snapshot_file() -> Path:
    return data_dir() / "tmux-snapshot.json"


def _marker_file() -> Path:
    return data_dir() / "tmux-restored.json"


def _history_file() -> Path:
    return data_dir() / "tmux-history.json"


def boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return str(int(psutil.boot_time()))


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ── 스냅숏 ──────────────────────────────────────────────────────────────────


def _agent_info(pid: int, command: str, cwd: str) -> dict | None:
    """pane 에서 도는 에이전트의 대화 ID · 이어서 켤 때 쓸 옵션."""
    if command not in tmux_service.AGENTS:
        return None
    proc = transcript_service._agent_process(pid, command)
    if proc is None:
        return None
    try:
        argv = proc.cmdline()[1:]
        codex_home = proc.environ().get("CODEX_HOME") if command == "codex" else None
    except psutil.Error:
        return None
    log = transcript_service.find_log(pid, command, cwd)
    ids = agent_restart._UUID.findall(log.name) if log else []
    keep = agent_restart.KEEP[command]
    info = {
        "agent": command,
        "session_id": ids[-1] if ids else None,
        "flags": agent_restart.keep_flags(argv, keep),
    }
    if codex_home:
        info["codex_home"] = codex_home
    return info


def capture() -> list[dict]:
    """지금 tmux 구성. tmux 서버가 없으면 빈 목록."""
    out = tmux_service._run(["list-panes", "-a", "-F", tmux_service.SEP.join(_FIELDS)])
    sessions: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split(tmux_service.SEP)
        if len(parts) != len(_FIELDS):
            continue
        (
            name,
            session_active,
            w_index,
            w_name,
            auto_rename,
            layout,
            w_active,
            p_index,
            p_active,
            pid,
            command,
            path,
        ) = parts
        session = sessions.setdefault(
            name, {"name": name, "attached": session_active == "1", "windows": {}}
        )
        window = session["windows"].setdefault(
            w_index,
            {
                "index": int(w_index),
                "name": w_name,
                "auto_rename": auto_rename != "0",
                "layout": layout,
                "active": w_active == "1",
                "panes": [],
            },
        )
        cwd = os.path.expanduser(path)
        pane = {"index": int(p_index), "active": p_active == "1", "cwd": cwd}
        try:
            agent = _agent_info(int(pid), command, cwd)
        except (OSError, ValueError, psutil.Error):
            agent = None
        if agent:
            pane.update(agent)
        window["panes"].append(pane)
    result = []
    for session in sessions.values():
        windows = sorted(session["windows"].values(), key=lambda w: w["index"])
        for window in windows:
            window["panes"].sort(key=lambda p: p["index"])
        result.append({"name": session["name"], "windows": windows})
    return result


def _pending_restore(current: str) -> bool:
    """이전 부팅의 스냅숏이 아직 복원되지 않은 상태 (이때는 스냅숏을 덮어쓰지 않는다)."""
    snapshot = _read(_snapshot_file())
    return bool(
        snapshot.get("boot")
        and snapshot["boot"] != current
        and _read(_marker_file()).get("boot") != current
    )


def _names(sessions: list) -> list[str]:
    return [s.get("name") for s in sessions if isinstance(s, dict) and s.get("name")]


def _record_history(sessions: list[dict], current_boot: str) -> None:
    """세션 이름 목록이 바뀌면 새 기록을 더하고, 같으면 가장 최근 기록을 지금 구성으로 갱신한다."""
    now = time.time()
    with _history_lock:
        data = _read(_history_file())
        history = [h for h in data.get("snapshots") or [] if isinstance(h, dict)]
        entry = {"at": now, "boot": current_boot, "sessions": sessions}
        if history and sorted(_names(history[-1].get("sessions") or [])) == sorted(
            _names(sessions)
        ):
            if history[-1].get("sessions") == sessions:
                return
            entry["since"] = history[-1].get("since", history[-1].get("at", now))
            history[-1] = entry
        else:
            entry["since"] = now
            history.append(entry)
        data["snapshots"] = history[-HISTORY_LIMIT:]
        _write(_history_file(), data)


def note_closed(name: str) -> None:
    """대시보드에서 일부러 닫은(또는 이름을 바꾼) 세션: 복구 알림에서 뺀다."""
    if not name:
        return
    with _history_lock:
        data = _read(_history_file())
        closed = data.get("closed") if isinstance(data.get("closed"), dict) else {}
        closed[name] = time.time()
        # 오래된 표시는 정리 (알림 대상 기간보다 넉넉히)
        data["closed"] = {
            k: v
            for k, v in closed.items()
            if isinstance(v, (int, float)) and time.time() - v < 7 * 86400
        }
        _write(_history_file(), data)


def save_snapshot() -> bool:
    """구성이 바뀌었으면 저장한다. 저장했으면 True."""
    current = boot_id()
    if _pending_restore(current):
        return False
    sessions = capture()
    # tmux 서버가 없거나(통째로 죽음) 세션이 하나도 없으면 직전 구성을 덮어쓰지 않는다
    if not sessions:
        return False
    _record_history(sessions, current)
    previous = _read(_snapshot_file())
    if previous.get("boot") == current and previous.get("sessions") == sessions:
        return False
    _write(
        _snapshot_file(),
        {"version": VERSION, "boot": current, "at": time.time(), "sessions": sessions},
    )
    return True


# ── 복원 ────────────────────────────────────────────────────────────────────


def _target(session: str, index: int) -> str:
    # '=' 접두사: 이름이 앞부분만 같은 다른 세션을 고르지 않게 정확히 일치
    return f"={session}:{index}"


def _shell_ready(pane_id: str, timeout: float = 10.0) -> None:
    """셸 프롬프트가 뜰 때까지 기다린다 (그 전에 입력하면 rc 파일 초기화 중에 먹힐 수 있다)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            command = tmux_service._run(
                ["display-message", "-p", "-t", pane_id, "#{pane_current_command}"]
            ).strip()
            screen = tmux_service._run(["capture-pane", "-p", "-t", pane_id]).strip()
        except tmux_service.TmuxError:
            return
        if command in agent_restart.SHELLS and screen:
            time.sleep(0.6)
            return
        time.sleep(0.3)


def _launch(pane: dict) -> str | None:
    agent = pane.get("agent")
    if agent not in tmux_service.AGENTS:
        return None
    session_id = pane.get("session_id")
    if session_id and not agent_restart._session_exists(agent, session_id):
        session_id = None
    flags = agent_restart.keep_flags(pane.get("flags") or [], agent_restart.KEEP[agent])
    command = shlex.join(agent_restart._launch_command(agent, session_id, flags))
    home = pane.get("codex_home")
    if agent == "codex" and isinstance(home, str) and home.startswith("/"):
        command = f"CODEX_HOME={shlex.quote(home)} {command}"
    return command


def _directory(path: str) -> str:
    folder = Path(path or "~").expanduser()
    return str(folder) if folder.is_dir() else str(Path.home())


def _restore_session(session: dict, launches: list) -> None:
    name = session["name"]
    windows = session.get("windows") or []
    if not windows or not tmux_service.SESSION_NAME.match(name or ""):
        return
    for position, window in enumerate(windows):
        panes = window.get("panes") or [{"cwd": "~"}]
        index = int(window.get("index", position))
        if position == 0:
            first = tmux_service._run(
                [
                    "new-session",
                    "-d",
                    "-P",
                    "-F",
                    "#{pane_id}" + tmux_service.SEP + "#{window_index}",
                    "-s",
                    name,
                    "-c",
                    _directory(panes[0].get("cwd")),
                    "-x",
                    "160",
                    "-y",
                    "45",
                ]
            ).strip()
            pane_id, _, base = first.partition(tmux_service.SEP)
            # 띄운 창 번호(base-index)가 예전과 다르면 옮긴다 (설정이 'name:번호' 로 저장돼 있다)
            if base.isdigit() and int(base) != index:
                tmux_service._run(
                    [
                        "move-window",
                        "-s",
                        _target(name, int(base)),
                        "-t",
                        _target(name, index),
                    ]
                )
        else:
            pane_id = tmux_service._run(
                [
                    "new-window",
                    "-d",
                    "-P",
                    "-F",
                    "#{pane_id}",
                    "-t",
                    _target(name, index),
                    "-c",
                    _directory(panes[0].get("cwd")),
                ]
            ).strip()
        pane_ids = [pane_id]
        for pane in panes[1:]:
            pane_ids.append(
                tmux_service._run(
                    [
                        "split-window",
                        "-d",
                        "-P",
                        "-F",
                        "#{pane_id}",
                        "-t",
                        pane_id,
                        "-c",
                        _directory(pane.get("cwd")),
                    ]
                ).strip()
            )
        target = _target(name, index)
        if len(panes) > 1 and window.get("layout"):
            try:
                tmux_service._run(["select-layout", "-t", target, window["layout"]])
            except tmux_service.TmuxError:
                tmux_service._run(["select-layout", "-t", target, "tiled"])
        if not window.get("auto_rename", True) and window.get("name"):
            tmux_service._run(["rename-window", "-t", target, window["name"][:100]])
        for pane, new_id in zip(panes, pane_ids, strict=False):
            if pane.get("active") and tmux_service.PANE_ID.match(new_id):
                tmux_service._run(["select-pane", "-t", new_id])
            command = _launch(pane)
            if command and tmux_service.PANE_ID.match(new_id):
                launches.append((new_id, command, pane["agent"]))
        if window.get("active"):
            tmux_service._run(["select-window", "-t", target])


def restore(snapshot: dict) -> dict:
    """스냅숏에서 지금 없는 세션만 다시 만든다."""
    existing = _current_names()
    restored, skipped, failed = [], [], []
    launches: list[tuple[str, str, str]] = []
    for session in snapshot.get("sessions") or []:
        name = session.get("name")
        if name in existing:
            skipped.append(name)
            continue
        try:
            _restore_session(session, launches)
            restored.append(name)
        except (tmux_service.TmuxError, OSError, ValueError, KeyError) as error:
            logger.warning("세션 복원 실패 · %s: %s", name, error)
            failed.append(name)
    tmux_service.invalidate_cache()
    # 에이전트는 셸이 뜬 뒤에 켠다. 한꺼번에 켜면 부팅 직후 부하가 몰려 조금씩 띄운다
    for pane_id, command, agent in launches:
        _shell_ready(pane_id)
        try:
            tmux_service.send_literal(pane_id, command)
            tmux_service.send_keys(pane_id, ["Enter"])
            agent_restart.watch_startup(pane_id, timeout=60.0, agent=agent)
        except (tmux_service.TmuxError, ValueError) as error:
            logger.warning("에이전트 다시 켜기 실패 · %s: %s", pane_id, error)
        time.sleep(0.5)
    tmux_service.invalidate_cache()
    return {
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
        "agents": len(launches),
    }


# ── 화면에서 고르는 복구 ─────────────────────────────────────────────────────


def _snapshot_id(entry: dict) -> str:
    return str(int(float(entry.get("at", 0)) * 1000))


def _current_names() -> set[str]:
    try:
        out = tmux_service._run(["list-sessions", "-F", "#{session_name}"])
    except tmux_service.TmuxError:
        return set()  # tmux 서버가 없음 = 세션 없음
    return {line for line in out.split("\n") if line}


def _missing(entry: dict, current: set[str], closed: dict) -> list[dict]:
    at = float(entry.get("at", 0))
    return [
        s
        for s in entry.get("sessions") or []
        if isinstance(s, dict)
        and s.get("name")
        and s["name"] not in current
        and not (float(closed.get(s["name"], 0) or 0) > at)
    ]


def _agents(sessions: list[dict]) -> int:
    return sum(
        1
        for s in sessions
        for w in s.get("windows") or []
        for p in w.get("panes") or []
        if p.get("agent") in tmux_service.AGENTS
    )


def history() -> dict:
    """복구 화면용: 기록 목록(최근 순) · 지금 없는 세션 · 알림을 띄울 기록 · 진행 중인 복구."""
    data = _read(_history_file())
    closed = data.get("closed") if isinstance(data.get("closed"), dict) else {}
    current = _current_names()
    now = time.time()
    rows, alert = [], None
    for entry in reversed(
        [h for h in data.get("snapshots") or [] if isinstance(h, dict)]
    ):
        sessions = [s for s in entry.get("sessions") or [] if isinstance(s, dict)]
        missing = _missing(entry, current, closed)
        row = {
            "id": _snapshot_id(entry),
            "at": entry.get("at"),
            "since": entry.get("since", entry.get("at")),
            "count": len(sessions),
            "names": _names(sessions),
            "agents": _agents(sessions),
            "missing": _names(missing),
            "missing_agents": _agents(missing),
        }
        rows.append(row)
        # 세션이 전부 사라졌거나, 한꺼번에 두 개 이상 사라졌을 때만 알린다 (하나씩 닫는 건 보통 일부러)
        if (
            alert is None
            and now - float(entry.get("at", 0)) < ALERT_WINDOW
            and missing
            and (not current or len(missing) >= 2)
        ):
            alert = row["id"]
    with _job_lock:
        job = dict(_job)
    return {"current": sorted(current), "snapshots": rows, "alert": alert, "job": job}


def restore_from_history(snapshot_id: str, names: list[str] | None = None) -> list[str]:
    """기록 하나에서 지금 없는 세션(names 가 있으면 그중 고른 것만)을 백그라운드로 다시 만든다."""
    data = _read(_history_file())
    entry = next(
        (
            h
            for h in data.get("snapshots") or []
            if isinstance(h, dict) and _snapshot_id(h) == snapshot_id
        ),
        None,
    )
    if entry is None:
        raise KeyError("그 기록을 찾지 못했습니다.")
    closed = data.get("closed") if isinstance(data.get("closed"), dict) else {}
    # 일부러 닫은 세션도 직접 고르면 복구한다
    missing = _missing(entry, _current_names(), {} if names else closed)
    if names is not None:
        wanted = set(names)
        missing = [s for s in missing if s["name"] in wanted]
    if not missing:
        raise ValueError("다시 만들 세션이 없습니다. 모두 열려 있어요.")
    with _job_lock:
        if _job["running"]:
            raise RuntimeError("이미 복구하는 중입니다. 잠시 뒤 다시 시도하세요.")
        _job.update(running=True, result=None, at=time.time())

    def run() -> None:
        try:
            result = restore({"sessions": missing})
        except Exception:
            logger.exception("세션 복구 중 오류")
            result = {"error": True}
        with _job_lock:
            _job.update(running=False, result=result, at=time.time())
        logger.info(
            "세션 복구 · 복원 %s · 이미 있음 %s · 실패 %s",
            len(result.get("restored", [])),
            len(result.get("skipped", [])),
            result.get("failed") or "-",
        )

    threading.Thread(target=run, daemon=True, name="tmux-restore").start()
    return _names(missing)


def restore_if_rebooted() -> dict | None:
    current = boot_id()
    if not _pending_restore(current):
        return None
    snapshot = _read(_snapshot_file())
    # 다음 부팅에 또 복원하지 않게 먼저 표시한다 (복원 중 대시보드가 죽어도 반복하지 않게)
    _write(_marker_file(), {"boot": current, "at": time.time(), "result": None})
    try:
        result = restore(snapshot)
    except Exception:
        logger.exception("재부팅 뒤 세션 복원 중 오류")
        result = {"error": True}
    _write(_marker_file(), {"boot": current, "at": time.time(), "result": result})
    logger.info(
        "재부팅 뒤 세션 복원 · 복원 %s · 이미 있음 %s · 실패 %s",
        len(result.get("restored", [])),
        len(result.get("skipped", [])),
        result.get("failed") or "-",
    )
    return result


def _loop() -> None:
    try:
        restore_if_rebooted()
    except Exception:
        logger.exception("세션 복원 실패")
    while True:
        try:
            save_snapshot()
        except Exception:
            logger.exception("tmux 스냅숏 저장 실패")
        time.sleep(SNAPSHOT_INTERVAL)


def start() -> None:
    """복원(필요하면) 후 스냅숏을 주기적으로 남기는 백그라운드 스레드. 한 번만 띄운다."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, daemon=True, name="tmux-snapshot").start()
