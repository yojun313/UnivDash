"""tmux queries / control.

- Every tmux call runs as an argument list, without a shell.
- Targets are tmux's own IDs only (%pane, @window, $session), never user-typed strings,
  and are checked again right before running to be IDs that exist now.
"""

import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from app.i18n import _

logger = logging.getLogger(__name__)

TMUX = shutil.which("tmux") or "tmux"
# tmux escapes control-character separators, so a rarely seen printable character is used.
SEP = "␟"

PANE_ID = re.compile(r"^%\d{1,6}$")
WINDOW_ID = re.compile(r"^@\d{1,6}$")
# A leading - would be read by tmux as an option, so it is rejected. ":" "." are tmux target separators and cannot be used.
SESSION_NAME = re.compile(r"^[\w가-힣][\w\-가-힣]{0,49}$")
SESSION_ID = re.compile(r"^\$\d{1,6}$")

MAX_TEXT = 20000
MAX_HISTORY = 5000
AGENTS = {"claude", "codex", "gemini"}
# Agent → executable name (the name shown as tmux's pane_current_command). Gemini is the Antigravity CLI (agy).
AGENT_BIN = {"claude": "claude", "codex": "codex", "gemini": "agy"}
_BIN_AGENT = {binary: agent for agent, binary in AGENT_BIN.items()}


def agent_of(command: str | None) -> str | None:
    """Name of the command running in a pane → agent name (None if it is not an agent)."""
    return _BIN_AGENT.get(command or "")


# tmux key names that the mobile key toolbar and direct-input mode may send (send-keys arguments as is)
NAMED_KEYS = {
    "Enter",
    "Escape",
    "Tab",
    "BTab",
    "BSpace",
    "Space",
    "DC",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "IC",
    *(f"F{n}" for n in range(1, 13)),
}
MODIFIED_KEY = re.compile(
    r"^(?:C-|M-|C-M-|S-)(?:[a-z0-9\[\]\\/_@^]|Enter|Tab|Up|Down|Left|Right|BSpace|Space)$"
)

_PANE_FIELDS = [
    ("session_id", "#{session_id}"),
    ("session_name", "#{session_name}"),
    ("session_attached", "#{session_attached}"),
    ("window_id", "#{window_id}"),
    ("window_index", "#{window_index}"),
    ("window_name", "#{window_name}"),
    ("window_active", "#{window_active}"),
    ("window_activity", "#{window_activity}"),
    ("pane_id", "#{pane_id}"),
    ("pane_index", "#{pane_index}"),
    ("pane_pid", "#{pane_pid}"),
    ("pane_active", "#{pane_active}"),
    ("pane_title", "#{pane_title}"),
    ("pane_command", "#{pane_current_command}"),
    ("pane_path", "#{pane_current_path}"),
    ("pane_width", "#{pane_width}"),
    ("pane_height", "#{pane_height}"),
    ("pane_dead", "#{pane_dead}"),
    ("pane_in_mode", "#{pane_in_mode}"),
]
_PANE_FORMAT = SEP.join(fmt for _name, fmt in _PANE_FIELDS)

