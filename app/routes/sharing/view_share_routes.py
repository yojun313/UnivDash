"""tmux screen sharing (read-only).

- Management (sign-in required): create · list · stop · stop all.
- Viewing (no sign-in): GET /v is an empty page without a token; the token lives only after the # of the address
  (never reaches the server or its logs). The page script calls GET /api/view/info · /api/view/screen with the
  X-View-Token header. The public routes only read the screen; input, keys and resizing exist nowhere.
"""

import asyncio
import logging
import threading
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app import i18n
from app.i18n import _
from app.routes.core.pages import templates
from app.security import LoginRateLimiter, client_key
from app.services.agents import tmux_service
from app.services.agents.tmux_service import TmuxError
from app.services.core import push_service
from app.services.core.auth_service import AuthService
from app.services.sharing import access_code, view_share_service

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

# Slows down repeated wrong tokens
_misses = LoginRateLimiter(
    max_attempts=20,
    window_seconds=600,
    lockout_seconds=900,
    global_max_attempts=300,
    global_window_seconds=600,
    global_lockout_seconds=300,
)
PUBLIC_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
}
# Screen requests: up to this many per second per viewer (the page asks once a second)
RATE_PER_SEC = 3.0
RATE_BURST = 6.0
_buckets: dict[str, tuple[float, float]] = {}
_buckets_lock = threading.Lock()
_tasks: set[asyncio.Task] = set()


# ── Management ────────────────────────────────────────────────────────────
class ViewShareRequest(BaseModel):
    pane: str = Field(min_length=2, max_length=16)
    minutes: int = Field(
        default=view_share_service.MINUTES_DEFAULT,
        ge=view_share_service.MINUTES_MIN,
        le=view_share_service.MINUTES_MAX,
    )
    history: int = Field(default=0, ge=0, le=2000)
    title: str = Field(default="", max_length=200)
    chat: bool = True  # for an agent window, show the conversation (chat) too


@router.post("/api/view-shares", dependencies=api_auth)
async def create_view_share(body: ViewShareRequest):
    try:
        token, code, share = await asyncio.to_thread(
            view_share_service.create,
            body.pane,
            body.minutes,
            body.history,
            body.title,
            body.chat,
        )
    except KeyError as error:
        raise HTTPException(
            status_code=404, detail=_("창을 찾을 수 없습니다.")
        ) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except TmuxError as error:
        raise HTTPException(
            status_code=502, detail=_("tmux 명령을 실행하지 못했습니다.")
        ) from error
    return {"url": f"/v#{token}", "code": code, "share": share}


@router.get("/api/view-shares", dependencies=api_auth)
async def list_view_shares():
    shares = await asyncio.to_thread(view_share_service.active)
    try:
        panes = await asyncio.to_thread(tmux_service._pane_ids)
    except TmuxError:
        panes = set()
    for share in shares:
        share["pane_alive"] = share["pane"] in panes
    return {"shares": shares}


@router.delete("/api/view-shares/{share_id}", dependencies=api_auth)
async def revoke_view_share(share_id: str):
    if not await asyncio.to_thread(view_share_service.revoke, share_id[:64]):
        raise HTTPException(status_code=404, detail=_("이미 끊긴 공유입니다."))
    return {"ok": True}


@router.delete("/api/view-shares", dependencies=api_auth)
async def revoke_all_view_shares():
    return {"revoked": await asyncio.to_thread(view_share_service.revoke_all)}


# ── Viewing (no sign-in) ──────────────────────────────────────────────────
@router.get("/v")
async def view_page(request: Request):
    response = templates.TemplateResponse(request=request, name="view.html")
    response.headers.update(PUBLIC_HEADERS)
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _json(status: int, content: dict, **headers) -> JSONResponse:
    return JSONResponse(
        status_code=status, content=content, headers={**PUBLIC_HEADERS, **headers}
    )


def _allow(who: str) -> bool:
    now = time.monotonic()
    with _buckets_lock:
        if len(_buckets) > 5000:
            for key in [k for k, (_tokens, t) in _buckets.items() if now - t > 60]:
                _buckets.pop(key)
        tokens, last = _buckets.get(who, (RATE_BURST, now))
        tokens = min(RATE_BURST, tokens + (now - last) * RATE_PER_SEC)
        if tokens < 1:
            _buckets[who] = (tokens, now)
            return False
        _buckets[who] = (tokens - 1, now)
        return True


def _lookup(request: Request, token: str):
    """(share, error response) — a correct token opens regardless of the lockout (256 bits cannot be guessed)."""
    share = view_share_service.find(token)
    if share is not None:
        return share, None
    key = client_key(request)
    wait = _misses.retry_after(key)
    if wait:
        return None, _json(429, {"state": "locked"}, **{"Retry-After": str(wait)})
    _misses.record_failure(key)
    logger.warning("unknown or expired screen share · client=%s", key)
    return None, _json(404, {"state": "gone"})


