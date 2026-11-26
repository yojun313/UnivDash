"""Document → PDF: exactly as it looks in the file viewer (the same rendering function · the same CSS, run in headless Chrome).

How the PDF is made for each file type (source_kind):
- md: step 1) below as is. Notebooks (ipynb) · tables (csv · tsv) · other text files (txt · code · tex …)
  are converted to markdown (code blocks · tables) and drawn the same way → zoom works too.
- html: the file itself is printed with Chrome. hwpx: the same HTML as the preview is printed.
- office (pptx · docx · xlsx · hwp …): the same LibreOffice-converted PDF as the preview. pdf: the original as is.
  (these, and html · hwpx, have no zoom, only N-up)

1) Reads the md file and builds a single HTML page in a temporary folder. That HTML loads common.js · marked ·
   DOMPurify · KaTeX · highlight.js · explorer.js and app.css from app/static unchanged and draws with the same
   renderMarkdownHtml() as the viewer (light theme).
2) Makes an A4 PDF with Chrome --print-to-pdf. Zoom is applied to the whole document with CSS zoom.
3) N-up (2 · 4 pages per sheet) scales and places that PDF's pages as vectors (pypdf). Chrome is not run again.
4) The preview is one PNG per page via pdftoppm. Save writes <same name>.pdf next to the md; download sends it as is.

Security: external network access is blocked (--host-resolver-rules). Dashboard secrets are removed from Chrome's environment.
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

from app.i18n import _
from app.paths import data_dir
from app.services.agents import tool_install
from app.services.files import preview_service
from app.services.files.fs_service import IMAGE_EXT, MEDIA_EXT, FsError, resolve

STATIC_DIR = Path(__file__).resolve().parents[2] / "static"
MAX_MD_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 200 * 1024 * 1024  # pdf · office originals
MAX_TABLE_ROWS = 5000
MD_EXT = {".md", ".markdown", ".mdx"}
HTML_EXT = {".html", ".htm", ".xhtml"}
# Code block language names (highlight.js) — when missing, the extension is passed as is, and unknown
# languages come out without highlighting
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
# N-up: "1" · "2" (left→right on landscape paper) · "4z" etc. (2×2 on portrait paper, order in ORDERS below)
LAYOUT = re.compile(r"^(1|2|4(z|s|rn|n))$")
A4 = (595.28, 841.89)
NUP_MARGIN = 14.0  # margin at the paper edge (pt)
NUP_GAP = 10.0  # gap between pages (pt)
# Order in which the 2×2 cells (column, row — row 0 is the top) are filled
ORDERS = {
    "z": [(0, 0), (1, 0), (0, 1), (1, 1)],  # Z: left→right, top→bottom
    "s": [(1, 0), (0, 0), (1, 1), (0, 1)],  # reversed Z: right→left, top→bottom
    "n": [
        (0, 0),
        (0, 1),
        (1, 0),
        (1, 1),
    ],  # top→bottom, left column first (the path looks like И)
    "rn": [(1, 0), (1, 1), (0, 0), (0, 1)],  # top→bottom, right column first (N shape)
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
    return tool_install.installed_chrome()


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
        raise FsError(_("잘못된 요청입니다."))
    job = _root() / token
    if not (job / "out.pdf").is_file():
        raise FsError(_("PDF 가 만료되었습니다. 다시 만들어 주십시오."))
    return job


def _check_layout(layout: str) -> str:
    if not LAYOUT.match(layout or ""):
        raise FsError(_("잘못된 레이아웃입니다."))
    return layout


def _sheet(layout: str, page_w: float, page_h: float):
    """Paper size · cell count · cell order. The paper orientation is the one that fits the pages largest.

    Portrait pages (A4 documents): 2 pages → landscape paper left→right, 4 pages → portrait paper 2×2.
    Landscape pages (slides): 2 pages → portrait paper top→bottom, 4 pages → landscape paper 2×2.
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
        sheet_w, sheet_h, cols, rows, _slots = option
        cell_w = (sheet_w - 2 * NUP_MARGIN - (cols - 1) * NUP_GAP) / cols
        cell_h = (sheet_h - 2 * NUP_MARGIN - (rows - 1) * NUP_GAP) / rows
        return min(cell_w / page_w, cell_h / page_h)

    return max(options, key=scale)


