"""OpenAI 호환 LLM API: 이 서버에 로그인된 Claude Code · Codex CLI 를 /llm/v1/chat/completions 로 내어 준다.

(참고: github.com/alipyth/CLI_to_API — CLI 를 띄워 표준 출력을 API 응답으로 돌려주는 구조)

보안
- 기본은 꺼짐. 켜도 API 토큰(Bearer)이 있어야 하고, 토큰은 만들 때 한 번만 보여 준 뒤 SHA-256 해시만 저장한다
  (data/llm_api.json, 0600). 대시보드 로그인 쿠키로는 /llm/v1 을 쓸 수 없다.
- CLI 는 요청마다 '나갈 수 없는' Docker 컨테이너 안에서만 돈다 (app/services/llm_sandbox.py):
  서버 파일 · 프로세스 · 소켓이 보이지 않고, 네트워크는 AI 서비스 주소로만 나간다. 격리를 못 하면 실행하지 않는다.
- 그 안에서도 '도구 없는 순수 LLM' 으로만 돈다:
  · Claude: --tools "" (내장 도구 0개) · MCP · 슬래시 명령 · 설정 파일 · 세션 저장 모두 끔.
  · Codex: 셸 · 앱 · 플러그인 · 멀티 에이전트 · 웹 검색 등 끔, 읽기 전용 샌드박스, 사용자 설정 무시, 세션 저장 안 함.
  · 도구가 붙어 있거나 도구 호출이 보이면 그 자리에서 컨테이너를 없애고 오류로 끝낸다.
- 셸을 거치지 않는다 (argv 로 직접 실행). 프롬프트는 표준 입력으로만 넣는다. 모델 이름은 정해진 글자만.
- 서버의 로그인은 건드리지 않는다: 컨테이너에는 접근 토큰(Claude) · 갱신 토큰을 뺀 로그인 사본(Codex)만 넣는다.
  컨테이너 안에서는 토큰을 갱신할 수 없으므로 서버 쪽 로그인이 바뀌거나 풀리지 않는다.
- 요청 기록: 시각 · 토큰 이름 · 모델 · 계정 · 걸린 시간 · 토큰 수. 설정(기본 켜짐)에 따라 받은 프롬프트 · 보낸 답변도
  저장한다 (data/llm-api-content/, 폴더 700 · 파일 600, 보관 기간 뒤 삭제). 대시보드에 로그인한 관리자만 볼 수 있다.
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

from app.paths import data_dir, find_command
from app.services import llm_sandbox

logger = logging.getLogger(__name__)

PROVIDERS = ("claude", "codex")
PROVIDER_LABEL = {"claude": "Claude", "codex": "Codex"}
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
    "providers": {"claude": True, "codex": True},
    "accounts": {},  # {"claude": {계정 id: bool}, "codex": {...}} — 없는 제공자는 '지금 로그인된 계정만'
    "strategy": "order",
    "default_model": "claude",
    "aliases": {},
    "max_concurrency": 2,
    "fast": True,  # 빠른 응답: 생각(추론) 단계를 줄인다
    "keep_content": True,  # 받은 프롬프트 · 보낸 답변을 저장해 관리 화면에서 볼 수 있게
    "content_days": 30,  # 내용 보관 기간 (지나면 지운다)
    "timeout": 300,
    "max_input_chars": 400_000,
    "tokens": {},
}

_lock = threading.RLock()
_log: deque[dict] = deque(maxlen=LOG_KEEP)
_log_loaded = False
_rate: dict[str, deque[float]] = {}
_round_robin: dict[str, int] = {}
_active = 0  # 지금 돌고 있는 요청 수
_slots: asyncio.Semaphore | None = None
_slots_size = 0


class ApiError(Exception):
    """OpenAI 형식 오류로 돌려줄 수 있는 오류."""

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
        self.retryable = False  # 다른 계정으로 다시 해 볼 만한 오류인지


# ── 저장 ──────────────────────────────────────────────────────────────────────
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


# ── 계정 ──────────────────────────────────────────────────────────────────────
def _accounts(provider: str) -> dict:
    """{accounts: [{id, email, plan, active, ...}], active} — 계정 서비스 그대로 (토큰은 들어 있지 않다)."""
    try:
        if provider == "claude":
            from app.services import claude_accounts

            return claude_accounts.list_accounts()
        from app.services import codex_accounts

        return codex_accounts.list_accounts()
    except Exception:
        logger.exception("LLM API: %s 계정 목록을 읽지 못함", provider)
        return {"accounts": [], "active": None}


def _account_flags(config: dict, provider: str, listing: dict) -> dict[str, bool]:
    """계정별 켜짐 여부. 한 번도 정하지 않은 제공자는 지금 로그인된 계정만 켠 것으로 본다."""
    saved = config["accounts"].get(provider)
    if isinstance(saved, dict):
        return {a["id"]: bool(saved.get(a["id"], False)) for a in listing["accounts"]}
    return {a["id"]: a["id"] == listing.get("active") for a in listing["accounts"]}


def installed(provider: str) -> bool:
    return bool(find_command(provider))


# ── 관리 화면 ─────────────────────────────────────────────────────────────────
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
                raise ValueError(f"별칭은 {MAX_ALIASES}개까지 둘 수 있어요.")
            clean = {}
            for name, target in aliases.items():
                if not isinstance(name, str) or not ALIAS_RE.match(name):
                    raise ValueError(f"별칭 이름이 올바르지 않아요: {str(name)[:40]}")
                _route(str(target), {})  # 가리키는 모델이 올바른지
                clean[name] = str(target)
            config["aliases"] = clean
        if "default_model" in changes:
            _route(str(changes["default_model"]), config["aliases"])
            config["default_model"] = str(changes["default_model"])
        _save(config)
    if "enabled" in changes:
        logger.warning("LLM API 서버 %s", "켬" if changes["enabled"] else "끔")


def set_account(provider: str, account_id: str, on: bool) -> None:
    if provider not in PROVIDERS or not ID_RE.match(account_id or ""):
        raise ValueError("없는 계정이에요.")
    listing = _accounts(provider)
    if account_id not in {a["id"] for a in listing["accounts"]}:
        raise ValueError("없는 계정이에요.")
    with _lock:
        config = _load()
        flags = _account_flags(config, provider, listing)
        flags[account_id] = bool(on)
        config["accounts"][provider] = flags
        _save(config)
    logger.info("LLM API: %s 계정 %s %s", provider, account_id, "켬" if on else "끔")


def _clean_token_fields(fields: dict, record: dict) -> None:
    if "name" in fields:
        name = re.sub(r"[\x00-\x1f\x7f]", "", str(fields["name"] or "")).strip()
        if not name:
            raise ValueError("토큰 이름을 적어 주세요.")
        record["name"] = name[:NAME_MAX]
    if "enabled" in fields:
        record["enabled"] = bool(fields["enabled"])
    if "providers" in fields:
        chosen = [p for p in PROVIDERS if p in (fields["providers"] or [])]
        if not chosen:
            raise ValueError("쓸 수 있는 제공자를 하나 이상 골라 주세요.")
        record["providers"] = chosen
    if "rpm" in fields:
        record["rpm"] = max(0, min(600, int(fields["rpm"] or 0)))
    if "expires_days" in fields:
        days = int(fields["expires_days"] or 0)
        record["expires"] = time.time() + min(days, 3650) * 86400 if days > 0 else None
    if "accounts" in fields:
        # 토큰이 쓸 계정을 정한다 ("" = 켜 둔 계정에서 자동)
        pinned = {}
        for provider in PROVIDERS:
            value = str((fields["accounts"] or {}).get(provider) or "")
            if value and not ID_RE.match(value):
                raise ValueError("없는 계정이에요.")
            pinned[provider] = value
        record["accounts"] = pinned


def create_token(fields: dict) -> tuple[str, dict]:
    """(토큰, 공개 정보) — 토큰은 이때만 알 수 있다."""
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
            raise ValueError(f"토큰은 {MAX_TOKENS}개까지 만들 수 있어요.")
        config["tokens"][_hash(token)] = record
        _save(config)
    logger.info("LLM API 토큰 만듦 · %s · %s", record["id"], record["name"])
    return token, _public_token(record)


def _find_token(config: dict, token_id: str) -> tuple[str, dict]:
    for key, record in config["tokens"].items():
        if record.get("id") == token_id:
            return key, record
    raise KeyError("없는 토큰이에요.")


def update_token(token_id: str, fields: dict) -> dict:
    with _lock:
        config = _load()
        _, record = _find_token(config, token_id)
        _clean_token_fields(fields, record)
        _save(config)
        return _public_token(record)


def rotate_token(token_id: str) -> tuple[str, dict]:
    """같은 설정으로 토큰 값만 새로 만든다 (예전 값은 바로 못 쓴다)."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    with _lock:
        config = _load()
        key, record = _find_token(config, token_id)
        config["tokens"].pop(key)
        record["hint"] = f"{token[:6]}…{token[-4:]}"
        config["tokens"][_hash(token)] = record
        _save(config)
    logger.info("LLM API 토큰 다시 만듦 · %s · %s", record["id"], record["name"])
    return token, _public_token(record)


