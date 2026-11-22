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

from app.i18n import _
from app.services.git.git_service import GitService
from app.services.server.ecosystem_service import child_env

logger = logging.getLogger(__name__)

COMMAND_TIMEOUT_SECONDS = 60
PROJECT_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"
# Variables pm2 injects into the app it manages (this dashboard itself) — they must not be carried over to other apps
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
    """The environment to pass to `pm2 restart --update-env`.

    --update-env overwrites the app's environment with that of whoever ran the pm2 command. Passing this
    dashboard's environment as is would put PORT · HOST · ADMIN_PASS · SECRET_KEY etc. from the UnivDash
    .env into other apps, causing port clashes and leaked secrets. So the environment the pm2 daemon
    started with (usually systemd) is used, and if that cannot be read, the dashboard-only values are
    removed from the current environment.
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
    """The uv project folder (pyproject.toml + uv.lock). Searched upwards from the working folder (uv workspace root).

    Never climbs past the git repository root or the home folder.
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
    """The git repository folder that contains the app's working folder (the nearest parent with .git)."""
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
        raise KeyError(_("프로세스를 찾을 수 없습니다."))
    return (proc.get("pm2_env") or {}).get("pm_cwd")


def _uv_binary() -> str | None:
    # A server started by pm2 may not have ~/.local/bin on its PATH
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
        """Runs pm2 with an argument list, without a shell (prevents command injection)."""
        pm2_path = shutil.which("pm2")
        if not pm2_path:
            logger.debug("PM2 executable not found.")
            return None
        return subprocess.run(
            [pm2_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            # The pm2 IPC variables must be removed for the CLI to exit cleanly when running under pm2
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
            logger.exception("Could not load the PM2 process list: %s", e)
            return []

    @staticmethod
    def get_process_summaries():
        """Keeps only the minimal fields to send to the browser. pm2_env holds the process environment (secrets)."""
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
                logger.warning("Cannot run the PM2 command: executable not found")
                return False

            if result.returncode != 0:
                logger.error(
                    "PM2 command failed · command=pm2 %s · error=%s",
                    " ".join(args),
                    result.stderr.strip() or "unknown error",
                )
                return False

            return True
        except Exception as e:
            logger.exception("Error while running the PM2 command: %s", e)
            return False

    @staticmethod
    def self_pm_id() -> int | None:
        """This dashboard's own pm_id when it runs under pm2 (pm2 sets it as an environment variable)."""
        value = os.getenv("pm_id", "")
        return int(value) if value.isdigit() else None

    @staticmethod
    def restart_self_later(pm_id: int, delay: float = 0.8) -> None:
        """Restarts itself after the response is sent. Once the pm2 daemon has the command, the restart proceeds even if this process dies."""

        def run() -> None:
            time.sleep(delay)
            PM2Service.run_command("restart", str(pm_id), ["--update-env"])

        threading.Thread(target=run, daemon=True).start()

    @staticmethod
    def uv_sync(name: str) -> tuple[bool, str]:
        """Runs `uv sync` in the pm2 app's working folder. Returns: (success, output)."""
        project = _uv_project(_app_cwd(name))
        if project is None:
            raise ValueError(_("uv 프로젝트(pyproject.toml + uv.lock)가 아닙니다."))
        uv = _uv_binary()
        if not uv:
            raise RuntimeError(_("uv 를 찾을 수 없습니다."))
        key = str(project)
        with _uv_sync_lock:
            if key in _uv_sync_running:
                raise RuntimeError(_("이미 uv sync 가 실행 중입니다."))
            _uv_sync_running.add(key)
        # Uses the pm2 daemon's environment so this dashboard's secrets · virtualenv do not leak in
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
            return False, _(
                "{seconds}초 안에 끝나지 않았습니다.", seconds=UV_SYNC_TIMEOUT_SECONDS
            )
        except OSError as error:
            return False, str(error)
        finally:
            with _uv_sync_lock:
                _uv_sync_running.discard(key)
        output = (result.stdout + result.stderr).strip()
        logger.info("uv sync · %s · exit code %s", name, result.returncode)
        return result.returncode == 0, f"$ cd {project} && uv sync\n{output}"[-20000:]

    @staticmethod
    def git_pull(name: str) -> dict:
        """`git pull --ff-only` in the repository that contains the pm2 app. No merge commits are made on the server.

        Uses the same repository lock as the Git page so Git jobs never run in both places at once.
        """
        cwd = _app_cwd(name)
        if _git_root(cwd) is None:
            raise ValueError(_("git 저장소가 아닙니다."))
        top = GitService._run(Path(cwd), "rev-parse", "--show-toplevel", timeout=10)
        if top.returncode != 0:
            raise ValueError(_("git 저장소가 아닙니다."))
        repo = Path(top.stdout.strip()).resolve()
        repo_id = hashlib.sha256(str(repo).encode("utf-8")).hexdigest()[:16]
        lock = GitService._lock_for(repo_id)
        if not lock.acquire(blocking=False):
            raise RuntimeError(_("이 저장소에서 다른 Git 작업이 실행 중입니다."))
        try:
            before = GitService._text(repo, "rev-parse", "HEAD")
            branch = GitService._text(repo, "branch", "--show-current")
            try:
                result = GitService._run(repo, "pull", "--ff-only")
            except subprocess.TimeoutExpired:
                return {
                    "ok": False,
                    "output": _("시간 안에 끝나지 않아 중단했습니다."),
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
        logger.info("git pull · %s · %s · exit code %s", name, repo, result.returncode)
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
            # A change to a workspace member's pyproject.toml changes uv.lock along with it
            "deps_changed": bool(deps & set(changed)),
            "output": GitService._mask(output)[-20000:] or _("(출력 없음)"),
        }

    @staticmethod
    def save_processes():
        try:
            result = PM2Service._run("save")
            if result is None:
                logger.warning("Cannot save the PM2 processes: executable not found")
                return False
            result.check_returncode()
            logger.info("Saved the PM2 process list.")
            return True
        except (subprocess.SubprocessError, OSError) as error:
            logger.exception("Failed to save the PM2 processes: %s", error)
            return False

    @staticmethod
    def get_startup_status():
        """Checks whether PM2 is set up to start automatically when the OS reboots."""
        try:
            result = PM2Service._run("startup")
            if result is None:
                return False
            return (
                "already configured" in result.stdout.lower()
                or "sudo" in result.stdout.lower()
            )
        except (subprocess.SubprocessError, OSError) as error:
            logger.debug("PM2 startup status check failed: %s", error)
            return False
