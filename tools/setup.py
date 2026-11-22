"""UnivDash first-run setup: writes a ready-to-use .env (login, secret key, port).

    uv run python tools/setup.py            # interactive (press Enter to accept every default)
    uv run python tools/setup.py --yes      # no questions: user "admin", generated password, port 8000
    uv run python tools/setup.py --reset    # replace an existing .env (the old one is kept as .env.bak)

The password is stored as a PBKDF2 hash (ADMIN_PASS_HASH), never in plain text. A generated password is
shown once on the terminal and nowhere else.
"""

import argparse
import getpass
import os
import re
import secrets
import shutil
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ENV_FILE = ROOT / ".env"
MIN_PASSWORD = 12
WORDS = [
    "amber",
    "birch",
    "cedar",
    "delta",
    "ember",
    "fjord",
    "grove",
    "harbor",
    "indigo",
    "juniper",
    "kelp",
    "lumen",
    "maple",
    "nectar",
    "onyx",
    "pebble",
    "quartz",
    "river",
    "sable",
    "tundra",
    "umber",
    "violet",
    "willow",
    "zephyr",
]


def _tty():
    """Questions are read from the terminal even when the installer itself is piped (curl … | sh)."""
    if sys.stdin.isatty():
        return sys.stdin
    try:
        return open("/dev/tty")
    except OSError:
        return None


def ask(stream, question: str, default: str) -> str:
    sys.stdout.write(f"{question} [{default}]: ")
    sys.stdout.flush()
    answer = stream.readline().strip()
    return answer or default


def ask_password(stream) -> tuple[str, bool]:
    """(password, generated). Enter generates a strong passphrase; a typed one is asked for twice."""
    del stream  # getpass opens the terminal itself (works when the installer is piped)
    while True:
        try:
            password = getpass.getpass(
                f"Password (at least {MIN_PASSWORD} characters, Enter = generate one): "
            )
            if not password:
                return generate_password(), True
            if len(password) < MIN_PASSWORD:
                print(f"  Too short: use {MIN_PASSWORD} characters or more.")
                continue
            again = getpass.getpass("Type the password again to confirm: ")
        except (EOFError, KeyboardInterrupt):
            raise SystemExit("\nSetup cancelled.") from None
        if again != password:
            print("  The two passwords do not match. Try again.")
            continue
        return password, False


def generate_password() -> str:
    """Four random words and a number: easy to type on a phone, about 60 bits."""
    words = [secrets.choice(WORDS) for _ in range(4)]
    return "-".join(words) + f"-{secrets.randbelow(9000) + 1000}"


def port_free(port: int) -> bool:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 50):
        if port_free(port):
            return port
    return preferred


def lan_address() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(
                ("192.0.2.1", 9)
            )  # no packet is sent; only picks the outgoing interface
            return probe.getsockname()[0]
    except OSError:
        return None


def write_env(values: dict[str, str]) -> None:
    """Start from .env.example (keeps its comments) and fill in the chosen values."""
    example = ROOT / ".env.example"
    lines = example.read_text(encoding="utf-8").splitlines() if example.exists() else []
    done: set[str] = set()
    out: list[str] = []
    for line in lines:
        match = re.match(r"^#?\s*([A-Z_]+)=", line)
        key = match.group(1) if match else None
        if key in values and key not in done:
            out.append(f"{key}={values[key]}")
            done.add(key)
        elif key == "ADMIN_PASS" and "ADMIN_PASS_HASH" in values:
            continue  # the hash replaces the plain-text line
        else:
            out.append(line)
    out += [f"{key}={value}" for key, value in values.items() if key not in done]
    tmp = ENV_FILE.with_name(".env.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out) + "\n")
    os.replace(tmp, ENV_FILE)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create the UnivDash .env file.")
    parser.add_argument(
        "--yes", action="store_true", help="accept every default, ask nothing"
    )
    parser.add_argument("--reset", action="store_true", help="replace an existing .env")
    parser.add_argument("--user", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument(
        "--lan",
        action="store_true",
        help="listen on every interface (phone on the same network)",
    )
    args = parser.parse_args(argv)

    if ENV_FILE.exists() and not args.reset:
        print(
            f".env already exists ({ENV_FILE}). Nothing changed. Use --reset to start over."
        )
        return 0

    from app.services.core.auth_service import hash_password

    stream = None if args.yes else _tty()
    default_user = args.user or "admin"
    default_port = free_port(args.port or 8000)
    print("\n  UnivDash setup\n  ──────────────")
    if stream is None:
        user, port, lan = default_user, default_port, args.lan
        password, generated = generate_password(), True
    else:
        print("  Press Enter to accept the value in [brackets].\n")
        user = ask(stream, "Login name", default_user)
        password, generated = ask_password(stream)
        while True:
            answer = ask(stream, "Port", str(default_port))
            if answer.isdigit() and 1024 <= int(answer) <= 65535:
                port = int(answer)
                break
            print("  Use a port number between 1024 and 65535.")
        lan = args.lan or ask(
            stream,
            "Open it to other devices on your network, e.g. your phone? (y/N)",
            "N",
        ).lower().startswith("y")

    if not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", user):
        raise SystemExit("Login name: use letters, digits and . _ @ - only.")

    if ENV_FILE.exists():
        shutil.copy2(ENV_FILE, ENV_FILE.with_name(".env.bak"))
        os.chmod(ENV_FILE.with_name(".env.bak"), 0o600)
    write_env(
        {
            "ADMIN_USER": user,
            "ADMIN_PASS_HASH": hash_password(password),
            "SECRET_KEY": secrets.token_urlsafe(48),
            "PORT": str(port),
            "HOST": "0.0.0.0" if lan else "127.0.0.1",
        }
    )

    address = lan_address() if lan else None
    print("\n  Done. Settings were saved to .env (readable only by you).\n")
    print(f"    Login name : {user}")
    if generated:
        print(f"    Password   : {password}")
        print(
            "                 ↑ shown only this once. Save it in your password manager."
        )
    else:
        print("    Password   : the one you typed (stored as a hash)")
    print(f"    Address    : http://127.0.0.1:{port}")
    if address:
        print(f"    On your phone (same Wi-Fi / VPN): http://{address}:{port}")
        print(
            "\n  Note: plain http on a network is not encrypted. For access over the internet, put UnivDash"
        )
        print(
            "  behind HTTPS (Tailscale, Cloudflare Tunnel, nginx or Caddy) and set SESSION_HTTPS_ONLY=true."
        )
    print(
        "\n  Tip: after your first sign-in the dashboard offers to set up two-factor authentication"
    )
    print(
        "  (a QR code for your authenticator app). You can also do it later in Settings › Signed-in devices."
    )
    print("\n  Start it with:  ./univdash start\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
