"""Explorer file system access.

- Allowed scope: EXPLORER_ROOTS (':'-separated, default = home folder). Paths are checked by their real
  path (symlinks resolved), so links pointing outside the scope are blocked too.
- Every operation uses Python file APIs only, never a shell.
- Delete does not remove right away; it moves to ~/.univdash/trash (so it can be undone).
"""

import mimetypes
import os
import re
import shutil
import stat as statmod
import subprocess
import tempfile
import time
import zipfile
from collections import deque
from pathlib import Path

from app.i18n import _
from app.services.core import settings_service

MAX_ENTRIES = 5000  # max entries shown for one folder
SEARCH_LIMIT = 200
SEARCH_SECONDS = 3.0
SEARCH_SKIP = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    "dist",
    "build",
    ".next",
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif"}
MEDIA_EXT = {
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".mp3",
    ".wav",
    ".m4a",
    ".ogg",
    ".oga",
    ".flac",
    ".aac",
}


class FsError(Exception):
    """An error that can be shown to the user."""


def roots() -> list[Path]:
    configured = [
        p for p in os.getenv("EXPLORER_ROOTS", "").split(os.pathsep) if p.strip()
    ]
    paths = [Path(os.path.expanduser(p)).resolve() for p in configured] or [
        Path.home().resolve()
    ]
    return [p for p in paths if p.is_dir()]


def home() -> str:
    return str(Path.home())


def trash_dir() -> Path:
    return Path.home() / ".univdash" / "trash"


def _inside(real: Path) -> bool:
    return any(real == root or root in real.parents for root in roots())


def resolve(path: str, must_exist: bool = True) -> Path:
    """User-supplied path → normalized absolute path (FsError when outside the allowed scope)."""
    if not isinstance(path, str) or not path or "\0" in path or len(path) > 4096:
        raise FsError(_("잘못된 경로입니다."))
    candidate = Path(os.path.normpath(os.path.expanduser(path)))
    if not candidate.is_absolute():
        raise FsError(_("절대 경로가 필요합니다."))
    if must_exist and not os.path.lexists(candidate):
        raise FsError(_("파일이나 폴더가 없습니다."))
    # If it exists, check the scope with links resolved; otherwise check against the parent
    real = (
        candidate.resolve()
        if os.path.exists(candidate)
        else candidate.parent.resolve() / candidate.name
    )
    if not _inside(real) and not _inside(candidate.parent.resolve()):
        raise FsError(_("허용된 폴더 밖입니다."))
    if os.path.exists(candidate) and not _inside(real):
        raise FsError(_("허용된 폴더 밖을 가리키는 링크입니다."))
    return candidate


def valid_name(name: str) -> str:
    name = (name or "").strip()
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\0" in name
        or len(name.encode()) > 255
    ):
        raise FsError(_("사용할 수 없는 이름입니다."))
    return name


def _entry(path: Path) -> dict | None:
    try:
        lst = path.lstat()
    except OSError:
        return None
    is_link = statmod.S_ISLNK(lst.st_mode)
    try:
        st = path.stat() if is_link else lst
        is_dir = statmod.S_ISDIR(st.st_mode)
        broken = False
    except OSError:
        st, is_dir, broken = lst, False, True
    return {
        "name": path.name,
        "path": str(path),
        "type": "dir" if is_dir else "file",
        "link": is_link,
        "broken": broken,
        "size": 0 if is_dir else st.st_size,
        "mtime": int(st.st_mtime),
        "ext": "" if is_dir else path.suffix.lower().lstrip("."),
    }


def _repo_of(directory: Path) -> Path | None:
    """Top level of the git repository containing the folder (None if there is none)."""
    for candidate in (directory, *directory.parents):
        if os.path.exists(candidate / ".git"):
            return candidate
    return None


