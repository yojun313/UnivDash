"""Multiple Claude Code accounts: save · switch · add.

- The Claude Code login is claudeAiOauth in ~/.claude/.credentials.json (other values in the same file, such as
  MCP logins, are left alone). The account info for display is oauthAccount in ~/.claude.json.
- A copy of claudeAiOauth per account is kept in the dashboard data folder (claude-accounts/, folder 700 · files 600).
- Which account a token belongs to is checked with the Anthropic profile API (~/.claude.json can be overwritten by a
  running Claude, so it is not trusted). When unsure, nothing is saved or switched — this prevents overwriting with
  another account's token and losing a login.
- Switch: the current account's latest token is saved first (Claude changes the token on every refresh), the original
  file is kept in backups/, then only claudeAiOauth is swapped atomically. A running Claude Code notices the file
  changed and re-reads it, so it continues on the new account without restarting the window.
- Add: `claude auth login` runs in a temporary config folder and only its result is saved (claude_login). The
  current login stays as it is.
- Only the email · organization · plan · timestamps are sent to the browser. Tokens are never sent out.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from app.i18n import _
from app.paths import data_dir
from app.services.accounts.ai_usage_service import AIUsageService

logger = logging.getLogger(__name__)

KEEP_BACKUPS = 20
# Right after a switch, if a Claude holding the old account reverts the file, it is swapped in again
GUARD_SECONDS = 90
GUARD_POLL = 5.0
_ID = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.RLock()


class AccountError(RuntimeError):
    """An error that can be shown to the user as is."""


# ── Files ─────────────────────────────────────────────────────────────────────


def claude_root() -> Path:
    return AIUsageService._data_root("CLAUDE_DATA_DIR", ".claude")


def live_file() -> Path:
    return claude_root() / ".credentials.json"


def config_file() -> Path | None:
    return AIUsageService._claude_config_file(claude_root())


def _store() -> Path:
    root = data_dir() / "claude-accounts"
    for path in (root, root / "backups", root / "pending"):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o700)
    return root


def pending_dir() -> Path:
    """Temporary config folder for an add-account login (700). Deleted when done."""
    path = _store() / "pending" / secrets.token_hex(8)
    path.mkdir(mode=0o700)
    return path


def _write_file(path: Path, text: str, mode: int = 0o600) -> None:
    """Write to a temporary file, then swap it in atomically (the original file survives an interrupted write)."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _read_json(path: Path | None) -> dict | None:
    if path is None:
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _oauth(credentials: dict | None) -> dict | None:
    oauth = credentials.get("claudeAiOauth") if credentials else None
    if isinstance(oauth, dict) and isinstance(oauth.get("accessToken"), str):
        return oauth
    return None


def _account_id(account_uuid: str, org_uuid: str) -> str:
    return hashlib.sha256(f"{account_uuid}:{org_uuid}".encode()).hexdigest()[:12]


def _profile_path(account_id: str) -> Path:
    if not _ID.match(account_id or ""):
        raise KeyError(_("없는 계정입니다."))
    return _store() / f"{account_id}.json"


def _profiles() -> dict[str, dict]:
    found = {}
    for path in sorted(_store().glob("*.json")):
        record = _read_json(path)
        if (
            record
            and _ID.match(path.stem)
            and _oauth({"claudeAiOauth": record.get("oauth")})
        ):
            found[path.stem] = record
    return found


# ── Which account a token belongs to ─────────────────────────────────────────────

_profile_cache: dict[str, tuple[float, dict | None]] = {}


