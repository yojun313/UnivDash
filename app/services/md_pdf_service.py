"""문서 → PDF: 파일 뷰어에 보이는 모습 그대로 (같은 렌더링 함수 · 같은 CSS 를 헤드리스 Chrome 에서 실행).

파일 종류마다 PDF 를 만드는 길 (source_kind):
- md: 아래 1) 그대로. 노트북(ipynb) · 표(csv · tsv) · 그 밖의 글 파일(txt · 코드 · tex …)은
  마크다운으로 옮겨(코드 블록 · 표) 같은 길로 그린다 → 배율도 된다.
- html: 그 파일을 Chrome 으로 그대로 인쇄. hwpx: 미리보기와 같은 HTML 을 인쇄.
- office (pptx · docx · xlsx · hwp …): 미리보기와 같은 LibreOffice 변환 PDF. pdf: 원본 그대로.
  (이 셋과 html · hwpx 는 배율 없이 모아찍기만)

1) md 파일을 읽어 임시 폴더에 HTML 한 장을 만든다. 이 HTML 은 app/static 의 common.js · marked · DOMPurify ·
   KaTeX · highlight.js · explorer.js 와 app.css 를 그대로 불러, 뷰어와 같은 renderMarkdownHtml() 로 그린다 (라이트 테마).
2) Chrome --print-to-pdf 로 A4 PDF 를 만든다. 배율은 문서 전체에 CSS zoom 으로 준다.
3) 모아찍기(한 장에 2 · 4쪽)는 그 PDF 의 쪽을 벡터 그대로 줄여 배치한다 (pypdf). Chrome 을 다시 돌리지 않는다.
4) 미리보기는 pdftoppm 으로 쪽마다 PNG. 저장은 md 옆에 같은 이름 .pdf, 다운로드는 그대로.

보안: 외부 네트워크는 막는다(--host-resolver-rules). 대시보드 비밀값은 Chrome 환경에서 뺀다.
"""

import html
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from app.paths import data_dir
from app.services import preview_service
from app.services.fs_service import IMAGE_EXT, MEDIA_EXT, FsError, resolve

STATIC_DIR = Path(__file__).resolve().parents[1] / "static"
MAX_MD_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 200 * 1024 * 1024  # pdf · 오피스 원본
MAX_TABLE_ROWS = 5000
MD_EXT = {".md", ".markdown", ".mdx"}
HTML_EXT = {".html", ".htm", ".xhtml"}
# 코드 블록 언어 이름 (highlight.js) — 없으면 확장자 그대로 넘기고, 모르는 언어는 강조 없이 나온다
FENCE_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".rb": "ruby",
    ".rs": "rust",
    ".kt": "kotlin",
    ".sh": "bash",
    ".zsh": "bash",
    ".bash": "bash",
    ".yml": "yaml",
    ".h": "c",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
    ".m": "matlab",
    ".tex": "latex",
    ".txt": "",
    ".log": "",
    ".text": "",
}
KEEP_SECONDS = 30 * 60
ZOOM_RANGE = (0.4, 2.0)
_TOKEN = re.compile(r"^[0-9a-f]{24}$")
# 모아찍기: "1" · "2" (가로 종이에 왼쪽→오른쪽) · "4z" 등 (세로 종이 2×2, 순서는 아래 ORDERS)
LAYOUT = re.compile(r"^(1|2|4(z|s|rn|n))$")
A4 = (595.28, 841.89)
NUP_MARGIN = 14.0  # 종이 가장자리 여백 (pt)
NUP_GAP = 10.0  # 쪽 사이 간격 (pt)
# 2×2 칸 (열, 행 — 행 0 이 위) 을 채우는 순서
ORDERS = {
    "z": [(0, 0), (1, 0), (0, 1), (1, 1)],  # Z: 왼→오, 위→아래
    "s": [(1, 0), (0, 0), (1, 1), (0, 1)],  # 거꾸로 Z: 오→왼, 위→아래
    "n": [(0, 0), (0, 1), (1, 0), (1, 1)],  # 위→아래, 왼쪽 열부터 (지나는 길이 И 모양)
    "rn": [(1, 0), (1, 1), (0, 0), (0, 1)],  # 위→아래, 오른쪽 열부터 (N 모양)
}


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


