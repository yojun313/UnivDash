"""브라우저가 그대로 못 여는 파일을 서버에서 미리보기로 바꾼다.

- 오피스 문서 (docx · xlsx · pptx · hwp · odt · rtf …): LibreOffice 로 PDF 변환 → PDF 뷰어(페이지 그림)로 본다
- 한글 hwpx: LibreOffice 가 못 읽어서 직접 해석해 HTML(문단 · 글자 모양 · 표 · 그림)로 그린다
- 압축 파일: 안에 든 파일 목록 (풀지 않음)
- SQLite: 표 목록과 앞쪽 행 (읽기 전용으로 연다)
- HEIC · TIFF 같은 이미지: ffmpeg 로 PNG 변환
- 그 밖의 바이너리: 앞부분 16KB 헥스 덤프
변환 결과는 ~/.univdash/cache/preview 에 (경로 · 수정 시각 · 크기) 기준으로 캐시한다.
"""

import asyncio
import base64
import hashlib
import html
import os
import re
import shutil
import sqlite3
import tarfile
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from app.services.fs_service import FsError, resolve

OFFICE_EXT = {
    ".doc",
    ".docx",
    ".docm",
    ".dot",
    ".dotx",
    ".odt",
    ".ott",
    ".rtf",
    ".wpd",
    ".pages",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".xlsb",
    ".ods",
    ".ots",
    ".numbers",
    ".ppt",
    ".pptx",
    ".pptm",
    ".pps",
    ".ppsx",
    ".odp",
    ".otp",
    ".key",
    ".odg",
    ".vsd",
    ".vsdx",
    ".pub",
    ".hwp",
    ".cwk",
    ".wps",
    ".wk1",
    ".dbf",
}
HWPX_EXT = {".hwpx"}
ARCHIVE_EXT = {
    ".zip",
    ".jar",
    ".war",
    ".whl",
    ".apk",
    ".epub",
    ".tar",
    ".tgz",
    ".gz",
    ".tbz2",
    ".bz2",
    ".txz",
    ".xz",
    ".7z",
    ".rar",
}
SQLITE_EXT = {".db", ".sqlite", ".sqlite3", ".db3"}
CONVERT_IMAGE_EXT = {
    ".heic",
    ".heif",
    ".tif",
    ".tiff",
    ".tga",
    ".dds",
    ".jp2",
    ".exr",
    ".hdr",
    ".pcx",
    ".ppm",
    ".pgm",
    ".pbm",
    ".xbm",
    ".xpm",
}

TIMEOUT = 120
MAX_ZIP_MEMBER = (
    60 * 1024 * 1024
)  # hwpx 안의 XML · 그림 하나의 최대 크기 (압축 폭탄 방지)
MAX_INLINE_IMAGES = 25 * 1024 * 1024
_office_lock = asyncio.Semaphore(
    1
)  # LibreOffice 는 한 번에 하나씩 (같은 프로필을 동시에 쓰면 실패)
_image_lock = asyncio.Semaphore(2)


def kind(path: Path) -> str | None:
    name = path.name.lower()
    ext = path.suffix.lower()
    if ext in HWPX_EXT:
        return "hwpx"
    if ext in OFFICE_EXT and shutil.which("soffice"):
        return "office"
    if ext in SQLITE_EXT:
        return "sqlite"
    if ext in ARCHIVE_EXT or name.endswith((".tar.gz", ".tar.bz2", ".tar.xz")):
        return "archive"
    if ext in CONVERT_IMAGE_EXT and shutil.which("ffmpeg"):
        return "image"
    return None


def cache_dir(sub: str) -> Path:
    path = Path.home() / ".univdash" / "cache" / sub
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _key(file: Path) -> str:
    st = file.stat()
    return hashlib.sha256(
        f"{file}\0{st.st_mtime_ns}\0{st.st_size}".encode()
    ).hexdigest()[:32]


