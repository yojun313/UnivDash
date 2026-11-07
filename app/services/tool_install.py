"""UnivDash 를 켤 때, 없는 도구를 알아서 설치한다: Claude Code · Codex · PDF 용 Chrome.

- 이미 있으면 아무것도 하지 않는다 (업데이트 · 로그인 정보는 건드리지 않는다).
- 서버가 뜨는 것을 막지 않게 백그라운드에서 돌고, 실패하면 기록만 남기고 다음에 켤 때 다시 한다.
- sudo 는 쓰지 않는다: 전부 사용자 폴더에 설치한다. AUTO_INSTALL_TOOLS=0 이면 끈다.
- Chrome 이 쓰는 시스템 라이브러리가 없으면 apt 저장소에서 패키지를 받아 사용자 폴더에 풀고 Chrome 에만 쓴다.
  (apt-get download 는 root 없이 되고, 서명된 패키지 목록으로 파일을 검증한다)
- Claude · Codex 는 공식 설치 스크립트로, Chrome 은 Google 의 Chrome for Testing 배포본으로 받는다.
  주소는 HTTPS · 정해진 호스트만 허용한다.
"""

import json
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from app.paths import data_dir, find_command

logger = logging.getLogger(__name__)

AGENT_INSTALLERS = {
    "claude": "https://claude.ai/install.sh",
    "codex": "https://chatgpt.com/codex/install.sh",
}
INSTALLER_HOSTS = {
    "claude.ai",
    "downloads.claude.ai",
    "chatgpt.com",
    "releases.openai.com",
}
INSTALL_TIMEOUT = 10 * 60
MAX_SCRIPT = 2 * 1024 * 1024

CHROME_INDEX = (
    "https://googlechromelabs.github.io/chrome-for-testing/"
    "last-known-good-versions-with-downloads.json"
)
CHROME_DOWNLOAD_PREFIX = "https://storage.googleapis.com/chrome-for-testing-public/"
CHROME_NAME = "chrome-headless-shell"
MAX_CHROME_ZIP = 400 * 1024 * 1024
CHROME_RETRY_AFTER = 60.0
_PLATFORMS = {
    ("Linux", "x86_64"): "linux64",
    ("Darwin", "arm64"): "mac-arm64",
    ("Darwin", "x86_64"): "mac-x64",
}

MAX_LIBRARY_ROUNDS = 8
LIBRARY_TIMEOUT = 120
_LIBRARY_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*\.so(?:\.[0-9.]+)?")
# 패키지 이름이 라이브러리 이름에서 나오지 않는 것들
_LIBRARY_PACKAGES = {
    "libnss3.so": "libnss3",
    "libnssutil3.so": "libnss3",
    "libsmime3.so": "libnss3",
    "libssl3.so": "libnss3",
    "libnspr4.so": "libnspr4",
    "libplc4.so": "libnspr4",
    "libplds4.so": "libnspr4",
    "libatspi.so.0": "libatspi2.0-0",
}

_chrome_lock = threading.Lock()
_chrome_state = {"installing": False, "error": None, "failed_at": 0.0}
_sandbox_cache: dict[str, bool] = {}


