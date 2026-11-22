"""Explorer (browse · manage the server's folders · files, like the VS Code explorer)."""

import asyncio
import contextvars
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect

from app.i18n import _
from app.routes.core.pages import render_page
from app.services.core.auth_service import AuthService
from app.services.files import fs_service, pdf_service, preview_service, upload_service
from app.services.files.explorer_prefs import ExplorerPrefs, ExplorerPrefsStore
from app.services.files.fs_service import FsError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


def _fail(error: Exception):
    if isinstance(error, FsError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, PermissionError):
        raise HTTPException(status_code=403, detail=_("권한이 없습니다.")) from error
    if isinstance(error, FileNotFoundError):
        raise HTTPException(
            status_code=404, detail=_("파일이나 폴더가 없습니다.")
        ) from error
    logger.warning("File operation failed: %s", error)
    raise HTTPException(
        status_code=500, detail=_("파일 작업에 실패했습니다.")
    ) from error


@router.get("/explorer")
async def explorer_page(request: Request):
    return render_page(request, "explorer")


@router.get("/api/fs/prefs", dependencies=api_auth)
async def get_prefs():
    prefs = await asyncio.to_thread(ExplorerPrefsStore.load)
    return {
        "prefs": prefs.model_dump(),
        "roots": [str(p) for p in fs_service.roots()],
        "home": fs_service.home(),
    }


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
    if kind:  # a file the server converts for display: only the kind is reported, the content is not read
        info = fs_service._entry(file) or {}
        info.update(
            {"preview": kind, "binary": True, "mtime_ns": str(file.stat().st_mtime_ns)}
        )
        return info
    return fs_service.read_file(path)