async def _run(args: list[str], cwd: Path | None = None) -> None:
    process = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            "HOME": str(cache_dir("lo-home")),
            "SAL_USE_VCLPLUGIN": "svp",
        },
    )
    try:
        _, err = await asyncio.wait_for(process.communicate(), TIMEOUT)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.wait()
        raise FsError("변환 시간이 너무 깁니다.") from error
    if process.returncode != 0:
        raise FsError(
            f"변환하지 못했습니다. ({err.decode(errors='replace').strip()[-160:]})"
        )


# ── 오피스 문서 → PDF ─────────────────────────────────────────────────────
async def office_pdf(path: str) -> Path:
    file = resolve(path)
    if not file.is_file() or kind(file) != "office":
        raise FsError("변환할 수 있는 문서가 아닙니다.")
    target = cache_dir("docs") / f"{_key(file)}.pdf"
    if target.exists():
        os.utime(target)
        return target
    async with _office_lock:
        if target.exists():
            return target
        work = cache_dir("docs") / f"work-{os.getpid()}-{time.monotonic_ns()}"
        work.mkdir(mode=0o700)
        try:
            # 원본 이름에 특수문자가 있어도 되도록 링크 대신 복사본(input.확장자)으로 변환한다
            source = work / f"input{file.suffix.lower()}"
            shutil.copyfile(file, source)
            profile = cache_dir("lo-profile")
            await _run(
                [
                    "soffice",
                    f"-env:UserInstallation=file://{profile}",
                    "--headless",
                    "--norestore",
                    "--nolockcheck",
                    "--nodefault",
                    "--nologo",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(work),
                    str(source),
                ],
                cwd=work,
            )
            produced = work / "input.pdf"
            if not produced.exists():
                raise FsError(
                    "이 문서를 변환하지 못했습니다 (지원하지 않는 형식일 수 있어요)."
                )
            os.replace(produced, target)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    _prune(cache_dir("docs"), 500 * 1024 * 1024)
    return target


def _prune(root: Path, limit: int) -> None:
    try:
        files = sorted(
            (p for p in root.iterdir() if p.is_file()), key=lambda p: p.stat().st_atime
        )
        total = sum(p.stat().st_size for p in files)
        for file in files:
            if total <= limit:
                break
            total -= file.stat().st_size
            file.unlink(missing_ok=True)
    except OSError:
        pass


# ── 이미지 변환 (HEIC · TIFF …) ───────────────────────────────────────────
async def image_png(path: str) -> Path:
    file = resolve(path)
    if not file.is_file() or kind(file) != "image":
        raise FsError("변환할 수 있는 이미지가 아닙니다.")
    target = cache_dir("images") / f"{_key(file)}.png"
    if target.exists():
        return target
    async with _image_lock:
        temp = target.with_suffix(f".{time.monotonic_ns()}.png")
        await _run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                str(file),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(3000,iw)':-2",
                str(temp),
            ]
        )
        if not temp.exists():
            raise FsError("이미지를 변환하지 못했습니다.")
        os.replace(temp, target)
    _prune(cache_dir("images"), 300 * 1024 * 1024)
    return target


