"""Take the README / website screenshots from the running demo server (tools/demo/demo.py up).

    uv run --with playwright python tools/demo/capture.py [--out docs/assets/screens] [--only name,name] [--lang en|ko]

Uses the Chrome installed on this machine (no browser download). Every picture comes from the demo
world, so no real project, account or host name can appear in them.
"""

import argparse
import os
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("UNIVDASH_DEMO_PORT", "7999"))
BASE = f"http://127.0.0.1:{PORT}"
USER, PASSWORD = "alex", "univdash-demo-2026"
DESKTOP = {"width": 1600, "height": 1000}
PHONE = {"width": 390, "height": 844}


def login(page: Page) -> None:
    page.goto(f"{BASE}/login")
    page.fill("#username", USER)
    page.fill("#password", PASSWORD)
    page.press("#password", "Enter")
    page.wait_for_url(f"{BASE}/")


def open_window(page: Page, name: str) -> None:
    """Open a window from the list by its session name and wait for the chat to render."""
    page.locator(f"text={name}").first.click()
    page.wait_for_timeout(1800)


def shots(page: Page, phone: bool) -> dict:
    """name → function that brings the page to the state to capture."""

    def workspace() -> None:
        page.goto(f"{BASE}/")
        page.wait_for_timeout(1500)
        open_window(page, "storefront")

    def waiting() -> None:
        page.goto(f"{BASE}/")
        page.wait_for_timeout(1500)
        open_window(page, "infra")

    def simple(path: str, wait: int = 2500):
        def go() -> None:
            page.goto(f"{BASE}{path}")
            page.wait_for_timeout(wait)

        return go

    def api_tab() -> None:
        page.goto(f"{BASE}/ai-usage")
        page.wait_for_timeout(1500)
        page.get_by_text("OpenAI", exact=False).first.click()
        page.wait_for_timeout(1500)

    def window_list() -> None:
        page.goto(f"{BASE}/")
        page.wait_for_timeout(2000)

    def git() -> None:
        page.goto(f"{BASE}/git")
        page.wait_for_timeout(2500)
        page.get_by_text("storefront", exact=True).first.click()
        page.wait_for_timeout(2500)
        if not phone:
            page.get_by_text("webhooks.ts", exact=False).first.click()
            page.wait_for_timeout(1500)

    def explorer() -> None:
        page.goto(f"{BASE}/explorer")
        page.wait_for_timeout(2500)
        for name in ("projects", "storefront", "README.md"):
            page.get_by_text(name, exact=True).first.click()
            page.wait_for_timeout(900)
        page.wait_for_timeout(1200)

    table = {
        "workspace": workspace,
        "waiting": waiting,
        "usage": simple("/ai-usage", 3500),
        "api": api_tab,
        "git": git,
        "server": simple("/server", 4000),
        "explorer": explorer,
    }
    if phone:
        table = {
            "list": window_list,
            "workspace": workspace,
            "usage": simple("/ai-usage", 3500),
            "git": simple("/git", 3500),
        }
    return table


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(REPO / "docs" / "assets" / "screens"))
    parser.add_argument("--only", default="")
    parser.add_argument("--lang", default="en")
    parser.add_argument("--scheme", default="dark")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {name for name in args.only.split(",") if name}
    locale = "ko-KR" if args.lang == "ko" else "en-US"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        for kind, viewport, scale in (("desktop", DESKTOP, 2), ("mobile", PHONE, 3)):
            context = browser.new_context(
                viewport=viewport,
                device_scale_factor=scale,
                locale=locale,
                color_scheme=args.scheme,
                is_mobile=kind == "mobile",
                has_touch=kind == "mobile",
                user_agent=None
                if kind == "desktop"
                else "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            )
            context.add_cookies(
                [{"name": "univdash_lang", "value": args.lang, "url": BASE}]
            )
            page = context.new_page()
            login(page)
            for name, prepare in shots(page, kind == "mobile").items():
                label = f"{kind}-{name}"
                if only and label not in only and name not in only:
                    continue
                try:
                    prepare()
                    page.screenshot(path=str(out / f"{label}.png"))
                    print("saved", label)
                except Exception as error:  # noqa: BLE001 — keep going, report at the end
                    print(
                        "FAILED",
                        label,
                        str(error).splitlines()[0][:160],
                        file=sys.stderr,
                    )
            context.close()
        browser.close()


if __name__ == "__main__":
    main()
