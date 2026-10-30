"""서버 재부팅 뒤 tmux 세션 복원.

- 스냅숏: 대시보드가 떠 있는 동안 주기적으로 tmux 세션 · 창 · pane 구성(이름, 순서, 폴더, 분할 모양)과
  pane 마다 돌던 에이전트(Claude Code · Codex)의 대화 ID · 실행 옵션을 data/tmux-snapshot.json 에 적는다.
- 복원: 대시보드가 켜졌을 때 스냅숏이 '이전 부팅'에서 찍힌 것이고 이번 부팅에 아직 복원하지 않았으면,
  없는 세션만 같은 이름 · 같은 창 번호로 다시 만들고 에이전트는 같은 대화로 이어서 켠다
  (claude --resume <ID> · codex resume <ID>). 세션 이름이 같아서 폴더 · 순서 · 별칭 설정도 그대로 맞는다.
- 에이전트가 아닌 pane 은 그 폴더의 셸만 연다 (예전에 돌던 임의 명령은 다시 실행하지 않는다).
- 부팅 구분은 /proc/sys/kernel/random/boot_id 로 한다. 대시보드만 재시작했을 때는 복원하지 않는다.
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


def _snapshot_file() -> Path:
    return data_dir() / "tmux-snapshot.json"


def _marker_file() -> Path:
    return data_dir() / "tmux-restored.json"


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


def save_snapshot() -> bool:
    """구성이 바뀌었으면 저장한다. 저장했으면 True."""
    current = boot_id()
    if _pending_restore(current):
        return False
    sessions = capture()
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
    existing = set(
        tmux_service._run(["list-sessions", "-F", "#{session_name}"]).split("\n")
    )
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
