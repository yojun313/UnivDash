"""마크다운 → PDF: 파일 뷰어에 보이는 모습 그대로 (같은 렌더링 함수 · 같은 CSS 를 헤드리스 Chrome 에서 실행).

1) md 파일을 읽어 임시 폴더에 HTML 한 장을 만든다. 이 HTML 은 app/static 의 common.js · marked · DOMPurify ·
   KaTeX · highlight.js · explorer.js 와 app.css 를 그대로 불러, 뷰어와 같은 renderMarkdownHtml() 로 그린다 (라이트 테마).
2) Chrome --print-to-pdf 로 A4 PDF 를 만든다. 배율은 문서 전체에 CSS zoom 으로 준다.
3) 미리보기는 pdftoppm 으로 쪽마다 PNG. 저장은 md 옆에 같은 이름 .pdf, 다운로드는 그대로.

보안: 외부 네트워크는 막는다(--host-resolver-rules). 대시보드 비밀값은 Chrome 환경에서 뺀다.
"""

import json
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from app.paths import data_dir
from app.services.fs_service import FsError, resolve

STATIC_DIR = Path(__file__).resolve().parents[1] / "static"
MAX_MD_BYTES = 2 * 1024 * 1024
KEEP_SECONDS = 30 * 60
ZOOM_RANGE = (0.4, 2.0)
_TOKEN = re.compile(r"^[0-9a-f]{24}$")


class MdPdfError(RuntimeError):
    pass


def chrome_path() -> str | None:
    configured = os.getenv("CHROME_PATH")
    if configured and os.access(configured, os.X_OK):
        return configured
    for name in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ):
        found = shutil.which(name)
        if found:
            return found
    return None


def _root() -> Path:
    root = data_dir() / "md-pdf"
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def _prune() -> None:
    now = time.time()
    for job in _root().iterdir():
        try:
            if now - job.stat().st_mtime > KEEP_SECONDS:
                shutil.rmtree(job, ignore_errors=True)
        except OSError:
            continue


def _job(token: str) -> Path:
    if not _TOKEN.match(token or ""):
        raise FsError("잘못된 요청입니다.")
    job = _root() / token
    if not (job / "out.pdf").is_file():
        raise FsError("PDF 가 만료됐어요. 다시 만들어 주세요.")
    return job


def _static(name: str) -> str:
    return (STATIC_DIR / name).as_uri()


def _page_html(content: str, md_path: Path, zoom: float) -> str:
    source = json.dumps(
        {"content": content, "path": str(md_path)}, ensure_ascii=False
    ).replace("</", "<\\/")
    css = [
        "vendor/fonts.css",
        "vendor/fontawesome/css/all.min.css",
        "theme.css",
        "app.css",
        "vendor/katex/katex.min.css",
        "vendor/highlight-github-light.scoped.css",
    ]
    scripts = [
        "common.js",
        "vendor/marked.min.js",
        "vendor/purify.min.js",
        "vendor/katex/katex.min.js",
        "vendor/highlight.min.js",
        "explorer.js",
    ]
    links = "\n".join(f'<link rel="stylesheet" href="{_static(c)}">' for c in css)
    tags = "\n".join(f'<script src="{_static(s)}"></script>' for s in scripts)
    return f"""<!doctype html>
<html lang="ko" data-ui-theme-mode="light"><head><meta charset="utf-8"><title>{md_path.stem}</title>
{links}
<style>
  @page {{ size: A4; margin: 14mm 13mm; }}
  html, body {{ background: #fff !important; margin: 0; }}
  body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  #doc {{ zoom: {zoom}; }}
  #doc .exv-md {{ max-width: none; margin: 0; padding: 0; }}
  /* 종이에서는 가로 스크롤이 없으니 긴 코드 · 표는 줄바꿈 / 축소 */
  #doc .exv-md pre code {{ white-space: pre-wrap; overflow-wrap: anywhere; }}
  #doc .exv-md pre, #doc .exv-md-table {{ overflow: visible; }}
  #doc .exv-md-table table {{ width: auto; max-width: 100%; }}
  #doc .katex-display {{ overflow: visible; }}
  #doc pre, #doc .katex-display, #doc img, #doc tr, #doc blockquote {{ break-inside: avoid; }}
  #doc h1, #doc h2, #doc h3, #doc h4 {{ break-after: avoid; }}
  #doc img {{ max-width: 100%; }}
</style>
</head><body data-page="md-pdf">
<script type="application/json" id="md-src">{source}</script>
<div id="doc"></div>
{tags}
<script>
  (function () {{
    var src = JSON.parse(document.getElementById('md-src').textContent);
    var url = function (p) {{ return 'file://' + encodeURI(p); }};
    var html = window.UnivDashExplorer && window.UnivDashExplorer.renderMarkdownHtml(src.content, src.path, {{ imageUrl: url, pdf: true }});
    document.getElementById('doc').innerHTML = html || '<pre>' + src.content.replace(/[&<>]/g, function (c) {{ return {{'&':'&amp;','<':'&lt;','>':'&gt;'}}[c]; }}) + '</pre>';
  }})();
</script>
</body></html>"""


