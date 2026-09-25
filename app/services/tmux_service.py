"""tmux 조회/제어.

- 모든 tmux 호출은 shell 없이 인자 리스트로 실행한다.
- 대상은 사용자 입력 문자열이 아니라 tmux 고유 ID(%pane, @window, $session)만 받고,
  실행 직전에 현재 존재하는 ID인지 다시 확인한다.
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
from pathlib import Path

logger = logging.getLogger(__name__)

TMUX = shutil.which("tmux") or "tmux"
SEP = "␟"  # tmux 는 제어 문자 구분자를 이스케이프하므로 보기 드문 인쇄 문자를 쓴다.

PANE_ID = re.compile(r"^%\d{1,6}$")
WINDOW_ID = re.compile(r"^@\d{1,6}$")
# 첫 글자가 - 이면 tmux 가 옵션으로 해석하므로 막는다. ":" "." 은 tmux 대상 구분자라 쓸 수 없다.
SESSION_NAME = re.compile(r"^[\w가-힣][\w\-가-힣]{0,49}$")
SESSION_ID = re.compile(r"^\$\d{1,6}$")

MAX_TEXT = 20000
MAX_HISTORY = 5000
AGENTS = {"claude", "codex"}

# 모바일 키 툴바와 직접 입력 모드에서 보낼 수 있는 tmux 키 이름 (send-keys 인자 그대로)
NAMED_KEYS = {
    "Enter", "Escape", "Tab", "BTab", "BSpace", "Space", "DC",
    "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "IC",
    *(f"F{n}" for n in range(1, 13)),
}
MODIFIED_KEY = re.compile(r"^(?:C-|M-|C-M-|S-)(?:[a-z0-9\[\]\\/_@^]|Enter|Tab|Up|Down|Left|Right|BSpace|Space)$")

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
_PANE_FORMAT = SEP.join(fmt for _, fmt in _PANE_FIELDS)

_BUSY_TEXT = re.compile(r"esc to interrupt|esc to cancel|ctrl\+c to interrupt", re.IGNORECASE)
# 권한/선택 프롬프트: "❯ 1. Yes" (Claude Code), "› 1. Yes, proceed" (Codex), 폴더 신뢰 확인, y/n 질문
_WAITING_TEXT = re.compile(
    # Codex 선택 창(/model 등)은 커서가 현재 항목에 있어 1. 이 아닐 수 있고 안내문이 "Press ⏎ to confirm or esc …" 이다
    r"^\s*[❯›]\s*1\.\s|press enter to continue|enter to confirm|to confirm or|esc to dismiss|esc to go back|enter select|enter default|esc back|enter continue|\(y/n\)|\[y/n\]",
    re.IGNORECASE | re.MULTILINE,
)
# Claude Code 는 작업 중 터미널 제목 앞에 점자 스피너를, 쉬는 중에는 ✳ 를 붙인다.
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
    key: str  # 환경설정 저장용 안정 키 "세션이름:창번호"
    id: str
    session: str
    session_id: str
    index: int
    name: str
    active: bool
    attached: bool
    activity: int
    panes: list[Pane] = field(default_factory=list)
    agent: str | None = None
    title: str = ""
    path: str = ""
    status: str = "idle"  # idle | busy | waiting | shell | dead

    def to_dict(self) -> dict:
        return asdict(self)


def _run(args: list[str], *, input_text: str | None = None, timeout: float = 5) -> str:
    try:
        result = subprocess.run(
            [TMUX, *args],
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": os.environ.get("LC_ALL") or "C.UTF-8"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TmuxError("tmux 를 실행하지 못했습니다.") from error
    if result.returncode != 0:
        message = result.stderr.strip()
        if "no server running" in message or "error connecting" in message:
            return ""
        raise TmuxError(message or "tmux 명령이 실패했습니다.")
    return result.stdout


def _short_path(path: str) -> str:
    home = str(Path.home())
    return "~" + path[len(home):] if path == home or path.startswith(home + "/") else path


def _clean_title(title: str) -> str:
    title = title.strip()
    if title in {os.uname().nodename, ""}:
        return ""
    return _TITLE_PREFIX.sub("", title).strip()


def detect_status(window: Window, tail: str) -> str:
    """에이전트(claude/codex) 창의 상태를 화면 하단 텍스트로 추정한다."""
    pane = next((p for p in window.panes if p.active), window.panes[0] if window.panes else None)
    if pane is None or pane.dead:
        return "dead"
    if window.agent is None:
        return "shell"
    if _WAITING_TEXT.search(tail):
        return "waiting"
    raw_title = pane.title.strip()
    if _BUSY_TEXT.search(tail) or _SPINNER_TITLE.match(raw_title):
        return "busy"
    return "idle"


def list_windows(with_status: bool = True) -> list[Window]:
    raw = _run(["list-panes", "-a", "-F", _PANE_FORMAT])
    windows: dict[str, Window] = {}
    for line in raw.splitlines():
        parts = line.split(SEP)
        if len(parts) != len(_PANE_FIELDS):
            continue
        row = dict(zip((name for name, _ in _PANE_FIELDS), parts))
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
    for window in result:
        active = next((p for p in window.panes if p.active), window.panes[0])
        agent_pane = next((p for p in window.panes if p.command in AGENTS), None)
        window.agent = agent_pane.command if agent_pane else None
        window.title = _clean_title((agent_pane or active).title)
        window.path = active.path
        if with_status:
            tail = ""
            if window.agent:
                try:
                    tail = "\n".join(
                        _run(["capture-pane", "-p", "-t", (agent_pane or active).id]).rstrip().splitlines()[-12:]
                    )
                except TmuxError:
                    tail = ""
            window.status = detect_status(window, tail)
    return result


_cache_lock = threading.Lock()
_cache: tuple[float, list[Window]] = (0.0, [])


def cached_windows(max_age: float = 1.5) -> list[Window]:
    """여러 탭/클라이언트가 동시에 폴링해도 tmux 를 한 번만 조회한다."""
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
    if not isinstance(pane_id, str) or not PANE_ID.match(pane_id) or pane_id not in _pane_ids():
        raise KeyError("존재하지 않는 pane 입니다.")
    return pane_id


def require_window(window_id: str) -> str:
    if not isinstance(window_id, str) or not WINDOW_ID.match(window_id) or window_id not in _window_ids():
        raise KeyError("존재하지 않는 창입니다.")
    return window_id


def capture(pane_id: str, history: int = 300) -> dict:
    """pane 화면 + 스크롤백을 ANSI 색상 그대로 가져온다 (HTML 변환은 브라우저가 한다)."""
    history = max(0, min(int(history), MAX_HISTORY))
    content = _run(["capture-pane", "-p", "-e", "-t", pane_id, "-S", f"-{history}"])
    info = _run(
        [
            "display-message", "-p", "-t", pane_id,
            SEP.join(["#{cursor_x}", "#{cursor_y}", "#{cursor_flag}", "#{pane_width}", "#{pane_height}", "#{alternate_on}", "#{pane_in_mode}"]),
        ]
    ).strip().split(SEP)
    cx, cy, cflag, width, height, alternate, in_mode = (info + ["0"] * 7)[:7]
    return {
        "pane": pane_id,
        # 줄 수 = 스크롤백 + 화면 높이 그대로 유지해야 커서 위치를 계산할 수 있다.
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
    raise ValueError("허용되지 않은 키입니다.")


def send_keys(pane_id: str, keys: list[str]) -> None:
    keys = [validate_key(k) for k in keys][:32]
    if keys:
        _run(["send-keys", "-t", pane_id, *keys])


def send_literal(pane_id: str, text: str) -> None:
    """직접 입력 모드: 한 글자/짧은 문자열을 그대로 보낸다 (키 이름으로 해석하지 않음)."""
    if not text:
        return
    if len(text) > 4096:
        raise ValueError("입력이 너무 깁니다.")
    _run(["send-keys", "-t", pane_id, "-l", "--", text])


def _paste(pane_id: str, text: str) -> None:
    buffer = f"univdash-{secrets.token_hex(6)}"
    _run(["load-buffer", "-b", buffer, "-"], input_text=text)
    _run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane_id])


def send_prompt(pane_id: str, text: str, submit: bool = True, attachments: list[str] | tuple = ()) -> None:
    """프롬프트 전송.

    여러 줄은 bracketed paste 로 붙여넣어 Claude Code / Codex 가 줄바꿈마다 제출하지 않게 하고,
    붙여넣기 직후 바로 Enter 를 보내면 붙여넣기 일부로 처리되는 경우가 있어 잠깐 기다린다.

    첨부 파일은 경로 하나씩 따로 붙여넣는다. 터미널에 파일을 끌어다 놓을 때와 같은 방식이라
    Claude Code / Codex 가 이미지 경로를 이미지 첨부([Image #1])로 인식한다.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > MAX_TEXT:
        raise ValueError(f"프롬프트는 {MAX_TEXT}자 이하로 보내주세요.")
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


def create_session(name: str, path: str, command: str) -> str:
    if not SESSION_NAME.match(name or ""):
        raise ValueError("세션 이름은 글자, 숫자, -, _ 로 50자 이하여야 합니다.")
    directory = Path(os.path.expanduser(path or "~")).resolve()
    if not directory.is_dir():
        raise ValueError("작업 폴더가 존재하지 않습니다.")
    existing = set(_run(["list-sessions", "-F", "#{session_name}"]).split("\n"))
    if name in existing:
        raise ValueError("같은 이름의 세션이 이미 있습니다.")
    command = (command or "").strip()
    if len(command) > 500 or "\n" in command:
        raise ValueError("시작 명령이 올바르지 않습니다.")
    pane_id = _run(
        ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", str(directory)]
    ).strip()
    if command and PANE_ID.match(pane_id):
        time.sleep(0.3)  # 셸이 뜨기 전에 입력하면 프롬프트 초기화 중에 먹힐 수 있다.
        _run(["send-keys", "-t", pane_id, "-l", "--", command])
        _run(["send-keys", "-t", pane_id, "Enter"])
    invalidate_cache()
    return pane_id


def rename_session(session_id: str, name: str) -> tuple[str, str]:
    """tmux 세션 이름을 바꾼다. (이전 이름, 새 이름)"""
    if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        raise KeyError("존재하지 않는 세션입니다.")
    name = (name or "").strip()
    if not SESSION_NAME.match(name):
        raise ValueError("세션 이름은 글자 · 숫자 · - · _ 로 50자 이하여야 합니다 (첫 글자는 - 불가, 공백 · : · . 불가).")
    rows = [line.split(SEP) for line in _run(["list-sessions", "-F", f"#{{session_id}}{SEP}#{{session_name}}"]).splitlines()]
    names = {row[0]: row[1] for row in rows if len(row) == 2}
    if session_id not in names:
        raise KeyError("존재하지 않는 세션입니다.")
    old = names[session_id]
    if name != old and name in names.values():
        raise ValueError("같은 이름의 세션이 이미 있습니다.")
    if name != old:
        _run(["rename-session", "-t", session_id, name])
        invalidate_cache()
    return old, name


def kill_window(window_id: str) -> None:
    _run(["kill-window", "-t", window_id])
    invalidate_cache()


def select_pane(pane_id: str) -> None:
    _run(["select-pane", "-t", pane_id])
