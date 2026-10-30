import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from dotenv import dotenv_values

from app.services.ecosystem_service import child_env
from app.services.git_service import GitService

logger = logging.getLogger(__name__)

COMMAND_TIMEOUT_SECONDS = 60
PROJECT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
# pm2 가 관리 중인 앱(이 대시보드 자신)에 넣어 주는 변수들 — 다른 앱에 옮기면 안 된다
PM2_APP_KEYS = {
    "pm_id",
    "name",
    "NODE_APP_INSTANCE",
    "unique_id",
    "instance_var",
    "pm_cwd",
    "pm_exec_path",
    "pm_out_log_path",
    "pm_err_log_path",
    "pm_pid_path",
    "pm_uptime",
    "vizion",
    "vizion_running",
    "node_args",
    "km_link",
    "axm_actions",
    "axm_monitor",
    "axm_options",
    "axm_dynamic",
    "PM2_JSON_PROCESSING",
    "status",
    "restart_time",
    "exec_interpreter",
    "exec_mode",
    "watch",
    "ignore_watch",
    "autorestart",
    "namespace",
    "version",
    "created_at",
    "unstable_restarts",
}


def update_env() -> dict[str, str]:
    """`pm2 restart --update-env` 에 넘길 환경.

    --update-env 는 pm2 명령을 실행한 쪽의 환경 변수를 앱에 덮어쓴다. 이 대시보드의 환경을 그대로
    넘기면 UnivDash .env 의 PORT · HOST · ADMIN_PASS · SECRET_KEY 등이 다른 앱에 들어가 포트 충돌과
    비밀값 유출이 생긴다. 그래서 pm2 데몬이 시작될 때의 환경(보통 systemd)을 쓰고,
    그것을 못 읽으면 현재 환경에서 이 대시보드 전용 값을 뺀다.
    """
    home = Path(os.getenv("PM2_HOME") or Path.home() / ".pm2")
    try:
        pid = int((home / "pm2.pid").read_text().strip())
        raw = Path(f"/proc/{pid}/environ").read_bytes().decode("utf-8", "replace")
        env = dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)
        if env.get("PATH"):
            env.setdefault("PM2_HOME", str(home))
            for key in (
                "NODE_CHANNEL_FD",
                "NODE_CHANNEL_SERIALIZATION_MODE",
                "NODE_UNIQUE_ID",
            ):
                env.pop(key, None)
            return env
    except (OSError, ValueError):
        pass
    env = child_env()
    project = {
        k
        for k, v in dotenv_values(PROJECT_ENV_FILE).items()
        if v is not None and env.get(k) == v
    }
    return {k: v for k, v in env.items() if k not in project and k not in PM2_APP_KEYS}


UV_SYNC_TIMEOUT_SECONDS = 600
_uv_sync_running: set[str] = set()
_uv_sync_lock = threading.Lock()


def _uv_project(cwd: str | None) -> Path | None:
    """uv 프로젝트 폴더 (pyproject.toml + uv.lock). 작업 폴더부터 위로 찾는다 (uv 워크스페이스 루트).

    git 저장소 루트나 홈 폴더 밖으로는 올라가지 않는다.
    """
    if not cwd:
        return None
    path = Path(cwd)
    for folder in (path, *path.parents):
        if (folder / "pyproject.toml").is_file() and (folder / "uv.lock").is_file():
            return folder
        if (folder / ".git").exists() or folder == Path.home():
            return None
    return None


def _git_root(cwd: str | None) -> Path | None:
    """앱 작업 폴더가 들어 있는 git 저장소 폴더 (.git 이 있는 가장 가까운 상위)."""
    if not cwd:
        return None
    path = Path(cwd)
    for folder in (path, *path.parents):
        if (folder / ".git").exists():
            return folder
    return None


def _app_cwd(name: str) -> str | None:
    proc = next((p for p in PM2Service.get_processes() if p.get("name") == name), None)
    if proc is None:
        raise KeyError("프로세스를 찾을 수 없습니다.")
    return (proc.get("pm2_env") or {}).get("pm_cwd")


