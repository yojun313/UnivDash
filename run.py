import logging
import os

import uvicorn
from dotenv import load_dotenv

from app.logging_config import configure_logging, show_startup_banner


def _first_run() -> None:
    """No settings yet: run the setup wizard once (tools/setup.py) so `python run.py` just works."""
    from pathlib import Path

    root = Path(__file__).resolve().parent
    if (root / ".env").exists() or os.getenv("ADMIN_USER"):
        return
    import subprocess
    import sys

    subprocess.run(
        [
            sys.executable,
            str(root / "tools" / "setup.py"),
            *([] if sys.stdin.isatty() else ["--yes"]),
        ],
        check=False,
    )


if __name__ == "__main__":
    _first_run()
load_dotenv()

if __name__ == "__main__":
    # By default bind so it is reachable only locally. Public exposure goes behind an HTTPS reverse proxy, adjusted with HOST.
    host = os.getenv("HOST", "127.0.0.1")
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    environment = os.getenv("APP_ENV", "production")
    configure_logging(log_level)

    try:
        port = int(os.getenv("PORT", "8000"))
    except ValueError:
        port = 8000
        logging.getLogger(__name__).warning(
            "PORT is not valid; using the default port %s.", port
        )

    show_startup_banner(
        host=host, port=port, log_level=log_level, environment=environment
    )
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level=log_level,
        log_config=None,
        access_log=True,
        server_header=False,
        ws_max_size=256 * 1024,
    )
