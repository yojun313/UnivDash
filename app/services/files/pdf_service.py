"""Renders PDFs to page images (PNG) on the server (poppler: pdfinfo · pdftoppm).

The browser receives only page pictures, not the PDF itself, so it looks the same even where there is no
PDF plug-in (iPhone home-screen app etc.). Rendered pages are cached in ~/.univdash/cache/pdf keyed by
(path · modification time · size · page · width).
"""

import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from app.i18n import _
from app.services.files import preview_service
from app.services.files.fs_service import FsError, resolve

MAX_PAGES = 2000
WIDTHS = (
    400,
    600,
    800,
    1000,
    1200,
    1400,
    1600,
    2000,
    2400,
    3200,
)  # requested widths snap to these steps to raise the cache hit rate
RENDER_TIMEOUT = 30
CACHE_LIMIT = 300 * 1024 * 1024
_render_slots = asyncio.Semaphore(2)  # limit on pages rendered at the same time
_text_slots = asyncio.Semaphore(2)


async def search(path: str, query: str, case_sensitive: bool = False) -> dict:
    """Search original PDF/converted Office text and return normalized word boxes."""
    if not shutil.which("pdftotext"):
        raise FsError(_("문서 검색에는 poppler-utils(pdftotext)가 필요합니다."))
    file = await _pdf(path)
    target = cache_dir() / _key(file) / "text.json"
    async with _text_slots:
        try:
            pages = json.loads(await asyncio.to_thread(target.read_text))
        except (OSError, ValueError):
            raw = await _run(
                "pdftotext",
                "-f",
                "1",
                "-l",
                str(MAX_PAGES),
                "-bbox",
                "-enc",
                "UTF-8",
                str(file),
                "-",
            )

            def extract():
                try:
                    root = ET.fromstring(raw)
                except ET.ParseError as error:
                    raise FsError(_("문서의 검색 정보를 읽지 못했습니다.")) from error
                result = []
                for page in root.iter():
                    if page.tag.rsplit("}", 1)[-1] != "page":
                        continue
                    width, height = (
                        float(page.attrib["width"]),
                        float(page.attrib["height"]),
                    )
                    words = []
                    for word in page.iter():
                        if word.tag.rsplit("}", 1)[-1] != "word":
                            continue
                        x, y = float(word.attrib["xMin"]), float(word.attrib["yMin"])
                        words.append(
                            [
                                "".join(word.itertext()),
                                x / width,
                                y / height,
                                (float(word.attrib["xMax"]) - x) / width,
                                (float(word.attrib["yMax"]) - y) / height,
                            ]
                        )
                    result.append(words)
                return result

            pages = await asyncio.to_thread(extract)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temp = target.with_suffix(f".{os.getpid()}.{time.monotonic_ns()}.tmp")
            try:
                await asyncio.to_thread(
                    temp.write_text, json.dumps(pages, ensure_ascii=False)
                )
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)

    def find():
        pattern = re.compile(re.escape(query), 0 if case_sensitive else re.IGNORECASE)
        matches = []
        total = 0
        for number, words in enumerate(pages, 1):
            starts = []
            parts = []
            offset = 0
            for word in words:
                starts.append(offset)
                parts.append(word[0])
                offset += len(word[0]) + 1
            for hit in pattern.finditer(" ".join(parts)):
                total += 1
                if len(matches) >= 1000:
                    continue
                rects = [
                    word[1:]
                    for word, start in zip(words, starts)
                    if start < hit.end() and start + len(word[0]) > hit.start()
                ]
                matches.append({"page": number, "rects": rects})
        return {
            "matches": matches,
            "total": total,
            "truncated": total > len(matches),
            "has_text": any(pages),
            "version": _key(file),
        }

    return await asyncio.to_thread(find)


def available() -> bool:
    return bool(shutil.which("pdftoppm") and shutil.which("pdfinfo"))


def cache_dir() -> Path:
    return Path.home() / ".univdash" / "cache" / "pdf"


