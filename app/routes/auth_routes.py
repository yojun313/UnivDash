import logging

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from app.security import LoginRateLimiter, client_key
from app.services.auth_service import AuthService, config_problem

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")
logger = logging.getLogger(__name__)
login_limiter = LoginRateLimiter()

ERROR_MESSAGE = "로그인 정보가 올바르지 않습니다."


def _login_page(request: Request, error: str | None = None, status_code: int = 200, headers=None):
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"error": error, "setup_problem": config_problem(), "totp": AuthService.totp_enabled()},
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
            f"로그인 시도가 너무 많습니다. {retry_after}초 후 다시 시도하세요.",
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    if AuthService.authenticate(username, password, otp):
        login_limiter.reset(client)
        AuthService.start_session(request, username)
        logger.info("로그인 성공 · client=%s · ua=%s", client, _agent(request))
        return RedirectResponse(url="/", status_code=303)

    login_limiter.record_failure(client)
    logger.warning("로그인 실패 · client=%s · ua=%s", client, _agent(request))
    # 아이디 · 비밀번호 · 코드 중 무엇이 틀렸는지 알려주지 않는다.
    return _login_page(request, ERROR_MESSAGE, status_code=401)


# 로그아웃도 상태 변경이므로 POST 로만 받는다 (SecurityMiddleware 가 교차 출처 POST 를 막는다).
@router.post("/logout")
async def logout(request: Request):
    AuthService.end_session(request)
    logger.info("로그아웃 · client=%s", client_key(request))
    return RedirectResponse(url="/login", status_code=303)


@router.post("/logout-all")
async def logout_all(request: Request):
    """모든 기기의 세션을 끊는다 (휴대폰을 잃어버렸을 때 등)."""
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    count = AuthService.end_all_sessions(request)
    logger.warning("전체 기기 로그아웃 · %d개 세션 · client=%s", count, client_key(request))
    return RedirectResponse(url="/login", status_code=303)
