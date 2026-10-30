"""서버 & 프로세스 (PM2Dash 에서 옮겨 온 기능): 서버 자원, PM2 프로세스 제어 · 로그, AI 사용량."""

import asyncio
import logging

import psutil
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.routes.pages import render_page
from app.services import ecosystem_service, sysmon_service
from app.services.ai_usage_service import AIUsageService
from app.services.auth_service import AuthService
from app.services.ecosystem_service import EcosystemError
from app.services.pm2_service import PM2Service

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)


@router.get("/server")
async def server_resources_page(request: Request):
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    processes = await asyncio.to_thread(PM2Service.get_process_summaries)
    return render_page(request, "server", processes=processes)


@router.get("/ai-usage")
async def ai_usage_page(request: Request):
    return render_page(request, "ai_usage")


@router.get("/processes")
async def pm2_manager_page(request: Request):
    # PM2Dash 시절 주소 호환
    if not AuthService.is_authenticated(request):
        return RedirectResponse(url="/login", status_code=303)
    return RedirectResponse(url="/server", status_code=303)


async def ensure_process(name: str) -> None:
    """URL 로 받은 이름이 실제 PM2 프로세스인지 확인한다 (옵션 주입/임의 대상 차단)."""
    if not name or name.startswith("-") or len(name) > 200:
        raise HTTPException(status_code=400, detail="Invalid process name")
    if not await asyncio.to_thread(PM2Service.process_exists, name):
        raise HTTPException(status_code=404, detail="Process not found")


@router.post("/control/{action}/{name}", dependencies=api_auth)
async def control_process(action: str, name: str):
    if action not in ["restart", "stop", "start", "delete"]:
        raise HTTPException(status_code=400, detail="Invalid action")
    await ensure_process(name)

    # 재시작은 기본으로 --update-env (환경 변수 변경을 반영). 넘기는 환경은 pm2_service.update_env 참고
    extra = ["--update-env"] if action == "restart" else []
    success = await asyncio.to_thread(PM2Service.run_command, action, name, extra)
    if not success:
        raise HTTPException(status_code=500, detail="Command failed")

    return {"status": "success"}


@router.post("/uv-sync/{name}", dependencies=api_auth)
async def uv_sync_process(name: str):
    """uv 로 구성된 pm2 앱의 작업 폴더에서 `uv sync`. 재시작은 하지 않는다."""
    _check_name(name)
    try:
        ok, output = await asyncio.to_thread(PM2Service.uv_sync, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"ok": ok, "output": output}


@router.post("/git-pull/{name}", dependencies=api_auth)
async def git_pull_process(name: str):
    """pm2 앱이 들어 있는 저장소에서 `git pull --ff-only`. 재시작은 하지 않는다."""
    _check_name(name)
    try:
        return await asyncio.to_thread(PM2Service.git_pull, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=error.args[0]) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/status", dependencies=api_auth)
async def get_pm2_status_api():
    return await asyncio.to_thread(PM2Service.get_process_summaries)


CPU_SENSORS = (
    "coretemp",
    "k10temp",
    "zenpower",
    "cpu_thermal",
    "cpu-thermal",
    "soc_thermal",
    "acpitz",
)


def _cpu_temperature() -> dict | None:
    """CPU 온도(°C). 패키지(소켓) 온도의 최댓값 + 가장 뜨거운 코어. 센서가 없으면 None."""
    try:
        sensors = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return None
    for name in CPU_SENSORS:
        readings = [
            r for r in sensors.get(name, []) if r.current and 0 < r.current < 150
        ]
        if not readings:
            continue
        packages = [
            r
            for r in readings
            if r.label.lower().startswith(("package", "tctl", "tdie"))
        ] or readings
        cores = [r for r in readings if r.label.lower().startswith("core")]
        top = max(packages, key=lambda r: r.current)
        high = top.high if top.high and top.high < 150 else None
        critical = top.critical if top.critical and top.critical < 150 else None
        return {
            "current": round(top.current, 1),
            "hottest_core": round(max(r.current for r in cores), 1) if cores else None,
            "high": high,
            "critical": critical,
            "sensor": name,
        }
    return None


@router.get("/server-stats", dependencies=api_auth)
async def get_server_stats():
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    du = psutil.disk_usage("/")
    net = psutil.net_io_counters()

    return {
        "cpu_percent": psutil.cpu_percent(),
        "cpu_cores": psutil.cpu_percent(percpu=True),
        "cpu_count_logical": psutil.cpu_count(),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "memory_total": vm.total,
        "memory_available": vm.available,
        "memory_used": vm.used,
        "memory_percent": vm.percent,
        "swap_total": sw.total,
        "swap_used": sw.used,
        "swap_percent": sw.percent,
        "disk_total": du.total,
        "disk_used": du.used,
        "disk_free": du.free,
        "disk_percent": du.percent,
        "net_bytes_sent": net.bytes_sent,
        "net_bytes_recv": net.bytes_recv,
        "cpu_temp": _cpu_temperature(),
    }


