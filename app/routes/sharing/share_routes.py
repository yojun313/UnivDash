"""Share links.

- Management (sign-in required): create · list · revoke. For a folder the progress is polled while it is packed.
- Receiving (no sign-in): GET /s/{token} only shows an info page; the download happens only through that page's
  button (POST). A link-preview bot of a messenger or mail client opening the address neither gets the file nor
  uses up a download.
"""

import asyncio
import contextvars
import logging
import secrets
import threading
import time
from datetime import datetime
from functools import partial
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from app import i18n
from app.i18n import _
from app.routes.core.pages import templates
from app.security import LoginRateLimiter, client_key
from app.services.core import push_service
from app.services.core.auth_service import AuthService
from app.services.files.fs_service import FsError
from app.services.sharing import access_code, share_service

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

# Slows down repeated wrong tokens (a 256-bit token cannot be guessed, but this keeps logs and load down)
_misses = LoginRateLimiter(
    max_attempts=20,
    window_seconds=600,
    lockout_seconds=900,
    global_max_attempts=300,
    global_window_seconds=600,
    global_lockout_seconds=300,
)
STREAM_CHUNK = 256 * 1024
PER_SHARE_STREAMS = 3
TOTAL_STREAMS = 8
_streams: dict[str, int] = {}
_streams_lock = threading.Lock()
_tasks: set[asyncio.Task] = set()

# Referrer-Policy stays at the default (same-origin). With no-referrer the browser sends Origin: null on the form
# POST, which trips the CSRF check. The page has no outside links or resources, so the token cannot leak to other sites.
PUBLIC_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
}


# ── Management ────────────────────────────────────────────────────────────
class ShareRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    minutes: int = Field(
        default=share_service.MINUTES_DEFAULT,
        ge=share_service.MINUTES_MIN,
        le=share_service.MINUTES_MAX,
    )
    max_downloads: int = Field(default=0, ge=0, le=1000)
    skip_ignored: bool = False
    # Require an access code, delivered separately from the link, to download (off by default)
    require_code: bool = False


_jobs: dict[str, dict] = {}
JOBS_MAX = 2


def _bad(error: Exception):
    if isinstance(error, FsError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    raise HTTPException(
        status_code=400, detail=_("공유할 수 없는 파일이나 폴더입니다.")
    ) from error


def _link(token: str, code: str | None, share: dict) -> dict:
    return {"state": "done", "url": f"/s/{token}", "code": code, "share": share}


def _run_job(job: dict, real, body: ShareRequest) -> None:
    def progress(state: dict) -> bool:
        job.update(state)
        return job["cancel"] or time.monotonic() - job["seen"] > 30

    try:
        archive, size = share_service.zip_for_share(real, body.skip_ignored, progress)
        token, code, share = share_service.create(
            real,
            "dir",
            body.minutes,
            body.max_downloads,
            archive,
            size,
            require_code=body.require_code,
        )
    except (FsError, OSError) as error:
        job.update(
            state="error", error=str(error) or _("공유 링크를 만들지 못했습니다.")
        )
        return
    except Exception:
        logger.exception("creating share link failed · %s", real)
        job.update(state="error", error=_("공유 링크를 만들지 못했습니다."))
        return
    job.update(_link(token, code, share))


@router.post("/api/share", dependencies=api_auth)
async def create_share(body: ShareRequest):
    try:
        real, kind = await asyncio.to_thread(share_service.check_target, body.path)
    except (FsError, OSError) as error:
        _bad(error)
    if kind == "file":
        try:
            token, code, share = await asyncio.to_thread(
                partial(
                    share_service.create,
                    real,
                    kind,
                    body.minutes,
                    body.max_downloads,
                    require_code=body.require_code,
                )
            )
        except (FsError, OSError) as error:
            _bad(error)
        return _link(token, code, share)
    now = time.monotonic()
    for job_id in [
        j
        for j, job in _jobs.items()
        if job["state"] != "running" and now - job["seen"] > 600
    ]:
        _jobs.pop(job_id, None)
    if sum(job["state"] == "running" for job in _jobs.values()) >= JOBS_MAX:
        raise HTTPException(
            status_code=429,
            detail=_("묶는 중인 공유가 있습니다. 잠시 뒤 다시 시도하십시오."),
        )
    job_id = secrets.token_urlsafe(18)
    job = {
        "state": "running",
        "stage": "scan",
        "files": 0,
        "cancel": False,
        "seen": now,
    }
    _jobs[job_id] = job
    # Run in a copy of the request context so error messages use the language of this request
    threading.Thread(
        target=contextvars.copy_context().run,
        args=(_run_job, job, real, body),
        daemon=True,
        name="share-zip",
    ).start()
    return {"state": "running", "job": job_id}


_JOB_FIELDS = (
    "state",
    "stage",
    "files",
    "files_total",
    "done_bytes",
    "total_bytes",
    "url",
    "code",
    "share",
    "error",
)


@router.get("/api/share/job/{job_id}", dependencies=api_auth)
async def share_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=_("작업을 찾을 수 없습니다."))
    job["seen"] = time.monotonic()
    result = {key: job[key] for key in _JOB_FIELDS if key in job}
    if job["state"] != "running":
        _jobs.pop(job_id, None)  # the link is handed out only once
    return result


