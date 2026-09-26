"""Codex 계정 여러 개: 저장 · 전환 · 추가(기기 인증 로그인).

- Codex 로그인 정보는 ~/.codex/auth.json 하나다. 계정마다 그 파일의 복사본을 대시보드 데이터 폴더
  (codex-accounts/, 폴더 700 · 파일 600)에 둔다.
- 전환: 지금 auth.json 을 먼저 그 계정 복사본으로 저장하고(그사이 갱신된 토큰을 잃지 않게),
  원래 파일은 backups/ 에 시각별로 남긴 뒤, 고른 계정 복사본을 auth.json 으로 원자적으로 바꿔 끼운다.
  Codex(공유 데몬 포함)는 토큰을 갱신하기 전에 auth.json 을 다시 읽으므로 새로 여는 세션부터 새 계정을 쓴다.
- 추가: 임시 CODEX_HOME 에서 `codex login --device-auth` 를 돌려 링크 · 일회용 코드를 화면에 보여 주고,
  로그인이 끝나면 그 auth.json 을 계정으로 저장한다. 지금 로그인은 건드리지 않는다.
- 브라우저로는 메일 · 요금제 · 저장 시각만 보낸다. 토큰은 절대 내보내지 않는다.
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

from app.paths import data_dir
from app.services.ai_usage_service import AIUsageService

LOGIN_TIMEOUT = 15 * 60  # 기기 코드 유효 시간
KEEP_BACKUPS = 20
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_URL = re.compile(r"https://auth\.openai\.com/[\w/.\-?=&%]+")
_CODE = re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b")
_ID = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.RLock()


class AccountError(RuntimeError):
    pass


# ── 파일 ──────────────────────────────────────────────────────────────────────


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
    """권한 600 으로 임시 파일에 쓴 뒤 원자적으로 바꿔 끼운다 (쓰다 끊겨도 원래 파일이 남는다)."""
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
    """auth.json 내용 → {email, plan} (ChatGPT 로그인이 아니면 None)."""
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
        raise KeyError("없는 계정입니다.")
    return _store() / f"{account_id}.json"


def _save_profile(auth: dict, info: dict) -> str:
    account_id = _account_id(info["email"])
    path = _profile_path(account_id)
    current = _read_json(path)
    if current and current.get("auth") == auth:
        return account_id  # 바뀐 게 없으면 쓰지 않는다
    record = {
        "email": info["email"],
        "plan": info["plan"],
        "saved_at": time.time(),
        "auth": auth,
    }
    _write_secret(path, json.dumps(record, ensure_ascii=False))
    return account_id


def sync_current() -> str | None:
    """지금 로그인(auth.json)을 계정 목록에 저장/갱신한다. 지금 계정 id (없으면 None)."""
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
    """사용량 조회 중 갱신된 토큰을 저장한다. 계정이 그사이 바뀌었으면 덮어쓰지 않는다."""
    with _lock:
        path = _profile_path(account_id)
        record = _read_json(path)
        if not record or record.get("auth") != previous or account_id == sync_current():
            return
        previous_info, current_info = _info(previous), _info(current)
        if not previous_info or not current_info or previous_info["email"] != current_info["email"]:
            return
        record["auth"] = current
        _write_secret(path, json.dumps(record, ensure_ascii=False))


# ── 목록 · 전환 · 삭제 ────────────────────────────────────────────────────────


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
    """공유 Codex 데몬(app-server)을 다시 켠다 — 새 계정의 로그인 파일을 읽고 뜨도록.

    기본 Codex 폴더(~/.codex)를 쓸 때만. 테스트 · 별도 폴더에서는 진짜 데몬을 건드리지 않는다 (None).
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


def apply_to_sessions() -> dict:
    """지금 로그인(auth.json)을 모든 Codex 창에 적용: 창을 끄고 → 데몬 재시작 → 같은 대화로 다시 켠다."""
    from app.services import agent_restart

    try:
        return agent_restart.relaunch_codex(after_stop=_restart_daemon)
    except ValueError as error:
        raise AccountError(str(error)) from error


