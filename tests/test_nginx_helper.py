"""root 헬퍼를 임시 폴더와 가짜 nginx · certbot · systemctl 로 시험한다. 실제 /etc/nginx 는 건드리지 않는다."""

import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import domain_service, nginx_helper as helper

CERTBOT_CONFIG = """server {
    server_name a.example.com;

    location / {
        proxy_pass http://localhost:7006;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
    location /api/ {
        proxy_pass http://localhost:7007/;
        proxy_redirect / /api/;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/a.example.com/fullchain.pem; # managed by Certbot
}
server {
    if ($host = a.example.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name a.example.com;
    return 404; # managed by Certbot
}
"""


class HelperTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.available = self.root / "available"
        self.enabled = self.root / "enabled"
        self.available.mkdir()
        self.enabled.mkdir()
        self.calls = self.root / "calls"
        self.fail_file = self.root / "fail"
        self.nginx = self._tool("nginx")
        self.certbot = self._tool("certbot")
        self.systemctl = self._tool("systemctl")
        for name, value in {
            "SITES_AVAILABLE": str(self.available),
            "SITES_ENABLED": str(self.enabled),
            "NGINX": self.nginx,
            "CERTBOT": self.certbot,
            "SYSTEMCTL": self.systemctl,
            "REJECT_CONF": str(self.root / "reject.conf"),
            "BACKUP_ROOT": str(self.root / "backup"),
            "PASSPHRASE_FILE": str(self.root / "passphrase"),
            "FAILURES_FILE": str(self.root / "failures"),
        }.items():
            patcher = patch.object(helper, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.passphrase = "correct horse battery"
        salt = b"0123456789abcdef"
        key = hashlib.scrypt(
            self.passphrase.encode(),
            salt=salt,
            n=2**4,
            r=8,
            p=1,
            maxmem=64 * 1024 * 1024,
        )
        secret = self.root / "passphrase"
        secret.write_text(f"scrypt$4${salt.hex()}${key.hex()}")
        secret.chmod(0o600)
        typed = patch.object(helper, "_read_passphrase", lambda: self.passphrase)
        typed.start()
        self.addCleanup(typed.stop)
        (self.available / "a.example.com").write_text(CERTBOT_CONFIG)
        (self.enabled / "a.example.com").symlink_to(self.available / "a.example.com")

    def _tool(self, name):
        path = self.root / name
        path.write_text(
            f'#!/bin/sh\necho "{name} $*" >> "{self.root}/calls"\n'
            f'if grep -qx "{name} $1" "{self.root}/fail" 2>/dev/null; then exit 1; fi\n'
        )
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def fail_on(self, line):
        self.fail_file.write_text(line + "\n")

    def called(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def config(self, name="a.example.com"):
        return (self.available / name).read_text()

    def test_rejects_values_that_could_inject_nginx_config(self):
        for domain in (
            "a.example.com\n",
            "a.example.com;",
            "../../etc/passwd",
            "-x.example.com",
            "default",
            "a b.example.com",
            "*.example.com",
            "a.example.com\nserver { }",
            "A.example.com/x",
        ):
            self.assertFalse(helper.is_valid_domain(domain), domain)
        for path in (
            "/a b",
            "/a;",
            "/a{",
            "/../x",
            "/a\nproxy_pass http://evil;",
            "/$x",
        ):
            self.assertIsNone(helper.normalize_path(path), path)
        for port in ("0", "65536", "80\n", "٣", "80;", "", "-1"):
            self.assertFalse(helper.is_valid_port(port), port)
        for email in ("-x@a.com", "a@b", "a@b.com\n", "a b@c.com", "--help@a.com"):
            self.assertFalse(helper.is_valid_email(email), email)

    def test_commands_reject_bad_input_before_touching_anything(self):
        before = self.config()
        for argv in (
            ["add", "bad\n.com", "a@b.com", "80", "/"],
            ["add", "b.example.com", "-x@b.com", "80", "/"],
            ["add-path", "a.example.com", "/x;", "80"],
            ["edit-path", "a.example.com", "/", "99999"],
            ["delete", "default"],
            ["delete", "../a.example.com"],
            ["rename", "a.example.com", "evil;.com", "a@b.com"],
            ["unknown"],
            ["add", "too", "few"],
            [],
        ):
            self.assertEqual(helper.run(argv), 1, argv)
        self.assertEqual(self.called(), [])
        self.assertEqual(self.config(), before)

    def test_add_creates_config_and_certificate(self):
        code = helper.run(["add", "b.example.com", "me@x.com", "3000", "/api"])
        self.assertEqual(code, 0)
        config = self.config("b.example.com")
        self.assertIn("server_name b.example.com;", config)
        self.assertIn("location /api/ {", config)
        self.assertIn("proxy_pass http://localhost:3000/;", config)
        self.assertTrue((self.enabled / "b.example.com").is_symlink())
        self.assertIn(
            "certbot --nginx -d b.example.com --non-interactive --agree-tos -m me@x.com",
            self.called(),
        )
        self.assertEqual(
            os.stat(self.available / "b.example.com").st_mode & 0o777, 0o644
        )

    def test_add_refuses_existing_domain_or_server_name(self):
        self.assertEqual(helper.run(["add", "a.example.com", "m@x.com", "1", "/"]), 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        (self.available / "other").write_text("server { server_name c.example.com; }\n")
        self.assertEqual(helper.run(["add", "c.example.com", "m@x.com", "1", "/"]), 1)
        self.assertFalse((self.available / "c.example.com").exists())

    def test_add_failed_certificate_removes_new_config(self):
        self.fail_on("certbot --nginx")
        self.assertEqual(helper.run(["add", "b.example.com", "m@x.com", "1", "/"]), 1)
        self.assertFalse((self.available / "b.example.com").exists())
        self.assertFalse((self.enabled / "b.example.com").is_symlink())

    def test_path_edits_keep_certbot_lines(self):
        self.assertEqual(helper.run(["add-path", "a.example.com", "/new", "9000"]), 0)
        config = self.config()
        self.assertIn("proxy_pass http://localhost:9000/;", config)
        self.assertIn("ssl_certificate /etc/letsencrypt", config)
        self.assertLess(config.index("location /new/"), config.index("listen 443"))

        self.assertEqual(helper.run(["edit-path", "a.example.com", "/new", "9001"]), 0)
        self.assertIn("localhost:9001/;", self.config())
        self.assertIn("localhost:7006;", self.config())

        self.assertEqual(helper.run(["delete-path", "a.example.com", "/new"]), 0)
        self.assertEqual(self.config().count("location"), 2)
        self.assertIn("listen 443", self.config())
        self.assertNotIn("certbot --nginx", " ".join(self.called()))

    def test_failed_nginx_test_restores_config_and_skips_reload(self):
        self.fail_on("nginx -t")
        self.assertEqual(helper.run(["edit-path", "a.example.com", "/", "9000"]), 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertFalse(any(line.startswith("systemctl") for line in self.called()))

    def test_last_path_reports_full_delete(self):
        helper.run(["delete-path", "a.example.com", "/api"])
        self.assertEqual(
            helper.run(["delete-path", "a.example.com", "/"]), helper.EXIT_LAST_PATH
        )
        self.assertIn("location /", self.config())

    def test_rename_moves_paths_and_replaces_certificate(self):
        code = helper.run(["rename", "a.example.com", "n.example.com", "m@x.com"])
        self.assertEqual(code, 0)
        self.assertFalse((self.available / "a.example.com").exists())
        self.assertFalse((self.enabled / "a.example.com").is_symlink())
        config = self.config("n.example.com")
        self.assertIn("localhost:7006;", config)
        self.assertIn("localhost:7007/;", config)
        self.assertNotIn("letsencrypt", config)
        self.assertIn(
            "certbot delete --cert-name a.example.com --non-interactive", self.called()
        )

    def test_rename_failure_restores_original(self):
        self.fail_on("certbot --nginx")
        code = helper.run(["rename", "a.example.com", "n.example.com", "m@x.com"])
        self.assertEqual(code, 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertTrue((self.enabled / "a.example.com").is_symlink())
        self.assertFalse((self.available / "n.example.com").exists())
        self.assertNotIn("certbot delete", " ".join(self.called()))

    def test_delete_removes_config_then_certificate(self):
        self.assertEqual(helper.run(["delete", "a.example.com"]), 0)
        self.assertFalse((self.available / "a.example.com").exists())
        self.assertFalse((self.enabled / "a.example.com").is_symlink())
        calls = self.called()
        self.assertLess(
            calls.index("systemctl reload nginx"),
            calls.index("certbot delete --cert-name a.example.com --non-interactive"),
        )

    def test_delete_restores_when_nginx_test_fails(self):
        self.fail_on("nginx -t")
        self.assertEqual(helper.run(["delete", "a.example.com"]), 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertTrue((self.enabled / "a.example.com").is_symlink())
        self.assertFalse(any(line.startswith("certbot") for line in self.called()))

    def test_changes_need_the_passphrase(self):
        self.passphrase = "wrong"
        for argv in (
            ["delete", "a.example.com"],
            ["edit-path", "a.example.com", "/", "1"],
            ["add", "b.example.com", "m@x.com", "1", "/"],
            ["rename", "a.example.com", "n.example.com", "m@x.com"],
            ["harden"],
        ):
            (self.root / "failures").unlink(missing_ok=True)
            self.assertEqual(helper.run(argv), helper.EXIT_PASSPHRASE, argv)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertEqual(self.called(), [])
        self.assertEqual(helper.run(["check"]), 0)

    def test_missing_or_open_secret_fails_closed(self):
        secret = self.root / "passphrase"
        secret.chmod(0o640)
        self.assertEqual(helper.run(["delete", "a.example.com"]), 1)
        secret.unlink()
        self.assertEqual(helper.run(["delete", "a.example.com"]), 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)

    def test_repeated_failures_lock_even_the_right_passphrase(self):
        right = self.passphrase
        self.passphrase = "wrong"
        for _ in range(helper.MAX_FAILURES):
            self.assertEqual(helper.run(["delete", "a.example.com"]), 4)
        self.passphrase = right
        self.assertEqual(helper.run(["delete", "a.example.com"]), 4)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertEqual(os.stat(self.root / "failures").st_mode & 0o777, 0o600)

    def test_new_blocks_overwrite_forwarded_headers(self):
        block = helper.location_block("/", "1")
        for line in helper.FORWARDED_HEADERS:
            self.assertIn(line, block)
        self.assertNotIn("proxy_add_x_forwarded_for", block)
        for path in ("/", "/api"):
            self.assertFalse(helper.needs_hardening(helper.location_block(path, "1")))

    def test_harden_is_idempotent_and_replaces_append_style(self):
        config = CERTBOT_CONFIG.replace(
            "proxy_set_header Host $host;",
            "proxy_set_header Host $host;\n"
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        )
        (self.available / "a.example.com").write_text(config)
        self.assertEqual(helper.run(["harden"]), 0)
        hardened = self.config()
        self.assertEqual(hardened.count("X-Forwarded-For $remote_addr"), 2)
        self.assertEqual(hardened.count("X-Real-IP $remote_addr"), 2)
        self.assertNotIn("proxy_add_x_forwarded_for", hardened)
        self.assertIn("ssl_certificate /etc/letsencrypt", hardened)
        self.assertIn("listen 443 ssl; # managed by Certbot", hardened)
        self.assertFalse(helper.needs_hardening(hardened))
        self.assertIn(
            "ssl_reject_handshake on", (self.root / "reject.conf").read_text()
        )
        calls = len(self.called())
        self.assertEqual(helper.run(["harden"]), 0)
        self.assertEqual(self.config(), hardened)
        self.assertEqual(len(self.called()), calls)

    def test_harden_rolls_back_everything(self):
        self.fail_on("nginx -t")
        self.assertEqual(helper.run(["harden"]), 1)
        self.assertEqual(self.config(), CERTBOT_CONFIG)
        self.assertFalse((self.root / "reject.conf").exists())

    def test_symlinked_config_is_refused(self):
        target = self.root / "secret"
        target.write_text("x")
        (self.available / "s.example.com").symlink_to(target)
        self.assertEqual(helper.run(["edit-path", "s.example.com", "/", "1"]), 1)
        self.assertEqual(helper.run(["delete", "s.example.com"]), 1)
        self.assertEqual(target.read_text(), "x")

    def test_app_cannot_pass_bad_console_values(self):
        for data in (
            {"action": "add", "domain": "a.com\nb", "email": "a@b.com", "port": "1"},
            {"action": "add", "domain": "a.com", "email": "-a@b.com", "port": "1"},
            {"action": "add", "domain": "a.com", "email": "a@b.com", "port": "x"},
            {
                "action": "add",
                "domain": "a.com",
                "email": "a@b.com",
                "port": "1",
                "path": "/;",
            },
            {"action": "delete", "domain": ["a.com"]},
            {"action": "rm", "domain": "a.com"},
            {
                "action": "rename",
                "old_domain": "a.com",
                "new_domain": "x",
                "email": "a@b.com",
            },
        ):
            with self.assertRaises(ValueError):
                domain_service.console_arguments(data)
        self.assertEqual(
            domain_service.console_arguments({"action": "delete", "domain": "a.com"}),
            ["delete", "a.com"],
        )

    def test_list_reads_real_format(self):
        domains = domain_service.get_domains()
        self.assertEqual(domains[0]["domain"], "a.example.com")
        self.assertEqual(domains[0]["primary_port"], 7006)
        self.assertEqual(
            [(p["path"], p["port"]) for p in domains[0]["paths"]],
            [("/", "7006"), ("/api", "7007")],
        )


class RealConfigTest(unittest.TestCase):
    """실제 설정 파일의 복사본으로 편집 결과를 확인한다 (읽기만 하고 /etc 에 쓰지 않는다)."""

    def test_real_configs_edit_only_the_port(self):
        directory = Path("/etc/nginx/sites-available")
        if not directory.is_dir():
            self.skipTest("nginx 없음")
        for path in directory.iterdir():
            content = path.read_text(errors="replace")
            if not helper.is_valid_domain(path.name):
                continue
            target = next(
                (i for i in helper.extract_locations(content) if i["port"] != "N/A"),
                None,
            )
            if target is None:
                continue
            changed = helper.with_port_changed(content, target["path"], "65001")
            self.assertEqual(
                helper.with_port_changed(changed, target["path"], target["port"]),
                content,
                path.name,
            )
            helper.with_path_added(content, "/univdash-test", "65002")
            hardened = helper.hardened_config(content)
            self.assertEqual(helper.hardened_config(hardened), hardened, path.name)
            stripped = hardened
            for line in helper.FORWARDED_HEADERS:
                stripped = stripped.replace(f"        {line}\n", "")
            self.assertEqual(stripped, content, path.name)
            helper.renamed_config(content, "new.example.com")


if __name__ == "__main__":
    unittest.main()