# In a narrow window the end of the hint is cut off ("esc to inte…")
_BUSY_TEXT = re.compile(r"esc to int|esc to cancel|ctrl\+c to interrupt", re.IGNORECASE)
# Claude Code working line: "✶ Scampering… (2m 50s · still thinking)" (after finishing: "✻ Worked for 2m 50s")
_CLAUDE_SPINNER = re.compile(r"^\s*[✻✽✶✢✳✺✹✷·*]\s+\S.{0,80}?…\s*(?:\(|$)")
# Cursor line of a selection dialog: "❯ 3. Yes" / "› 2. GPT-6-Sol"
_CURSOR_OPTION = re.compile(r"^\s*[❯›]\s*\d{1,2}\.\s+\S")
# Codex working line: "• Working (5s • esc to interrupt)" (the end is cut off when narrow)
_CODEX_WORKING = re.compile(r"\(\d+[hms][^)]*esc to i")
_SEPARATOR = re.compile(r"^\s*─{20,}\s*$")
# Hint below the Codex input box (cut to "? for sho" when narrow)
_CODEX_INPUT_HINT = re.compile(r"\? for|for shortcuts|for agents|context left|to queue")
# Even after Claude Code hits the usage limit, the previous spinner text or tmux title may linger for a moment.
# When this notice is visible the current request is no longer being processed, so it takes precedence over busy.
_LIMIT_REACHED_TEXT = re.compile(
    r"you(?:'|’)ve hit your (?:session|usage|weekly|monthly) limit|usage limit reached",
    re.IGNORECASE,
)
# Permission / selection prompts: "❯ 1. Yes" (Claude Code), "› 1. Yes, proceed" (Codex), the folder trust check, y/n questions
_WAITING_TEXT = re.compile(
    # In a Codex selection dialog (/model, etc.) the cursor is on the current item, which may not be 1., and the
    # hint reads "Press ⏎ to confirm or esc …"
    r"^\s*[❯›]\s*1\.\s|press enter to continue|enter to confirm|to confirm or|esc to dismiss|esc to go back|enter select|enter default|esc back|enter to set as default|use this session only|enter continue|\(y/n\)|\[y/n\]",
    re.IGNORECASE | re.MULTILINE,
)
# Antigravity CLI: selection · permission · folder trust dialogs show "> 1. Yes, run command" and the
# "↑/↓ Navigate · enter Confirm" hint
_GEMINI_WAITING = re.compile(
    r"^\s*>\s*\d\.\s+\S|↑/↓ navigate", re.IGNORECASE | re.MULTILINE
)
# Working line: "⣽  Generating..." · "⢿  Running command..." (right above the input box)
_GEMINI_SPINNER = re.compile(r"^\s*[\u2800-\u28ff]\s+\S")
# Claude Code prefixes the terminal title with a braille spinner while working and with ✳ while idle.
_SPINNER_TITLE = re.compile(r"^[\u2800-\u28ff]")
_TITLE_PREFIX = re.compile(r"^[\u2800-\u28ff✳]\s*")


class TmuxError(Exception):
    pass


@dataclass
class Pane:
    id: str
    index: int
    pid: int
    active: bool
    title: str
    command: str
    path: str
    width: int
    height: int
    dead: bool
    in_mode: bool


@dataclass
class Window:
    key: str  # stable key for stored preferences: "session-name:window-number"
    id: str
    session: str
    session_id: str
    index: int
    name: str
    active: bool
    attached: bool
    activity: int
    panes: list[Pane] = field(default_factory=list)
    # Time of the last real agent answer (screen redraws excluded)
    reply_activity: int = 0
    # The last thing done was only a conversation compaction (a finished compaction raises no 'work done' notification)
    compacted: bool = False
    agent: str | None = None
    title: str = ""
    path: str = ""
    status: str = "idle"  # idle | busy | waiting | shell | dead
    # An agent the dashboard just (re)started — status changes during start-up are not notified
    starting: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


# Environment variables passed when creating a new session (and the server, if no tmux server exists). The tmux
# server and every shell inside it inherit the environment of the process that started the server. Passing the
# dashboard's environment as is would put ADMIN_PASS · SECRET_KEY etc. from .env into every session, so only this
# list is passed (PATH etc. are set again by the login shell).
_SESSION_ENV = {
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMUX_TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
}


def session_env() -> dict[str, str]:
    return {
        k: v for k, v in os.environ.items() if k in _SESSION_ENV or k.startswith("LC_")
    }


