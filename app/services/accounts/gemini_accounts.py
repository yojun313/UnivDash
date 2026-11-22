"""Multiple Gemini (Antigravity CLI · agy) accounts: save · switch · delete · add by signing in.

The Antigravity CLI holds a single login (~/.gemini/antigravity-cli/antigravity-oauth-token). That file is kept
per account in the dashboard data folder (folder 700 · files 600); on a switch the original file is backed up and
then swapped atomically. Tokens never leave the server (only the email · plan go to the screen).

Adding an account runs the official login (agy → Google OAuth) as is in a temporary home folder, saves only the
result and deletes the folder — the current login file is not even opened.
"""

import fcntl
import hashlib
import json
import logging
import os
import pty
import re
import secrets
import shutil
import signal
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir, find_command
from app.services.accounts import gemini_service

logger = logging.getLogger(__name__)

KEEP_BACKUPS = 20
LOGIN_TIMEOUT = 15 * 60
START_TIMEOUT = 25
VERIFY_TIMEOUT = 60
_ID = re.compile(r"^[0-9a-f]{12}$")
_ANSI = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b[=>()][0-9A-Za-z]?"
)
_URL = re.compile(r"https://accounts\.google\.com/o/oauth2/[\w/.\-?=&%+~#:]+")
# Authorization code: the character set is restricted so terminal control characters cannot slip in
CODE_PATTERN = r"^[A-Za-z0-9_\-.~#+/=%]{8,2048}$"
_CODE = re.compile(CODE_PATTERN)

_lock = threading.RLock()


class AccountError(RuntimeError):
    """An error that can be shown to the user as is."""


def live_file() -> Path:
    return gemini_service.token_path()


def _store() -> Path:
    root = data_dir() / "gemini-accounts"
    for path in (root, root / "backups", root / "pending"):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o700)
    return root


