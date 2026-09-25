"""Git 관리 (PM2Dash 에서 옮겨 온 기능)."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services.auth_service import AuthService
from app.services.git_preferences import GitPreferences, GitPreferencesStore
from app.services.git_service import GitService

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


@router.get("/api/git/repositories", dependencies=api_auth)
async def get_repositories(status: bool = True):
    repositories = await asyncio.to_thread(GitService.list_repositories, status)
    preferences = await asyncio.to_thread(GitPreferencesStore.load)
    return {"repositories": repositories, "preferences": preferences.model_dump()}


@router.put("/api/git/preferences", dependencies=api_auth)
async def save_preferences(preferences: GitPreferences):
    saved = await asyncio.to_thread(GitPreferencesStore.save, preferences)
    return {"preferences": saved.model_dump()}


@router.get("/api/git/repositories/{repository_id}", dependencies=api_auth)
async def get_repository(repository_id: str):
    try:
        return await asyncio.to_thread(GitService.get_repository_detail, repository_id)
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)


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
    if action == "ruff_format":
        try:
            return await asyncio.to_thread(GitService.ruff_format, repository_id)
        except (KeyError, ValueError, RuntimeError) as error:
            _raise_for(error)
    if action not in GitService.ACTIONS:
        raise HTTPException(status_code=400, detail="지원하지 않는 Git 작업입니다.")
    try:
        return await asyncio.to_thread(
            GitService.run_action,
            repository_id,
            action,
            payload.model_dump(),
        )
    except (KeyError, ValueError, RuntimeError) as error:
        _raise_for(error)