def _check_layout(layout: str) -> str:
    if not LAYOUT.match(layout or ""):
        raise FsError("잘못된 레이아웃입니다.")
    return layout


def _sheet(layout: str, page_w: float, page_h: float):
    """종이 크기 · 칸 수 · 칸 순서. 종이 방향은 쪽이 가장 크게 들어가는 쪽으로 고른다.

    세로 쪽(A4 문서): 2쪽 → 가로 종이 왼→오, 4쪽 → 세로 종이 2×2.
    가로 쪽(슬라이드): 2쪽 → 세로 종이 위→아래, 4쪽 → 가로 종이 2×2.
    """
    if layout == "2":
        options = [
            (A4[1], A4[0], 2, 1, [(0, 0), (1, 0)]),
            (A4[0], A4[1], 1, 2, [(0, 0), (0, 1)]),
        ]
    else:
        slots = ORDERS[layout[1:]]
        options = [(A4[0], A4[1], 2, 2, slots), (A4[1], A4[0], 2, 2, slots)]

    def scale(option) -> float:
        sheet_w, sheet_h, cols, rows, _ = option
        cell_w = (sheet_w - 2 * NUP_MARGIN - (cols - 1) * NUP_GAP) / cols
        cell_h = (sheet_h - 2 * NUP_MARGIN - (rows - 1) * NUP_GAP) / rows
        return min(cell_w / page_w, cell_h / page_h)

    return max(options, key=scale)


def _draw_frames(sheet, frames: list[tuple[float, float, float, float]]) -> None:
    """얇은 회색 테두리를 그린 투명한 쪽을 위에 겹친다."""
    from pypdf import PageObject
    from pypdf.generic import ContentStream, FloatObject

    overlay = PageObject.create_blank_page(
        width=float(sheet.mediabox.width), height=float(sheet.mediabox.height)
    )
    stream = ContentStream(None, None)
    stream.operations = [
        ([FloatObject(0.72)] * 3, b"RG"),
        ([FloatObject(0.6)], b"w"),
        *(([FloatObject(v) for v in frame], b"re") for frame in frames),
        ([], b"S"),
    ]
    overlay.replace_contents(stream)
    sheet.merge_page(overlay)


def _dark_sheet(width: float, height: float):
    """검은 배경(뷰어 다크 모드 색)을 칠한 빈 종이. 그 위에 쪽들을 겹친다."""
    from pypdf import PageObject
    from pypdf.generic import ContentStream, FloatObject

    sheet = PageObject.create_blank_page(width=width, height=height)
    red, green, blue = (int(DARK_BG[i : i + 2], 16) / 255 for i in (1, 3, 5))
    stream = ContentStream(None, None)
    stream.operations = [
        ([FloatObject(red), FloatObject(green), FloatObject(blue)], b"rg"),
        (
            [FloatObject(0), FloatObject(0), FloatObject(width), FloatObject(height)],
            b"re",
        ),
        ([], b"f"),
    ]
    sheet.replace_contents(stream)
    return sheet


