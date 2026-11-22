"""AI commit messages (like VS Code Copilot): sends the changes to commit (diff) to an OpenAI-compatible API and gets a message back.

- Settings (address · model · token · language) live in ai-commit.json (mode 600) in the dashboard data folder.
  The token never leaves the server (to the browser) — only whether it is set is reported.
- The repository is only read (git diff · status · log). Nothing such as staging is changed.
"""

import json
import os
import re
import secrets
from pathlib import Path

import httpx

from app.i18n import _
from app.paths import data_dir
from app.services.git.git_service import GitService

MAX_DIFF_CHARS = 24000
MAX_UNTRACKED_FILES = 20
MAX_UNTRACKED_LINES = 40
REQUEST_TIMEOUT = 60.0
LANGUAGES = {"auto", "ko", "en"}
# fallback API: when the primary API fails, retry with the OpenAI API
OPENAI_BASE_URL = "https://api.openai.com/v1"
# OpenAI /models also lists embedding · audio · image models → pick only chat models
_OPENAI_CHAT = re.compile(r"^(gpt-|o\d|chatgpt-)", re.IGNORECASE)
_OPENAI_NOT_CHAT = re.compile(
    r"(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use|deep-research)",
    re.IGNORECASE,
)
_MODEL = re.compile(r"^[\w.:/\-\[\]@+]{1,120}$")


class AICommitError(RuntimeError):
    pass


# ── Settings ──────────────────────────────────────────────────────────────────


def _settings_file() -> Path:
    return data_dir() / "ai-commit.json"


def _read() -> dict:
    try:
        data = json.loads(_settings_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def public_settings() -> dict:
    data = _read()
    return {
        "base_url": data.get("base_url") or "",
        "model": data.get("model") or "",
        "language": data.get("language") or "auto",
        "token_set": bool(data.get("token")),
        "primary_configured": _primary_ready(data),
        "fallback_model": data.get("fallback_model") or "",
        "fallback_token_set": bool(data.get("fallback_token")),
        "fallback_configured": _fallback_ready(data),
        "configured": _primary_ready(data) or _fallback_ready(data),
    }


def _primary_ready(data: dict) -> bool:
    # even with an empty model, an address is enough: /models is checked again at use (saved while the local server was off)
    return bool(data.get("base_url"))


def _fallback_ready(data: dict) -> bool:
    return bool(data.get("fallback_model") and data.get("fallback_token"))


def _clean_token(token: str) -> str:
    token = token.strip()
    if len(token) > 1000 or any(c in token for c in "\r\n"):
        raise ValueError(_("토큰 형식이 올바르지 않습니다."))
    return token


def save_settings(
    base_url: str,
    model: str,
    token: str | None,
    language: str,
    fallback_model: str | None = None,
    fallback_token: str | None = None,
) -> dict:
    """token · fallback_token: None keeps the existing value, "" removes it. fallback_model: None leaves it as is."""
    base_url = (base_url or "").strip().rstrip("/")
    model = (model or "").strip()
    if fallback_model is not None:
        fallback_model = fallback_model.strip()
        if fallback_model and not _MODEL.match(fallback_model):
            raise ValueError(_("예비 모델 이름이 올바르지 않습니다."))
    if base_url and not re.match(r"^https?://[^\s/?#]+(?:/[^\s?#]*)?$", base_url):
        raise ValueError(
            _(
                "API 주소는 http:// 또는 https:// 로 시작해야 합니다 (예: https://api.openai.com/v1)."
            )
        )
    if len(base_url) > 500:
        raise ValueError(_("API 주소가 너무 깁니다."))
    if model and not _MODEL.match(model):
        raise ValueError(_("모델 이름이 올바르지 않습니다."))
    if language not in LANGUAGES:
        raise ValueError(_("언어 설정이 올바르지 않습니다."))
    data = _read()
    data.update({"base_url": base_url, "model": model, "language": language})
    if token is not None:
        data["token"] = _clean_token(token)
    if fallback_model is not None:
        data["fallback_model"] = fallback_model
    if fallback_token is not None:
        data["fallback_token"] = _clean_token(fallback_token)
    path = _settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, path)
    return public_settings()


def _validated_base_url(base_url: str) -> str:
    base_url = (base_url or "").strip().rstrip("/")
    if not re.match(r"^https?://[^\s/?#]+(?:/[^\s?#]*)?$", base_url):
        raise ValueError(_("API 주소는 http:// 또는 https:// 로 시작해야 합니다."))
    if len(base_url) > 500:
        raise ValueError(_("API 주소가 너무 깁니다."))
    return base_url