def delete_token(token_id: str) -> None:
    with _lock:
        config = _load()
        key, record = _find_token(config, token_id)
        config["tokens"].pop(key)
        _save(config)
    _rate.pop(token_id, None)
    logger.info("LLM API 토큰 지움 · %s · %s", record["id"], record["name"])


# ── 요청 확인 ─────────────────────────────────────────────────────────────────
def authenticate(token: str) -> dict | None:
    """살아 있는 토큰의 기록 (없거나 꺼졌거나 만료면 None)."""
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
    """분당 요청 수 제한. 넘었으면 기다릴 초, 아니면 0 (통과하면 이번 요청을 센다)."""
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


# ── 모델 ──────────────────────────────────────────────────────────────────────
def _route(model: str, aliases: dict) -> tuple[str, str]:
    """모델 이름 → (제공자, CLI 에 넘길 모델 · 없으면 CLI 기본값)."""
    name = (model or "").strip()
    name = aliases.get(name, name)
    provider, _, sub = name.partition("/")
    if provider not in PROVIDERS:
        # 제공자 없이 모델 이름만 온 경우
        sub = name
        low = name.lower()
        if low.startswith("claude") or low in CLAUDE_MODELS:
            provider = "claude"
        elif re.match(r"^(gpt-|o\d|codex)", low):
            provider = "codex"
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
    """Codex 가 쓸 수 있는 모델 이름들 — Codex CLI 가 받아 둔 목록(~/.codex/models_cache.json)에서 읽는다."""
    try:
        from app.services import codex_accounts

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
    return [slug for _, slug in sorted(found)]


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
    known = {m["id"] for m in out}
    out += [{"id": a, "owned_by": "alias"} for a in config["aliases"] if a not in known]
    return out


