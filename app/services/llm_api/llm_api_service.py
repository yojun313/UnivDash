"""OpenAI-compatible LLM API: serves the Claude Code · Codex CLIs signed in on this server at /llm/v1/chat/completions.

(Reference: github.com/alipyth/CLI_to_API — a design that launches the CLI and returns its standard output as the API response)

Security
- Off by default. Even when on, an API token (Bearer) is required; a token is shown once when created and only
  its SHA-256 hash is stored (data/llm_api.json, 0600). The dashboard login cookie cannot be used for /llm/v1.
- The CLI runs only inside a Docker container it "cannot leave", per request (app/services/llm_api/llm_sandbox.py):
  the server's files · processes · sockets are invisible and the network reaches only the AI service addresses.
  If isolation is not possible, nothing is run.
- Even in there it runs only as a "pure LLM without tools":
  · Claude: --tools "" (zero built-in tools) · MCP · slash commands · settings files · session saving all off.
  · Codex: shell · apps · plugins · multi-agent · web search etc. off, read-only sandbox, user config ignored, no session saving.
  · If a tool is attached or a tool call is seen, the container is removed on the spot and the request ends in an error.
- No shell is involved (executed directly by argv). The prompt goes in only through standard input. Model names use a fixed character set.
- The server's logins are not touched: the container gets only the access token (Claude) · a copy of the login
  without the refresh token (Codex). Tokens cannot be refreshed inside the container, so the server-side login
  never changes or gets signed out.
- Request log: time · token name · model · account · duration · token counts. Depending on the setting (on by
  default) the received prompt · sent answer are saved too (data/llm-api-content/, folder 700 · files 600, deleted
  after the retention period). Only an admin signed in to the dashboard can see them.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path

from app.i18n import _, translate
from app.i18n import default as default_language
from app.paths import data_dir, find_command
from app.services.llm_api import llm_sandbox

logger = logging.getLogger(__name__)

PROVIDERS = ("claude", "codex", "gemini")
PROVIDER_LABEL = {"claude": "Claude", "codex": "Codex", "gemini": "Gemini"}
# provider → CLI executable name (Gemini is the Antigravity CLI · agy)
PROVIDER_BIN = {"claude": "claude", "codex": "codex", "gemini": "agy"}
TOKEN_PREFIX = "ud-"
TOKEN_RE = re.compile(r"^ud-[A-Za-z0-9_-]{43}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]@+-]{0,79}$")
ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$")
ID_RE = re.compile(r"^[0-9a-f]{12}$")
NAME_MAX = 40
MAX_TOKENS = 50
MAX_ALIASES = 50
LOG_KEEP = 500
CLAUDE_MODELS = ("fable", "opus", "sonnet", "haiku")
STRATEGIES = ("order", "round_robin")
DEFAULTS = {
    "enabled": False,
    "providers": {"claude": True, "codex": True, "gemini": True},
    # {"claude": {account id: bool}, "codex": {...}} — a missing provider means "only the currently signed-in account"
    "accounts": {},
    "strategy": "order",
    "default_model": "claude",
    "aliases": {},
    "max_concurrency": 2,
    "fast": True,  # fast responses: reduce the thinking (reasoning) stage
    "keep_content": True,  # save the received prompt · sent answer so the admin screen can show them
    "content_days": 30,  # content retention period (deleted afterwards)
    "timeout": 300,
    "max_input_chars": 400_000,
    "tokens": {},
}

_lock = threading.RLock()
_log: deque[dict] = deque(maxlen=LOG_KEEP)
_log_loaded = False
_rate: dict[str, deque[float]] = {}
_round_robin: dict[str, int] = {}
_active = 0  # number of requests running right now
_slots: asyncio.Semaphore | None = None
_slots_size = 0


class ApiError(Exception):
    """An error that can be returned as an OpenAI-format error."""

    def __init__(
        self,
        status: int,
        message: str,
        kind: str = "api_error",
        code: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind
        self.code = code
        self.retryable = False  # whether it is worth retrying with another account


# ── Storage ───────────────────────────────────────────────────────────────────
def _path() -> Path:
    return data_dir() / "llm_api.json"


def _log_path() -> Path:
    return data_dir() / "llm_api_log.jsonl"


def _load() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    config = json.loads(json.dumps(DEFAULTS))
    for key, value in data.items():
        if key in config and isinstance(value, type(config[key])):
            config[key] = value
    return config


def _save(config: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".llm_api.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(config, handle, ensure_ascii=False)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def enabled() -> bool:
    with _lock:
        return bool(_load()["enabled"])


def default_model() -> str:
    with _lock:
        return str(_load()["default_model"])


# ── Accounts ──────────────────────────────────────────────────────────────────
def _accounts(provider: str) -> dict:
    """{accounts: [{id, email, plan, active, ...}], active} — straight from the account services (contains no tokens)."""
    try:
        if provider == "claude":
            from app.services.accounts import claude_accounts

            return claude_accounts.list_accounts()
        if provider == "gemini":
            from app.services.accounts import gemini_accounts

            return gemini_accounts.list_accounts()
        from app.services.accounts import codex_accounts

        return codex_accounts.list_accounts()
    except Exception:
        logger.exception("LLM API: could not read the %s account list", provider)
        return {"accounts": [], "active": None}


def _account_flags(config: dict, provider: str, listing: dict) -> dict[str, bool]:
    """Whether each account is on. A provider that was never configured counts as having only the currently signed-in account on."""
    saved = config["accounts"].get(provider)
    if isinstance(saved, dict):
        return {a["id"]: bool(saved.get(a["id"], False)) for a in listing["accounts"]}
    return {a["id"]: a["id"] == listing.get("active") for a in listing["accounts"]}


def installed(provider: str) -> bool:
    return bool(find_command(PROVIDER_BIN.get(provider, provider)))


# ── Admin screen ──────────────────────────────────────────────────────────────
def _public_token(record: dict) -> dict:
    return {
        key: record.get(key)
        for key in (
            "id",
            "name",
            "hint",
            "created",
            "expires",
            "enabled",
            "providers",
            "rpm",
            "accounts",
            "requests",
            "errors",
            "input_tokens",
            "output_tokens",
            "last_used",
            "last_ip",
        )
    }


def state() -> dict:
    with _lock:
        config = _load()
    providers = []
    for provider in PROVIDERS:
        listing = _accounts(provider)
        flags = _account_flags(config, provider, listing)
        providers.append(
            {
                "id": provider,
                "label": PROVIDER_LABEL[provider],
                "installed": installed(provider),
                "enabled": bool(config["providers"].get(provider, True)),
                "accounts": [
                    {
                        "id": a["id"],
                        "email": a.get("email"),
                        "plan": a.get("plan"),
                        "active": bool(a.get("active")),
                        "expired": bool(a.get("expired")),
                        "enabled": flags.get(a["id"], False),
                    }
                    for a in listing["accounts"]
                ],
            }
        )
    now = time.time()
    tokens = sorted(
        (_public_token(t) for t in config["tokens"].values()),
        key=lambda t: t["created"] or 0,
        reverse=True,
    )
    for token in tokens:
        token["expired"] = bool(token["expires"] and token["expires"] < now)
    return {
        "enabled": config["enabled"],
        "providers": providers,
        "strategy": config["strategy"],
        "default_model": config["default_model"],
        "aliases": config["aliases"],
        "max_concurrency": config["max_concurrency"],
        "timeout": config["timeout"],
        "fast": config["fast"],
        "keep_content": config["keep_content"],
        "content_days": config["content_days"],
        "tokens": tokens,
        "models": [m["id"] for m in models(config)],
        "active": _active,
        "sandbox": {
            "problem": llm_sandbox.problem(),
            "image": llm_sandbox.IMAGE,
            "running": llm_sandbox.container_running(),
        },
        "log": recent_log(100),
    }


def update_settings(changes: dict) -> None:
    with _lock:
        config = _load()
        if "enabled" in changes:
            config["enabled"] = bool(changes["enabled"])
        if isinstance(changes.get("providers"), dict):
            for provider in PROVIDERS:
                if provider in changes["providers"]:
                    config["providers"][provider] = bool(changes["providers"][provider])
        if changes.get("strategy") in STRATEGIES:
            config["strategy"] = changes["strategy"]
        if "max_concurrency" in changes:
            config["max_concurrency"] = max(1, min(8, int(changes["max_concurrency"])))
        if "keep_content" in changes:
            config["keep_content"] = bool(changes["keep_content"])
        if "content_days" in changes:
            config["content_days"] = max(1, min(365, int(changes["content_days"])))
        if "fast" in changes:
            config["fast"] = bool(changes["fast"])
        if "timeout" in changes:
            config["timeout"] = max(10, min(1800, int(changes["timeout"])))
        if "aliases" in changes:
            aliases = changes["aliases"]
            if not isinstance(aliases, dict) or len(aliases) > MAX_ALIASES:
                raise ValueError(
                    _("별칭은 {count}개까지 둘 수 있습니다.", count=MAX_ALIASES)
                )
            clean = {}
            for name, target in aliases.items():
                if not isinstance(name, str) or not ALIAS_RE.match(name):
                    raise ValueError(
                        _(
                            "별칭 이름이 올바르지 않습니다:{name}",
                            name=str(name)[:40],
                        )
                    )
                _route(str(target), {})  # whether the target model is valid
                clean[name] = str(target)
            config["aliases"] = clean
        if "default_model" in changes:
            _route(str(changes["default_model"]), config["aliases"])
            config["default_model"] = str(changes["default_model"])
        _save(config)
    if "enabled" in changes:
        logger.warning(
            "LLM API server turned %s", "on" if changes["enabled"] else "off"
        )


def set_account(provider: str, account_id: str, on: bool) -> None:
    if provider not in PROVIDERS or not ID_RE.match(account_id or ""):
        raise ValueError(_("없는 계정입니다."))
    listing = _accounts(provider)
    if account_id not in {a["id"] for a in listing["accounts"]}:
        raise ValueError(_("없는 계정입니다."))
    with _lock:
        config = _load()
        flags = _account_flags(config, provider, listing)
        flags[account_id] = bool(on)
        config["accounts"][provider] = flags
        _save(config)
    logger.info(
        "LLM API: %s account %s turned %s", provider, account_id, "on" if on else "off"
    )


def _clean_token_fields(fields: dict, record: dict) -> None:
    if "name" in fields:
        name = re.sub(r"[\x00-\x1f\x7f]", "", str(fields["name"] or "")).strip()
        if not name:
            raise ValueError(_("토큰 이름을 적어 주십시오."))
        record["name"] = name[:NAME_MAX]
    if "enabled" in fields:
        record["enabled"] = bool(fields["enabled"])
    if "providers" in fields:
        chosen = [p for p in PROVIDERS if p in (fields["providers"] or [])]
        if not chosen:
            raise ValueError(_("쓸 수 있는 제공자를 하나 이상 골라 주십시오."))
        record["providers"] = chosen
    if "rpm" in fields:
        record["rpm"] = max(0, min(600, int(fields["rpm"] or 0)))
    if "expires_days" in fields:
        days = int(fields["expires_days"] or 0)
        record["expires"] = time.time() + min(days, 3650) * 86400 if days > 0 else None
    if "accounts" in fields:
        # Choose the account the token uses ("" = automatic among the accounts that are on)
        pinned = {}
        for provider in PROVIDERS:
            value = str((fields["accounts"] or {}).get(provider) or "")
            if value and not ID_RE.match(value):
                raise ValueError(_("없는 계정입니다."))
            pinned[provider] = value
        record["accounts"] = pinned


def create_token(fields: dict) -> tuple[str, dict]:
    """(token, public info) — the token can only be learned at this moment."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    record = {
        "id": secrets.token_hex(6),
        "name": "",
        "hint": f"{token[:6]}…{token[-4:]}",
        "created": time.time(),
        "expires": None,
        "enabled": True,
        "providers": list(PROVIDERS),
        "rpm": 30,
        "accounts": {p: "" for p in PROVIDERS},
        "requests": 0,
        "errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "last_used": None,
        "last_ip": None,
    }
    _clean_token_fields({"name": fields.get("name"), **fields}, record)
    with _lock:
        config = _load()
        if len(config["tokens"]) >= MAX_TOKENS:
            raise ValueError(
                _("토큰은 {count}개까지 만들 수 있습니다.", count=MAX_TOKENS)
            )
        config["tokens"][_hash(token)] = record
        _save(config)
    logger.info("LLM API token created · %s · %s", record["id"], record["name"])
    return token, _public_token(record)