def _write_secret(path: Path, text: str) -> None:
    """Write to a temporary file with mode 600, then swap it in atomically (the original file survives an interrupted write)."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _token_of(auth: dict | None) -> dict | None:
    """Token file content → the shape gemini_service uses ({"access", "refresh", "expires"})."""
    token = auth.get("token") if isinstance(auth, dict) else None
    if not isinstance(token, dict) or not isinstance(token.get("access_token"), str):
        return None
    expires = 0.0
    raw = token.get("expiry")
    if isinstance(raw, str) and raw:
        from datetime import datetime

        try:
            expires = datetime.fromisoformat(raw).timestamp()
        except ValueError:
            expires = 0.0
    refresh = token.get("refresh_token")
    return {
        "access": token["access_token"],
        "refresh": refresh if isinstance(refresh, str) else "",
        "expires": expires,
    }


def _account_id(auth: dict, email: str | None) -> str:
    """Accounts are told apart by email when it is known, otherwise by the refresh token."""
    if email:
        return hashlib.sha256(f"gemini:{email.lower()}".encode()).hexdigest()[:12]
    return gemini_service.account_key(_token_of(auth))[:12]


def _profile_path(account_id: str) -> Path:
    if not _ID.match(account_id or ""):
        raise KeyError(_("없는 계정입니다."))
    return _store() / f"{account_id}.json"


def _save_profile(auth: dict, fetch: bool = True) -> str | None:
    token = _token_of(auth)
    if token is None:
        return None
    info = gemini_service.profile(token, fetch=fetch)
    account_id = _account_id(auth, info["email"])
    if not _ID.match(account_id):
        return None
    path = _profile_path(account_id)
    current = _read_json(path)
    if current and current.get("auth") == auth:
        return account_id  # nothing changed, so nothing is written
    record = {
        "email": info["email"] or (current or {}).get("email"),
        "plan": info["plan"] or (current or {}).get("plan"),
        "saved_at": time.time(),
        "auth": auth,
    }
    _write_secret(path, json.dumps(record, ensure_ascii=False))
    return account_id


def sync_current() -> str | None:
    """Save/update the current login (token file) in the account list. Returns the current account id (None if there is none)."""
    with _lock:
        auth = _read_json(live_file())
        return _save_profile(auth) if auth else None


def _invalidate_usage_cache() -> None:
    from app.services.accounts.ai_usage_service import AIUsageService

    gemini_service.forget_limits()
    AIUsageService._limits_cache = None
    with AIUsageService._cache_lock:
        AIUsageService._cache.clear()


def list_accounts() -> dict:
    with _lock:
        active = sync_current()
        accounts = []
        for path in sorted(_store().glob("*.json")):
            record = _read_json(path)
            if not record or not _ID.match(path.stem):
                continue
            accounts.append(
                {
                    "id": path.stem,
                    "email": record.get("email"),
                    "plan": record.get("plan"),
                    "saved_at": record.get("saved_at"),
                    "active": path.stem == active,
                }
            )
        accounts.sort(key=lambda a: (not a["active"], (a["email"] or "").lower()))
        return {"accounts": accounts, "active": active}


# ── Tokens of saved accounts (they last one hour, so they are refreshed on use) ────


def _cli_env(home: Path) -> dict[str, str]:
    from app.services.agents.pty_service import (
        _env,  # environment without the dashboard secrets
    )

    env = _env()
    for key in ("DISPLAY", "WAYLAND_DISPLAY"):
        env.pop(key, None)
    env.update({"HOME": str(home), "BROWSER": "/bin/true", "NO_COLOR": "1"})
    return env


def _pending_home() -> Path:
    home = _store() / "pending" / secrets.token_hex(8)
    (home / ".gemini" / "antigravity-cli").mkdir(mode=0o700, parents=True)
    os.chmod(home, 0o700)
    return home


def _discard(home: Path) -> None:
    pending = _store() / "pending"
    if home.parent == pending:
        shutil.rmtree(home, ignore_errors=True)


def cleanup_pending() -> None:
    for folder in (_store() / "pending").iterdir():
        shutil.rmtree(folder, ignore_errors=True)


def _refresh_saved(account_id: str, record: dict) -> dict | None:
    """Expired token of a saved account: put only the token in a temporary home and run `agy models` so the CLI refreshes it."""
    binary = find_command("agy")
    if not binary:
        return None
    home = _pending_home()
    try:
        target = home / ".gemini" / "antigravity-cli" / gemini_service.TOKEN_FILE
        _write_secret(target, json.dumps(record["auth"], ensure_ascii=False))
        try:
            subprocess.run(
                [binary, "models"],
                env=_cli_env(home),
                cwd=str(home),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=40,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        fresh = _read_json(target)
        token = _token_of(fresh)
        if not fresh or token is None or token["expires"] - time.time() < 60:
            return None
        with _lock:
            path = _profile_path(account_id)
            current = _read_json(path)
            if current and current.get("auth") == record["auth"]:
                current["auth"] = fresh
                _write_secret(path, json.dumps(current, ensure_ascii=False))
        return fresh
    finally:
        _discard(home)


def account_token(account_id: str, allow_refresh: bool = True) -> dict | None:
    """A usable token for that account ({"access", "expires", …}). None if there is none or it could not be refreshed."""
    with _lock:
        active = sync_current()
    if account_id == active:
        return gemini_service.fresh_token(refresh=allow_refresh)
    record = _read_json(_profile_path(account_id))
    if not record or not isinstance(record.get("auth"), dict):
        return None
    token = _token_of(record["auth"])
    if token and token["expires"] - time.time() > 120:
        return token
    if not allow_refresh:
        return None
    return _token_of(_refresh_saved(account_id, record))


def saved_limits(now) -> list[dict]:
    """Remaining limits of the accounts that are not signed in now (for the account list screen)."""
    listing = list_accounts()
    out = []
    for account in listing["accounts"]:
        if account["active"]:
            continue
        try:
            token = account_token(account["id"])
            limits = gemini_service.limits(now, token=token) if token else None
        except Exception:
            logger.debug(
                "Failed to read limits of a saved Gemini account", exc_info=True
            )
            limits = None
        out.append({**account, "limits": limits, "login_expired": token is None})
    return out


# ── Switch · delete ───────────────────────────────────────────────────────────


def _install_live(auth: dict) -> None:
    """(inside _lock) Back up the original token file and replace it atomically."""
    live = live_file()
    if live.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = _store() / "backups" / f"token-{stamp}-{secrets.token_hex(2)}.json"
        _write_secret(backup, live.read_text(encoding="utf-8"))
        for old in sorted((_store() / "backups").glob("token-*.json"))[:-KEEP_BACKUPS]:
            old.unlink(missing_ok=True)
    live.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _write_secret(live, json.dumps(auth, indent=2, ensure_ascii=False))
    _invalidate_usage_cache()


def _restart_windows() -> dict:
    """Running Gemini windows still hold the old account → restart the idle windows on the same conversation."""
    from app.services.agents import agent_update_all

    report: dict = {"restarted": [], "skipped": []}
    try:
        agent_update_all._restart_idle("gemini", report)
    except Exception:
        logger.exception("Failed to restart Gemini windows")
    return report


def switch(account_id: str) -> dict:
    with _lock:
        path = _profile_path(account_id)
        record = _read_json(path)
        if not record or not isinstance(record.get("auth"), dict):
            raise KeyError(_("없는 계정입니다."))
        active = sync_current()  # save the current account's latest token first
        if active == account_id:
            return {"email": record.get("email"), "changed": False}
        if _token_of(record["auth"]) is None:
            raise AccountError(
                _(
                    "저장된 로그인 정보가 올바르지 않습니다. 계정을 다시 추가해 주십시오."
                )
            )
        _install_live(record["auth"])
    return {
        "email": record.get("email"),
        "changed": True,
        "windows": _restart_windows(),
    }


def remove(account_id: str) -> None:
    with _lock:
        path = _profile_path(account_id)
        if account_id == sync_current():
            raise AccountError(
                _(
                    "지금 사용 중인 계정은 삭제할 수 없습니다. 다른 계정으로 바꾼 뒤 삭제해 주십시오."
                )
            )
        if not path.exists():
            raise KeyError(_("없는 계정입니다."))
        path.unlink()


# ── Add account: official login in a temporary home (link → browser → authorization code) ──


class _Login:
    def __init__(self) -> None:
        self.id = secrets.token_hex(8)
        self.home = _pending_home()
        self.state = (
            "starting"  # starting → waiting → verifying → done | error | cancelled
        )
        self.url: str | None = None
        self.email: str | None = None
        # whether the current login (token file) was switched to the new account too
        self.live = False
        self.error: str | None = None
        self.started = time.monotonic()
        self.submitted: float | None = None
        self.proc: subprocess.Popen | None = None
        self.master: int | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "url": self.url,
            "email": self.email,
            "error": self.error,
            "add": True,
            "live": self.live,
            "expires_in": max(
                0, int(LOGIN_TIMEOUT - (time.monotonic() - self.started))
            ),
        }


_logins: dict[str, _Login] = {}


def _kill(login: _Login) -> None:
    proc = login.proc
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def _stop(login: _Login, reason: str) -> None:
    if login.state in {"done", "error", "cancelled"}:
        return
    login.state = "cancelled" if reason == "cancel" else "error"
    if reason == "timeout":
        login.error = _("시간이 지나 로그인이 취소되었습니다. 다시 시도해 주십시오.")
    _kill(login)


def _store_login(login: _Login) -> bool:
    """Save the token created in the temporary home to the account list. True if saved."""
    target = login.home / ".gemini" / "antigravity-cli" / gemini_service.TOKEN_FILE
    auth = _read_json(target)
    if not auth or _token_of(auth) is None:
        return False
    with _lock:
        account_id = _save_profile(auth)
        if account_id is None:
            return False
        record = _read_json(_profile_path(account_id)) or {}
        login.email = record.get("email")
        # If there is no current login or it is the same account, the token file is replaced too (a different account is only added to the list)
        current = _read_json(live_file())
        current_id = _save_profile(current, fetch=False) if current else None
        if current_id in {None, account_id}:
            _install_live(auth)
            login.live = True
        else:
            _invalidate_usage_cache()
    return True


def _run(login: _Login, command: str) -> None:
    master, slave = pty.openpty()
    login.master = master
    timer = threading.Timer(LOGIN_TIMEOUT, lambda: _stop(login, "timeout"))
    timer.daemon = True
    token_file = login.home / ".gemini" / "antigravity-cli" / gemini_service.TOKEN_FILE
    try:
        # A very wide terminal so the long link is not cut by line wrapping
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))
        env = _cli_env(login.home)
        env.pop("NO_COLOR", None)
        env["TERM"] = "xterm-256color"
        work = login.home / "work"
        work.mkdir(mode=0o700, exist_ok=True)
        login.proc = subprocess.Popen(
            [command],
            env=env,
            cwd=str(work),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        slave = -1
        timer.start()
        buffer = ""
        chosen = False
        os.set_blocking(master, False)
        while login.proc.poll() is None:
            if login.state in {"cancelled", "error"}:
                return
            try:
                chunk = os.read(master, 65536)
            except BlockingIOError:
                chunk = b""
                time.sleep(0.15)
            except OSError:  # EIO once the child exits
                break
            if chunk:
                text = _ANSI.sub("", chunk.decode("utf-8", "replace"))
                buffer = (buffer + text)[-32768:]
            if (
                not chosen
                and "Select login method" in buffer
                and "Google OAuth" in buffer
            ):
                chosen = True
                time.sleep(0.3)
                os.write(master, b"\r")  # the first item, "Google OAuth"
            if login.url is None:
                match = _URL.search(buffer)
                if match and "authorization code" in buffer[match.end() :].lower():
                    login.url = match.group(0)
                    login.state = "waiting"
            if login.state == "verifying":
                if token_file.is_file() and _store_login(login):
                    login.state = "done"
                    return
                if (
                    login.submitted is not None
                    and time.monotonic() - login.submitted > VERIFY_TIMEOUT
                ):
                    login.state = "error"
                    login.error = _(
                        "코드가 맞지 않거나 만료되었습니다. 지금 로그인은 그대로입니다. 다시 시도해 주십시오."
                    )
                    return
        if login.state not in {"done", "cancelled", "error"}:
            if token_file.is_file() and _store_login(login):
                login.state = "done"
            else:
                login.state = "error"
                login.error = _(
                    "로그인이 끝나지 않았습니다. 지금 로그인은 그대로입니다. 다시 시도해 주십시오."
                )
    except AccountError as error:
        login.state = "error"
        login.error = str(error)
    except Exception:
        logger.debug("Gemini login failed", exc_info=True)
        login.state = "error"
        login.error = _("로그인을 진행하지 못했습니다. 다시 시도해 주십시오.")
    finally:
        timer.cancel()
        _kill(login)
        _discard(login.home)
        login.master = None
        for fd in (master, slave):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass


def start_login() -> dict:
    """Keep the current login and add another Google account to the list (if there is no login, that account becomes signed in)."""
    command = find_command("agy")
    if not command:
        raise AccountError(_("agy 명령을 찾지 못했습니다."))
    with _lock:
        for other in list(_logins.values()):  # only one at a time
            _stop(other, "cancel")
        _logins.clear()
        cleanup_pending()
        login = _Login()
        _logins[login.id] = login
    threading.Thread(target=_run, args=(login, command), daemon=True).start()
    deadline = time.monotonic() + START_TIMEOUT
    while login.state == "starting" and time.monotonic() < deadline:
        time.sleep(0.1)
    if login.state == "starting":
        _stop(login, "cancel")
        raise AccountError(
            _("로그인 링크를 받지 못했습니다. 잠시 뒤 다시 시도해 주십시오.")
        )
    return login.public()


def login_status(login_id: str) -> dict:
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
        raise AccountError(
            _("코드 형식이 올바르지 않습니다. 복사한 코드를 그대로 붙여 넣어 주십시오.")
        )
    with _lock:
        if login.state != "waiting" or login.master is None:
            raise AccountError(
                _("지금은 코드를 받을 수 없습니다. 다시 시도해 주십시오.")
            )
        login.submitted = time.monotonic()
        login.state = "verifying"
        os.write(login.master, code.encode() + b"\r")
    return login.public()


def cancel_login(login_id: str) -> None:
    login = _logins.get(login_id)
    if login:
        _stop(login, "cancel")


# ── Sign out: removes the current login and the stored data of that account ─────────────


def logout() -> dict:
    """Delete the Antigravity CLI token file (= CLI sign-out), and delete that account's login data · backups saved in the dashboard.

    The Antigravity CLI has no logout command (only /logout inside its screen), so the token file is deleted directly.
    """
    with _lock:
        live = live_file()
        auth = _read_json(live)
        if not auth:
            raise AccountError(_("로그인된 계정이 없습니다."))
        active = _save_profile(auth, fetch=False)
        email = (
            (_read_json(_profile_path(active)) or {}).get("email") if active else None
        )
        live.unlink(missing_ok=True)
        if active:
            _profile_path(active).unlink(missing_ok=True)
        for old in (_store() / "backups").glob("*.json"):
            old.unlink(missing_ok=True)
        # The recorded email · plan are deleted too
        key = gemini_service.account_key(_token_of(auth))
        gemini_service.forget_profile(key)
        _invalidate_usage_cache()
    return {"email": email}
