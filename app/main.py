import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

load_dotenv()

from app.routes import (
    account_routes,
    auth_routes,
    fs_routes,
    git_routes,
    pty_routes,
    server_routes,
    tmux_routes,
    upload_routes,
)
from app.security import SecurityMiddleware, env_flag, resolve_secret_key
from app.services.auth_service import SESSION_MAX_AGE
from app.services import upload_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup_task = asyncio.create_task(upload_service.cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task


# 관리용 대시보드이므로 API 문서(/docs, /redoc, /openapi.json)는 노출하지 않는다.
app = FastAPI(
    title="UnivDash", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
)

https_only = env_flag("SESSION_HTTPS_ONLY")

# HTTPS 에서는 __Host- 접두사 쿠키: Secure + Path=/ + Domain 없음이 강제되어 하위 도메인이 쿠키를 덮어쓸 수 없다.
# SameSite=Strict: 다른 사이트에서 시작된 요청에는 쿠키가 아예 실리지 않는다.
app.add_middleware(
    SessionMiddleware,
    secret_key=resolve_secret_key(),
    session_cookie="__Host-univdash" if https_only else "univdash_session",
    max_age=SESSION_MAX_AGE,
    same_site="strict",
    https_only=https_only,
)
app.add_middleware(SecurityMiddleware, hsts=https_only)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # 기본 422 응답은 입력 스키마를 그대로 드러내므로 간단한 메시지만 돌려준다.
    return JSONResponse(status_code=422, content={"detail": "잘못된 요청입니다."})


app.mount(
    "/static",
    StaticFiles(directory=Path(__file__).resolve().parent / "static"),
    name="static",
)

app.include_router(auth_routes.router)
app.include_router(account_routes.router)
app.include_router(tmux_routes.router)
app.include_router(upload_routes.router)
app.include_router(server_routes.router)
app.include_router(git_routes.router)
app.include_router(fs_routes.router)
app.include_router(pty_routes.router)