@router.get("/api/sysmon", dependencies=api_auth)
async def sysmon():
    """사이드바 서버 상태 (CPU · 메모리 · GPU · 디스크). 짧은 캐시가 있어 여러 화면이 자주 물어도 괜찮다."""
    return await sysmon_service.snapshot(_cpu_temperature)


@router.get("/api/ai-usage", dependencies=api_auth)
async def get_ai_usage(days: int = 7):
    return await asyncio.to_thread(AIUsageService.get_usage, days)


@router.websocket("/ws/logs/{name}")
async def process_logs_websocket(websocket: WebSocket, name: str):
    # Origin 검사는 SecurityMiddleware 가, 로그인 검사는 여기서 한다.
    if not AuthService.current_user(websocket):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    if name.startswith("-") or not await asyncio.to_thread(
        PM2Service.process_exists, name
    ):
        await websocket.send_text("Error: Process not found.")
        await websocket.close(code=1008)
        return

    process = await asyncio.create_subprocess_exec(
        "pm2",
        "logs",
        name,
        "--lines",
        "50",
        "--raw",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=ecosystem_service.child_env(),
    )

    loop = asyncio.get_running_loop()
    next_auth = loop.time() + 10
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            if loop.time() >= next_auth:
                if not AuthService.current_user(websocket):
                    await websocket.close(code=1008)
                    break
                next_auth = loop.time() + 10

            await websocket.send_text(line.decode().strip())

    except WebSocketDisconnect:
        if process.returncode is None:
            process.terminate()
    except Exception as e:
        logger.exception("프로세스 로그 스트리밍 오류 · process=%s · error=%s", name, e)
    finally:
        if process.returncode is None:
            process.terminate()
            await process.wait()


@router.post("/toggle-watch/{name}", dependencies=api_auth)
async def toggle_watch(name: str):
    if not name or name.startswith("-"):
        raise HTTPException(status_code=400, detail="Invalid process name")

    processes = await asyncio.to_thread(PM2Service.get_processes)
    target_proc = next((p for p in processes if p["name"] == name), None)

    if not target_proc:
        raise HTTPException(status_code=404, detail="Process not found")

    current_watch = target_proc.get("pm2_env", {}).get("watch", False)

    new_flag = ["--watch", "false"] if current_watch else ["--watch"]

    new_flag.append("--update-env")

    success = await asyncio.to_thread(PM2Service.run_command, "restart", name, new_flag)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to toggle watch mode")

    return {"status": "success", "watch": not current_watch}


@router.get("/startup-status", dependencies=api_auth)
async def get_startup_status():
    status = await asyncio.to_thread(PM2Service.get_startup_status)
    return {"is_registered": status}


@router.post("/restart-all", dependencies=api_auth)
async def restart_all():
    """모든 PM2 앱을 --update-env 로 재시작한다. 이 대시보드 자신은 응답을 보낸 뒤 마지막에 재시작한다."""
    processes = await asyncio.to_thread(PM2Service.get_process_summaries)
    me = PM2Service.self_pm_id()
    restarted, failed = [], []
    for proc in processes:
        if proc["pm_id"] == me:
            continue
        ok = await asyncio.to_thread(
            PM2Service.run_command, "restart", str(proc["pm_id"]), ["--update-env"]
        )
        (restarted if ok else failed).append(proc["name"])
    self_name = next((p["name"] for p in processes if p["pm_id"] == me), None)
    if self_name:
        PM2Service.restart_self_later(me)
    logger.info(
        "PM2 전체 재시작 · 성공 %d · 실패 %s · 자기 자신 %s",
        len(restarted),
        failed or "-",
        self_name or "-",
    )
    return {"restarted": restarted, "failed": failed, "self": self_name}


@router.post("/save", dependencies=api_auth)
async def save_pm2_list():
    success = await asyncio.to_thread(PM2Service.save_processes)
    if not success:
        raise HTTPException(status_code=500, detail="Save failed")
    return {"status": "success"}


# ── ecosystem.config.js ─────────────────────────────────────────────────────


class EcosystemAppRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    cwd: str = Field(min_length=1, max_length=1024)
    script: str = Field(min_length=1, max_length=500)
    interpreter: str = Field(default="", max_length=500)
    args: str = Field(default="", max_length=500)
    watch: bool = False
    time: bool = True
    env: str = Field(default="", max_length=20000)
    start: bool = True