# ── 압축 파일 목록 ─────────────────────────────────────────────────────────
def archive_list(path: str) -> dict:
    file = resolve(path)
    name = file.name.lower()
    entries, truncated, deadline = [], False, time.monotonic() + 5
    try:
        if zipfile.is_zipfile(file):
            with zipfile.ZipFile(file) as archive:
                for info in archive.infolist():
                    if len(entries) >= 3000:
                        truncated = True
                        break
                    entries.append(
                        {
                            "name": info.filename,
                            "size": info.file_size,
                            "packed": info.compress_size,
                            "dir": info.is_dir(),
                            "mtime": int(time.mktime(info.date_time + (0, 0, -1)))
                            if info.date_time[0] > 1980
                            else None,
                        }
                    )
            return {"format": "zip", "entries": entries, "truncated": truncated}
        if tarfile.is_tarfile(file):
            with tarfile.open(file) as archive:
                for info in archive:
                    if len(entries) >= 3000 or time.monotonic() > deadline:
                        truncated = True
                        break
                    entries.append(
                        {
                            "name": info.name + ("/" if info.isdir() else ""),
                            "size": info.size,
                            "dir": info.isdir(),
                            "mtime": int(info.mtime),
                        }
                    )
            return {"format": "tar", "entries": entries, "truncated": truncated}
    except (OSError, zipfile.BadZipFile, tarfile.TarError, EOFError) as error:
        raise FsError(f"압축 파일을 읽지 못했습니다. ({error})") from error
    if name.endswith((".gz", ".bz2", ".xz")):
        return {
            "format": "compressed",
            "entries": [
                {
                    "name": re.sub(r"\.(gz|bz2|xz)$", "", file.name),
                    "size": None,
                    "dir": False,
                }
            ],
            "truncated": False,
        }
    raise FsError(
        "이 압축 형식(7z · rar 등)은 목록을 볼 수 없습니다. 다운로드해서 여세요."
    )


# ── SQLite ────────────────────────────────────────────────────────────────
def sqlite_preview(path: str, limit: int = 100) -> dict:
    file = resolve(path)
    with file.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\x00":
            raise FsError("SQLite 데이터베이스가 아닙니다.")
    uri = f"file:{file.as_posix()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error as error:
        raise FsError(f"열지 못했습니다. ({error})") from error
    try:
        connection.execute("PRAGMA query_only = 1")
        tables = []
        rows = connection.execute(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        for name, kind_ in rows[:40]:
            quoted = '"' + name.replace('"', '""') + '"'
            try:
                cursor = connection.execute(
                    f"SELECT * FROM {quoted} LIMIT {int(limit)}"
                )
                columns = [c[0] for c in cursor.description or []]
                data = [[_cell(v) for v in row] for row in cursor.fetchall()]
                count = (
                    connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
                    if kind_ == "table"
                    else None
                )
            except sqlite3.Error as error:
                columns, data, count = [], [], f"읽기 실패: {error}"
            tables.append(
                {
                    "name": name,
                    "type": kind_,
                    "columns": columns,
                    "rows": data,
                    "count": count,
                }
            )
        return {"tables": tables, "more": len(rows) > 40}
    finally:
        connection.close()


def _cell(value):
    if isinstance(value, bytes):
        return f"<BLOB {len(value)} bytes>"
    if isinstance(value, str) and len(value) > 500:
        return value[:500] + "…"
    return value


# ── 헥스 덤프 ─────────────────────────────────────────────────────────────
def hex_head(path: str, size: int = 16 * 1024) -> dict:
    file = resolve(path)
    with file.open("rb") as handle:
        data = handle.read(size)
    return {
        "data": base64.b64encode(data).decode(),
        "size": file.stat().st_size,
        "shown": len(data),
    }


# ── 한글 hwpx → HTML ──────────────────────────────────────────────────────
NS = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hs": "http://www.hancom.co.kr/hwpml/2011/section",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "opf": "http://www.idpf.org/2007/opf/",
}
HP = "{%s}" % NS["hp"]
HC = "{%s}" % NS["hc"]


def _px(hwpunit) -> float:
    """HWPUNIT(1/7200 인치) → CSS px (1/96 인치)."""
    try:
        return round(int(hwpunit) / 75, 1)
    except (TypeError, ValueError):
        return 0.0


def _border_css(element) -> str | None:
    if element is None or element.get("type", "NONE") == "NONE":
        return None
    try:
        width = max(1, round(float(element.get("width", "0.12").split()[0]) * 3.78))
    except ValueError:
        width = 1
    style = {
        "DASH": "dashed",
        "DOT": "dotted",
        "DOUBLE_SLIM": "double",
        "DOUBLE": "double",
    }.get(element.get("type"), "solid")
    return f"{width}px {style} {element.get('color', '#000')}"