def _nup(source: Path, target: Path, layout: str, theme: str = "light") -> None:
    """source 의 쪽들을 한 장에 2쪽 또는 4쪽(2×2 · 순서 지정)씩 배치한다. dark 면 종이도 검게."""
    from pypdf import PageObject, PdfReader, PdfWriter, Transformation

    reader = PdfReader(str(source))
    pages = list(reader.pages)
    first = pages[0].mediabox if pages else None
    sheet_w, sheet_h, cols, rows, slots = _sheet(
        layout,
        float(first.width) if first else A4[0],
        float(first.height) if first else A4[1],
    )
    cell_w = (sheet_w - 2 * NUP_MARGIN - (cols - 1) * NUP_GAP) / cols
    cell_h = (sheet_h - 2 * NUP_MARGIN - (rows - 1) * NUP_GAP) / rows
    writer = PdfWriter()
    for start in range(0, len(pages), len(slots)):
        sheet = (
            _dark_sheet(sheet_w, sheet_h)
            if theme == "dark"
            else PageObject.create_blank_page(width=sheet_w, height=sheet_h)
        )
        frames = []
        for page, (col, row) in zip(pages[start : start + len(slots)], slots):
            box = page.mediabox
            width, height = float(box.width), float(box.height)
            scale = min(cell_w / width, cell_h / height)
            # 칸 안 가운데 (PDF 좌표는 아래가 0 → 행 0 이 위)
            x = NUP_MARGIN + col * (cell_w + NUP_GAP) + (cell_w - width * scale) / 2
            y = (
                sheet_h
                - NUP_MARGIN
                - (row + 1) * cell_h
                - row * NUP_GAP
                + (cell_h - height * scale) / 2
            )
            sheet.merge_transformed_page(
                page,
                Transformation()
                .translate(-float(box.left), -float(box.bottom))
                .scale(scale)
                .translate(x, y),
            )
            if (
                width > height
            ):  # 슬라이드는 배경이 흰색이라 경계가 안 보여 얇은 테두리를 두른다
                frames.append((x, y, width * scale, height * scale))
        if frames:
            _draw_frames(sheet, frames)
        writer.add_page(sheet)
    # 합친 쪽 내용은 압축이 풀린 채라 다시 압축하고, 쪽마다 복사된 글꼴 · 그림은 하나로 합친다
    for sheet in writer.pages:
        sheet.compress_content_streams()
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    with tmp.open("wb") as handle:
        writer.write(handle)
    os.replace(tmp, target)


def layout_pdf(token: str, layout: str = "1") -> Path:
    """레이아웃을 적용한 PDF (만든 것은 그 작업 폴더에 남겨 다시 쓴다)."""
    job = _job(token)
    if _check_layout(layout) == "1":
        return job / "out.pdf"
    target = job / f"out-{layout}.pdf"
    if not target.is_file():
        _nup(job / "out.pdf", target, layout, _job_theme(job))
    return target


def _job_theme(job: Path) -> str:
    """PDF 를 만들 때 고른 배경 (모아찍기 종이도 같은 색으로)."""
    try:
        theme = (job / "theme").read_text(encoding="utf-8").strip()
    except OSError:
        return "light"
    return theme if theme in THEMES else "light"


def layout_info(token: str, layout: str) -> dict:
    pdf = layout_pdf(token, layout)
    from pypdf import PdfReader

    return {"pages": len(PdfReader(str(pdf)).pages), "size": pdf.stat().st_size}


def _static(name: str) -> str:
    return (STATIC_DIR / name).as_uri()


THEMES = {"light", "dark"}
DARK_BG = "#0b0f19"  # 뷰어(다크 모드) 배경과 같은 색