def _git_ignored(directory: Path, names: list[str]) -> set[str]:
    """Names of entries matched by .gitignore (to show them dimmed, like VS Code). Empty set when git is missing or fails."""
    if not names or not shutil.which("git"):
        return set()
    real = directory.resolve()
    repo = _repo_of(real)
    if repo is None:
        return set()
    ignored = {".git"} if real == repo else set()
    prefix = os.path.relpath(real, repo)
    rel = [n if prefix == "." else f"{prefix}/{n}" for n in names if n != ".git"]
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "check-ignore", "-z", "--stdin"],
            input="\0".join(rel).encode() + b"\0",
            capture_output=True,
            timeout=3,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return ignored
    if result.returncode not in (0, 1):
        return ignored
    for item in result.stdout.decode(errors="replace").split("\0"):
        if item:
            ignored.add(item.rsplit("/", 1)[-1])
    return ignored


def list_dir(path: str) -> dict:
    directory = resolve(path)
    if not directory.is_dir():
        raise FsError(_("폴더가 아닙니다."))
    entries = []
    try:
        with os.scandir(directory) as it:
            for index, item in enumerate(it):
                if index >= MAX_ENTRIES:
                    break
                entry = _entry(Path(item.path))
                if entry:
                    entries.append(entry)
    except PermissionError as error:
        raise FsError(_("이 폴더를 읽을 권한이 없습니다.")) from error
    for name in _git_ignored(directory, [e["name"] for e in entries]):
        for entry in entries:
            if entry["name"] == name:
                entry["ignored"] = True
    parent = directory.parent
    return {
        "path": str(directory),
        "parent": str(parent)
        if parent != directory and _inside(parent.resolve())
        else None,
        "entries": entries,
        "truncated": len(entries) >= MAX_ENTRIES,
    }


def file_version(path: str) -> dict:
    """A cheap check whether an open file was changed elsewhere (by an agent etc.); the content is not read."""
    file = resolve(path)
    if not file.is_file():
        raise FsError(_("파일이 아닙니다."))
    st = file.stat()
    return {"mtime_ns": str(st.st_mtime_ns), "size": st.st_size}


def read_file(path: str) -> dict:
    file = resolve(path)
    if not file.is_file():
        raise FsError(_("파일이 아닙니다."))
    info = _entry(file) or {}
    info["mtime_ns"] = str(
        file.stat().st_mtime_ns
    )  # a string, because a JS number (2^53) lacks the precision
    ext = file.suffix.lower()
    info["mime"] = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    info["image"] = ext in IMAGE_EXT
    info["pdf"] = ext == ".pdf"
    info["media"] = (
        ("video" if ext in {".mp4", ".webm", ".mov", ".m4v"} else "audio")
        if ext in MEDIA_EXT
        else None
    )
    if info["image"] or info["pdf"] or info["media"]:
        return info
    limit = (
        settings_service.viewer_max_bytes()
    )  # max size shown in the viewer (setting)
    try:
        with file.open("rb") as handle:
            raw = handle.read(limit + 1)
    except PermissionError as error:
        raise FsError(_("이 파일을 읽을 권한이 없습니다.")) from error
    info["truncated"] = len(raw) > limit
    raw = raw[:limit]
    if b"\0" in raw[:8192]:
        info["binary"] = True
        return info
    info["binary"] = False
    info["content"] = raw.decode("utf-8", errors="replace")
    return info


ENV_NAME = re.compile(r"^\.env(\..+)?$")  # .env · .env.local · .env.example …


def search(root: str, query: str, show_hidden: bool, show_env: bool = False) -> dict:
    base = resolve(root)
    query = (query or "").strip().lower()
    if not query:
        return {"results": [], "truncated": False}
    deadline = time.monotonic() + SEARCH_SECONDS
    results, stack, truncated = [], [base], False
    while stack:
        if time.monotonic() > deadline or len(results) >= SEARCH_LIMIT:
            truncated = True
            break
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                items = sorted(it, key=lambda e: e.name.lower())
        except OSError:
            continue
        for item in items:
            if (
                not show_hidden
                and item.name.startswith(".")
                and not (show_env and ENV_NAME.match(item.name))
            ):
                continue
            if query in item.name.lower():
                entry = _entry(Path(item.path))
                if entry:
                    results.append(entry)
                    if len(results) >= SEARCH_LIMIT:
                        break
            try:
                if item.is_dir(follow_symlinks=False) and item.name not in SEARCH_SKIP:
                    stack.append(Path(item.path))
            except OSError:
                continue
    return {"results": results, "truncated": truncated}


