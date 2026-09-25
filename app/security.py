"""HTTP 보안 계층: 보안 헤더(CSP 등), Host 허용 목록, CSRF(Origin) 검사, 로그인 시도 제한.

UnivDash 는 tmux 터미널 입력 · pm2 · git 을 다루므로 사실상 서버 셸 권한과 같다.
그래서 브라우저 쪽 공격(XSS · CSRF · DNS rebinding · 클릭재킹)을 최대한 좁힌다.
"""

import logging
import os
import secrets
import threading
import time
from collections import deque
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# 모든 스크립트 · 스타일 · 폰트를 자체 호스팅하므로 외부 출처를 하나도 허용하지 않는다.
# - script-src 'self': 인라인 스크립트 · eval · 외부 CDN 불가 (XSS 가 생겨도 주입 스크립트가 실행되지 않음)
# - style-src 'unsafe-inline': 요소의 style 속성(진행률 막대 폭 등)에만 필요하다. 스타일은 코드를 실행하지 못한다.
_CSP_BASE = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
]
CONTENT_SECURITY_POLICY = "; ".join(_CSP_BASE)

SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def resolve_secret_key() -> str:
    """SECRET_KEY 가 비었거나 예시 값이면 실행마다 새로운 임의 키를 사용한다."""
    secret = os.getenv("SECRET_KEY", "").strip()
    placeholders = {
        "your-secret-key",
        "your_random_secret_key_here",
        "generate_a_very_long_random_string_here",
        "your-secret-key-here",
        "fallback-secret",
    }
    if len(secret) < 32 or secret in placeholders:
        logger.warning(
            "SECRET_KEY 가 없거나 너무 짧습니다(32자 미만). 임시 키를 생성하므로 재시작하면 모든 세션이 만료됩니다."
        )
        return secrets.token_urlsafe(48)
    return secret


def allowed_hosts() -> set[str]:
    """ALLOWED_HOSTS=dash.example.com,localhost — 비어 있으면 Host 검사를 하지 않는다."""
    return {
        h.strip().lower()
        for h in os.getenv("ALLOWED_HOSTS", "").split(",")
        if h.strip()
    }


def _hostname(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):  # [::1]:8000
        return host.split("]")[0] + "]"
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def is_same_origin(headers: Headers) -> bool:
    """Origin(없으면 Referer) 헤더가 요청 Host 와 같은지 확인한다.

    상태를 바꾸는 요청과 WebSocket 에만 쓰며, 두 헤더가 모두 없으면 거부한다.
    (현대 브라우저는 POST · WebSocket 에 항상 Origin 을 보낸다. 쿠키로 인증하므로 비브라우저 예외를 두지 않는다.)
    """
    source = headers.get("origin") or headers.get("referer")
    if not source or source == "null":
        return False
    host = (headers.get("host") or "").strip().lower()
    try:
        return bool(host) and urlsplit(source).netloc.lower() == host
    except ValueError:
        return False


