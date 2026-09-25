"""Explorer 파일 시스템 접근.

- 허용 범위: EXPLORER_ROOTS (':' 구분, 기본 = 홈 폴더). 경로는 실제 경로(심볼릭 링크 해석)로 검사해서
  링크로 범위 밖을 가리키는 것도 막는다.
- 모든 작업은 shell 없이 파이썬 파일 API 로만 한다.
- 삭제는 바로 지우지 않고 ~/.univdash/trash 로 옮긴다 (되돌릴 수 있게).
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
from pathlib import Path

MAX_READ = 2 * 1024 * 1024  # 뷰어에서 보여줄 최대 크기
MAX_ENTRIES = 5000  # 폴더 하나에서 보여줄 최대 항목 수
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
    """사용자에게 보여줄 수 있는 오류."""


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
    """사용자가 준 경로 → 정규화된 절대 경로 (허용 범위 밖이면 FsError)."""
    if not isinstance(path, str) or not path or "\0" in path or len(path) > 4096:
        raise FsError("잘못된 경로입니다.")
    candidate = Path(os.path.normpath(os.path.expanduser(path)))
    if not candidate.is_absolute():
        raise FsError("절대 경로가 필요합니다.")
    if must_exist and not os.path.lexists(candidate):
        raise FsError("파일이나 폴더가 없습니다.")
    # 존재하면 링크까지 풀어서, 없으면 부모 기준으로 범위를 확인한다
    real = (
        candidate.resolve()
        if os.path.exists(candidate)
        else candidate.parent.resolve() / candidate.name
    )
    if not _inside(real) and not _inside(candidate.parent.resolve()):
        raise FsError("허용된 폴더 밖입니다.")
    if os.path.exists(candidate) and not _inside(real):
        raise FsError("허용된 폴더 밖을 가리키는 링크입니다.")
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
        raise FsError("사용할 수 없는 이름입니다.")
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
    """폴더를 품고 있는 git 저장소의 최상위 (없으면 None)."""
    for candidate in (directory, *directory.parents):
        if os.path.exists(candidate / ".git"):
            return candidate
    return None


def _git_ignored(directory: Path, names: list[str]) -> set[str]:
    """.gitignore 에 걸리는 항목 이름들 (VS Code 처럼 흐리게 보여주기용). git 이 없거나 실패하면 빈 집합."""
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
        raise FsError("폴더가 아닙니다.")
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
        raise FsError("이 폴더를 읽을 권한이 없습니다.") from error
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


def read_file(path: str) -> dict:
    file = resolve(path)
    if not file.is_file():
        raise FsError("파일이 아닙니다.")
    info = _entry(file) or {}
    info["mtime_ns"] = str(
        file.stat().st_mtime_ns
    )  # JS 숫자(2^53)로는 정밀도가 모자라 문자열로
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
    try:
        with file.open("rb") as handle:
            raw = handle.read(MAX_READ + 1)
    except PermissionError as error:
        raise FsError("이 파일을 읽을 권한이 없습니다.") from error
    info["truncated"] = len(raw) > MAX_READ
    raw = raw[:MAX_READ]
    if b"\0" in raw[:8192]:
        info["binary"] = True
        return info
    info["binary"] = False
    info["content"] = raw.decode("utf-8", errors="replace")
    return info


def search(root: str, query: str, show_hidden: bool) -> dict:
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
            if not show_hidden and item.name.startswith("."):
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


def _protected(path: Path) -> None:
    real = path.resolve()
    if real in roots() or real == Path.home().resolve():
        raise FsError("최상위 폴더는 바꿀 수 없습니다.")


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
    raise FsError("같은 이름이 너무 많습니다.")


def make(parent: str, name: str, kind: str) -> str:
    directory = resolve(parent)
    if not directory.is_dir():
        raise FsError("폴더가 아닙니다.")
    target = directory / valid_name(name)
    if os.path.lexists(target):
        raise FsError("같은 이름이 이미 있습니다.")
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
        raise FsError("같은 이름이 이미 있습니다.")
    source.rename(target)
    return str(target)


def delete(path: str) -> str:
    """휴지통(~/.univdash/trash)으로 옮긴다."""
    source = resolve(path)
    _protected(source)
    trash = trash_dir()
    if (
        trash.resolve() in source.resolve().parents
        or source.resolve() == trash.resolve()
    ):
        raise FsError("휴지통 안의 항목은 여기서 지울 수 없습니다.")
    trash.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = _free_name(trash, f"{time.strftime('%Y%m%d-%H%M%S')}-{source.name}")
    shutil.move(str(source), str(target))
    return str(target)


def transfer(path: str, dest_dir: str, move: bool) -> str:
    source = resolve(path)
    directory = resolve(dest_dir)
    if not directory.is_dir():
        raise FsError("대상이 폴더가 아닙니다.")
    if source.is_dir() and (
        directory.resolve() == source.resolve()
        or source.resolve() in directory.resolve().parents
    ):
        raise FsError("폴더를 자기 안으로 옮길 수 없습니다.")
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


MAX_WRITE = 5 * 1024 * 1024


def write_file(path: str, content: str, expected_mtime_ns: int | None) -> dict:
    """텍스트 파일 저장. 연 뒤에 다른 곳에서 바뀌었으면(expected_mtime_ns 불일치) 덮어쓰지 않는다.
    임시 파일에 쓰고 교체해서 중간에 끊겨도 파일이 깨지지 않게 하고, 권한은 원래 파일 것을 유지한다."""
    file = resolve(path)
    if not file.is_file():
        raise FsError("파일이 아닙니다.")
    data = content.encode("utf-8")
    if len(data) > MAX_WRITE:
        raise FsError("5MB 넘는 파일은 여기서 저장할 수 없습니다.")
    st = file.stat()
    if expected_mtime_ns is not None and st.st_mtime_ns != expected_mtime_ns:
        raise FileExistsError("다른 곳에서 파일이 바뀌었습니다.")
    real = file.resolve()  # 링크면 가리키는 실제 파일에 쓴다
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
    )  # JS 숫자(2^53)로는 정밀도가 모자라 문자열로
    return info


ZIP_MAX_BYTES = 4 * 1024 * 1024 * 1024  # 폴더 다운로드 최대 (압축 전 합계)
ZIP_MAX_FILES = 200_000


def _git_files(directory: Path) -> list[Path] | None:
    """git 저장소 안이면 .gitignore 를 뺀 파일 목록 (추적 중 + 새 파일). 저장소가 아니면 None."""
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


def zip_folder(path: str, skip_ignored: bool = False) -> tuple[Path, str]:
    """폴더를 zip 으로 묶어 임시 파일 경로와 받을 파일 이름을 돌려준다 (호출한 쪽이 보낸 뒤 지운다).
    링크는 따라가지 않고, 허용 범위 밖을 가리키는 것은 뺀다."""
    directory = resolve(path)
    if not directory.is_dir():
        raise FsError("폴더가 아닙니다.")
    files = _git_files(directory) if skip_ignored else None
    if files is None:
        files = []
        for current, dirs, names in os.walk(directory, followlinks=False):
            dirs.sort()
            for name in sorted(names):
                files.append(Path(current) / name)
                if len(files) > ZIP_MAX_FILES:
                    raise FsError(f"파일이 너무 많습니다 (최대 {ZIP_MAX_FILES:,}개).")
    total = 0
    chosen = []
    for file in files:
        try:
            st = file.lstat()
        except OSError:
            continue
        if statmod.S_ISLNK(st.st_mode):
            try:
                if not file.is_file() or not _inside(file.resolve()):
                    continue
                st = file.stat()
            except OSError:
                continue
        elif not statmod.S_ISREG(st.st_mode):
            continue
        total += st.st_size
        if total > ZIP_MAX_BYTES:
            raise FsError(
                "폴더가 너무 큽니다 (최대 4GB). .gitignore 제외 옵션이나 하위 폴더로 받아 보세요."
            )
        chosen.append(file)
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
            for file in chosen:
                try:
                    archive.write(
                        file, f"{base}/{file.relative_to(directory).as_posix()}"
                    )
                except (OSError, ValueError):
                    continue
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
    """parent 폴더 안에 git clone. 비밀번호 창은 띄우지 않는다(ssh 키 · 저장된 자격 증명만 사용)."""
    url = (url or "").strip()
    if not CLONE_URL.match(url) or url.startswith("-") or len(url) > 2000:
        raise FsError(
            "저장소 주소가 올바르지 않습니다. (https://… 또는 git@host:user/repo.git)"
        )
    directory = resolve(parent)
    if not directory.is_dir():
        raise FsError("대상이 폴더가 아닙니다.")
    target = directory / valid_name(name or clone_name(url))
    if os.path.lexists(target):
        raise FsError(
            f"'{target.name}' 이(가) 이미 있습니다. 다른 폴더 이름을 적어 주세요."
        )
    branch = (branch or "").strip()
    if branch and (
        branch.startswith("-") or not re.fullmatch(r"[\w./\-]{1,200}", branch)
    ):
        raise FsError("브랜치 이름이 올바르지 않습니다.")
    if not shutil.which("git"):
        raise FsError("서버에 git 이 없습니다.")
    args = ["git", "clone", "--progress"]
    if branch:
        args += ["--branch", branch]
    if depth and depth > 0:
        args += ["--depth", str(int(depth))]
    args += ["--", url, str(target)]
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",  # 아이디/비밀번호 묻지 않기
        "GIT_ALLOW_PROTOCOL": "https:http:ssh:git",  # file:// · ext:: 같은 로컬 · 명령 실행 프로토콜 금지
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
        raise FsError("clone 시간이 너무 깁니다 (15분 초과).") from error
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
        detail = lines[-1] if lines else "알 수 없는 오류"
        if (
            "Authentication failed" in result.stderr
            or "could not read Username" in result.stderr
            or "Permission denied" in result.stderr
        ):
            detail = "인증이 필요합니다. 비공개 저장소는 서버에 SSH 키나 git 자격 증명을 설정한 뒤 git@… 주소로 받아 주세요."
        raise FsError(f"clone 실패: {detail[:300]}")
    return {"path": str(target), "name": target.name}


def properties(path: str) -> dict:
    """속성 창: 종류 · 크기 · 권한 · 소유자 · 시각 · 링크 대상 · git 정보 (폴더 전체 크기는 du 로 따로)."""
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
        "kind": "폴더" if is_dir else (mimetypes.guess_type(target.name)[0] or "파일"),
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
    """폴더 전체 크기 · 디스크 사용량 · 항목 수를 du(C 구현)로 병렬 계산한다. 다른 디스크로는 넘어가지 않는다(-x)."""
    import asyncio

    target = resolve(path)
    if not target.is_dir():
        raise FsError("폴더가 아닙니다.")
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
        )  # 권한 없는 하위 폴더가 있으면 일부만 센 값

    if not shutil.which("du"):
        raise FsError("서버에 du 가 없습니다.")
    (size, p1), (disk, p2), (inodes, p3) = await asyncio.gather(
        du("-b"), du("-B1"), du("--inodes")
    )
    result = {
        "size": size,
        "disk": disk,
        "items": max(0, inodes - 1) if inodes is not None else None,  # 자기 자신 제외
        "partial": p1 or p2 or p3,
        "timed_out": size is None,
        "seconds": round(time.monotonic() - started, 2),
    }
    if len(_du_cache) > 200:
        _du_cache.clear()
    _du_cache[key] = (time.monotonic(), result)
    return result


def upload_target(dest_dir: str, name: str) -> Path:
    directory = resolve(dest_dir)
    if not directory.is_dir():
        raise FsError("대상이 폴더가 아닙니다.")
    return _free_name(directory, valid_name(name))