DIR_SEARCH_LIMIT = 60


def search_dirs(root: str, query: str, show_hidden: bool) -> dict:
    """Finds folders only, by name (nearest folders first — breadth first)."""
    base = resolve(root)
    query = (query or "").strip().lower()
    # "csed/week" → the trailing folder names contain csed · week in that order
    parts = [part for part in query.split("/") if part]
    if not parts:
        return {"results": [], "truncated": False}
    deadline = time.monotonic() + SEARCH_SECONDS
    results, queue, truncated = [], deque([base]), False
    while queue:
        if time.monotonic() > deadline:
            truncated = True
            break
        current = queue.popleft()
        try:
            with os.scandir(current) as it:
                items = sorted(it, key=lambda e: e.name.lower())
        except OSError:
            continue
        for item in items:
            if not show_hidden and item.name.startswith("."):
                continue
            try:
                if not item.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            names = (
                os.path.relpath(item.path, base).lower().split(os.sep)
                if len(parts) > 1
                else [item.name.lower()]
            )
            if len(names) >= len(parts) and all(
                part in name for part, name in zip(parts, names[-len(parts) :])
            ):
                entry = _entry(Path(item.path))
                if entry:
                    results.append(entry)
                    if len(results) >= DIR_SEARCH_LIMIT:
                        return {"results": results, "truncated": True}
            if item.name not in SEARCH_SKIP:
                queue.append(Path(item.path))
    return {"results": results, "truncated": truncated}


def _protected(path: Path) -> None:
    real = path.resolve()
    if real in roots() or real == Path.home().resolve():
        raise FsError(_("최상위 폴더는 바꿀 수 없습니다."))


def _free_name(directory: Path, name: str) -> Path:
    target = directory / name
    if not os.path.lexists(target):
        return target
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext, dot = name, "", ""
    for n in range(2, 1000):
        candidate = directory / f"{stem} ({n}){dot}{ext}"
        if not os.path.lexists(candidate):
            return candidate
    raise FsError(_("같은 이름이 너무 많습니다."))


def make(parent: str, name: str, kind: str) -> str:
    directory = resolve(parent)
    if not directory.is_dir():
        raise FsError(_("폴더가 아닙니다."))
    target = directory / valid_name(name)
    if os.path.lexists(target):
        raise FsError(_("같은 이름이 이미 있습니다."))
    if kind == "dir":
        target.mkdir()
    else:
        target.touch(exist_ok=False)
    return str(target)


def rename(path: str, name: str) -> str:
    source = resolve(path)
    _protected(source)
    target = source.parent / valid_name(name)
    if os.path.lexists(target):
        raise FsError(_("같은 이름이 이미 있습니다."))
    source.rename(target)
    return str(target)


def delete(path: str) -> str:
    """Moves to the trash (~/.univdash/trash)."""
    source = resolve(path)
    _protected(source)
    trash = trash_dir()
    if (
        trash.resolve() in source.resolve().parents
        or source.resolve() == trash.resolve()
    ):
        raise FsError(_("휴지통 안의 항목은 여기서 지울 수 없습니다."))
    trash.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = _free_name(trash, f"{time.strftime('%Y%m%d-%H%M%S')}-{source.name}")
    shutil.move(str(source), str(target))
    return str(target)


def transfer(path: str, dest_dir: str, move: bool) -> str:
    source = resolve(path)
    directory = resolve(dest_dir)
    if not directory.is_dir():
        raise FsError(_("대상이 폴더가 아닙니다."))
    if source.is_dir() and (
        directory.resolve() == source.resolve()
        or source.resolve() in directory.resolve().parents
    ):
        raise FsError(_("폴더를 자기 안으로 옮길 수 없습니다."))
    if move:
        _protected(source)
        if source.parent.resolve() == directory.resolve():
            return str(source)
    target = _free_name(directory, source.name)
    if move:
        shutil.move(str(source), str(target))
    elif source.is_dir() and not source.is_symlink():
        shutil.copytree(source, target, symlinks=True)
    else:
        shutil.copy2(source, target, follow_symlinks=False)
    return str(target)


