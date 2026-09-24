import logging
import os
from typing import Final

from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table
from rich.theme import Theme

LOG_THEME: Final = Theme(
    {
        "logging.level.debug": "dim cyan",
        "logging.level.info": "bold bright_blue",
        "logging.level.warning": "bold yellow",
        "logging.level.error": "bold red",
        "logging.level.critical": "bold white on red",
        "dashboard.label": "bold bright_black",
        "dashboard.value": "bright_white",
        "dashboard.success": "bold bright_green",
    }
)

console = Console(theme=LOG_THEME, highlight=True)


def configure_logging(level: str = "INFO") -> None:
    """애플리케이션과 Uvicorn 로그를 하나의 Rich 콘솔로 통합합니다."""
    level_name = level.upper()
    numeric_level = getattr(logging, level_name, logging.INFO)
    handler = RichHandler(
        console=console,
        show_time=True,
        show_level=True,
        show_path=False,
        omit_repeated_times=False,
        rich_tracebacks=True,
        tracebacks_show_locals=os.getenv("LOG_TRACEBACK_LOCALS", "false").lower()
        in {"1", "true", "yes"},
        log_time_format="[%H:%M:%S]",
        markup=False,
    )
    handler.setFormatter(logging.Formatter("%(name)s  %(message)s"))

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(numeric_level)

    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(logger_name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
        uvicorn_logger.setLevel(numeric_level)

    logging.captureWarnings(True)


def show_startup_banner(
    *, host: str, port: int, log_level: str, environment: str
) -> None:
    """UnivDash 실행 정보를 Rich 패널로 표시합니다."""
    local_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    table = Table.grid(padding=(0, 2))
    table.add_column(style="dashboard.label", justify="right")
    table.add_column(style="dashboard.value")
    table.add_row("STATUS", "[dashboard.success]● STARTING[/dashboard.success]")
    table.add_row("LOCAL", f"http://{local_host}:{port}")
    table.add_row("BIND", f"{host}:{port}")
    table.add_row("ENV", environment)
    table.add_row("LOG", log_level.upper())

    console.print()
    console.print(
        Panel.fit(
            table,
            title="[bold bright_blue]UnivDash[/bold bright_blue]",
            subtitle="[bright_black]Agent · Server · Git Console[/bright_black]",
            border_style="bright_blue",
            padding=(1, 3),
        )
    )
    console.print()