class SecurityMiddleware:
    """보안 헤더, Host 허용 목록, 교차 출처 상태 변경 요청(CSRF) · WebSocket 차단."""

    def __init__(self, app: ASGIApp, hsts: bool = False) -> None:
        self.app = app
        self.hsts = hsts
        self.hosts = allowed_hosts()
        if not self.hosts:
            logger.warning(
                "ALLOWED_HOSTS 가 비어 있습니다. 운영 도메인을 지정하면 DNS rebinding 공격을 막을 수 있습니다."
            )
        self.headers = dict(SECURITY_HEADERS)
        if hsts:
            self.headers["Strict-Transport-Security"] = (
                "max-age=63072000; includeSubDomains"
            )
            self.headers["Content-Security-Policy"] = (
                CONTENT_SECURITY_POLICY + "; upgrade-insecure-requests"
            )

    async def _reject(
        self, scope: Scope, receive: Receive, send: Send, status: int, text: str
    ) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = PlainTextResponse(text, status_code=status)
        await response(scope, receive, self._with_headers(send))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        is_websocket = scope["type"] == "websocket"

        if self.hosts and _hostname(headers.get("host") or "") not in self.hosts:
            logger.warning(
                "허용되지 않은 Host 차단 · host=%s · path=%s",
                headers.get("host"),
                scope.get("path"),
            )
            await self._reject(scope, receive, send, 400, "Bad Request")
            return

        if (is_websocket or scope["method"] in UNSAFE_METHODS) and not is_same_origin(
            headers
        ):
            logger.warning(
                "교차 출처 요청 차단 · path=%s · origin=%s",
                scope.get("path"),
                headers.get("origin") or headers.get("referer"),
            )
            await self._reject(scope, receive, send, 403, "Forbidden")
            return

        if is_websocket:
            await self.app(scope, receive, send)
        else:
            await self.app(scope, receive, self._with_headers(send))

    def _with_headers(self, send: Send) -> Send:
        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"server"
                ]
                present = {name.lower() for name, _ in raw}
                for name, value in self.headers.items():
                    key = name.lower().encode("latin-1")
                    if key not in present:
                        raw.append((key, value.encode("latin-1")))
                if b"cache-control" not in present:
                    raw.append((b"cache-control", b"no-store"))
                message["headers"] = raw
            await send(message)

        return send_wrapper


class LoginRateLimiter:
    """로그인 실패 횟수를 제한해 무차별 대입 공격을 늦춘다 (메모리 기반).

    키별(IP) 제한과 별개로 global_* 로 전체 실패 횟수도 제한한다 (여러 IP 로 나눈 공격 대비).
    """

    def __init__(
        self,
        max_attempts: int = 5,
        window_seconds: int = 900,
        lockout_seconds: int = 900,
        global_max_attempts: int = 30,
        global_window_seconds: int = 900,
        global_lockout_seconds: int = 900,
    ):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.lockout_seconds = lockout_seconds
        self.global_max_attempts = global_max_attempts
        self.global_window_seconds = global_window_seconds
        self.global_lockout_seconds = global_lockout_seconds
        self._failures: dict[str, deque[float]] = {}
        self._locked_until: dict[str, float] = {}
        self._global_failures: deque[float] = deque()
        self._global_locked_until = 0.0
        self._lock = threading.Lock()

    def retry_after(self, key: str) -> int:
        """잠겨 있으면 남은 초, 아니면 0."""
        with self._lock:
            now = time.monotonic()
            until = max(self._locked_until.get(key, 0), self._global_locked_until)
            remaining = until - now
            if remaining <= 0:
                self._locked_until.pop(key, None)
                return 0
            return int(remaining) + 1

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            failures = self._failures.setdefault(key, deque())
            failures.append(now)
            while failures and now - failures[0] > self.window_seconds:
                failures.popleft()
            if len(failures) >= self.max_attempts:
                self._locked_until[key] = now + self.lockout_seconds
                failures.clear()
                logger.warning(
                    "로그인 시도 제한 · client=%s · %s초 잠금",
                    key,
                    self.lockout_seconds,
                )

            self._global_failures.append(now)
            while (
                self._global_failures
                and now - self._global_failures[0] > self.global_window_seconds
            ):
                self._global_failures.popleft()
            if len(self._global_failures) >= self.global_max_attempts:
                self._global_locked_until = now + self.global_lockout_seconds
                self._global_failures.clear()
                logger.error(
                    "전체 로그인 실패가 너무 많아 %s초 동안 모든 로그인을 잠급니다.",
                    self.global_lockout_seconds,
                )
            if len(self._failures) > 10000:
                self._prune(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)
            self._locked_until.pop(key, None)

    def _prune(self, now: float) -> None:
        for key in [
            k
            for k, v in self._failures.items()
            if not v or now - v[-1] > self.window_seconds
        ]:
            self._failures.pop(key, None)
        for key in [k for k, until in self._locked_until.items() if until <= now]:
            self._locked_until.pop(key, None)


def client_key(request) -> str:
    # 리버스 프록시 뒤라면 uvicorn(proxy_headers)이 X-Forwarded-For 로 client 를 채워준다.
    return request.client.host if request.client else "unknown"