def _fetch_profile(access_token: str) -> dict | None:
    """Check the token owner with the Anthropic profile API (read only, the token is not refreshed). Cached for 10 minutes."""
    key = hashlib.sha256(access_token.encode()).hexdigest()
    cached = _profile_cache.get(key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    result = None
    try:
        import httpx

        response = httpx.get(
            "https://api.anthropic.com/api/oauth/profile",
            headers={
                "Authorization": f"Bearer {access_token}",
                "anthropic-beta": "oauth-2025-04-20",
            },
            timeout=8,
            follow_redirects=False,
        )
        if response.status_code == 200:
            data = response.json()
            account = data.get("account") or {}
            org = data.get("organization") or {}
            if account.get("uuid") and org.get("uuid"):
                result = {
                    "account_uuid": account["uuid"],
                    "org_uuid": org["uuid"],
                    "email": AIUsageService._clean_email(account.get("email")),
                    "org_name": org.get("name"),
                }
    except Exception:  # noqa: BLE001 — network error: treated as not verified
        result = None
    if len(_profile_cache) > 64:
        _profile_cache.clear()
    if result is not None:  # failures are not cached (a brief network error)
        _profile_cache[key] = (time.monotonic(), result)
    return result


def _from_config(config: dict | None) -> dict | None:
    account = config.get("oauthAccount") if config else None
    if not isinstance(account, dict):
        return None
    if not account.get("accountUuid") or not account.get("organizationUuid"):
        return None
    return {
        "account_uuid": account["accountUuid"],
        "org_uuid": account["organizationUuid"],
        "email": AIUsageService._clean_email(account.get("emailAddress")),
        "org_name": account.get("organizationName"),
    }


def _usable(oauth: dict) -> bool:
    expires = oauth.get("expiresAt")
    return not isinstance(expires, (int, float)) or expires / 1000 > time.time() + 60


def _identify(oauth: dict, config: dict | None) -> dict | None:
    """Token owner {account_uuid, org_uuid, email, org_name} — None when unknown."""
    for record in _profiles().values():
        saved = record["oauth"]
        if saved.get("accessToken") == oauth.get("accessToken") or (
            oauth.get("refreshToken")
            and saved.get("refreshToken") == oauth.get("refreshToken")
        ):
            return {
                key: record.get(key)
                for key in ("account_uuid", "org_uuid", "email", "org_name")
            }
    if _usable(oauth):
        return _fetch_profile(oauth["accessToken"])
    # Expired token (no Claude was running, so it was not refreshed): trust the config file written by the same login
    return _from_config(config)


def _snapshot(config: dict | None, ident: dict) -> dict | None:
    """Keep the config file's oauthAccount as is, only when it is the same account (put back on a switch)."""
    account = config.get("oauthAccount") if config else None
    if (
        isinstance(account, dict)
        and account.get("accountUuid") == ident["account_uuid"]
        and account.get("organizationUuid") == ident["org_uuid"]
    ):
        return account
    return None


def _save(oauth: dict, ident: dict, snapshot: dict | None, force: bool = False) -> str:
    account_id = _account_id(ident["account_uuid"], ident["org_uuid"])
    path = _profile_path(account_id)
    record = _read_json(path) or {}
    saved = record.get("oauth") if isinstance(record.get("oauth"), dict) else None
    if saved == oauth and (snapshot is None or record.get("oauth_account") == snapshot):
        return account_id
    # If the saved token is newer (obtained by a separate login), do not overwrite it with an older one
    if (
        saved
        and not force
        and saved != oauth
        and (saved.get("expiresAt") or 0) > (oauth.get("expiresAt") or 0)
    ):
        return account_id
    record.update(
        {
            "account_uuid": ident["account_uuid"],
            "org_uuid": ident["org_uuid"],
            "email": ident.get("email") or record.get("email"),
            "org_name": ident.get("org_name") or record.get("org_name"),
            "plan": oauth.get("subscriptionType") or record.get("plan"),
            "saved_at": time.time(),
            "oauth": oauth,
            "oauth_account": snapshot or record.get("oauth_account"),
        }
    )
    _write_file(path, json.dumps(record, ensure_ascii=False))
    return account_id


def sync_current() -> str | None:
    """Save/update the current login in the account list. Returns the current account id (None when there is no login or it could not be verified)."""
    with _lock:
        oauth = _oauth(_read_json(live_file()))
        if not oauth:
            return None
        config = _read_json(config_file())
        ident = _identify(oauth, config)
        if not ident:
            return None
        return _save(oauth, ident, _snapshot(config, ident))


def _invalidate_usage_cache() -> None:
    AIUsageService._limits_cache = None
    AIUsageService._claude_usage_cache = None
    AIUsageService._claude_rejected_token = None
    with AIUsageService._cache_lock:
        AIUsageService._cache.clear()


# ── List · switch · remove ──────────────────────────────────────────────────────


def list_accounts() -> dict:
    with _lock:
        active = sync_current()
        accounts = []
        for account_id, record in _profiles().items():
            refresh_until = record["oauth"].get("refreshTokenExpiresAt")
            accounts.append(
                {
                    "id": account_id,
                    "email": record.get("email"),
                    "org": record.get("org_name"),
                    "plan": record.get("plan"),
                    "saved_at": record.get("saved_at"),
                    "active": account_id == active,
                    "expired": isinstance(refresh_until, (int, float))
                    and refresh_until / 1000 < time.time(),
                }
            )
        accounts.sort(key=lambda a: (not a["active"], (a["email"] or "").lower()))
        return {"accounts": accounts, "active": active}


# ── Remaining limits of saved (not currently signed-in) accounts ────────────────
# The usage API is read with the saved token. If the access token has expired it is refreshed the same way
# Claude Code does, and the new token is saved to that account's file right away (a refresh invalidates the
# old refresh token, so saving is what keeps the login alive).
# The currently signed-in account is refreshed by the running Claude, so it is never refreshed here.

TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"  # Claude Code
_saved_rejected: set[str] = (
    set()
)  # accounts whose refresh was rejected (must sign in again)


def _refresh_saved(account_id: str, record: dict) -> dict | None:
    """(inside _lock) Refresh and save a saved account's token. Returns the new oauth · None on failure."""
    oauth = record["oauth"]
    refresh = oauth.get("refreshToken")
    if not isinstance(refresh, str) or not refresh:
        return None
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": CLIENT_ID,
    }
    scopes = oauth.get("scopes")
    if isinstance(scopes, list) and all(isinstance(x, str) for x in scopes) and scopes:
        body["scope"] = " ".join(scopes)
    try:
        import httpx

        response = httpx.post(
            TOKEN_URL,
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=15,
            follow_redirects=False,
        )
    except Exception:  # noqa: BLE001 — network error: try again next time
        return None
    if response.status_code in (400, 401, 403):
        _saved_rejected.add(account_id)
        logger.warning(
            "Saved Claude account refresh rejected · %s · %s",
            record.get("email"),
            response.status_code,
        )
        return None
    if response.status_code != 200:
        return None
    try:
        data = response.json()
    except ValueError:
        return None
    token = data.get("access_token") if isinstance(data, dict) else None
    expires_in = data.get("expires_in") if isinstance(data, dict) else None
    if (
        not isinstance(token, str)
        or not token
        or not isinstance(expires_in, (int, float))
    ):
        return None
    now_ms = int(time.time() * 1000)
    updated = {
        **oauth,
        "accessToken": token,
        "refreshToken": data.get("refresh_token") or refresh,
        "expiresAt": now_ms + int(expires_in * 1000),
    }
    if isinstance(data.get("refresh_token_expires_in"), (int, float)):
        updated["refreshTokenExpiresAt"] = now_ms + int(
            data["refresh_token_expires_in"] * 1000
        )
    if isinstance(data.get("scope"), str) and data["scope"].strip():
        updated["scopes"] = data["scope"].split()
    record = {**record, "oauth": updated, "saved_at": time.time()}
    _write_file(_profile_path(account_id), json.dumps(record, ensure_ascii=False))
    _saved_rejected.discard(account_id)
    logger.info("Saved Claude account token refreshed · %s", record.get("email"))
    return updated


