import base64
import hashlib
import json
import logging
import os
import re
import select
import subprocess
import tempfile
import threading
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

from app import i18n
from app.i18n import N_, _
from app.paths import data_dir, find_command

# Error text when Codex refuses a limits query because of a login problem
_CODEX_LOGIN_ERROR = re.compile(
    r"\b401\b|unauthori[sz]ed|refresh.?token|token.{0,40}(?:expired|revoked|invalid)"
    r"|(?:sign|log).?in\b|authenticat",
    re.IGNORECASE,
)


class AIUsageService:
    """Safely aggregates the local session records of Claude Code and Codex.

    Codex credentials are read only inside the server and never sent to the browser.
    For remaining usage, the current account's limits from the Codex app-server take priority.
    - Claude Code: cachedUsageUtilization in ~/.claude.json (refreshed periodically by the CLI)
    - Codex: app-server account/rateLimits/read (on failure, that account's session logs)

    Limit labels are translated, so every cache that holds them is keyed by the request language.
    """

    _cache: ClassVar[dict[tuple, tuple[float, dict[str, Any]]]] = {}
    _cache_lock = threading.Lock()
    _cache_ttl_seconds = 30
    _max_files_per_provider = 500
    _top_items = 10

    @classmethod
    def get_usage(cls, days: int = 7) -> dict[str, Any]:
        days = max(1, min(days, 30))
        claude_root = cls._data_root("CLAUDE_DATA_DIR", ".claude")
        codex_root = cls._data_root("CODEX_DATA_DIR", ".codex")
        try:
            auth_version = (codex_root / "auth.json").stat().st_mtime_ns
        except OSError:
            auth_version = 0
        try:
            accounts_version = (data_dir() / "codex-accounts").stat().st_mtime_ns
        except OSError:
            accounts_version = 0
        from app.services.accounts import gemini_service

        try:
            gemini_version = gemini_service.token_path().stat().st_mtime_ns
        except OSError:
            gemini_version = 0
        cache_key = (
            days,
            str(claude_root),
            str(codex_root),
            auth_version,
            accounts_version,
            gemini_version,
            i18n.current(),
        )

        with cls._cache_lock:
            cached = cls._cache.get(cache_key)
            if cached and time.monotonic() - cached[0] < cls._cache_ttl_seconds:
                return cached[1]

        now = datetime.now().astimezone()
        dates = [
            (now.date() - timedelta(days=offset)) for offset in range(days - 1, -1, -1)
        ]
        cutoff = datetime.combine(dates[0], datetime.min.time(), tzinfo=now.tzinfo)

        claude = cls._collect_claude(claude_root, cutoff, dates, now)
        accounts = cls.accounts()
        claude["account"] = accounts["claude"]
        claude.update(cls._claude_login_state(claude_root))
        codex_summaries = []
        for index, account in enumerate(cls._saved_codex_accounts(codex_root)):
            codex = cls._collect_codex(
                codex_root, cutoff, dates, now, user_id=account["user_id"]
            )
            codex["account"] = account["email"]
            codex["active"] = account["active"]
            codex["name"] = "Codex"
            codex["accent"] = ("#10a37f", "#60a5fa", "#a78bfa", "#f59e0b")[index % 4]
            live = (
                cls._live_codex_limits(codex_root, now)
                if account["active"]
                else cls._saved_codex_limits(account["path"], now)
            )
            codex["limits"] = live or codex["limits"]
            codex["login_expired"] = account["email"] in cls._codex_login_problems
            codex_summaries.append(codex)
        # Old Codex logs carry no account ID, so the account cannot be determined safely.
        # They are shown as a separate record instead of being added to an arbitrary account.
        unknown = cls._collect_codex(
            codex_root, cutoff, dates, now, unassigned_only=True
        )
        if unknown["has_data"]:
            unknown.update(
                {
                    "account": _("계정 미확인 (이전 기록)"),
                    "unknown": True,  # stable flag: the account text above is translated
                    "active": False,
                    "accent": "#94a3b8",
                    "limits": None,
                }
            )
            codex_summaries.append(unknown)
        if not codex_summaries:
            codex = cls._collect_codex(codex_root, cutoff, dates, now)
            codex["account"] = accounts["codex"]
            codex["limits"] = cls._live_codex_limits(codex_root, now) or codex["limits"]
            codex["login_expired"] = accounts["codex"] in cls._codex_login_problems
            codex_summaries.append(codex)
        try:
            from app.services.accounts import claude_accounts

            saved_claude = claude_accounts.saved_limits(now)
        except Exception:  # the page is shown even without the saved accounts' limits
            logging.getLogger(__name__).exception(
                "Failed to read limits of saved Claude accounts"
            )
            saved_claude = []
        claude["active"] = True if saved_claude else None
        gemini = cls._collect_gemini(cutoff, dates, now)
        gemini["account"] = accounts.get("gemini")
        try:
            from app.services.accounts import gemini_accounts

            saved_gemini = gemini_accounts.saved_limits(now)
        except Exception:  # the page is shown even without the saved accounts' limits
            logging.getLogger(__name__).exception(
                "Failed to read limits of saved Gemini accounts"
            )
            saved_gemini = []
        gemini["active"] = True if saved_gemini else None
        result = {
            "generated_at": now.isoformat(),
            "window_days": days,
            "providers": [claude, *codex_summaries, gemini],
            # Claude accounts that are not signed in now: limits only (local records do not tell accounts apart)
            "claude_accounts": saved_claude,
            "gemini_accounts": saved_gemini,
        }

        with cls._cache_lock:
            cls._cache[cache_key] = (time.monotonic(), result)
        return result

    # language → (time, auth version, result); set to None to invalidate
    _limits_cache: ClassVar[dict[str, tuple[float, int, dict]] | None] = None
    # (root, auth mtime, language) → (time, limits)
    _codex_live_cache: ClassVar[
        dict[tuple[str, int, str], tuple[float, dict[str, Any]]]
    ] = {}
    # (path, language) → (mtime, time, limits)
    _codex_saved_limits_cache: ClassVar[
        dict[tuple[str, str], tuple[int, float, dict[str, Any]]]
    ] = {}

    # Emails of Codex accounts · the tail of the Claude token that the server refused to log in (cleared when a later query succeeds)
    _codex_login_problems: ClassVar[set[str]] = set()
    _claude_rejected_token: str | None = None

    @classmethod
    def limits(cls) -> dict[str, Any]:
        """Just the remaining limits, lightweight (for the Workspace header gauges, cached 30 seconds). Only the tail of session logs is read."""
        codex_root = cls._data_root("CODEX_DATA_DIR", ".codex")
        try:
            auth_version = (codex_root / "auth.json").stat().st_mtime_ns
        except OSError:
            auth_version = 0
        lang = i18n.current()
        cached = (cls._limits_cache or {}).get(lang)
        if cached and cached[1] == auth_version and time.monotonic() - cached[0] < 30:
            return cached[2]
        now = datetime.now().astimezone()
        claude = cls._claude_limits(cls._data_root("CLAUDE_DATA_DIR", ".claude"), now)
        codex = cls._live_codex_limits(codex_root, now)
        sessions = codex_root / "sessions"
        user_id = cls._codex_user_id(codex_root)
        try:
            newest = (
                sorted(
                    sessions.rglob("rollout-*.jsonl"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )[:3]
                if sessions.is_dir()
                else []
            )
        except OSError:
            newest = []
        if codex is None:
            for path in newest:
                if user_id and cls._codex_log_owner(path) != user_id:
                    continue
                found = cls._tail_rate_limits(path)
                if found:
                    codex = cls._codex_limits(found[1], found[0], now)
                    break
        from app.services.accounts import gemini_service

        try:
            gemini = gemini_service.limits(now)
        except (
            Exception
        ):  # the rest is shown even if the Gemini limits could not be read
            logging.getLogger(__name__).exception("Failed to read Gemini limits")
            gemini = None
        result = {
            "claude": claude,
            "codex": codex,
            "gemini": gemini,
            "accounts": cls.accounts(),
            "generated_at": now.isoformat(),
        }
        try:
            current_auth_version = (codex_root / "auth.json").stat().st_mtime_ns
        except OSError:
            current_auth_version = 0
        if current_auth_version == auth_version:
            cache = cls._limits_cache or {}
            cache[lang] = (time.monotonic(), auth_version, result)
            cls._limits_cache = cache
        return result

    @classmethod
    def accounts(cls) -> dict[str, str | None]:
        """Only the emails of the signed-in accounts (secrets such as tokens · keys are never sent out).

        Claude Code: oauthAccount.emailAddress in ~/.claude.json
        Codex: the email inside the id_token (JWT) in ~/.codex/auth.json — display only, so the signature is not verified.
        """
        from app.services.accounts import gemini_service

        try:
            gemini = gemini_service.account_email()
        except Exception:  # the rest is shown even if the email is unknown
            gemini = None
        return {
            "claude": cls._claude_account(cls._data_root("CLAUDE_DATA_DIR", ".claude")),
            "codex": cls._codex_account(cls._data_root("CODEX_DATA_DIR", ".codex")),
            "gemini": gemini,
        }

    @classmethod
    def _collect_gemini(
        cls, cutoff: datetime, dates: list[Any], now: datetime
    ) -> dict[str, Any]:
        """Gemini (Antigravity CLI): collects the token counts recorded at each response step of the conversation logs."""
        from app.services.accounts import gemini_service

        root = gemini_service.root()
        files = gemini_service.recent_logs(cutoff, cls._max_files_per_provider)
        summary = cls._empty_summary(
            provider_id="gemini",
            name="Gemini",
            accent="#4285f4",
            command="agy",
            auth_files=[gemini_service.token_path(root)],
            env_keys=[],
            files=files,
            dates=dates,
        )
        stats = _Stats()
        for path in files:
            fallback_time = cls._mtime(path)
            # brain/<conversation ID>/.system_generated/logs/…
            session = path.parents[2].name
            cwd = gemini_service.workspace(session)
            for record in cls._read_jsonl(path):
                if record.get("type") != "PLANNER_RESPONSE":
                    continue
                # input_tokens excludes what was read from the cache
                input_tokens = cls._as_int(record.get("input_tokens"))
                output_tokens = cls._as_int(record.get("output_tokens"))
                cache_read = cls._as_int(record.get("cache_read_tokens"))
                reasoning = cls._as_int(record.get("thinking_tokens"))
                total_tokens = input_tokens + output_tokens + cache_read
                if total_tokens <= 0:
                    continue
                timestamp = cls._parse_timestamp(
                    record.get("created_at"), fallback_time
                )
                if not cls._add_usage(
                    summary,
                    timestamp,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read=cache_read,
                    cache_write=0,
                    total_tokens=total_tokens,
                    reasoning_tokens=reasoning,
                ):
                    continue
                stats.add(
                    model=record.get("model"),
                    project=Path(cwd).name if cwd else None,
                    session=session,
                    tokens=total_tokens,
                )
        stats.apply(summary, cls._top_items)
        prompt_tokens = summary["input_tokens"] + summary["cache_read_tokens"]
        summary["cache_hit_rate"] = (
            summary["cache_read_tokens"] / prompt_tokens if prompt_tokens else None
        )
        try:
            summary["limits"] = gemini_service.limits(now)
        except Exception:
            logging.getLogger(__name__).exception("Failed to read Gemini limits")
            summary["limits"] = None
        summary["logged_in"] = gemini_service.logged_in()
        return cls._finalize_summary(summary, now)

    @classmethod
    def _claude_account(cls, root: Path) -> str | None:
        config_file = cls._claude_config_file(root)
        if not config_file:
            return None
        try:
            with config_file.open("r", encoding="utf-8") as handle:
                account = (json.load(handle) or {}).get("oauthAccount")
        except (OSError, ValueError, AttributeError):
            return None
        email = account.get("emailAddress") if isinstance(account, dict) else None
        return cls._clean_email(email)

    @classmethod
    def _codex_account(cls, root: Path) -> str | None:
        claims = cls._codex_claims(root)
        return cls._clean_email(claims.get("email"))

    @classmethod
    def _codex_user_id(cls, root: Path) -> str | None:
        return cls._codex_user_id_from_claims(cls._codex_claims(root))

    @staticmethod
    def _codex_user_id_from_claims(claims: dict) -> str | None:
        value = claims.get("https://api.openai.com/auth")
        user_id = value.get("chatgpt_user_id") if isinstance(value, dict) else None
        return user_id if isinstance(user_id, str) and user_id else None

    @staticmethod
    def _codex_claims(root: Path) -> dict:
        try:
            with (root / "auth.json").open("r", encoding="utf-8") as handle:
                auth = json.load(handle)
        except (OSError, ValueError):
            return {}
        return AIUsageService._codex_claims_from_auth(auth)

    @staticmethod
    def _codex_claims_from_auth(auth: dict) -> dict:
        try:
            tokens = auth.get("tokens") if isinstance(auth, dict) else None
            id_token = tokens.get("id_token") if isinstance(tokens, dict) else None
            if not isinstance(id_token, str) or id_token.count(".") != 2:
                return {}
            payload = id_token.split(".")[1]
            claims = json.loads(
                base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
            )
        except (ValueError, AttributeError, TypeError):
            return {}
        return claims if isinstance(claims, dict) else {}

    @classmethod
    def _saved_codex_accounts(cls, root: Path) -> list[dict[str, Any]]:
        active_email = cls._codex_account(root)
        accounts = []
        store = data_dir() / "codex-accounts"
        if store.is_dir():
            for path in store.glob("*.json"):
                if not re.fullmatch(r"[0-9a-f]{12}\.json", path.name):
                    continue
                try:
                    with path.open("r", encoding="utf-8") as handle:
                        record = json.load(handle)
                    claims = cls._codex_claims_from_auth(record.get("auth"))
                except (OSError, ValueError, AttributeError):
                    continue
                email = cls._clean_email(claims.get("email"))
                user_id = cls._codex_user_id_from_claims(claims)
                if (
                    not email
                    or not user_id
                    or hashlib.sha256(email.lower().encode()).hexdigest()[:12]
                    != path.stem
                ):
                    continue
                accounts.append(
                    {
                        "email": email,
                        "user_id": user_id,
                        "active": email == active_email,
                        "path": path,
                    }
                )
        if active_email and not any(a["active"] for a in accounts):
            user_id = cls._codex_user_id(root)
            if user_id:
                accounts.append(
                    {
                        "email": active_email,
                        "user_id": user_id,
                        "active": True,
                        "path": None,
                    }
                )
        accounts.sort(key=lambda a: (not a["active"], a["email"].lower()))
        return accounts

    @classmethod
    def _saved_codex_limits(cls, path: Path, now: datetime) -> dict[str, Any] | None:
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            return None
        saved_key = (str(path), i18n.current())
        with cls._cache_lock:
            cached = cls._codex_saved_limits_cache.get(saved_key)
            if cached and cached[0] == mtime and time.monotonic() - cached[1] < 30:
                return cached[2]
        try:
            with path.open("r", encoding="utf-8") as handle:
                record = json.load(handle)
            auth = record.get("auth")
            if not isinstance(auth, dict):
                return None
            with tempfile.TemporaryDirectory(
                prefix="univdash-codex-usage-"
            ) as temporary:
                auth_file = Path(temporary) / "auth.json"
                fd = os.open(auth_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(auth, handle)
                limits = cls._live_codex_limits(Path(temporary), now, use_cache=False)
                updated_auth = json.loads(auth_file.read_text(encoding="utf-8"))
            if updated_auth != auth:
                from app.services.accounts import codex_accounts

                codex_accounts.refresh_saved_auth(path.stem, auth, updated_auth)
                mtime = path.stat().st_mtime_ns
        except (OSError, ValueError, AttributeError):
            return None
        if limits is not None:
            with cls._cache_lock:
                cls._codex_saved_limits_cache[saved_key] = (
                    mtime,
                    time.monotonic(),
                    limits,
                )
        return limits

    @staticmethod
    def _codex_log_owner(path: Path) -> str | None:
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = (json.loads(handle.readline()) or {}).get("payload")
        except (OSError, ValueError, AttributeError):
            return None
        owner = payload.get("creator_user_id") if isinstance(payload, dict) else None
        return owner if isinstance(owner, str) else None

    @classmethod
    def _live_codex_limits(
        cls, root: Path, now: datetime, use_cache: bool = True
    ) -> dict[str, Any] | None:
        """Reads the limits of the currently signed-in account directly from the Codex app-server."""
        try:
            auth_file = root / "auth.json"
            auth_mtime = auth_file.stat().st_mtime_ns
            with auth_file.open("r", encoding="utf-8") as handle:
                auth = json.load(handle)
            account_id = (auth.get("tokens") or {}).get("account_id")
        except (OSError, ValueError, AttributeError):
            return None
        if not isinstance(account_id, str) or not account_id:
            return None
        email = cls._clean_email(cls._codex_claims_from_auth(auth).get("email"))
        cache_key = (str(root), auth_mtime, i18n.current())
        if use_cache:
            with cls._cache_lock:
                cached = cls._codex_live_cache.get(cache_key)
                if cached and time.monotonic() - cached[0] < 15:
                    return cached[1]

        codex = find_command("codex")
        if not codex:
            return None
        env = os.environ.copy()
        env["CODEX_HOME"] = str(root)
        env.pop("OPENAI_API_KEY", None)
        env.pop("CODEX_API_KEY", None)
        messages = (
            {
                "method": "initialize",
                "id": 0,
                "params": {
                    "clientInfo": {
                        "name": "univdash",
                        "title": "UnivDash",
                        "version": "0.2.0",
                    }
                },
            },
            {"method": "initialized", "params": {}},
            {"method": "account/rateLimits/read", "id": 1},
        )
        process = None
        try:
            process = subprocess.Popen(
                [codex, "app-server"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=env,
            )
            for message in messages:
                process.stdin.write((json.dumps(message) + "\n").encode())
            process.stdin.flush()
            pending = b""
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and len(pending) < 1024 * 1024:
                ready, _writable, _errors = select.select(
                    [process.stdout], [], [], max(0, deadline - time.monotonic())
                )
                if not ready:
                    break
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    try:
                        response = json.loads(raw)
                    except ValueError:
                        continue
                    if response.get("id") != 1:
                        continue
                    error = response.get("error")
                    if (
                        email
                        and isinstance(error, dict)
                        and _CODEX_LOGIN_ERROR.search(str(error.get("message") or ""))
                    ):
                        cls._codex_login_problems.add(email)
                    result = response.get("result")
                    if (
                        not isinstance(result, dict)
                        or result.get("accountId") != account_id
                    ):
                        return None
                    snapshot = result.get("rateLimits")
                    if not isinstance(snapshot, dict):
                        return None

                    def window(value):
                        if not isinstance(value, dict):
                            return None
                        return {
                            "used_percent": value.get("usedPercent"),
                            "window_minutes": value.get("windowDurationMins"),
                            "resets_at": value.get("resetsAt"),
                        }

                    credits = snapshot.get("credits")
                    normalized = {
                        "primary": window(snapshot.get("primary")),
                        "secondary": window(snapshot.get("secondary")),
                        "plan_type": snapshot.get("planType"),
                        "rate_limit_reached_type": snapshot.get("rateLimitReachedType"),
                        "credits": {
                            "has_credits": credits.get("hasCredits"),
                            "unlimited": credits.get("unlimited"),
                            "balance": credits.get("balance"),
                        }
                        if isinstance(credits, dict)
                        else None,
                    }
                    limits = cls._codex_limits(normalized, now, now)
                    cls._codex_login_problems.discard(email)
                    if use_cache and auth_file.stat().st_mtime_ns != auth_mtime:
                        return None
                    if use_cache:
                        with cls._cache_lock:
                            # keep only this login's entries (one per language)
                            cls._codex_live_cache = {
                                **{
                                    key: value
                                    for key, value in cls._codex_live_cache.items()
                                    if key[:2] == cache_key[:2]
                                },
                                cache_key: (time.monotonic(), limits),
                            }
                    return limits
        except (OSError, ValueError, AttributeError):
            return None
        finally:
            if process is not None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        return None

    @staticmethod
    def _clean_email(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        value = value.strip()
        return (
            value
            if re.fullmatch(r"[^\s@<>\"']{1,64}@[^\s@<>\"']{1,190}", value)
            else None
        )

    @classmethod
    def _tail_rate_limits(
        cls, path: Path, size: int = 2 * 1024 * 1024
    ) -> tuple[datetime, dict[str, Any]] | None:
        try:
            with path.open("rb") as handle:
                handle.seek(max(0, path.stat().st_size - size))
                lines = handle.read().decode("utf-8", errors="replace").splitlines()
        except OSError:
            return None
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload")
            if isinstance(payload, dict) and isinstance(
                payload.get("rate_limits"), dict
            ):
                return cls._parse_timestamp(
                    record.get("timestamp"), cls._mtime(path)
                ), payload["rate_limits"]
        return None

    @staticmethod
    def _data_root(env_name: str, default_dir: str) -> Path:
        configured = os.getenv(env_name)
        return (
            Path(configured).expanduser() if configured else Path.home() / default_dir
        )

    # ── Claude Code ─────────────────────────────────────────────────────
    @classmethod
    def _collect_claude(
        cls, root: Path, cutoff: datetime, dates: list[Any], now: datetime
    ) -> dict[str, Any]:
        files = cls._recent_jsonl_files(root / "projects", cutoff)
        summary = cls._empty_summary(
            provider_id="claude",
            name="Claude Code",
            accent="#d97757",
            command="claude",
            auth_files=[root / ".credentials.json", root / "credentials.json"],
            env_keys=["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            files=files,
            dates=dates,
        )
        stats = _Stats()

        for path in files:
            fallback_time = cls._mtime(path)
            # Claude Code writes one line per content block of a response, repeating the same usage.
            # Without de-duplicating by (message.id, requestId) the tokens are counted nearly twice.
            # Mid-stream lines can have a small output_tokens, so the largest value per message is kept.
            entries: dict[
                Any, tuple[dict[str, Any], dict[str, Any], dict[str, Any]]
            ] = {}
            for index, record in enumerate(cls._read_jsonl(path)):
                message = record.get("message")
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    continue
                message_id = message.get("id")
                key: Any = (
                    (message_id, str(record.get("requestId") or ""))
                    if isinstance(message_id, str) and message_id
                    else index
                )
                previous = entries.get(key)
                if previous is None or cls._as_int(
                    usage.get("output_tokens")
                ) >= cls._as_int(previous[2].get("output_tokens")):
                    entries[key] = (record, message, usage)

            for record, message, usage in entries.values():
                input_tokens = cls._as_int(usage.get("input_tokens"))
                output_tokens = cls._as_int(usage.get("output_tokens"))
                cache_write = cls._as_int(usage.get("cache_creation_input_tokens"))
                cache_read = cls._as_int(usage.get("cache_read_input_tokens"))
                total_tokens = input_tokens + output_tokens + cache_write + cache_read
                if total_tokens <= 0:
                    continue

                timestamp = cls._parse_timestamp(record.get("timestamp"), fallback_time)
                if not cls._add_usage(
                    summary,
                    timestamp,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read=cache_read,
                    cache_write=cache_write,
                    total_tokens=total_tokens,
                ):
                    continue

                session_id = record.get("sessionId") or record.get("session_id")
                session_key = (
                    session_id
                    if isinstance(session_id, str) and session_id
                    else str(path)
                )
                cwd = record.get("cwd")
                stats.add(
                    model=message.get("model"),
                    project=Path(cwd).name if isinstance(cwd, str) and cwd else None,
                    session=session_key,
                    tokens=total_tokens,
                )

        stats.apply(summary, cls._top_items)
        # Claude's input_tokens excludes the cache, so the ratio of cache reads to the whole input is used.
        prompt_tokens = (
            summary["input_tokens"]
            + summary["cache_read_tokens"]
            + summary["cache_write_tokens"]
        )
        summary["cache_hit_rate"] = (
            summary["cache_read_tokens"] / prompt_tokens if prompt_tokens else None
        )
        summary["limits"] = cls._claude_limits(root, now)
        return cls._finalize_summary(summary, now)

    @classmethod
    def _claude_config_file(cls, root: Path) -> Path | None:
        candidates = [root / ".claude.json"]
        if root.name == ".claude":
            candidates.append(root.parent / ".claude.json")
        return next((path for path in candidates if path.is_file()), None)

    @classmethod
    def _claude_limits(cls, root: Path, now: datetime) -> dict[str, Any] | None:
        config_file = cls._claude_config_file(root)
        if not config_file:
            return None
        try:
            with config_file.open("r", encoding="utf-8") as handle:
                config = json.load(handle)
        except (OSError, ValueError):
            return None
        if not isinstance(config, dict):
            return None

        cached = config.get("cachedUsageUtilization")
        account = config.get("oauthAccount")
        tier = (
            account.get("organizationRateLimitTier")
            if isinstance(account, dict)
            else None
        )
        # If the usage cache left by Claude Code is missing (it is cleared on an account switch) or old, fetch it directly
        fetched_ms = cached.get("fetchedAtMs") if isinstance(cached, dict) else None
        stale = (
            not isinstance(fetched_ms, (int, float))
            or time.time() - fetched_ms / 1000 > 300
        )
        if (
            not isinstance(cached, dict)
            or not isinstance(cached.get("utilization"), dict)
            or stale
        ):
            live = cls._fetch_claude_usage(root)
            if live and (
                not isinstance(fetched_ms, (int, float))
                or live["fetchedAtMs"] > fetched_ms
            ):
                cached = live
        if not isinstance(cached, dict):
            return None
        if not tier or tier == "default_claude_ai":
            tier = cls._claude_subscription(root) or tier
        return cls._claude_limits_from(cached, tier, now)

    @classmethod
    def _claude_limits_from(
        cls, cached: dict, tier: Any, now: datetime
    ) -> dict[str, Any] | None:
        """{utilization, fetchedAtMs} → the limits to show on screen."""
        utilization = cached.get("utilization")
        if not isinstance(utilization, dict):
            return None

        windows = []
        limits = utilization.get("limits")
        if isinstance(limits, list):
            for item in limits:
                if not isinstance(item, dict):
                    continue
                kind = item.get("kind")
                scope = item.get("scope") if isinstance(item.get("scope"), dict) else {}
                model = (
                    scope.get("model") if isinstance(scope.get("model"), dict) else {}
                )
                model_name = model.get("display_name")
                if kind == "session":
                    label, minutes = _("현재 세션"), 300
                elif kind == "weekly_all":
                    label, minutes = _("주간 · 전체 모델"), 10080
                elif kind == "weekly_scoped":
                    label = (
                        _("주간 · {model}", model=model_name)
                        if model_name
                        else _("주간 · 특정 모델")
                    )
                    minutes = 10080
                else:
                    label = str(item.get("group") or kind or _("한도"))
                    minutes = 10080 if item.get("group") == "weekly" else None
                windows.append(
                    cls._window(
                        f"claude-{kind}-{model_name or ''}",
                        label,
                        item.get("percent"),
                        item.get("resets_at"),
                        minutes,
                        now,
                        active=bool(item.get("is_active")),
                    )
                )
        if not windows:
            # Older CLI format: five_hour / seven_day
            for key, label, minutes in (
                ("five_hour", N_("현재 세션"), 300),
                ("seven_day", N_("주간 · 전체 모델"), 10080),
                ("seven_day_opus", N_("주간 · Opus"), 10080),
                ("seven_day_sonnet", N_("주간 · Sonnet"), 10080),
            ):
                value = utilization.get(key)
                if isinstance(value, dict) and value.get("utilization") is not None:
                    windows.append(
                        cls._window(
                            f"claude-{key}",
                            _(label),
                            value.get("utilization"),
                            value.get("resets_at"),
                            minutes,
                            now,
                        )
                    )

        # Some accounts do not report a 5-hour (session) limit (five_hour: null · no session in limits — e.g. Max 20x).
        # A missing slot looks broken, so it is shown as "unlimited" (the `unlimited` flag; the screen writes the text).
        if windows and not any(w.get("window_minutes") == 300 for w in windows):
            session = cls._window(
                "claude-session-none", _("현재 세션"), 0, None, 300, now
            )
            session["unlimited"] = True
            windows.insert(0, session)

        breakdown = []
        raw_breakdown = utilization.get("seven_day_breakdown")
        if isinstance(raw_breakdown, dict) and isinstance(
            raw_breakdown.get("rows"), list
        ):
            for row in raw_breakdown["rows"]:
                if isinstance(row, dict) and row.get("display_name"):
                    breakdown.append(
                        {
                            "name": str(row["display_name"]),
                            "percent": cls._as_float(row.get("percent")),
                        }
                    )

        fetched_ms = cached.get("fetchedAtMs")
        updated_at = None
        if isinstance(fetched_ms, (int, float)):
            updated_at = (
                datetime.fromtimestamp(fetched_ms / 1000, tz=UTC)
                .astimezone()
                .isoformat()
            )
        return {
            "plan": cls._claude_plan_label(tier),
            "updated_at": updated_at,
            "windows": windows,
            "breakdown": breakdown,
            "credits": None,
        }

    _claude_usage_cache: tuple[float, str, dict | None] | None = None

    @classmethod
    def _claude_credentials(cls, root: Path) -> dict | None:
        """Only reads the login token file (never writes it)."""
        try:
            data = json.loads((root / ".credentials.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        return oauth if isinstance(oauth, dict) else None

    @classmethod
    def _claude_subscription(cls, root: Path) -> str | None:
        oauth = cls._claude_credentials(root) or {}
        kind = oauth.get("subscriptionType")
        return f"subscription_{kind}" if isinstance(kind, str) and kind else None

    @classmethod
    def _claude_login_state(cls, root: Path) -> dict[str, bool]:
        """login_expired: a new sign-in is certainly needed / login_stale: the token is past its expiry.

        A running Claude refreshes an expired token by itself, so expiry alone is not taken as a lost login
        (refreshing it here instead would change the token and could break the running Claude's login).
        """
        oauth = cls._claude_credentials(root) or {}
        token = oauth.get("accessToken")
        expires = oauth.get("expiresAt")
        past = isinstance(expires, (int, float)) and expires / 1000 < time.time()
        if not isinstance(token, str) or not token:
            return {"login_expired": True, "login_stale": False}
        rejected = cls._claude_rejected_token == token[-12:]
        no_refresh = past and not oauth.get("refreshToken")
        return {"login_expired": rejected or no_refresh, "login_stale": past}

    # The usage API answers 429 as soon as requests bunch up a little (running Claude Code windows call it with the same account too).
    # → The last value received is kept per account (also in a file) and, on failure, shown as "as of N minutes ago".
    #   While 429s · network errors continue, the interval between queries grows.
    USAGE_FRESH = 60.0  # no new query while a value newer than this exists
    USAGE_BACKOFF_MAX = 600.0
    # account → {utilization, fetchedAtMs}
    _claude_usage_good: ClassVar[dict[str, dict] | None] = None
    # account → (when to ask again, interval)
    _claude_usage_wait: ClassVar[dict[str, tuple[float, float]]] = {}
    _claude_usage_lock = threading.Lock()

    @staticmethod
    def _usage_cache_file() -> Path:
        return data_dir() / "claude-usage-cache.json"

    @classmethod
    def _usage_good(cls) -> dict[str, dict]:
        if cls._claude_usage_good is None:
            try:
                data = json.loads(cls._usage_cache_file().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            cls._claude_usage_good = {
                key: value
                for key, value in (data if isinstance(data, dict) else {}).items()
                if isinstance(value, dict)
                and isinstance(value.get("utilization"), dict)
                and isinstance(value.get("fetchedAtMs"), (int, float))
            }
        return cls._claude_usage_good

    @classmethod
    def _store_usage_good(cls, key: str, entry: dict) -> None:
        good = cls._usage_good()
        good[key] = entry
        if len(good) > 50:
            for old in sorted(good, key=lambda k: good[k]["fetchedAtMs"])[:-50]:
                good.pop(old, None)
        path = cls._usage_cache_file()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".claude-usage.")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(good, handle)
            os.chmod(temp, 0o600)
            os.replace(temp, path)
        except OSError:
            pass

    @classmethod
    def claude_usage(cls, key: str, token: str) -> tuple[dict | None, int | None]:
        """(usage {utilization, fetchedAtMs} of account `key`, the HTTP status received this time — None if not asked or on a network error).

        If nothing new could be fetched, the last received value is returned (None if there is none).
        """
        with cls._claude_usage_lock:
            last = cls._usage_good().get(key)
            now = time.time()
            if last and now - last["fetchedAtMs"] / 1000 < cls.USAGE_FRESH:
                return last, None
            wait_until, delay = cls._claude_usage_wait.get(key, (0.0, 0.0))
            if now < wait_until:
                return last, None
            status, result = cls._request_claude_usage(token)
            if status == 200 and result:
                entry = {"utilization": result, "fetchedAtMs": now * 1000}
                cls._claude_usage_wait.pop(key, None)
                cls._store_usage_good(key, entry)
                return entry, status
            delay = min(cls.USAGE_BACKOFF_MAX, max(30.0, delay * 2))
            cls._claude_usage_wait[key] = (now + delay, delay)
            return last, status

    @classmethod
    def _claude_usage_key(cls, root: Path, token: str) -> str:
        """The same value for the same account even after a token refresh (so another account's usage is never shown)."""
        config_file = cls._claude_config_file(root)
        try:
            with config_file.open("r", encoding="utf-8") as handle:  # type: ignore[union-attr]
                account = (json.load(handle) or {}).get("oauthAccount")
        except (OSError, ValueError, AttributeError):
            account = None
        if isinstance(account, dict) and account.get("accountUuid"):
            return (
                f"acct:{account['accountUuid']}:{account.get('organizationUuid') or ''}"
            )
        return f"token:{hashlib.sha256(token.encode()).hexdigest()[:16]}"

    @classmethod
    def _fetch_claude_usage(cls, root: Path) -> dict | None:
        """Fetches the remaining limits the same way Claude Code does (GET /api/oauth/usage). {utilization, fetchedAtMs}

        If the token has expired it is not refreshed and only the last value is used — a refresh would change the token and could break the running Claude's login.
        """
        oauth = cls._claude_credentials(root) or {}
        token = oauth.get("accessToken")
        expires = oauth.get("expiresAt")
        if not isinstance(token, str) or not token:
            return None
        key = cls._claude_usage_key(root, token)
        if isinstance(expires, (int, float)) and expires / 1000 < time.time() + 60:
            with cls._claude_usage_lock:
                return cls._usage_good().get(key)
        # Right after a login · account switch: ask immediately without waiting
        if cls._claude_usage_cache is None:
            with cls._claude_usage_lock:
                cls._claude_usage_wait.pop(key, None)
        result, status = cls.claude_usage(key, token)
        cls._claude_usage_cache = (time.monotonic(), key, result)
        if status == 401:
            cls._claude_rejected_token = token[-12:]
        elif status == 200:
            cls._claude_rejected_token = None
        return result

    @staticmethod
    def _request_claude_usage(token: str) -> tuple[int | None, dict | None]:
        """(HTTP status · None on a network error, usage) — read only, the token is not refreshed."""
        try:
            import httpx

            response = httpx.get(
                "https://api.anthropic.com/api/oauth/usage",
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": "oauth-2025-04-20",
                    "Content-Type": "application/json",
                },
                timeout=8,
                follow_redirects=False,
            )
        except Exception:  # noqa: BLE001 — on a network error it is simply not shown
            return None, None
        result = None
        if response.status_code == 200:
            try:
                data = response.json()
            except ValueError:
                data = None
            result = data if isinstance(data, dict) else None
        return response.status_code, result

    @staticmethod
    def _claude_plan_label(tier: Any) -> str | None:
        if not isinstance(tier, str) or not tier:
            return None
        match = re.search(r"max_(\d+)x", tier)
        if match:
            return f"Max {match.group(1)}x"
        for key, label in (
            ("pro", "Pro"),
            ("max", "Max"),
            ("team", "Team"),
            ("enterprise", "Enterprise"),
        ):
            if key in tier:
                return label
        return None

    # ── Codex ───────────────────────────────────────────────────────────
    @classmethod
    def _collect_codex(
        cls,
        root: Path,
        cutoff: datetime,
        dates: list[Any],
        now: datetime,
        user_id: str | None = None,
        unassigned_only: bool = False,
    ) -> dict[str, Any]:
        files = cls._recent_jsonl_files(root / "sessions", cutoff)
        if unassigned_only:
            files = [path for path in files if cls._codex_log_owner(path) is None]
        elif user_id:
            files = [path for path in files if cls._codex_log_owner(path) == user_id]
        else:
            user_id = cls._codex_user_id(root)
            if user_id:
                files = [
                    path for path in files if cls._codex_log_owner(path) == user_id
                ]
        summary = cls._empty_summary(
            provider_id="codex",
            name="Codex",
            accent="#10a37f",
            command="codex",
            auth_files=[root / "auth.json"],
            env_keys=["OPENAI_API_KEY"],
            files=files,
            dates=dates,
        )
        stats = _Stats()
        latest_limits: tuple[datetime, dict[str, Any]] | None = None

        for path in files:
            fallback_time = cls._mtime(path)
            previous_total: dict[str, int] | None = None
            session_id: str | None = None
            project: str | None = None
            model: str | None = None

            for record in cls._read_jsonl(path):
                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue

                record_type = record.get("type")
                payload_type = payload.get("type")
                if record_type == "session_meta":
                    candidate = payload.get("id")
                    if isinstance(candidate, str) and candidate:
                        session_id = candidate
                    cwd = payload.get("cwd")
                    if isinstance(cwd, str) and cwd:
                        project = Path(cwd).name
                    continue
                if record_type == "turn_context":
                    candidate = payload.get("model")
                    if isinstance(candidate, str) and candidate:
                        model = candidate
                    continue
                if record_type != "event_msg" or payload_type != "token_count":
                    continue

                timestamp = cls._parse_timestamp(record.get("timestamp"), fallback_time)
                rate_limits = payload.get("rate_limits")
                if isinstance(rate_limits, dict) and (
                    latest_limits is None or timestamp > latest_limits[0]
                ):
                    latest_limits = (timestamp, rate_limits)

                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                current_total = info.get("total_token_usage")
                if not isinstance(current_total, dict):
                    continue

                normalized = {
                    "input": cls._as_int(current_total.get("input_tokens")),
                    "output": cls._as_int(current_total.get("output_tokens")),
                    "cache": cls._as_int(current_total.get("cached_input_tokens")),
                    "reasoning": cls._as_int(
                        current_total.get("reasoning_output_tokens")
                    ),
                    "total": cls._as_int(current_total.get("total_tokens")),
                }
                if normalized["total"] <= 0:
                    normalized["total"] = normalized["input"] + normalized["output"]

                if (
                    previous_total is None
                    or normalized["total"] < previous_total["total"]
                ):
                    delta = normalized
                else:
                    delta = {
                        key: max(normalized[key] - previous_total[key], 0)
                        for key in normalized
                    }
                previous_total = normalized

                if delta["total"] <= 0:
                    continue
                if not cls._add_usage(
                    summary,
                    timestamp,
                    input_tokens=delta["input"],
                    output_tokens=delta["output"],
                    cache_read=delta["cache"],
                    cache_write=0,
                    reasoning_tokens=delta["reasoning"],
                    total_tokens=delta["total"],
                ):
                    continue
                stats.add(
                    model=model,
                    project=project,
                    session=session_id or str(path),
                    tokens=delta["total"],
                )

        stats.apply(summary, cls._top_items)
        # Codex's input_tokens includes the cached input.
        summary["cache_hit_rate"] = (
            summary["cache_read_tokens"] / summary["input_tokens"]
            if summary["input_tokens"]
            else None
        )
        if latest_limits is None and not unassigned_only:
            latest_limits = cls._latest_codex_rate_limits(root, user_id)
        summary["limits"] = (
            cls._codex_limits(latest_limits[1], latest_limits[0], now)
            if latest_limits
            else None
        )
        return cls._finalize_summary(summary, now)

    @classmethod
    def _latest_codex_rate_limits(
        cls, root: Path, user_id: str | None = None
    ) -> tuple[datetime, dict[str, Any]] | None:
        """When the aggregation period has no records, looks for limit info in the few most recent session files."""
        sessions_dir = root / "sessions"
        if not sessions_dir.is_dir():
            return None
        try:
            newest = sorted(
                sessions_dir.rglob("*.jsonl"),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )[:5]
        except OSError:
            return None
        for path in newest:
            if user_id and cls._codex_log_owner(path) != user_id:
                continue
            found = None
            fallback_time = cls._mtime(path)
            for record in cls._read_jsonl(path):
                payload = record.get("payload")
                if isinstance(payload, dict) and isinstance(
                    payload.get("rate_limits"), dict
                ):
                    found = (
                        cls._parse_timestamp(record.get("timestamp"), fallback_time),
                        payload["rate_limits"],
                    )
            if found:
                return found
        return None

    @classmethod
    def _codex_limits(
        cls, rate_limits: dict[str, Any], observed_at: datetime, now: datetime
    ) -> dict[str, Any]:
        windows = []
        for key in ("primary", "secondary"):
            value = rate_limits.get(key)
            if not isinstance(value, dict):
                continue
            minutes = cls._as_int(value.get("window_minutes")) or None
            label = cls._window_label(minutes) if minutes else key
            resets_at = value.get("resets_at")
            if resets_at is None and value.get("resets_in_seconds") is not None:
                resets_at = (
                    observed_at
                    + timedelta(seconds=cls._as_int(value.get("resets_in_seconds")))
                ).timestamp()
            windows.append(
                cls._window(
                    f"codex-{key}",
                    label,
                    value.get("used_percent"),
                    resets_at,
                    minutes,
                    now,
                )
            )
        credits = rate_limits.get("credits")
        plan = rate_limits.get("plan_type")
        return {
            "plan": plan.capitalize() if isinstance(plan, str) and plan else None,
            "updated_at": observed_at.isoformat(),
            "reached_type": rate_limits.get("rate_limit_reached_type"),
            "windows": windows,
            "breakdown": [],
            "credits": {
                "has_credits": bool(credits.get("has_credits")),
                "unlimited": bool(credits.get("unlimited")),
                "balance": str(credits.get("balance") or "0"),
            }
            if isinstance(credits, dict)
            else None,
        }

    @staticmethod
    def _window_label(minutes: int) -> str:
        if minutes <= 360:
            return _("현재 세션")
        if minutes >= 10080:
            return _("주간")
        if minutes % 1440 == 0:
            return _("{days}일", days=minutes // 1440)
        return _("{hours}시간", hours=round(minutes / 60))

    @classmethod
    def _window(
        cls,
        window_id: str,
        label: str,
        used_percent: Any,
        resets_at: Any,
        window_minutes: int | None,
        now: datetime,
        active: bool = False,
    ) -> dict[str, Any]:
        used = min(max(cls._as_float(used_percent), 0.0), 100.0)
        reset_time = None
        if isinstance(resets_at, (int, float)):
            reset_time = datetime.fromtimestamp(resets_at, tz=UTC).astimezone()
        elif isinstance(resets_at, str) and resets_at:
            try:
                reset_time = datetime.fromisoformat(resets_at).astimezone()
            except ValueError:
                reset_time = None
        # If the reset time has passed since the record, the window has been reset.
        expired = reset_time is not None and reset_time <= now
        if expired:
            used = 0.0
        return {
            "id": window_id,
            "label": label,
            "used_percent": round(used, 1),
            "remaining_percent": round(100.0 - used, 1),
            "resets_at": None
            if expired or reset_time is None
            else reset_time.isoformat(),
            "window_minutes": window_minutes,
            "expired": expired,
            "active": active,
        }

    # ── Shared aggregation ──────────────────────────────────────────────
    @classmethod
    def _empty_summary(
        cls,
        *,
        provider_id: str,
        name: str,
        accent: str,
        command: str,
        auth_files: list[Path],
        env_keys: list[str],
        files: list[Path],
        dates: list[Any],
    ) -> dict[str, Any]:
        command_path = find_command(command)
        authenticated = any(path.is_file() for path in auth_files) or any(
            bool(os.getenv(key)) for key in env_keys
        )
        installed = command_path is not None
        connected = authenticated or (installed and bool(files))
        return {
            "id": provider_id,
            "name": name,
            "accent": accent,
            "connected": connected,
            "installed": installed,
            "has_data": bool(files),
            "status": "connected" if connected else "not_connected",
            "source": "local_session_logs",
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
            "total_tokens": 0,
            "requests": 0,
            "sessions": 0,
            "model": None,
            "last_activity": None,
            "first_activity": None,
            "hourly": [0] * 24,
            "weekday": [0] * 7,
            "daily": {
                day.isoformat(): {
                    "date": day.isoformat(),
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_tokens": 0,
                    "total_tokens": 0,
                    "requests": 0,
                }
                for day in dates
            },
        }

    @staticmethod
    def _finalize_summary(summary: dict[str, Any], now: datetime) -> dict[str, Any]:
        summary["has_data"] = summary["total_tokens"] > 0
        daily = list(summary["daily"].values())
        summary["daily"] = daily
        today = now.date().isoformat()
        summary["today_tokens"] = next(
            (day["total_tokens"] for day in daily if day["date"] == today), 0
        )
        summary["active_days"] = sum(1 for day in daily if day["total_tokens"] > 0)
        peak = max(daily, key=lambda day: day["total_tokens"], default=None)
        summary["peak_day"] = (
            {"date": peak["date"], "total_tokens": peak["total_tokens"]}
            if peak and peak["total_tokens"] > 0
            else None
        )
        peak_hour = max(range(24), key=lambda hour: summary["hourly"][hour])
        summary["peak_hour"] = peak_hour if summary["hourly"][peak_hour] > 0 else None
        requests = summary["requests"]
        sessions = summary["sessions"]
        summary["avg_tokens_per_request"] = (
            round(summary["total_tokens"] / requests) if requests else 0
        )
        summary["avg_tokens_per_session"] = (
            round(summary["total_tokens"] / sessions) if sessions else 0
        )
        summary["avg_output_per_request"] = (
            round(summary["output_tokens"] / requests) if requests else 0
        )
        return summary

    @staticmethod
    def _add_usage(
        summary: dict[str, Any],
        timestamp: datetime,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_read: int,
        cache_write: int,
        total_tokens: int,
        reasoning_tokens: int = 0,
    ) -> bool:
        local_time = timestamp.astimezone()
        day_key = local_time.date().isoformat()
        bucket = summary["daily"].get(day_key)
        if bucket is None:
            return False

        cache_tokens = cache_read + cache_write
        for key, value in (
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("cache_tokens", cache_tokens),
            ("total_tokens", total_tokens),
        ):
            summary[key] += value
            bucket[key] += value
        bucket["requests"] += 1
        summary["requests"] += 1
        summary["cache_read_tokens"] += cache_read
        summary["cache_write_tokens"] += cache_write
        summary["reasoning_tokens"] += reasoning_tokens
        summary["hourly"][local_time.hour] += total_tokens
        summary["weekday"][local_time.weekday()] += total_tokens

        iso = timestamp.isoformat()
        if summary["last_activity"] is None or iso > summary["last_activity"]:
            summary["last_activity"] = iso
        if summary["first_activity"] is None or iso < summary["first_activity"]:
            summary["first_activity"] = iso
        return True

    @classmethod
    def _recent_jsonl_files(cls, root: Path, cutoff: datetime) -> list[Path]:
        if not root.is_dir():
            return []

        cutoff_timestamp = cutoff.timestamp()
        candidates: list[tuple[float, Path]] = []
        try:
            for path in root.rglob("*.jsonl"):
                try:
                    modified = path.stat().st_mtime
                except OSError:
                    continue
                if modified >= cutoff_timestamp:
                    candidates.append((modified, path))
        except OSError:
            return []

        candidates.sort(key=lambda item: item[0], reverse=True)
        return [path for _modified, path in candidates[: cls._max_files_per_provider]]

    @staticmethod
    def _mtime(path: Path) -> datetime:
        try:
            return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).astimezone()
        except OSError:
            return datetime.now().astimezone()

    @staticmethod
    def _read_jsonl(path: Path):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        continue
                    if isinstance(record, dict):
                        yield record
        except OSError:
            return

    @staticmethod
    def _parse_timestamp(value: Any, fallback: datetime) -> datetime:
        if isinstance(value, (int, float)):
            try:
                return datetime.fromtimestamp(value, tz=UTC).astimezone()
            except (OverflowError, OSError, ValueError):
                return fallback
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value).astimezone()
            except ValueError:
                return fallback
        return fallback

    @staticmethod
    def _as_int(value: Any) -> int:
        try:
            return max(int(value or 0), 0)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _as_float(value: Any) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0


class _Stats:
    """Auxiliary aggregation per model/project/session."""

    def __init__(self) -> None:
        self.model_tokens: Counter[str] = Counter()
        self.model_requests: Counter[str] = Counter()
        self.project_tokens: Counter[str] = Counter()
        self.project_requests: Counter[str] = Counter()
        self.project_sessions: defaultdict[str, set[str]] = defaultdict(set)
        self.sessions: set[str] = set()

    def add(
        self, *, model: Any, project: str | None, session: str, tokens: int
    ) -> None:
        self.sessions.add(session)
        if isinstance(model, str) and model and not model.startswith("<"):
            self.model_tokens[model] += tokens
            self.model_requests[model] += 1
        name = project or _("(알 수 없음)")
        self.project_tokens[name] += tokens
        self.project_requests[name] += 1
        self.project_sessions[name].add(session)

    def apply(self, summary: dict[str, Any], limit: int) -> None:
        summary["sessions"] = len(self.sessions)
        summary["model"] = (
            self.model_requests.most_common(1)[0][0] if self.model_requests else None
        )
        summary["models"] = [
            {
                "name": name,
                "total_tokens": tokens,
                "requests": self.model_requests[name],
            }
            for name, tokens in self.model_tokens.most_common(limit)
        ]
        summary["projects"] = [
            {
                "name": name,
                "total_tokens": tokens,
                "requests": self.project_requests[name],
                "sessions": len(self.project_sessions[name]),
            }
            for name, tokens in self.project_tokens.most_common(limit)
        ]