MAX_WRITE = (
    50 * 1024 * 1024
)  # upper bound for request validation. The real limit is a setting (edit_max_mb)


def write_file(path: str, content: str, expected_mtime_ns: int | None) -> dict:
    """Saves a text file. Does not overwrite when it changed elsewhere after it was opened
    (expected_mtime_ns mismatch). Writes to a temporary file and swaps it in, so an interruption cannot
    corrupt the file; the original file's permissions are kept."""
    file = resolve(path)
    if not file.is_file():
        raise FsError(_("파일이 아닙니다."))
    data = content.encode("utf-8")
    limit = settings_service.edit_max_bytes()
    if len(data) > limit:
        raise FsError(
            _(
                "{limit}MB 넘는 파일은 여기서 저장할 수 없습니다 (설정에서 늘릴 수 있습니다).",
                limit=limit // (1024 * 1024),
            )
        )
    st = file.stat()
    if expected_mtime_ns is not None and st.st_mtime_ns != expected_mtime_ns:
        raise FileExistsError(_("다른 곳에서 파일이 바뀌었습니다."))
    real = file.resolve()  # for a link, write to the real file it points to
    temp = real.with_name(
        f".{real.name}.univdash-{os.getpid()}-{time.monotonic_ns()}.tmp"
    )
    try:
        fd = os.open(
            temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, statmod.S_IMODE(st.st_mode)
        )
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chown(temp, st.st_uid, st.st_gid)
        except OSError:
            pass
        os.replace(temp, real)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    info = _entry(file) or {}
    info["mtime_ns"] = str(
        file.stat().st_mtime_ns
    )  # a string, because a JS number (2^53) lacks the precision
    return info


ZIP_MAX_BYTES = (
    4 * 1024 * 1024 * 1024
)  # folder download maximum (total before compression)
ZIP_MAX_FILES = 200_000


def _git_files(directory: Path) -> list[Path] | None:
    """Inside a git repository: the file list without .gitignore matches (tracked + new files). None outside a repository."""
    if not shutil.which("git") or _repo_of(directory.resolve()) is None:
        return None
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(directory),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            capture_output=True,
            timeout=30,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [
        directory / name
        for name in result.stdout.decode(errors="replace").split("\0")
        if name
    ]


ZIP_CHUNK = 1024 * 1024


def open_confined(file: Path, root: Path):
    """Opens only regular files inside root. Blocks following a link out of root, and also a path
    component being swapped for a link between the check and the open (re-checked against the really
    opened path in /proc). Returns (file object, stat)."""
    target = file.resolve(strict=True)
    if target != root and root not in target.parents:
        raise PermissionError(_("공유한 범위 밖을 가리킵니다."))
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        opened = Path(os.readlink(f"/proc/self/fd/{fd}"))
        if not statmod.S_ISREG(st.st_mode) or (
            opened != root and root not in opened.parents
        ):
            raise PermissionError(_("공유한 범위 밖을 가리킵니다."))
    except BaseException:
        os.close(fd)
        raise
    return os.fdopen(fd, "rb"), st


def _zip_write(
    archive: zipfile.ZipFile, file: Path, name: str, on_bytes, confine: Path | None
) -> None:
    """Adds one file by reading it in small pieces (so progress rises smoothly for large files too)."""
    if confine is not None:
        source, st = open_confined(file, confine)
    else:
        source = open(file, "rb")  # noqa: SIM115 — closed by the with below
        st = os.fstat(source.fileno())
    with source:
        stamp = time.localtime(st.st_mtime)[:6]
        info = zipfile.ZipInfo(name, max(stamp, (1980, 1, 1, 0, 0, 0)))
        info.external_attr = (st.st_mode & 0xFFFF) << 16
        info.file_size = st.st_size
        info.compress_type = zipfile.ZIP_DEFLATED
        info._compresslevel = 6  # same compression level as ZipFile.write
        with archive.open(
            info, "w", force_zip64=info.file_size >= zipfile.ZIP64_LIMIT
        ) as target:
            while chunk := source.read(ZIP_CHUNK):
                target.write(chunk)
                on_bytes(len(chunk))


