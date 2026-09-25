"""서버가 쓰는 런타임 데이터 위치.

프로젝트 폴더 밖(기본 ~/.univdash/data)에 둔다. 프로젝트 안에 두면 pm2 의 watch 가
세션 · 설정 파일이 바뀔 때마다 서버를 재시작해서, 그 순간 연 페이지가 CSS 없이 뜨거나
실시간 연결이 끊긴다.
"""

import logging
import os
import shutil
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

LEGACY_DIR = Path(__file__).resolve().parents[1] / "data"  # 예전 위치 (프로젝트/data)
_migrated: set[Path] = set()
_lock = threading.Lock()


def data_dir() -> Path:
    configured = os.getenv("UNIVDASH_DATA_DIR")
    base = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".univdash" / "data"
    )
    if not configured:
        _migrate_legacy(base)
    return base


def _migrate_legacy(target: Path) -> None:
    """예전 프로젝트/data 의 파일을 새 위치로 한 번 복사한다 (새 위치에 이미 있으면 건드리지 않음)."""
    with _lock:
        if target in _migrated:
            return
        _migrated.add(target)
        if not LEGACY_DIR.is_dir():
            return
        for source in LEGACY_DIR.glob("*.json"):
            destination = target / source.name
            if destination.exists():
                continue
            try:
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(source, destination)
                os.chmod(destination, 0o600)
                logger.info("데이터 파일을 옮겼습니다 · %s → %s", source, destination)
            except OSError as error:
                logger.warning(
                    "데이터 파일을 옮기지 못했습니다 · %s: %s", source, error
                )