class _Hwpx:
    def __init__(self, archive: zipfile.ZipFile):
        self.zip = archive
        self.chars: dict[str, str] = {}
        self.paras: dict[str, str] = {}
        self.borders: dict[str, str] = {}
        self.fonts: dict[str, str] = {}
        self.bin: dict[str, str] = {}
        self.image_bytes = 0
        self._styles()

    def read(self, name: str) -> bytes:
        info = self.zip.getinfo(name)
        if info.file_size > MAX_ZIP_MEMBER:
            raise FsError("문서 안의 항목이 너무 큽니다.")
        return self.zip.read(info)

    def _styles(self) -> None:
        try:
            head = ET.fromstring(self.read("Contents/header.xml"))
        except (KeyError, ET.ParseError):
            return
        for face in head.iter("{%s}fontface" % NS["hh"]):
            if face.get("lang") == "HANGUL":
                for font in face.iter("{%s}font" % NS["hh"]):
                    self.fonts[font.get("id")] = font.get("face", "")
        for pr in head.iter("{%s}charPr" % NS["hh"]):
            css = []
            try:
                css.append(f"font-size:{int(pr.get('height', '1000')) / 100:.1f}pt")
            except ValueError:
                pass
            if pr.get("textColor") and pr.get("textColor") not in ("#000000", "none"):
                css.append(f"color:{pr.get('textColor')}")
            if pr.get("shadeColor") and pr.get("shadeColor") not in ("none", "#FFFFFF"):
                css.append(f"background:{pr.get('shadeColor')}")
            if pr.find("{%s}bold" % NS["hh"]) is not None:
                css.append("font-weight:700")
            if pr.find("{%s}italic" % NS["hh"]) is not None:
                css.append("font-style:italic")
            under = pr.find("{%s}underline" % NS["hh"])
            strike = pr.find("{%s}strikeout" % NS["hh"])
            deco = []
            if under is not None and under.get("type", "NONE") != "NONE":
                deco.append("underline")
            if strike is not None and strike.get("shape", "NONE") not in ("NONE", ""):
                deco.append("line-through")
            if deco:
                css.append(f"text-decoration:{' '.join(deco)}")
            ref = pr.find("{%s}fontRef" % NS["hh"])
            if ref is not None and self.fonts.get(ref.get("hangul")):
                css.append(
                    f"font-family:'{self.fonts[ref.get('hangul')]}',var(--hwp-font)"
                )
            self.chars[pr.get("id")] = ";".join(css)
        for pr in head.iter("{%s}paraPr" % NS["hh"]):
            css = []
            align = pr.find("{%s}align" % NS["hh"])
            if align is not None:
                css.append(
                    "text-align:"
                    + {
                        "CENTER": "center",
                        "RIGHT": "right",
                        "JUSTIFY": "justify",
                        "DISTRIBUTE": "justify",
                    }.get(align.get("horizontal"), "left")
                )
            margin = pr.find(".//{%s}margin" % NS["hh"])
            if margin is not None:
                for child, prop in (
                    ("left", "margin-left"),
                    ("right", "margin-right"),
                    ("prev", "margin-top"),
                    ("next", "margin-bottom"),
                    ("intent", "text-indent"),
                ):
                    element = margin.find(HC + child)
                    if element is not None and element.get("value") not in (None, "0"):
                        css.append(f"{prop}:{_px(element.get('value')) / 2}px")
            spacing = pr.find(".//{%s}lineSpacing" % NS["hh"])
            if spacing is not None and spacing.get("type") == "PERCENT":
                try:
                    css.append(
                        f"line-height:{max(1.0, int(spacing.get('value', '160')) / 100):.2f}"
                    )
                except ValueError:
                    pass
            self.paras[pr.get("id")] = ";".join(css)
        for fill in head.iter("{%s}borderFill" % NS["hh"]):
            css = []
            for side in ("left", "right", "top", "bottom"):
                value = _border_css(fill.find("{%s}%sBorder" % (NS["hh"], side)))
                css.append(f"border-{side}:{value}" if value else f"border-{side}:0")
            brush = fill.find(".//{%s}winBrush" % NS["hc"])
            if brush is not None and brush.get("faceColor") not in (
                None,
                "none",
                "#FFFFFF",
            ):
                css.append(f"background:{brush.get('faceColor')}")
            self.borders[fill.get("id")] = ";".join(css)
        try:
            manifest = ET.fromstring(self.read("Contents/content.hpf"))
            for item in manifest.iter("{%s}item" % NS["opf"]):
                self.bin[item.get("id")] = item.get("href", "")
        except (KeyError, ET.ParseError):
            pass

    # 문단 · 글자
    def paragraph(self, p) -> str:
        parts = []
        for run in p.findall(HP + "run"):
            style = self.chars.get(run.get("charPrIDRef"), "")
            text = []
            for child in run:
                tag = child.tag
                if tag == HP + "t":
                    text.append(self.text(child))
                elif tag == HP + "tbl":
                    if text:
                        parts.append(f'<span style="{style}">{"".join(text)}</span>')
                        text = []
                    parts.append(self.table(child))
                elif tag in (HP + "pic", HP + "picture"):
                    parts.append(self.picture(child))
                elif tag in (
                    HP + "rect",
                    HP + "container",
                    HP + "ellipse",
                    HP + "polygon",
                ):
                    parts.append(self.shape(child))
                elif tag in (HP + "equation",):
                    script = child.find(HP + "script")
                    if script is not None and script.text:
                        parts.append(
                            f'<code class="hwp-eq">{html.escape(script.text)}</code>'
                        )
            if text:
                parts.append(f'<span style="{style}">{"".join(text)}</span>')
        body = "".join(parts) or "&nbsp;"
        return f'<p class="hwp-p" style="{self.paras.get(p.get("paraPrIDRef"), "")}">{body}</p>'

    def text(self, t) -> str:
        out = [html.escape(t.text or "")]
        for child in t:
            if child.tag == HP + "tab":
                out.append('<span class="hwp-tab"></span>')
            elif child.tag == HP + "lineBreak":
                out.append("<br>")
            elif child.tag in (HP + "nbSpace", HP + "fwSpace"):
                out.append("&nbsp;")
            out.append(html.escape(child.tail or ""))
        return "".join(out)

    def sublist(self, element) -> str:
        sub = element.find(HP + "subList")
        if sub is None:
            sub = element.find(".//" + HP + "subList")
        return (
            "".join(self.paragraph(p) for p in sub.findall(HP + "p"))
            if sub is not None
            else ""
        )

    def table(self, tbl) -> str:
        rows = []
        for tr in tbl.findall(HP + "tr"):
            cells = []
            for tc in tr.findall(HP + "tc"):
                span = tc.find(HP + "cellSpan")
                size = tc.find(HP + "cellSz")
                margin = tc.find(HP + "cellMargin")
                attrs = []
                if span is not None:
                    if span.get("colSpan", "1") != "1":
                        attrs.append(f'colspan="{int(span.get("colSpan"))}"')
                    if span.get("rowSpan", "1") != "1":
                        attrs.append(f'rowspan="{int(span.get("rowSpan"))}"')
                css = [
                    self.borders.get(tc.get("borderFillIDRef"), "border:1px solid #000")
                ]
                if size is not None:
                    css.append(
                        f"width:{_px(size.get('width'))}px;height:{_px(size.get('height'))}px"
                    )
                if margin is not None:
                    css.append(
                        f"padding:{_px(margin.get('top'))}px {_px(margin.get('right'))}px {_px(margin.get('bottom'))}px {_px(margin.get('left'))}px"
                    )
                sub = tc.find(HP + "subList")
                if sub is not None:
                    css.append(
                        "vertical-align:"
                        + {"CENTER": "middle", "BOTTOM": "bottom"}.get(
                            sub.get("vertAlign"), "top"
                        )
                    )
                cells.append(
                    f'<td {" ".join(attrs)} style="{";".join(css)}">{self.sublist(tc)}</td>'
                )
            rows.append(f"<tr>{''.join(cells)}</tr>")
        size = tbl.find(HP + "sz")
        width = f"width:{_px(size.get('width'))}px" if size is not None else ""
        return f'<table class="hwp-table" style="{width}">{"".join(rows)}</table>'

    def picture(self, pic) -> str:
        image = pic.find(".//" + HC + "img")
        if image is None:
            return ""
        href = self.bin.get(image.get("binaryItemIDRef"), "")
        if not href or href not in self.zip.namelist():
            return ""
        info = self.zip.getinfo(href)
        if self.image_bytes + info.file_size > MAX_INLINE_IMAGES:
            return '<span class="hwp-missing">[그림 생략: 문서가 너무 큼]</span>'
        self.image_bytes += info.file_size
        ext = Path(href).suffix.lower().lstrip(".")
        mime = {
            "jpg": "jpeg",
            "jpeg": "jpeg",
            "png": "png",
            "gif": "gif",
            "bmp": "bmp",
            "webp": "webp",
            "svg": "svg+xml",
        }.get(ext)
        if not mime:
            return f'<span class="hwp-missing">[그림: {html.escape(ext)}]</span>'
        size = pic.find(HP + "curSz")
        if size is None or size.get("width") in (None, "0"):
            size = pic.find(HP + "sz")
        width = (
            f'width="{_px(size.get("width"))}"'
            if size is not None and size.get("width") not in (None, "0")
            else ""
        )
        data = base64.b64encode(self.read(href)).decode()
        return f'<img class="hwp-img" {width} src="data:image/{mime};base64,{data}" alt="">'

    def shape(self, shape) -> str:
        draw = shape.find(".//" + HP + "drawText")
        inner = self.sublist(draw if draw is not None else shape)
        pics = "".join(self.picture(p) for p in shape.iter(HP + "pic"))
        return f'<div class="hwp-box">{inner}{pics}</div>' if inner or pics else ""

    def render(self) -> str:
        sections = sorted(
            (
                n
                for n in self.zip.namelist()
                if re.fullmatch(r"Contents/section\d+\.xml", n)
            ),
            key=lambda n: int(re.findall(r"\d+", n)[0]),
        )
        pages = []
        for name in sections:
            root = ET.fromstring(self.read(name))
            page = root.find(".//" + HP + "pagePr")
            width, padding = 794, "72px 76px"
            if page is not None:
                width = _px(page.get("width")) or width
                margin = page.find(HP + "margin")
                if margin is not None:
                    padding = f"{_px(margin.get('top'))}px {_px(margin.get('right'))}px {_px(margin.get('bottom'))}px {_px(margin.get('left'))}px"
            body = "".join(self.paragraph(p) for p in root.findall(HP + "p"))
            pages.append(
                f'<section class="hwp-page" style="width:{width}px;padding:{padding}">{body}</section>'
            )
        return "".join(pages)


def hwpx_html(path: str) -> dict:
    file = resolve(path)
    target = cache_dir("hwpx") / f"{_key(file)}.html"
    if target.exists():
        return {"html": target.read_text(encoding="utf-8")}
    try:
        with zipfile.ZipFile(file) as archive:
            rendered = _Hwpx(archive).render()
    except (zipfile.BadZipFile, KeyError, ET.ParseError, OSError) as error:
        raise FsError(f"hwpx 문서를 읽지 못했습니다. ({error})") from error
    if not rendered.strip():
        raise FsError("문서에 내용이 없습니다.")
    target.write_text(rendered, encoding="utf-8")
    _prune(cache_dir("hwpx"), 200 * 1024 * 1024)
    return {"html": rendered}