def _draw_frames(sheet, frames: list[tuple[float, float, float, float]]) -> None:
    """Overlays a transparent page with thin grey frames drawn on it."""
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
    """A blank sheet filled with the dark background (the viewer's dark-mode colour). Pages are laid on top of it."""
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
    """Places the pages of source 2 or 4 (2×2 · chosen order) per sheet. With dark, the paper is dark too."""
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
            # Centred in the cell (PDF coordinates start at the bottom → row 0 is the top)
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
            ):  # slides have a white background, so their edge is invisible: draw a thin frame
                frames.append((x, y, width * scale, height * scale))
        if frames:
            _draw_frames(sheet, frames)
        writer.add_page(sheet)
    # Merged page contents are left uncompressed, so compress them again, and merge the fonts · images
    # that were copied for every page into one
    for sheet in writer.pages:
        sheet.compress_content_streams()
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    with tmp.open("wb") as handle:
        writer.write(handle)
    os.replace(tmp, target)


def layout_pdf(token: str, layout: str = "1") -> Path:
    """The PDF with the layout applied (the result stays in the job folder and is reused)."""
    job = _job(token)
    if _check_layout(layout) == "1":
        return job / "out.pdf"
    target = job / f"out-{layout}.pdf"
    if not target.is_file():
        _nup(job / "out.pdf", target, layout, _job_theme(job))
    return target


def _job_theme(job: Path) -> str:
    """The background chosen when the PDF was made (N-up paper uses the same colour)."""
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
DARK_BG = "#0b0f19"  # same colour as the viewer's (dark mode) background


def _page_html(content: str, md_path: Path, zoom: float, theme: str = "light") -> str:
    """theme: light (white paper) · dark (like the viewer's dark mode: dark background · light text · dark code highlighting)."""
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
    # The viewer scripts call t() (translations); without it they stop and the page falls back to plain text
    from app import i18n

    i18n_js = i18n.script(i18n.current()).replace("</", "<\\/")
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
  /* Paper has no horizontal scrolling, so long code · tables wrap / shrink */
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
<script>{i18n_js}</script>
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
    from app.services.agents.pty_service import (
        _env as clean_env,  # environment without the dashboard secrets
    )

    return clean_env()


def source_kind(file: Path) -> str | None:
    """How the PDF is made. None when it is not a document (image · video · archive · binary)."""
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
        raise FsError(_("파일이 아닙니다."))
    kind = source_kind(file)
    if not kind:
        raise FsError(_("PDF 로 만들 수 있는 문서가 아닙니다."))
    limit = MAX_SOURCE_BYTES if kind in {"pdf", "office", "hwpx"} else MAX_MD_BYTES
    if file.stat().st_size > limit:
        raise FsError(
            _("파일이 너무 큽니다 (최대 {limit}).", limit=f"{limit // (1024 * 1024)}MB")
        )
    return file, kind


def _fence(text: str, lang: str = "") -> str:
    """A code block wrapped in a fence longer than any ``` inside the content."""
    longest = max((len(m) for m in re.findall(r"`{3,}", text)), default=2)
    fence = "`" * (longest + 1)
    return f"{fence}{lang}\n{text.rstrip(chr(10))}\n{fence}"


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _notebook_md(raw: str) -> str:
    """Jupyter notebook → markdown (markdown cells · code cells · output text · images)."""
    try:
        nb = json.loads(raw)
    except ValueError as error:
        raise FsError(_("노트북(ipynb)을 읽지 못했습니다.")) from error

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
    """csv · tsv → markdown table (first MAX_TABLE_ROWS rows)."""
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
        "\n\n*" + _("앞 {count}행만 넣었습니다.", count=MAX_TABLE_ROWS) + "*"
        if len(rows) > MAX_TABLE_ROWS
        else ""
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
    """The same hwpx HTML as the preview, made printable on paper (page break between sections)."""
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
    # Shrink so the widest section fits the paper width (A4 210mm ≈ 794px)
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
            raise FsError(_("암호가 걸린 PDF 라 다시 배치할 수 없습니다."))
        return len(reader.pages)
    except FsError:
        raise
    except Exception as error:  # broken PDF
        raise FsError(_("PDF 를 읽지 못했습니다.")) from error


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


def _without_sandbox() -> bool:
    chrome = chrome_path()
    return bool(chrome and tool_install.chrome_needs_no_sandbox(chrome))


_DOCTYPE = re.compile(rb"^\s*(?:\xef\xbb\xbf)?\s*<!doctype[^>]*>", re.IGNORECASE)


