"""Multiple Codex accounts: save · switch · add (device-auth login).

- The Codex login is the single file ~/.codex/auth.json. A copy of that file per account is kept in the dashboard
  data folder (codex-accounts/, folder 700 · files 600).
- Switch: the current auth.json is first saved as that account's copy (so a token refreshed in the meantime is not
  lost), the original file is kept in backups/ by timestamp, then the chosen account's copy is swapped in as
  auth.json atomically. Codex (including the shared daemon) re-reads auth.json before refreshing a token, so newly
  opened sessions use the new account.
- Add: `codex login --device-auth` runs in a temporary CODEX_HOME, the link · one-time code are shown on screen,
  and when the login finishes that auth.json is saved as an account. The current login is not touched.
- Only the email · plan · save time are sent to the browser. Tokens are never sent out.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir, find_command
from app.services.accounts.ai_usage_service import AIUsageService

LOGIN_TIMEOUT = 15 * 60  # how long the device code is valid
KEEP_BACKUPS = 20
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_URL = re.compile(r"https://auth\.openai\.com/[\w/.\-?=&%]+")
_CODE = re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b")
_ID = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.RLock()


class AccountError(RuntimeError):
    pass


# ── Files ─────────────────────────────────────────────────────────────────────


def codex_home() -> Path:
    return AIUsageService._data_root("CODEX_DATA_DIR", ".codex")


def live_file() -> Path:
    return codex_home() / "auth.json"


def _store() -> Path:
    root = data_dir() / "codex-accounts"
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
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _claims(auth: dict) -> dict:
    token = (
        (auth.get("tokens") or {}).get("id_token") if isinstance(auth, dict) else None
    )
    if not isinstance(token, str) or token.count(".") != 2:
        return {}
    payload = token.split(".")[1]
    try:
        claims = json.loads(
            base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        )
    except (ValueError, TypeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _info(auth: dict) -> dict | None:
    """auth.json content → {email, plan} (None unless it is a ChatGPT login)."""
    claims = _claims(auth)
    email = AIUsageService._clean_email(claims.get("email"))
    if not email:
        return None
    extra = claims.get("https://api.openai.com/auth")
    plan = extra.get("chatgpt_plan_type") if isinstance(extra, dict) else None
    return {"email": email, "plan": plan if isinstance(plan, str) else None}


def _account_id(email: str) -> str:
    return hashlib.sha256(email.lower().encode()).hexdigest()[:12]


def _profile_path(account_id: str) -> Path:
    if not _ID.match(account_id or ""):
        raise KeyError(_("없는 계정입니다."))
    return _store() / f"{account_id}.json"


def _save_profile(auth: dict, info: dict) -> str:
    account_id = _account_id(info["email"])
    path = _profile_path(account_id)
    current = _read_json(path)
    if current and current.get("auth") == auth:
        return account_id  # nothing changed, so nothing is written
    record = {
        "email": info["email"],
        "plan": info["plan"],
        "saved_at": time.time(),
        "auth": auth,
    }
    _write_secret(path, json.dumps(record, ensure_ascii=False))
    return account_id


def sync_current() -> str | None:
    """Save/update the current login (auth.json) in the account list. Returns the current account id (None if there is none)."""
    with _lock:
        auth = _read_json(live_file())
        info = _info(auth) if auth else None
        return _save_profile(auth, info) if info else None


def _invalidate_usage_cache() -> None:
    AIUsageService._limits_cache = None
    with AIUsageService._cache_lock:
        AIUsageService._cache.clear()
        AIUsageService._codex_live_cache.clear()


def refresh_saved_auth(account_id: str, previous: dict, current: dict) -> None:
    """Save a token that was refreshed during a usage query. Not overwritten if the account changed in the meantime."""
    with _lock:
        path = _profile_path(account_id)
        record = _read_json(path)
        if not record or record.get("auth") != previous or account_id == sync_current():
            return
        previous_info, current_info = _info(previous), _info(current)
        if (
            not previous_info
            or not current_info
            or previous_info["email"] != current_info["email"]
        ):
            return
        record["auth"] = current
        _write_secret(path, json.dumps(record, ensure_ascii=False))


# ── List · switch · delete ────────────────────────────────────────────────────


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


def _restart_daemon() -> bool | None:
    """Restart the shared Codex daemon (app-server) — so it starts up reading the new account's login file.

    Only when the default Codex folder (~/.codex) is used. In tests · a separate folder the real daemon is not touched (None).
    """
    if codex_home().resolve() != (Path.home() / ".codex").resolve():
        return None
    try:
        result = subprocess.run(
            [_codex_bin(), "app-server", "daemon", "restart"],
            env=_child_env(codex_home()),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=40,
            check=False,
        )
    except (OSError, subprocess.SubprocessError, AccountError):
        return False
    return result.returncode == 0


# ── Apply the new account to every Codex window (automatic) ──────────────────────
# Restarting the shared daemon cuts off conversations that are working, so it is done in one go while every
# Codex window is idle:
#   stop every Codex window → codex update → re-check the login file is the chosen account → restart the daemon
#   → restart on the same conversation
# Give up if no moment with everything idle comes within this time (can be applied again from the settings screen)
APPLY_WAIT = 12 * 3600
APPLY_POLL = 3.0
UPDATE_TIMEOUT = 300
_apply_lock = threading.Lock()
_apply: dict = {
    "state": "idle",
    "target": None,
    "update": True,
    "waiting": [],
    "since": 0.0,
    "result": None,
    "error": None,
    "seq": 0,
}


def _update_codex() -> bool | None:
    """Update codex to the latest (only with the default Codex folder — in tests · a separate folder the real install is not touched)."""
    if codex_home().resolve() != (Path.home() / ".codex").resolve():
        return None
    try:
        result = subprocess.run(
            [_codex_bin(), "update"],
            env=_child_env(codex_home()),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=UPDATE_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError, AccountError):
        return False
    return result.returncode == 0


def _ensure_live(target: str | None) -> None:
    """If a Codex on the old account reverted auth.json while refreshing its token during the wait, swap the chosen account in again."""
    if not target:
        return
    with _lock:
        live = _read_json(live_file())
        info = _info(live) if live else None
        if info and _account_id(info["email"]) == target:
            return
        if info:
            # the latest token of the reverted old account is saved to that account
            _save_profile(live, info)
        record = _read_json(_profile_path(target))
        if record and isinstance(record.get("auth"), dict):
            _write_secret(
                live_file(), json.dumps(record["auth"], indent=2, ensure_ascii=False)
            )
            _invalidate_usage_cache()


def _after_stop(target: str | None, update: bool = True) -> dict:
    updated = _update_codex() if update else None
    _ensure_live(target)
    return {"updated": updated, "daemon": _restart_daemon()}


def _apply_worker(seq: int) -> None:
    from app.services.agents import agent_restart, tmux_service

    deadline = time.monotonic() + APPLY_WAIT
    while time.monotonic() < deadline:
        with _apply_lock:
            if _apply["seq"] != seq:
                return  # a more recently scheduled apply took over
            target = _apply["target"]
            update = _apply["update"]
        tmux_service.invalidate_cache()
        busy = [w.key for w, _pane in agent_restart.codex_panes() if w.status == "busy"]
        with _apply_lock:
            _apply["waiting"] = busy
            _apply["state"] = "waiting" if busy else "applying"
        if not busy:
            try:
                result = agent_restart.relaunch_codex(
                    after_stop=lambda target=target, update=update: _after_stop(
                        target, update
                    )
                )
            except ValueError:
                # work started in the meantime → wait again
                time.sleep(APPLY_POLL)
                continue
            except Exception as error:  # noqa: BLE001 — reported through the state
                with _apply_lock:
                    if _apply["seq"] == seq:
                        _apply.update(
                            state="error",
                            error=str(error) or _("적용하지 못했습니다."),
                            waiting=[],
                        )
                return
            with _apply_lock:
                if _apply["seq"] == seq:
                    _apply.update(state="done", result=result, waiting=[], error=None)
            return
        time.sleep(APPLY_POLL)
    with _apply_lock:
        if _apply["seq"] == seq:
            _apply.update(
                state="error",
                error=_(
                    "Codex 작업이 끝나지 않아 적용하지 못했습니다. 나중에 '모든 Codex 창에 적용'을 눌러 주십시오."
                ),
            )


def schedule_apply(target: str | None = None, update: bool = True) -> dict:
    """As soon as every Codex window is idle (right away if they already are), update and restart on the new account. Runs in the background.

    With update=False Codex is not updated (for an automatic switch while nobody is around).
    """
    with _apply_lock:
        _apply["seq"] += 1
        _apply.update(
            state="waiting",
            target=target,
            update=update,
            waiting=[],
            since=time.time(),
            result=None,
            error=None,
        )
        seq = _apply["seq"]
    threading.Thread(
        target=_apply_worker, args=(seq,), daemon=True, name="codex-apply"
    ).start()
    time.sleep(
        0.3
    )  # so the response carries the first check of whether it can start right away
    return apply_status()


def apply_status() -> dict:
    with _apply_lock:
        return {
            "state": _apply["state"],
            "waiting": list(_apply["waiting"]),
            "since": _apply["since"],
            "result": _apply["result"],
            "error": _apply["error"],
            "seq": _apply["seq"],
        }


def apply_to_sessions() -> dict:
    """Apply the current login to every Codex window (including the update; if a window is working, automatically after it finishes)."""
    return schedule_apply(sync_current())


def _install_live(auth: dict) -> None:
    """(inside _lock) Back up the original file and replace auth.json atomically."""
    live = live_file()
    if live.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = _store() / "backups" / f"auth-{stamp}-{secrets.token_hex(2)}.json"
        _write_secret(backup, live.read_text(encoding="utf-8"))
        olds = sorted((_store() / "backups").glob("auth-*.json"))
        for old in olds[:-KEEP_BACKUPS]:
            old.unlink(missing_ok=True)
    live.parent.mkdir(parents=True, exist_ok=True)
    _write_secret(live, json.dumps(auth, indent=2, ensure_ascii=False))
    _invalidate_usage_cache()


def _store_login(auth: dict, info: dict) -> bool:
    """Save a login result. If it is the account in use (or there is no login), auth.json also gets the new token.

    Only the same account's token changes, so running Codex windows are left alone. A different account is only added to the list.
    """
    with _lock:
        _save_profile(auth, info)
        current = _read_json(live_file())
        current_info = _info(current) if current else None
        if current_info and current_info["email"] != info["email"]:
            return False
        _install_live(auth)
        return True


def switch(account_id: str, update: bool = True) -> dict:
    with _lock:
        path = _profile_path(account_id)
        record = _read_json(path)
        if not record or not isinstance(record.get("auth"), dict):
            raise KeyError(_("없는 계정입니다."))
        info = _info(record["auth"])
        if not info or _account_id(info["email"]) != account_id:
            raise AccountError(
                _(
                    "저장된 로그인 정보가 올바르지 않습니다. 계정을 다시 추가해 주십시오."
                )
            )
        active = sync_current()  # save the current account's latest token first
        if active == account_id:
            return {"email": info["email"], "changed": False}
        _install_live(record["auth"])
    # A running Codex (and the shared daemon) still holds the old account and fails with a "different account"
    # error on token refresh → after the update, restart on the same conversation (if windows are working,
    # automatically after they all finish)
    return {
        "email": info["email"],
        "changed": True,
        "applied": schedule_apply(account_id, update),
    }


def remove(account_id: str) -> None:
    with _lock:
        path = _profile_path(account_id)
        if account_id == sync_current():
            raise AccountError(
                _(
                    "지금 쓰고 있는 계정은 지울 수 없습니다. 다른 계정으로 바꾼 뒤 지워 주십시오."
                )
            )
        if not path.exists():
            raise KeyError(_("없는 계정입니다."))
        path.unlink()


# ── Add account: device-auth login ──────────────────────────────────────────────


class _Login:
    def __init__(self) -> None:
        self.id = secrets.token_hex(8)
        self.home = _store() / "pending" / self.id
        self.home.mkdir(mode=0o700)
        self.url: str | None = None
        self.code: str | None = None
        self.state = "starting"  # starting → waiting → done | error | cancelled
        self.email: str | None = None
        self.live = False  # whether the current login (auth.json) was replaced too
        self.error: str | None = None
        self.started = time.monotonic()
        self.output: list[str] = []
        self.proc: subprocess.Popen | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "url": self.url,
            "code": self.code,
            "email": self.email,
            "live": self.live,
            "error": self.error,
            "expires_in": max(
                0, int(LOGIN_TIMEOUT - (time.monotonic() - self.started))
            ),
        }


_logins: dict[str, _Login] = {}


def _codex_bin() -> str:
    found = find_command("codex")
    if not found:
        raise AccountError(_("codex 명령을 찾지 못했습니다."))
    return found


def _child_env(home: Path) -> dict[str, str]:
    from app.services.agents.pty_service import (
        _env,  # environment without the dashboard secrets
    )

    env = _env()
    env["CODEX_HOME"] = str(home)
    env["NO_COLOR"] = "1"
    return env


def _run_login(login: _Login) -> None:
    try:
        login.proc = subprocess.Popen(
            [_codex_bin(), "login", "--device-auth"],
            env=_child_env(login.home),
            cwd=str(login.home),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        timer = threading.Timer(LOGIN_TIMEOUT, lambda: _stop(login, "timeout"))
        timer.daemon = True
        timer.start()
        for raw in login.proc.stdout:
            line = _ANSI.sub("", raw).strip()
            if line:
                login.output = (login.output + [line])[-30:]
            if not login.url and (m := _URL.search(line)):
                login.url = m.group(0)
            if not login.code and login.url and (m := _CODE.search(line)):
                login.code = m.group(0)
            if login.url and login.code and login.state == "starting":
                login.state = "waiting"
        code = login.proc.wait()
        timer.cancel()
        if login.state in {"cancelled", "error"}:
            return
        auth = _read_json(login.home / "auth.json")
        info = _info(auth) if auth else None
        if code == 0 and info:
            login.live = _store_login(auth, info)
            login.email = info["email"]
            login.state = "done"
        else:
            login.state = "error"
            tail = " / ".join(login.output[-3:])
            login.error = _("로그인이 끝나지 않았습니다. {tail}", tail=tail).strip()[
                :400
            ]
    except Exception as error:  # noqa: BLE001 — inside a thread: reported through the state
        login.state = "error"
        login.error = str(error)[:300]
    finally:
        shutil.rmtree(login.home, ignore_errors=True)


def _stop(login: _Login, reason: str) -> None:
    if login.state in {"done", "error", "cancelled"}:
        return
    login.state = "cancelled" if reason == "cancel" else "error"
    if reason == "timeout":
        login.error = _("시간이 지나 코드가 만료됐습니다. 다시 시도해 주십시오.")
    proc = login.proc
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, 15)
        except ProcessLookupError:
            pass


def start_login() -> dict:
    """Start a new login and wait until the link · code appear (up to 15 seconds)."""
    with _lock:
        for other in list(_logins.values()):  # only one at a time
            _stop(other, "cancel")
        _logins.clear()
        login = _Login()
        _logins[login.id] = login
    threading.Thread(target=_run_login, args=(login,), daemon=True).start()
    deadline = time.monotonic() + 15
    while login.state == "starting" and time.monotonic() < deadline:
        time.sleep(0.1)
    if login.state == "starting":
        _stop(login, "cancel")
        raise AccountError(
            _("로그인 코드를 받지 못했습니다. 잠시 뒤 다시 시도해 주십시오.")
        )
    return login.public()


def login_status(login_id: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError(_("로그인 요청을 찾지 못했습니다."))
    return login.public()


def cancel_login(login_id: str) -> None:
    login = _logins.get(login_id)
    if login:
        _stop(login, "cancel")


# ── Sign out: removes the current login and the stored data of that account ─────────────


def logout() -> dict:
    """Sign out with the official `codex logout`, and delete that account's login data · backups saved in the dashboard."""
    with _lock:
        auth = _read_json(live_file())
        info = _info(auth) if auth else None
        if not auth:
            raise AccountError(_("로그인된 계정이 없습니다."))
        active = _account_id(info["email"]) if info else None
    try:
        subprocess.run(
            [_codex_bin(), "logout"],
            env=_child_env(codex_home()),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AccountError(_("로그아웃 명령을 실행하지 못했습니다.")) from error
    with _lock:
        if _read_json(live_file()):
            raise AccountError(
                _("로그아웃하지 못했습니다. 터미널에서 확인해 주십시오.")
            )
        if active:
            _profile_path(active).unlink(missing_ok=True)
        for old in (_store() / "backups").glob("*.json"):
            old.unlink(missing_ok=True)
        _invalidate_usage_cache()
    return {"email": info["email"] if info else None}