def _page_html(content: str, md_path: Path, zoom: float, theme: str = "light") -> str:
    """theme: light(흰 종이) · dark(뷰어 다크 모드처럼 검은 배경 · 밝은 글씨 · 다크 코드 강조)."""
    dark = theme == "dark"
    source = json.dumps(
        {"content": content, "path": str(md_path)}, ensure_ascii=False
    ).replace("</", "<\\/")
    css = [
        "vendor/fonts.css",
        "vendor/fontawesome/css/all.min.css",
        "theme.css",
        "app.css",
        "vendor/katex/katex.min.css",
        "vendor/highlight-github-dark.min.css"
        if dark
        else "vendor/highlight-github-light.scoped.css",
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
<html lang="ko" data-ui-theme-mode="{theme}"><head><meta charset="utf-8"><title>{md_path.stem}</title>
{links}
<style>
  @page {{ size: A4; margin: 14mm 13mm; {f"background: {DARK_BG};" if dark else ""} }}
  html, body {{ background: {DARK_BG if dark else "#fff"} !important; margin: 0; }}
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


def source_kind(file: Path) -> str | None:
    """PDF 를 만드는 길. 문서가 아니면(그림 · 영상 · 압축 · 바이너리) None."""
    ext = file.suffix.lower()
    if ext in MD_EXT:
        return "md"
    if ext == ".pdf":
        return "pdf"
    if ext in HTML_EXT:
        return "html"
    if ext == ".ipynb":
        return "notebook"
    if ext in {".csv", ".tsv"}:
        return "table"
    kind = preview_service.kind(file)
    if kind in {"office", "hwpx"}:
        return kind
    if kind or ext in IMAGE_EXT or ext in MEDIA_EXT:
        return None
    try:
        with file.open("rb") as handle:
            head = handle.read(8192)
    except OSError:
        return None
    return None if b"\0" in head else "text"


def _source(path: str) -> tuple[Path, str]:
    file = resolve(path)
    if not file.is_file():
        raise FsError("파일이 아닙니다.")
    kind = source_kind(file)
    if not kind:
        raise FsError("PDF 로 만들 수 있는 문서가 아니에요.")
    limit = MAX_SOURCE_BYTES if kind in {"pdf", "office", "hwpx"} else MAX_MD_BYTES
    if file.stat().st_size > limit:
        raise FsError(f"파일이 너무 커요 (최대 {limit // (1024 * 1024)}MB).")
    return file, kind


def _fence(text: str, lang: str = "") -> str:
    """내용 안의 ``` 보다 긴 울타리로 감싼 코드 블록."""
    longest = max((len(m) for m in re.findall(r"`{3,}", text)), default=2)
    fence = "`" * (longest + 1)
    return f"{fence}{lang}\n{text.rstrip(chr(10))}\n{fence}"


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _notebook_md(raw: str) -> str:
    """Jupyter 노트북 → 마크다운 (마크다운 셀 · 코드 셀 · 출력 텍스트 · 그림)."""
    try:
        nb = json.loads(raw)
    except ValueError as error:
        raise FsError("노트북(ipynb)을 읽지 못했어요.") from error

    def join(value) -> str:
        return "".join(value) if isinstance(value, list) else (value or "")

    meta = nb.get("metadata") or {}
    lang = (
        (meta.get("kernelspec") or {}).get("language")
        or (meta.get("language_info") or {}).get("name")
        or "python"
    ).lower()
    parts: list[str] = []
    for cell in nb.get("cells") or []:
        source = join(cell.get("source"))
        if cell.get("cell_type") == "markdown":
            parts.append(source)
            continue
        if cell.get("cell_type") != "code":
            parts.append(_fence(source))
            continue
        if source.strip():
            parts.append(_fence(source, lang))
        for output in cell.get("outputs") or []:
            kind = output.get("output_type")
            if kind == "stream":
                parts.append(_fence(_ANSI.sub("", join(output.get("text")))))
            elif kind == "error":
                trace = "\n".join(output.get("traceback") or []) or output.get(
                    "evalue", ""
                )
                parts.append(_fence(_ANSI.sub("", trace)))
            elif kind in {"execute_result", "display_data"}:
                data = output.get("data") or {}
                image = next(
                    (
                        t
                        for t in ("image/png", "image/jpeg", "image/gif")
                        if data.get(t)
                    ),
                    None,
                )
                if image:
                    encoded = re.sub(r"\s", "", join(data[image]))
                    parts.append(f"![](data:{image};base64,{encoded})")
                elif data.get("text/markdown"):
                    parts.append(join(data["text/markdown"]))
                elif data.get("text/plain"):
                    parts.append(_fence(join(data["text/plain"])))
    return "\n\n".join(parts)


def _table_md(raw: str, delimiter: str) -> str:
    """csv · tsv → 마크다운 표 (앞 MAX_TABLE_ROWS 행)."""
    import csv
    import io

    rows = []
    for row in csv.reader(io.StringIO(raw), delimiter=delimiter):
        rows.append(row)
        if len(rows) > MAX_TABLE_ROWS:
            break
    if not rows:
        return ""
    width = max(len(row) for row in rows)

    def cell(value: str) -> str:
        value = value.replace("\\", "\\\\").replace("|", "\\|").replace("\r", "")
        return value.replace("\n", "<br>") or " "

    lines = [
        "| " + " | ".join(cell(v) for v in row + [""] * (width - len(row))) + " |"
        for row in rows[:MAX_TABLE_ROWS]
    ]
    lines.insert(1, "|" + " --- |" * width)
    note = (
        f"\n\n*앞 {MAX_TABLE_ROWS}행만 넣었어요.*" if len(rows) > MAX_TABLE_ROWS else ""
    )
    return "\n".join(lines) + note


def _markdown(file: Path, kind: str) -> str:
    raw = file.read_text(encoding="utf-8", errors="replace")
    if kind == "md":
        return raw
    if kind == "notebook":
        return _notebook_md(raw)
    if kind == "table":
        return _table_md(raw, "\t" if file.suffix.lower() == ".tsv" else ",")
    ext = file.suffix.lower()
    return _fence(raw, FENCE_LANG.get(ext, ext.lstrip(".")))


def _hwpx_html(file: Path) -> str:
    """미리보기와 같은 hwpx HTML 을 종이에 인쇄할 수 있게 (구역 사이는 쪽 넘김)."""
    body = preview_service.hwpx_html(str(file))["html"]
    links = "\n".join(
        f'<link rel="stylesheet" href="{_static(c)}">'
        for c in ("vendor/fonts.css", "theme.css", "app.css")
    )
    return f"""<!doctype html>
<html lang="ko" data-ui-theme-mode="light"><head><meta charset="utf-8"><title>{html.escape(file.stem)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; style-src 'unsafe-inline' file:; font-src file: data:">
{links}
<style>
  @page {{ size: A4; margin: 12mm 0; }}
  html, body {{ background: #fff !important; margin: 0; }}
  body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  .hwp-doc {{ display: block; padding: 0; zoom: var(--fit, 1); }}
  .hwp-page {{ box-shadow: none !important; border-radius: 0; margin: 0 auto; padding-top: 0 !important; padding-bottom: 0 !important; }}
  .hwp-page + .hwp-page {{ break-before: page; }}
  .hwp-doc img, .hwp-doc tr {{ break-inside: avoid; }}
</style>
</head><body><div class="hwp-doc" style="--fit: {_hwp_fit(body)}">{body}</div></body></html>"""


def _hwp_fit(body: str) -> float:
    # 종이 폭(A4 210mm ≈ 794px)에 가장 넓은 구역이 들어가도록 줄인다
    widths = [
        float(w) for w in re.findall(r'class="hwp-page" style="width:([\d.]+)px', body)
    ]
    return round(min(1.0, 794 / max(widths, default=794)), 3)


def _new_job() -> tuple[str, Path]:
    _prune()
    token = secrets.token_hex(12)
    job = _root() / token
    job.mkdir(mode=0o700)
    return token, job


def _count_pages(pdf: Path) -> int:
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(pdf))
        if reader.is_encrypted and not reader.decrypt(""):
            raise FsError("암호가 걸린 PDF 라 다시 배치할 수 없어요.")
        return len(reader.pages)
    except FsError:
        raise
    except Exception as error:  # 깨진 PDF
        raise FsError("PDF 를 읽지 못했어요.") from error