async def _pdf(path: str) -> Path:
    """PDFs are used as they are; office documents (docx · xlsx · pptx · hwp …) use the PDF converted by LibreOffice."""
    if not available():
        raise FsError(_("서버에 poppler-utils(pdftoppm)가 없어 PDF 를 볼 수 없습니다."))
    file = resolve(path)
    if file.is_file() and file.suffix.lower() == ".pdf":
        return file
    if file.is_file() and preview_service.kind(file) == "office":
        return await preview_service.office_pdf(path)
    raise FsError(_("PDF 로 볼 수 있는 파일이 아닙니다."))


def _key(file: Path) -> str:
    st = file.stat()
    return hashlib.sha256(
        f"{file}\0{st.st_mtime_ns}\0{st.st_size}".encode()
    ).hexdigest()[:32]


async def _run(*args: str) -> bytes:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), RENDER_TIMEOUT)
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise FsError(_("PDF 처리 시간이 너무 깁니다.")) from error
    if process.returncode != 0:
        message = err.decode(errors="replace").strip().splitlines()
        raise FsError(
            _("PDF 를 읽지 못했습니다. ({detail})", detail=message[-1][:120])
            if message
            else _("PDF 를 읽지 못했습니다.")
        )
    return out


async def info(path: str) -> dict:
    """Page count and per-page sizes (pt). Lets the viewer reserve space up front so scrolling does not jump."""
    file = await _pdf(path)
    head = (await _run("pdfinfo", str(file))).decode(errors="replace")
    match = re.search(r"^Pages:\s+(\d+)", head, re.MULTILINE)
    pages = min(int(match.group(1)) if match else 0, MAX_PAGES)
    if pages <= 0:
        raise FsError(_("페이지가 없는 PDF 입니다."))
    sizes = []
    if pages > 1:
        detail = (await _run("pdfinfo", "-f", "1", "-l", str(pages), str(file))).decode(
            errors="replace"
        )
        sizes = [
            (float(w), float(h))
            for w, h in re.findall(
                r"^Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)", detail, re.MULTILINE
            )
        ]
    if not sizes:
        match = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+)", head, re.MULTILINE)
        sizes = (
            [(float(match.group(1)), float(match.group(2)))]
            if match
            else [(612.0, 792.0)]
        )
    rotated = re.search(r"^Page rot:\s+(90|270)", head, re.MULTILINE)
    if rotated:
        sizes = [(h, w) for w, h in sizes]
    return {
        "pages": pages,
        "sizes": [[round(w, 1), round(h, 1)] for w, h in sizes[:pages]],
        "version": _key(file),
        "size": file.stat().st_size,
        "mtime": int(file.stat().st_mtime),
    }


def _prune() -> None:
    root = cache_dir()
    try:
        files = sorted(
            (
                p
                for p in root.rglob("*")
                if p.is_file() and (p.suffix == ".png" or p.name == "text.json")
            ),
            key=lambda p: p.stat().st_atime,
        )
        total = sum(p.stat().st_size for p in files)
        for file in files:
            if total <= CACHE_LIMIT:
                break
            total -= file.stat().st_size
            file.unlink(missing_ok=True)
    except OSError:
        pass


async def page(path: str, number: int, width: int) -> Path:
    file = await _pdf(path)
    width = next((w for w in WIDTHS if w >= width), WIDTHS[-1])
    if number < 1 or number > MAX_PAGES:
        raise FsError(_("잘못된 페이지입니다."))
    target = cache_dir() / _key(file) / f"{number}-{width}.png"
    if target.exists():
        os.utime(target)
        return target
    async with _render_slots:
        if target.exists():
            return target
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        png = await _run(
            "pdftoppm",
            "-png",
            "-f",
            str(number),
            "-l",
            str(number),
            "-singlefile",
            "-scale-to-x",
            str(width),
            "-scale-to-y",
            "-1",
            "-aa",
            "yes",
            "-aaVector",
            "yes",
            "-hide-annotations",
            str(file),
        )
        if not png:
            raise FsError(_("페이지를 그리지 못했습니다."))
        temp = target.with_suffix(f".{os.getpid()}.{time.monotonic_ns()}.tmp")
        temp.write_bytes(png)
        os.replace(temp, target)
    await asyncio.to_thread(_prune)
    return target