def _run(args: list[str], *, input_text: str | None = None, timeout: float = 5) -> str:
    base = session_env() if args[:1] == ["new-session"] else os.environ
    try:
        result = subprocess.run(
            [TMUX, *args],
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**base, "LC_ALL": os.environ.get("LC_ALL") or "C.UTF-8"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TmuxError(_("tmux 를 실행하지 못했습니다.")) from error
    if result.returncode != 0:
        message = result.stderr.strip()
        if "no server running" in message or "error connecting" in message:
            return ""
        raise TmuxError(message or _("tmux 명령이 실패했습니다."))
    return result.stdout


def _short_path(path: str) -> str:
    home = str(Path.home())
    return (
        "~" + path[len(home) :] if path == home or path.startswith(home + "/") else path
    )


def _clean_title(title: str) -> str:
    title = title.strip()
    if title in {os.uname().nodename, ""}:
        return ""
    return _TITLE_PREFIX.sub("", title).strip()


def _input_box(rows: list[str], agent: str | None) -> tuple[int, int] | None:
    """Position (top line, bottom line) of the input box if it is at the very bottom of the screen. rows is the screen without blank lines.

    When a selection · permission dialog appears, the input box disappears. So while the input box is visible,
    the agent is not waiting for an answer, whatever characters the conversation text contains.
    """
    if agent in {"claude", "gemini"}:
        # Like Claude Code, Antigravity CLI puts the "> " input line between two horizontal rules
        seps = [i for i, line in enumerate(rows) if _SEPARATOR.match(line)]
        if len(seps) < 2:
            return None
        top, bottom = seps[-2], seps[-1]
        if len(rows) - 1 - bottom > 4 or bottom - top < 2:
            return None
        return (top, bottom) if rows[top + 1].lstrip().startswith(("❯", ">")) else None
    if agent == "codex":
        if not any(_CODEX_INPUT_HINT.search(line) for line in rows[-3:]):
            return None
        for i in range(len(rows) - 1, max(-1, len(rows) - 7), -1):
            line = rows[i].lstrip()
            if line.startswith("› ") and not _CURSOR_OPTION.match(rows[i]):
                return i, i
        return None
    return None


def has_input_box(lines: list[str], agent: str | None) -> bool:
    return _input_box([line for line in lines if line.strip()], agent) is not None


def detect_status(window: Window, tail: str) -> str:
    """Estimate the status of an agent (claude/codex) window from its screen (the whole visible part)."""
    pane = next(
        (p for p in window.panes if p.active), window.panes[0] if window.panes else None
    )
    if pane is None or pane.dead:
        return "dead"
    if window.agent is None:
        return "shell"
    rows = [line.rstrip() for line in tail.splitlines() if line.strip()]
    recent = "\n".join(rows[-12:])
    if _LIMIT_REACHED_TEXT.search(recent):
        return "idle"
    box = _input_box(rows, window.agent)
    if box is None:
        # No input box: a selection · permission · confirmation dialog
        if _WAITING_TEXT.search(recent) or any(_CURSOR_OPTION.match(r) for r in rows):
            return "waiting"
        if window.agent == "gemini" and _GEMINI_WAITING.search(recent):
            return "waiting"
        if _BUSY_TEXT.search(recent):
            return "busy"
    else:
        top, bottom = box
        # The working line is right above the input box (a to-do list · tips may follow below it); hints are
        # looked for only below the input box
        above = rows[max(0, top - 20) : top]
        below = "\n".join(rows[bottom + 1 :])
        if window.agent == "claude" and any(_CLAUDE_SPINNER.match(r) for r in above):
            return "busy"
        if window.agent == "gemini":
            # The slash-command list also shows "esc to cancel" (together with the Navigate hint), so the
            # working line is checked first
            if any(_GEMINI_SPINNER.match(r) for r in above[-4:]):
                return "busy"
            return (
                "busy"
                if _BUSY_TEXT.search(below) and "navigate" not in below.lower()
                else "idle"
            )
        if _BUSY_TEXT.search(below):
            return "busy"
        # The Codex working line "• Working (5s • esc to interrupt)" is right above the input line
        if window.agent == "codex" and any(
            _CODEX_WORKING.search(r) for r in above[-3:]
        ):
            return "busy"
    if _SPINNER_TITLE.match(pane.title.strip()):
        return "busy"
    return "idle"


# Agent windows the dashboard (re)started: pane id → no status-change notifications until this time.
# So the brief 'working' → done while a conversation is reloaded after an account switch · restart is not
# notified as 'work done'.
_starting_lock = threading.Lock()
_starting: dict[str, float] = {}


def mark_starting(pane_id: str, seconds: float) -> None:
    with _starting_lock:
        _starting[pane_id] = time.monotonic() + seconds


def settle_starting(pane_id: str, grace: float) -> None:
    """Start-up finished: notifications are turned back on after grace seconds, once the screen has settled."""
    with _starting_lock:
        if pane_id in _starting:
            _starting[pane_id] = min(_starting[pane_id], time.monotonic() + grace)


def _starting_panes() -> set[str]:
    now = time.monotonic()
    with _starting_lock:
        for pane_id in [p for p, until in _starting.items() if until <= now]:
            del _starting[pane_id]
        return set(_starting)


# The Codex background server (app-server-daemon) updates and restarts itself. Every Codex window then
# reattaches to the server and reloads its conversation, becoming 'working' briefly and then done → during that
# time Codex windows are treated as starting.
CODEX_DAEMON_GRACE = 90.0


def _codex_daemon_restarted_recently() -> bool:
    root = os.getenv("CODEX_DATA_DIR")
    home = Path(root).expanduser() if root else Path.home() / ".codex"
    try:
        started = (home / "app-server-daemon" / "daemon.pid").stat().st_mtime
    except OSError:
        return False
    return 0 <= time.time() - started < CODEX_DAEMON_GRACE


def list_windows(with_status: bool = True) -> list[Window]:
    raw = _run(["list-panes", "-a", "-F", _PANE_FORMAT])
    windows: dict[str, Window] = {}
    for line in raw.splitlines():
        parts = line.split(SEP)
        if len(parts) != len(_PANE_FIELDS):
            continue
        row = dict(zip((name for name, _fmt in _PANE_FIELDS), parts))
        window = windows.get(row["window_id"])
        if window is None:
            window = Window(
                key=f"{row['session_name']}:{row['window_index']}",
                id=row["window_id"],
                session=row["session_name"],
                session_id=row["session_id"],
                index=int(row["window_index"] or 0),
                name=row["window_name"],
                active=row["window_active"] == "1",
                attached=row["session_attached"] not in {"", "0"},
                activity=int(row["window_activity"] or 0),
            )
            windows[window.id] = window
        window.panes.append(
            Pane(
                id=row["pane_id"],
                index=int(row["pane_index"] or 0),
                pid=int(row["pane_pid"] or 0),
                active=row["pane_active"] == "1",
                title=row["pane_title"],
                command=row["pane_command"],
                path=_short_path(row["pane_path"]),
                width=int(row["pane_width"] or 0),
                height=int(row["pane_height"] or 0),
                dead=row["pane_dead"] == "1",
                in_mode=row["pane_in_mode"] == "1",
            )
        )

    result = sorted(windows.values(), key=lambda w: (w.session, w.index))
    starting = _starting_panes()
    codex_restarting = _codex_daemon_restarted_recently()
    for window in result:
        window.starting = any(p.id in starting for p in window.panes)
        active = next((p for p in window.panes if p.active), window.panes[0])
        agent_pane = next((p for p in window.panes if agent_of(p.command)), None)
        window.agent = agent_of(agent_pane.command) if agent_pane else None
        if codex_restarting and window.agent == "codex":
            window.starting = True
        window.title = _clean_title((agent_pane or active).title)
        window.path = active.path
        if with_status:
            tail = ""
            if window.agent:
                try:
                    tail = _run(
                        ["capture-pane", "-p", "-t", (agent_pane or active).id]
                    ).rstrip()
                except TmuxError:
                    tail = ""
            window.status = detect_status(window, tail)
            if window.agent:
                # tmux window_activity also changes on Codex's idle screen refreshes, so unread answers are
                # judged by the last assistant message of the actual conversation log.
                from app.services.agents import transcript_service

                pane = agent_pane or active
                try:
                    log = transcript_service.find_log(
                        pane.pid, window.agent, os.path.expanduser(pane.path)
                    )
                    if log:
                        items = transcript_service.read(log, window.agent, None, 300)[
                            "items"
                        ]
                        latest = next(
                            (
                                item.get("ts")
                                for item in reversed(items)
                                if item.get("kind") == "assistant" and item.get("ts")
                            ),
                            None,
                        )
                        window.compacted = bool(items) and (
                            items[-1].get("text") == transcript_service.COMPACTED
                        )
                        if latest:
                            window.reply_activity = int(
                                datetime.fromisoformat(latest).timestamp()
                            )
                except (OSError, ValueError, KeyError):
                    pass
    return result


_cache_lock = threading.Lock()
_cache: tuple[float, list[Window]] = (0.0, [])


def cached_windows(max_age: float = 1.5) -> list[Window]:
    """Query tmux only once even when several tabs / clients poll at the same time."""
    global _cache
    with _cache_lock:
        stamp, windows = _cache
        if time.monotonic() - stamp < max_age:
            return windows
        windows = list_windows()
        _cache = (time.monotonic(), windows)
        return windows


def invalidate_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = (0.0, [])


def _pane_ids() -> set[str]:
    return set(_run(["list-panes", "-a", "-F", "#{pane_id}"]).split())


def _window_ids() -> set[str]:
    return set(_run(["list-windows", "-a", "-F", "#{window_id}"]).split())


def require_pane(pane_id: str) -> str:
    if (
        not isinstance(pane_id, str)
        or not PANE_ID.match(pane_id)
        or pane_id not in _pane_ids()
    ):
        raise KeyError(_("존재하지 않는 pane 입니다."))
    return pane_id


def require_window(window_id: str) -> str:
    if (
        not isinstance(window_id, str)
        or not WINDOW_ID.match(window_id)
        or window_id not in _window_ids()
    ):
        raise KeyError(_("존재하지 않는 창입니다."))
    return window_id


def capture(pane_id: str, history: int = 300) -> dict:
    """Fetch the pane screen + scrollback with ANSI colors intact (the browser converts it to HTML)."""
    history = max(0, min(int(history), MAX_HISTORY))
    content = _run(["capture-pane", "-p", "-e", "-t", pane_id, "-S", f"-{history}"])
    info = (
        _run(
            [
                "display-message",
                "-p",
                "-t",
                pane_id,
                SEP.join(
                    [
                        "#{cursor_x}",
                        "#{cursor_y}",
                        "#{cursor_flag}",
                        "#{pane_width}",
                        "#{pane_height}",
                        "#{alternate_on}",
                        "#{pane_in_mode}",
                    ]
                ),
            ]
        )
        .strip()
        .split(SEP)
    )
    cx, cy, cflag, width, height, alternate, in_mode = (info + ["0"] * 7)[:7]
    return {
        "pane": pane_id,
        # The line count must stay = scrollback + screen height so the cursor position can be computed.
        "content": content.removesuffix("\n"),
        "cursor": {"x": int(cx or 0), "y": int(cy or 0), "visible": cflag == "1"},
        "width": int(width or 0),
        "height": int(height or 0),
        "alternate": alternate == "1",
        "in_mode": in_mode == "1",
    }


def validate_key(key: str) -> str:
    if key in NAMED_KEYS or MODIFIED_KEY.match(key or ""):
        return key
    raise ValueError(_("허용되지 않은 키입니다."))


def send_keys(pane_id: str, keys: list[str]) -> None:
    keys = [validate_key(k) for k in keys][:32]
    if keys:
        _run(["send-keys", "-t", pane_id, *keys])


def send_literal(pane_id: str, text: str) -> None:
    """Direct-input mode: send one character / a short string as is (not interpreted as key names)."""
    if not text:
        return
    if len(text) > 4096:
        raise ValueError(_("입력이 너무 깁니다."))
    _run(["send-keys", "-t", pane_id, "-l", "--", text])


def _paste(pane_id: str, text: str) -> None:
    buffer = f"univdash-{secrets.token_hex(6)}"
    _run(["load-buffer", "-b", buffer, "-"], input_text=text)
    _run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane_id])


