import logging

from fastapi import APIRouter, Depends, Form, HTTPException, Path, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from app.assets import install as install_assets
from app.i18n import N_, _
from app.security import LoginRateLimiter, client_key
from app.services.core.auth_service import AuthService, config_problem, sessions

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
install_assets(templates)
logger = logging.getLogger(__name__)
login_limiter = LoginRateLimiter()

ERROR_MESSAGE = N_("로그인 정보가 올바르지 않습니다.")


def _login_page(
    request: Request, error: str | None = None, status_code: int = 200, headers=None
):
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={
            "error": error,
            "setup_problem": config_problem(),
            "totp": AuthService.totp_enabled(),
        },
        status_code=status_code,
        headers=headers,
    )


def _agent(request: Request) -> str:
    return (request.headers.get("user-agent") or "-")[:120]


@router.get("/login")
async def login_page(request: Request):
    if AuthService.is_authenticated(request):
        return RedirectResponse(url="/", status_code=303)
    return _login_page(request)


@router.post("/login")
async def login(
    request: Request,
    username: str = Form(..., max_length=128),
    password: str = Form(..., max_length=256),
    otp: str = Form("", max_length=12),
):
    client = client_key(request)
    retry_after = login_limiter.retry_after(client)
    if retry_after:
        return _login_page(
            request,
            _(
                "로그인 시도가 너무 많습니다. {seconds}초 후 다시 시도하십시오.",
                seconds=retry_after,
            ),
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    if AuthService.authenticate(username, password, otp):
        login_limiter.reset(client)
        AuthService.start_session(request, username)
        logger.info("sign-in succeeded · client=%s · ua=%s", client, _agent(request))
        return RedirectResponse(url="/", status_code=303)

    login_limiter.record_failure(client)
    logger.warning("sign-in failed · client=%s · ua=%s", client, _agent(request))
    # does not reveal which of the ID · password · code was wrong.
    return _login_page(request, _(ERROR_MESSAGE), status_code=401)


# Sign-out changes state too, so it is accepted by POST only (SecurityMiddleware blocks cross-origin POSTs).
@router.post("/logout")
async def logout(request: Request):
    AuthService.end_session(request)
    logger.info("sign-out · client=%s", client_key(request))
    return RedirectResponse(url="/login", status_code=303)


@router.post("/logout-all")
async def logout_all(request: Request):
    """Ends the sessions of every device (e.g. after losing a phone)."""
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    count = AuthService.end_all_sessions(request)
    logger.warning(
        "sign-out on all devices · %d sessions · client=%s", count, client_key(request)
    )
    return RedirectResponse(url="/login", status_code=303)


# ── Signed-in devices (Settings → Signed-in devices) ────────────────────────


def _current_sid(request: Request) -> str:
    sid = request.session.get("sid")
    return sid if isinstance(sid, str) else ""


@router.get("/api/auth/sessions", dependencies=[Depends(AuthService.require_user)])
async def session_list(request: Request):
    return {"sessions": sessions.active(_current_sid(request))}


@router.delete(
    "/api/auth/sessions/{session_id}",
    dependencies=[Depends(AuthService.require_user)],
)
async def session_revoke(
    request: Request, session_id: str = Path(pattern=r"^[0-9a-f]{20}$")
):
    current = _current_sid(request)
    mine = any(
        row["current"] and row["id"] == session_id for row in sessions.active(current)
    )
    if not sessions.revoke_id(session_id):
        raise HTTPException(status_code=404, detail=_("이미 로그아웃된 기기입니다."))
    if mine:
        request.session.clear()
    logger.warning(
        "device sign-out · %s · client=%s",
        "this device" if mine else session_id,
        client_key(request),
    )
    return {"ok": True, "current": mine}


@router.post(
    "/api/auth/sessions/revoke-others",
    dependencies=[Depends(AuthService.require_user)],
)
async def session_revoke_others(request: Request):
    count = sessions.revoke_others(_current_sid(request))
    logger.warning(
        "sign-out on all other devices · %d sessions · client=%s",
        count,
        client_key(request),
    )
    return {"ok": True, "count": count}
