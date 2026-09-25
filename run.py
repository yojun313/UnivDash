import logging
import os

import uvicorn
from dotenv import load_dotenv

from app.logging_config import configure_logging, show_startup_banner

load_dotenv()

if __name__ == "__main__":
    # 기본은 로컬에서만 접속 가능하게 묶는다. 외부 공개는 HTTPS 리버스 프록시 뒤에서 HOST 로 조정.
    host = os.getenv("HOST", "127.0.0.1")
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    environment = os.getenv("APP_ENV", "production")
    configure_logging(log_level)

    try:
        port = int(os.getenv("PORT", "8000"))
    except ValueError:
        port = 8000
        logging.getLogger(__name__).warning(
            "PORT 값이 올바르지 않아 기본 포트 %s를 사용합니다.", port
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