def send_prompt(
    pane_id: str, text: str, submit: bool = True, attachments: list[str] | tuple = ()
) -> None:
    """Send a prompt.

    Multiple lines are pasted with bracketed paste so Claude Code / Codex do not submit at every line break,
    and since an Enter sent right after a paste is sometimes treated as part of the paste, there is a short wait.

    Attachments are pasted separately, one path at a time. This is the same as dragging a file onto the terminal,
    so Claude Code / Codex recognize an image path as an image attachment ([Image #1]).
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > MAX_TEXT:
        raise ValueError(_("프롬프트는 {count}자 이하로 보내주십시오.", count=MAX_TEXT))
    for path in attachments:
        _paste(pane_id, path)
        time.sleep(0.2)
        _run(["send-keys", "-t", pane_id, "-l", "--", " "])
    if text:
        if "\n" in text:
            _paste(pane_id, text)
        else:
            _run(["send-keys", "-t", pane_id, "-l", "--", text])
    if submit:
        if text or attachments:
            time.sleep(0.3 if attachments or "\n" in text or len(text) > 200 else 0.12)
        _run(["send-keys", "-t", pane_id, "Enter"])


MIN_COLS, MAX_COLS = 40, 400
MIN_ROWS, MAX_ROWS = 10, 200


def fit_window(pane_id: str, cols: int, rows: int) -> bool:
    """Resize the pane's tmux window to the screen size seen in the dashboard.

    A session with no attached terminal (client) stays at tmux's default size (80x24) and looks small, so it
    follows the size of the device that opened the screen last. A session with a real terminal attached keeps
    that terminal's size and is not touched.
    """
    cols = max(MIN_COLS, min(MAX_COLS, int(cols)))
    rows = max(MIN_ROWS, min(MAX_ROWS, int(rows)))
    info = _run(
        [
            "display-message",
            "-p",
            "-t",
            pane_id,
            "#{window_width} #{window_height} #{session_attached}",
        ]
    ).split()
    if len(info) != 3:
        return False
    width, height, attached = info
    if attached not in {"", "0"}:
        return False
    if (width, height) == (str(cols), str(rows)):
        return False
    _run(["resize-window", "-t", pane_id, "-x", str(cols), "-y", str(rows)])
    return True


def check_new_session(name: str, path: str) -> Path:
    """Check that a new session can be created and return its working folder."""
    if not SESSION_NAME.match(name or ""):
        raise ValueError(_("세션 이름은 글자, 숫자, -, _ 로 50자 이하여야 합니다."))
    directory = Path(os.path.expanduser(path or "~")).resolve()
    if not directory.is_dir():
        raise ValueError(_("작업 폴더가 존재하지 않습니다."))
    existing = set(_run(["list-sessions", "-F", "#{session_name}"]).split("\n"))
    if name in existing:
        raise ValueError(_("같은 이름의 세션이 이미 있습니다."))
    return directory


def create_session(name: str, path: str, command: str) -> str:
    directory = check_new_session(name, path)
    command = (command or "").strip()
    if len(command) > 500 or "\n" in command:
        raise ValueError(_("시작 명령이 올바르지 않습니다."))
    pane_id = _run(
        [
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            name,
            "-c",
            str(directory),
            "-x",
            "160",
            "-y",
            "45",
        ]
    ).strip()
    if command and PANE_ID.match(pane_id):
        # Input typed before the shell is up can be swallowed while the prompt initializes.
        time.sleep(0.3)
        _run(["send-keys", "-t", pane_id, "-l", "--", command])
        _run(["send-keys", "-t", pane_id, "Enter"])
    invalidate_cache()
    return pane_id


def rename_session(session_id: str, name: str) -> tuple[str, str]:
    """Rename a tmux session. (old name, new name)"""
    if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        raise KeyError(_("존재하지 않는 세션입니다."))
    name = (name or "").strip()
    if not SESSION_NAME.match(name):
        raise ValueError(
            _(
                "세션 이름은 글자 · 숫자 · - · _ 로 50자 이하여야 합니다 (첫 글자는 - 불가, 공백 · : · . 불가)."
            )
        )
    rows = [
        line.split(SEP)
        for line in _run(
            ["list-sessions", "-F", f"#{{session_id}}{SEP}#{{session_name}}"]
        ).splitlines()
    ]
    names = {row[0]: row[1] for row in rows if len(row) == 2}
    if session_id not in names:
        raise KeyError(_("존재하지 않는 세션입니다."))
    old = names[session_id]
    if name != old and name in names.values():
        raise ValueError(_("같은 이름의 세션이 이미 있습니다."))
    if name != old:
        _run(["rename-session", "-t", session_id, name])
        invalidate_cache()
    return old, name


def window_session(window_id: str) -> str:
    return _run(["display-message", "-p", "-t", window_id, "#{session_name}"]).strip()


def kill_window(window_id: str) -> None:
    _run(["kill-window", "-t", window_id])
    invalidate_cache()


def select_pane(pane_id: str) -> None:
    _run(["select-pane", "-t", pane_id])


# Status line at the bottom of the Codex screen: "  GPT-6-Luna low · ~" or "  GPT-6-Sol medium fast · ~"
_CODEX_FOOTER = re.compile(
    r"^\s{1,6}((?:gpt|o\d|codex)[\w.\-]*)"
    r"(?:\s+(minimal|low|medium|high|xhigh|extra high|max|ultra))?"
    r"(?:\s+(fast))?\s*·\s",
    re.IGNORECASE,
)


def codex_footer_model(pane_id: str) -> str | None:
    try:
        text = _run(["capture-pane", "-p", "-t", pane_id])
    except TmuxError:
        return None
    lines = [line for line in text.split("\n") if line.strip()][-8:]
    for line in reversed(lines):
        match = _CODEX_FOOTER.match(line)
        if match:
            return " ".join(part for part in match.groups() if part)[:60]
    return None


# Bottom right of the Antigravity CLI screen: "Gemini 3.8 Flash · low" (model · reasoning effort)
_GEMINI_FOOTER = re.compile(
    r"(?:^|\s{2,})((?:Gemini|Claude|GPT)[\w .\-()]{1,40}?)\s·\s(low|medium|high)\s*$",
    re.IGNORECASE,
)


def gemini_footer_model(pane_id: str) -> str | None:
    try:
        text = _run(["capture-pane", "-p", "-t", pane_id])
    except TmuxError:
        return None
    lines = [line for line in text.split("\n") if line.strip()][-4:]
    for line in reversed(lines):
        match = _GEMINI_FOOTER.search(line.rstrip())
        if match:
            return f"{match.group(1).strip()} {match.group(2).lower()}"[:60]
    return None
