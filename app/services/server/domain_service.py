"""Domains page: reading the nginx domain list, display folders, calling the root helper.

The config files are world-readable, so the list is read directly.
Every change goes through the root helper (nginx_helper.py); no other sudo command is run here.
"""

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

from app.i18n import N_, _
from app.paths import data_dir
from app.services.server import nginx_helper

HELPER_PATH = Path("/usr/local/sbin/univdash-nginx")
SUDO = "/usr/bin/sudo"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
INSTALL_COMMAND = f"sudo bash {PROJECT_ROOT}/tools/install_nginx_helper.sh"
MAX_FOLDER_NAME = 40
PATH_TIMEOUT = 90

_folders_lock = threading.Lock()
_verified_hash: str | None = None


def _source_hash() -> str:
    return hashlib.sha256(Path(nginx_helper.__file__).read_bytes()).hexdigest()


def helper_status() -> dict:
    """Whether the helper can be used. Not used if it differs from the repository's helper (so an old helper never runs)."""
    global _verified_hash
    base = {"command": INSTALL_COMMAND}
    try:
        info = HELPER_PATH.stat()
        installed = hashlib.sha256(HELPER_PATH.read_bytes()).hexdigest()
    except OSError:
        return {**base, "ready": False, "reason": "not_installed"}
    if info.st_uid != 0 or info.st_mode & 0o022 or installed != _source_hash():
        return {**base, "ready": False, "reason": "outdated"}
    if _verified_hash != installed:
        try:
            result = subprocess.run(
                [SUDO, "-n", str(HELPER_PATH), "check"],
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return {**base, "ready": False, "reason": "not_installed"}
        if result.returncode != 0:
            return {**base, "ready": False, "reason": "not_installed"}
        _verified_hash = installed
    return {**base, "ready": True, "reason": ""}


def helper_command(*args: str) -> list[str]:
    return [SUDO, "-n", str(HELPER_PATH), *args]


def clean_passphrase(value) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 1024:
        raise ValueError(_("변경 비밀번호를 입력해 주십시오."))
    if any(ord(character) < 32 for character in value):
        raise ValueError(_("변경 비밀번호에 쓸 수 없는 글자가 있습니다."))
    return value


def _run_helper(
    *args: str, passphrase: str, new_passphrase: str | None = None
) -> tuple[int, str]:
    if not helper_status()["ready"]:
        raise ValueError(_("도메인을 바꾸려면 먼저 Nginx 헬퍼를 설치해 주십시오."))
    lines = [clean_passphrase(passphrase)]
    if new_passphrase is not None:
        lines.append(clean_passphrase(new_passphrase))
    try:
        result = subprocess.run(
            helper_command(*args),
            input="".join(f"{line}\n" for line in lines),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PATH_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError(_("시간 안에 끝나지 않았습니다.")) from error
    return result.returncode, (result.stdout + result.stderr).strip()


# The helper is a stand-alone root script and always answers in Korean. Its fixed failure messages are
# listed here so the catalog can translate them when they are shown as an error in the UI.
HELPER_MESSAGES = (
    N_("유효하지 않은 도메인입니다."),
    N_("유효하지 않은 포트입니다."),
    N_("유효하지 않은 이메일입니다."),
    N_("유효하지 않은 경로입니다."),
    N_("이미 존재하는 경로입니다."),
    N_("설정 파일 형식을 인식할 수 없습니다."),
    N_("해당 경로를 찾을 수 없습니다."),
    N_("포트 설정을 찾을 수 없습니다."),
    N_("마지막 경로입니다. 도메인 전체 삭제가 필요합니다."),
    N_("옮길 수 있는 경로(proxy_pass)를 찾지 못했습니다."),
    N_("해당 도메인이 존재하지 않습니다."),
    N_("설정 파일이 일반 파일이 아니거나 소유자가 달라 건드리지 않습니다."),
    N_("이미 존재하는 도메인입니다."),
    N_("기존 도메인과 새 도메인이 같습니다."),
    N_("두 번 입력한 값이 서로 다릅니다."),
    N_("새 변경 비밀번호가 너무 깁니다."),
    N_("새 변경 비밀번호에 쓸 수 없는 글자가 있습니다."),
    N_("새 변경 비밀번호를 입력해 주십시오."),
    N_("변경 비밀번호 파일의 권한이 안전하지 않습니다."),
    N_("변경 비밀번호가 설정되어 있지 않습니다. 설치 스크립트를 다시 실행해 주십시오."),
    N_("변경 비밀번호를 여러 번 틀려 잠겼습니다. 15분 뒤 다시 해 주십시오."),
    N_("변경 비밀번호가 틀렸습니다."),
    N_("지원하지 않는 명령입니다."),
    N_("다른 도메인 작업이 진행 중입니다. 잠시 뒤 다시 해 주십시오."),
)


def _helper_message(output: str) -> str:
    lines = [line for line in output.splitlines() if line.strip()]
    failed = [line for line in lines if line.startswith("실패: ")]
    if failed:
        return _(failed[-1].removeprefix("실패: "))
    return lines[-1] if lines else _("작업에 실패했습니다.")


def _require_domain(domain: str) -> str:
    if not nginx_helper.is_valid_domain(domain):
        raise ValueError(_("유효하지 않은 도메인입니다."))
    return domain


# ── List ──────────────────────────────────────────────────────────────
def _primary_port(paths: list[dict]) -> int | None:
    root = next((item for item in paths if item["path"] == "/"), None)
    ports = []
    for item in [root] if root else paths:
        try:
            ports.append(int(item["port"]))
        except (TypeError, ValueError):
            continue
    return min(ports) if ports else None


def _read_site(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def get_domains() -> list[dict]:
    domains = []
    try:
        names = os.listdir(nginx_helper.SITES_ENABLED)
    except OSError:
        return []
    for filename in names:
        content = _read_site(os.path.join(nginx_helper.SITES_ENABLED, filename))
        domain = nginx_helper.first_server_name(content) if content else None
        if not nginx_helper.is_valid_domain(domain):
            continue
        paths = [
            {"path": item["path"], "port": item["port"]}
            for item in nginx_helper.extract_locations(content)
        ]
        domains.append(
            {
                "domain": domain,
                "filename": filename,
                "paths": paths,
                "primary_port": _primary_port(paths),
            }
        )
    domains.sort(key=_domain_sort_key)
    return domains


def _domain_sort_key(domain: dict) -> tuple:
    port = domain.get("primary_port")
    return port is None, port or 0, domain["domain"]


def _collect_ports(domains: list[dict]) -> list[int]:
    ports = set()
    for domain in domains:
        for item in domain["paths"]:
            if str(item["port"]).isdecimal():
                ports.add(int(item["port"]))
    return sorted(ports)


def group_domains(domains: list[dict]) -> list[dict]:
    by_name = {domain["domain"]: domain for domain in domains}
    claimed: set[str] = set()
    groups = []
    for folder in list_folders():
        members = []
        for name in folder["domains"]:
            if name in by_name and name not in claimed:
                members.append(by_name[name])
                claimed.add(name)
        members.sort(key=_domain_sort_key)
        groups.append(
            {
                "id": folder["id"],
                "name": folder["name"],
                "domains": members,
                "ports": _collect_ports(members),
            }
        )
    rest = [domain for domain in domains if domain["domain"] not in claimed]
    groups.append(
        {
            "id": None,
            "name": _("미분류"),
            "domains": rest,
            "ports": _collect_ports(rest),
        }
    )
    return groups


def hardening_status() -> dict:
    """Existing sites still on the old config (where the client can spoof its IP)."""
    pending = []
    try:
        names = os.listdir(nginx_helper.SITES_AVAILABLE)
    except OSError:
        names = []
    for name in names:
        if not nginx_helper.is_valid_domain(name):
            continue
        content = _read_site(os.path.join(nginx_helper.SITES_AVAILABLE, name))
        if content and nginx_helper.needs_hardening(content):
            pending.append(name)
    missing_reject = bool(names) and not os.path.lexists(nginx_helper.REJECT_CONF)
    return {
        "needed": bool(pending) or missing_reject,
        "sites": len(pending),
        "command": f"sudo {HELPER_PATH} harden",
    }


def overview() -> dict:
    domains = get_domains()
    return {
        "helper": helper_status(),
        "hardening": hardening_status(),
        "groups": group_domains(domains),
        "folders": [
            {"id": folder["id"], "name": folder["name"]} for folder in list_folders()
        ],
    }


# ── Display folders (unrelated to nginx) ──────────────────────────────
def _folders_path() -> Path:
    return data_dir() / "domain_folders.json"


def _load_folders() -> list[dict]:
    try:
        raw = json.loads(_folders_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    folders = []
    for item in raw:
        if isinstance(item, dict) and item.get("id"):
            folders.append(
                {
                    "id": str(item["id"]),
                    "name": str(item.get("name") or _("이름 없음")),
                    "domains": [str(name) for name in item.get("domains") or []],
                }
            )
    return folders


def _save_folders(folders: list[dict]) -> None:
    path = _folders_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".domain_folders.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(folders, handle, ensure_ascii=False, indent=2)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def list_folders() -> list[dict]:
    with _folders_lock:
        return _load_folders()


def _clean_folder_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise ValueError(_("폴더 이름을 입력해 주십시오."))
    if len(name) > MAX_FOLDER_NAME:
        raise ValueError(
            _("폴더 이름은 {count}자 이하여야 합니다.", count=MAX_FOLDER_NAME)
        )
    return name


def create_folder(name: str) -> dict:
    name = _clean_folder_name(name)
    with _folders_lock:
        folders = _load_folders()
        if any(folder["name"] == name for folder in folders):
            raise ValueError(_("같은 이름의 폴더가 이미 있습니다."))
        folder = {"id": uuid.uuid4().hex[:12], "name": name, "domains": []}
        folders.append(folder)
        _save_folders(folders)
    return folder


def rename_folder(folder_id: str, name: str) -> None:
    name = _clean_folder_name(name)
    with _folders_lock:
        folders = _load_folders()
        target = next((item for item in folders if item["id"] == folder_id), None)
        if target is None:
            raise ValueError(_("폴더를 찾을 수 없습니다."))
        if any(item["name"] == name and item["id"] != folder_id for item in folders):
            raise ValueError(_("같은 이름의 폴더가 이미 있습니다."))
        target["name"] = name
        _save_folders(folders)


def delete_folder(folder_id: str) -> None:
    with _folders_lock:
        folders = _load_folders()
        remaining = [item for item in folders if item["id"] != folder_id]
        if len(remaining) == len(folders):
            raise ValueError(_("폴더를 찾을 수 없습니다."))
        _save_folders(remaining)


def assign_domain(domain: str, folder_id: str | None) -> None:
    _require_domain(domain)
    with _folders_lock:
        folders = _load_folders()
        target = None
        if folder_id:
            target = next((item for item in folders if item["id"] == folder_id), None)
            if target is None:
                raise ValueError(_("폴더를 찾을 수 없습니다."))
        for folder in folders:
            folder["domains"] = [name for name in folder["domains"] if name != domain]
        if target is not None:
            target["domains"].append(domain)
        _save_folders(folders)


def rename_in_folders(old_domain: str, new_domain: str) -> None:
    with _folders_lock:
        folders = _load_folders()
        for folder in folders:
            if old_domain in folder["domains"]:
                folder["domains"] = list(
                    dict.fromkeys(
                        new_domain if name == old_domain else name
                        for name in folder["domains"]
                    )
                )
        _save_folders(folders)


def change_passphrase(current: str, new: str) -> None:
    if len(new.encode("utf-8")) > nginx_helper.MAX_PASSPHRASE:
        raise ValueError(_("새 변경 비밀번호가 너무 깁니다."))
    code, output = _run_helper(
        "change-passphrase", passphrase=current, new_passphrase=new
    )
    if code != 0:
        raise ValueError(_helper_message(output))


# ── Paths (jobs that do not request a new certificate) ────────────────
def add_path(domain: str, path: str, port: str, passphrase: str) -> None:
    code, output = _run_helper(
        "add-path", _require_domain(domain), path, port, passphrase=passphrase
    )
    if code != 0:
        raise ValueError(_helper_message(output))


def edit_path(domain: str, path: str, port: str, passphrase: str) -> None:
    code, output = _run_helper(
        "edit-path", _require_domain(domain), path, port, passphrase=passphrase
    )
    if code != 0:
        raise ValueError(_helper_message(output))


def delete_path(domain: str, path: str, passphrase: str) -> bool:
    """True if it is the last path, so the whole domain has to be deleted."""
    code, output = _run_helper(
        "delete-path", _require_domain(domain), path, passphrase=passphrase
    )
    if code == nginx_helper.EXIT_LAST_PATH:
        return True
    if code != 0:
        raise ValueError(_helper_message(output))
    return False


def check_rename(old_domain: str, new_domain: str) -> None:
    """A check that warns before the console opens. The helper makes the real decision again."""
    _require_domain(old_domain)
    _require_domain(new_domain)
    if old_domain == new_domain:
        raise ValueError(_("기존 도메인과 새 도메인이 같습니다."))
    content = _read_site(os.path.join(nginx_helper.SITES_AVAILABLE, old_domain))
    if content is None:
        raise ValueError(_("해당 도메인이 존재하지 않습니다."))
    if os.path.lexists(os.path.join(nginx_helper.SITES_AVAILABLE, new_domain)):
        raise ValueError(_("이미 존재하는 도메인입니다."))
    try:
        nginx_helper.renamed_config(content, new_domain)
    except nginx_helper.HelperError as error:
        raise ValueError(_(str(error))) from error


# ── Console jobs (issuing · deleting certificates) ────────────────────
def console_arguments(data: dict) -> list[str]:
    """Turns the values from the screen into helper arguments. ValueError on a bad value."""
    action = data.get("action")
    if action == "add":
        domain = _require_domain(_clean_domain(data.get("domain")))
        email = _email(data.get("email"))
        port = str(data.get("port") or "")
        if not nginx_helper.is_valid_port(port):
            raise ValueError(_("유효하지 않은 포트입니다."))
        path = nginx_helper.normalize_path(data.get("path") or "/")
        if path is None:
            raise ValueError(_("유효하지 않은 경로입니다."))
        return ["add", domain, email, port, path]
    if action == "rename":
        old_domain = _require_domain(data.get("old_domain"))
        new_domain = _require_domain(_clean_domain(data.get("new_domain")))
        return ["rename", old_domain, new_domain, _email(data.get("email"))]
    if action == "delete":
        return ["delete", _require_domain(data.get("domain"))]
    raise ValueError(_("지원하지 않는 작업입니다."))


def _clean_domain(value) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


def _email(value) -> str:
    value = value.strip() if isinstance(value, str) else ""
    if not nginx_helper.is_valid_email(value):
        raise ValueError(_("유효하지 않은 이메일입니다."))
    return value


FOLDER_ID = re.compile(r"[0-9a-f]{12}")


def after_console_success(arguments: list[str], data: dict) -> str | None:
    """Applies a successful job to the display folders too. nginx is already done, so a failure only leaves a note."""
    action = arguments[0]
    try:
        if action == "add":
            folder_id = data.get("folder_id")
            if isinstance(folder_id, str) and FOLDER_ID.fullmatch(folder_id):
                assign_domain(arguments[1], folder_id)
                return _("선택한 폴더로 분류했습니다.")
        elif action == "rename":
            rename_in_folders(arguments[1], arguments[2])
        elif action == "delete":
            assign_domain(arguments[1], None)
    except (OSError, ValueError) as error:
        return _("폴더 정보는 갱신하지 못했습니다: {error}", error=error)
    return None