def _saved_token(account_id: str, allow_refresh: bool) -> tuple[str | None, bool]:
    """(usable access token, whether a new sign-in is needed). (None, False) when it is the currently signed-in account."""
    with _lock:
        record = _read_json(_profile_path(account_id))
        oauth = _oauth({"claudeAiOauth": record.get("oauth")}) if record else None
        if not oauth:
            return None, False
        live = _oauth(_read_json(live_file())) or {}
        if live.get("refreshToken") and live.get("refreshToken") == oauth.get(
            "refreshToken"
        ):
            return (
                None,
                False,
            )  # the currently signed-in token — left to the running Claude
        if _usable(oauth):
            return oauth["accessToken"], False
        refresh_until = oauth.get("refreshTokenExpiresAt")
        if (
            isinstance(refresh_until, (int, float))
            and refresh_until / 1000 < time.time()
        ):
            return None, True
        # Right after a switch (while the revert guard runs) a running Claude may still hold the old account's token, so do not refresh
        if _guard["target"] and time.monotonic() < _guard["until"]:
            return None, False
        if account_id in _saved_rejected:
            return None, True
        if not allow_refresh:
            return None, False
        updated = _refresh_saved(account_id, {**record, "oauth": oauth})
        if updated:
            return updated["accessToken"], False
        return None, account_id in _saved_rejected


