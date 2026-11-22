"""Adds a version to static file addresses: /static/app.js → /static/app.js?v=<value that changes with the content>.

SecurityMiddleware has versioned addresses cached as immutable for a year.
So moving between pages does not re-download JS · CSS, and editing a file changes its address so the new file is fetched at once.
"""

from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
_cache: dict[str, tuple[int, int, str]] = {}


def asset_url(path: str) -> str:
    """For templates: {{ asset('app.js') }}"""
    rel = path.lstrip("/")
    try:
        stat = (STATIC_DIR / rel).stat()
    except OSError:
        return f"/static/{rel}"
    cached = _cache.get(rel)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2]
    version = format((stat.st_mtime_ns ^ (stat.st_size << 20)) & 0xFFFFFFFFFF, "x")
    url = f"/static/{rel}?v={version}"
    _cache[rel] = (stat.st_mtime_ns, stat.st_size, url)
    return url


def install(templates) -> None:
    from app import i18n

    templates.env.globals["asset"] = asset_url
    i18n.install(templates)  # {{ t("…") }} · {{ ui_lang() }} · {{ i18n_src() }}


def static_cache_control(path: str, query: str) -> bytes | None:
    """Cache-Control of /static responses. None for any other path (keeps the default no-store)."""
    if not path.startswith("/static/"):
        return None
    if any(part.startswith("v=") for part in query.split("&")):
        return b"public, max-age=31536000, immutable"
    if path.startswith("/static/vendor/"):
        # Fonts etc. referenced by relative path from CSS — third-party library files that do not change
        return b"public, max-age=2592000"
    # Unversioned addresses (icons, manifest etc.) are revalidated by ETag every time (304 when unchanged)
    return b"no-cache"


__all__ = ["asset_url", "install", "static_cache_control"]