def _block_scripts(page: bytes, folder: Path) -> bytes:
    """When printing without a sandbox: puts a CSP at the very front so scripts in the user's file cannot run.

    It comes before any tag, so every script in the file is blocked. Images next to the file are still found through base.
    """
    guard = (
        '<meta http-equiv="Content-Security-Policy" '
        "content=\"script-src 'none'; object-src 'none'; connect-src 'none'\">"
        f'<base href="{html.escape(folder.as_uri())}/">'
    ).encode()
    match = _DOCTYPE.match(page)
    end = match.end() if match else 0
    return page[:end] + guard + page[end:]


def _chrome_print(job: Path, url: str, file_access: bool) -> Path:
    chrome = chrome_path()
    if not chrome:
        raise MdPdfError(tool_install.chrome_missing_message())
    out = job / "out.pdf"
    no_sandbox = tool_install.chrome_needs_no_sandbox(chrome)
    command = [
        chrome,
        *([] if Path(chrome).name == tool_install.CHROME_NAME else ["--headless=new"]),
        *(["--no-sandbox"] if no_sandbox else []),
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        f"--user-data-dir={job / 'profile'}",
        *(["--allow-file-access-from-files"] if file_access else []),
        "--host-resolver-rules=MAP * ~NOTFOUND",  # block the external network (no web images · tracking requests)
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=15000",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
        url,
    ]
    try:
        result = subprocess.run(
            command,
            env=tool_install.chrome_env(chrome, _env()),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=90,
            check=False,
            cwd=str(job),
        )
    except subprocess.TimeoutExpired as error:
        shutil.rmtree(job, ignore_errors=True)
        raise MdPdfError(
            _("PDF 를 만드는 데 너무 오래 걸립니다 (90초 초과).")
        ) from error
    shutil.rmtree(job / "profile", ignore_errors=True)
    if not out.is_file() or out.stat().st_size == 0:
        shutil.rmtree(job, ignore_errors=True)
        tail = (result.stderr or b"").decode(errors="replace").strip().splitlines()[-1:]
        raise MdPdfError(
            _("PDF 를 만들지 못했습니다. ({detail})", detail=tail[0][:200])
            if tail
            else _("PDF 를 만들지 못했습니다.")
        )
    return out


def needs_office(path: str) -> bool:
    """Whether the document must first go through the LibreOffice conversion (async · cached)."""
    return _source(path)[1] == "office"


def render(
    path: str, zoom: float, converted: Path | None = None, theme: str = "light"
) -> dict:
    """Makes the PDF for the preview. For office documents, converted carries the LibreOffice result.
    theme (dark background) applies only to text files (md · code · notebooks · tables), like zoom."""
    file, kind = _source(path)
    if kind in {"pdf", "office"}:
        source = file if kind == "pdf" else converted
        if source is None:
            raise FsError(_("문서를 변환하지 못했습니다."))
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
        if _without_sandbox():
            (job / "page.html").write_bytes(
                _block_scripts(file.read_bytes(), file.parent)
            )
            return _result(
                token,
                _chrome_print(job, (job / "page.html").as_uri(), False),
                file,
                kind,
                None,
            )
        return _result(
            token, _chrome_print(job, file.as_uri(), False), file, kind, None
        )
    if kind == "hwpx":
        page = _hwpx_html(file)
        token, job = _new_job()
        data = page.encode("utf-8")
        (job / "page.html").write_bytes(
            _block_scripts(data, file.parent) if _without_sandbox() else data
        )
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
            raise FsError(_("페이지를 그리지 못했습니다."))
    return target


def pdf_file(token: str, layout: str = "1") -> Path:
    return layout_pdf(token, layout)


def target_name(stem: str, source_pdf: bool, layout: str) -> str:
    """Save · download name. When the original is a PDF, an N-up marker is appended (so the original is not overwritten)."""
    if not source_pdf:
        return f"{stem}.pdf"
    return f"{stem}-{layout[0]}up.pdf"


def save_next_to(token: str, src_path: str, overwrite: bool, layout: str = "1") -> str:
    """Saves as <same name>.pdf next to the original (name-2up.pdf style when the original is a PDF). An existing file is overwritten only with overwrite."""
    _check_layout(layout)
    original = resolve(src_path)
    source_pdf = original.suffix.lower() == ".pdf"
    if source_pdf and layout == "1":
        raise FsError(
            _("원본 PDF 와 같습니다. 한 장에 2쪽 이상을 고르면 따로 저장합니다.")
        )
    source = pdf_file(token, layout)
    target = original.with_name(target_name(original.stem, source_pdf, layout))
    resolve(str(target), must_exist=False)  # check the allowed scope
    if target.exists() and not overwrite:
        raise FileExistsError(str(target))
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    shutil.copyfile(source, tmp)
    os.replace(tmp, target)
    return str(target)