@router.delete("/api/share/job/{job_id}", dependencies=api_auth)
async def cancel_share_job(job_id: str):
    job = _jobs.get(job_id)
    if job is not None:
        job["cancel"] = True
    return {"ok": True}


@router.get("/api/shares", dependencies=api_auth)
async def list_shares():
    return {"shares": await asyncio.to_thread(share_service.active)}


@router.delete("/api/shares/{share_id}", dependencies=api_auth)
async def revoke_share(share_id: str):
    if not await asyncio.to_thread(share_service.revoke, share_id[:64]):
        raise HTTPException(status_code=404, detail=_("이미 없는 링크입니다."))
    return {"ok": True}


# ── Receiving (no sign-in) ────────────────────────────────────────────────
def _size(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{n} B"


def _page(request: Request, status: int, **context) -> HTMLResponse:
    response = templates.TemplateResponse(
        request=request, name="share.html", context=context, status_code=status
    )
    response.headers.update(PUBLIC_HEADERS)
    return response


def _gone(request: Request) -> HTMLResponse:
    return _page(request, 404, missing=True)


def _lookup(request: Request, token: str):
    """(share info, error response) — only one of them is set.

    A correct link opens regardless of the lockout (256 bits cannot be guessed, so the receiver is not blocked
    even when someone triggers the global lockout by hammering wrong links). Only wrong links are counted and slowed.
    """
    share = share_service.find(token)
    if share is not None:
        return share, None
    key = client_key(request)
    wait = _misses.retry_after(key)
    if wait:
        response = _page(request, 429, locked=True)
        response.headers["Retry-After"] = str(wait)
        return None, response
    _misses.record_failure(key)
    logger.warning("unknown or expired share link · client=%s", key)
    return None, _gone(request)


@router.get("/s/{token}")
async def share_page(request: Request, token: str):
    share, error = await asyncio.to_thread(_lookup, request, token)
    if error:
        return error
    if share.get("code_hash"):
        # Before the code is entered not even the file name or size is shown
        return _page(request, 200, need_code=True, action=f"/s/{token}")
    left = (
        share["max_downloads"] - share["downloads"] if share["max_downloads"] else None
    )
    expires = datetime.fromtimestamp(share["expires"])
    return _page(
        request,
        200,
        name=share["name"],
        is_dir=share["kind"] == "dir",
        size=_size(share["size"]),
        expires=expires.strftime(_("%m월 %d일 %H:%M")).lstrip("0"),
        minutes=max(1, int((share["expires"] - time.time() + 59) // 60)),
        left=left,
        action=f"/s/{token}",
    )


CODE_FORM_MAX = 1024


async def _form_code(request: Request) -> str:
    """Access code sent by the form (empty when the body is too large or of another type)."""
    if not (request.headers.get("content-type") or "").startswith(
        "application/x-www-form-urlencoded"
    ):
        return ""
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > CODE_FORM_MAX:
            return ""
    values = parse_qs(body.decode("utf-8", "replace"), max_num_fields=4).get("code")
    return values[0] if values else ""


async def _code_denied(
    request: Request, share: dict, token: str
) -> HTMLResponse | None:
    """None when the access code is correct, otherwise the page that asks for it again."""
    result = await asyncio.to_thread(
        access_code.check, share, await _form_code(request)
    )
    if result:
        return None
    who = client_key(request)
    if result is None:
        wait = access_code.locked(share["id"]) or 60
        logger.warning(
            "share link access code locked · %s · client=%s", share["id"], who
        )
        if access_code.should_notify(share["id"]):
            task = asyncio.create_task(_notify_lock(share))
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
        response = _page(request, 429, code_locked=True, wait=max(1, (wait + 59) // 60))
        response.headers["Retry-After"] = str(wait)
        return response
    logger.warning("share link access code wrong · %s · client=%s", share["id"], who)
    return _page(request, 403, need_code=True, wrong=True, action=f"/s/{token}")


def _take_slot(share_id: str) -> bool:
    with _streams_lock:
        if (
            sum(_streams.values()) >= TOTAL_STREAMS
            or _streams.get(share_id, 0) >= PER_SHARE_STREAMS
        ):
            return False
        _streams[share_id] = _streams.get(share_id, 0) + 1
        return True


def _give_slot(share_id: str) -> None:
    with _streams_lock:
        count = _streams.get(share_id, 0) - 1
        if count > 0:
            _streams[share_id] = count
        else:
            _streams.pop(share_id, None)


@router.post("/s/{token}")
async def share_download(request: Request, token: str):
    share, error = await asyncio.to_thread(_lookup, request, token)
    if error:
        return error
    if share.get("code_hash") and (denied := await _code_denied(request, share, token)):
        return denied
    if not _take_slot(share["id"]):
        response = _page(request, 429, busy=True)
        response.headers["Retry-After"] = "30"
        return response
    try:
        try:
            source, size = await asyncio.to_thread(share_service.open_shared, share)
        except FileNotFoundError:
            return _gone(request)
        claimed = await asyncio.to_thread(share_service.claim, token)
        if claimed is None:  # expired, used up or revoked in the meantime
            source.close()
            return _gone(request)
    except BaseException:
        _give_slot(share["id"])
        raise

    async def body():
        try:
            while chunk := await asyncio.to_thread(source.read, STREAM_CHUNK):
                yield chunk
        finally:
            source.close()
            _give_slot(share["id"])

    who = client_key(request)
    logger.info(
        "downloaded through share link · %s · %s · client=%s · download #%d",
        share["id"],
        share["path"],
        who,
        claimed["downloads"],
    )
    task = asyncio.create_task(_notify(claimed))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    name = share["name"]
    headers = {
        **PUBLIC_HEADERS,
        "Content-Disposition": f"attachment; filename=\"download{'.zip' if share['kind'] == 'dir' else ''}\"; filename*=UTF-8''{quote(name)}",
        "Content-Length": str(size),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
    }
    media = "application/zip" if share["kind"] == "dir" else "application/octet-stream"
    return StreamingResponse(body(), media_type=media, headers=headers)


async def _notify(share: dict) -> None:
    # The notification goes to the owner: use the server language, not the downloader's
    i18n.activate(i18n.default())
    limit = share["max_downloads"]
    body = (
        _(
            "{name} · {count}/{limit}번째",
            name=share["name"],
            count=share["downloads"],
            limit=limit,
        )
        if limit
        else _("{name} · {count}번째", name=share["name"], count=share["downloads"])
    )
    try:
        await push_service.send(
            {
                "title": _("공유 링크로 받아 갔습니다"),
                "body": body,
                "tag": f"univdash-share-{share['id']}",
                "url": "/explorer",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("share notification failed")


async def _notify_lock(share: dict) -> None:
    i18n.activate(i18n.default())
    try:
        await push_service.send(
            {
                "title": _("공유 링크 접근 코드가 여러 번 틀렸습니다"),
                "body": _(
                    "{name} · 15분 동안 막았습니다. 모르는 사람이면 링크를 끊으십시오.",
                    name=share["name"],
                ),
                "tag": f"univdash-share-lock-{share['id']}",
                "url": "/explorer",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("share notification failed")
