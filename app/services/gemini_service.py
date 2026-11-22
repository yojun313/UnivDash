"""Gemini (Google Antigravity CLI · 명령 이름 `agy`) 의 로그인 · 남은 한도 · 사용 기록.

- 로그인 토큰: ~/.gemini/antigravity-cli/antigravity-oauth-token (읽기만 한다. 고치지 않는다)
- 대화 기록: ~/.gemini/antigravity-cli/brain/<대화 ID>/.system_generated/logs/transcript_full.jsonl
- 남은 한도: Antigravity CLI 의 /usage 와 같은 곳(cloudcode-pa)에 물어본다. 토큰은 서버 안에서만 쓰고
  브라우저로 내보내지 않는다.

Google 의 접근 토큰은 한 시간짜리다. 만료됐으면 대시보드가 직접 갱신하지 않고 `agy models` 를 한 번 돌려
CLI 가 자기 토큰 파일을 갱신하게 한다 (갱신 토큰을 대시보드가 다루지 않는다).
"""

import hashlib
import json
import logging
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.paths import data_dir, find_command
from app.services import transcript_service

logger = logging.getLogger(__name__)

API_HOST = "daily-cloudcode-pa.googleapis.com"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
TOKEN_FILE = "antigravity-oauth-token"
REFRESH_EVERY = 120.0  # `agy models` 로 토큰을 갱신시키는 최소 간격 (초)
LIMITS_TTL = 60.0
PROFILE_TTL = 3600.0

_lock = threading.Lock()
_refresh_lock = threading.Lock()
_last_refresh = 0.0
_limits_cache: dict[str, tuple[float, dict | None]] = {}
_profile_cache: dict[str, tuple[float, dict]] = {}


def root() -> Path:
    return transcript_service.gemini_root()


def token_path(home: Path | None = None) -> Path:
    return (home or root()) / TOKEN_FILE


