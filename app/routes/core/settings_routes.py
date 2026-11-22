"""Settings window API: read · change server settings (sign-in required; the security middleware blocks cross-origin requests)."""

import asyncio
import logging
import os
import shutil

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.i18n import _
from app.services.core import settings_service
from app.services.core.auth_service import AuthService
from app.services.files import upload_service

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
    try:  # also show the server's free disk space as a reference when choosing the upload size
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
            status_code=400, detail=_("설정 값이 범위를 벗어났습니다.")
        ) from error
    except OSError as error:
        logger.warning("settings could not be saved: %s", error)
        raise HTTPException(
            status_code=500, detail=_("설정을 저장하지 못했습니다.")
        ) from error
    logger.info("settings changed · %s · %s", user, changes)
    return _payload(value)


# ── Interface language (Korean / English) ──────────────────────────────────────


def _language_file():
    from app.paths import data_dir

    return data_dir() / "language.json"


def load_default_language() -> None:
    """At start-up: text produced outside a request (push notifications) uses the last chosen language."""
    import json

    from app import i18n

    try:
        saved = json.loads(_language_file().read_text(encoding="utf-8")).get("lang")
    except (OSError, ValueError, AttributeError):
        saved = None
    i18n.set_default(saved or os.getenv("UNIVDASH_LANG"))


class LanguageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lang: str = Field(pattern=r"^(ko|en)$")


@router.get("/i18n.js")
async def i18n_script(l: str = ""):  # noqa: E741 — short query name keeps the URL small
    """Catalog and `t()` for the page (public: the login page needs it too; it holds UI text only)."""
    from app import i18n

    lang = i18n.normalize(l) or i18n.current()
    return Response(
        i18n.script(lang),
        media_type="text/javascript; charset=utf-8",
        # the URL carries a version (?v=…), so a changed catalog gets a new URL
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.put("/api/settings/language")
async def write_language(
    body: LanguageUpdate, user: str = Depends(AuthService.require_user)
):
    """Remember the language in this browser (cookie) and as the server default for notifications."""
    import json

    from app import i18n

    i18n.set_default(body.lang)
    try:
        path = _language_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"lang": body.lang}), encoding="utf-8")
    except OSError as error:
        logger.warning("language setting could not be saved: %s", error)
    response = JSONResponse({"lang": body.lang})
    response.set_cookie(
        i18n.COOKIE,
        body.lang,
        max_age=365 * 24 * 3600,
        path="/",
        samesite="lax",
        httponly=False,  # read by nothing sensitive; the page reloads after a change
    )
    logger.info("interface language · %s · %s", user, body.lang)
    return response
