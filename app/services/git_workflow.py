"""Git 자동 흐름 (ruff format → AI 커밋 메시지 → 커밋 · 푸시) 을 브라우저와 상관없이 끝까지 돌린다.

- 버튼을 누르면 별도 프로세스(`python -m app.services.git_workflow <id>`)를 띄우고 바로 돌아온다.
  페이지를 떠나거나 다른 저장소를 눌러도, 대시보드가 다시 시작돼도(ruff 가 UnivDash 파일을 고치면 pm2 watch 가 재시작한다)
  끝까지 돈다. 그래서 서버 스레드가 아니라 서버의 자식이 아닌 프로세스로 띄운다 (pm2 는 재시작할 때 자식 프로세스까지 끝낸다).
- 진행 상황은 데이터 폴더의 git-workflows/<id>.json (권한 600) 에 단계별로 적는다. 화면은 이것을 읽어 보여 주고, 끝나면 알린다.
"""

import json
import os
import secrets
import shlex
import subprocess
import sys
import time
from pathlib import Path

from app.paths import data_dir

KEEP_SECONDS = 24 * 3600
MAX_JOBS = 40
PROJECT_ROOT = Path(__file__).resolve().parents[2]
STEPS = {
    "ruff": "ruff format 실행 중",
    "ai": "AI 커밋 메시지 생성 중",
    "push": "커밋하고 푸시 중",
}


def _dir() -> Path:
    path = data_dir() / "git-workflows"
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _path(job_id: str) -> Path:
    if (
        not job_id
        or not all(c in "0123456789abcdef" for c in job_id)
        or len(job_id) != 16
    ):
        raise ValueError("잘못된 작업 id 입니다.")
    return _dir() / f"{job_id}.json"


def _write(job: dict) -> None:
    target = _path(job["id"])
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(job, handle, ensure_ascii=False)
    os.replace(tmp, target)


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, TypeError, ValueError):
        return False
    try:  # 끝났지만 거둬지지 않은 좀비는 죽은 것으로 본다
        with open(f"/proc/{int(pid)}/stat", encoding="utf-8") as handle:
            return handle.read().split(") ", 1)[1][:1] != "Z"
    except (OSError, IndexError):
        return True


def jobs() -> list[dict]:
    """최근 작업 (새것 먼저). 프로세스가 사라진 '실행 중' 작업은 중단으로 정리한다."""
    now = time.time()
    found = []
    for path in _dir().glob("*.json"):
        job = _read(path)
        if not job:
            continue
        if now - (job.get("finished") or job.get("started") or 0) > KEEP_SECONDS:
            path.unlink(missing_ok=True)
            continue
        if (
            job.get("status") == "running"
            and now - job.get("started", now) > 15
            and not _alive(job.get("pid"))
        ):
            job.update(
                status="error", error="작업 프로세스가 중간에 끝났어요.", finished=now
            )
            _write(job)
        found.append(job)
    found.sort(key=lambda j: j.get("started") or 0, reverse=True)
    for stale in found[MAX_JOBS:]:
        _path(stale["id"]).unlink(missing_ok=True)
    return found[:MAX_JOBS]


def running_for(repository_id: str) -> dict | None:
    return next(
        (
            j
            for j in jobs()
            if j.get("repository_id") == repository_id and j.get("status") == "running"
        ),
        None,
    )


def start(repository_id: str) -> dict:
    from app.services.ai_commit_service import public_settings
    from app.services.git_service import GitService

    repository = GitService._get_repository(repository_id)  # 없으면 KeyError
    if not public_settings()["configured"]:
        raise ValueError("먼저 AI 커밋 메시지 설정을 해 주세요.")
    if running_for(repository.id):
        raise ValueError("이 저장소에서 자동 커밋 흐름이 이미 실행 중이에요.")
    job = {
        "id": secrets.token_hex(8),
        "repository_id": repository.id,
        "repository": repository.name,
        "branch": "",
        "status": "running",
        "step": "ruff",
        "step_label": STEPS["ruff"],
        "started": time.time(),
        "finished": None,
        "ruff": "",
        "message": "",
        "output": "",
        "error": "",
        "pid": None,
    }
    _write(job)
    log = _dir() / f"{job['id']}.log"
    # sh 가 백그라운드로 띄우고 바로 끝나므로 작업 프로세스의 부모는 init 이 된다 → 대시보드가 재시작돼도 살아 있다
    command = " ".join(
        shlex.quote(part)
        for part in (sys.executable, "-m", "app.services.git_workflow", job["id"])
    )
    subprocess.run(
        [
            "/bin/sh",
            "-c",
            f"nohup {command} >{shlex.quote(str(log))} 2>&1 </dev/null &",
        ],
        cwd=str(PROJECT_ROOT),
        env=os.environ.copy(),
        check=False,
        start_new_session=True,
        timeout=10,
    )
    return job


# ── 작업 프로세스 ────────────────────────────────────────────────────────────


def _run(job_id: str) -> None:
    from app.services import ai_commit_service
    from app.services.git_service import GitService

    path = _path(job_id)
    job = _read(path)
    if not job or job.get("status") != "running":
        return
    job["pid"] = os.getpid()
    _write(job)

    def step(name: str) -> None:
        job.update(step=name, step_label=STEPS[name])
        _write(job)

    def fail(message: str, output: str = "") -> None:
        job.update(
            status="error", error=message, output=output[-4000:], finished=time.time()
        )
        _write(job)

    repository_id = job["repository_id"]
    try:
        try:
            path = GitService._get_repository(repository_id).path
            job["branch"] = (
                GitService._run(path, "rev-parse", "--abbrev-ref", "HEAD").stdout or ""
            ).strip()
        except Exception:  # noqa: BLE001 — 브랜치 이름은 표시용
            job["branch"] = ""
        step("ruff")
        formatted = GitService.ruff_format(repository_id)
        lines = (formatted.get("output") or "").splitlines()
        job["ruff"] = formatted.get("summary") or (lines[-1] if lines else "")
        if not formatted.get("success"):
            return fail("ruff format 이 실패했어요.", formatted.get("output", ""))

        step("ai")
        generated = ai_commit_service.generate(repository_id, True)
        job["message"] = generated["message"]
        _write(job)

        step("push")
        committed = GitService.run_action(
            repository_id,
            "commit",
            {
                "message": generated["message"],
                "amend": False,
                "stage_all": True,
                "push_after": True,
                "force": False,
            },
        )
        job["output"] = (committed.get("output") or "")[-4000:]
        if not committed.get("success"):
            return fail("커밋 또는 푸시가 실패했어요.", committed.get("output", ""))
        job.update(status="done", step="done", step_label="완료", finished=time.time())
        _write(job)
    except Exception as error:  # noqa: BLE001 — 어떤 실패든 상태 파일에 남긴다
        fail(str(error) or type(error).__name__)


if __name__ == "__main__":
    _run(sys.argv[1] if len(sys.argv) > 1 else "")
