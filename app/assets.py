"""정적 파일 주소에 버전을 붙인다: /static/app.js → /static/app.js?v=<내용이 바뀌면 바뀌는 값>.

버전이 붙은 주소는 SecurityMiddleware 가 1년 immutable 로 캐시시킨다.
그래서 페이지를 옮길 때 JS · CSS 를 다시 받지 않고, 파일을 고치면 주소가 바뀌어 바로 새 파일을 받는다.
"""

from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
_cache: dict[str, tuple[int, int, str]] = {}


def asset_url(path: str) -> str:
    """템플릿용: {{ asset('app.js') }}"""
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
    templates.env.globals["asset"] = asset_url


def static_cache_control(path: str, query: str) -> bytes | None:
    """/static 응답의 Cache-Control. 그 밖의 경로는 None (기본 no-store 유지)."""
    if not path.startswith("/static/"):
        return None
    if any(part.startswith("v=") for part in query.split("&")):
        return b"public, max-age=31536000, immutable"
    if path.startswith("/static/vendor/"):
        # CSS 안에서 상대 경로로 부르는 글꼴 등 — 바뀌지 않는 외부 라이브러리 파일
        return b"public, max-age=2592000"
    # 버전 없는 주소(아이콘 · manifest 등)는 매번 ETag 로 확인 (바뀌지 않았으면 304)
    return b"no-cache"


__all__ = ["asset_url", "install", "static_cache_control"]
