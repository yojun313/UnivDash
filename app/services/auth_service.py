"""로그인 · 세션.

- 비밀번호: ADMIN_PASS(평문, 12자 이상) 또는 ADMIN_PASS_HASH(PBKDF2, tools/security.py hash-password)
- 2단계 인증: ADMIN_TOTP_SECRET 이 있으면 인증 앱의 6자리 코드도 요구한다 (RFC 6238, 같은 코드 재사용 불가)
- 세션: 쿠키에는 임의 세션 ID 만 있고, 서버의 세션 목록(data/sessions.json)에 있어야 유효하다.
  → 로그아웃 · 전체 로그아웃이 서버 재시작 후에도 유지되고, 유휴/최대 시간이 지나거나
    계정 정보(비밀번호 · TOTP)가 바뀌면 기존 세션이 모두 무효가 된다.
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

from app.paths import data_dir

logger = logging.getLogger(__name__)

MIN_PASSWORD_LENGTH = 12
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


# ── 자격 증명 ────────────────────────────────────────────────────────────────


def _username() -> str:
    # 예전 .env 키(ADMIN_USERNAME)도 읽는다.
    return os.getenv("ADMIN_USER") or os.getenv("ADMIN_USERNAME") or ""


def _plain_password() -> str:
    return os.getenv("ADMIN_PASS") or os.getenv("ADMIN_PASSWORD") or ""


def _password_hash() -> str:
    return os.getenv("ADMIN_PASS_HASH", "").strip()


def _totp_secret() -> str:
    return os.getenv("ADMIN_TOTP_SECRET", "").strip().replace(" ", "").upper()


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
    """로그인을 막아야 하는 설정 문제 (없으면 None). 로그인 화면에 그대로 보여줄 수 있는 문구."""
    if not _username():
        return "서버 .env 에 ADMIN_USER 를 설정하세요."
    if _password_hash():
        if not _password_hash().startswith("pbkdf2_sha256$"):
            return "ADMIN_PASS_HASH 형식이 올바르지 않습니다. tools/security.py hash-password 로 만드세요."
    else:
        password = _plain_password()
        if not password:
            return "서버 .env 에 ADMIN_PASS(또는 ADMIN_PASS_HASH)를 설정하세요."
        if len(password) < MIN_PASSWORD_LENGTH or password.lower() in WEAK_PASSWORDS:
            return f"ADMIN_PASS 가 너무 약합니다. {MIN_PASSWORD_LENGTH}자 이상으로 바꾸세요."
    secret = _totp_secret()
    if secret:
        try:
            if len(_b32decode(secret)) < 10:
                return "ADMIN_TOTP_SECRET 이 너무 짧습니다. tools/security.py totp 로 다시 만드세요."
        except ValueError:
            return "ADMIN_TOTP_SECRET 형식이 올바르지 않습니다 (Base32)."
    return None


# ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────


def _b32decode(secret: str) -> bytes:
    try:
        return base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    except (ValueError, TypeError) as error:
        raise ValueError("잘못된 TOTP 비밀값") from error


def totp_code(secret: str, counter: int, digits: int = 6) -> str:
    digest = hmac.new(
        _b32decode(secret), struct.pack(">Q", counter), hashlib.sha1
    ).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % 10**digits).zfill(digits)


class _TotpGuard:
    """±30초 오차를 허용하되, 한 번 쓴 시간 구간(코드)은 다시 받지 않는다 (재전송 공격 방지)."""

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


# ── 세션 목록 ────────────────────────────────────────────────────────────────


class SessionRegistry:
    """서버가 발급한 세션 목록. 쿠키의 세션 ID 는 여기에 SHA-256 으로만 저장한다."""

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
        """계정 정보(비밀번호 · TOTP)의 지문. 느린 해시라 세션 파일이 새도 비밀번호를 역산하기 어렵다."""
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

    def validate(self, sid: str) -> dict | None:
        now = time.time()
        fingerprint = self.fingerprint()
        with self.lock:
            self._load()
            entry = self.data["sessions"].get(self._key(sid))
            if entry is None:
                return None
            reason = None
            if entry.get("fp") != fingerprint:
                reason = "계정 정보 변경"
            elif now - entry.get("created", 0) > SESSION_MAX_AGE:
                reason = "최대 시간 초과"
            elif now - entry.get("seen", 0) > SESSION_IDLE:
                reason = "유휴 시간 초과"
            if reason:
                self.data["sessions"].pop(self._key(sid), None)
                self._save()
                logger.info("세션 만료 · %s", reason)
                return None
            entry["seen"] = now
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
            logger.error("로그인 거부 · %s", problem)
            return False
        # 타이밍 공격을 막기 위해 상수 시간 비교를 쓰고, 아이디와 비밀번호를 모두 끝까지 비교한다.
        user_ok = hmac.compare_digest(username.encode(), _username().encode())
        if _password_hash():
            pass_ok = verify_password_hash(password, _password_hash())
        else:
            pass_ok = hmac.compare_digest(password.encode(), _plain_password().encode())
        if not (user_ok and pass_ok):
            return False
        # 비밀번호가 맞을 때만 코드를 확인한다 (틀린 비밀번호로 유효한 코드를 소모시키지 못하게).
        if _totp_secret():
            return totp_guard.verify(_totp_secret(), otp)
        return True

    @staticmethod
    def start_session(request: Request, username: str) -> None:
        # 세션 고정 공격 방지: 로그인 전 세션 내용을 버리고 새로 발급한다.
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
        """HTTP 요청과 WebSocket 모두에서 쓴다."""
        session = conn.session
        user, sid = session.get("user"), session.get("sid")
        if not (isinstance(user, str) and isinstance(sid, str)):
            return None
        if not hmac.compare_digest(user.encode(), _username().encode()):
            return None
        if sessions.validate(sid) is None:
            return None
        return user

    @staticmethod
    def is_authenticated(request: Request) -> bool:
        return AuthService.current_user(request) is not None

    @staticmethod
    def require_user(request: Request) -> str:
        """API 라우트용 의존성: 로그인하지 않았으면 401."""
        user = AuthService.current_user(request)
        if not user:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return user