def saved_limits(now) -> list[dict]:
    """{id, email, org, plan, limits, login_expired} for each saved account that is not signed in now. Tokens are not sent out."""
    with _lock:
        active = sync_current()
        records = {k: v for k, v in _profiles().items() if k != active}
        # Do not refresh when the account of the current login is unknown: using that login's old refresh
        # token could sign out the current login too
        allow_refresh = active is not None or _oauth(_read_json(live_file())) is None
    result = []
    for account_id, record in sorted(
        records.items(), key=lambda kv: (kv[1].get("email") or "").lower()
    ):
        token, expired = _saved_token(account_id, allow_refresh)
        # Same key as the current account's card: the last usage received carries over a switch (shown on a 429)
        key = f"acct:{record.get('account_uuid')}:{record.get('org_uuid') or ''}"
        if token:
            entry, _status = AIUsageService.claude_usage(key, token)
        else:
            with AIUsageService._claude_usage_lock:
                entry = AIUsageService._usage_good().get(key)
        tier = f"subscription_{record.get('plan')}" if record.get("plan") else None
        limits = (
            AIUsageService._claude_limits_from(entry, tier, now)
            if entry and not expired
            else None
        )
        result.append(
            {
                "id": account_id,
                "email": record.get("email"),
                "org": record.get("org_name"),
                "plan": record.get("plan"),
                "limits": limits,
                "login_expired": expired,
            }
        )
    return result


def _backup(credentials_text: str | None, oauth_account) -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = _store() / "backups" / f"credentials-{stamp}-{secrets.token_hex(2)}.json"
    _write_file(
        backup,
        json.dumps(
            {"credentials": credentials_text, "oauthAccount": oauth_account},
            ensure_ascii=False,
        ),
    )
    olds = sorted((_store() / "backups").glob("credentials-*.json"))
    for old in olds[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)


def _install(record: dict) -> None:
    """(inside _lock) Back up the original file and swap in only claudeAiOauth and oauthAccount."""
    live = live_file()
    text = live.read_text(encoding="utf-8") if live.exists() else None
    credentials = _read_json(live) if text is not None else {}
    if text is not None and credentials is None:
        raise AccountError(_("로그인 파일을 읽지 못해 바꾸지 않았습니다."))
    cfg_path = config_file()
    config = _read_json(cfg_path)
    _backup(text, (config or {}).get("oauthAccount"))

    credentials = dict(credentials or {})
    credentials["claudeAiOauth"] = record["oauth"]
    live.parent.mkdir(parents=True, exist_ok=True)
    _write_file(live, json.dumps(credentials, indent=2, ensure_ascii=False))

    # The account shown on screen · in /status. A failure here does not affect the login.
    if cfg_path is not None and config is not None:
        account = record.get("oauth_account") or {
            "accountUuid": record["account_uuid"],
            "emailAddress": record.get("email"),
            "organizationUuid": record["org_uuid"],
            "organizationName": record.get("org_name"),
        }
        try:
            mode = cfg_path.stat().st_mode & 0o777
            config["oauthAccount"] = account
            config.pop("cachedUsageUtilization", None)  # the old account's usage
            _write_file(
                cfg_path, json.dumps(config, indent=2, ensure_ascii=False), mode
            )
        except OSError as error:
            logger.warning(
                "Could not update the Claude account display info · %s", error
            )
    _invalidate_usage_cache()


_guard = {"target": None, "until": 0.0, "running": False}


def _guard_worker() -> None:
    """For a short while after a switch: if a Claude holding the old account's token reverts the file while refreshing, save that token to its account and swap the target in again."""
    while True:
        time.sleep(GUARD_POLL)
        with _lock:
            target = _guard["target"]
            if not target or time.monotonic() > _guard["until"]:
                _guard.update(target=None, running=False)
                return
            try:
                current = sync_current()
                if current and current != target:
                    record = _read_json(_profile_path(target))
                    if record and _oauth({"claudeAiOauth": record.get("oauth")}):
                        _install(record)
                        logger.warning(
                            "Claude account was reverted, switched again · %s",
                            record.get("email"),
                        )
            except Exception:
                logger.exception("Claude account check failed")


