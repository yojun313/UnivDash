"""Runs the Git auto flow (ruff format → AI commit message → commit · push) to the end, independent of the browser.

- Pressing the button starts a separate process (`python -m app.services.git.git_workflow <id>`) and returns at once.
  It runs to the end even if you leave the page, click another repository, or the dashboard restarts (when ruff
  changes UnivDash files, pm2 watch restarts it). That is why it is started as a process that is not a child of
  the server rather than a server thread (pm2 also ends child processes when it restarts).
- Progress is written step by step to git-workflows/<id>.json (mode 600) in the data folder. The screen reads it
  to show progress and notifies when it finishes.
- The job remembers the interface language of the request that started it, so the worker process writes its
  messages in that language.
"""

import json
import os
import secrets
import shlex
import subprocess
import sys
import time
from pathlib import Path

from app import i18n
from app.i18n import N_, _
from app.paths import data_dir

KEEP_SECONDS = 24 * 3600
MAX_JOBS = 40
PROJECT_ROOT = Path(__file__).resolve().parents[3]
STEPS = {
    "ruff": N_("ruff format 실행 중"),
    "ai": N_("AI 커밋 메시지 생성 중"),
    "push": N_("커밋하고 푸시 중"),
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
        raise ValueError(_("잘못된 작업 id 입니다."))
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
    try:  # a zombie that ended but was not reaped counts as dead
        with open(f"/proc/{int(pid)}/stat", encoding="utf-8") as handle:
            return handle.read().split(") ", 1)[1][:1] != "Z"
    except (OSError, IndexError):
        return True


def jobs() -> list[dict]:
    """Recent jobs (newest first). A 'running' job whose process is gone is marked as stopped."""
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
                status="error",
                error=_("작업 프로세스가 중간에 끝났습니다."),
                finished=now,
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
    from app.services.git.ai_commit_service import public_settings
    from app.services.git.git_service import GitService

    repository = GitService._get_repository(repository_id)  # KeyError when missing
    if not public_settings()["configured"]:
        raise ValueError(_("먼저 AI 커밋 메시지 설정을 해 주십시오."))
    if running_for(repository.id):
        raise ValueError(_("이 저장소에서 자동 커밋 흐름이 이미 실행 중입니다."))
    job = {
        "id": secrets.token_hex(8),
        "repository_id": repository.id,
        "repository": repository.name,
        "branch": "",
        "status": "running",
        "step": "ruff",
        "step_label": _(STEPS["ruff"]),
        "lang": i18n.current(),
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
    # sh starts it in the background and exits at once, so the worker's parent becomes init → it survives a dashboard restart
    command = " ".join(
        shlex.quote(part)
        for part in (sys.executable, "-m", "app.services.git.git_workflow", job["id"])
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


# ── Worker process ───────────────────────────────────────────────────────────


def _run(job_id: str) -> None:
    from app.services.git import ai_commit_service
    from app.services.git.git_service import GitService

    path = _path(job_id)
    job = _read(path)
    if not job or job.get("status") != "running":
        return
    job["pid"] = os.getpid()
    _write(job)
    # this process has no request: use the language of the request that started the job
    i18n.set_default(job.get("lang"))

    def step(name: str) -> None:
        job.update(step=name, step_label=_(STEPS[name]))
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
        except Exception:  # noqa: BLE001 — the branch name is for display only
            job["branch"] = ""
        step("ruff")
        formatted = GitService.ruff_format(repository_id)
        lines = (formatted.get("output") or "").splitlines()
        job["ruff"] = formatted.get("summary") or (lines[-1] if lines else "")
        if not formatted.get("success"):
            return fail(_("ruff format 이 실패했습니다."), formatted.get("output", ""))

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
            return fail(
                _("커밋 또는 푸시가 실패했습니다."), committed.get("output", "")
            )
        job.update(
            status="done", step="done", step_label=_("완료"), finished=time.time()
        )
        _write(job)
    except Exception as error:  # noqa: BLE001 — any failure is recorded in the status file
        fail(str(error) or type(error).__name__)


if __name__ == "__main__":
    _run(sys.argv[1] if len(sys.argv) > 1 else "")