@router.get("/api/fs/read", dependencies=api_auth)
async def read_file(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(_read, path)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/version", dependencies=api_auth)
async def file_version(path: str = Query(..., max_length=4096)):
    try:
        return await asyncio.to_thread(fs_service.file_version, path)
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
    return FileResponse(
        image,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/api/fs/raw", dependencies=api_auth)
async def raw_file(path: str = Query(..., max_length=4096), download: bool = False):
    """Image preview · download. A sandbox CSP and nosniff are added so it is never interpreted as a page."""
    try:
        file = await asyncio.to_thread(fs_service.resolve, path)
        if not file.is_file():
            raise FsError(_("파일이 아닙니다."))
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
async def pdf_page(
    path: str = Query(..., max_length=4096),
    page: int = Query(1, ge=1, le=pdf_service.MAX_PAGES),
    w: int = Query(1000, ge=100, le=4000),
):
    """Draws one PDF page as a PNG on the server and sends it. The URL carries a version (v), so long caching is fine."""
    try:
        image = await pdf_service.page(path, page, w)
    except (FsError, OSError) as error:
        _fail(error)
    headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
    }
    return FileResponse(image, media_type="image/png", headers=headers)


@router.get("/api/fs/pdf/search", dependencies=api_auth)
async def pdf_search(
    path: str = Query(..., max_length=4096),
    q: str = Query(..., min_length=1, max_length=500),
    case_sensitive: bool = False,
):
    try:
        return await pdf_service.search(path, q, case_sensitive)
    except (FsError, OSError) as error:
        _fail(error)


# Folder download: a POST starts the zip job → progress is polled (errors come back as JSON) →
# when done, a GET with the returned token lets the browser download it directly.
_zips: dict[str, tuple[Path, str, float]] = {}
ZIP_TTL = 600
_zip_jobs: dict[str, dict] = {}
ZIP_JOBS_MAX = 4  # number of zip jobs running at the same time


def _drop_zip(token: str) -> None:
    item = _zips.pop(token, None)
    if item:
        item[0].unlink(missing_ok=True)


class ZipRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    skip_ignored: bool = False


def _run_zip_job(job: dict, path: str, skip_ignored: bool) -> None:
    def progress(state: dict) -> bool:
        job.update(state)
        # Stop when the screen has not asked for progress for over 30 seconds (the window was closed)
        return job["cancel"] or time.monotonic() - job["seen"] > 30

    try:
        archive, name = fs_service.zip_folder(path, skip_ignored, progress)
    except (FsError, OSError) as error:
        job.update(state="error", error=str(error) or _("압축하지 못했습니다."))
        return
    except Exception:  # so the worker thread never dies silently
        logger.exception("Folder zip failed · %s", path)
        job.update(state="error", error=_("압축하지 못했습니다."))
        return
    token = secrets.token_urlsafe(24)
    _zips[token] = (archive, name, time.monotonic())
    size = archive.stat().st_size
    logger.info("Folder download ready · %s · %d bytes", path, size)
    job.update(state="done", token=token, name=name, size=size)


@router.post("/api/fs/zip", dependencies=api_auth)
async def make_zip(body: ZipRequest):
    now = time.monotonic()
    for token in [t for t, item in _zips.items() if now - item[2] > ZIP_TTL]:
        _drop_zip(token)
    for job_id in [
        j
        for j, job in _zip_jobs.items()
        if job["state"] != "running" and now - job["seen"] > ZIP_TTL
    ]:
        _zip_jobs.pop(job_id, None)
    try:
        fs_service.resolve(body.path)  # path problems are reported right away
    except (FsError, OSError) as error:
        _fail(error)
    if sum(job["state"] == "running" for job in _zip_jobs.values()) >= ZIP_JOBS_MAX:
        raise HTTPException(
            status_code=429,
            detail=_("압축 중인 작업이 많습니다. 잠시 뒤 다시 시도하십시오."),
        )
    job_id = secrets.token_urlsafe(18)
    job = {
        "state": "running",
        "stage": "scan",
        "files": 0,
        "cancel": False,
        "seen": now,
    }
    _zip_jobs[job_id] = job
    # Run in a copy of the request context so error messages use this request's language
    threading.Thread(
        target=contextvars.copy_context().run,
        args=(_run_zip_job, job, body.path, body.skip_ignored),
        daemon=True,
        name="zip-folder",
    ).start()
    return {"job": job_id}


_ZIP_JOB_FIELDS = (
    "state",
    "stage",
    "files",
    "files_total",
    "done_bytes",
    "total_bytes",
    "token",
    "name",
    "size",
    "error",
)


@router.get("/api/fs/zip/job/{job_id}", dependencies=api_auth)
async def zip_job(job_id: str):
    job = _zip_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=_("압축 작업을 찾을 수 없습니다."))
    job["seen"] = time.monotonic()
    result = {key: job[key] for key in _ZIP_JOB_FIELDS if key in job}
    if job["state"] != "running":
        _zip_jobs.pop(job_id, None)  # the result is reported only once
    return result


@router.delete("/api/fs/zip/job/{job_id}", dependencies=api_auth)
async def cancel_zip_job(job_id: str):
    job = _zip_jobs.get(job_id)
    if job is not None:
        job["cancel"] = True
    return {"ok": True}


@router.get("/api/fs/zip/{token}", dependencies=api_auth)
async def get_zip(token: str):
    item = _zips.pop(token, None)
    if not item or not item[0].exists():
        raise HTTPException(
            status_code=404,
            detail=_("다운로드가 만료되었습니다. 다시 시도하십시오."),
        )
    archive, name, _made = item
    return FileResponse(
        archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
            "X-Content-Type-Options": "nosniff",
        },
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
async def search(
    root: str = Query(..., max_length=4096),
    q: str = Query(..., max_length=200),
    hidden: bool = False,
    env: bool = False,
):
    try:
        return await asyncio.to_thread(fs_service.search, root, q, hidden, env)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/search-dirs", dependencies=api_auth)
async def search_dirs(
    root: str = Query(..., max_length=4096),
    q: str = Query(..., max_length=200),
    hidden: bool = False,
):
    try:
        return await asyncio.to_thread(fs_service.search_dirs, root, q, hidden)
    except (FsError, OSError) as error:
        _fail(error)


