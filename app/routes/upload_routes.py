import asyncio
import logging
import os
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from starlette.requests import ClientDisconnect

from app.services import upload_service
from app.services.auth_service import AuthService

router = APIRouter()
logger = logging.getLogger(__name__)


def _require_user(request: Request) -> None:
    # 본문을 읽기 전에 인증부터 확인한다 (비로그인 대용량 업로드로 디스크를 채우지 못하게).
    if not AuthService.current_user(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.post("/api/uploads")
async def api_upload(request: Request):
    """본문 전체가 파일 하나다 (multipart 아님). 원래 이름은 X-Filename 헤더(URI 인코딩)."""
    _require_user(request)
    limit = upload_service.max_bytes()
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError:
        raise HTTPException(status_code=400, detail="잘못된 요청입니다.") from None
    if declared > limit:
        raise HTTPException(status_code=413, detail=f"파일이 너무 큽니다 (최대 {limit // (1024 * 1024)}MB).")

    original = unquote(request.headers.get("x-filename", ""))[:255] or "file"
    path = await asyncio.to_thread(upload_service.new_path, original)
    written = 0
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail=f"파일이 너무 큽니다 (최대 {limit // (1024 * 1024)}MB).")
                handle.write(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="빈 파일은 첨부할 수 없습니다.")
    except (HTTPException, ClientDisconnect, OSError) as error:
        path.unlink(missing_ok=True)
        if isinstance(error, HTTPException):
            raise
        if isinstance(error, OSError):
            logger.warning("첨부 파일 저장 실패: %s", error)
            raise HTTPException(status_code=500, detail="파일을 저장하지 못했습니다.") from error
        raise HTTPException(status_code=400, detail="업로드가 중단되었습니다.") from error

    await asyncio.to_thread(upload_service.cleanup)
    logger.info("첨부 업로드 · %s · %d bytes", path.name, written)
    return {"id": path.name, "path": str(path), "name": original, "size": written}


@router.delete("/api/uploads/{upload_id}")
async def api_delete_upload(upload_id: str, request: Request):
    _require_user(request)
    try:
        await asyncio.to_thread(upload_service.remove, upload_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="첨부 파일을 찾을 수 없습니다.") from None
    return {"ok": True}
