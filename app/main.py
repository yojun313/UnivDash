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

from app.routes.accounts import account_routes
from app.routes.agents import pty_routes, tmux_routes
from app.routes.core import auth_routes, push_routes, settings_routes
from app.routes.files import fs_routes, upload_routes
from app.routes.git import git_routes
from app.routes.llm_api import llm_api_routes
from app.routes.server import domain_routes, server_routes
from app.routes.sharing import share_routes, view_share_routes
from app import i18n
from app.security import SecurityMiddleware, env_flag, resolve_secret_key
from app.services.accounts import codex_auto_switch
from app.services.agents import (
    agent_restart,
    agent_update_all,
    folder_rename,
    session_restore,
    tool_install,
)
from app.services.core import push_service
from app.services.core.auth_service import SESSION_MAX_AGE
from app.services.files import upload_service
from app.services.git import git_auto_pull
from app.services.sharing import share_service, view_share_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings_routes.load_default_language()
    # Restore tmux sessions after a reboot + snapshot of the session layout (background thread)
    session_restore.start()
    # Install missing tools (Claude Code · Codex · Chrome for PDF) (background thread)
    tool_install.start()
    tasks = [
        asyncio.create_task(upload_service.cleanup_loop()),
        asyncio.create_task(push_service.watch_loop()),
        asyncio.create_task(agent_restart.auto_trust_loop()),
        asyncio.create_task(git_auto_pull.loop()),
        asyncio.create_task(folder_rename.loop()),
        asyncio.create_task(codex_auto_switch.loop()),
        asyncio.create_task(agent_update_all.update_prompt_loop()),
        asyncio.create_task(share_service.cleanup_loop()),
        asyncio.create_task(view_share_service.cleanup_loop()),
        # If the OpenAI-compatible API is on, keep the sandbox container up (if off, take down a leftover container)
        asyncio.create_task(llm_api_routes.sync_sandbox()),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task


# This is an admin dashboard, so the API docs (/docs, /redoc, /openapi.json) are not exposed.
app = FastAPI(
    title="UnivDash", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
)

https_only = env_flag("SESSION_HTTPS_ONLY")

# Over HTTPS a __Host- prefixed cookie: Secure + Path=/ + no Domain are enforced, so a subdomain cannot overwrite it.
# SameSite=Strict: the cookie is not sent at all on requests started from another site.
app.add_middleware(
    SessionMiddleware,
    secret_key=resolve_secret_key(),
    session_cookie="__Host-univdash" if https_only else "univdash_session",
    max_age=SESSION_MAX_AGE,
    same_site="strict",
    https_only=https_only,
)
app.add_middleware(SecurityMiddleware, hsts=https_only)
# Outermost: every request (and WebSocket) runs with the language of that browser.
app.add_middleware(i18n.LanguageMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # The default 422 response exposes the input schema as is, so only a short message is returned.
    return JSONResponse(
        status_code=422, content={"detail": i18n._("잘못된 요청입니다.")}
    )


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
app.include_router(domain_routes.router)
app.include_router(fs_routes.router)
app.include_router(pty_routes.router)
app.include_router(settings_routes.router)
app.include_router(push_routes.router)
app.include_router(share_routes.router)
app.include_router(view_share_routes.router)
app.include_router(llm_api_routes.router)