def _enabled() -> bool:
    return os.getenv("AUTO_INSTALL_TOOLS", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _fetch(url: str, limit: int) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(limit + 1)
        final = urllib.parse.urlsplit(response.geturl())
    if len(data) > limit:
        raise RuntimeError("받은 파일이 너무 큽니다.")
    if final.scheme != "https":
        raise RuntimeError("HTTPS 가 아닌 주소로 옮겨졌습니다.")
    return data


# ── Claude Code · Codex ─────────────────────────────────────────────────────


def _child_env() -> dict[str, str]:
    from app.services.pty_service import _env  # 대시보드 비밀값을 뺀 환경

    env = _env()
    env["HOME"] = str(Path.home())
    env["NO_COLOR"] = "1"
    env.pop("CODEX_HOME", None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    return env


def _add_local_bin_to_path() -> None:
    """Claude 설치 프로그램은 PATH 를 안내만 한다 → 새 터미널에서 바로 되도록 셸 설정에 넣는다."""
    shell = Path(os.getenv("SHELL") or "").name
    names = {"zsh": ".zshrc", "bash": ".bashrc"}
    target = Path.home() / names.get(shell, ".profile")
    try:
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        if ".local/bin" in current:
            return
        with target.open("a", encoding="utf-8") as handle:
            handle.write(
                "\n# >>> UnivDash: 에이전트 명령 경로 >>>\n"
                'export PATH="$HOME/.local/bin:$PATH"\n'
                "# <<< UnivDash <<<\n"
            )
    except OSError as error:
        logger.warning("PATH 설정을 추가하지 못했습니다: %s", error)


def _fetch_installer(url: str) -> bytes:
    """공식 안내대로 curl 로 받는다 (설치 주소가 파이썬 기본 요청은 막는다). 이동한 곳이 허용된 호스트인지 본다."""
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("curl 이 없어 설치 스크립트를 받지 못했습니다.")
    with tempfile.TemporaryDirectory(prefix="univdash-install-") as folder:
        path = Path(folder) / "install.sh"
        result = subprocess.run(
            [
                curl,
                "-fsSL",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-time",
                "60",
                "--max-filesize",
                str(MAX_SCRIPT),
                "-o",
                str(path),
                "-w",
                "%{url_effective}",
                url,
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=90,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"설치 스크립트를 받지 못했습니다 (curl {result.returncode})."
            )
        host = urllib.parse.urlsplit(result.stdout.decode(errors="replace")).hostname
        if host not in INSTALLER_HOSTS:
            raise RuntimeError(f"예상과 다른 설치 스크립트 주소입니다: {host}")
        return path.read_bytes()


def _install_agent(name: str) -> bool:
    url = AGENT_INSTALLERS[name]
    script = _fetch_installer(url)
    with tempfile.TemporaryDirectory(prefix="univdash-install-") as folder:
        path = Path(folder) / "install.sh"
        path.write_bytes(script)
        result = subprocess.run(
            ["bash", str(path)],
            env=_child_env(),
            cwd=folder,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=INSTALL_TIMEOUT,
            check=False,
        )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or b"").decode(errors="replace")[-300:]
        raise RuntimeError(f"설치 스크립트 실패: {tail}")
    return find_command(name) is not None


def ensure_agents() -> None:
    for name in AGENT_INSTALLERS:
        if find_command(name):
            continue
        logger.info("%s 이 없어 설치합니다.", name)
        try:
            if _install_agent(name):
                _add_local_bin_to_path()
                logger.info("%s 설치 완료", name)
            else:
                logger.warning("%s 를 설치했지만 명령을 찾지 못했습니다.", name)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            logger.warning("%s 설치 실패: %s", name, error)


# ── PDF 용 Chrome ───────────────────────────────────────────────────────────


def _chrome_root() -> Path:
    return data_dir() / "tools" / CHROME_NAME


def installed_chrome() -> str | None:
    """대시보드가 받아 둔 Chrome."""
    candidate = _chrome_root() / "current" / CHROME_NAME
    return str(candidate) if os.access(candidate, os.X_OK) else None


def _libraries_root() -> Path:
    return _chrome_root() / "libs"


def chrome_env(binary: str, env: dict[str, str]) -> dict[str, str]:
    """받아 둔 Chrome 을 실행할 환경. 내려받은 라이브러리는 이 Chrome 에만 보이게 한다."""
    root = _libraries_root()
    if not binary.startswith(f"{_chrome_root()}{os.sep}") or not root.is_dir():
        return env
    folders = sorted({str(path.parent) for path in root.rglob("*.so*")})
    if not folders:
        return env
    return {**env, "LD_LIBRARY_PATH": os.pathsep.join(folders)}


def _missing_libraries(binary: str) -> list[str]:
    if not shutil.which("ldd"):
        return []
    result = subprocess.run(
        ["ldd", binary],
        env=chrome_env(binary, _child_env()),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=30,
        check=False,
    )
    missing = set()
    for line in result.stdout.splitlines():
        name, _, rest = line.strip().partition(" => ")
        if rest.startswith("not found") and _LIBRARY_NAME.fullmatch(name):
            missing.add(name)
    return sorted(missing)


def _package_candidates(library: str) -> list[str]:
    """Debian 의 이름 규칙: libatk-1.0.so.0 → libatk1.0-0, libX11.so.6 → libx11-6 (Ubuntu 24.04 는 t64 가 붙기도 한다)."""
    packages = []
    if library in _LIBRARY_PACKAGES:
        packages = [_LIBRARY_PACKAGES[library]]
    elif match := re.fullmatch(r"(.+?)\.so\.([0-9]+)[0-9.]*", library):
        name, version = match.group(1).lower().replace("_", "-"), match.group(2)
        head, dash, tail = name.rpartition("-")
        stems = [f"{head}{tail}", name] if dash else [name]
        packages = [
            f"{stem}-{version}" if stem[-1].isdigit() else f"{stem}{version}"
            for stem in stems
        ]
    return [variant for item in packages for variant in (f"{item}t64", item)]


def _download_library(library: str) -> bool:
    env = {**_child_env(), "LC_ALL": "C"}
    for package in _package_candidates(library):
        with tempfile.TemporaryDirectory(prefix="univdash-lib-") as folder:
            result = subprocess.run(
                ["apt-get", "download", package],
                cwd=folder,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=LIBRARY_TIMEOUT,
                check=False,
            )
            archives = list(Path(folder).glob("*.deb"))
            if result.returncode != 0 or len(archives) != 1:
                continue
            subprocess.run(
                ["dpkg-deb", "-x", str(archives[0]), str(_libraries_root())],
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=LIBRARY_TIMEOUT,
                check=True,
            )
            logger.info("Chrome 용 라이브러리 설치 · %s (%s)", library, package)
            return True
    return False


def _install_missing_libraries(binary: str) -> list[str]:
    """없는 라이브러리를 받는다. 받은 라이브러리가 또 다른 것을 필요로 할 수 있어 없어질 때까지 반복한다."""
    missing = _missing_libraries(binary)
    if not missing or not (shutil.which("apt-get") and shutil.which("dpkg-deb")):
        return missing
    _libraries_root().mkdir(parents=True, exist_ok=True)
    tried: set[str] = set()
    for _ in range(MAX_LIBRARY_ROUNDS):
        fresh = [library for library in missing if library not in tried]
        if not fresh:
            break
        tried.update(fresh)
        for library in fresh:
            _download_library(library)
        missing = _missing_libraries(binary)
        if not missing:
            break
    return missing


def _chrome_problem(binary: str) -> str | None:
    """받은 Chrome 이 이 컴퓨터에서 실행되는지. 필요한 시스템 라이브러리가 없으면 그 이름을 알려 준다."""
    with tempfile.TemporaryDirectory(prefix="univdash-chrome-") as folder:
        result = subprocess.run(
            [
                binary,
                "--no-sandbox",
                "--disable-gpu",
                f"--user-data-dir={folder}",
                "--dump-dom",
                "about:blank",
            ],
            env=chrome_env(binary, _child_env()),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=30,
            check=False,
        )
    if result.returncode == 0:
        return None
    return (
        result.stderr.decode(errors="replace").strip()[-200:] or "실행하지 못했습니다."
    )


def _download_chrome() -> None:
    target = _PLATFORMS.get((platform.system(), platform.machine()))
    if not target:
        raise RuntimeError(
            f"{platform.system()} {platform.machine()} 용 배포본이 없습니다."
        )
    index = json.loads(_fetch(CHROME_INDEX, 4 * 1024 * 1024))
    stable = index["channels"]["Stable"]
    url = next(
        item["url"]
        for item in stable["downloads"][CHROME_NAME]
        if item["platform"] == target
    )
    if not url.startswith(CHROME_DOWNLOAD_PREFIX):
        raise RuntimeError("예상과 다른 Chrome 다운로드 주소입니다.")
    root = _chrome_root()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root, prefix="download-") as folder:
        archive = Path(folder) / "chrome.zip"
        size = 0
        with (
            urllib.request.urlopen(url, timeout=120) as response,
            archive.open("wb") as out,
        ):
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_CHROME_ZIP:
                    raise RuntimeError("받은 파일이 너무 큽니다.")
                out.write(chunk)
        unpacked = Path(folder) / "unpacked"
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                extracted = Path(
                    bundle.extract(member, unpacked)
                )  # extract 가 ../ 경로를 막아 준다
                mode = member.external_attr >> 16
                if mode & stat.S_IXUSR and extracted.is_file():
                    extracted.chmod(0o700)
        folders = [p for p in unpacked.iterdir() if p.is_dir()]
        if len(folders) != 1 or not (folders[0] / CHROME_NAME).is_file():
            raise RuntimeError("받은 파일의 구성이 예상과 다릅니다.")
        binary = str(folders[0] / CHROME_NAME)
        missing = _install_missing_libraries(binary)
        if missing:
            raise RuntimeError(
                f"Chrome 에 필요한 시스템 라이브러리를 받지 못했습니다: {', '.join(missing[:6])}. "
                "관리자가 시스템에 Chrome 을 설치하면 해결됩니다."
            )
        problem = _chrome_problem(binary)
        if problem:
            raise RuntimeError(f"받은 Chrome 이 실행되지 않습니다: {problem}")
        current = root / "current"
        if current.exists():
            shutil.rmtree(current)
        folders[0].rename(current)


def _install_chrome_worker() -> None:
    try:
        logger.info("Chrome 이 없어 PDF 용으로 설치합니다.")
        _download_chrome()
        logger.info("PDF 용 Chrome 설치 완료")
        with _chrome_lock:
            _chrome_state.update(error=None)
    except Exception as error:  # noqa: BLE001 — 스레드 안: 상태로 알린다
        logger.warning("Chrome 설치 실패: %s", error)
        with _chrome_lock:
            _chrome_state.update(error=str(error)[:300], failed_at=time.monotonic())
    finally:
        with _chrome_lock:
            _chrome_state["installing"] = False


def _start_chrome_install() -> None:
    with _chrome_lock:
        if _chrome_state["installing"]:
            return
        if (
            _chrome_state["error"]
            and time.monotonic() - _chrome_state["failed_at"] < CHROME_RETRY_AFTER
        ):
            return
        _chrome_state["installing"] = True
    threading.Thread(target=_install_chrome_worker, daemon=True).start()


def chrome_missing_message() -> str:
    """Chrome 이 없을 때 사용자에게 보여 줄 글. 설치가 돌고 있지 않으면 다시 시작한다."""
    if _enabled():
        _start_chrome_install()
    with _chrome_lock:
        installing, error = _chrome_state["installing"], _chrome_state["error"]
    if installing:
        return (
            "PDF 에 필요한 Chrome 을 설치하는 중이에요. 1~2분 뒤에 다시 시도해 주세요."
        )
    if error:
        return f"PDF 에 필요한 Chrome 을 설치하지 못했어요. ({error})"
    return "서버에 Chrome/Chromium 이 없어 PDF 를 만들 수 없어요."


def chrome_needs_no_sandbox(binary: str) -> bool:
    """받아 둔 Chrome 만 해당: Ubuntu 23.10+ 처럼 샌드박스를 못 쓰는 환경인지 (결과는 기억해 둔다).

    시스템에 설치된 Chrome 은 자체 샌드박스 권한이 있으므로 언제나 샌드박스를 켠 채로 쓴다.
    """
    if binary != installed_chrome():
        return False
    cached = _sandbox_cache.get(binary)
    if cached is not None:
        return cached
    with tempfile.TemporaryDirectory(prefix="univdash-chrome-") as folder:
        try:
            result = subprocess.run(
                [
                    binary,
                    "--disable-gpu",
                    f"--user-data-dir={folder}",
                    "--dump-dom",
                    "about:blank",
                ],
                env=chrome_env(binary, _child_env()),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=30,
                check=False,
            )
            needed = b"No usable sandbox" in result.stderr
        except (OSError, subprocess.SubprocessError):
            needed = False
    _sandbox_cache[binary] = needed
    return needed


def ensure_chrome() -> None:
    from app.services.md_pdf_service import chrome_path

    if not chrome_path():
        _start_chrome_install()


def _worker() -> None:
    try:
        ensure_chrome()
        ensure_agents()
    except Exception:
        logger.warning("도구 자동 설치 확인 실패", exc_info=True)


def start() -> None:
    if _enabled():
        threading.Thread(target=_worker, daemon=True).start()