def _result(token: str, out: Path, file: Path, kind: str, zoom: float | None) -> dict:
    return {
        "token": token,
        "pages": _count_pages(out),
        "size": out.stat().st_size,
        "zoom": zoom,
        "zoomable": zoom is not None,
        "kind": kind,
        "source_pdf": kind == "pdf",
        "name": f"{file.stem}.pdf",
    }


def _chrome_print(job: Path, url: str, file_access: bool) -> Path:
    chrome = chrome_path()
    if not chrome:
        raise MdPdfError("서버에 Chrome/Chromium 이 없어 PDF 를 만들 수 없어요.")
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
        *(["--allow-file-access-from-files"] if file_access else []),
        "--host-resolver-rules=MAP * ~NOTFOUND",  # 외부 네트워크 차단 (웹 그림 · 추적 요청 없음)
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=15000",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
        url,
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
    return out


def needs_office(path: str) -> bool:
    """LibreOffice 변환(비동기 · 캐시)을 먼저 거쳐야 하는 문서인지."""
    return _source(path)[1] == "office"


def render(
    path: str, zoom: float, converted: Path | None = None, theme: str = "light"
) -> dict:
    """미리보기용 PDF 를 만든다. 오피스 문서는 converted 에 LibreOffice 변환 결과를 넘긴다.
    theme(검은 배경)은 배율처럼 글 파일(md · 코드 · 노트북 · 표)에만 적용된다."""
    file, kind = _source(path)
    if kind in {"pdf", "office"}:
        source = file if kind == "pdf" else converted
        if source is None:
            raise FsError("문서를 변환하지 못했어요.")
        token, job = _new_job()
        out = job / "out.pdf"
        shutil.copyfile(source, out)
        try:
            return _result(token, out, file, kind, None)
        except FsError:
            shutil.rmtree(job, ignore_errors=True)
            raise
    if kind == "html":
        token, job = _new_job()
        return _result(
            token, _chrome_print(job, file.as_uri(), False), file, kind, None
        )
    if kind == "hwpx":
        page = _hwpx_html(file)
        token, job = _new_job()
        (job / "page.html").write_text(page, encoding="utf-8")
        return _result(
            token,
            _chrome_print(job, (job / "page.html").as_uri(), False),
            file,
            kind,
            None,
        )
    zoom = round(min(ZOOM_RANGE[1], max(ZOOM_RANGE[0], float(zoom))), 2)
    content = _markdown(file, kind)
    token, job = _new_job()
    theme = theme if theme in THEMES else "light"
    (job / "theme").write_text(theme, encoding="utf-8")
    (job / "page.html").write_text(
        _page_html(content, file, zoom, theme), encoding="utf-8"
    )
    return _result(
        token, _chrome_print(job, (job / "page.html").as_uri(), True), file, kind, zoom
    )


