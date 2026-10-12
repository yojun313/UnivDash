"""설정 창 API: 서버 설정 읽기 · 바꾸기 (로그인 필요, 교차 출처 요청은 보안 미들웨어가 막는다)."""

import asyncio
import logging
import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services import settings_service, upload_service
from app.services.auth_service import AuthService

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    upload_max_mb: int | None = Field(
        default=None, ge=1, le=settings_service.UPLOAD_MAX_MB_LIMIT
    )
    upload_ttl_days: float | None = Field(default=None, ge=0.5, le=30)
    viewer_max_mb: int | None = Field(default=None, ge=1, le=20)
    edit_max_mb: int | None = Field(default=None, ge=1, le=50)


def _payload(value: settings_service.ServerSettings) -> dict:
    try:  # 업로드 크기를 정할 때 참고하도록 서버 디스크 남은 공간을 같이 보여 준다
        free = shutil.disk_usage(upload_service.upload_dir()).free
    except OSError:
        free = None
    return {
        "disk_free": free,
        "settings": value.model_dump(),
        "defaults": settings_service.defaults().model_dump(),
        "limits": {"upload_max_mb": settings_service.UPLOAD_MAX_MB_LIMIT},
    }


@router.get("/api/settings", dependencies=api_auth)
async def read_settings():
    return _payload(await asyncio.to_thread(settings_service.get))


@router.put("/api/settings")
async def write_settings(
    body: SettingsUpdate, user: str = Depends(AuthService.require_user)
):
    changes = body.model_dump(exclude_none=True)
    try:
        value = await asyncio.to_thread(settings_service.update, changes)
    except (ValidationError, ValueError) as error:
        raise HTTPException(
            status_code=400, detail="설정 값이 범위를 벗어났어요."
        ) from error
    except OSError as error:
        logger.warning("설정 저장 실패: %s", error)
        raise HTTPException(
            status_code=500, detail="설정을 저장하지 못했어요."
        ) from error
    logger.info("설정 변경 · %s · %s", user, changes)
    return _payload(value)
