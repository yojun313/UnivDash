"""When UnivDash starts, missing tools are installed automatically: Claude Code · Codex · Chrome for PDF.

- Nothing is done for tools already present (updates · login data are not touched).
- Runs in the background so server start-up is not blocked; on failure it only logs and tries again at the next start.
- sudo is never used: everything is installed into the user's folders. AUTO_INSTALL_TOOLS=0 turns it off.
- If system libraries Chrome needs are missing, the packages are fetched from the apt repository, unpacked into a
  user folder and used for Chrome only.
  (apt-get download works without root and verifies files against the signed package lists)
- Claude · Codex come from the official install scripts, Chrome from Google's Chrome for Testing builds.
  Only HTTPS addresses · fixed hosts are allowed.
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

from app.i18n import _
from app.paths import data_dir, find_command

logger = logging.getLogger(__name__)

AGENT_INSTALLERS = {
    "claude": "https://claude.ai/install.sh",
    "codex": "https://chatgpt.com/codex/install.sh",
    # Gemini: Antigravity CLI (the command is named agy)
    "agy": "https://antigravity.google/cli/install.sh",
}
INSTALLER_HOSTS = {
    "claude.ai",
    "downloads.claude.ai",
    "chatgpt.com",
    "releases.openai.com",
    "antigravity.google",
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
# Libraries whose package name cannot be derived from the library name
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
        raise RuntimeError(_("받은 파일이 너무 큽니다."))
    if final.scheme != "https":
        raise RuntimeError(_("HTTPS 가 아닌 주소로 옮겨졌습니다."))
    return data


# ── Claude Code · Codex ─────────────────────────────────────────────────────


def _child_env() -> dict[str, str]:
    # Environment without the dashboard's secrets
    from app.services.agents.pty_service import _env

    env = _env()
    env["HOME"] = str(Path.home())
    env["NO_COLOR"] = "1"
    env.pop("CODEX_HOME", None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    return env


def _add_local_bin_to_path() -> None:
    """The Claude installer only mentions PATH → add it to the shell config so it works right away in a new terminal."""
    shell = Path(os.getenv("SHELL") or "").name
    names = {"zsh": ".zshrc", "bash": ".bashrc"}
    target = Path.home() / names.get(shell, ".profile")
    try:
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        if ".local/bin" in current:
            return
        with target.open("a", encoding="utf-8") as handle:
            handle.write(
                "\n# >>> UnivDash: agent command path >>>\n"
                'export PATH="$HOME/.local/bin:$PATH"\n'
                "# <<< UnivDash <<<\n"
            )
    except OSError as error:
        logger.warning("Could not add the PATH setting: %s", error)


def _fetch_installer(url: str) -> bytes:
    """Download with curl as the official instructions say (the install address blocks Python's default requests). Checks that the redirect target is an allowed host."""
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is missing; could not download the install script.")
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
                f"Could not download the install script (curl {result.returncode})."
            )
        host = urllib.parse.urlsplit(result.stdout.decode(errors="replace")).hostname
        if host not in INSTALLER_HOSTS:
            raise RuntimeError(f"Unexpected install script address: {host}")
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
        raise RuntimeError(f"Install script failed: {tail}")
    return find_command(name) is not None


def ensure_agents() -> None:
    for name in AGENT_INSTALLERS:
        if find_command(name):
            continue
        logger.info("%s is missing; installing it.", name)
        try:
            if _install_agent(name):
                _add_local_bin_to_path()
                logger.info("%s installed", name)
            else:
                logger.warning("%s was installed but the command was not found.", name)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            logger.warning("%s install failed: %s", name, error)


# ── Chrome for PDF ──────────────────────────────────────────────────────────


def _chrome_root() -> Path:
    return data_dir() / "tools" / CHROME_NAME


def installed_chrome() -> str | None:
    """The Chrome downloaded by the dashboard."""
    candidate = _chrome_root() / "current" / CHROME_NAME
    return str(candidate) if os.access(candidate, os.X_OK) else None


def _libraries_root() -> Path:
    return _chrome_root() / "libs"


def chrome_env(binary: str, env: dict[str, str]) -> dict[str, str]:
    """Environment for running the downloaded Chrome. The downloaded libraries are visible to this Chrome only."""
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
        name, _sep, rest = line.strip().partition(" => ")
        if rest.startswith("not found") and _LIBRARY_NAME.fullmatch(name):
            missing.add(name)
    return sorted(missing)