def _ecosystem_error(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(
            status_code=404, detail=str(error.args[0] if error.args else error)
        ) from error
    if isinstance(error, ValueError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/api/ecosystem", dependencies=api_auth)
async def get_ecosystem():
    path = ecosystem_service.ecosystem_path()
    try:
        apps = await asyncio.to_thread(ecosystem_service.load_apps, path)
    except EcosystemError as error:
        return {
            "path": str(path),
            "exists": path.exists(),
            "error": str(error),
            "apps": [],
        }
    processes = await asyncio.to_thread(PM2Service.get_process_summaries)
    running = {proc["name"]: proc["pm2_env"]["status"] for proc in processes}
    me = PM2Service.self_pm_id()
    self_name = next((p["name"] for p in processes if p["pm_id"] == me), None)
    for app in apps:
        app["status"] = running.get(app.get("name"))
        app["self"] = me is not None and app.get("name") == self_name
    return {"path": str(path), "exists": path.exists(), "apps": apps}


@router.get("/api/ecosystem/inspect", dependencies=api_auth)
async def inspect_ecosystem_directory(cwd: str = Query(..., max_length=1024)):
    return await asyncio.to_thread(ecosystem_service.inspect_directory, cwd)


@router.post("/api/ecosystem/apps", dependencies=api_auth)
async def add_ecosystem_app(body: EcosystemAppRequest):
    try:
        result = await asyncio.to_thread(ecosystem_service.add_app, body.model_dump())
    except (ValueError, KeyError, EcosystemError, OSError) as error:
        _ecosystem_error(error)
    logger.info("ecosystem 앱 추가 · %s", body.name)
    result["started"] = None
    if body.start:
        try:
            ok, output = await asyncio.to_thread(ecosystem_service.start_app, body.name)
        except (ValueError, KeyError, EcosystemError) as error:
            ok, output = False, str(error)
        result.update(started=ok, output=output)
    return result


def _self_name() -> str | None:
    """이 대시보드의 pm2 프로세스 이름 (pm2 로 실행 중이 아니면 None)."""
    me = PM2Service.self_pm_id()
    if me is None:
        return None
    return next(
        (p["name"] for p in PM2Service.get_process_summaries() if p["pm_id"] == me),
        None,
    )


def _check_name(name: str) -> None:
    if not name or name.startswith("-") or len(name) > 200:
        raise HTTPException(status_code=400, detail="잘못된 앱 이름입니다.")


class EcosystemUpdateRequest(EcosystemAppRequest):
    start: bool = False
    apply: bool = True


@router.get("/api/ecosystem/apps/{name}", dependencies=api_auth)
async def get_ecosystem_app(name: str):
    _check_name(name)
    try:
        app = await asyncio.to_thread(ecosystem_service.get_app, name)
    except (KeyError, EcosystemError) as error:
        _ecosystem_error(error)
    app["self"] = name == await asyncio.to_thread(_self_name)
    return app


@router.put("/api/ecosystem/apps/{name}", dependencies=api_auth)
async def update_ecosystem_app(name: str, body: EcosystemUpdateRequest):
    """항목을 고친다. apply 면 돌고 있는 프로세스를 지우고 새 설정으로 다시 시작한다 (대시보드 자신은 제외)."""
    _check_name(name)
    self_name = await asyncio.to_thread(_self_name)
    if body.name != name and name == self_name:
        raise HTTPException(
            status_code=400,
            detail="이 대시보드 자신의 앱 이름은 여기서 바꿀 수 없습니다.",
        )
    try:
        result = await asyncio.to_thread(
            ecosystem_service.update_app, name, body.model_dump()
        )
    except (ValueError, KeyError, EcosystemError, OSError) as error:
        _ecosystem_error(error)
    logger.info("ecosystem 앱 수정 · %s → %s · %s", name, body.name, result["changed"])
    result["applied"] = None
    running = await asyncio.to_thread(PM2Service.process_exists, name)
    if body.apply and result["changed"] and running:
        if name == self_name:
            result["applied"] = "self"
        else:
            # script · cwd · 인터프리터 변경은 restart 로는 반영되지 않아 지우고 새로 시작한다
            await asyncio.to_thread(PM2Service.run_command, "delete", name)
            try:
                ok, output = await asyncio.to_thread(
                    ecosystem_service.start_app, body.name
                )
            except (ValueError, KeyError, EcosystemError) as error:
                ok, output = False, str(error)
            result.update(applied=ok, output=output)
    return result


@router.delete("/api/ecosystem/apps/{name}", dependencies=api_auth)
async def delete_ecosystem_app(name: str, pm2: bool = False):
    """ecosystem 에서 항목을 지운다. pm2 면 돌고 있는 프로세스도 지운다. 대시보드 자신은 지울 수 없다."""
    _check_name(name)
    if name == await asyncio.to_thread(_self_name):
        raise HTTPException(
            status_code=400, detail="이 대시보드 자신은 여기서 지울 수 없습니다."
        )
    try:
        result = await asyncio.to_thread(ecosystem_service.delete_app, name)
    except (ValueError, KeyError, EcosystemError, OSError) as error:
        _ecosystem_error(error)
    logger.info("ecosystem 앱 삭제 · %s · pm2 삭제 %s", name, pm2)
    result["pm2_deleted"] = None
    if pm2 and await asyncio.to_thread(PM2Service.process_exists, name):
        result["pm2_deleted"] = await asyncio.to_thread(
            PM2Service.run_command, "delete", name
        )
    return result


@router.post("/api/ecosystem/apps/{name}/start", dependencies=api_auth)
async def start_ecosystem_app(name: str):
    try:
        ok, output = await asyncio.to_thread(ecosystem_service.start_app, name)
    except (ValueError, KeyError, EcosystemError) as error:
        _ecosystem_error(error)
    if not ok:
        raise HTTPException(
            status_code=500, detail=output or "pm2 start 가 실패했습니다."
        )
    return {"started": True, "output": output}
