"""공유 링크.

- 관리(로그인 필요): 만들기 · 목록 · 취소. 폴더는 묶는 동안 진행률을 물어본다.
- 받기(로그인 없음): GET /s/{토큰} 은 안내 페이지만 보여 주고, 내려받기는 그 페이지의 버튼(POST)으로만 한다.
  메신저 · 메일의 링크 미리보기 봇이 주소를 열어도 파일이 나가거나 횟수가 줄지 않는다.
"""

import asyncio
import logging
import secrets
import threading
import time
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.routes.pages import templates
from app.security import LoginRateLimiter, client_key
from app.services import push_service, share_service
from app.services.auth_service import AuthService
from app.services.fs_service import FsError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

# 틀린 토큰을 계속 넣어 보는 것을 늦춘다 (토큰은 256비트라 맞힐 수 없지만 로그 · 부하 방지)
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

# Referrer-Policy 는 기본(same-origin)을 둔다. no-referrer 면 브라우저가 폼 POST 의 Origin 을 null 로 보내
# CSRF 검사에 걸린다. 페이지에 바깥 링크 · 자원이 없어 토큰이 다른 사이트로 새지 않는다.
PUBLIC_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
}


# ── 관리 ──────────────────────────────────────────────────────────────────
class ShareRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    minutes: int = Field(
        default=share_service.MINUTES_DEFAULT,
        ge=share_service.MINUTES_MIN,
        le=share_service.MINUTES_MAX,
    )
    max_downloads: int = Field(default=0, ge=0, le=1000)
    skip_ignored: bool = False


_jobs: dict[str, dict] = {}
JOBS_MAX = 2


def _bad(error: Exception):
    if isinstance(error, FsError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    raise HTTPException(
        status_code=400, detail="공유할 수 없는 파일이나 폴더예요."
    ) from error


def _link(token: str, share: dict) -> dict:
    return {"state": "done", "url": f"/s/{token}", "share": share}


def _run_job(job: dict, real, body: ShareRequest) -> None:
    def progress(state: dict) -> bool:
        job.update(state)
        return job["cancel"] or time.monotonic() - job["seen"] > 30

    try:
        archive, size = share_service.zip_for_share(real, body.skip_ignored, progress)
        token, share = share_service.create(
            real, "dir", body.minutes, body.max_downloads, archive, size
        )
    except (FsError, OSError) as error:
        job.update(state="error", error=str(error) or "공유 링크를 만들지 못했어요.")
        return
    except Exception:
        logger.exception("공유 링크 만들기 실패 · %s", real)
        job.update(state="error", error="공유 링크를 만들지 못했어요.")
        return
    job.update(_link(token, share))


@router.post("/api/share", dependencies=api_auth)
async def create_share(body: ShareRequest):
    try:
        real, kind = await asyncio.to_thread(share_service.check_target, body.path)
    except (FsError, OSError) as error:
        _bad(error)
    if kind == "file":
        try:
            token, share = await asyncio.to_thread(
                share_service.create, real, kind, body.minutes, body.max_downloads
            )
        except (FsError, OSError) as error:
            _bad(error)
        return _link(token, share)
    now = time.monotonic()
    for job_id in [
        j
        for j, job in _jobs.items()
        if job["state"] != "running" and now - job["seen"] > 600
    ]:
        _jobs.pop(job_id, None)
    if sum(job["state"] == "running" for job in _jobs.values()) >= JOBS_MAX:
        raise HTTPException(
            status_code=429, detail="묶는 중인 공유가 있어요. 잠시 뒤 다시 시도하세요."
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
    threading.Thread(
        target=_run_job, args=(job, real, body), daemon=True, name="share-zip"
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
    "share",
    "error",
)


@router.get("/api/share/job/{job_id}", dependencies=api_auth)
async def share_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없어요.")
    job["seen"] = time.monotonic()
    result = {key: job[key] for key in _JOB_FIELDS if key in job}
    if job["state"] != "running":
        _jobs.pop(job_id, None)  # 링크는 한 번만 알려 준다
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
        raise HTTPException(status_code=404, detail="이미 없는 링크예요.")
    return {"ok": True}


# ── 받기 (로그인 없음) ──────────────────────────────────────────────────────
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
    """(공유 정보, 오류 응답) — 하나만 값이 있다.

    맞는 링크는 잠금과 상관없이 연다 (256비트라 맞혀 볼 수 없으므로, 남이 틀린 링크를 마구 넣어
    전체 잠금을 걸어도 받을 사람이 막히지 않게). 틀린 링크만 횟수를 세고 늦춘다.
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
    logger.warning("없거나 만료된 공유 링크 · client=%s", key)
    return None, _gone(request)


@router.get("/s/{token}")
async def share_page(request: Request, token: str):
    share, error = await asyncio.to_thread(_lookup, request, token)
    if error:
        return error
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
        expires=expires.strftime("%m월 %d일 %H:%M").lstrip("0"),
        minutes=max(1, int((share["expires"] - time.time() + 59) // 60)),
        left=left,
        action=f"/s/{token}",
    )


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
        if claimed is None:  # 그 사이 만료 · 횟수 소진 · 취소
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
        "공유 링크로 받음 · %s · %s · client=%s · %d번째",
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
    limit = share["max_downloads"]
    count = (
        f"{share['downloads']}/{limit}번째" if limit else f"{share['downloads']}번째"
    )
    try:
        await push_service.send(
            {
                "title": "공유 링크로 받아 갔어요",
                "body": f"{share['name']} · {count}",
                "tag": f"univdash-share-{share['id']}",
                "url": "/explorer",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("공유 알림 실패")