def resolve(model: str | None, record: dict | None) -> tuple[str, str, list[dict]]:
    """(제공자, CLI 모델, 차례대로 써 볼 계정들)."""
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
    # 지금 로그인된 계정 먼저, 나머지는 메일 순서 (list_accounts 가 그렇게 정렬해 준다)
    if config["strategy"] == "round_robin" and len(candidates) > 1:
        with _lock:
            turn = _round_robin.get(provider, 0)
            _round_robin[provider] = turn + 1
        shift = turn % len(candidates)
        candidates = candidates[shift:] + candidates[:shift]
    return provider, sub, candidates


# ── 실행 (격리 컨테이너 안에서만 — app/services/llm_sandbox.py) ──────────────────
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
    error.retryable = True  # 다른 계정으로 해 볼 수 있다
    return error


def _blocked() -> ApiError:
    return ApiError(
        502,
        "The model tried to use a tool, which is not allowed.",
        "api_error",
        "tool_use_blocked",
    )


def _claude_token(account: dict) -> str:
    """이 계정의 접근 토큰 (몇 시간짜리). 컨테이너에는 이것만 들어간다 — 갱신 토큰 · 로그인 파일은 넣지 않는다."""
    from app.services import claude_accounts

    if account.get("active"):
        oauth = claude_accounts._oauth(
            claude_accounts._read_json(claude_accounts.live_file())
        )
        if oauth and claude_accounts._usable(oauth):
            return oauth["accessToken"]
        # 지금 로그인된 계정의 토큰은 실행 중인 Claude Code 가 갱신한다 (대시보드가 갱신하면 그쪽 로그인이 풀릴 수 있다)
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
    """컨테이너에 넣을 Codex 로그인 사본: 갱신 토큰을 뺀다 → 컨테이너 안에서는 토큰을 갱신(교체)할 수 없다."""
    import base64

    from app.services import codex_accounts

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
    """격리 컨테이너 안에서 CLI 를 돌려 표준 출력의 JSON 줄을 하나씩 준다. 끝나면 {"_exit": 코드, "_stderr": 글}.

    target = (요청 id, 계정 폴더, 사용자 번호). 받는 쪽이 그만두거나(연결 끊김) 시간이 넘으면 안의 프로세스를 끝낸다.
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
            llm_sandbox._container_ok = (0.0, "")  # 다음 요청에서 다시 띄운다
            logger.error("LLM API: 격리 컨테이너에서 실행 실패 · %s", stderr[-500:])
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
    except ValueError as error:  # 한 줄이 너무 길다
        raise ApiError(
            502, "The CLI produced an oversized message.", "api_error"
        ) from error
    finally:
        llm_sandbox.kill(*target)  # 끝났어도 부른다 (pid 파일 정리)
        if not finished:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stderr_task.cancel()


def _cli_error(provider: str, detail: str, code: int | None = None) -> ApiError:
    """CLI 가 실패했을 때의 오류. 자세한 내용은 서버 기록에만 남기고, 호출한 쪽에는 종류만 알린다."""
    logger.warning(
        "LLM API: %s 실패 (exit %s) · %s",
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
        extra["MAX_THINKING_TOKENS"] = "0"  # 생각 단계 없이 바로 답한다
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
            # 도구 · MCP 서버가 하나라도 붙어 있으면 시작하지 않는다
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
                got_text = True  # 조각으로 오지 않은 답
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
    # Codex 는 로그인을 파일로만 읽는다 → (갱신 토큰을 뺀) 사본을 환경 변수로 넘겨 컨테이너 안 계정 폴더(메모리)에만 쓴다.
    # 서버 디스크에는 아무것도 남기지 않는다.
    target = (llm_sandbox.new_request(), home, user)
    argv = llm_sandbox.exec_argv(
        *target,
        command,
        timeout=timeout,
        env={"CODEX_HOME": "{home}/codex", "UD_FILE": "codex/auth.json"},
        pass_env=("UD_FILE_DATA",),
    )
    env = llm_sandbox.client_env({"UD_FILE_DATA": json.dumps(auth)})
    # Codex 는 답을 조각이 아니라 메시지 단위로 주고, 최종 답 앞에 "~하겠습니다" 같은 중간 말을 따로 보낸다.
    # API 답으로는 마지막 메시지(최종 답)만 내보낸다.
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
            # 컨테이너에 없는 보조 프로그램(code mode host 등)을 못 띄웠다는 알림은 오류가 아니다
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


def _semaphore(size: int) -> asyncio.Semaphore:
    global _slots, _slots_size
    if _slots is None or _slots_size != size:
        _slots, _slots_size = asyncio.Semaphore(size), size
    return _slots


async def generate(
    model: str | None, system: str, prompt: str, record: dict | None, meta: dict
) -> AsyncIterator[tuple[str, object]]:
    """답을 조각으로 준다: ("text", 글) … 그리고 한 번 ("usage", {input, output}).

    켜 둔 계정을 차례로 써 본다 — 한도 초과 · 로그인 만료처럼 계정 탓인 오류가 답이 나오기 전에 나면 다음 계정으로.
    meta 에는 기록용 정보(provider · account · model)를 채운다.
    """
    global _active
    provider, sub, candidates = resolve(model, record)
    reason = await asyncio.to_thread(llm_sandbox.problem)
    if reason:
        # 격리 없이 돌리는 대체 경로는 없다
        logger.error("LLM API: 격리 실행 불가 · %s", reason)
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
    runner = _run_claude if provider == "claude" else _run_codex
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
                    "LLM API: %s 계정 %s 실패 → 다음 계정 · %s",
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


# ── 기록 ──────────────────────────────────────────────────────────────────────
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


# 요청 내용 (받은 메시지 · 보낸 답변): 요청마다 파일 하나 (data/llm-api-content/<id>.json · 폴더 700 · 파일 600).
# 대시보드에 로그인한 관리자만 본다. 보관 기간이 지나거나 개수 · 용량이 넘으면 오래된 것부터 지운다.
CONTENT_ID = re.compile(r"^[0-9a-f]{16}$")
CONTENT_TEXT_MAX = 400_000  # 메시지 하나 · 답변 하나에서 저장할 최대 글자
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
    return text[:CONTENT_TEXT_MAX] + f"\n… ({len(text) - CONTENT_TEXT_MAX}자 생략)"


def _prune_content(days: int) -> None:
    """(_lock 안에서) 보관 기간이 지난 내용, 개수 · 용량을 넘는 오래된 내용을 지운다. 10분에 한 번."""
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
    files.sort(reverse=True)  # 새것부터
    total = 0
    for index, (_, size, path) in enumerate(files):
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
        logger.exception("LLM API 요청 내용 저장 실패")
        return False


def request_content(request_id: str) -> dict | None:
    """요청 하나의 기록 + 저장된 내용 (없으면 None)."""
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
    """요청 하나를 기록하고 토큰의 누적 값을 올린다. 설정이 켜져 있으면 받은 메시지 · 보낸 답변도 저장한다."""
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
        "token": record["name"] if record else "관리자 테스트",
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
            logger.exception("LLM API 기록 저장 실패")
        if record is None:
            return
        config = _load()
        try:
            _, saved = _find_token(config, record["id"])
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
        for path in _content_dir().glob(
            "*.json"
        ):  # 저장해 둔 프롬프트 · 답변도 함께 지운다
            path.unlink(missing_ok=True)
