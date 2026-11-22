"""Sign-in · sessions.

- Password: ADMIN_PASS (plain text) or ADMIN_PASS_HASH (PBKDF2, tools/security.py hash-password)
- Two-step verification: with ADMIN_TOTP_SECRET set, the 6-digit code from an authenticator app is also required
  (RFC 6238, the same code cannot be reused)
- Sessions: the cookie holds only a random session ID, valid only while it is in the server's session list
  (data/sessions.json).
  → sign-out · sign-out everywhere survive a server restart, and every existing session becomes invalid once the
    idle/maximum time passes or the account details (password · TOTP) change.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import struct
import tempfile
import threading
import time
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.requests import HTTPConnection

from app.i18n import _
from app.paths import data_dir

logger = logging.getLogger(__name__)

WEAK_PASSWORDS = {
    "changeme",
    "admin",
    "admin1234",
    "password",
    "1234",
    "12345678",
    "qwerty",
    "password123",
}
PBKDF2_ITERATIONS = 600_000


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


SESSION_MAX_AGE = _int_env("SESSION_MAX_HOURS", 12) * 3600
SESSION_IDLE = _int_env("SESSION_IDLE_MINUTES", 240) * 60


# ── Credentials ──────────────────────────────────────────────────────────────


def _username() -> str:
    # the old .env key (ADMIN_USERNAME) is read too.
    return os.getenv("ADMIN_USER") or os.getenv("ADMIN_USERNAME") or ""


def _plain_password() -> str:
    return os.getenv("ADMIN_PASS") or os.getenv("ADMIN_PASSWORD") or ""


def _password_hash() -> str:
    # a password changed in Settings is stored in the data folder and takes precedence over .env
    return (
        str(_credential_state().get("pass_hash") or "")
        or os.getenv("ADMIN_PASS_HASH", "").strip()
    )


_credential_cache: tuple[int, dict] = (-1, {})


def _credential_file() -> Path:
    return data_dir() / "credentials.json"


def _credential_state() -> dict:
    global _credential_cache
    try:
        stamp = _credential_file().stat().st_mtime_ns
    except OSError:
        return {}
    if _credential_cache[0] == stamp:
        return _credential_cache[1]
    try:
        data = json.loads(_credential_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    _credential_cache = (stamp, data if isinstance(data, dict) else {})
    return _credential_cache[1]


def change_password(current: str, new: str, code: str = "") -> None:
    """Change the sign-in password from Settings. Needs the current password (and a code when two-factor is on).

    Every session becomes invalid (the password is part of the session fingerprint); the caller re-issues
    one for the browser that made the change.
    """
    global _credential_cache
    if not check_password(current):
        raise ValueError(_("현재 비밀번호가 맞지 않습니다."))
    secret = _totp_secret()
    if secret and not totp_guard.verify(secret, code):
        raise ValueError(_("인증 코드가 맞지 않습니다."))
    if len(new) < 12:
        raise ValueError(_("새 비밀번호는 12자 이상이어야 합니다."))
    if new.lower() in WEAK_PASSWORDS:
        raise ValueError(_("너무 흔한 비밀번호입니다. 다른 값을 사용하십시오."))
    if hmac.compare_digest(new.encode(), current.encode()):
        raise ValueError(_("새 비밀번호가 현재 비밀번호와 같습니다."))
    path = _credential_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"pass_hash": hash_password(new), "changed_at": time.time()}, handle)
    os.replace(tmp, path)
    _credential_cache = (-1, {})


def _env_totp_secret() -> str:
    return os.getenv("ADMIN_TOTP_SECRET", "").strip().replace(" ", "").upper()


def _totp_secret() -> str:
    """The TOTP secret: ADMIN_TOTP_SECRET in .env wins; otherwise the one enrolled in the browser."""
    return _env_totp_secret() or str(_totp_state().get("secret") or "")


# ── Two-factor enrolment from the browser ─────────────────────────────────────
# The secret enrolled on the website is kept in the data folder (file mode 600), next to the session list.
# .env still works and takes precedence, so an existing ADMIN_TOTP_SECRET setup is unchanged.

TOTP_PENDING_SECONDS = 15 * 60
TOTP_MAX_ATTEMPTS = 6
_totp_lock = threading.Lock()
_totp_cache: tuple[int, dict] = (-1, {})
_totp_pending: dict[str, dict] = {}  # session id → {"secret", "at", "tries"}


def _totp_file() -> Path:
    return data_dir() / "totp.json"


def _totp_state() -> dict:
    global _totp_cache
    path = _totp_file()
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return {}
    if _totp_cache[0] == stamp:
        return _totp_cache[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    _totp_cache = (stamp, data)
    return data


def _write_totp_state(data: dict) -> None:
    global _totp_cache
    path = _totp_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp, path)
    _totp_cache = (-1, {})


def check_password(password: str) -> bool:
    if _password_hash():
        return verify_password_hash(password, _password_hash())
    plain = _plain_password()
    return bool(plain) and hmac.compare_digest(password.encode(), plain.encode())


def totp_status() -> dict:
    """{"enabled", "source": "env" | "web" | None, "prompt"}. `prompt`: ask once after sign-in whether to enrol."""
    state = _totp_state()
    source = "env" if _env_totp_secret() else "web" if state.get("secret") else None
    return {
        "enabled": source is not None,
        "source": source,
        "prompt": source is None and not state.get("dismissed"),
    }


def totp_dismiss() -> None:
    """Do not ask again whether to enrol (it stays available in Settings)."""
    with _totp_lock:
        state = dict(_totp_state())
        state["dismissed"] = True
        _write_totp_state(state)


def totp_begin(sid: str, account: str) -> dict:
    """Start an enrolment: a fresh secret that only becomes active after a valid code. Returns what the app needs."""
    from urllib.parse import quote

    if _env_totp_secret():
        raise ValueError(
            _("이중 인증이 서버 설정(.env)으로 관리되고 있어 여기서 바꿀 수 없습니다.")
        )
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    with _totp_lock:
        now = time.time()
        for key in [
            k for k, v in _totp_pending.items() if now - v["at"] > TOTP_PENDING_SECONDS
        ]:
            del _totp_pending[key]
        _totp_pending[sid] = {"secret": secret, "at": now, "tries": 0}
    label = quote(f"UnivDash:{account or 'admin'}")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer=UnivDash&digits=6&period=30"
    return {
        "secret": " ".join(secret[i : i + 4] for i in range(0, len(secret), 4)),
        "uri": uri,
        "qr": _qr_svg(uri),
    }


def _qr_svg(text: str) -> str:
    """The otpauth link as an inline SVG QR code (drawn on the server; no external service sees the secret)."""
    try:
        import io

        import segno

        buffer = io.BytesIO()
        segno.make(text, error="m").save(
            buffer, kind="svg", scale=5, border=2, xmldecl=False, svgns=True, nl=False
        )
        return buffer.getvalue().decode("utf-8")
    except Exception:  # noqa: BLE001 — the secret can still be typed by hand
        logger.debug("QR code could not be drawn", exc_info=True)
        return ""


def totp_enable(sid: str, code: str) -> None:
    """Activate the pending secret once the authenticator app shows a matching code."""
    with _totp_lock:
        pending = _totp_pending.get(sid)
        if not pending or time.time() - pending["at"] > TOTP_PENDING_SECONDS:
            _totp_pending.pop(sid, None)
            raise ValueError(
                _("등록 시간이 지났습니다. 처음부터 다시 진행해 주십시오.")
            )
        pending["tries"] += 1
        if pending["tries"] > TOTP_MAX_ATTEMPTS:
            del _totp_pending[sid]
            raise ValueError(
                _("코드를 너무 많이 틀렸습니다. 처음부터 다시 진행해 주십시오.")
            )
        code = (code or "").strip().replace(" ", "")
        current = int(time.time() // 30)
        valid = (
            len(code) == 6
            and code.isdigit()
            and any(
                hmac.compare_digest(totp_code(pending["secret"], counter), code)
                for counter in (current - 1, current, current + 1)
            )
        )
        if not valid:
            raise ValueError(
                _(
                    "코드가 맞지 않습니다. 인증 앱에 표시된 6자리 숫자를 입력해 주십시오."
                )
            )
        state = dict(_totp_state())
        state.update(secret=pending["secret"], enabled_at=time.time())
        state.pop("dismissed", None)
        _write_totp_state(state)
        del _totp_pending[sid]
        totp_guard.last_counter = (
            current  # the code just used cannot be replayed at sign-in
        )


def totp_disable(password: str, code: str) -> None:
    """Turn two-factor off. Needs the password and a current code, so a stolen session alone cannot do it."""
    if _env_totp_secret():
        raise ValueError(
            _("이중 인증이 서버 설정(.env)으로 관리되고 있어 여기서 바꿀 수 없습니다.")
        )
    secret = str(_totp_state().get("secret") or "")
    if not secret:
        raise ValueError(_("이중 인증이 켜져 있지 않습니다."))
    if not check_password(password) or not totp_guard.verify(secret, code):
        raise ValueError(_("비밀번호 또는 인증 코드가 맞지 않습니다."))
    with _totp_lock:
        state = dict(_totp_state())
        state.pop("secret", None)
        state.pop("enabled_at", None)
        state["dismissed"] = (
            True  # they chose to turn it off: do not nag at the next sign-in
        )
        _write_totp_state(state)


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password_hash(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, digest = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def config_problem() -> str | None:
    """A configuration problem that must block sign-in (None when there is none). Wording that can be shown as is on the sign-in screen."""
    if not _username():
        return _("서버 .env 에 ADMIN_USER 를 설정하십시오.")
    if _password_hash():
        if not _password_hash().startswith("pbkdf2_sha256$"):
            return _(
                "ADMIN_PASS_HASH 형식이 올바르지 않습니다. tools/security.py hash-password 로 만드십시오."
            )
    else:
        password = _plain_password()
        if not password:
            return _("서버 .env 에 ADMIN_PASS(또는 ADMIN_PASS_HASH)를 설정하십시오.")
        if password.lower() in WEAK_PASSWORDS:
            return _("ADMIN_PASS 가 너무 흔한 비밀번호입니다. 다른 값으로 바꾸십시오.")
    secret = _totp_secret()
    if secret:
        try:
            if len(_b32decode(secret)) < 10:
                return _(
                    "ADMIN_TOTP_SECRET 이 너무 짧습니다. tools/security.py totp 로 다시 만드십시오."
                )
        except ValueError:
            return _("ADMIN_TOTP_SECRET 형식이 올바르지 않습니다 (Base32).")
    return None


# ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────


def _b32decode(secret: str) -> bytes:
    try:
        return base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    except (ValueError, TypeError) as error:
        raise ValueError(_("잘못된 TOTP 비밀값")) from error


def totp_code(secret: str, counter: int, digits: int = 6) -> str:
    digest = hmac.new(
        _b32decode(secret), struct.pack(">Q", counter), hashlib.sha1
    ).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % 10**digits).zfill(digits)


class _TotpGuard:
    """Allows ±30 seconds of drift, but never accepts a time step (code) that was already used (replay protection)."""

    def __init__(self) -> None:
        self.last_counter = -1
        self.lock = threading.Lock()

    def verify(self, secret: str, code: str, now: float | None = None) -> bool:
        code = (code or "").strip().replace(" ", "")
        if len(code) != 6 or not code.isdigit():
            return False
        current = int((now if now is not None else time.time()) // 30)
        with self.lock:
            for counter in (current - 1, current, current + 1):
                if counter > self.last_counter and hmac.compare_digest(
                    totp_code(secret, counter), code
                ):
                    self.last_counter = counter
                    return True
        return False


totp_guard = _TotpGuard()


# ── Session list ─────────────────────────────────────────────────────────────


class SessionRegistry:
    """The sessions issued by the server. The cookie's session ID is stored here only as a SHA-256 hash."""

    FLUSH_INTERVAL = 60

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.path: Path | None = None
        self.data: dict = {}
        self.dirty_since = 0.0
        self._fp_cache: dict[str, str] = {}

    def _file(self) -> Path:
        return data_dir() / "sessions.json"

    def _load(self) -> None:
        path = self._file()
        if self.path == path:
            return
        self.path = path
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(self.data.get("sessions"), dict) or not isinstance(
                self.data.get("salt"), str
            ):
                raise ValueError
        except (OSError, ValueError, AttributeError):
            self.data = {"salt": secrets.token_hex(16), "sessions": {}}

    def _save(self) -> None:
        assert self.path is not None
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix=".sessions.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self.data, handle)
            os.chmod(temp, 0o600)
            os.replace(temp, self.path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise
        self.dirty_since = 0.0

    @staticmethod
    def _key(sid: str) -> str:
        return hashlib.sha256(sid.encode()).hexdigest()

    def fingerprint(self) -> str:
        """Fingerprint of the account details (password · TOTP). A slow hash, so a leaked session file makes it hard to work back to the password."""
        material = "\0".join(
            [_username(), _password_hash() or _plain_password(), _totp_secret()]
        )
        with self.lock:
            self._load()
            salt = self.data["salt"]
        cache_key = hashlib.sha256((salt + "\0" + material).encode()).hexdigest()
        cached = self._fp_cache.get(cache_key)
        if cached is None:
            cached = hashlib.pbkdf2_hmac(
                "sha256", material.encode(), salt.encode(), 200_000
            ).hex()[:32]
            self._fp_cache = {cache_key: cached}
        return cached

    def create(self, sid: str, meta: dict) -> None:
        now = time.time()
        fingerprint = self.fingerprint()
        with self.lock:
            self._load()
            sessions = self.data["sessions"]
            stale = [
                k
                for k, v in sessions.items()
                if now - v.get("created", 0) > SESSION_MAX_AGE
                or v.get("fp") != fingerprint
            ]
            for key in stale:
                sessions.pop(key, None)
            sessions[self._key(sid)] = {
                "created": now,
                "seen": now,
                "fp": fingerprint,
                **meta,
            }
            self._save()

    def validate(self, sid: str, ip: str = "") -> dict | None:
        now = time.time()
        fingerprint = self.fingerprint()
        with self.lock:
            self._load()
            entry = self.data["sessions"].get(self._key(sid))
            if entry is None:
                return None
            reason = None
            if entry.get("fp") != fingerprint:
                reason = "account details changed"
            elif now - entry.get("created", 0) > SESSION_MAX_AGE:
                reason = "maximum time exceeded"
            elif now - entry.get("seen", 0) > SESSION_IDLE:
                reason = "idle time exceeded"
            if reason:
                self.data["sessions"].pop(self._key(sid), None)
                self._save()
                logger.info("session expired · %s", reason)
                return None
            entry["seen"] = now
            if ip and entry.get("last_ip", entry.get("ip")) != ip:
                entry["last_ip"] = ip
            if not self.dirty_since:
                self.dirty_since = now
            elif now - self.dirty_since > self.FLUSH_INTERVAL:
                self._save()
            return entry

    def revoke(self, sid: str) -> None:
        with self.lock:
            self._load()
            if self.data["sessions"].pop(self._key(sid), None) is not None:
                self._save()

    def _public_id(self, key: str) -> str:
        """The session ID shown on screen. The stored key (hash of the cookie session ID) is never exposed."""
        return hashlib.sha256((self.data["salt"] + "\0" + key).encode()).hexdigest()[
            :20
        ]

    def active(self, current_sid: str = "") -> list[dict]:
        """Valid sessions (most recently used first). Expired sessions and those from before an account change are left out."""
        now = time.time()
        fingerprint = self.fingerprint()
        current = self._key(current_sid) if current_sid else ""
        with self.lock:
            self._load()
            rows = [
                {
                    "id": self._public_id(key),
                    "created": entry.get("created", 0),
                    "seen": entry.get("seen", 0),
                    "ip": entry.get("ip", ""),
                    "last_ip": entry.get("last_ip", entry.get("ip", "")),
                    "ua": entry.get("ua", ""),
                    "current": key == current,
                }
                for key, entry in self.data["sessions"].items()
                if entry.get("fp") == fingerprint
                and now - entry.get("created", 0) <= SESSION_MAX_AGE
                and now - entry.get("seen", 0) <= SESSION_IDLE
            ]
        return sorted(rows, key=lambda row: (not row["current"], -row["seen"]))

    def revoke_id(self, public_id: str) -> bool:
        with self.lock:
            self._load()
            for key in list(self.data["sessions"]):
                if hmac.compare_digest(self._public_id(key), public_id):
                    self.data["sessions"].pop(key)
                    self._save()
                    return True
        return False

    def revoke_others(self, current_sid: str) -> int:
        current = self._key(current_sid)
        with self.lock:
            self._load()
            others = [key for key in self.data["sessions"] if key != current]
            for key in others:
                self.data["sessions"].pop(key)
            if others:
                self._save()
            return len(others)

    def revoke_all(self) -> int:
        with self.lock:
            self._load()
            count = len(self.data["sessions"])
            self.data["sessions"] = {}
            self._save()
            return count


sessions = SessionRegistry()


class AuthService:
    @staticmethod
    def is_configured() -> bool:
        return config_problem() is None

    @staticmethod
    def totp_enabled() -> bool:
        return bool(_totp_secret())

    @staticmethod
    def authenticate(username: str, password: str, otp: str = "") -> bool:
        problem = config_problem()
        if problem:
            logger.error("sign-in refused · %s", problem)
            return False
        # to prevent timing attacks, use constant-time comparison and compare both the ID and the password to the end.
        user_ok = hmac.compare_digest(username.encode(), _username().encode())
        if _password_hash():
            pass_ok = verify_password_hash(password, _password_hash())
        else:
            pass_ok = hmac.compare_digest(password.encode(), _plain_password().encode())
        if not (user_ok and pass_ok):
            return False
        # the code is checked only when the password is right (so a wrong password cannot burn a valid code).
        if _totp_secret():
            return totp_guard.verify(_totp_secret(), otp)
        return True

    @staticmethod
    def start_session(request: Request, username: str) -> None:
        # session fixation protection: drop the pre-sign-in session contents and issue a new one.
        request.session.clear()
        sid = secrets.token_urlsafe(32)
        sessions.create(
            sid,
            {
                "ip": request.client.host if request.client else "",
                "ua": (request.headers.get("user-agent") or "")[:200],
            },
        )
        request.session.update({"user": username, "sid": sid})

    @staticmethod
    def end_session(request: Request) -> None:
        sid = request.session.get("sid")
        if isinstance(sid, str):
            sessions.revoke(sid)
        request.session.clear()

    @staticmethod
    def end_all_sessions(request: Request) -> int:
        count = sessions.revoke_all()
        request.session.clear()
        return count

    @staticmethod
    def current_user(conn: HTTPConnection) -> str | None:
        """Used by both HTTP requests and WebSockets."""
        session = conn.session
        user, sid = session.get("user"), session.get("sid")
        if not (isinstance(user, str) and isinstance(sid, str)):
            return None
        if not hmac.compare_digest(user.encode(), _username().encode()):
            return None
        ip = conn.client.host if conn.client else ""
        if sessions.validate(sid, ip) is None:
            return None
        return user

    @staticmethod
    def is_authenticated(request: Request) -> bool:
        return AuthService.current_user(request) is not None

    @staticmethod
    def require_user(request: Request) -> str:
        """Dependency for API routes: 401 when not signed in."""
        user = AuthService.current_user(request)
        if not user:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return user
