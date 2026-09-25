"""Explorer (VS Code 탐색기처럼 서버의 폴더 · 파일 조회 · 관리)."""

import asyncio
import logging
import os
import secrets
import time
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from app.routes.pages import render_page
from app.services import fs_service, pdf_service, preview_service, upload_service
from app.services.auth_service import AuthService
from app.services.explorer_prefs import ExplorerPrefs, ExplorerPrefsStore
from app.services.fs_service import FsError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


def _fail(error: Exception):
    if isinstance(error, FsError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, PermissionError):
        raise HTTPException(status_code=403, detail="권한이 없습니다.") from error
    if isinstance(error, FileNotFoundError):
        raise HTTPException(status_code=404, detail="파일이나 폴더가 없습니다.") from error
    logger.warning("파일 작업 실패: %s", error)
    raise HTTPException(status_code=500, detail="파일 작업에 실패했습니다.") from error


@router.get("/explorer")
async def explorer_page(request: Request):
    return render_page(request, "explorer")


@router.get("/api/fs/prefs", dependencies=api_auth)
async def get_prefs():
    prefs = await asyncio.to_thread(ExplorerPrefsStore.load)
    return {"prefs": prefs.model_dump(), "roots": [str(p) for p in fs_service.roots()], "home": fs_service.home()}


@router.put("/api/fs/prefs", dependencies=api_auth)
async def put_prefs(prefs: ExplorerPrefs):
    saved = await asyncio.to_thread(ExplorerPrefsStore.save, prefs)
    return {"prefs": saved.model_dump()}