def zip_folder(
    path: str,
    skip_ignored: bool = False,
    progress=None,
    *,
    confine: bool = False,
    exclude=None,
) -> tuple[Path, str]:
    """Packs a folder into a zip and returns the temporary file path and the download file name (the
    caller deletes it after sending). Links are not followed, and ones pointing outside the allowed
    scope are left out.

    progress(state): reports progress as a dict — stage ("scan" · "zip"), files · files_total ·
    done_bytes · total_bytes. A True return value stops the job (cancel).
    confine: links are included only when they point inside this folder (for share links, rather than
    the whole allowed scope).
    exclude(name): True leaves out the file · folder (and everything inside) with that name.
    """
    report = progress or (lambda state: False)
    skip = exclude or (lambda name: False)
    directory = resolve(path)
    if not directory.is_dir():
        raise FsError(_("폴더가 아닙니다."))
    jail = directory.resolve() if confine else None
    files = _git_files(directory) if skip_ignored else None
    if files is not None:
        files = [f for f in files if not any(map(skip, f.relative_to(directory).parts))]
    else:
        files = []
        for current, dirs, names in os.walk(directory, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not skip(d))
            for name in sorted(names):
                if skip(name):
                    continue
                files.append(Path(current) / name)
                if len(files) > ZIP_MAX_FILES:
                    raise FsError(
                        _(
                            "파일이 너무 많습니다 (최대 {count}개).",
                            count=f"{ZIP_MAX_FILES:,}",
                        )
                    )
            if report({"stage": "scan", "files": len(files)}):
                raise FsError(_("압축을 취소했습니다."))
    total = 0
    chosen = []
    for file in files:
        try:
            st = file.lstat()
        except OSError:
            continue
        if statmod.S_ISLNK(st.st_mode):
            try:
                target = file.resolve()
                if not file.is_file() or not _inside(target):
                    continue
                if jail and target != jail and jail not in target.parents:
                    continue
                st = file.stat()
            except OSError:
                continue
        elif not statmod.S_ISREG(st.st_mode):
            continue
        total += st.st_size
        if total > ZIP_MAX_BYTES:
            raise FsError(
                _(
                    "폴더가 너무 큽니다 (최대 4GB). .gitignore 제외 옵션이나 하위 폴더로 받아 보십시오."
                )
            )
        chosen.append((file, st.st_size))
    state = {
        "stage": "zip",
        "files": 0,
        "files_total": len(chosen),
        "done_bytes": 0,
        "total_bytes": total,
    }
    report(dict(state))
    last = [0.0]

    def on_bytes(count: int) -> None:
        state["done_bytes"] += count
        now = time.monotonic()
        if now - last[0] >= 0.2:  # do not report too often
            last[0] = now
            if report(dict(state)):
                raise FsError(_("압축을 취소했습니다."))

    temp_dir = Path.home() / ".univdash" / "cache" / "zip"
    temp_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=temp_dir, suffix=".zip")
    os.close(fd)
    base = directory.name or "root"
    try:
        with zipfile.ZipFile(
            temp,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        ) as archive:
            for file, size in chosen:
                before = state["done_bytes"]
                try:
                    _zip_write(
                        archive,
                        file,
                        f"{base}/{file.relative_to(directory).as_posix()}",
                        on_bytes,
                        jail,
                    )
                except (OSError, ValueError):
                    pass
                # Files whose size changed while reading, or that could not be read, still count as the planned progress
                state["done_bytes"] = before + size
                state["files"] += 1
            report(dict(state))
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
    return Path(temp), f"{base}.zip"


CLONE_URL = re.compile(
    r"^(https?://[^\s]+|ssh://[^\s]+|git://[^\s]+|[\w.\-]+@[\w.\-]+:[^\s]+)$"
)
CLONE_TIMEOUT = 900


def clone_name(url: str) -> str:
    """https://github.com/a/b.git → b"""
    tail = re.split(r"[/:]", url.rstrip("/"))[-1]
    return re.sub(r"\.git$", "", tail) or "repo"


