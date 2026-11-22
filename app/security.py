"""HTTP security layer: security headers (CSP etc.), Host allow-list, CSRF (Origin) check, login attempt limiting.

UnivDash handles tmux terminal input, pm2 and git, which effectively equals shell access to the server.
So browser-side attacks (XSS · CSRF · DNS rebinding · clickjacking) are narrowed as far as possible.
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

from app.assets import static_cache_control

logger = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# All scripts, styles and fonts are self-hosted, so no external origin is allowed at all.
# - script-src 'self': no inline scripts, eval or external CDNs (even with an XSS, an injected script does not run)
# - style-src 'unsafe-inline': needed only for element style attributes (progress bar width etc.). Styles cannot run code.
_CSP_BASE = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",  # service worker for web push notifications (/sw.js)
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
    """If SECRET_KEY is empty or an example value, a new random key is used on every start."""
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
            "SECRET_KEY is missing or too short (under 32 characters). A temporary key is generated, so every session expires on restart."
        )
        return secrets.token_urlsafe(48)
    return secret


def allowed_hosts() -> set[str]:
    """ALLOWED_HOSTS=dash.example.com,localhost — when empty, the Host is not checked."""
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
    """Checks that the Origin header (or Referer when absent) matches the request Host.

    Used only for state-changing requests and WebSockets; rejected when both headers are missing.
    (Modern browsers always send Origin on POST and WebSocket. Authentication is by cookie, so there is no non-browser exception.)
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
    """Security headers, Host allow-list, blocking of cross-origin state-changing requests (CSRF) and WebSockets."""

    def __init__(self, app: ASGIApp, hsts: bool = False) -> None:
        self.app = app
        self.hsts = hsts
        self.hosts = allowed_hosts()
        if not self.hosts:
            logger.warning(
                "ALLOWED_HOSTS is empty. Setting the production domain protects against DNS rebinding attacks."
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
                "blocked disallowed Host · host=%s · path=%s",
                headers.get("host"),
                scope.get("path"),
            )
            await self._reject(scope, receive, send, 400, "Bad Request")
            return

        # /llm/v1/ (OpenAI-compatible API) is called by programs, not browsers, so there is no Origin. This path never
        # looks at the login cookie and checks only the Authorization token (app/routes/llm_api/llm_api_routes.py),
        # so it is not a CSRF target.
        token_api = not is_websocket and scope.get("path", "").startswith("/llm/v1/")
        if (
            (is_websocket or scope["method"] in UNSAFE_METHODS)
            and not token_api
            and not is_same_origin(headers)
        ):
            logger.warning(
                "blocked cross-origin request · path=%s · origin=%s",
                scope.get("path"),
                headers.get("origin") or headers.get("referer"),
            )
            await self._reject(scope, receive, send, 403, "Forbidden")
            return

        if is_websocket:
            await self.app(scope, receive, send)
        else:
            await self.app(scope, receive, self._with_headers(send, scope))

    def _with_headers(self, send: Send, scope: Scope | None = None) -> Send:
        cache_control = (
            static_cache_control(
                scope.get("path", ""), scope.get("query_string", b"").decode("latin-1")
            )
            if scope
            else None
        )

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
                    # Only static files may be cached (versioned addresses for a year); pages and API are no-store
                    raw.append((b"cache-control", cache_control or b"no-store"))
                message["headers"] = raw
            await send(message)

        return send_wrapper


class LoginRateLimiter:
    """Limits failed logins to slow down brute-force attacks (in memory).

    Besides the per-key (IP) limit, global_* also limits the total number of failures (against attacks spread over many IPs).
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
        """Seconds left while locked, otherwise 0."""
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
                    "login attempts limited · client=%s · locked for %ss",
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
                    "too many failed logins overall; locking all logins for %ss.",
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
    # Behind a reverse proxy, uvicorn (proxy_headers) fills client from X-Forwarded-For.
    return request.client.host if request.client else "unknown"