def _start_guard(target: str) -> None:
    _guard.update(target=target, until=time.monotonic() + GUARD_SECONDS)
    if not _guard["running"]:
        _guard["running"] = True
        threading.Thread(
            target=_guard_worker, daemon=True, name="claude-account-guard"
        ).start()


def switch(account_id: str) -> dict:
    with _lock:
        record = _read_json(_profile_path(account_id))
        if not record or not _oauth({"claudeAiOauth": record.get("oauth")}):
            raise KeyError(_("없는 계정입니다."))
        refresh_until = record["oauth"].get("refreshTokenExpiresAt")
        if (
            isinstance(refresh_until, (int, float))
            and refresh_until / 1000 < time.time()
        ):
            raise AccountError(
                _(
                    "이 계정은 저장된 로그인이 만료됐습니다. 계정 추가로 다시 로그인해 주십시오."
                )
            )
        has_login = _oauth(_read_json(live_file())) is not None
        # Save the current account's latest token first (losing it would sign that account out)
        active = sync_current()
        if has_login and active is None:
            raise AccountError(
                _(
                    "지금 로그인된 Claude 계정을 확인하지 못해 바꾸지 않았습니다 (인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주십시오)."
                )
            )
        if active == account_id:
            return {"email": record.get("email"), "changed": False}
        _install(record)
        _start_guard(account_id)
    logger.info("Claude account switched · %s", record.get("email"))
    return {"email": record.get("email"), "changed": True}


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


def store_login(folder: Path) -> dict:
    """Save the login result in a temporary folder as an account (the current login is not touched). {id, email, active}"""
    with _lock:
        oauth = _oauth(_read_json(folder / ".credentials.json"))
        if not oauth:
            raise AccountError(
                _("로그인 정보를 찾지 못했습니다. 다시 시도해 주십시오.")
            )
        config = _read_json(folder / ".claude.json")
        ident = _fetch_profile(oauth["accessToken"]) or _from_config(config)
        if not ident:
            raise AccountError(
                _("로그인한 계정을 확인하지 못했습니다. 다시 시도해 주십시오.")
            )
        account_id = _save(oauth, ident, _snapshot(config, ident), force=True)
        active = sync_current()
        return {
            "id": account_id,
            "email": ident.get("email"),
            "active": active == account_id,
        }


def discard(folder: Path) -> None:
    """Delete a temporary login folder (so no token is left behind)."""
    try:
        if folder.resolve().parent == (_store() / "pending").resolve():
            shutil.rmtree(folder, ignore_errors=True)
    except OSError:
        pass


def cleanup_pending() -> None:
    """Delete temporary folders left behind when the server stopped during a login."""
    for folder in (_store() / "pending").iterdir():
        discard(folder)


# ── Sign out: removes the current login and the stored data of that account ─────────────


def _purge_backups() -> None:
    for old in (_store() / "backups").glob("*.json"):
        old.unlink(missing_ok=True)


def logout() -> dict:
    """Sign out with the official `claude auth logout`, and delete that account's login data · backups saved in the dashboard.

    Running Claude Code windows use the same login, so they are signed out too.
    """
    import subprocess

    from app.paths import find_command
    from app.services.accounts import claude_login

    command = find_command("claude")
    if not command:
        raise AccountError(_("claude 명령을 찾지 못했습니다."))
    with _lock:
        # So the revert guard that runs right after a switch does not sign in again
        _guard.update(target=None)
        active = sync_current()
        email = (
            (_read_json(_profile_path(active)) or {}).get("email") if active else None
        )
        if not _oauth(_read_json(live_file())):
            raise AccountError(_("로그인된 계정이 없습니다."))
    try:
        subprocess.run(
            [command, "auth", "logout"],
            env=claude_login._child_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AccountError(_("로그아웃 명령을 실행하지 못했습니다.")) from error
    with _lock:
        if _oauth(_read_json(live_file())):
            raise AccountError(
                _("로그아웃하지 못했습니다. 터미널에서 확인해 주십시오.")
            )
        if active:
            _profile_path(active).unlink(missing_ok=True)
        _purge_backups()
    _invalidate_usage_cache()
    return {"email": email}
