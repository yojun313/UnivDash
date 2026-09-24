import json
import logging
import shutil
import subprocess

from app.services.ecosystem_service import child_env

logger = logging.getLogger(__name__)

COMMAND_TIMEOUT_SECONDS = 60


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
            env=child_env(),  # pm2 IPC 변수를 빼야 pm2 로 실행 중일 때도 CLI 가 정상 종료된다
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