def _find_token(config: dict, token_id: str) -> tuple[str, dict]:
    for key, record in config["tokens"].items():
        if record.get("id") == token_id:
            return key, record
    raise KeyError(_("없는 토큰입니다."))


def update_token(token_id: str, fields: dict) -> dict:
    with _lock:
        config = _load()
        _key, record = _find_token(config, token_id)
        _clean_token_fields(fields, record)
        _save(config)
        return _public_token(record)


def rotate_token(token_id: str) -> tuple[str, dict]:
    """Create only a new token value with the same settings (the old value stops working immediately)."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    with _lock:
        config = _load()
        key, record = _find_token(config, token_id)
        config["tokens"].pop(key)
        record["hint"] = f"{token[:6]}…{token[-4:]}"
        config["tokens"][_hash(token)] = record
        _save(config)
    logger.info("LLM API token rotated · %s · %s", record["id"], record["name"])
    return token, _public_token(record)


def delete_token(token_id: str) -> None:
    with _lock:
        config = _load()
        key, record = _find_token(config, token_id)
        config["tokens"].pop(key)
        _save(config)
    _rate.pop(token_id, None)
    logger.info("LLM API token deleted · %s · %s", record["id"], record["name"])


# ── Request checks ────────────────────────────────────────────────────────────
def authenticate(token: str) -> dict | None:
    """The record of a live token (None if missing, turned off or expired)."""
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        return None
    with _lock:
        record = _load()["tokens"].get(_hash(token))
    if not record or not record.get("enabled"):
        return None
    if record.get("expires") and record["expires"] < time.time():
        return None
    return record


def check_rate(record: dict) -> int:
    """Requests-per-minute limit. Seconds to wait if exceeded, otherwise 0 (a passing request is counted)."""
    limit = int(record.get("rpm") or 0)
    if limit <= 0:
        return 0
    now = time.monotonic()
    with _lock:
        window = _rate.setdefault(record["id"], deque())
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= limit:
            return int(60 - (now - window[0])) + 1
        window.append(now)
    return 0


# ── Models ────────────────────────────────────────────────────────────────────
def _route(model: str, aliases: dict) -> tuple[str, str]:
    """Model name → (provider, model passed to the CLI · the CLI default if empty)."""
    name = (model or "").strip()
    name = aliases.get(name, name)
    provider, _sep, sub = name.partition("/")
    if provider not in PROVIDERS:
        # Only a model name came, without a provider
        sub = name
        low = name.lower()
        if low.startswith("claude") or low in CLAUDE_MODELS:
            provider = "claude"
        elif re.match(r"^(gpt-|o\d|codex)", low):
            provider = "codex"
        elif low.startswith("gemini"):
            provider = "gemini"
        else:
            raise ApiError(
                404,
                f"The model '{name[:80]}' does not exist. See GET /llm/v1/models.",
                "invalid_request_error",
                "model_not_found",
            )
    if sub and not MODEL_RE.match(sub):
        raise ApiError(
            400, "Invalid model name.", "invalid_request_error", "invalid_model"
        )
    return provider, sub


def codex_models() -> list[str]:
    """Model names Codex can use — read from the list the Codex CLI downloaded (~/.codex/models_cache.json)."""
    try:
        from app.services.accounts import codex_accounts

        data = json.loads(
            (codex_accounts.codex_home() / "models_cache.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return []
    found = []
    for item in data.get("models") or [] if isinstance(data, dict) else []:
        slug = item.get("slug") if isinstance(item, dict) else None
        if (
            isinstance(slug, str)
            and MODEL_RE.match(slug)
            and item.get("visibility") == "list"
        ):
            found.append((item.get("priority") or 999, slug))
    return [slug for _priority, slug in sorted(found)]


def gemini_models() -> list[str]:
    """Model names Gemini (Antigravity CLI) can use (`agy models` — kept by gemini_service)."""
    from app.services.accounts import gemini_service

    return [m["id"] for m in gemini_service.models() if MODEL_RE.match(m["id"])]


def models(config: dict | None = None) -> list[dict]:
    if config is None:
        with _lock:
            config = _load()
    out = []
    if config["providers"].get("claude", True) and installed("claude"):
        out.append({"id": "claude", "owned_by": "anthropic"})
        out += [{"id": f"claude/{m}", "owned_by": "anthropic"} for m in CLAUDE_MODELS]
    if config["providers"].get("codex", True) and installed("codex"):
        out.append({"id": "codex", "owned_by": "openai"})
        out += [{"id": f"codex/{m}", "owned_by": "openai"} for m in codex_models()]
    if config["providers"].get("gemini", True) and installed("gemini"):
        out.append({"id": "gemini", "owned_by": "google"})
        out += [{"id": f"gemini/{m}", "owned_by": "google"} for m in gemini_models()]
    known = {m["id"] for m in out}
    out += [{"id": a, "owned_by": "alias"} for a in config["aliases"] if a not in known]
    return out


def resolve(model: str | None, record: dict | None) -> tuple[str, str, list[dict]]:
    """(provider, CLI model, the accounts to try in order)."""
    with _lock:
        config = _load()
    provider, sub = _route(model or config["default_model"], config["aliases"])
    label = PROVIDER_LABEL[provider]
    if not config["providers"].get(provider, True):
        raise ApiError(
            403,
            f"{label} is turned off on this server.",
            "invalid_request_error",
            "provider_disabled",
        )
    if record is not None and provider not in (record.get("providers") or []):
        raise ApiError(
            403,
            f"This API key cannot use {label} models.",
            "invalid_request_error",
            "provider_not_allowed",
        )
    if not installed(provider):
        raise ApiError(
            503,
            f"{label} CLI is not installed on this server.",
            "api_error",
            "provider_unavailable",
        )
    listing = _accounts(provider)
    flags = _account_flags(config, provider, listing)
    candidates = [
        a for a in listing["accounts"] if flags.get(a["id"]) and not a.get("expired")
    ]
    pinned = ((record or {}).get("accounts") or {}).get(provider) or ""
    if pinned:
        candidates = [a for a in candidates if a["id"] == pinned]
    if not candidates:
        raise ApiError(
            503,
            f"No {label} account is enabled for the API.",
            "api_error",
            "no_account",
        )
    # The currently signed-in account first, the rest in email order (list_accounts sorts them that way)
    if config["strategy"] == "round_robin" and len(candidates) > 1:
        with _lock:
            turn = _round_robin.get(provider, 0)
            _round_robin[provider] = turn + 1
        shift = turn % len(candidates)
        candidates = candidates[shift:] + candidates[:shift]
    return provider, sub, candidates


# ── Execution (only inside the isolated container — app/services/llm_api/llm_sandbox.py) ──
CODEX_OFF = (
    "shell_tool",
    "apps",
    "plugins",
    "multi_agent",
    "image_generation",
    "browser_use",
    "computer_use",
    "hooks",
    "skill_search",
    "sleep_tool",
    "tool_suggest",
    "goals",
    "in_app_browser",
)
_CODEX_SAFE_ITEMS = {"agent_message", "reasoning", "todo_list", "error"}
_TOOL_BLOCKS = {"tool_use", "server_tool_use", "mcp_tool_use"}


def _unavailable(message: str) -> ApiError:
    error = ApiError(503, message, "api_error", "account_unavailable")
    error.retryable = True  # another account can be tried
    return error


def _blocked() -> ApiError:
    return ApiError(
        502,
        "The model tried to use a tool, which is not allowed.",
        "api_error",
        "tool_use_blocked",
    )


def _claude_token(account: dict) -> str:
    """This account's access token (valid a few hours). Only this goes into the container — no refresh token · login file."""
    from app.services.accounts import claude_accounts

    if account.get("active"):
        oauth = claude_accounts._oauth(
            claude_accounts._read_json(claude_accounts.live_file())
        )
        if oauth and claude_accounts._usable(oauth):
            return oauth["accessToken"]
        # The currently signed-in account's token is refreshed by the running Claude Code (a refresh by the dashboard could sign it out there)
        raise _unavailable(
            "The Claude login on this server needs a refresh. Open Claude Code on the server once."
        )
    token, relogin = claude_accounts._saved_token(account["id"], True)
    if not token:
        raise _unavailable(
            "This Claude account needs to log in again."
            if relogin
            else "This Claude account's token is not available right now."
        )
    return token