def git_clone(
    url: str, parent: str, name: str = "", branch: str = "", depth: int = 0
) -> dict:
    """git clone into the parent folder. Never prompts for a password (only ssh keys · stored credentials are used)."""
    url = (url or "").strip()
    if not CLONE_URL.match(url) or url.startswith("-") or len(url) > 2000:
        raise FsError(
            _(
                "저장소 주소가 올바르지 않습니다. (https://… 또는 git@host:user/repo.git)"
            )
        )
    directory = resolve(parent)
    if not directory.is_dir():
        raise FsError(_("대상이 폴더가 아닙니다."))
    target = directory / valid_name(name or clone_name(url))
    if os.path.lexists(target):
        raise FsError(
            _(
                "'{name}' 이(가) 이미 있습니다. 다른 폴더 이름을 적어 주십시오.",
                name=target.name,
            )
        )
    branch = (branch or "").strip()
    if branch and (
        branch.startswith("-") or not re.fullmatch(r"[\w./\-]{1,200}", branch)
    ):
        raise FsError(_("브랜치 이름이 올바르지 않습니다."))
    if not shutil.which("git"):
        raise FsError(_("서버에 git 이 없습니다."))
    args = ["git", "clone", "--progress"]
    if branch:
        args += ["--branch", branch]
    if depth and depth > 0:
        args += ["--depth", str(int(depth))]
    args += ["--", url, str(target)]
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",  # never ask for a username/password
        "GIT_ALLOW_PROTOCOL": "https:http:ssh:git",  # no local · command-running protocols such as file:// · ext::
        "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        "LC_ALL": "C",
    }
    try:
        result = subprocess.run(
            args,
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=CLONE_TIMEOUT,
            env=env,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as error:
        shutil.rmtree(target, ignore_errors=True)
        raise FsError(_("clone 시간이 너무 깁니다 (15분 초과).")) from error
    if result.returncode != 0:
        shutil.rmtree(target, ignore_errors=True)
        lines = [
            line
            for line in result.stderr.splitlines()
            if line.strip()
            and not line.startswith(
                ("Cloning into", "remote:", "Receiving", "Resolving")
            )
        ]
        detail = lines[-1] if lines else _("알 수 없는 오류")
        if (
            "Authentication failed" in result.stderr
            or "could not read Username" in result.stderr
            or "Permission denied" in result.stderr
        ):
            detail = _(
                "인증이 필요합니다. 비공개 저장소는 서버에 SSH 키나 git 자격 증명을 설정한 뒤 git@… 주소로 받아 주십시오."
            )
        raise FsError(_("clone 실패: {detail}", detail=detail[:300]))
    return {"path": str(target), "name": target.name}


def properties(path: str) -> dict:
    """Properties dialog: kind · size · permissions · owner · times · link target · git info (the total folder size comes separately from du)."""
    import grp
    import pwd

    target = resolve(path)
    lst = target.lstat()
    is_link = statmod.S_ISLNK(lst.st_mode)
    try:
        st = target.stat()
    except OSError:
        st = lst
    is_dir = statmod.S_ISDIR(st.st_mode)

    def name_of(lookup, ident):
        try:
            return lookup(ident)[0]
        except KeyError:
            return str(ident)

    info = {
        "name": target.name or str(target),
        "path": str(target),
        "type": "dir" if is_dir else "file",
        "kind": _("폴더")
        if is_dir
        else (mimetypes.guess_type(target.name)[0] or _("파일")),
        "link": is_link,
        "link_target": os.readlink(target) if is_link else None,
        "size": None if is_dir else st.st_size,
        "disk": None if is_dir else st.st_blocks * 512,
        "mode": statmod.filemode(st.st_mode),
        "octal": oct(statmod.S_IMODE(st.st_mode))[2:].zfill(3),
        "owner": name_of(pwd.getpwuid, st.st_uid),
        "group": name_of(grp.getgrgid, st.st_gid),
        "mtime": st.st_mtime,
        "atime": st.st_atime,
        "ctime": st.st_ctime,
        "birth": getattr(st, "st_birthtime", None),
        "inode": st.st_ino,
        "readable": os.access(target, os.R_OK),
        "writable": os.access(target, os.W_OK),
        "executable": os.access(target, os.X_OK) and not is_dir,
    }
    if is_dir:
        try:
            with os.scandir(target) as it:
                children = list(it)
            info["children"] = len(children)
            info["child_dirs"] = sum(
                1 for c in children if c.is_dir(follow_symlinks=False)
            )
        except OSError:
            info["children"] = None
    repo = _repo_of(target.resolve() if is_dir else target.resolve().parent)
    if repo is not None:
        info["git_repo"] = str(repo)
        info["git_ignored"] = (
            bool(_git_ignored(target.parent, [target.name]))
            if target != repo
            else False
        )
    return info


_du_cache: dict[tuple[str, int], tuple[float, dict]] = {}
DU_TIMEOUT = 30


async def folder_usage(path: str) -> dict:
    """Computes the total folder size · disk usage · entry count in parallel with du (C implementation). Never crosses onto another disk (-x)."""
    import asyncio

    target = resolve(path)
    if not target.is_dir():
        raise FsError(_("폴더가 아닙니다."))
    key = (str(target), target.stat().st_mtime_ns)
    cached = _du_cache.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return {**cached[1], "cached": True}
    started = time.monotonic()

    async def du(*flags: str) -> tuple[int | None, bool]:
        process = await asyncio.create_subprocess_exec(
            "du",
            "-s",
            "-x",
            *flags,
            "--",
            str(target),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        try:
            out, err = await asyncio.wait_for(process.communicate(), DU_TIMEOUT)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return None, True
        try:
            value = int(out.split()[0])
        except (IndexError, ValueError):
            return None, True
        return value, process.returncode != 0 or bool(
            err.strip()
        )  # a partial count when some subfolders are not readable

    if not shutil.which("du"):
        raise FsError(_("서버에 du 가 없습니다."))
    (size, p1), (disk, p2), (inodes, p3) = await asyncio.gather(
        du("-b"), du("-B1"), du("--inodes")
    )
    result = {
        "size": size,
        "disk": disk,
        "items": max(0, inodes - 1) if inodes is not None else None,  # excluding itself
        "partial": p1 or p2 or p3,
        "timed_out": size is None,
        "seconds": round(time.monotonic() - started, 2),
    }
    if len(_du_cache) > 200:
        _du_cache.clear()
    _du_cache[key] = (time.monotonic(), result)
    return result


MAX_UPLOAD_DEPTH = 32


def _subdir(directory: Path, rel_dir: str, create: bool = True) -> Path:
    """Folder upload: creates rel_dir ("a/b/c") under directory. Each component's name is validated and the scope re-checked."""
    parts = [p for p in (rel_dir or "").split("/") if p]
    if len(parts) > MAX_UPLOAD_DEPTH:
        raise FsError(_("폴더가 너무 깊습니다."))
    target = directory
    for part in parts:
        target = target / valid_name(part)
        if create and not os.path.lexists(target):
            target.mkdir()
        # An existing name that is a link pointing outside is stopped here
        target = resolve(str(target))
        if not target.is_dir():
            raise FsError(_("같은 이름의 파일이 있어 폴더를 만들 수 없습니다."))
    return target


def upload_target(dest_dir: str, name: str, rel_dir: str = "") -> Path:
    directory = resolve(dest_dir)
    if not directory.is_dir():
        raise FsError(_("대상이 폴더가 아닙니다."))
    if rel_dir:
        directory = _subdir(directory, rel_dir)
    return _free_name(directory, valid_name(name))


def upload_folder(dest_dir: str, rel: str, unique: bool) -> str:
    """Prepares a folder upload: with unique, creates the top folder under a new name ("name (2)"); otherwise creates the rel path (for empty folders)."""
    directory = resolve(dest_dir)
    if not directory.is_dir():
        raise FsError(_("대상이 폴더가 아닙니다."))
    if unique:
        target = _free_name(directory, valid_name(rel))
        target.mkdir()
        return str(target)
    return str(_subdir(directory, rel))
