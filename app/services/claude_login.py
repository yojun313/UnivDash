"""AI 사용량 페이지에서 Claude Code 다시 로그인.

공식 `claude auth login` 을 그대로 돌린다: 링크를 화면에 보여 주고, 브라우저 로그인 뒤 받은 코드를
입력받아 그 명령에 넘긴다. 로그인 정보는 Claude Code 가 직접, 로그인이 성공했을 때만 바꾼다
— 취소 · 시간 초과 · 틀린 코드로는 지금 로그인이 그대로다. 토큰과 코드는 기록하지 않는다.
"""

import fcntl
import os
import pty
import re
import secrets
import signal
import struct
import subprocess
import termios
import threading
import time

from app.paths import find_command
from app.services.ai_usage_service import AIUsageService

LOGIN_TIMEOUT = 15 * 60
START_TIMEOUT = 20
_ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]")
_URL = re.compile(
    r"https://(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)/[\w/.\-?=&%+~#:]+"
)
_FAILED = re.compile(r"Login failed")
# 코드는 "코드#state" 꼴: 터미널 조작 문자가 끼어들 수 없게 글자를 제한한다
CODE_PATTERN = r"^[A-Za-z0-9_\-.~#+/=%]{8,2048}$"
_CODE = re.compile(CODE_PATTERN)


class LoginError(RuntimeError):
    """사용자에게 그대로 보여 줄 수 있는 오류."""


class _Login:
    def __init__(self) -> None:
        self.id = secrets.token_hex(8)
        self.state = (
            "starting"  # starting → waiting → verifying → done | error | cancelled
        )
        self.url: str | None = None
        self.email: str | None = None
        self.error: str | None = None
        self.started = time.monotonic()
        self.proc: subprocess.Popen | None = None
        self.master: int | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "url": self.url,
            "email": self.email,
            "error": self.error,
            "expires_in": max(
                0, int(LOGIN_TIMEOUT - (time.monotonic() - self.started))
            ),
        }


_logins: dict[str, _Login] = {}
_lock = threading.Lock()


def _child_env() -> dict[str, str]:
    from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

    env = _env()
    # 다른 로그인 수단이 끼어들지 않게, 서버 쪽에서 브라우저를 열지 않게
    for key in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "DISPLAY",
        "WAYLAND_DISPLAY",
    ):
        env.pop(key, None)
    env["BROWSER"] = "/bin/true"
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    if os.environ.get("CLAUDE_DATA_DIR"):
        env["CLAUDE_CONFIG_DIR"] = os.environ["CLAUDE_DATA_DIR"]
    return env


def _stop(login: _Login, reason: str) -> None:
    if login.state in {"done", "error", "cancelled"}:
        return
    login.state = "cancelled" if reason == "cancel" else "error"
    if reason == "timeout":
        login.error = "시간이 지나 로그인이 취소됐어요. 다시 시도해 주세요."
    proc = login.proc
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def _invalidate_usage_cache() -> None:
    AIUsageService._limits_cache = None
    AIUsageService._claude_usage_cache = None
    AIUsageService._claude_rejected_token = None
    with AIUsageService._cache_lock:
        AIUsageService._cache.clear()


def _run(login: _Login, command: str) -> None:
    master, slave = pty.openpty()
    login.master = master
    timer = threading.Timer(LOGIN_TIMEOUT, lambda: _stop(login, "timeout"))
    timer.daemon = True
    try:
        # 긴 링크가 줄바꿈으로 잘리지 않게 아주 넓은 터미널로
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO  # 입력한 코드가 출력으로 되돌아오지 않게
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        login.proc = subprocess.Popen(
            [command, "auth", "login"],
            env=_child_env(),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        slave = -1
        timer.start()
        buffer = ""
        failed = False
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError:  # 자식이 끝나면 EIO
                break
            if not chunk:
                break
            buffer = (buffer + _ANSI.sub("", chunk.decode("utf-8", "replace")))[-16384:]
            # 링크가 다 들어올 때까지(프롬프트가 뜰 때까지) 기다린다
            match = _URL.search(buffer) if not login.url else None
            if match and "Paste code" in buffer[match.end() :]:
                login.url = match.group(0)
                if login.state == "starting":
                    login.state = "waiting"
            failed = failed or bool(_FAILED.search(buffer))
        code = login.proc.wait()
        if login.state in {"cancelled", "error"}:
            return
        if code == 0 and not failed:
            _invalidate_usage_cache()
            login.email = AIUsageService.accounts().get("claude")
            login.state = "done"
        else:
            login.state = "error"
            login.error = (
                "코드가 맞지 않거나 만료됐어요. 지금 로그인은 그대로예요. 다시 시도해 주세요."
                if failed
                else "로그인이 끝나지 않았어요. 지금 로그인은 그대로예요. 다시 시도해 주세요."
            )
    except Exception:  # noqa: BLE001 — 스레드 안: 상태로 알린다 (비밀값이 섞이지 않게 내용은 빼고)
        login.state = "error"
        login.error = "로그인을 진행하지 못했어요. 다시 시도해 주세요."
    finally:
        timer.cancel()
        login.master = None
        for fd in (master, slave):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass


def start_login() -> dict:
    command = find_command("claude")
    if not command:
        raise LoginError("claude 명령을 찾지 못했어요.")
    with _lock:
        for other in list(_logins.values()):  # 한 번에 하나만
            _stop(other, "cancel")
        _logins.clear()
        login = _Login()
        _logins[login.id] = login
    threading.Thread(target=_run, args=(login, command), daemon=True).start()
    deadline = time.monotonic() + START_TIMEOUT
    while login.state == "starting" and time.monotonic() < deadline:
        time.sleep(0.1)
    if login.state == "starting":
        _stop(login, "cancel")
        raise LoginError("로그인 링크를 받지 못했어요. 잠시 뒤 다시 시도해 주세요.")
    return login.public()


def status(login_id: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError("로그인 요청을 찾지 못했어요.")
    return login.public()


def submit_code(login_id: str, code: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError("로그인 요청을 찾지 못했어요.")
    code = code.strip()
    if not _CODE.match(code):
        raise LoginError(
            "코드 형식이 올바르지 않아요. 복사한 코드를 그대로 붙여 넣어 주세요."
        )
    with _lock:
        if login.state != "waiting" or login.master is None:
            raise LoginError("지금은 코드를 받을 수 없어요. 다시 시도해 주세요.")
        login.state = "verifying"
        os.write(login.master, code.encode() + b"\r")
    return login.public()


def cancel(login_id: str) -> None:
    login = _logins.get(login_id)
    if login:
        _stop(login, "cancel")
