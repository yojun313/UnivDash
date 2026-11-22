"""Restoring tmux sessions after a server reboot.

- Snapshot: while the dashboard is up, the tmux session · window · pane layout (names, order, folders, split shape)
  and, per pane, the conversation ID · launch options of the agent that ran there (Claude Code · Codex) are written
  periodically to data/tmux-snapshot.json.
- Restore: when the dashboard starts and the snapshot was taken in a 'previous boot' and has not been restored in
  this boot yet, only the missing sessions are recreated with the same name · same window numbers, and agents are
  resumed with the same conversation (claude --resume <ID> · codex resume <ID>). Because the session names match,
  the folder · order · alias settings still apply.
- A pane that was not an agent only gets a shell in its folder (arbitrary commands that ran before are not re-run).
- Boots are told apart by /proc/sys/kernel/random/boot_id. Nothing is restored when only the dashboard restarted.
- History: whenever the session list (names) changes, the latest HISTORY_LIMIT entries are kept in
  data/tmux-history.json. Nothing is recorded when the tmux server died as a whole and there are no sessions,
  so the layout from just before it died remains. In the UI's 'Session restore', one entry is picked and only the
  sessions missing now are recreated (restore_from_history).
- Sessions closed from the dashboard are recorded as 'closed' and left out of the restore notice.
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

from app.i18n import _
from app.paths import data_dir
from app.services.agents import agent_restart, tmux_service, transcript_service

logger = logging.getLogger(__name__)

SNAPSHOT_INTERVAL = 20.0
VERSION = 1
HISTORY_LIMIT = 40
# Entries older than this are not used for the 'sessions disappeared' notice
ALERT_WINDOW = 12 * 3600
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


# ── Snapshot ────────────────────────────────────────────────────────────────


def _agent_info(pid: int, command: str, cwd: str) -> dict | None:
    """Conversation ID of the agent running in a pane · the options used to resume it."""
    # Executable name (agy) → agent name (gemini)
    command = tmux_service.agent_of(command)
    if command is None:
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
    keep = agent_restart.KEEP[command]
    info = {
        "agent": command,
        "session_id": transcript_service.conversation_id(log) or None,
        "flags": agent_restart.keep_flags(argv, keep),
    }
    if codex_home:
        info["codex_home"] = codex_home
    return info


def capture() -> list[dict]:
    """The current tmux layout. An empty list if there is no tmux server."""
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
    """A snapshot from a previous boot has not been restored yet (the snapshot is not overwritten in this state)."""
    snapshot = _read(_snapshot_file())
    return bool(
        snapshot.get("boot")
        and snapshot["boot"] != current
        and _read(_marker_file()).get("boot") != current
    )


def _names(sessions: list) -> list[str]:
    return [s.get("name") for s in sessions if isinstance(s, dict) and s.get("name")]


def _record_history(sessions: list[dict], current_boot: str) -> None:
    """Add a new entry when the list of session names changed; otherwise update the latest entry to the current layout."""
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
    """A session closed (or renamed) on purpose from the dashboard: left out of the restore notice."""
    if not name:
        return
    with _history_lock:
        data = _read(_history_file())
        closed = data.get("closed") if isinstance(data.get("closed"), dict) else {}
        closed[name] = time.time()
        # Drop old marks (kept comfortably longer than the notice period)
        data["closed"] = {
            k: v
            for k, v in closed.items()
            if isinstance(v, (int, float)) and time.time() - v < 7 * 86400
        }
        _write(_history_file(), data)


def save_snapshot() -> bool:
    """Save if the layout changed. True if saved."""
    current = boot_id()
    if _pending_restore(current):
        return False
    sessions = capture()
    # With no tmux server (it died as a whole) or no sessions at all, the previous layout is not overwritten
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


# ── Restore ─────────────────────────────────────────────────────────────────


def _target(session: str, index: int) -> str:
    # '=' prefix: exact match, so another session whose name merely starts the same is not picked
    return f"={session}:{index}"


def _shell_ready(pane_id: str, timeout: float = 10.0) -> None:
    """Wait until the shell prompt is up (input typed earlier can be swallowed while the rc files initialize)."""
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
            pane_id, _sep, base = first.partition(tmux_service.SEP)
            # If the new window's number (base-index) differs from before, move it (settings are stored as 'name:number')
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
    """Recreate only the sessions of the snapshot that are missing now."""
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
            logger.warning("Session restore failed · %s: %s", name, error)
            failed.append(name)
    tmux_service.invalidate_cache()
    # Agents are started after the shell is up. Starting them all at once piles load right after boot, so they
    # are started a few at a time
    for pane_id, command, agent in launches:
        _shell_ready(pane_id)
        try:
            tmux_service.send_literal(pane_id, command)
            tmux_service.send_keys(pane_id, ["Enter"])
            agent_restart.watch_startup(pane_id, timeout=60.0, agent=agent)
        except (tmux_service.TmuxError, ValueError) as error:
            logger.warning("Agent restart failed · %s: %s", pane_id, error)
        time.sleep(0.5)
    tmux_service.invalidate_cache()
    return {
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
        "agents": len(launches),
    }


# ── Restore picked in the UI ────────────────────────────────────────────────


def _snapshot_id(entry: dict) -> str:
    return str(int(float(entry.get("at", 0)) * 1000))


def _current_names() -> set[str]:
    try:
        out = tmux_service._run(["list-sessions", "-F", "#{session_name}"])
    except tmux_service.TmuxError:
        return set()  # no tmux server = no sessions
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
    """For the restore screen: history entries (newest first) · sessions missing now · the entry to raise a notice for · the restore in progress."""
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
        # Notify only when every session is gone or two or more disappeared at once (closing one at a time is usually on purpose)
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
    """Recreate, in the background, the sessions of one history entry that are missing now (with names, only the chosen ones)."""
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
        raise KeyError(_("그 기록을 찾지 못했습니다."))
    closed = data.get("closed") if isinstance(data.get("closed"), dict) else {}
    # A session closed on purpose is restored too when it is picked explicitly
    missing = _missing(entry, _current_names(), {} if names else closed)
    if names is not None:
        wanted = set(names)
        missing = [s for s in missing if s["name"] in wanted]
    if not missing:
        raise ValueError(_("다시 만들 세션이 없습니다. 모두 열려 있습니다."))
    with _job_lock:
        if _job["running"]:
            raise RuntimeError(_("이미 복구하는 중입니다. 잠시 뒤 다시 시도하십시오."))
        _job.update(running=True, result=None, at=time.time())

    def run() -> None:
        try:
            result = restore({"sessions": missing})
        except Exception:
            logger.exception("Error during session restore")
            result = {"error": True}
        with _job_lock:
            _job.update(running=False, result=result, at=time.time())
        logger.info(
            "Session restore · restored %s · already present %s · failed %s",
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
    # Mark first so it is not restored again (no repeat even if the dashboard dies during the restore)
    _write(_marker_file(), {"boot": current, "at": time.time(), "result": None})
    try:
        result = restore(snapshot)
    except Exception:
        logger.exception("Error during session restore after reboot")
        result = {"error": True}
    _write(_marker_file(), {"boot": current, "at": time.time(), "result": result})
    logger.info(
        "Session restore after reboot · restored %s · already present %s · failed %s",
        len(result.get("restored", [])),
        len(result.get("skipped", [])),
        result.get("failed") or "-",
    )
    return result


def _loop() -> None:
    try:
        restore_if_rebooted()
    except Exception:
        logger.exception("Session restore failed")
    while True:
        try:
            save_snapshot()
        except Exception:
            logger.exception("Saving the tmux snapshot failed")
        time.sleep(SNAPSHOT_INTERVAL)


def start() -> None:
    """Background thread that restores (if needed) and then takes snapshots periodically. Started only once."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, daemon=True, name="tmux-snapshot").start()
