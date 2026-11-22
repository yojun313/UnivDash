import logging

from fastapi import APIRouter, Depends, Form, HTTPException, Path, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, ConfigDict, Field

from app.assets import install as install_assets
from app.i18n import N_, _
from app.security import LoginRateLimiter, client_key
from app.services.core import auth_service, passkeys
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
            "passkey": passkeys.any_registered(),
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


# ── Two-factor authentication, enrolled in the browser ────────────────────────
# Enrolment: /setup hands out a fresh secret (QR code + key) → /enable activates it once the authenticator
# app shows a matching code. Enabling signs every other device out and keeps this browser signed in.


class TotpCode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=6, max_length=12)


class TotpDisable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=12)


@router.get("/api/auth/totp", dependencies=[Depends(AuthService.require_user)])
async def totp_status():
    return auth_service.totp_status()


@router.post("/api/auth/totp/setup")
async def totp_setup(request: Request, user: str = Depends(AuthService.require_user)):
    try:
        return auth_service.totp_begin(_current_sid(request), user)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/api/auth/totp/enable")
async def totp_enable(
    body: TotpCode, request: Request, user: str = Depends(AuthService.require_user)
):
    client = client_key(request)
    try:
        auth_service.totp_enable(_current_sid(request), body.code)
    except ValueError as error:
        logger.warning("two-factor enrolment failed · client=%s", client)
        raise HTTPException(status_code=400, detail=str(error)) from error
    # The secret is part of every session's fingerprint, so all sessions just became invalid.
    # Issue a new one for this browser; the other devices have to sign in again with a code.
    AuthService.start_session(request, user)
    logger.info("two-factor enabled · %s · client=%s", user, client)
    return auth_service.totp_status()


@router.post("/api/auth/totp/disable")
async def totp_disable(
    body: TotpDisable, request: Request, user: str = Depends(AuthService.require_user)
):
    client = client_key(request)
    retry_after = login_limiter.retry_after(client)
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail=_(
                "로그인 시도가 너무 많습니다. {seconds}초 후 다시 시도하십시오.",
                seconds=retry_after,
            ),
            headers={"Retry-After": str(retry_after)},
        )
    try:
        auth_service.totp_disable(body.password, body.code)
    except ValueError as error:
        login_limiter.record_failure(client)
        logger.warning("two-factor disable refused · client=%s", client)
        raise HTTPException(status_code=400, detail=str(error)) from error
    AuthService.start_session(request, user)
    logger.info("two-factor disabled · %s · client=%s", user, client)
    return auth_service.totp_status()


@router.post("/api/auth/totp/dismiss", dependencies=[Depends(AuthService.require_user)])
async def totp_dismiss():
    auth_service.totp_dismiss()
    return {"ok": True}


# ── Passkeys (WebAuthn) ───────────────────────────────────────────────────────
# Signing in with a passkey needs neither the password nor a two-factor code: the device itself checks the
# person (biometrics / PIN) before it answers. Adding one needs the password, so a borrowed session cannot
# quietly leave itself a way back in.


def _site(request: Request) -> tuple[str, str]:
    return passkeys.site(request.headers.get("origin"), request.headers.get("host"))


class PasskeyStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=256)


class PasskeyCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credential: dict
    name: str = Field(default="", max_length=40)


class PasskeyName(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=40)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current: str = Field(min_length=1, max_length=256)
    new: str = Field(min_length=1, max_length=256)
    code: str = Field(default="", max_length=12)


@router.get("/api/auth/passkeys", dependencies=[Depends(AuthService.require_user)])
async def passkey_list(request: Request):
    host = (request.headers.get("host") or "").split(":")[0].strip("[]").lower()
    return {"passkeys": passkeys.public_list(host or None)}


