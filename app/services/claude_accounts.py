"""Claude Code 계정 여러 개: 저장 · 전환 · 추가.

- Claude Code 로그인은 ~/.claude/.credentials.json 의 claudeAiOauth 다 (같은 파일의 MCP 로그인 등 다른 값은
  건드리지 않는다). 표시용 계정 정보는 ~/.claude.json 의 oauthAccount.
- 계정마다 claudeAiOauth 복사본을 대시보드 데이터 폴더(claude-accounts/, 폴더 700 · 파일 600)에 둔다.
- 어느 계정의 토큰인지는 Anthropic 프로필 API 로 확인한다 (~/.claude.json 은 실행 중인 Claude 가 덮어쓸 수 있어
  믿지 않는다). 확실하지 않으면 저장 · 전환하지 않는다 — 다른 계정 토큰으로 덮어써 로그인이 풀리는 일을 막는다.
- 전환: 지금 계정의 최신 토큰을 먼저 저장하고(Claude 는 토큰을 갱신할 때마다 바꾸므로), 원래 파일을 backups/ 에
  남긴 뒤 claudeAiOauth 만 원자적으로 바꿔 끼운다. 실행 중인 Claude Code 는 이 파일이 바뀐 것을 알아채고
  다시 읽으므로 창을 다시 켜지 않아도 새 계정으로 이어진다.
- 추가: 임시 설정 폴더에서 `claude auth login` 을 돌려 그 결과만 저장한다 (claude_login). 지금 로그인은 그대로다.
- 브라우저로는 메일 · 조직 · 요금제 · 시각만 보낸다. 토큰은 절대 내보내지 않는다.
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

from app.paths import data_dir
from app.services.ai_usage_service import AIUsageService

logger = logging.getLogger(__name__)

KEEP_BACKUPS = 20
GUARD_SECONDS = 90  # 바꾼 직후, 예전 계정을 든 Claude 가 파일을 되돌리면 다시 끼운다
GUARD_POLL = 5.0
_ID = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.RLock()


class AccountError(RuntimeError):
    """사용자에게 그대로 보여 줄 수 있는 오류."""


# ── 파일 ──────────────────────────────────────────────────────────────────────


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
    """계정 추가 로그인용 임시 설정 폴더 (700). 끝나면 지운다."""
    path = _store() / "pending" / secrets.token_hex(8)
    path.mkdir(mode=0o700)
    return path


def _write_file(path: Path, text: str, mode: int = 0o600) -> None:
    """임시 파일에 쓴 뒤 원자적으로 바꿔 끼운다 (쓰다 끊겨도 원래 파일이 남는다)."""
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
        raise KeyError("없는 계정입니다.")
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


# ── 어느 계정의 토큰인지 ─────────────────────────────────────────────────────────

_profile_cache: dict[str, tuple[float, dict | None]] = {}


def _fetch_profile(access_token: str) -> dict | None:
    """Anthropic 프로필 API 로 토큰 주인을 확인한다 (읽기만, 토큰을 갱신하지 않는다). 10분 캐시."""
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
    except Exception:  # noqa: BLE001 — 네트워크 오류: 확인하지 못한 것으로 친다
        result = None
    if len(_profile_cache) > 64:
        _profile_cache.clear()
    if result is not None:  # 실패는 캐시하지 않는다 (잠깐의 네트워크 오류)
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
    """토큰 주인 {account_uuid, org_uuid, email, org_name} — 모르면 None."""
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
    # 기한이 지난 토큰(아무 Claude 도 안 돌아 갱신되지 않음): 같은 로그인이 함께 적은 설정 파일을 믿는다
    return _from_config(config)


def _snapshot(config: dict | None, ident: dict) -> dict | None:
    """설정 파일의 oauthAccount 가 같은 계정일 때만 그대로 보관 (전환할 때 되돌려 넣는다)."""
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
    # 저장된 쪽이 더 새 토큰이면(따로 로그인해 받은 것) 오래된 것으로 덮지 않는다
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
    """지금 로그인을 계정 목록에 저장/갱신한다. 지금 계정 id (로그인이 없거나 확인하지 못하면 None)."""
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


# ── 목록 · 전환 · 지우기 ────────────────────────────────────────────────────────


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
    """(_lock 안에서) 원래 파일을 백업하고 claudeAiOauth 와 oauthAccount 만 바꿔 끼운다."""
    live = live_file()
    text = live.read_text(encoding="utf-8") if live.exists() else None
    credentials = _read_json(live) if text is not None else {}
    if text is not None and credentials is None:
        raise AccountError("로그인 파일을 읽지 못해 바꾸지 않았어요.")
    cfg_path = config_file()
    config = _read_json(cfg_path)
    _backup(text, (config or {}).get("oauthAccount"))

    credentials = dict(credentials or {})
    credentials["claudeAiOauth"] = record["oauth"]
    live.parent.mkdir(parents=True, exist_ok=True)
    _write_file(live, json.dumps(credentials, indent=2, ensure_ascii=False))

    # 화면 · /status 의 계정 표시. 실패해도 로그인에는 영향이 없다.
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
            config.pop("cachedUsageUtilization", None)  # 예전 계정 사용량
            _write_file(
                cfg_path, json.dumps(config, indent=2, ensure_ascii=False), mode
            )
        except OSError as error:
            logger.warning("Claude 계정 표시 정보를 바꾸지 못함 · %s", error)
    _invalidate_usage_cache()


_guard = {"target": None, "until": 0.0, "running": False}


def _guard_worker() -> None:
    """바꾼 직후 잠깐: 예전 계정 토큰을 든 Claude 가 갱신하며 파일을 되돌리면 그 토큰은 그 계정에 저장하고 다시 끼운다."""
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
                            "Claude 계정이 되돌아가 다시 바꿈 · %s", record.get("email")
                        )
            except Exception:
                logger.exception("Claude 계정 확인 실패")


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
            raise KeyError("없는 계정입니다.")
        refresh_until = record["oauth"].get("refreshTokenExpiresAt")
        if (
            isinstance(refresh_until, (int, float))
            and refresh_until / 1000 < time.time()
        ):
            raise AccountError(
                "이 계정은 저장된 로그인이 만료됐어요. 계정 추가로 다시 로그인해 주세요."
            )
        has_login = _oauth(_read_json(live_file())) is not None
        active = (
            sync_current()
        )  # 지금 계정의 최신 토큰을 먼저 저장 (잃으면 그 계정이 로그아웃된다)
        if has_login and active is None:
            raise AccountError(
                "지금 로그인된 Claude 계정을 확인하지 못해 바꾸지 않았어요 (인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요)."
            )
        if active == account_id:
            return {"email": record.get("email"), "changed": False}
        _install(record)
        _start_guard(account_id)
    logger.info("Claude 계정 전환 · %s", record.get("email"))
    return {"email": record.get("email"), "changed": True}


def remove(account_id: str) -> None:
    with _lock:
        path = _profile_path(account_id)
        if account_id == sync_current():
            raise AccountError(
                "지금 쓰고 있는 계정은 지울 수 없어요. 다른 계정으로 바꾼 뒤 지워 주세요."
            )
        if not path.exists():
            raise KeyError("없는 계정입니다.")
        path.unlink()


def store_login(folder: Path) -> dict:
    """임시 폴더의 로그인 결과를 계정으로 저장한다 (지금 로그인은 건드리지 않는다). {id, email, active}"""
    with _lock:
        oauth = _oauth(_read_json(folder / ".credentials.json"))
        if not oauth:
            raise AccountError("로그인 정보를 찾지 못했어요. 다시 시도해 주세요.")
        config = _read_json(folder / ".claude.json")
        ident = _fetch_profile(oauth["accessToken"]) or _from_config(config)
        if not ident:
            raise AccountError("로그인한 계정을 확인하지 못했어요. 다시 시도해 주세요.")
        account_id = _save(oauth, ident, _snapshot(config, ident), force=True)
        active = sync_current()
        return {
            "id": account_id,
            "email": ident.get("email"),
            "active": active == account_id,
        }


def discard(folder: Path) -> None:
    """임시 로그인 폴더를 지운다 (토큰이 남지 않게)."""
    try:
        if folder.resolve().parent == (_store() / "pending").resolve():
            shutil.rmtree(folder, ignore_errors=True)
    except OSError:
        pass


def cleanup_pending() -> None:
    """서버가 로그인 도중 꺼져 남은 임시 폴더를 지운다."""
    for folder in (_store() / "pending").iterdir():
        discard(folder)