def discover_model(
    base_url: str, token: str | None = None, target: str = "primary"
) -> dict:
    """Reads the currently available models from the OpenAI-compatible /models and picks one automatically.

    target="fallback": the fallback API (fixed OpenAI address · saved fallback token); returns chat models only."""
    if target == "fallback":
        saved = _read()
        token = _clean_token(
            token if token is not None else saved.get("fallback_token") or ""
        )
        if not token:
            raise AICommitError(_("OpenAI API 키를 입력해 주십시오."))
        listed = _list_models(f"{OPENAI_BASE_URL}/models", token)
        models = sorted(
            (
                m
                for m in listed["models"]
                if _OPENAI_CHAT.match(m) and not _OPENAI_NOT_CHAT.search(m)
            ),
            reverse=True,
        )
        if not models:
            raise AICommitError(_("이 키로 쓸 수 있는 대화용 모델이 없습니다."))
        current = saved.get("fallback_model") or ""
        return {"model": current if current in models else models[0], "models": models}
    base_url = _validated_base_url(base_url)
    if base_url.endswith("/chat/completions"):
        models_url = base_url[: -len("/chat/completions")] + "/models"
    elif base_url.endswith("/models"):
        models_url = base_url
    else:
        models_url = base_url + "/models"

    saved = _read()
    if token is None and saved.get("base_url", "").rstrip("/") == base_url:
        token = saved.get("token") or ""
    listed = _list_models(models_url, _clean_token(token or ""))
    models, rows = listed["models"], listed["rows"]
    # when the server marks an active model, prefer it; otherwise default to the first /models entry.
    active = next(
        (
            row.get("id") or row.get("name")
            for row in rows
            if isinstance(row, dict)
            and (row.get("loaded") or row.get("active") or row.get("currently_loaded"))
            and isinstance(row.get("id") or row.get("name"), str)
        ),
        models[0],
    )
    return {"model": active, "models": models}


