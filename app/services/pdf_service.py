"""PDF 를 서버에서 페이지 이미지(PNG)로 렌더링한다 (poppler: pdfinfo · pdftoppm).

브라우저에는 PDF 원본이 아니라 페이지 그림만 보내므로 PDF 플러그인이 없는 환경(iPhone 홈 화면 앱 등)에서도
똑같이 보인다. 렌더링 결과는 ~/.univdash/cache/pdf 에 (경로 · 수정 시각 · 크기 · 페이지 · 폭) 기준으로 캐시한다.
"""

import asyncio
import hashlib
import os
import re
import shutil
import time
from pathlib import Path

from app.services import preview_service
from app.services.fs_service import FsError, resolve

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
)  # 요청 폭은 이 단계로 맞춰 캐시 적중률을 높인다
RENDER_TIMEOUT = 30
CACHE_LIMIT = 300 * 1024 * 1024
_render_slots = asyncio.Semaphore(2)  # 동시에 렌더링하는 페이지 수 제한


def available() -> bool:
    return bool(shutil.which("pdftoppm") and shutil.which("pdfinfo"))


def cache_dir() -> Path:
    return Path.home() / ".univdash" / "cache" / "pdf"


async def _pdf(path: str) -> Path:
    """PDF 는 그대로, 오피스 문서(docx · xlsx · pptx · hwp …)는 LibreOffice 로 변환한 PDF 를 쓴다."""
    if not available():
        raise FsError("서버에 poppler-utils(pdftoppm)가 없어 PDF 를 볼 수 없습니다.")
    file = resolve(path)
    if file.is_file() and file.suffix.lower() == ".pdf":
        return file
    if file.is_file() and preview_service.kind(file) == "office":
        return await preview_service.office_pdf(path)
    raise FsError("PDF 로 볼 수 있는 파일이 아닙니다.")


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
    except asyncio.TimeoutError as error:
        process.kill()
        await process.wait()
        raise FsError("PDF 처리 시간이 너무 깁니다.") from error
    if process.returncode != 0:
        message = err.decode(errors="replace").strip().splitlines()
        raise FsError(
            "PDF 를 읽지 못했습니다." + (f" ({message[-1][:120]})" if message else "")
        )
    return out


async def info(path: str) -> dict:
    """페이지 수와 페이지별 크기(pt). 뷰어가 미리 자리를 잡아 스크롤이 튀지 않게 한다."""
    file = await _pdf(path)
    head = (await _run("pdfinfo", str(file))).decode(errors="replace")
    match = re.search(r"^Pages:\s+(\d+)", head, re.M)
    pages = min(int(match.group(1)) if match else 0, MAX_PAGES)
    if pages <= 0:
        raise FsError("페이지가 없는 PDF 입니다.")
    sizes = []
    if pages > 1:
        detail = (await _run("pdfinfo", "-f", "1", "-l", str(pages), str(file))).decode(
            errors="replace"
        )
        sizes = [
            (float(w), float(h))
            for w, h in re.findall(
                r"^Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)", detail, re.M
            )
        ]
    if not sizes:
        match = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+)", head, re.M)
        sizes = (
            [(float(match.group(1)), float(match.group(2)))]
            if match
            else [(612.0, 792.0)]
        )
    rotated = re.search(r"^Page rot:\s+(90|270)", head, re.M)
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
            (p for p in root.rglob("*.png")), key=lambda p: p.stat().st_atime
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
        raise FsError("잘못된 페이지입니다.")
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
            raise FsError("페이지를 그리지 못했습니다.")
        temp = target.with_suffix(f".{os.getpid()}.{time.monotonic_ns()}.tmp")
        temp.write_bytes(png)
        os.replace(temp, target)
    await asyncio.to_thread(_prune)
    return target