def _env() -> dict:
    from app.services.pty_service import _env as clean_env  # 대시보드 비밀값을 뺀 환경

    return clean_env()


def render(path: str, zoom: float) -> dict:
    md = resolve(path)
    if not md.is_file() or md.suffix.lower() not in {".md", ".markdown", ".mdx"}:
        raise FsError("마크다운 파일이 아닙니다.")
    if md.stat().st_size > MAX_MD_BYTES:
        raise FsError("파일이 너무 커요 (최대 2MB).")
    chrome = chrome_path()
    if not chrome:
        raise MdPdfError("서버에 Chrome/Chromium 이 없어 PDF 를 만들 수 없어요.")
    zoom = round(min(ZOOM_RANGE[1], max(ZOOM_RANGE[0], float(zoom))), 2)
    _prune()
    token = secrets.token_hex(12)
    job = _root() / token
    job.mkdir(mode=0o700)
    content = md.read_text(encoding="utf-8", errors="replace")
    (job / "page.html").write_text(_page_html(content, md, zoom), encoding="utf-8")
    out = job / "out.pdf"
    command = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        f"--user-data-dir={job / 'profile'}",
        "--allow-file-access-from-files",
        "--host-resolver-rules=MAP * ~NOTFOUND",  # 외부 네트워크 차단 (웹 그림 · 추적 요청 없음)
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=15000",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
        (job / "page.html").as_uri(),
    ]
    try:
        result = subprocess.run(
            command,
            env=_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=90,
            check=False,
            cwd=str(job),
        )
    except subprocess.TimeoutExpired as error:
        shutil.rmtree(job, ignore_errors=True)
        raise MdPdfError("PDF 를 만드는 데 너무 오래 걸려요 (90초 초과).") from error
    shutil.rmtree(job / "profile", ignore_errors=True)
    if not out.is_file() or out.stat().st_size == 0:
        shutil.rmtree(job, ignore_errors=True)
        tail = (result.stderr or b"").decode(errors="replace").strip().splitlines()[-1:]
        raise MdPdfError(
            "PDF 를 만들지 못했어요." + (f" ({tail[0][:200]})" if tail else "")
        )
    info = subprocess.run(
        ["pdfinfo", str(out)], capture_output=True, text=True, timeout=20, check=False
    ).stdout
    match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
    return {
        "token": token,
        "pages": int(match.group(1)) if match else 1,
        "size": out.stat().st_size,
        "zoom": zoom,
        "name": f"{md.stem}.pdf",
    }


def page_png(token: str, number: int, width: int) -> Path:
    job = _job(token)
    width = max(200, min(2000, int(width)))
    target = job / f"p{number}-{width}.png"
    if not target.is_file():
        prefix = job / f"p{number}-{width}"
        subprocess.run(
            [
                "pdftoppm",
                "-png",
                "-singlefile",
                "-f",
                str(number),
                "-l",
                str(number),
                "-scale-to-x",
                str(width),
                "-scale-to-y",
                "-1",
                str(job / "out.pdf"),
                str(prefix),
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if not target.is_file():
            raise FsError("페이지를 그리지 못했어요.")
    return target


def pdf_file(token: str) -> Path:
    return _job(token) / "out.pdf"


def save_next_to(token: str, md_path: str, overwrite: bool) -> str:
    """md 옆에 같은 이름의 .pdf 로 저장. 이미 있으면 overwrite 일 때만 덮어쓴다."""
    source = pdf_file(token)
    md = resolve(md_path)
    target = md.with_suffix(".pdf")
    resolve(str(target), must_exist=False)  # 허용 범위 확인
    if target.exists() and not overwrite:
        raise FileExistsError(str(target))
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    shutil.copyfile(source, tmp)
    os.replace(tmp, target)
    return str(target)
