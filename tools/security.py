"""UnivDash 보안 설정 도우미.

    .venv/bin/python tools/security.py hash-password   # ADMIN_PASS_HASH 만들기 (평문 비밀번호를 .env 에 두지 않기)
    .venv/bin/python tools/security.py totp            # 2단계 인증(ADMIN_TOTP_SECRET) 만들기
    .venv/bin/python tools/security.py secret-key      # SECRET_KEY 만들기

출력된 줄을 .env 에 넣고 서버를 재시작하세요. 비밀값은 화면에만 출력하고 어디에도 저장하지 않습니다.
"""

import base64
import getpass
import secrets
import sys
import time
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.auth_service import (
    MIN_PASSWORD_LENGTH,
    hash_password,
    totp_code,
)


def cmd_hash_password() -> None:
    password = getpass.getpass(f"새 비밀번호 ({MIN_PASSWORD_LENGTH}자 이상): ")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다.")
    if getpass.getpass("한 번 더: ") != password:
        sys.exit("두 비밀번호가 다릅니다.")
    print("\n.env 에 아래 줄을 넣고, ADMIN_PASS 줄은 지우세요:\n")
    print(f"ADMIN_PASS_HASH={hash_password(password)}")


def cmd_totp() -> None:
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    user = input("인증 앱에 표시할 계정 이름 [admin]: ").strip() or "admin"
    uri = f"otpauth://totp/UnivDash:{quote(user)}?secret={secret}&issuer=UnivDash&digits=6&period=30"
    print("\n1) 인증 앱(Google Authenticator, 1Password, iOS 암호 앱 등)에 '설정 키'로 아래 값을 추가하세요:\n")
    print(f"   {' '.join(secret[i:i + 4] for i in range(0, len(secret), 4))}")
    print(f"\n   (또는 이 주소를 지원하는 앱에서 열기: {uri})")
    print(f"\n2) 앱에 나온 코드가 지금 코드와 같은지 확인하세요: {totp_code(secret, int(time.time() // 30))}")
    print("\n3) .env 에 아래 줄을 넣고 서버를 재시작하세요 (기존 로그인은 모두 풀립니다):\n")
    print(f"ADMIN_TOTP_SECRET={secret}")


def cmd_secret_key() -> None:
    print(f"SECRET_KEY={secrets.token_urlsafe(48)}")


COMMANDS = {"hash-password": cmd_hash_password, "totp": cmd_totp, "secret-key": cmd_secret_key}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]]()