class FsWrite(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    content: str = Field(max_length=fs_service.MAX_WRITE)
    mtime_ns: str | None = Field(
        default=None, pattern=r"^\d{1,25}$"
    )  # the value received on open (a string). 409 when it changed in between
    force: bool = False  # overwrite despite a known conflict


@router.put("/api/fs/write", dependencies=api_auth)
async def write_file(body: FsWrite):
    try:
        result = await asyncio.to_thread(
            fs_service.write_file,
            body.path,
            body.content,
            None if body.force or body.mtime_ns is None else int(body.mtime_ns),
        )
    except FileExistsError as error:
        raise HTTPException(
            status_code=409,
            detail=_(
                "다른 곳에서 파일이 바뀌었습니다. 다시 불러오거나 덮어쓰기를 선택하십시오."
            ),
        ) from error
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("File saved · %s · %d bytes", body.path, result.get("size", 0))
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
        result = await asyncio.to_thread(
            fs_service.git_clone,
            body.url,
            body.parent,
            body.name,
            body.branch,
            body.depth,
        )
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("git clone · %s → %s", body.url.split("@")[-1][:200], result["path"])
    return result


class MdPdfRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    zoom: float = Field(default=1.0, ge=0.4, le=2.0)
    theme: str = Field(default="light", pattern=r"^(light|dark)$")


class MdPdfSaveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    overwrite: bool = False
    layout: str = Field(default="1", pattern=r"^(1|2|4(z|s|rn|n))$")


@router.post("/api/fs/md-pdf", dependencies=api_auth)
async def md_pdf(body: MdPdfRequest):
    """Turns a document (md · code · notebook · table · html · hwpx · office · pdf) into a PDF exactly as
    it looks in the viewer (a temporary file for the preview, kept 30 minutes)."""
    from app.services.files import md_pdf_service

    try:
        converted = None
        if await asyncio.to_thread(md_pdf_service.needs_office, body.path):
            converted = await preview_service.office_pdf(body.path)
        return await asyncio.to_thread(
            md_pdf_service.render, body.path, body.zoom, converted, body.theme
        )
    except md_pdf_service.MdPdfError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/md-pdf/{token}/layout", dependencies=api_auth)
async def md_pdf_layout(
    token: str, layout: str = Query("1", pattern=r"^(1|2|4(z|s|rn|n))$")
):
    """Sheet count · size of the result with N-up (2 · 4 pages per sheet) applied."""
    from app.services.files import md_pdf_service

    try:
        return await asyncio.to_thread(md_pdf_service.layout_info, token, layout)
    except (FsError, OSError) as error:
        _fail(error)


@router.get("/api/fs/md-pdf/{token}/page/{number}", dependencies=api_auth)
async def md_pdf_page(
    token: str,
    number: int,
    w: int = Query(900, ge=200, le=2000),
    layout: str = Query("1", pattern=r"^(1|2|4(z|s|rn|n))$"),
):
    from app.services.files import md_pdf_service

    try:
        png = await asyncio.to_thread(md_pdf_service.page_png, token, number, w, layout)
    except (FsError, OSError) as error:
        _fail(error)
    return FileResponse(
        png, media_type="image/png", headers={"Cache-Control": "private, max-age=1800"}
    )


@router.get("/api/fs/md-pdf/{token}/download", dependencies=api_auth)
async def md_pdf_download(
    token: str,
    name: str = Query("document.pdf", max_length=255),
    layout: str = Query("1", pattern=r"^(1|2|4(z|s|rn|n))$"),
):
    from app.services.files import md_pdf_service

    try:
        pdf = await asyncio.to_thread(md_pdf_service.pdf_file, token, layout)
    except (FsError, OSError) as error:
        _fail(error)
    safe = (
        "".join("_" if c in "/\\" or ord(c) < 32 else c for c in name) or "document.pdf"
    )
    if not safe.lower().endswith(".pdf"):
        safe += ".pdf"
    return FileResponse(pdf, media_type="application/pdf", filename=safe)


@router.post("/api/fs/md-pdf/{token}/save", dependencies=api_auth)
async def md_pdf_save(token: str, body: MdPdfSaveRequest):
    """Saves as <same name>.pdf next to the original (409 when it exists → ask whether to overwrite, then overwrite)."""
    from app.services.files import md_pdf_service

    try:
        saved = await asyncio.to_thread(
            md_pdf_service.save_next_to, token, body.path, body.overwrite, body.layout
        )
    except FileExistsError as error:
        raise HTTPException(
            status_code=409, detail=_("같은 이름의 PDF 가 이미 있습니다.")
        ) from error
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("PDF saved · %s", saved)
    return {"path": saved}


class UploadFolderRequest(BaseModel):
    dir: str = Field(min_length=1, max_length=4096)
    rel: str = Field(min_length=1, max_length=4096)
    unique: bool = False


@router.post("/api/fs/upload-folder", dependencies=api_auth)
async def upload_folder(body: UploadFolderRequest):
    """Folder upload: create the top folder ("name (2)" when the name is taken) · create empty subfolders."""
    try:
        path = await asyncio.to_thread(
            fs_service.upload_folder, body.dir, body.rel, body.unique
        )
    except (FsError, OSError) as error:
        _fail(error)
    return {"path": path}


class FsOperation(BaseModel):
    op: str = Field(pattern=r"^(mkdir|touch|rename|delete|copy|move)$")
    path: str = Field(min_length=1, max_length=4096)
    name: str = Field(default="", max_length=255)
    dest: str = Field(default="", max_length=4096)


@router.post("/api/fs/op", dependencies=api_auth)
async def operation(body: FsOperation):
    try:
        if body.op in {"mkdir", "touch"}:
            result = await asyncio.to_thread(
                fs_service.make,
                body.path,
                body.name,
                "dir" if body.op == "mkdir" else "file",
            )
        elif body.op == "rename":
            result = await asyncio.to_thread(fs_service.rename, body.path, body.name)
        elif body.op == "delete":
            result = await asyncio.to_thread(fs_service.delete, body.path)
        else:
            result = await asyncio.to_thread(
                fs_service.transfer, body.path, body.dest, body.op == "move"
            )
    except (FsError, OSError) as error:
        _fail(error)
    logger.info("File operation · %s · %s", body.op, body.path)
    return {"path": result}


@router.post("/api/fs/upload", dependencies=api_auth)
async def upload(request: Request, dir: str = Query(..., max_length=4096)):
    """The whole body is one file (same as attachment upload). The name is in the X-Filename header (URI-encoded)."""
    limit = upload_service.max_bytes()
    try:
        if int(request.headers.get("content-length", "0")) > limit:
            raise HTTPException(
                status_code=413,
                detail=_(
                    "파일이 너무 큽니다 (최대 {limit}).",
                    limit=f"{limit // (1024 * 1024)}MB",
                ),
            )
        target = await asyncio.to_thread(
            fs_service.upload_target,
            dir,
            unquote(request.headers.get("x-filename", "")),
            unquote(request.headers.get("x-relative-dir", ""))[
                :4096
            ],  # folder upload: subfolder path
        )
    except ValueError:
        raise HTTPException(status_code=400, detail=_("잘못된 요청입니다.")) from None
    except (FsError, OSError) as error:
        _fail(error)
    written = 0
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as handle:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(
                        status_code=413, detail=_("파일이 너무 큽니다.")
                    )
                handle.write(chunk)
    except (HTTPException, ClientDisconnect, OSError) as error:
        target.unlink(missing_ok=True)
        if isinstance(error, HTTPException):
            raise
        _fail(
            error
            if isinstance(error, OSError)
            else FsError(_("업로드가 중단되었습니다."))
        )
    logger.info("File uploaded · %s · %d bytes", target, written)
    return {"path": str(target), "size": written}