def _list_models(models_url: str, token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        with httpx.Client(timeout=15.0, follow_redirects=False) as client:
            response = client.get(models_url, headers=headers)
    except httpx.TimeoutException as error:
        raise AICommitError(_("모델 목록 조회 시간이 초과됐습니다.")) from error
    except httpx.HTTPError as error:
        raise AICommitError(
            _(
                "모델 목록을 가져오지 못했습니다:{error}",
                error=type(error).__name__,
            )
        ) from error
    if response.status_code >= 400:
        raise AICommitError(
            _(
                "모델 목록 조회 실패 ({status}). API 주소와 토큰을 확인해 주십시오.",
                status=response.status_code,
            )
        )
    try:
        payload = response.json()
        rows = (
            payload.get("data", payload.get("models", []))
            if isinstance(payload, dict)
            else []
        )
        models = [
            row.get("id") or row.get("name")
            for row in rows
            if isinstance(row, dict)
            and isinstance(row.get("id") or row.get("name"), str)
        ]
    except (ValueError, TypeError, AttributeError) as error:
        raise AICommitError(
            _("모델 목록 응답이 OpenAI 호환 형식이 아닙니다.")
        ) from error
    models = list(dict.fromkeys(model.strip() for model in models if model.strip()))
    if not models:
        raise AICommitError(_("API 주소에서 사용 가능한 모델을 찾지 못했습니다."))
    return {"models": models, "rows": rows}


# ── Collecting changes (read only) ───────────────────────────────────────────────


def _git(path: Path, *args: str) -> str:
    return GitService._run(path, *args).stdout or ""


def collect_changes(repository_id: str, include_all: bool) -> dict:
    repository = GitService._get_repository(repository_id)
    path = repository.path
    has_head = GitService._has_head(path)
    if include_all:
        diff = (
            _git(path, "diff", "--no-ext-diff", "HEAD")
            if has_head
            else _git(path, "diff", "--no-ext-diff", "--cached")
            + _git(path, "diff", "--no-ext-diff")
        )
        untracked = [
            line
            for line in _git(
                path, "ls-files", "--others", "--exclude-standard", "-z"
            ).split("\0")
            if line
        ]
    else:
        diff = _git(path, "diff", "--no-ext-diff", "--cached")
        untracked = []
    # new (untracked) files: only the beginning
    for name in untracked[:MAX_UNTRACKED_FILES]:
        file = (path / name).resolve()
        try:
            file.relative_to(path.resolve())
            if not file.is_file() or file.stat().st_size > 512 * 1024:
                diff += f"\nnew file: {name}\n"
                continue
            lines = file.read_text(encoding="utf-8", errors="replace").splitlines()[
                :MAX_UNTRACKED_LINES
            ]
        except (OSError, ValueError):
            continue
        diff += f"\nnew file: {name}\n" + "\n".join(f"+{line}" for line in lines) + "\n"
    if len(untracked) > MAX_UNTRACKED_FILES:
        diff += f"\n(새 파일 {len(untracked) - MAX_UNTRACKED_FILES}개 더)\n"
    if not diff.strip():
        raise AICommitError(
            _("커밋할 변경이 없습니다.")
            if include_all
            else _(
                "스테이징된 변경이 없습니다. 파일을 스테이징하거나 '모든 변경 포함'을 켜 주십시오."
            )
        )
    truncated = len(diff) > MAX_DIFF_CHARS
    stat_args = (
        ["diff", "--stat", "HEAD"]
        if include_all and has_head
        else ["diff", "--stat", "--cached"]
    )
    stat = _git(path, *stat_args).strip()
    recent = _git(path, "log", "-8", "--pretty=format:%s").strip() if has_head else ""
    return {
        "diff": diff[:MAX_DIFF_CHARS]
        + ("\n… (diff 가 길어 뒷부분은 생략)" if truncated else ""),
        "stat": stat[-3000:],
        "recent": recent,
        "branch": _git(path, "rev-parse", "--abbrev-ref", "HEAD").strip()
        if has_head
        else "",
    }


# ── Generation ────────────────────────────────────────────────────────────────

_SYSTEM = (
    "You write git commit messages for the given changes. Reply with the commit message only — no code fences, "
    "no quotes, no explanations. Format: a concise summary line (imperative mood, at most 72 characters), then, "
    "only if it helps, a blank line and a short body of '- ' bullet points explaining what changed and why. "
    "Do not invent changes that are not in the diff."
)
_LANGUAGE_HINT = {
    "auto": "Write in the same language and style as the recent commit subjects if there are any; otherwise English.",
    "ko": "Write the message in Korean.",
    "en": "Write the message in English.",
}


def _endpoint(base_url: str) -> str:
    return (
        base_url
        if base_url.endswith("/chat/completions")
        else f"{base_url}/chat/completions"
    )


def _clean(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[\w-]*\n?|\n?```$", "", text).strip()
    text = re.sub(
        r"<think>.*?</think>", "", text, flags=re.DOTALL
    ).strip()  # for models that emit their thinking
    return text.strip('"').strip()


def _build_prompt(changes: dict, language: str) -> str:
    return "\n\n".join(
        part
        for part in [
            _LANGUAGE_HINT[language if language in LANGUAGES else "auto"],
            f"Branch: {changes['branch']}" if changes["branch"] else "",
            f"Recent commit subjects (style reference):\n{changes['recent']}"
            if changes["recent"]
            else "",
            f"Changed files:\n{changes['stat']}" if changes["stat"] else "",
            f"Diff:\n{changes['diff']}",
        ]
        if part
    )


def _ask(base_url: str, model: str, token: str, prompt: str) -> str:
    """Asks one API for a commit message. Raises AICommitError on failure."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ],
    }
    # OpenAI reasoning models (o series · gpt-5 and later) do not accept a changed temperature
    if not re.match(r"^(o\d|gpt-[5-9])", model, re.IGNORECASE):
        body["temperature"] = 0.2
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT, follow_redirects=False) as client:
            response = client.post(_endpoint(base_url), headers=headers, json=body)
    except httpx.TimeoutException as error:
        raise AICommitError(_("AI 응답이 너무 늦습니다 (60초 초과).")) from error
    except httpx.HTTPError as error:
        raise AICommitError(
            _("AI 서버에 연결하지 못했습니다:{error}", error=type(error).__name__)
        ) from error
    if response.status_code >= 400:
        detail = ""
        try:
            payload = response.json()
            detail = (
                (payload.get("error") or {}).get("message")
                if isinstance(payload.get("error"), dict)
                else payload.get("error") or payload.get("detail") or ""
            )
        except (ValueError, AttributeError):
            detail = response.text[:200]
        raise AICommitError(
            _(
                "AI 요청 실패 ({status}): {detail}",
                status=response.status_code,
                detail=str(detail)[:300],
            )
            if detail
            else _("AI 요청 실패 ({status})", status=response.status_code)
        )
    try:
        content = response.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise AICommitError(
            _(
                "AI 응답 형식을 알 수 없습니다 (OpenAI 호환 /chat/completions 인지 확인해 주십시오)."
            )
        ) from error
    message = _clean(content if isinstance(content, str) else "")
    if not message:
        raise AICommitError(_("AI 가 빈 메시지를 돌려줬습니다."))
    return message[:5000]


def generate(repository_id: str, include_all: bool) -> dict:
    """Writes with the primary API; on failure (or without a primary) writes again with the fallback API (OpenAI)."""
    settings = _read()
    attempts = []
    if _primary_ready(settings):
        attempts.append(
            (
                "primary",
                settings["base_url"],
                settings.get("model") or "",
                settings.get("token") or "",
            )
        )
    if _fallback_ready(settings):
        attempts.append(
            (
                "fallback",
                OPENAI_BASE_URL,
                settings["fallback_model"],
                settings["fallback_token"],
            )
        )
    if not attempts:
        raise AICommitError(_("AI 설정(API 주소 · 모델)을 먼저 해 주십시오."))
    changes = collect_changes(repository_id, include_all)
    prompt = _build_prompt(changes, settings.get("language") or "auto")
    errors = []
    for provider, base_url, model, token in attempts:
        try:
            if not model:
                model = discover_model(base_url, token)["model"]
            message = _ask(base_url, model, token, prompt)
        except AICommitError as error:
            errors.append((provider, str(error)))
            continue
        return {
            "message": message,
            "truncated": "생략" in changes["diff"][-40:],
            "provider": provider,
            "model": model,
            "primary_error": errors[0][1] if errors else "",
        }
    if len(errors) == 1:
        raise AICommitError(errors[0][1])
    raise AICommitError(
        _(
            "기본 API: {primary} / 예비 API(OpenAI): {fallback}",
            primary=errors[0][1],
            fallback=errors[1][1],
        )
    )