@router.get("/api/fs/list", dependencies=api_auth)
async def list_dir(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(fs_service.list_dir, path)
    except (FsError, OSError) as error:
        _fail(error)


def _read(path: str) -> dict:
    file = fs_service.resolve(path)
    kind = preview_service.kind(file) if file.is_file() else None
    if kind:  # 서버에서 변환해서 보여줄 파일: 내용은 읽지 않고 종류만 알려준다
        info = fs_service._entry(file) or {}
        info.update({"preview": kind, "binary": True, "mtime_ns": str(file.stat().st_mtime_ns)})
        return info
    return fs_service.read_file(path)


@router.get("/api/fs/read", dependencies=api_auth)
async def read_file(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(_read, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/preview/hwpx", dependencies=api_auth)
async def preview_hwpx(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(preview_service.hwpx_html, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/preview/archive", dependencies=api_auth)
async def preview_archive(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(preview_service.archive_list, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/preview/sqlite", dependencies=api_auth)
async def preview_sqlite(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(preview_service.sqlite_preview, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/preview/hex", dependencies=api_auth)
async def preview_hex(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(preview_service.hex_head, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/preview/image", dependencies=api_auth)
async def preview_image(path: str = Query(..., max_length=4096)):
    try:
        image = await preview_service.image_png(path)
    except (FsError, OSError) as error:
        _fail(error)
    return FileResponse(image, media_type="image/png", headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


@router.get("/api/fs/raw", dependencies=api_auth)
async def raw_file(path: str = Query(..., max_length=4096), download: bool = False):
    """이미지 미리보기 · 다운로드. 페이지로 해석되지 않도록 sandbox CSP 와 nosniff 를 붙인다."""
    try:
        file = await asyncio.to_thread(fs_service.resolve, path)
        if not file.is_file():
            raise FsError("파일이 아닙니다.")
    except (FsError, OSError) as error:
        _fail(error)
    viewable = file.suffix.lower() in fs_service.IMAGE_EXT | fs_service.MEDIA_EXT
    inline = viewable and not download
    headers = {
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(file.name)}",
    }
    media = None if inline else "application/octet-stream"
    return FileResponse(file, media_type=media, headers=headers)


@router.get("/api/fs/pdf/info", dependencies=api_auth)
async def pdf_info(path: str = Query(..., max_length=4096)):
    try:
        return await pdf_service.info(path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/pdf/page", dependencies=api_auth)
async def pdf_page(path: str = Query(..., max_length=4096), page: int = Query(1, ge=1, le=pdf_service.MAX_PAGES), w: int = Query(1000, ge=100, le=4000)):
    """PDF 한 페이지를 서버에서 PNG 로 그려 보낸다. URL 에 버전(v)이 붙으므로 오래 캐시해도 된다."""
    try:
        image = await pdf_service.page(path, page, w)
    except (FsError, OSError) as error:
        _fail(error)
    headers = {"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"}
    return FileResponse(image, media_type="image/png", headers=headers)


# 폴더 다운로드: POST 로 zip 을 만들고(오류는 JSON 으로) → 받은 토큰으로 GET 해서 브라우저가 바로 내려받는다.
_zips: dict[str, tuple[Path, str, float]] = {}
ZIP_TTL = 600


def _drop_zip(token: str) -> None:
    item = _zips.pop(token, None)
    if item:
        item[0].unlink(missing_ok=True)


class ZipRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    skip_ignored: bool = False


@router.post("/api/fs/zip", dependencies=api_auth)
async def make_zip(body: ZipRequest):
    now = time.monotonic()
    for token in [t for t, (_, _, made) in _zips.items() if now - made > ZIP_TTL]:
        _drop_zip(token)
    try:
        archive, name = await asyncio.to_thread(fs_service.zip_folder, body.path, body.skip_ignored)
    except (FsError, OSError) as error:
        _fail(error)
    token = secrets.token_urlsafe(24)
    _zips[token] = (archive, name, now)
    logger.info("폴더 다운로드 준비 · %s · %d bytes", body.path, archive.stat().st_size)
    return {"token": token, "name": name, "size": archive.stat().st_size}


@router.get("/api/fs/zip/{token}", dependencies=api_auth)
async def get_zip(token: str):
    item = _zips.pop(token, None)
    if not item or not item[0].exists():
        raise HTTPException(status_code=404, detail="다운로드가 만료되었습니다. 다시 시도하세요.")
    archive, name, _ = item
    return FileResponse(
        archive, media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}", "X-Content-Type-Options": "nosniff"},
        background=BackgroundTask(lambda: archive.unlink(missing_ok=True)),
    )


@router.get("/api/fs/stat", dependencies=api_auth)
async def stat_entry(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(fs_service.properties, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/du", dependencies=api_auth)
async def folder_usage(path: str = Query(..., max_length=4096)):
    try:
        return await fs_service.folder_usage(path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/search", dependencies=api_auth)
async def search(root: str = Query(..., max_length=4096), q: str = Query(..., max_length=200), hidden: bool = False):
    try:
        return await asyncio.to_thread(fs_service.search, root, q, hidden)
    except (FsError, OSError) as error:
        _fail(error)


class FsWrite(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    content: str = Field(max_length=fs_service.MAX_WRITE)
    mtime_ns: str | None = Field(default=None, pattern=r"^\d{1,25}$")   # 열 때 받은 값(문자열). 그 사이 바뀌었으면 409
    force: bool = False               # 충돌을 알고도 덮어쓰기


@router.put("/api/fs/write", dependencies=api_auth)
async def write_file(body: FsWrite):
    try:
        result = await asyncio.to_thread(fs_service.write_file, body.path, body.content, None if body.force or body.mtime_ns is None else int(body.mtime_ns))
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail="다른 곳에서 파일이 바뀌었습니다. 다시 불러오거나 덮어쓰기를 선택하세요.") from error
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("파일 저장 · %s · %d bytes", body.path, result.get("size", 0))
    return result


class CloneRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2000)
    parent: str = Field(min_length=1, max_length=4096)
    name: str = Field(default="", max_length=255)
    branch: str = Field(default="", max_length=200)
    depth: int = Field(default=0, ge=0, le=100000)


@router.post("/api/fs/clone", dependencies=api_auth)
async def git_clone(body: CloneRequest):
    try:
        result = await asyncio.to_thread(fs_service.git_clone, body.url, body.parent, body.name, body.branch, body.depth)
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("git clone · %s → %s", body.url.split("@")[-1][:200], result["path"])
    return result


class FsOperation(BaseModel):
    op: str = Field(pattern=r"^(mkdir|touch|rename|delete|copy|move)$")
    path: str = Field(min_length=1, max_length=4096)
    name: str = Field(default="", max_length=255)
    dest: str = Field(default="", max_length=4096)


@router.post("/api/fs/op", dependencies=api_auth)
async def operation(body: FsOperation):
    try:
        if body.op in {"mkdir", "touch"}:
            result = await asyncio.to_thread(fs_service.make, body.path, body.name, "dir" if body.op == "mkdir" else "file")
        elif body.op == "rename":
            result = await asyncio.to_thread(fs_service.rename, body.path, body.name)
        elif body.op == "delete":
            result = await asyncio.to_thread(fs_service.delete, body.path)
        else:
            result = await asyncio.to_thread(fs_service.transfer, body.path, body.dest, body.op == "move")
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("파일 작업 · %s · %s", body.op, body.path)
    return {"path": result}


@router.post("/api/fs/upload", dependencies=api_auth)
async def upload(request: Request, dir: str = Query(..., max_length=4096)):
    """본문 전체가 파일 하나 (첨부 업로드와 같은 방식). 이름은 X-Filename 헤더(URI 인코딩)."""
    limit = upload_service.max_bytes()
    try:
        if int(request.headers.get("content-length", "0")) > limit:
            raise HTTPException(status_code=413, detail=f"파일이 너무 큽니다 (최대 {limit // (1024 * 1024)}MB).")
        target = await asyncio.to_thread(fs_service.upload_target, dir, unquote(request.headers.get("x-filename", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="잘못된 요청입니다.") from None
    except (FsError, OSError) as error:
        _fail(error)
    written = 0
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as handle:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")
                handle.write(chunk)
    except (HTTPException, ClientDisconnect, OSError) as error:
        target.unlink(missing_ok=True)
        if isinstance(error, HTTPException):
            raise
        _fail(error if isinstance(error, OSError) else FsError("업로드가 중단되었습니다."))
    logger.info("파일 업로드 · %s · %d bytes", target, written)
    return {"path": str(target), "size": written}