def _uv_binary() -> str | None:
    # pm2 로 뜬 서버는 PATH 에 ~/.local/bin 이 없을 수 있다
    found = shutil.which("uv")
    if found:
        return found
    for candidate in (Path.home() / ".local/bin/uv", Path.home() / ".cargo/bin/uv"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


class PM2Service:
    @staticmethod
    def _run(
        *args: str, timeout: int = COMMAND_TIMEOUT_SECONDS
    ) -> subprocess.CompletedProcess[str] | None:
        """셸을 거치지 않고 인자 목록으로 pm2 를 실행한다 (명령 주입 방지)."""
        pm2_path = shutil.which("pm2")
        if not pm2_path:
            logger.debug("PM2 실행 파일을 찾지 못했습니다.")
            return None
        return subprocess.run(
            [pm2_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            # pm2 IPC 변수를 빼야 pm2 로 실행 중일 때도 CLI 가 정상 종료된다
            env=update_env() if "--update-env" in args else child_env(),
        )

    @staticmethod
    def get_processes():
        try:
            result = PM2Service._run("jlist")
            if result is None:
                return []
            result.check_returncode()
            return json.loads(result.stdout)
        except Exception as e:
            logger.exception("PM2 프로세스 목록을 불러오지 못했습니다: %s", e)
            return []

    @staticmethod
    def get_process_summaries():
        """브라우저로 보낼 최소 필드만 남긴다. pm2_env 에는 프로세스 환경 변수(비밀 값)가 들어 있다."""
        summaries = []
        for proc in PM2Service.get_processes():
            env = proc.get("pm2_env") or {}
            monit = proc.get("monit") or {}
            summaries.append(
                {
                    "name": proc.get("name"),
                    "pm_id": proc.get("pm_id"),
                    "monit": {
                        "cpu": monit.get("cpu", 0),
                        "memory": monit.get("memory", 0),
                    },
                    "uv": _uv_project(env.get("pm_cwd")) is not None,
                    "git": _git_root(env.get("pm_cwd")) is not None,
                    "pm2_env": {
                        "status": env.get("status"),
                        "pm_uptime": env.get("pm_uptime"),
                        "watch": bool(env.get("watch")),
                    },
                }
            )
        return summaries

    @staticmethod
    def process_exists(name: str) -> bool:
        return any(proc.get("name") == name for proc in PM2Service.get_processes())

    @staticmethod
    def run_command(action: str, name: str, extra_args: list = None):
        args = [action, name, *(extra_args or [])]
        try:
            result = PM2Service._run(*args)
            if result is None:
                logger.warning("PM2 명령을 실행할 수 없습니다: 실행 파일 없음")
                return False

            if result.returncode != 0:
                logger.error(
                    "PM2 명령 실패 · command=pm2 %s · error=%s",
                    " ".join(args),
                    result.stderr.strip() or "unknown error",
                )
                return False

            return True
        except Exception as e:
            logger.exception("PM2 명령 실행 중 오류가 발생했습니다: %s", e)
            return False

    @staticmethod
    def self_pm_id() -> int | None:
        """이 대시보드가 pm2 로 실행 중이면 자기 pm_id (pm2 가 환경 변수로 넣어 준다)."""
        value = os.getenv("pm_id", "")
        return int(value) if value.isdigit() else None

    @staticmethod
    def restart_self_later(pm_id: int, delay: float = 0.8) -> None:
        """응답을 보낸 뒤 자기 자신을 재시작한다. pm2 데몬이 명령을 받으면 이 프로세스가 죽어도 재시작은 진행된다."""

        def run() -> None:
            time.sleep(delay)
            PM2Service.run_command("restart", str(pm_id), ["--update-env"])

        threading.Thread(target=run, daemon=True).start()

    @staticmethod
    def uv_sync(name: str) -> tuple[bool, str]:
        """pm2 앱의 작업 폴더에서 `uv sync` 를 실행한다. 반환: (성공 여부, 출력)."""
        project = _uv_project(_app_cwd(name))
        if project is None:
            raise ValueError("uv 프로젝트(pyproject.toml + uv.lock)가 아닙니다.")
        uv = _uv_binary()
        if not uv:
            raise RuntimeError("uv 를 찾을 수 없습니다.")
        key = str(project)
        with _uv_sync_lock:
            if key in _uv_sync_running:
                raise RuntimeError("이미 uv sync 가 실행 중입니다.")
            _uv_sync_running.add(key)
        # 이 대시보드의 비밀값 · 가상환경이 섞이지 않게 pm2 데몬 환경을 쓴다
        env = update_env()
        for k in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PYTHONPATH", "PYTHONHOME"):
            env.pop(k, None)
        env["NO_COLOR"] = "1"
        try:
            result = subprocess.run(
                [uv, "sync"],
                check=False,
                cwd=project,
                capture_output=True,
                text=True,
                timeout=UV_SYNC_TIMEOUT_SECONDS,
                env=env,
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            return False, f"{UV_SYNC_TIMEOUT_SECONDS}초 안에 끝나지 않았습니다."
        except OSError as error:
            return False, str(error)
        finally:
            with _uv_sync_lock:
                _uv_sync_running.discard(key)
        output = (result.stdout + result.stderr).strip()
        logger.info("uv sync · %s · 종료 코드 %s", name, result.returncode)
        return result.returncode == 0, f"$ cd {project} && uv sync\n{output}"[-20000:]

    @staticmethod
    def git_pull(name: str) -> dict:
        """pm2 앱이 들어 있는 저장소에서 `git pull --ff-only`. 서버에서 머지 커밋은 만들지 않는다.

        Git 페이지와 같은 저장소 잠금을 써서 두 곳에서 동시에 Git 작업이 돌지 않게 한다.
        """
        cwd = _app_cwd(name)
        if _git_root(cwd) is None:
            raise ValueError("git 저장소가 아닙니다.")
        top = GitService._run(Path(cwd), "rev-parse", "--show-toplevel", timeout=10)
        if top.returncode != 0:
            raise ValueError("git 저장소가 아닙니다.")
        repo = Path(top.stdout.strip()).resolve()
        repo_id = hashlib.sha256(str(repo).encode("utf-8")).hexdigest()[:16]
        lock = GitService._lock_for(repo_id)
        if not lock.acquire(blocking=False):
            raise RuntimeError("이 저장소에서 다른 Git 작업이 실행 중입니다.")
        try:
            before = GitService._text(repo, "rev-parse", "HEAD")
            branch = GitService._text(repo, "branch", "--show-current")
            try:
                result = GitService._run(repo, "pull", "--ff-only")
            except subprocess.TimeoutExpired:
                return {
                    "ok": False,
                    "output": "시간 안에 끝나지 않아 중단했습니다.",
                    "changed": [],
                }
            after = GitService._text(repo, "rev-parse", "HEAD")
            changed = []
            if result.returncode == 0 and before and after and before != after:
                diff = GitService._text(
                    repo, "diff", "--name-only", "-z", before, after
                )
                changed = [f for f in diff.split("\0") if f]
        finally:
            lock.release()
        output = "\n".join(
            part for part in (result.stdout.strip(), result.stderr.strip()) if part
        )
        logger.info("git pull · %s · %s · 종료 코드 %s", name, repo, result.returncode)
        project = _uv_project(cwd)
        deps = set()
        if project is not None:
            rel = project.resolve().relative_to(repo)
            deps = {
                f if str(rel) == "." else str(rel / f)
                for f in ("uv.lock", "pyproject.toml")
            }
        return {
            "ok": result.returncode == 0,
            "repo": str(repo),
            "branch": branch,
            "updated": before != after,
            "changed": changed[:500],
            # 워크스페이스 멤버의 pyproject.toml 이 바뀌어도 uv.lock 이 같이 바뀐다
            "deps_changed": bool(deps & set(changed)),
            "output": GitService._mask(output)[-20000:] or "(출력 없음)",
        }

    @staticmethod
    def save_processes():
        try:
            result = PM2Service._run("save")
            if result is None:
                logger.warning("PM2 프로세스를 저장할 수 없습니다: 실행 파일 없음")
                return False
            result.check_returncode()
            logger.info("PM2 프로세스 목록을 저장했습니다.")
            return True
        except (subprocess.SubprocessError, OSError) as error:
            logger.exception("PM2 프로세스 저장에 실패했습니다: %s", error)
            return False

    @staticmethod
    def get_startup_status():
        """PM2가 OS 재부팅 시 자동 실행되도록 설정되어 있는지 확인합니다."""
        try:
            result = PM2Service._run("startup")
            if result is None:
                return False
            return (
                "already configured" in result.stdout.lower()
                or "sudo" in result.stdout.lower()
            )
        except (subprocess.SubprocessError, OSError) as error:
            logger.debug("PM2 시작 프로그램 상태 확인 실패: %s", error)
            return False
