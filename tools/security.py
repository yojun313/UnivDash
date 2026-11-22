"""UnivDash security setup helper.

    .venv/bin/python tools/security.py hash-password   # create ADMIN_PASS_HASH (no plain-text password in .env)
    .venv/bin/python tools/security.py totp            # create two-step verification (ADMIN_TOTP_SECRET)
    .venv/bin/python tools/security.py secret-key      # create SECRET_KEY

Put the printed line into .env and restart the server. Secrets are only printed to the screen and never stored anywhere.
"""

import base64
import getpass
import secrets
import sys
import time
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.core.auth_service import (
    hash_password,
    totp_code,
)


def cmd_hash_password() -> None:
    password = getpass.getpass("New password: ")
    if not password:
        sys.exit("The password is empty.")
    if getpass.getpass("Once more: ") != password:
        sys.exit("The two passwords do not match.")
    print("\nPut the line below into .env and remove the ADMIN_PASS line:\n")
    print(f"ADMIN_PASS_HASH={hash_password(password)}")


def cmd_totp() -> None:
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    user = input("Account name to show in the authenticator app [admin]: ").strip()
    user = user or "admin"
    uri = f"otpauth://totp/UnivDash:{quote(user)}?secret={secret}&issuer=UnivDash&digits=6&period=30"
    print(
        "\n1) Add the value below as a 'setup key' in an authenticator app (Google Authenticator, 1Password, iOS Passwords etc.):\n"
    )
    print(f"   {' '.join(secret[i : i + 4] for i in range(0, len(secret), 4))}")
    print(f"\n   (or open this address in an app that supports it: {uri})")
    print(
        f"\n2) Check that the code in the app matches the current code: {totp_code(secret, int(time.time() // 30))}"
    )
    print(
        "\n3) Put the line below into .env and restart the server (all existing sign-ins are ended):\n"
    )
    print(f"ADMIN_TOTP_SECRET={secret}")


def cmd_secret_key() -> None:
    print(f"SECRET_KEY={secrets.token_urlsafe(48)}")


COMMANDS = {
    "hash-password": cmd_hash_password,
    "totp": cmd_totp,
    "secret-key": cmd_secret_key,
}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]]()