def _token(request: Request) -> str:
    return (request.headers.get("x-view-token") or "")[:64]


async def _code_error(request: Request, share: dict) -> JSONResponse | None:
    """None when the access code is correct, otherwise the response to send."""
    result = await asyncio.to_thread(
        access_code.check, share, request.headers.get("x-view-code")
    )
    if result:
        return None
    who = client_key(request)
    if result is None:
        wait = access_code.locked(share["id"]) or 60
        logger.warning(
            "screen share access code locked · %s · client=%s", share["id"], who
        )
        if access_code.should_notify(share["id"]):
            task = asyncio.create_task(_notify_lock(share))
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
        return _json(
            429, {"state": "code_locked", "wait": wait}, **{"Retry-After": str(wait)}
        )
    logger.warning("screen share access code wrong · %s · client=%s", share["id"], who)
    return _json(403, {"state": "code"})


@router.get("/api/view/info")
async def view_info(request: Request):
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    token = _token(request)
    share, error = await asyncio.to_thread(_lookup, request, token)
    if error:
        return error
    if not request.headers.get("x-view-code"):
        # Code entry screen — nothing is shown yet
        return _json(401, {"state": "need_code"})
    if denied := await _code_error(request, share):
        return denied
    opened = await asyncio.to_thread(view_share_service.note_open, token)
    if opened is None:
        return _json(404, {"state": "gone"})
    logger.info(
        "screen share opened · %s · pane=%s · client=%s · open #%d",
        share["id"],
        share["pane"],
        who,
        opened["opens"],
    )
    if view_share_service.note_viewer(share["id"], who):
        task = asyncio.create_task(_notify(opened))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    return _json(
        200,
        {
            "state": "ok",
            "title": share["title"],
            "expires": share["expires"],
            "chat": await asyncio.to_thread(view_share_service.chat_available, share),
            "until": datetime.fromtimestamp(share["expires"])
            .strftime(_("%m월 %d일 %H:%M"))
            .lstrip("0"),
        },
    )


@router.get("/api/view/chat")
async def view_chat(request: Request, start: int | None = None, limit: int = 100):
    """Conversation of the shared window's agent (read-only). Without start, the last `limit` items."""
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    share, error = await asyncio.to_thread(_lookup, request, _token(request))
    if error:
        return error
    if denied := await _code_error(request, share):
        return denied
    view_share_service.note_viewer(share["id"], who)
    if start is not None and not 0 <= start <= 10_000_000:
        start = None
    try:
        data = await asyncio.to_thread(view_share_service.chat, share, start, limit)
    except Exception:
        logger.exception("reading screen share chat failed · %s", share["id"])
        return _json(200, {"state": "ok", "available": False})
    if data is None:
        return _json(410, {"state": "closed"})
    if data.get("hash") and request.query_params.get("h") == data["hash"]:
        return Response(status_code=204, headers=PUBLIC_HEADERS)
    return _json(200, {"state": "ok", "expires": share["expires"], **data})


@router.get("/api/view/screen")
async def view_screen(request: Request):
    who = client_key(request)
    if not _allow(who):
        return _json(429, {"state": "busy"}, **{"Retry-After": "2"})
    share, error = await asyncio.to_thread(_lookup, request, _token(request))
    if error:
        return error
    if denied := await _code_error(request, share):
        return denied
    view_share_service.note_viewer(share["id"], who)
    data = await asyncio.to_thread(view_share_service.screen, share)
    if data is None:
        return _json(410, {"state": "closed"})
    if request.query_params.get("h") == data["hash"]:
        return Response(status_code=204, headers=PUBLIC_HEADERS)
    return _json(200, {"state": "ok", "expires": share["expires"], **data})


async def _notify(share: dict) -> None:
    # The notification goes to the owner: use the server language, not the viewer's
    i18n.activate(i18n.default())
    try:
        await push_service.send(
            {
                "title": _("공유한 화면을 누가 보고 있습니다"),
                "body": _(
                    "{title} · {count}번째 열림",
                    title=share["title"],
                    count=share.get("opens", 0),
                ),
                "tag": f"univdash-view-{share['id']}",
                "url": "/",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("screen share notification failed")


async def _notify_lock(share: dict) -> None:
    i18n.activate(i18n.default())
    try:
        await push_service.send(
            {
                "title": _("화면 공유 접근 코드가 여러 번 틀렸습니다"),
                "body": _(
                    "{title} · 15분 동안 막았습니다. 모르는 사람이면 공유를 끊으십시오.",
                    title=share["title"],
                ),
                "tag": f"univdash-view-lock-{share['id']}",
                "url": "/",
            },
            skip_focused=False,
        )
    except Exception:
        logger.exception("screen share notification failed")
