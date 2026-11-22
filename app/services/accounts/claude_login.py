"""Claude Code re-login and add-account from the AI usage page.

Runs the official `claude auth login` as is: the link is shown on screen, and the code received after the
browser login is taken from the user and passed to that command. The login data is changed by Claude Code
itself, and only when the login succeeds — cancelling, timing out or a wrong code leaves the current login
untouched. Tokens and codes are never logged.

Adding an account runs the same command in a temporary config folder (CLAUDE_CONFIG_DIR), saves only the
result to the account list and deletes the folder — the current login file is not even opened.
"""

import fcntl
import logging
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
from pathlib import Path

from app.i18n import _
from app.paths import find_command
from app.services.accounts import claude_accounts
from app.services.accounts.ai_usage_service import AIUsageService

logger = logging.getLogger(__name__)

LOGIN_TIMEOUT = 15 * 60
START_TIMEOUT = 20
_ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]")
_URL = re.compile(
    r"https://(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)/[\w/.\-?=&%+~#:]+"
)
_FAILED = re.compile(r"Login failed")
# The code looks like "code#state": the character set is restricted so terminal control characters cannot slip in
CODE_PATTERN = r"^[A-Za-z0-9_\-.~#+/=%]{8,2048}$"
_CODE = re.compile(CODE_PATTERN)


class LoginError(RuntimeError):
    """An error that can be shown to the user as is."""


class _Login:
    def __init__(self, folder: Path | None = None) -> None:
        self.id = secrets.token_hex(8)
        self.folder = folder  # add account: temporary config folder · re-login: None
        self.account_id: str | None = None
        self.live = folder is None
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
            "add": self.folder is not None,
            "live": self.live,
            "expires_in": max(
                0, int(LOGIN_TIMEOUT - (time.monotonic() - self.started))
            ),
        }


_logins: dict[str, _Login] = {}
_lock = threading.Lock()


def _child_env(folder: Path | None = None) -> dict[str, str]:
    from app.services.agents.pty_service import (
        _env,  # environment without the dashboard secrets
    )

    env = _env()
    # So that no other login method interferes, and no browser is opened on the server side
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
    env.pop("CLAUDE_CONFIG_DIR", None)
    if folder is not None:
        env["CLAUDE_CONFIG_DIR"] = str(folder)
    elif os.environ.get("CLAUDE_DATA_DIR"):
        env["CLAUDE_CONFIG_DIR"] = os.environ["CLAUDE_DATA_DIR"]
    return env


def _stop(login: _Login, reason: str) -> None:
    if login.state in {"done", "error", "cancelled"}:
        return
    login.state = "cancelled" if reason == "cancel" else "error"
    if reason == "timeout":
        login.error = _("시간이 지나 로그인이 취소되었습니다. 다시 시도해 주십시오.")
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
        # A very wide terminal so the long link is not cut by line wrapping
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO  # so the typed code is not echoed back in the output
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        login.proc = subprocess.Popen(
            [command, "auth", "login"],
            env=_child_env(login.folder),
            cwd=str(login.folder) if login.folder else None,
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
            except OSError:  # EIO once the child exits
                break
            if not chunk:
                break
            buffer = (buffer + _ANSI.sub("", chunk.decode("utf-8", "replace")))[-16384:]
            # Wait until the whole link has arrived (until the prompt appears)
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
            if login.folder is not None:
                saved = claude_accounts.store_login(login.folder)
                login.email, login.account_id, login.live = (
                    saved["email"],
                    saved["id"],
                    saved["active"],
                )
            else:
                _invalidate_usage_cache()
                login.email = AIUsageService.accounts().get("claude")
                try:
                    # the new login also goes into the account list
                    claude_accounts.sync_current()
                except Exception:
                    logger.exception("Failed to save the Claude account list")
            login.state = "done"
        else:
            login.state = "error"
            login.error = (
                _(
                    "코드가 맞지 않거나 만료되었습니다. 지금 로그인은 그대로입니다. 다시 시도해 주십시오."
                )
                if failed
                else _(
                    "로그인이 끝나지 않았습니다. 지금 로그인은 그대로입니다. 다시 시도해 주십시오."
                )
            )
    except claude_accounts.AccountError as error:
        login.state = "error"
        login.error = str(error)
    except Exception:  # noqa: BLE001 — inside a thread: reported through the state (without the content, so no secret leaks)
        login.state = "error"
        login.error = _("로그인을 진행하지 못했습니다. 다시 시도해 주십시오.")
    finally:
        timer.cancel()
        if login.folder is not None:
            claude_accounts.discard(login.folder)
        login.master = None
        for fd in (master, slave):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass


def start_login(add: bool = False) -> dict:
    """add=False: redo the current login · add=True: keep the current login and add another account to the list."""
    command = find_command("claude")
    if not command:
        raise LoginError(_("claude 명령을 찾지 못했습니다."))
    with _lock:
        for other in list(_logins.values()):  # only one at a time
            _stop(other, "cancel")
        _logins.clear()
        if add:
            # temporary folders left over from before a shutdown
            claude_accounts.cleanup_pending()
        login = _Login(claude_accounts.pending_dir() if add else None)
        _logins[login.id] = login
    threading.Thread(target=_run, args=(login, command), daemon=True).start()
    deadline = time.monotonic() + START_TIMEOUT
    while login.state == "starting" and time.monotonic() < deadline:
        time.sleep(0.1)
    if login.state == "starting":
        _stop(login, "cancel")
        raise LoginError(
            _("로그인 링크를 받지 못했습니다. 잠시 뒤 다시 시도해 주십시오.")
        )
    return login.public()


def status(login_id: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError(_("로그인 요청을 찾지 못했습니다."))
    return login.public()


def submit_code(login_id: str, code: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError(_("로그인 요청을 찾지 못했습니다."))
    code = code.strip()
    if not _CODE.match(code):
        raise LoginError(
            _("코드 형식이 올바르지 않습니다. 복사한 코드를 그대로 붙여 넣어 주십시오.")
        )
    with _lock:
        if login.state != "waiting" or login.master is None:
            raise LoginError(_("지금은 코드를 받을 수 없습니다. 다시 시도해 주십시오."))
        login.state = "verifying"
        os.write(login.master, code.encode() + b"\r")
    return login.public()


def cancel(login_id: str) -> None:
    login = _logins.get(login_id)
    if login:
        _stop(login, "cancel")