def read_token(path: Path | None = None) -> dict | None:
    """{"access", "refresh", "expires"(epoch 초)} — 로그인돼 있지 않으면 None."""
    try:
        data = json.loads((path or token_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = data.get("token") if isinstance(data, dict) else None
    if not isinstance(token, dict) or not isinstance(token.get("access_token"), str):
        return None
    expires = 0.0
    raw = token.get("expiry")
    if isinstance(raw, str) and raw:
        try:
            expires = datetime.fromisoformat(raw).timestamp()
        except ValueError:
            expires = 0.0
    return {
        "access": token["access_token"],
        "refresh": token.get("refresh_token")
        if isinstance(token.get("refresh_token"), str)
        else "",
        "expires": expires,
    }


def account_key(token: dict | None) -> str:
    """계정을 구분하는 키 (갱신 토큰의 해시 앞부분 — 비밀값 자체는 어디에도 남기지 않는다)."""
    secret = (token or {}).get("refresh") or (token or {}).get("access") or ""
    return hashlib.sha256(secret.encode()).hexdigest()[:16] if secret else ""


def logged_in() -> bool:
    return read_token() is not None


def _refresh_with_cli() -> None:
    """만료된 토큰: Antigravity CLI 가 스스로 갱신하게 `agy models` 를 한 번 돌린다."""
    global _last_refresh
    binary = find_command("agy")
    if not binary:
        return
    with _refresh_lock:
        if time.monotonic() - _last_refresh < REFRESH_EVERY:
            return
        _last_refresh = time.monotonic()
        from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

        try:
            subprocess.run(
                [binary, "models"],
                env={**_env(), "NO_COLOR": "1"},
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=40,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            logger.debug("agy models 실행 실패", exc_info=True)


def fresh_token(refresh: bool = True) -> dict | None:
    """쓸 수 있는(만료되지 않은) 토큰. 만료됐으면 CLI 로 갱신을 한 번 시도한다."""
    token = read_token()
    if token is None:
        return None
    if token["expires"] and token["expires"] - time.time() < 90:
        if not refresh:
            return None
        _refresh_with_cli()
        token = read_token()
        if token is None or (token["expires"] and token["expires"] - time.time() < 30):
            return None
    return token


def _request(url: str, access: str, body: dict | None = None) -> tuple[int, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {access}",
            "Content-Type": "application/json",
            "User-Agent": "antigravity",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read(4 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        return error.code, None
    except (OSError, ValueError):
        return 0, None


def _call(method: str, access: str, body: dict | None = None) -> tuple[int, Any]:
    return _request(f"https://{API_HOST}/v1internal:{method}", access, body or {})


# ── 계정 (메일 · 요금제) ─────────────────────────────────────────────────────


def _profile_file() -> Path:
    return data_dir() / "gemini-profile.json"


def _stored_profiles() -> dict:
    try:
        data = json.loads(_profile_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _store_profile(key: str, profile: dict) -> None:
    import os
    import secrets

    data = _stored_profiles()
    data[key] = profile
    if len(data) > 40:
        for old in list(data)[:-40]:
            data.pop(old, None)
    path = _profile_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, path)


def profile(token: dict | None = None, fetch: bool = True) -> dict:
    """{"email", "plan"} — 메일과 요금제 이름만 (비밀값은 담지 않는다). 모르면 값이 None."""
    token = token or read_token()
    key = account_key(token)
    if not key:
        return {"email": None, "plan": None}
    with _lock:
        cached = _profile_cache.get(key)
    if cached and time.monotonic() - cached[0] < PROFILE_TTL:
        return cached[1]
    stored = _stored_profiles().get(key)
    result = (
        {"email": stored.get("email"), "plan": stored.get("plan")}
        if isinstance(stored, dict)
        else {"email": None, "plan": None}
    )
    usable = token if token and token["expires"] - time.time() > 30 else None
    if fetch and usable:
        status, info = _request(USERINFO_URL, usable["access"])
        if (
            status == 200
            and isinstance(info, dict)
            and isinstance(info.get("email"), str)
        ):
            result["email"] = info["email"][:254]
        status, assist = _call("loadCodeAssist", usable["access"])
        if status == 200 and isinstance(assist, dict):
            tier = assist.get("paidTier") or assist.get("currentTier")
            if isinstance(tier, dict) and isinstance(tier.get("name"), str):
                result["plan"] = tier["name"][:60]
        if result["email"] or result["plan"]:
            try:
                _store_profile(key, result)
            except OSError:
                logger.debug("Gemini 계정 정보 저장 실패", exc_info=True)
            with _lock:
                _profile_cache[key] = (time.monotonic(), result)
    return result


def forget_profile(key: str) -> None:
    """로그아웃한 계정의 메일 · 요금제 기록을 지운다."""
    import os
    import secrets

    with _lock:
        _profile_cache.pop(key, None)
    data = _stored_profiles()
    if key not in data:
        return
    data.pop(key, None)
    path = _profile_file()
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, path)


def account_email() -> str | None:
    return profile(fetch=False)["email"] or profile()["email"]


# ── 남은 한도 ───────────────────────────────────────────────────────────────

_WINDOW_MINUTES = {"5h": 300, "weekly": 10080}


def _group_name(display: str) -> str:
    return "Gemini" if "gemini" in display.lower() else "Claude · GPT"


def _windows(summary: Any, quota: Any, now: datetime, make_window) -> list[dict]:
    windows: list[dict] = []
    groups = summary.get("groups") if isinstance(summary, dict) else None
    for group in groups if isinstance(groups, list) else []:
        if not isinstance(group, dict):
            continue
        name = _group_name(str(group.get("displayName") or ""))
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict):
                continue
            minutes = _WINDOW_MINUTES.get(str(bucket.get("window") or ""))
            remaining = bucket.get("remainingFraction")
            if not isinstance(remaining, (int, float)):
                remaining = 0.0  # 값이 없으면 다 쓴 것 (proto 의 0 은 생략된다)
            label = "현재 세션" if minutes == 300 else "주간" if minutes else "한도"
            windows.append(
                make_window(
                    f"gemini-{bucket.get('bucketId') or label}",
                    f"{label} · {name}",
                    (1.0 - float(remaining)) * 100,
                    bucket.get("resetTime"),
                    minutes,
                    now,
                )
            )
    # 묶음 요약에 Gemini 모델이 빠져 오는 계정이 있다 → 모델별 한도(5시간 창)에서 만든다
    if not any(" · Gemini" in w["label"] for w in windows):
        buckets = quota.get("buckets") if isinstance(quota, dict) else None
        gemini = [
            b
            for b in (buckets if isinstance(buckets, list) else [])
            if isinstance(b, dict)
            and str(b.get("modelId") or "").startswith("gemini")
            and b.get("resetTime")
        ]
        if gemini:
            worst = min(
                gemini,
                key=lambda b: (
                    b.get("remainingFraction")
                    if isinstance(b.get("remainingFraction"), (int, float))
                    else 0.0
                ),
            )
            remaining = worst.get("remainingFraction")
            if not isinstance(remaining, (int, float)):
                remaining = 0.0
            windows.insert(
                0,
                make_window(
                    "gemini-1p-5h",
                    "현재 세션 · Gemini",
                    (1.0 - float(remaining)) * 100,
                    worst.get("resetTime"),
                    300,
                    now,
                ),
            )
    # 화면은 Gemini 묶음을 먼저 보여 준다
    windows.sort(
        key=lambda w: (" · Gemini" not in w["label"], w["window_minutes"] or 0)
    )
    return windows


def limits(now: datetime | None = None, token: dict | None = None) -> dict | None:
    """남은 한도 (없으면 None). token 을 주면 그 계정(저장해 둔 계정)의 한도."""
    from app.services.ai_usage_service import AIUsageService

    now = now or datetime.now().astimezone()
    current = token is None
    token = fresh_token() if current else token
    key = account_key(token) or account_key(read_token())
    with _lock:
        cached = _limits_cache.get(key)
    if cached and time.monotonic() - cached[0] < LIMITS_TTL:
        return cached[1]
    if token is None or (token["expires"] and token["expires"] - time.time() < 30):
        return cached[1] if cached else None
    status, summary = _call("retrieveUserQuotaSummary", token["access"])
    if status != 200:
        if status in {401, 403} and current:
            _refresh_with_cli()
        return cached[1] if cached else None
    _status, quota = _call("retrieveUserQuota", token["access"])
    windows = _windows(summary, quota, now, AIUsageService._window)
    result = (
        {
            "plan": profile(token)["plan"],
            "updated_at": datetime.now(UTC).astimezone().isoformat(),
            "windows": windows,
            "breakdown": [],
            "credits": None,
        }
        if windows
        else None
    )
    with _lock:
        if len(_limits_cache) > 40:
            _limits_cache.clear()
        _limits_cache[key] = (time.monotonic(), result)
    return result


def forget_limits() -> None:
    with _lock:
        _limits_cache.clear()


# ── 사용 기록 (토큰 수) ──────────────────────────────────────────────────────


def recent_logs(cutoff: datetime, limit: int = 500) -> list[Path]:
    brain = root() / "brain"
    if not brain.is_dir():
        return []
    found = []
    try:
        for path in brain.glob("*/.system_generated/logs/transcript_full.jsonl"):
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            if modified >= cutoff.timestamp():
                found.append((modified, path))
    except OSError:
        return []
    found.sort(reverse=True)
    return [path for _, path in found[:limit]]


def workspace(conversation_id: str) -> str | None:
    """대화를 시작한 폴더 (Antigravity CLI 의 요약 DB 기준)."""
    info = transcript_service.gemini_summaries().get(conversation_id)
    return info["cwd"] if info else None


def workspace_of(conversation_id: str, cache: dict | None = None) -> str | None:
    """대화를 시작한 폴더 (cache/last_conversations.json 은 폴더 → 마지막 대화만 알려 준다)."""
    if cache is None:
        try:
            cache = json.loads(
                (root() / "cache" / "last_conversations.json").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError):
            cache = {}
    if not isinstance(cache, dict):
        return None
    return next((cwd for cwd, last in cache.items() if last == conversation_id), None)


# ── 모델 목록 ───────────────────────────────────────────────────────────────
MODELS_TTL = 1800.0
_models: tuple[float, list[dict]] = (0.0, [])
_models_lock = threading.Lock()


def _load_models() -> list[dict]:
    """`agy models` 가 알려 주는 모델 (한 줄에 "이름<탭>표시 이름")."""
    binary = find_command("agy")
    if not binary:
        return []
    from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

    try:
        result = subprocess.run(
            [binary, "models"],
            env={**_env(), "NO_COLOR": "1"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=40,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    found: list[dict] = []
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        name, tab, label = line.partition("\t")
        name = name.strip()
        if tab and name and len(name) <= 80 and all(m["id"] != name for m in found):
            found.append({"id": name, "name": label.strip()[:80] or name})
    return found


def _refresh_models() -> None:
    global _models
    if not _models_lock.acquire(blocking=False):
        return
    try:
        found = _load_models()
        if found or not _models[1]:
            _models = (time.monotonic(), found)
        else:  # 이번에는 못 받았다 → 예전 목록을 그대로 두고 잠시 뒤 다시
            _models = (time.monotonic() - MODELS_TTL + 120, _models[1])
    finally:
        _models_lock.release()


def models() -> list[dict]:
    """[{"id", "name"}] — 30분마다 뒤에서 다시 받고, 그동안은 받아 둔 목록을 준다."""
    stamp, cached = _models
    if stamp and time.monotonic() - stamp < MODELS_TTL:
        return cached
    if not stamp:  # 처음 한 번은 기다린다 (몇 초)
        _refresh_models()
        return _models[1]
    threading.Thread(target=_refresh_models, daemon=True, name="gemini-models").start()
    return cached