def page_png(token: str, number: int, width: int, layout: str = "1") -> Path:
    job = _job(token)
    pdf = layout_pdf(token, layout)
    width = max(200, min(2000, int(width)))
    target = job / f"p{layout}-{number}-{width}.png"
    if not target.is_file():
        prefix = job / f"p{layout}-{number}-{width}"
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
                str(pdf),
                str(prefix),
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if not target.is_file():
            raise FsError("페이지를 그리지 못했어요.")
    return target


def pdf_file(token: str, layout: str = "1") -> Path:
    return layout_pdf(token, layout)


def target_name(stem: str, source_pdf: bool, layout: str) -> str:
    """저장 · 다운로드 이름. 원본이 PDF 면 모아찍기 표시를 붙인다 (원본을 덮어쓰지 않게)."""
    if not source_pdf:
        return f"{stem}.pdf"
    return f"{stem}-{layout[0]}up.pdf"


def save_next_to(token: str, src_path: str, overwrite: bool, layout: str = "1") -> str:
    """원본 옆에 같은 이름의 .pdf 로 저장 (원본이 PDF 면 이름-2up.pdf 처럼). 이미 있으면 overwrite 일 때만 덮어쓴다."""
    _check_layout(layout)
    original = resolve(src_path)
    source_pdf = original.suffix.lower() == ".pdf"
    if source_pdf and layout == "1":
        raise FsError("원본 PDF 와 같아요. 한 장에 2쪽 이상을 고르면 따로 저장해요.")
    source = pdf_file(token, layout)
    target = original.with_name(target_name(original.stem, source_pdf, layout))
    resolve(str(target), must_exist=False)  # 허용 범위 확인
    if target.exists() and not overwrite:
        raise FileExistsError(str(target))
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    shutil.copyfile(source, tmp)
    os.replace(tmp, target)
    return str(target)
