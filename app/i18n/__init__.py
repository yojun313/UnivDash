"""Interface language (Korean / English).

Korean is the source language: every user-visible string is written in Korean in the code and wrapped
in a translation call, and English lives in catalogs keyed by that Korean text.

    Python     _("{name} 창을 닫았습니다.", name=name)        # app.i18n._
    Jinja      {{ t("로그인") }}
    JavaScript t('{count}개 삭제했습니다.', { count })          # window.t, defined by /i18n.js

Catalogs are JSON files in app/i18n/en/ (one per area, merged at start-up): {"한국어 원문": "English"}.
A string without a translation is shown in Korean, so a missing entry never breaks a screen.
`tools/i18n_check.py` lists the strings that are still missing.

The language is chosen per browser (cookie `univdash_lang`, set in Settings › Display). Without the
cookie the browser's Accept-Language decides. Text produced outside a request (push notifications)
uses the server default, which follows the language last chosen in Settings.
"""

import json
import logging
import threading
from contextvars import ContextVar
from pathlib import Path

logger = logging.getLogger(__name__)

LANGUAGES = {"ko": "한국어", "en": "English"}
LOCALES = {"ko": "ko-KR", "en": "en-US"}
SOURCE = "ko"
COOKIE = "univdash_lang"
CATALOG_DIR = Path(__file__).resolve().parent

_lock = threading.Lock()
_catalogs: dict[str, tuple[tuple, dict[str, str]]] = {}
_default = SOURCE
_current: ContextVar[str | None] = ContextVar("univdash_lang", default=None)


def _files(lang: str) -> list[Path]:
    folder = CATALOG_DIR / lang
    return sorted(folder.glob("*.json")) if folder.is_dir() else []


def catalog(lang: str) -> dict[str, str]:
    """Merged catalog for a language. Re-read when a catalog file changes."""
    if lang == SOURCE or lang not in LANGUAGES:
        return {}
    files = _files(lang)
    stamp = tuple((path.name, path.stat().st_mtime_ns) for path in files)
    with _lock:
        cached = _catalogs.get(lang)
        if cached and cached[0] == stamp:
            return cached[1]
        merged: dict[str, str] = {}
        for path in files:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                logger.warning("i18n catalog could not be read: %s", path.name)
                continue
            if isinstance(data, dict):
                merged.update(
                    {k: v for k, v in data.items() if isinstance(v, str) and v}
                )
        _catalogs[lang] = (stamp, merged)
        return merged


def version(lang: str) -> str:
    """Changes whenever the catalog changes (cache key for /i18n.js)."""
    stamp = sum(path.stat().st_mtime_ns for path in _files(lang))
    return format(stamp & 0xFFFFFFFFFF, "x")


def normalize(value: str | None) -> str | None:
    value = (value or "").strip().lower()[:8]
    return value if value in LANGUAGES else None


def from_accept_language(header: str | None) -> str:
    """Korean browsers get Korean, everyone else English."""
    for part in (header or "").split(","):
        tag = part.split(";")[0].strip().lower()
        if tag.startswith("ko"):
            return "ko"
        if tag:
            return "en"
    return _default


def pick(cookie: str | None, accept_language: str | None) -> str:
    return normalize(cookie) or from_accept_language(accept_language)


def current() -> str:
    return _current.get() or _default


def activate(lang: str | None):
    """Set the language for the current request/task. Returns a token for `deactivate`."""
    return _current.set(normalize(lang))


def deactivate(token) -> None:
    _current.reset(token)


def set_default(lang: str | None) -> None:
    """Language for text produced outside a request (push notifications, background jobs)."""
    global _default
    _default = normalize(lang) or SOURCE


def default() -> str:
    return _default


def translate(text: str, lang: str | None = None, /, **values) -> str:
    """Translate a Korean source string and fill {placeholders}."""
    lang = lang or current()
    if lang != SOURCE:
        text = catalog(lang).get(text, text)
    if values:
        try:
            return text.format(**values)
        except (KeyError, IndexError, ValueError):
            return text
    return text


def _(text: str, /, **values) -> str:
    return translate(text, None, **values)


def N_(text: str) -> str:  # noqa: N802 — gettext convention
    """Marks a string for translation without translating it now (module-level constants).

    Translate at the point of use: `_(SOME_CONSTANT)`.
    """
    return text


class LanguageMiddleware:
    """Pure ASGI middleware: picks the language of each request from the cookie / Accept-Language."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        cookie = accept = None
        for name, value in scope.get("headers") or []:
            if name == b"cookie":
                for item in value.decode("latin-1").split(";"):
                    key, _sep, val = item.strip().partition("=")
                    if key == COOKIE:
                        cookie = val
            elif name == b"accept-language":
                accept = value.decode("latin-1")
        token = activate(pick(cookie, accept))
        try:
            await self.app(scope, receive, send)
        finally:
            deactivate(token)


def install(templates) -> None:
    """Jinja helpers: {{ t("…") }}, {{ ui_lang() }}, {{ i18n_src() }}."""
    templates.env.globals["t"] = translate_for_template
    templates.env.globals["ui_lang"] = current
    templates.env.globals["i18n_src"] = lambda: (
        f"/i18n.js?l={current()}&v={version(current())}"
    )


def translate_for_template(text: str, **values) -> str:
    return translate(text, None, **values)


def script(lang: str) -> str:
    """The body of /i18n.js: the catalog for one language and the `t()` helper."""
    lang = normalize(lang) or SOURCE
    payload = json.dumps(
        {
            "lang": lang,
            "locale": LOCALES[lang],
            "languages": LANGUAGES,
            "messages": catalog(lang),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).replace("</", "<\\/")
    return (
        "(function(){'use strict';"
        f"var data={payload};"
        "var fill=function(text,values){"
        "return values?text.replace(/\\{(\\w+)\\}/g,function(m,k){return k in values?values[k]:m;}):text;};"
        "var t=function(text,values){var m=data.messages[text];return fill(m===undefined?text:m,values);};"
        "t.lang=data.lang;t.locale=data.locale;t.languages=data.languages;"
        "window.t=t;window.UnivDashI18n=data;"
        "document.documentElement.lang=data.lang;})();"
    )