@router.post("/api/auth/passkeys/options")
async def passkey_register_options(
    body: PasskeyStart, request: Request, user: str = Depends(AuthService.require_user)
):
    client = client_key(request)
    if login_limiter.retry_after(client):
        raise HTTPException(status_code=429, detail=_(ERROR_MESSAGE))
    if not auth_service.check_password(body.password):
        login_limiter.record_failure(client)
        raise HTTPException(status_code=403, detail=_("비밀번호가 맞지 않습니다."))
    try:
        rp_id, _origin = _site(request)
        return passkeys.register_options(request.session, rp_id, user)
    except passkeys.PasskeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/auth/passkeys")
async def passkey_register(
    body: PasskeyCredential,
    request: Request,
    user: str = Depends(AuthService.require_user),
):
    try:
        rp_id, origin = _site(request)
        saved = passkeys.register_verify(
            request.session, rp_id, origin, body.credential, body.name
        )
    except passkeys.PasskeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    logger.info("passkey added · %s · client=%s", user, client_key(request))
    return saved


@router.patch(
    "/api/auth/passkeys/{passkey_id}", dependencies=[Depends(AuthService.require_user)]
)
async def passkey_rename(
    body: PasskeyName,
    passkey_id: str = Path(pattern=r"^[A-Za-z0-9_-]{16}$"),
):
    try:
        passkeys.rename(passkey_id, body.name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0])) from error
    return {"ok": True}


@router.delete("/api/auth/passkeys/{passkey_id}")
async def passkey_remove(
    request: Request,
    passkey_id: str = Path(pattern=r"^[A-Za-z0-9_-]{16}$"),
    user: str = Depends(AuthService.require_user),
):
    try:
        passkeys.remove(passkey_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0])) from error
    logger.info("passkey removed · %s · client=%s", user, client_key(request))
    return {"ok": True}


@router.post("/api/auth/passkey/login/options")
async def passkey_login_options(request: Request):
    """Public: the challenge for a passkey sign-in. It reveals nothing about which passkeys exist."""
    if login_limiter.retry_after(client_key(request)):
        raise HTTPException(status_code=429, detail=_(ERROR_MESSAGE))
    try:
        rp_id, _origin = _site(request)
        return passkeys.login_options(request.session, rp_id)
    except passkeys.PasskeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class PasskeyLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credential: dict


@router.post("/api/auth/passkey/login")
async def passkey_login(body: PasskeyLogin, request: Request):
    client = client_key(request)
    retry_after = login_limiter.retry_after(client)
    if retry_after or config_problem():
        raise HTTPException(
            status_code=429 if retry_after else 403, detail=_(ERROR_MESSAGE)
        )
    try:
        rp_id, origin = _site(request)
        used = passkeys.login_verify(request.session, rp_id, origin, body.credential)
    except passkeys.PasskeyError as error:
        login_limiter.record_failure(client)
        logger.warning(
            "passkey sign-in failed · client=%s · ua=%s", client, _agent(request)
        )
        raise HTTPException(status_code=401, detail=str(error)) from error
    login_limiter.reset(client)
    AuthService.start_session(request, auth_service._username())
    logger.info(
        "sign-in succeeded (passkey: %s) · client=%s · ua=%s",
        used,
        client,
        _agent(request),
    )
    return {"ok": True, "redirect": "/"}


@router.post("/api/auth/password")
async def password_change(
    body: PasswordChange,
    request: Request,
    user: str = Depends(AuthService.require_user),
):
    client = client_key(request)
    retry_after = login_limiter.retry_after(client)
    if retry_after:
        raise HTTPException(status_code=429, detail=_(ERROR_MESSAGE))
    try:
        auth_service.change_password(body.current, body.new, body.code)
    except ValueError as error:
        login_limiter.record_failure(client)
        raise HTTPException(status_code=400, detail=str(error)) from error
    # every session is invalid now: keep this browser signed in, the others sign in again with the new password
    AuthService.start_session(request, user)
    logger.info("password changed · %s · client=%s", user, client)
    return {"ok": True}
