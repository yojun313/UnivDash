"""Git management (a feature moved over from PM2Dash)."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.i18n import _
from app.routes.core.pages import render_page
from app.services.core.auth_service import AuthService
from app.services.git import git_auto_pull, git_workflow
from app.services.git.git_preferences import GitPreferences, GitPreferencesStore
from app.services.git.git_service import GitService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]


class GitActionRequest(BaseModel):
    rebase: bool = False
    force: bool = False
    paths: list[str] | None = Field(default=None, max_length=2000)
    message: str | None = Field(default=None, max_length=10000)
    amend: bool = False
    stage_all: bool = False
    push_after: bool = False
    branch: str | None = Field(default=None, max_length=255)
    start_point: str | None = Field(default=None, max_length=255)
    switch: bool = True
    no_ff: bool = False
    squash: bool = False
    include_untracked: bool = False
    stash_ref: str | None = Field(default=None, max_length=32)
    commit: str | None = Field(default=None, max_length=40)


class AutoPullRequest(BaseModel):
    enabled: bool
    interval_minutes: int = Field(
        default=git_auto_pull.DEFAULT_INTERVAL_MINUTES,
        ge=git_auto_pull.MIN_INTERVAL_MINUTES,
        le=git_auto_pull.MAX_INTERVAL_MINUTES,
    )


def _raise_for(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else error)
        ) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/git")
async def git_manager_page(request: Request):
    return render_page(request, "git")


class AISettingsRequest(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    token: str | None = Field(
        default=None, max_length=1000
    )  # None: keep as is, "": remove
    language: str = Field(default="auto", pattern=r"^(auto|ko|en)$")
    # fallback API (OpenAI): None keeps it as is, "" removes it
    fallback_model: str | None = Field(default=None, max_length=120)
    fallback_token: str | None = Field(default=None, max_length=1000)


class AIModelsRequest(BaseModel):
    base_url: str = Field(default="", max_length=500)
    token: str | None = Field(default=None, max_length=1000)
    target: str = Field(default="primary", pattern=r"^(primary|fallback)$")


class AICommitRequest(BaseModel):
    stage_all: bool = True


@router.get("/api/git/ai/settings", dependencies=api_auth)
async def get_ai_settings():
    """AI commit message settings (for the token, only whether it is set)."""
    from app.services.git import ai_commit_service

    return await asyncio.to_thread(ai_commit_service.public_settings)


@router.put("/api/git/ai/settings", dependencies=api_auth)
async def save_ai_settings(body: AISettingsRequest):
    from app.services.git import ai_commit_service

    try:
        return await asyncio.to_thread(
            ai_commit_service.save_settings,
            body.base_url,
            body.model,
            body.token,
            body.language,
            body.fallback_model,
            body.fallback_token,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/git/ai/models", dependencies=api_auth)
async def get_ai_models(body: AIModelsRequest):
    """Reads the models available from the OpenAI-compatible API and picks a default model."""
    from app.services.git import ai_commit_service

    try:
        return await asyncio.to_thread(
            ai_commit_service.discover_model, body.base_url, body.token, body.target
        )
    except ai_commit_service.AICommitError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/git/ai/commit-message/{repository_id}", dependencies=api_auth)
async def ai_commit_message(repository_id: str, body: AICommitRequest):
    """Reads the changes to commit and writes a commit message with AI (the repository is not changed)."""
    from app.services.git import ai_commit_service

    try:
        return await asyncio.to_thread(
            ai_commit_service.generate, repository_id, body.stage_all
        )
    except ai_commit_service.AICommitError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)


@router.get("/api/git/workflows", dependencies=api_auth)
async def list_workflows():
    """ruff format · AI commit · push auto flows (last 24 hours). The screen uses this to show progress and completion notices."""
    jobs = await asyncio.to_thread(git_workflow.jobs)
    return {"jobs": [{k: v for k, v in job.items() if k != "pid"} for job in jobs]}


@router.post("/api/git/workflows/{repository_id}", dependencies=api_auth)
async def start_workflow(repository_id: str):
    try:
        job = await asyncio.to_thread(git_workflow.start, repository_id)
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)
    return {k: v for k, v in job.items() if k != "pid"}


@router.get("/api/git/repositories", dependencies=api_auth)
async def get_repositories(status: bool = True):
    repositories = await asyncio.to_thread(GitService.list_repositories, status)
    preferences = await asyncio.to_thread(GitPreferencesStore.load)
    auto_pull = await asyncio.to_thread(git_auto_pull.overview)
    return {
        "repositories": repositories,
        "preferences": preferences.model_dump(),
        "auto_pull": auto_pull,
    }


@router.put("/api/git/preferences", dependencies=api_auth)
async def save_preferences(preferences: GitPreferences):
    saved = await asyncio.to_thread(GitPreferencesStore.save, preferences)
    return {"preferences": saved.model_dump()}


@router.put("/api/git/auto-pull/{repository_id}", dependencies=api_auth)
async def save_auto_pull(repository_id: str, body: AutoPullRequest):
    try:
        return await asyncio.to_thread(
            git_auto_pull.configure, repository_id, body.enabled, body.interval_minutes
        )
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)


@router.get("/api/git/repositories/{repository_id}", dependencies=api_auth)
async def get_repository(repository_id: str):
    try:
        detail = await asyncio.to_thread(
            GitService.get_repository_detail, repository_id
        )
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)
    detail["auto_pull"] = await asyncio.to_thread(git_auto_pull.status, repository_id)
    return detail


@router.get("/api/git/repositories/{repository_id}/diff", dependencies=api_auth)
async def get_diff(
    repository_id: str,
    path: str = Query(..., min_length=1, max_length=4096),
    staged: bool = False,
):
    try:
        return await asyncio.to_thread(GitService.get_diff, repository_id, path, staged)
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)


@router.get(
    "/api/git/repositories/{repository_id}/commits/{commit_hash}", dependencies=api_auth
)
async def get_commit(repository_id: str, commit_hash: str):
    try:
        return await asyncio.to_thread(
            GitService.get_commit, repository_id, commit_hash
        )
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)


@router.post("/api/git/repositories/{repository_id}/{action}", dependencies=api_auth)
async def run_git_action(
    repository_id: str,
    action: str,
    payload: GitActionRequest,
):
    # the auto flow is a separate process and cannot share the repository lock → while it runs, other operations on the same repository are blocked
    if await asyncio.to_thread(git_workflow.running_for, repository_id):
        raise HTTPException(
            status_code=409,
            detail=_(
                "이 저장소에서 자동 커밋 흐름(ruff · AI 커밋 · 푸시)이 실행 중입니다. 끝난 뒤 다시 해 주십시오."
            ),
        )
    if action == "ruff_format":
        try:
            return await asyncio.to_thread(GitService.ruff_format, repository_id)
        except (KeyError, ValueError, RuntimeError) as error:
            _raise_for(error)
    if action not in GitService.ACTIONS:
        raise HTTPException(status_code=400, detail=_("지원하지 않는 Git 작업입니다."))
    try:
        return await asyncio.to_thread(
            GitService.run_action,
            repository_id,
            action,
            payload.model_dump(),
        )
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)