def _package_candidates(library: str) -> list[str]:
    """Debian's naming rule: libatk-1.0.so.0 → libatk1.0-0, libX11.so.6 → libx11-6 (Ubuntu 24.04 sometimes appends t64)."""
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
            logger.info("Library for Chrome installed · %s (%s)", library, package)
            return True
    return False


def _install_missing_libraries(binary: str) -> list[str]:
    """Download the missing libraries. A downloaded library may need yet another one, so repeat until none are missing."""
    missing = _missing_libraries(binary)
    if not missing or not (shutil.which("apt-get") and shutil.which("dpkg-deb")):
        return missing
    _libraries_root().mkdir(parents=True, exist_ok=True)
    tried: set[str] = set()
    for _round in range(MAX_LIBRARY_ROUNDS):
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
    """Whether the downloaded Chrome runs on this machine. If a required system library is missing, its name is reported."""
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
    return result.stderr.decode(errors="replace").strip()[-200:] or _(
        "실행하지 못했습니다."
    )


def _download_chrome() -> None:
    target = _PLATFORMS.get((platform.system(), platform.machine()))
    if not target:
        raise RuntimeError(
            _(
                "{system} {machine} 용 배포본이 없습니다.",
                system=platform.system(),
                machine=platform.machine(),
            )
        )
    index = json.loads(_fetch(CHROME_INDEX, 4 * 1024 * 1024))
    stable = index["channels"]["Stable"]
    url = next(
        item["url"]
        for item in stable["downloads"][CHROME_NAME]
        if item["platform"] == target
    )
    if not url.startswith(CHROME_DOWNLOAD_PREFIX):
        raise RuntimeError(_("예상과 다른 Chrome 다운로드 주소입니다."))
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
                    raise RuntimeError(_("받은 파일이 너무 큽니다."))
                out.write(chunk)
        unpacked = Path(folder) / "unpacked"
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                # extract blocks ../ paths
                extracted = Path(bundle.extract(member, unpacked))
                mode = member.external_attr >> 16
                if mode & stat.S_IXUSR and extracted.is_file():
                    extracted.chmod(0o700)
        folders = [p for p in unpacked.iterdir() if p.is_dir()]
        if len(folders) != 1 or not (folders[0] / CHROME_NAME).is_file():
            raise RuntimeError(_("받은 파일의 구성이 예상과 다릅니다."))
        binary = str(folders[0] / CHROME_NAME)
        missing = _install_missing_libraries(binary)
        if missing:
            raise RuntimeError(
                _(
                    "Chrome 에 필요한 시스템 라이브러리를 받지 못했습니다: {libraries}. 관리자가 시스템에 Chrome 을 설치하면 해결됩니다.",
                    libraries=", ".join(missing[:6]),
                )
            )
        problem = _chrome_problem(binary)
        if problem:
            raise RuntimeError(
                _("받은 Chrome 이 실행되지 않습니다: {problem}", problem=problem)
            )
        current = root / "current"
        if current.exists():
            shutil.rmtree(current)
        folders[0].rename(current)


def _install_chrome_worker() -> None:
    try:
        logger.info("Chrome is missing; installing it for PDF.")
        _download_chrome()
        logger.info("Chrome for PDF installed")
        with _chrome_lock:
            _chrome_state.update(error=None)
    except Exception as error:  # noqa: BLE001 — inside a thread: reported through the state
        logger.warning("Chrome install failed: %s", error)
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
    """Text shown to the user when Chrome is missing. Starts the install again if it is not running."""
    if _enabled():
        _start_chrome_install()
    with _chrome_lock:
        installing, error = _chrome_state["installing"], _chrome_state["error"]
    if installing:
        return _(
            "PDF 에 필요한 Chrome 을 설치하는 중입니다. 1~2분 뒤에 다시 시도해 주십시오."
        )
    if error:
        return _("PDF 에 필요한 Chrome 을 설치하지 못했습니다. ({error})", error=error)
    return _("서버에 Chrome/Chromium 이 없어 PDF 를 만들 수 없습니다.")


def chrome_needs_no_sandbox(binary: str) -> bool:
    """Only for the downloaded Chrome: whether this is an environment where the sandbox cannot be used, like Ubuntu 23.10+ (the result is remembered).

    A Chrome installed on the system has its own sandbox privileges, so it always runs with the sandbox on.
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
    from app.services.files.md_pdf_service import chrome_path

    if not chrome_path():
        _start_chrome_install()


def _worker() -> None:
    try:
        ensure_chrome()
        ensure_agents()
    except Exception:
        logger.warning("Automatic tool install check failed", exc_info=True)


def start() -> None:
    if _enabled():
        threading.Thread(target=_worker, daemon=True).start()