def _codex_auth(account: dict) -> dict:
    """The copy of the Codex login that goes into the container: without the refresh token → the token cannot be refreshed (replaced) inside the container."""
    import base64

    from app.services.accounts import codex_accounts

    if account.get("active"):
        auth = codex_accounts._read_json(codex_accounts.live_file())
    else:
        record = codex_accounts._read_json(codex_accounts._profile_path(account["id"]))
        auth = record.get("auth") if record else None
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    access = tokens.get("access_token") if isinstance(tokens, dict) else None
    if not isinstance(access, str) or access.count(".") != 2:
        raise _unavailable("This Codex account is not available.")
    try:
        payload = access.split(".")[1]
        claims = json.loads(
            base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        )
        expires = float(claims.get("exp") or 0)
    except (ValueError, TypeError):
        expires = 0.0
    if expires and expires < time.time() + 120:
        raise _unavailable(
            "The Codex login on this server needs a refresh. Open Codex on the server once."
        )
    safe = json.loads(json.dumps(auth))
    safe["tokens"]["refresh_token"] = ""
    safe["OPENAI_API_KEY"] = None
    return safe


async def _lines(
    target: tuple[str, str, str], argv: list[str], env: dict, stdin: str, timeout: float
) -> AsyncIterator[dict]:
    """Runs the CLI inside the isolated container and yields the JSON lines of its standard output one by one. At the end: {"_exit": code, "_stderr": text}.

    target = (request id, account folder, user number). If the consumer stops (connection dropped) or time runs out, the process inside is ended.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            start_new_session=True,
            limit=8 * 1024 * 1024,
        )
    except OSError as error:
        raise ApiError(
            503, "Could not start the sandbox.", "api_error", "sandbox_unavailable"
        ) from error
    stderr_task = asyncio.create_task(proc.stderr.read())
    deadline = time.monotonic() + timeout
    finished = False
    try:
        try:
            proc.stdin.write(stdin.encode("utf-8"))
            await asyncio.wait_for(proc.stdin.drain(), timeout=30)
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("{"):
                continue
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if isinstance(data, dict):
                yield data
        code = await asyncio.wait_for(
            proc.wait(), timeout=max(1.0, deadline - time.monotonic())
        )
        finished = True
        stderr = (await stderr_task).decode("utf-8", "replace")
        if (
            code in (125, 126)
            or "is not running" in stderr
            or "No such container" in stderr
        ):
            llm_sandbox._container_ok = (0.0, "")  # recreated on the next request
            logger.error(
                "LLM API: execution in the sandbox container failed · %s",
                stderr[-500:],
            )
            raise ApiError(
                503, "Could not start the sandbox.", "api_error", "sandbox_unavailable"
            )
        yield {"_exit": code, "_stderr": stderr[-2000:]}
    except TimeoutError:
        raise ApiError(
            504,
            f"The model did not finish within {int(timeout)} seconds.",
            "api_error",
            "timeout",
        ) from None
    except ValueError as error:  # a single line is too long
        raise ApiError(
            502, "The CLI produced an oversized message.", "api_error"
        ) from error
    finally:
        llm_sandbox.kill(*target)  # called even when finished (cleans up the pid file)
        if not finished:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stderr_task.cancel()


def _cli_error(provider: str, detail: str, code: int | None = None) -> ApiError:
    """The error for a failed CLI. Details stay in the server log only; the caller is told just the kind."""
    logger.warning(
        "LLM API: %s failed (exit %s) · %s",
        provider,
        code,
        detail[-500:].replace("\n", " "),
    )
    label = PROVIDER_LABEL[provider]
    low = detail.lower()
    if re.search(
        r"rate.?limit|usage limit|quota|too many requests|\b429\b|credit", low
    ):
        error = ApiError(
            429,
            f"{label} usage limit reached. Try again later.",
            "rate_limit_error",
            "rate_limit_exceeded",
        )
    elif re.search(r"overloaded|\b529\b|\b503\b", low):
        error = ApiError(
            503, f"{label} is overloaded. Try again later.", "api_error", "overloaded"
        )
    elif re.search(
        r"expired|unauthori[sz]ed|\b401\b|not logged in|log ?in|authenticat|refresh",
        low,
    ):
        error = _unavailable(f"The {label} login on this server needs a refresh.")
    elif re.search(r"model", low) and re.search(
        r"not (found|exist|supported|available)|invalid|unknown|does not exist", low
    ):
        return ApiError(
            400,
            "The requested model is not available.",
            "invalid_request_error",
            "model_not_found",
        )
    else:
        return ApiError(502, f"{label} CLI failed.", "api_error", "cli_error")
    error.retryable = True
    return error


async def _run_claude(
    account: dict, model: str, system: str, prompt: str, timeout: float, fast: bool
) -> AsyncIterator[tuple[str, object]]:
    exe = find_command("claude")
    if not exe:
        raise ApiError(
            503,
            "Claude CLI is not installed on this server.",
            "api_error",
            "provider_unavailable",
        )
    token = await asyncio.to_thread(_claude_token, account)
    command = [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--system-prompt",
        system or "You are a helpful assistant.",
    ]
    if model:
        command += ["--model", model]
    home, user = llm_sandbox.account_home("claude", account["id"])
    target = (llm_sandbox.new_request(), home, user)
    extra = {
        "CLAUDE_CONFIG_DIR": "{home}/cfg",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    if fast:
        extra["MAX_THINKING_TOKENS"] = (
            "0"  # answer right away, without a thinking stage
        )
    argv = llm_sandbox.exec_argv(
        *target,
        command,
        timeout=timeout,
        env=extra,
        pass_env=("CLAUDE_CODE_OAUTH_TOKEN",),
    )
    env = llm_sandbox.client_env({"CLAUDE_CODE_OAUTH_TOKEN": token})
    got_text = False
    failure = ""
    async for event in _lines(target, argv, env, prompt, timeout):
        if "_exit" in event:
            if not got_text:
                raise _cli_error(
                    "claude", failure or event["_stderr"] or "no output", event["_exit"]
                )
            return
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            # Do not start if even one tool · MCP server is attached
            if event.get("tools") or event.get("mcp_servers"):
                raise _blocked()
        elif kind == "stream_event":
            inner = event.get("event") or {}
            if (
                inner.get("type") == "content_block_start"
                and (inner.get("content_block") or {}).get("type") in _TOOL_BLOCKS
            ):
                raise _blocked()
            delta = inner.get("delta") or {}
            if (
                inner.get("type") == "content_block_delta"
                and delta.get("type") == "text_delta"
                and delta.get("text")
            ):
                got_text = True
                yield "text", delta["text"]
        elif kind == "result":
            usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
            yield (
                "usage",
                {
                    "input": sum(
                        int(usage.get(k) or 0)
                        for k in (
                            "input_tokens",
                            "cache_creation_input_tokens",
                            "cache_read_input_tokens",
                        )
                    ),
                    "output": int(usage.get("output_tokens") or 0),
                },
            )
            if event.get("is_error"):
                failure = str(event.get("result") or event.get("subtype") or "error")
                if got_text:
                    raise _cli_error("claude", failure)
            elif (
                not got_text
                and isinstance(event.get("result"), str)
                and event["result"]
            ):
                got_text = True  # an answer that did not arrive in chunks
                yield "text", event["result"]


async def _run_codex(
    account: dict, model: str, system: str, prompt: str, timeout: float, fast: bool
) -> AsyncIterator[tuple[str, object]]:
    exe = find_command("codex")
    if not exe:
        raise ApiError(
            503,
            "Codex CLI is not installed on this server.",
            "api_error",
            "provider_unavailable",
        )
    auth = await asyncio.to_thread(_codex_auth, account)
    home, user = llm_sandbox.account_home("codex", account["id"])
    command = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "read-only",
        "--color",
        "never",
        "--json",
        "-C",
        f"/work/{home}/cwd",
        "-c",
        'web_search="disabled"',
    ]
    if fast:
        command += ["-c", 'model_reasoning_effort="low"']
    for feature in CODEX_OFF:
        command += ["--disable", feature]
    if model:
        command += ["-m", model]
    command.append("-")
    text = f"[Instructions]\n{system}\n\n{prompt}" if system else prompt
    # Codex reads its login only from a file → the copy (without the refresh token) is passed in an environment
    # variable and written only to the account folder inside the container (in memory).
    # Nothing is left on the server's disk.
    target = (llm_sandbox.new_request(), home, user)
    argv = llm_sandbox.exec_argv(
        *target,
        command,
        timeout=timeout,
        env={"CODEX_HOME": "{home}/codex", "UD_FILE": "codex/auth.json"},
        pass_env=("UD_FILE_DATA",),
    )
    env = llm_sandbox.client_env({"UD_FILE_DATA": json.dumps(auth)})
    # Codex delivers the answer per message rather than in chunks, and sends interim remarks such as "I will …"
    # separately before the final answer. Only the last message (the final answer) is sent as the API answer.
    got_text = False
    answer = ""
    failure = ""
    async for event in _lines(target, argv, env, text, timeout):
        if "_exit" in event:
            if answer and not got_text:
                got_text = True
                yield "text", answer
            if not got_text:
                raise _cli_error(
                    "codex",
                    failure or event["_stderr"] or "no output",
                    event["_exit"],
                )
            return
        kind = event.get("type")
        item = event.get("item") if isinstance(event.get("item"), dict) else {}
        if (
            kind in {"item.started", "item.completed", "item.updated"}
            and item.get("type") not in _CODEX_SAFE_ITEMS
        ):
            raise _blocked()
        if (
            kind == "item.completed"
            and item.get("type") == "agent_message"
            and item.get("text")
        ):
            answer = str(item["text"])
        elif kind == "item.completed" and item.get("type") == "error":
            # A notice that a helper program missing from the container (code mode host etc.) could not start is not an error
            if (
                not answer
                and "unavailable" not in str(item.get("message") or "").lower()
            ):
                failure = str(item.get("message") or failure)
        elif kind == "turn.completed":
            if answer and not got_text:
                got_text = True
                yield "text", answer
            usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
            yield (
                "usage",
                {
                    "input": int(usage.get("input_tokens") or 0),
                    "output": int(usage.get("output_tokens") or 0),
                },
            )
        elif kind in {"error", "turn.failed"}:
            detail = (
                event.get("message")
                or (event.get("error") or {}).get("message")
                or "error"
            )
            failure = str(detail)
            if got_text:
                raise _cli_error("codex", failure)


def _gemini_auth(account: dict) -> dict:
    """The copy of the Gemini login that goes into the container: only the access token (valid one hour), without the refresh token."""
    from datetime import UTC, datetime

    from app.services.accounts import gemini_accounts

    token = gemini_accounts.account_token(account["id"])
    if token is None or token["expires"] - time.time() < 120:
        raise _unavailable("The Gemini login on this server needs a refresh.")
    return {
        "token": {
            "access_token": token["access"],
            "token_type": "Bearer",
            "refresh_token": "",
            "expiry": datetime.fromtimestamp(token["expires"], UTC).isoformat(),
        },
        "auth_method": "consumer",
    }


GEMINI_NO_TOOLS = (
    "Answer directly from your own knowledge. Do not call tools, run commands, "
    "read or write files, browse, or ask for permission."
)


async def _run_gemini(
    account: dict, model: str, system: str, prompt: str, timeout: float, fast: bool
) -> AsyncIterator[tuple[str, object]]:
    """Gemini: the headless mode of the Antigravity CLI (agy). Cut off at once if it tries to use a tool (nothing outside the container is reachable anyway)."""
    exe = find_command("agy")
    if not exe:
        raise ApiError(
            503,
            "Gemini (Antigravity CLI) is not installed on this server.",
            "api_error",
            "provider_unavailable",
        )
    auth = await asyncio.to_thread(_gemini_auth, account)
    home, user = llm_sandbox.account_home("gemini", account["id"])
    command = [
        "agy",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--disable-slash-commands",
        "--sandbox",
        "--print-timeout",
        f"{int(timeout)}s",
    ]
    if model:
        command += ["--model", model]
    elif fast:
        command += ["--effort", "low"]
    instructions = f"{GEMINI_NO_TOOLS}\n\n{system}" if system else GEMINI_NO_TOOLS
    text = json.dumps(
        {
            "event": "user",
            "message": {"content": f"[Instructions]\n{instructions}\n\n{prompt}"},
        },
        ensure_ascii=False,
    )
    target = (llm_sandbox.new_request(), home, user)
    argv = llm_sandbox.exec_argv(
        *target,
        command,
        timeout=timeout,
        env={"UD_FILE": ".gemini/antigravity-cli/antigravity-oauth-token"},
        pass_env=("UD_FILE_DATA",),
    )
    env = llm_sandbox.client_env({"UD_FILE_DATA": json.dumps(auth)})
    got_text = False
    failure = ""
    async for event in _lines(target, argv, env, text + "\n", timeout):
        if "_exit" in event:
            if not got_text:
                raise _cli_error(
                    "gemini", failure or event["_stderr"] or "no output", event["_exit"]
                )
            return
        kind = event.get("event")
        if kind == "step_update":
            step = event.get("step_update") or {}
            step_type = step.get("step_type")
            if (
                step_type == "tool"
                or step.get("tool_name")
                or step.get("subagent_info")
            ):
                raise _blocked()
            if step_type == "agent_response" and step.get("text_delta"):
                got_text = True
                yield "text", str(step["text_delta"])
        elif kind == "result":
            result = event.get("result") or {}
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            yield (
                "usage",
                {
                    "input": int(usage.get("input_tokens") or 0)
                    + int(usage.get("cache_read_tokens") or 0),
                    "output": int(usage.get("output_tokens") or 0),
                },
            )
            if result.get("status") != "SUCCESS":
                failure = str(result.get("error") or result.get("status") or "error")
                if got_text:
                    raise _cli_error("gemini", failure)
            elif not got_text and isinstance(result.get("response"), str):
                if result["response"].strip():
                    got_text = True
                    yield "text", result["response"]
            # Only a single exchange: once the answer is done, standard input is closed and the CLI ends too


def _semaphore(size: int) -> asyncio.Semaphore:
    global _slots, _slots_size
    if _slots is None or _slots_size != size:
        _slots, _slots_size = asyncio.Semaphore(size), size
    return _slots


async def generate(
    model: str | None, system: str, prompt: str, record: dict | None, meta: dict
) -> AsyncIterator[tuple[str, object]]:
    """Yields the answer in chunks: ("text", text) … and once ("usage", {input, output}).

    The enabled accounts are tried in order — if an account-related error such as an exceeded limit · expired login
    happens before any answer, the next account is used.
    meta is filled with the info for the log (provider · account · model).
    """
    global _active
    provider, sub, candidates = resolve(model, record)
    reason = await asyncio.to_thread(llm_sandbox.problem)
    if reason:
        # There is no fallback path that runs without isolation
        logger.error("LLM API: isolated execution unavailable · %s", reason)
        raise ApiError(
            503,
            "The sandbox is not available on this server.",
            "api_error",
            "sandbox_unavailable",
        )
    try:
        await llm_sandbox.ensure_container()
    except (RuntimeError, OSError) as error:
        raise ApiError(
            503,
            "The sandbox is not available on this server.",
            "api_error",
            "sandbox_unavailable",
        ) from error
    with _lock:
        config = _load()
    if len(prompt) + len(system) > config["max_input_chars"]:
        raise ApiError(
            413,
            "The request is too long for this server.",
            "invalid_request_error",
            "context_length_exceeded",
        )
    meta.update(provider=provider, model=f"{provider}/{sub}" if sub else provider)
    runner = {"claude": _run_claude, "codex": _run_codex, "gemini": _run_gemini}[
        provider
    ]
    slots = _semaphore(config["max_concurrency"])
    try:
        await asyncio.wait_for(slots.acquire(), timeout=60)
    except TimeoutError:
        raise ApiError(
            429,
            "The server is busy. Try again shortly.",
            "rate_limit_error",
            "server_busy",
        ) from None
    _active += 1
    try:
        last: ApiError | None = None
        for account in candidates:
            meta["account"] = account.get("email") or account["id"]
            started = False
            try:
                async for kind, value in runner(
                    account,
                    sub,
                    system,
                    prompt,
                    float(config["timeout"]),
                    bool(config["fast"]),
                ):
                    started = started or kind == "text"
                    yield kind, value
                return
            except ApiError as error:
                if started or not error.retryable:
                    raise
                last = error
                logger.info(
                    "LLM API: %s account %s failed → next account · %s",
                    provider,
                    meta["account"],
                    error.code,
                )
        raise last or ApiError(
            503, "No account is available.", "api_error", "no_account"
        )
    finally:
        _active -= 1
        slots.release()


# ── Log ───────────────────────────────────────────────────────────────────────
def _load_log() -> None:
    global _log_loaded
    if _log_loaded:
        return
    _log_loaded = True
    try:
        lines = _log_path().read_text(encoding="utf-8").splitlines()[-LOG_KEEP:]
    except OSError:
        return
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            _log.append(entry)


# Request content (received messages · sent answer): one file per request (data/llm-api-content/<id>.json · folder 700 · files 600).
# Only an admin signed in to the dashboard sees it. Past the retention period, or over the count · size limits, the oldest are deleted first.
CONTENT_ID = re.compile(r"^[0-9a-f]{16}$")
CONTENT_TEXT_MAX = 400_000  # maximum characters saved from one message · one answer
CONTENT_MAX_FILES = 5000
CONTENT_MAX_BYTES = 300 * 1024 * 1024
_content_pruned = 0.0


def _content_dir() -> Path:
    path = data_dir() / "llm-api-content"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def _clip_content(text) -> str:
    text = text if isinstance(text, str) else str(text or "")
    if len(text) <= CONTENT_TEXT_MAX:
        return text
    # Saved while serving an API client, so the server's default language is used (not the client's)
    note = translate(
        "… ({count}자 생략)", default_language(), count=len(text) - CONTENT_TEXT_MAX
    )
    return text[:CONTENT_TEXT_MAX] + "\n" + note


def _prune_content(days: int) -> None:
    """(inside _lock) Deletes content past the retention period and old content over the count · size limits. Once every 10 minutes."""
    global _content_pruned
    now = time.time()
    if now - _content_pruned < 600:
        return
    _content_pruned = now
    files = []
    for path in _content_dir().glob("*.json"):
        try:
            info = path.stat()
        except OSError:
            continue
        if now - info.st_mtime > days * 86400:
            path.unlink(missing_ok=True)
        else:
            files.append((info.st_mtime, info.st_size, path))
    files.sort(reverse=True)  # newest first
    total = 0
    for index, (_modified, size, path) in enumerate(files):
        total += size
        if index >= CONTENT_MAX_FILES or total > CONTENT_MAX_BYTES:
            path.unlink(missing_ok=True)


def _save_content(request_id: str, content: dict, days: int) -> bool:
    try:
        path = _content_dir() / f"{request_id}.json"
        data = {
            "messages": [
                {
                    "role": str(m.get("role") or "user")[:20],
                    "text": _clip_content(m.get("text")),
                }
                for m in (content.get("messages") or [])[:2000]
                if isinstance(m, dict)
            ],
            "answer": _clip_content(content.get("answer")),
            "error": str(content.get("error") or "")[:2000],
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        _prune_content(days)
        return True
    except OSError:
        logger.exception("Failed to save LLM API request content")
        return False


def request_content(request_id: str) -> dict | None:
    """The log entry of one request + its saved content (None if there is neither)."""
    if not CONTENT_ID.match(request_id or ""):
        return None
    with _lock:
        _load_log()
        entry = next((dict(e) for e in _log if e.get("id") == request_id), None)
    try:
        data = json.loads(
            (_content_dir() / f"{request_id}.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        data = None
    if entry is None and data is None:
        return None
    return {"entry": entry, "content": data if isinstance(data, dict) else None}


def record_request(
    record: dict | None, entry: dict, content: dict | None = None
) -> None:
    """Logs one request and bumps the token's running totals. If the setting is on, the received messages · sent answer are saved too."""
    request_id = secrets.token_hex(8)
    with _lock:
        config = _load()
        saved_content = bool(
            content is not None
            and config["keep_content"]
            and _save_content(request_id, content, int(config["content_days"]))
        )
    entry = {
        "id": request_id,
        "has_content": saved_content,
        "ts": time.time(),
        # no token record = the admin's test from the dashboard (stored in that admin's language)
        "token": record["name"] if record else _("관리자 테스트"),
        "token_id": record["id"] if record else None,
        **entry,
    }
    with _lock:
        _load_log()
        _log.append(entry)
        path = _log_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if path.exists() and path.stat().st_size > 1_000_000:
                path.write_text(
                    "\n".join(json.dumps(e, ensure_ascii=False) for e in _log) + "\n",
                    encoding="utf-8",
                )
            else:
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            os.chmod(path, 0o600)
        except OSError:
            logger.exception("Failed to save the LLM API log")
        if record is None:
            return
        config = _load()
        try:
            _key, saved = _find_token(config, record["id"])
        except KeyError:
            return
        saved["requests"] = int(saved.get("requests") or 0) + 1
        if entry.get("status", 200) >= 400:
            saved["errors"] = int(saved.get("errors") or 0) + 1
        saved["input_tokens"] = int(saved.get("input_tokens") or 0) + int(
            entry.get("input_tokens") or 0
        )
        saved["output_tokens"] = int(saved.get("output_tokens") or 0) + int(
            entry.get("output_tokens") or 0
        )
        saved["last_used"] = entry["ts"]
        saved["last_ip"] = entry.get("ip")
        _save(config)


def recent_log(limit: int = 100) -> list[dict]:
    with _lock:
        _load_log()
        return list(_log)[-limit:][::-1]


def clear_log() -> None:
    with _lock:
        _load_log()
        _log.clear()
        _log_path().unlink(missing_ok=True)
        # the saved prompts · answers are deleted along with it
        for path in _content_dir().glob("*.json"):
            path.unlink(missing_ok=True)