def switch(account_id: str) -> dict:
    from app.services import agent_restart

    busy = [w.key for w, _ in agent_restart.codex_panes() if w.status == "busy"]
    if busy:
        raise AccountError(
            f"Codex 가 작업 중인 창이 있어요 ({', '.join(busy)}). 끝난 뒤에 계정을 바꿔 주세요."
        )
    with _lock:
        path = _profile_path(account_id)
        record = _read_json(path)
        if not record or not isinstance(record.get("auth"), dict):
            raise KeyError("없는 계정입니다.")
        info = _info(record["auth"])
        if not info or _account_id(info["email"]) != account_id:
            raise AccountError(
                "저장된 로그인 정보가 올바르지 않아요. 계정을 다시 추가해 주세요."
            )
        active = sync_current()  # 지금 계정의 최신 토큰을 먼저 저장
        if active == account_id:
            return {"email": info["email"], "changed": False}
        live = live_file()
        if live.exists():
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = _store() / "backups" / f"auth-{stamp}-{secrets.token_hex(2)}.json"
            _write_secret(backup, live.read_text(encoding="utf-8"))
            olds = sorted((_store() / "backups").glob("auth-*.json"))
            for old in olds[:-KEEP_BACKUPS]:
                old.unlink(missing_ok=True)
        live.parent.mkdir(parents=True, exist_ok=True)
        _write_secret(live, json.dumps(record["auth"], indent=2, ensure_ascii=False))
        _invalidate_usage_cache()
    # 실행 중인 Codex(와 공유 데몬)는 예전 계정을 들고 있어 토큰 갱신 때 "다른 계정" 오류가 난다 → 같은 대화로 다시 켠다
    try:
        applied = apply_to_sessions()
    except AccountError as error:
        applied = {"error": str(error)}
    return {"email": info["email"], "changed": True, "applied": applied}


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


# ── 계정 추가: 기기 인증 로그인 ─────────────────────────────────────────────────


class _Login:
    def __init__(self) -> None:
        self.id = secrets.token_hex(8)
        self.home = _store() / "pending" / self.id
        self.home.mkdir(mode=0o700)
        self.url: str | None = None
        self.code: str | None = None
        self.state = "starting"  # starting → waiting → done | error | cancelled
        self.email: str | None = None
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
            "error": self.error,
            "expires_in": max(
                0, int(LOGIN_TIMEOUT - (time.monotonic() - self.started))
            ),
        }


_logins: dict[str, _Login] = {}


def _codex_bin() -> str:
    found = shutil.which("codex")
    if not found:
        raise AccountError("codex 명령을 찾지 못했어요.")
    return found


def _child_env(home: Path) -> dict[str, str]:
    from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

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
            with _lock:
                _save_profile(auth, info)
            login.email = info["email"]
            login.state = "done"
        else:
            login.state = "error"
            tail = " / ".join(login.output[-3:])
            login.error = f"로그인이 끝나지 않았어요. {tail}".strip()[:400]
    except Exception as error:  # noqa: BLE001 — 스레드 안: 상태로 알린다
        login.state = "error"
        login.error = str(error)[:300]
    finally:
        shutil.rmtree(login.home, ignore_errors=True)


def _stop(login: _Login, reason: str) -> None:
    if login.state in {"done", "error", "cancelled"}:
        return
    login.state = "cancelled" if reason == "cancel" else "error"
    if reason == "timeout":
        login.error = "시간이 지나 코드가 만료됐어요. 다시 시도해 주세요."
    proc = login.proc
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, 15)
        except ProcessLookupError:
            pass


def start_login() -> dict:
    """새 로그인을 시작하고 링크 · 코드가 나올 때까지(최대 15초) 기다린다."""
    with _lock:
        for other in list(_logins.values()):  # 한 번에 하나만
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
        raise AccountError("로그인 코드를 받지 못했어요. 잠시 뒤 다시 시도해 주세요.")
    return login.public()


def login_status(login_id: str) -> dict:
    login = _logins.get(login_id)
    if not login:
        raise KeyError("로그인 요청을 찾지 못했어요.")
    return login.public()


def cancel_login(login_id: str) -> None:
    login = _logins.get(login_id)
    if login:
        _stop(login, "cancel")
