import base64
import hashlib
import json
import os
import re
import select
import shutil
import subprocess
import tempfile
import threading
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

from app.paths import data_dir


class AIUsageService:
    """Claude Code와 Codex의 로컬 세션 기록을 안전하게 집계합니다.

    Codex 인증 정보는 서버 안에서만 읽고 브라우저로 내보내지 않는다.
    남은 사용량은 Codex app-server의 현재 계정 한도를 우선 쓴다.
    - Claude Code: ~/.claude.json 의 cachedUsageUtilization (CLI 가 주기적으로 갱신)
    - Codex: app-server account/rateLimits/read (실패 시 해당 계정의 세션 로그)
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
        cache_key = (days, str(claude_root), str(codex_root), auth_version, accounts_version)

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
            codex_summaries.append(codex)
        # 구버전 Codex 로그에는 계정 ID가 없어 어느 계정인지 안전하게 판별할 수 없다.
        # 임의의 계정에 합산하지 않고 별도 기록으로 보여준다.
        unknown = cls._collect_codex(
            codex_root, cutoff, dates, now, unassigned_only=True
        )
        if unknown["has_data"]:
            unknown.update({
                "account": "계정 미확인 (이전 기록)",
                "active": False,
                "accent": "#94a3b8",
                "limits": None,
            })
            codex_summaries.append(unknown)
        if not codex_summaries:
            codex = cls._collect_codex(codex_root, cutoff, dates, now)
            codex["account"] = accounts["codex"]
            codex["limits"] = cls._live_codex_limits(codex_root, now) or codex["limits"]
            codex_summaries.append(codex)
        result = {
            "generated_at": now.isoformat(),
            "window_days": days,
            "providers": [claude, *codex_summaries],
        }

        with cls._cache_lock:
            cls._cache[cache_key] = (time.monotonic(), result)
        return result

    _limits_cache: ClassVar[tuple[float, int, dict] | None] = None
    _codex_live_cache: ClassVar[dict[tuple[str, int], tuple[float, dict[str, Any]]]] = {}
    _codex_saved_limits_cache: ClassVar[dict[str, tuple[int, float, dict[str, Any]]]] = {}

    @classmethod
    def limits(cls) -> dict[str, Any]:
        """남은 한도만 가볍게 (Workspace 머리글 게이지용, 30초 캐시). 세션 로그는 끝부분만 읽는다."""
        codex_root = cls._data_root("CODEX_DATA_DIR", ".codex")
        try:
            auth_version = (codex_root / "auth.json").stat().st_mtime_ns
        except OSError:
            auth_version = 0
        if (
            cls._limits_cache
            and cls._limits_cache[1] == auth_version
            and time.monotonic() - cls._limits_cache[0] < 30
        ):
            return cls._limits_cache[2]
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
        result = {
            "claude": claude,
            "codex": codex,
            "accounts": cls.accounts(),
            "generated_at": now.isoformat(),
        }
        try:
            current_auth_version = (codex_root / "auth.json").stat().st_mtime_ns
        except OSError:
            current_auth_version = 0
        if current_auth_version == auth_version:
            cls._limits_cache = (time.monotonic(), auth_version, result)
        return result

    @classmethod
    def accounts(cls) -> dict[str, str | None]:
        """로그인한 계정 메일만 (토큰 · 키 같은 비밀값은 절대 내보내지 않는다).

        Claude Code: ~/.claude.json 의 oauthAccount.emailAddress
        Codex: ~/.codex/auth.json 의 id_token(JWT) 안 email — 표시용이라 서명은 확인하지 않는다.
        """
        return {
            "claude": cls._claude_account(cls._data_root("CLAUDE_DATA_DIR", ".claude")),
            "codex": cls._codex_account(cls._data_root("CODEX_DATA_DIR", ".codex")),
        }

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
                if not email or not user_id or hashlib.sha256(email.lower().encode()).hexdigest()[:12] != path.stem:
                    continue
                accounts.append({"email": email, "user_id": user_id, "active": email == active_email, "path": path})
        if active_email and not any(a["active"] for a in accounts):
            user_id = cls._codex_user_id(root)
            if user_id:
                accounts.append({"email": active_email, "user_id": user_id, "active": True, "path": None})
        accounts.sort(key=lambda a: (not a["active"], a["email"].lower()))
        return accounts

    @classmethod
    def _saved_codex_limits(cls, path: Path, now: datetime) -> dict[str, Any] | None:
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            return None
        with cls._cache_lock:
            cached = cls._codex_saved_limits_cache.get(str(path))
            if cached and cached[0] == mtime and time.monotonic() - cached[1] < 30:
                return cached[2]
        try:
            with path.open("r", encoding="utf-8") as handle:
                record = json.load(handle)
            auth = record.get("auth")
            if not isinstance(auth, dict):
                return None
            with tempfile.TemporaryDirectory(prefix="univdash-codex-usage-") as temporary:
                auth_file = Path(temporary) / "auth.json"
                fd = os.open(auth_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(auth, handle)
                limits = cls._live_codex_limits(Path(temporary), now, use_cache=False)
                updated_auth = json.loads(auth_file.read_text(encoding="utf-8"))
            if updated_auth != auth:
                from app.services import codex_accounts
                codex_accounts.refresh_saved_auth(path.stem, auth, updated_auth)
                mtime = path.stat().st_mtime_ns
        except (OSError, ValueError, AttributeError):
            return None
        if limits is not None:
            with cls._cache_lock:
                cls._codex_saved_limits_cache[str(path)] = (mtime, time.monotonic(), limits)
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
        """현재 로그인한 계정의 한도를 Codex app-server에서 직접 읽는다."""
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
        cache_key = (str(root), auth_mtime)
        if use_cache:
            with cls._cache_lock:
                cached = cls._codex_live_cache.get(cache_key)
                if cached and time.monotonic() - cached[0] < 15:
                    return cached[1]

        codex = shutil.which("codex")
        if not codex:
            return None
        env = os.environ.copy()
        env["CODEX_HOME"] = str(root)
        env.pop("OPENAI_API_KEY", None)
        env.pop("CODEX_API_KEY", None)
        messages = (
            {"method": "initialize", "id": 0, "params": {"clientInfo": {
                "name": "univdash", "title": "UnivDash", "version": "0.2.0"
            }}},
            {"method": "initialized", "params": {}},
            {"method": "account/rateLimits/read", "id": 1},
        )
        process = None
        try:
            process = subprocess.Popen(
                [codex, "app-server"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
            )
            for message in messages:
                process.stdin.write((json.dumps(message) + "\n").encode())
            process.stdin.flush()
            pending = b""
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and len(pending) < 1024 * 1024:
                ready, _, _ = select.select(
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
                    result = response.get("result")
                    if not isinstance(result, dict) or result.get("accountId") != account_id:
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
                        "credits": {
                            "has_credits": credits.get("hasCredits"),
                            "unlimited": credits.get("unlimited"),
                            "balance": credits.get("balance"),
                        } if isinstance(credits, dict) else None,
                    }
                    limits = cls._codex_limits(normalized, now, now)
                    if use_cache and auth_file.stat().st_mtime_ns != auth_mtime:
                        return None
                    if use_cache:
                        with cls._cache_lock:
                            cls._codex_live_cache = {cache_key: (time.monotonic(), limits)}
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
            # Claude Code 는 응답의 content block 마다 한 줄씩 기록하면서 같은 usage 를 반복한다.
            # (message.id, requestId) 로 중복을 제거하지 않으면 토큰이 두 배 가까이 집계된다.
            # 스트리밍 중간 줄은 output_tokens 가 작을 수 있어 메시지마다 가장 큰 값을 남긴다.
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
        # Claude 의 input_tokens 는 캐시를 제외한 값이므로 전체 입력 대비 캐시 읽기 비율을 쓴다.
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
        if not isinstance(cached, dict):
            return None
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
                    label, minutes = "현재 세션", 300
                elif kind == "weekly_all":
                    label, minutes = "주간 · 전체 모델", 10080
                elif kind == "weekly_scoped":
                    label, minutes = f"주간 · {model_name or '특정 모델'}", 10080
                else:
                    label = str(item.get("group") or kind or "한도")
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
            # 이전 CLI 형식: five_hour / seven_day
            for key, label, minutes in (
                ("five_hour", "현재 세션", 300),
                ("seven_day", "주간 · 전체 모델", 10080),
                ("seven_day_opus", "주간 · Opus", 10080),
                ("seven_day_sonnet", "주간 · Sonnet", 10080),
            ):
                value = utilization.get(key)
                if isinstance(value, dict) and value.get("utilization") is not None:
                    windows.append(
                        cls._window(
                            f"claude-{key}",
                            label,
                            value.get("utilization"),
                            value.get("resets_at"),
                            minutes,
                            now,
                        )
                    )

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

    @staticmethod
    def _claude_plan_label(tier: Any) -> str | None:
        if not isinstance(tier, str) or not tier:
            return None
        match = re.search(r"max_(\d+)x", tier)
        if match:
            return f"Max {match.group(1)}x"
        for key, label in (
            ("pro", "Pro"),
            ("team", "Team"),
            ("enterprise", "Enterprise"),
        ):
            if key in tier:
                return label
        return None

    # ── Codex ───────────────────────────────────────────────────────────
    @classmethod
    def _collect_codex(
        cls, root: Path, cutoff: datetime, dates: list[Any], now: datetime,
        user_id: str | None = None, unassigned_only: bool = False,
    ) -> dict[str, Any]:
        files = cls._recent_jsonl_files(root / "sessions", cutoff)
        if unassigned_only:
            files = [path for path in files if cls._codex_log_owner(path) is None]
        elif user_id:
            files = [path for path in files if cls._codex_log_owner(path) == user_id]
        else:
            user_id = cls._codex_user_id(root)
            if user_id:
                files = [path for path in files if cls._codex_log_owner(path) == user_id]
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
        # Codex 의 input_tokens 는 캐시된 입력을 포함한다.
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
        """집계 기간에 기록이 없을 때 가장 최근 세션 파일 몇 개에서 한도 정보를 찾는다."""
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
            return "현재 세션"
        if minutes >= 10080:
            return "주간"
        if minutes % 1440 == 0:
            return f"{minutes // 1440}일"
        return f"{round(minutes / 60)}시간"

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
        # 기록 이후 리셋 시각이 지났다면 창이 초기화된 것이다.
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

    # ── 공통 집계 ───────────────────────────────────────────────────────
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
        command_path = shutil.which(command)
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
        return [path for _, path in candidates[: cls._max_files_per_provider]]

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
    """모델/프로젝트/세션별 보조 집계."""

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
        name = project or "(알 수 없음)"
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
