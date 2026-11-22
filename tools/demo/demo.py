"""UnivDash demo environment: a throw-away server with made-up projects, conversations and usage.

Used to take the screenshots in the README and on the website, and to try the UI without touching
your own tmux sessions, agent logins or settings. Everything lives under one folder (default
/tmp/univdash-demo): its own home folder, its own tmux socket, its own PM2 daemon and data folder.

    uv run python tools/demo/demo.py up        # build the demo world and start the server
    uv run python tools/demo/demo.py down      # stop the server, its tmux sessions and PM2 apps
    uv run python tools/demo/demo.py serve     # (used by `up`) run the server in the foreground

Login: user `alex`, password `univdash-demo-2026`, http://127.0.0.1:7999

Nothing here is real: the "agents" are tools/demo/agent.py, which only draws a screen. No request is
sent to Anthropic, OpenAI or Google, and no real account is read.
"""

import json
import os
import random
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get("UNIVDASH_DEMO_DIR", "/tmp/univdash-demo"))
HOME = ROOT / "home" / "alex"
DATA = ROOT / "data"
BIN = ROOT / "bin"
LOGS = ROOT / "transcripts"
PORT = int(os.environ.get("UNIVDASH_DEMO_PORT", "7999"))
USER, PASSWORD = "alex", "univdash-demo-2026"


def demo_env() -> dict[str, str]:
    """The environment every demo process runs in. TMUX is removed so tmux uses the demo socket only."""
    env = {k: v for k, v in os.environ.items() if k not in {"TMUX", "TMUX_PANE"}}
    env.update(
        {
            "HOME": str(HOME),
            "USER": USER,
            "LOGNAME": USER,
            "TMUX_TMPDIR": str(ROOT / "tmux"),
            "PM2_HOME": str(HOME / ".pm2"),
            "UNIVDASH_DATA_DIR": str(DATA),
            "UNIVDASH_UPLOAD_DIR": str(ROOT / "uploads"),
            "UNIVDASH_DEMO_DIR": str(ROOT),
            "AUTO_INSTALL_TOOLS": "0",
            "ADMIN_USER": USER,
            "ADMIN_PASS": PASSWORD,
            # a real .env next to the code must not leak into the demo (load_dotenv never overrides these)
            "ADMIN_PASS_HASH": "",
            "ADMIN_TOTP_SECRET": "",
            "ALLOWED_HOSTS": "",
            "GIT_REPOSITORIES": "",
            "CLAUDE_DATA_DIR": str(HOME / ".claude"),
            "CODEX_DATA_DIR": str(HOME / ".codex"),
            "GEMINI_DATA_DIR": str(HOME / ".gemini" / "antigravity-cli"),
            "SESSION_MAX_HOURS": "12",
            "SESSION_IDLE_MINUTES": "240",
            "SECRET_KEY": "demo-" + "0" * 40,
            "HOST": "127.0.0.1",
            "PORT": str(PORT),
            "SESSION_HTTPS_ONLY": "false",
            "GIT_REPOSITORY_ROOTS": str(HOME / "projects"),
            "EXPLORER_ROOTS": str(HOME),
            "PM2_ECOSYSTEM_FILE": str(HOME / "ecosystem.config.js"),
            "PATH": f"{BIN}:{os.environ.get('PATH', '')}",
            "SHELL": "/bin/bash",
        }
    )
    return env


def run(args: list[str], cwd: Path | None = None, check: bool = True) -> str:
    result = subprocess.run(
        args, cwd=cwd, env=demo_env(), capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        raise SystemExit(f"{' '.join(args[:4])} failed: {result.stderr.strip()[:300]}")
    return result.stdout


def tmux(*args: str, check: bool = True) -> str:
    # -S pins the demo socket explicitly, whatever the environment says
    # (this is the default socket for TMUX_TMPDIR, i.e. the one the demo dashboard uses too)
    socket = ROOT / "tmux" / f"tmux-{os.getuid()}" / "default"
    socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return run(["tmux", "-S", str(socket), *args], check=check)


# ── made-up projects ─────────────────────────────────────────────────────────

FILES = {
    "storefront": {
        "README.md": "# Storefront\n\nNext.js storefront for the Northfield shop.\n\n## Develop\n\n```bash\npnpm install\npnpm dev\n```\n\n## Checkout flow\n\n1. Cart → `POST /api/checkout/session`\n2. Payment provider redirects back to `/checkout/complete`\n3. Webhook `payment.succeeded` marks the order as paid\n\n| Env | URL |\n|---|---|\n| staging | https://staging.northfield.example |\n| production | https://shop.northfield.example |\n",
        "src/lib/webhooks.ts": "import { db } from './db';\nimport { verifySignature } from './signature';\n\nconst MAX_ATTEMPTS = 5;\n\nexport async function handlePaymentWebhook(request: Request) {\n  const body = await request.text();\n  if (!verifySignature(body, request.headers.get('x-signature'))) {\n    return new Response('invalid signature', { status: 401 });\n  }\n  const event = JSON.parse(body);\n  await processWithRetry(event);\n  return new Response('ok');\n}\n\nasync function processWithRetry(event: PaymentEvent, attempt = 1): Promise<void> {\n  try {\n    await db.orders.markPaid(event.orderId, event.id);\n  } catch (error) {\n    if (attempt >= MAX_ATTEMPTS) throw error;\n    await sleep(2 ** attempt * 250);\n    return processWithRetry(event, attempt + 1);\n  }\n}\n",
        "src/lib/webhooks.test.ts": "import { describe, expect, it } from 'vitest';\nimport { handlePaymentWebhook } from './webhooks';\n\ndescribe('payment webhook', () => {\n  it('rejects a bad signature', async () => {\n    const response = await handlePaymentWebhook(new Request('http://x', { method: 'POST', body: '{}' }));\n    expect(response.status).toBe(401);\n  });\n});\n",
        "package.json": '{\n  "name": "storefront",\n  "private": true,\n  "scripts": { "dev": "next dev", "test": "vitest run" }\n}\n',
    },
    "billing-api": {
        "README.md": "# Billing API\n\nFastAPI service that issues invoices and renders them to PDF.\n",
        "app/invoices/render.py": 'from weasyprint import HTML\n\n\ndef render_invoice(invoice) -> bytes:\n    """Render an invoice to PDF bytes."""\n    html = TEMPLATE.render(invoice=invoice, lines=invoice.lines)\n    return HTML(string=html).write_pdf()\n',
        "app/main.py": "from fastapi import FastAPI\n\napp = FastAPI(title='billing-api')\n",
        "pyproject.toml": '[project]\nname = "billing-api"\nversion = "0.9.2"\n',
    },
    "mobile-app": {
        "README.md": "# Mobile app\n\nReact Native client.\n",
        "app/screens/Orders.tsx": "export function Orders() {\n  return <OrderList />;\n}\n",
    },
    "data-pipeline": {
        "README.md": "# Data pipeline\n\nNightly jobs that load events into the warehouse.\n",
        "jobs/backfill_events.py": "def backfill(start, end):\n    for day in days(start, end):\n        load_partition(day)\n",
    },
    "docs-site": {
        "README.md": "# Docs\n\nPublic documentation, built with Astro.\n",
        "src/content/quickstart.md": "# Quickstart\n\nInstall the CLI and create your first project in five minutes.\n",
    },
    "infra": {
        "README.md": "# Infra\n\nTerraform and deploy scripts.\n",
        "deploy/staging.sh": "#!/usr/bin/env bash\nset -euo pipefail\npnpm prisma migrate deploy\n",
    },
    "ml-eval": {
        "README.md": "# Model evaluation\n\nOffline evaluation harness for the ranking model.\n",
        "eval/run.py": "def main():\n    print('recall@10', evaluate())\n",
    },
}

# session → (agent, state, model shown, task title, folder)
WINDOWS = [
    ("storefront", "claude", "idle", "", "Retry failed payment webhooks", "Product"),
    (
        "billing-api",
        "claude",
        "busy",
        "",
        "Refactor the invoice PDF renderer",
        "Product",
    ),
    (
        "mobile-app",
        "codex",
        "idle",
        "gpt-6.2-sol high",
        "Order list: pull to refresh",
        "Product",
    ),
    ("infra", "claude", "waiting", "", "Apply staging migrations", "Platform"),
    (
        "data-pipeline",
        "codex",
        "busy",
        "gpt-6.2-sol medium",
        "Backfill the events table",
        "Platform",
    ),
    (
        "docs-site",
        "gemini",
        "busy",
        "Gemini 3.8 Flash",
        "Rewrite the quickstart guide",
        "",
    ),
    (
        "ml-eval",
        "gemini",
        "idle",
        "Gemini 3.8 Flash",
        "Compare recall@10 across runs",
        "",
    ),
]
BINARY = {"claude": "claude", "codex": "codex", "gemini": "agy"}


def iso(minutes_ago: float) -> str:
    return (
        (datetime.now(UTC) - timedelta(minutes=minutes_ago))
        .isoformat()
        .replace("+00:00", "Z")
    )


# ── conversations (written in each agent's own log format, read by the real parser) ───────────


def claude_log(
    path: Path, cwd: Path, title: str, turns: list, model: str = "claude-opus-5-5"
) -> None:
    session = path.stem
    rows: list[dict] = [{"type": "ai-title", "aiTitle": title, "sessionId": session}]
    call = 0
    for minutes, kind, payload in turns:
        base = {"timestamp": iso(minutes), "sessionId": session, "cwd": str(cwd)}
        if kind == "user":
            rows.append(
                {
                    **base,
                    "type": "user",
                    "message": {"role": "user", "content": payload},
                }
            )
        elif kind == "say":
            rows.append(
                {
                    **base,
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "model": model,
                        "id": f"msg_{uuid.uuid4().hex[:12]}",
                        "content": [{"type": "text", "text": payload}],
                        "usage": {
                            "input_tokens": 1800,
                            "output_tokens": 420,
                            "cache_read_input_tokens": 42000,
                            "cache_creation_input_tokens": 900,
                        },
                    },
                }
            )
        elif kind == "tool":
            name, data, output = payload
            call += 1
            call_id = f"toolu_{call:04d}"
            rows.append(
                {
                    **base,
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "model": model,
                        "id": f"msg_{uuid.uuid4().hex[:12]}",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": call_id,
                                "name": name,
                                "input": data,
                            }
                        ],
                        "usage": {
                            "input_tokens": 900,
                            "output_tokens": 160,
                            "cache_read_input_tokens": 41000,
                            "cache_creation_input_tokens": 300,
                        },
                    },
                }
            )
            if output is not None:
                rows.append(
                    {
                        **base,
                        "type": "user",
                        "message": {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": call_id,
                                    "content": output,
                                }
                            ],
                        },
                    }
                )
        elif kind == "done":
            rows.append(
                {
                    **base,
                    "type": "system",
                    "subtype": "turn_duration",
                    "durationMs": 61000,
                }
            )
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )


def codex_log(path: Path, cwd: Path, turns: list, model: str) -> None:
    rows: list[dict] = [
        {
            "type": "session_meta",
            "timestamp": iso(90),
            "payload": {"id": path.stem[-36:], "cwd": str(cwd), "timestamp": iso(90)},
        }
    ]
    call = 0
    for minutes, kind, payload in turns:
        ts = iso(minutes)
        if kind == "user":
            rows += [
                {
                    "type": "event_msg",
                    "timestamp": ts,
                    "payload": {
                        "type": "task_started",
                        "turn_attribution": {"turn_trigger": "user"},
                    },
                },
                {"type": "turn_context", "timestamp": ts, "payload": {"model": model}},
                {
                    "type": "response_item",
                    "timestamp": ts,
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": payload}],
                    },
                },
            ]
        elif kind == "say":
            rows.append(
                {
                    "type": "response_item",
                    "timestamp": ts,
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": payload}],
                    },
                }
            )
        elif kind == "tool":
            name, data, output = payload
            call += 1
            rows.append(
                {
                    "type": "response_item",
                    "timestamp": ts,
                    "payload": {
                        "type": "function_call",
                        "name": name,
                        "call_id": f"call_{call}",
                        "arguments": json.dumps(data),
                    },
                }
            )
            if output is not None:
                rows.append(
                    {
                        "type": "response_item",
                        "timestamp": ts,
                        "payload": {
                            "type": "function_call_output",
                            "call_id": f"call_{call}",
                            "output": output,
                        },
                    }
                )
        elif kind == "done":
            rows.append(
                {
                    "type": "event_msg",
                    "timestamp": ts,
                    "payload": {"type": "task_complete"},
                }
            )
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )


def gemini_log(path: Path, turns: list, model: str = "gemini-3.8-flash-high") -> None:
    rows: list[dict] = []
    for index, (minutes, kind, payload) in enumerate(turns):
        base = {"step_index": index, "status": "DONE", "created_at": iso(minutes)}
        if kind == "user":
            rows.append(
                {
                    **base,
                    "source": "USER_EXPLICIT",
                    "type": "USER_INPUT",
                    "content": f"<USER_REQUEST>\n{payload}\n</USER_REQUEST>",
                }
            )
        elif kind == "say":
            rows.append(
                {
                    **base,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "model": model,
                    "input_tokens": 2400,
                    "cache_read_tokens": 7000,
                    "output_tokens": 380,
                    "content": payload,
                }
            )
        elif kind == "tool":
            name, data, output = payload
            rows.append(
                {
                    **base,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "model": model,
                    "input_tokens": 2100,
                    "cache_read_tokens": 6800,
                    "output_tokens": 90,
                    "tool_calls": [{"name": name, "args": data}],
                    "content": "",
                }
            )
            if output is not None:
                rows.append(
                    {**base, "source": "MODEL", "type": "GENERIC", "content": output}
                )
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )


def conversations(projects: Path) -> dict[str, Path]:
    """Writes every window's conversation and returns session → log file."""
    logs: dict[str, Path] = {}

    def new(session: str, prefix: str = "") -> Path:
        path = LOGS / f"{prefix}{uuid.uuid4()}.jsonl"
        logs[session] = path
        return path

    store = projects / "storefront"
    old = "  try {\n    await db.orders.markPaid(event.orderId, event.id);\n  } catch (error) {\n    if (attempt >= MAX_ATTEMPTS) throw error;\n    await sleep(2 ** attempt * 250);\n    return processWithRetry(event, attempt + 1);\n  }"
    new_code = "  try {\n    await db.orders.markPaid(event.orderId, event.id);\n  } catch (error) {\n    if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) {\n      await deadLetter.push(event, error);\n      throw error;\n    }\n    await sleep(backoff(attempt));\n    return processWithRetry(event, attempt + 1);\n  }"
    claude_log(
        new("storefront"),
        store,
        "Retry failed payment webhooks",
        [
            (
                26,
                "user",
                "Payment webhooks sometimes fail when the database is briefly unavailable and the order stays unpaid. Make the handler retry safely and keep the events we could not process.",
            ),
            (
                25,
                "say",
                "I'll look at how the webhook handler retries today, then check the tests.",
            ),
            (
                25,
                "tool",
                (
                    "Read",
                    {"file_path": "src/lib/webhooks.ts"},
                    "import { db } from './db';\n…\nasync function processWithRetry(event: PaymentEvent, attempt = 1): Promise<void> {",
                ),
            ),
            (
                24,
                "tool",
                (
                    "Grep",
                    {"pattern": "markPaid", "path": "src"},
                    "src/lib/webhooks.ts:18\nsrc/lib/db.ts:42\nsrc/lib/orders.ts:77",
                ),
            ),
            (
                23,
                "say",
                "Two problems in the current retry loop:\n\n- It retries **every** error, including ones that can never succeed (unknown order, duplicate event).\n- When the last attempt fails the event is lost, because nothing stores it.\n\nI'll retry only transient errors, add jitter to the backoff, and push exhausted events to a dead-letter table.",
            ),
            (
                22,
                "tool",
                (
                    "Edit",
                    {
                        "file_path": "src/lib/webhooks.ts",
                        "old_string": old,
                        "new_string": new_code,
                    },
                    "The file has been updated.",
                ),
            ),
            (
                21,
                "tool",
                (
                    "Write",
                    {
                        "file_path": "src/lib/dead-letter.ts",
                        "content": "import { db } from './db';\n\nexport const deadLetter = {\n  async push(event: PaymentEvent, error: unknown) {\n    await db.webhookFailures.insert({\n      eventId: event.id,\n      payload: event,\n      reason: String(error),\n    });\n  },\n};\n",
                    },
                    "File created.",
                ),
            ),
            (
                20,
                "tool",
                (
                    "Bash",
                    {
                        "command": "pnpm vitest run src/lib/webhooks.test.ts",
                        "description": "Run the webhook tests",
                    },
                    " ✓ src/lib/webhooks.test.ts (7 tests) 412ms\n   ✓ rejects a bad signature\n   ✓ retries a transient database error\n   ✓ does not retry an unknown order\n   ✓ stores the event after the last attempt\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)",
                ),
            ),
            (
                19,
                "say",
                "The webhook handler now retries only transient failures and keeps every event it could not process. All 7 tests pass.\n\n**What changed**\n\n| File | Change |\n|---|---|\n| `src/lib/webhooks.ts` | Retry only transient errors, backoff with jitter |\n| `src/lib/dead-letter.ts` | New: stores events that ran out of attempts |\n| `src/lib/webhooks.test.ts` | 4 new cases |\n\n**Decision for you:** failed events are kept in `webhook_failures` but nothing replays them yet. I can add a `pnpm webhooks:replay` command; say so if you want it.",
            ),
            (19, "done", None),
        ],
    )
    billing = projects / "billing-api"
    claude_log(
        new("billing-api"),
        billing,
        "Refactor the invoice PDF renderer",
        [
            (
                9,
                "user",
                "The invoice renderer is one 400-line function. Split it so line items, taxes and totals can be tested separately. Keep the PDF output byte-identical.",
            ),
            (
                8,
                "say",
                "I'll snapshot the current PDF for three sample invoices first, so I can prove the output does not change.",
            ),
            (
                8,
                "tool",
                (
                    "Bash",
                    {
                        "command": "uv run pytest tests/invoices -q",
                        "description": "Run the invoice tests",
                    },
                    "12 passed in 3.41s",
                ),
            ),
            (
                7,
                "tool",
                (
                    "Read",
                    {"file_path": "app/invoices/render.py"},
                    "def render_invoice(invoice) -> bytes:",
                ),
            ),
            (
                6,
                "say",
                "Snapshots are in place. Splitting the renderer into `lines.py`, `taxes.py` and `totals.py` now.",
            ),
            (
                5,
                "tool",
                (
                    "Edit",
                    {
                        "file_path": "app/invoices/render.py",
                        "old_string": "    html = TEMPLATE.render(invoice=invoice, lines=invoice.lines)",
                        "new_string": "    lines = build_lines(invoice)\n    totals = build_totals(lines, tax_rules_for(invoice))\n    html = TEMPLATE.render(invoice=invoice, lines=lines, totals=totals)",
                    },
                    None,
                ),
            ),
        ],
    )
    infra = projects / "infra"
    claude_log(
        new("infra"),
        infra,
        "Apply staging migrations",
        [
            (
                4,
                "user",
                "Staging is two migrations behind. Apply them and confirm the schema matches.",
            ),
            (
                4,
                "say",
                "Two migrations are pending on staging: `20261118_add_webhook_failures` and `20261120_order_paid_at_index`. Both are additive. I'll apply them now.",
            ),
            (
                3,
                "tool",
                (
                    "Bash",
                    {
                        "command": "pnpm prisma migrate deploy",
                        "description": "Apply pending migrations to the staging database",
                    },
                    None,
                ),
            ),
        ],
        model="claude-sonnet-5-5",
    )
    mobile = projects / "mobile-app"
    codex_log(
        new("mobile-app", "rollout-2026-11-22T10-12-03-"),
        mobile,
        [
            (
                38,
                "user",
                "Add pull-to-refresh to the order list and show a skeleton while the first page loads.",
            ),
            (
                37,
                "tool",
                (
                    "shell",
                    {"command": 'rg -n "OrderList" app'},
                    "app/screens/Orders.tsx:2\napp/components/OrderList.tsx:11",
                ),
            ),
            (
                36,
                "say",
                "The order list now refreshes on pull and shows six skeleton rows during the first load. I ran the component tests (9 passed) and checked it on the iOS simulator.",
            ),
            (36, "done", None),
        ],
        "gpt-6.2-sol",
    )
    pipeline = projects / "data-pipeline"
    codex_log(
        new("data-pipeline", "rollout-2026-11-22T11-40-51-"),
        pipeline,
        [
            (
                6,
                "user",
                "Backfill the events table for October. Run it day by day and stop on the first failed partition.",
            ),
            (
                5,
                "say",
                "Starting the backfill for 2026-10-01 to 2026-10-31. I'll report after each week.",
            ),
            (
                4,
                "tool",
                (
                    "shell",
                    {
                        "command": "uv run python jobs/backfill_events.py --start 2026-10-01 --end 2026-10-07"
                    },
                    "2026-10-01 ok 1,204,331 rows\n2026-10-02 ok 1,198,870 rows\n2026-10-03 ok 1,251,090 rows",
                ),
            ),
        ],
        "gpt-6.2-sol",
    )
    gemini_log(
        new("docs-site"),
        [
            (
                7,
                "user",
                "Rewrite the quickstart so a new user reaches a working project in five minutes. Keep every command copy-pasteable.",
            ),
            (
                6,
                "tool",
                (
                    "read_file",
                    {"Path": "src/content/quickstart.md"},
                    "Showing lines 1-3 of 3\n1: # Quickstart",
                ),
            ),
            (
                5,
                "say",
                "The current page explains concepts before the first command. I'll lead with install → create → run, and move the concepts to a link at the end.",
            ),
        ],
    )
    gemini_log(
        new("ml-eval"),
        [
            (
                52,
                "user",
                "Compare recall@10 for the last three evaluation runs and tell me which change moved it.",
            ),
            (
                51,
                "tool",
                (
                    "run_command",
                    {"CommandLine": "uv run python eval/run.py --compare last3"},
                    "Command exited with code 0.\n\nrun-41  recall@10 0.712\nrun-42  recall@10 0.709\nrun-43  recall@10 0.731",
                ),
            ),
            (
                50,
                "say",
                "Recall@10 rose from **0.709 to 0.731** in run-43. The only change in that run is the new negative sampling (hard negatives from the same category), so that is what moved it. Run-42 was within noise of run-41.",
            ),
        ],
    )
    return logs


# ── build ────────────────────────────────────────────────────────────────────


def build() -> None:
    if ROOT.exists():
        down(quiet=True)
        shutil.rmtree(ROOT, ignore_errors=True)
    for folder in (HOME, DATA, BIN, LOGS, ROOT / "tmux", ROOT / "uploads"):
        folder.mkdir(parents=True, exist_ok=True)
    os.chmod(ROOT / "tmux", 0o700)
    for name in BINARY.values():  # tmux then reports the agent's process name
        (BIN / name).symlink_to(
            sys.executable
            if not os.path.islink(sys.executable)
            else os.path.realpath(sys.executable)
        )

    projects = HOME / "projects"
    for project, files in FILES.items():
        for relative, text in files.items():
            path = projects / project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
    (HOME / "notes").mkdir()
    (HOME / "notes" / "release-checklist.md").write_text(
        "# Release checklist\n\n- [x] Changelog updated\n- [x] Staging deploy green\n- [ ] Announce in #releases\n",
        encoding="utf-8",
    )

    git = [
        "git",
        "-c",
        "user.name=Alex Kim",
        "-c",
        "user.email=alex@example.com",
        "-c",
        "init.defaultBranch=main",
    ]
    for project in FILES:
        folder = projects / project
        run([*git, "init", "-q"], cwd=folder)
        run(["git", "config", "user.name", "Alex Kim"], cwd=folder)
        run(["git", "config", "user.email", "alex@example.com"], cwd=folder)
        run([*git, "add", "-A"], cwd=folder)
        run([*git, "commit", "-qm", "Initial commit"], cwd=folder)
    # a few more commits and uncommitted work so the Git page has something to show
    store = projects / "storefront"
    for message, relative, text in [
        (
            "Add checkout session endpoint",
            "src/app/api/checkout/route.ts",
            "export async function POST() {\n  return Response.json({ ok: true });\n}\n",
        ),
        (
            "Verify webhook signatures",
            "src/lib/signature.ts",
            "export function verifySignature(body: string, signature: string | null) {\n  return Boolean(signature);\n}\n",
        ),
        (
            "Show order status on the account page",
            "src/app/account/page.tsx",
            "export default function Account() {\n  return <Orders />;\n}\n",
        ),
    ]:
        path = store / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        run([*git, "add", "-A"], cwd=store)
        run([*git, "commit", "-qm", message], cwd=store)
    run([*git, "checkout", "-qb", "fix/webhook-retries"], cwd=store)
    (store / "src/lib/dead-letter.ts").write_text(
        "import { db } from './db';\n\nexport const deadLetter = {\n  async push(event: PaymentEvent, error: unknown) {\n    await db.webhookFailures.insert({ eventId: event.id, payload: event, reason: String(error) });\n  },\n};\n",
        encoding="utf-8",
    )
    text = (store / "src/lib/webhooks.ts").read_text(encoding="utf-8")
    (store / "src/lib/webhooks.ts").write_text(
        text.replace(
            "    if (attempt >= MAX_ATTEMPTS) throw error;\n    await sleep(2 ** attempt * 250);",
            "    if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) {\n      await deadLetter.push(event, error);\n      throw error;\n    }\n    await sleep(backoff(attempt));",
        ),
        encoding="utf-8",
    )
    run([*git, "add", "src/lib/dead-letter.ts"], cwd=store)

    logs = conversations(projects)

    # tmux: one session per project, each running the stand-in agent
    agent = REPO / "tools" / "demo" / "agent.py"
    for session, kind, state, model, title, _folder in WINDOWS:
        command = [
            BINARY[kind],
            str(agent),
            "--agent",
            kind,
            "--state",
            state,
            "--title",
            title,
            "--model",
            model,
            "--log",
            str(logs[session]),
        ]
        tmux(
            "new-session",
            "-d",
            "-s",
            session,
            "-x",
            "150",
            "-y",
            "42",
            "-c",
            str(projects / session),
            " ".join(f"'{part}'" for part in command),
        )
    tmux(
        "new-session",
        "-d",
        "-s",
        "scratch",
        "-x",
        "150",
        "-y",
        "42",
        "-c",
        str(HOME),
        "bash --norc",
    )

    folders: dict[str, list[str]] = {}
    for session, *_rest, folder in WINDOWS:
        if folder:
            folders.setdefault(folder, []).append(f"{session}:0")
    # the demo is not asked to set up two-factor authentication (keeps the screenshots clean)
    (DATA / "totp.json").write_text(json.dumps({"dismissed": True}), encoding="utf-8")
    (DATA / "preferences.json").write_text(
        json.dumps(
            {
                "folders": [
                    {
                        "id": f"demo{index}",
                        "name": name,
                        "color": color,
                        "collapsed": False,
                        "items": items,
                    }
                    for index, ((name, items), color) in enumerate(
                        zip(folders.items(), ["blue", "emerald"], strict=False)
                    )
                ],
                "order": ["docs-site:0", "ml-eval:0", "scratch:0"],
                "hidden": [],
                "aliases": {},
                "notes": {},
                "sort": "manual",
            }
        ),
        encoding="utf-8",
    )

    # PM2: three tiny apps in the demo's own daemon (PM2_HOME is inside the demo folder)
    if shutil.which("pm2"):
        apps = HOME / "apps"
        apps.mkdir()
        (apps / "tick.js").write_text(
            "setInterval(() => console.log(new Date().toISOString(), 'ok'), 5000);\n",
            encoding="utf-8",
        )
        (HOME / "ecosystem.config.js").write_text(
            "module.exports = {\n  apps: [\n"
            + "".join(
                f"    {{ name: '{name}', script: './apps/tick.js', cwd: '{HOME}' }},\n"
                for name in ("storefront-web", "billing-api", "queue-worker")
            )
            + "  ],\n};\n",
            encoding="utf-8",
        )
        run(["pm2", "start", str(HOME / "ecosystem.config.js")], cwd=HOME, check=False)


def up() -> None:
    build()
    log = (ROOT / "server.log").open("w")
    server = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "serve"],
        cwd=REPO,
        env=demo_env(),
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    (ROOT / "server.pid").write_text(str(server.pid))
    print(
        f"Demo is starting: http://127.0.0.1:{PORT}  (user {USER} / password {PASSWORD})"
    )
    print("Stop it with: uv run python tools/demo/demo.py down")


def down(quiet: bool = False) -> None:
    # Only the demo's own server process, tmux server (private socket) and PM2 daemon (private PM2_HOME) are stopped.
    try:
        server = int((ROOT / "server.pid").read_text())
        cmdline = Path(f"/proc/{server}/cmdline").read_bytes().decode(errors="replace")
        if "demo.py" in cmdline and "serve" in cmdline:
            os.kill(server, 15)
    except (OSError, ValueError):
        pass
    socket_dir = ROOT / "tmux"
    if socket_dir.exists():
        # Safety: act only on the tmux server whose socket is inside the demo folder.
        answer = tmux(
            "display-message", "-p", "#{pid} #{socket_path}", check=False
        ).split()
        pid = answer[0] if len(answer) == 2 else ""
        if pid.isdigit() and not answer[1].startswith(str(socket_dir.resolve()) + "/"):
            raise SystemExit(
                f"Refusing to stop tmux: {answer[1]} is not the demo socket."
            )
        if pid.isdigit():
            for session in tmux(
                "list-sessions", "-F", "#{session_name}", check=False
            ).split():
                for pane in tmux(
                    "list-panes",
                    "-s",
                    "-t",
                    f"={session}",
                    "-F",
                    "#{pane_pid}",
                    check=False,
                ).split():
                    if pane.isdigit():
                        subprocess.run(["pkill", "-TERM", "-P", pane], check=False)
                        subprocess.run(["kill", "-TERM", pane], check=False)
            time.sleep(0.5)
            subprocess.run(["kill", "-TERM", pid], check=False)
    if (HOME / ".pm2").exists() and shutil.which("pm2"):
        run(["pm2", "kill"], check=False)
    if not quiet:
        print("Demo stopped.")


# ── server with made-up accounts and usage ───────────────────────────────────


def patch_app() -> None:
    """Replace everything that would read a real login or call a provider with fixed demo data."""
    import psutil

    from app.i18n import _
    from app.services.accounts import (
        claude_accounts,
        codex_accounts,
        gemini_accounts,
        gemini_service,
    )
    from app.services.accounts.ai_usage_service import AIUsageService, _Stats
    from app.services.agents import transcript_service
    from app.services.llm_api import llm_api_service, llm_sandbox

    # the isolated container belongs to a real installation: the demo never creates or stops one
    async def nothing(*_args, **_kwargs) -> None:
        return None

    llm_sandbox.CONTAINER = "univdash-llm-demo"
    llm_sandbox.ensure_container = nothing
    llm_sandbox.stop_container = nothing
    llm_sandbox.container_running = lambda: True
    llm_sandbox.problem = lambda: None

    def find_log(pane_pid: int, agent: str | None, cwd: str):
        proc = transcript_service._agent_process(pane_pid, agent) if agent else None
        try:
            argv = proc.cmdline() if proc else []
        except psutil.Error:
            return None
        if "--log" in argv:
            path = Path(argv[argv.index("--log") + 1])
            return path if path.is_file() else None
        return None

    transcript_service.find_log = find_log

    accounts = {
        "claude": [
            ("a1b2c3d4e5f6", "alex@example.com", "Max 20x", True),
            ("b2c3d4e5f6a1", "team@example.com", "Team", False),
        ],
        "codex": [("c3d4e5f6a1b2", "alex@example.com", "Pro", True)],
        "gemini": [("d4e5f6a1b2c3", "alex@example.com", "Google AI Pro", True)],
    }

    def listing(provider: str):
        def result() -> dict:
            rows = [
                {
                    "id": i,
                    "email": e,
                    "plan": p,
                    "saved_at": time.time() - 86400,
                    "active": a,
                }
                for i, e, p, a in accounts[provider]
            ]
            return {
                "accounts": rows,
                "active": next(r["id"] for r in rows if r["active"]),
            }

        return result

    claude_accounts.list_accounts = listing("claude")
    codex_accounts.list_accounts = listing("codex")
    gemini_accounts.list_accounts = listing("gemini")
    gemini_service.models = lambda: [
        {"id": f"gemini-3.8-flash-{e}", "name": f"Gemini 3.8 Flash ({e.title()})"}
        for e in ("high", "medium", "low")
    ]
    llm_api_service.codex_models = lambda: [
        "gpt-6.2-sol",
        "gpt-6.2-luna",
        "gpt-6-codex",
    ]

    def limits_for(now: datetime) -> dict:
        window = AIUsageService._window
        soon = (now + timedelta(hours=3, minutes=12)).isoformat()
        week = (now + timedelta(days=4, hours=6)).isoformat()
        return {
            "claude": {
                "plan": "Max 20x",
                "updated_at": now.isoformat(),
                "breakdown": [],
                "credits": None,
                "windows": [
                    window("claude-session-", _("현재 세션"), 38, soon, 300, now),
                    window(
                        "claude-weekly_all-",
                        _("주간 · 전체 모델"),
                        21,
                        week,
                        10080,
                        now,
                    ),
                    window(
                        "claude-weekly_scoped-Opus",
                        _("주간 · Opus"),
                        34,
                        week,
                        10080,
                        now,
                    ),
                ],
            },
            "codex": {
                "plan": "Pro",
                "updated_at": now.isoformat(),
                "breakdown": [],
                "credits": None,
                "windows": [
                    window("codex-primary", _("현재 세션"), 12, soon, 300, now),
                    window("codex-secondary", _("주간"), 47, week, 10080, now),
                ],
            },
            "gemini": {
                "plan": "Google AI Pro",
                "updated_at": now.isoformat(),
                "breakdown": [],
                "credits": None,
                "windows": [
                    {
                        **window(
                            "gemini-1p-5h", _("현재 세션 · Gemini"), 9, soon, 300, now
                        ),
                        "group": "gemini",
                    },
                    {
                        **window(
                            "gemini-3p-5h",
                            f"{_('현재 세션')} · Claude · GPT",
                            3,
                            soon,
                            300,
                            now,
                        ),
                        "group": "other",
                    },
                    {
                        **window(
                            "gemini-3p-weekly",
                            f"{_('주간')} · Claude · GPT",
                            11,
                            week,
                            10080,
                            now,
                        ),
                        "group": "other",
                    },
                ],
            },
        }

    emails = {
        "claude": "alex@example.com",
        "codex": "alex@example.com",
        "gemini": "alex@example.com",
    }

    def limits() -> dict:
        now = datetime.now().astimezone()
        return {**limits_for(now), "accounts": emails, "generated_at": now.isoformat()}

    def get_usage(days: int = 7) -> dict:
        days = max(1, min(days, 30))
        now = datetime.now().astimezone()
        dates = [
            now.date() - timedelta(days=offset) for offset in range(days - 1, -1, -1)
        ]
        live = limits_for(now)
        providers = []
        for provider, name, accent, command, models, scale in [
            (
                "claude",
                "Claude Code",
                "#d97757",
                "claude",
                ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
                1.0,
            ),
            (
                "codex",
                "Codex",
                "#10a37f",
                "codex",
                ["gpt-6.2-sol", "gpt-6.2-luna"],
                0.55,
            ),
            (
                "gemini",
                "Gemini",
                "#4285f4",
                "agy",
                ["gemini-3.8-flash-high", "gemini-3.8-flash-low"],
                0.3,
            ),
        ]:
            rng = random.Random(f"univdash-{provider}")
            summary = AIUsageService._empty_summary(
                provider_id=provider,
                name=name,
                accent=accent,
                command=command,
                auth_files=[],
                env_keys=[],
                files=[Path("demo")],
                dates=dates,
            )
            stats = _Stats()
            for day_index, day in enumerate(dates):
                weekday = day.weekday() < 5
                for _request in range(
                    int((70 if weekday else 22) * scale * rng.uniform(0.6, 1.3))
                ):
                    hour = min(23, max(0, int(rng.gauss(14, 4))))
                    if day == now.date() and hour > now.hour:
                        continue
                    stamp = datetime.combine(
                        day, datetime.min.time(), tzinfo=now.tzinfo
                    ) + timedelta(hours=hour, minutes=rng.randrange(60))
                    fresh, out, cached = (
                        rng.randrange(400, 6000),
                        rng.randrange(80, 2400),
                        rng.randrange(8000, 90000),
                    )
                    total = fresh + out + cached
                    if AIUsageService._add_usage(
                        summary,
                        stamp,
                        input_tokens=fresh,
                        output_tokens=out,
                        cache_read=cached,
                        cache_write=rng.randrange(0, 900)
                        if provider == "claude"
                        else 0,
                        total_tokens=total,
                        reasoning_tokens=rng.randrange(0, 600)
                        if provider != "claude"
                        else 0,
                    ):
                        stats.add(
                            model=rng.choices(models, weights=[6, 3, 1][: len(models)])[
                                0
                            ],
                            project=rng.choice(list(FILES)),
                            session=f"{provider}-{day_index}-{rng.randrange(6)}",
                            tokens=total,
                        )
            stats.apply(summary, AIUsageService._top_items)
            prompt = (
                summary["input_tokens"]
                + summary["cache_read_tokens"]
                + summary["cache_write_tokens"]
            )
            summary["cache_hit_rate"] = (
                summary["cache_read_tokens"] / prompt if prompt else None
            )
            summary.update(
                connected=True,
                installed=True,
                status="connected",
                account=emails[provider],
                limits=live[provider],
                active=True if provider == "claude" else None,
                logged_in=True,
                login_expired=False,
                login_stale=False,
            )
            providers.append(AIUsageService._finalize_summary(summary, now))
        saved = [
            {
                "id": "b2c3d4e5f6a1",
                "email": "team@example.com",
                "plan": "Team",
                "active": False,
                "login_expired": False,
                "limits": {
                    "plan": "Team",
                    "updated_at": now.isoformat(),
                    "breakdown": [],
                    "credits": None,
                    "windows": [
                        AIUsageService._window(
                            "claude-session-",
                            _("현재 세션"),
                            4,
                            (now + timedelta(hours=4)).isoformat(),
                            300,
                            now,
                        ),
                        AIUsageService._window(
                            "claude-weekly_all-",
                            _("주간 · 전체 모델"),
                            62,
                            (now + timedelta(days=2)).isoformat(),
                            10080,
                            now,
                        ),
                    ],
                },
            }
        ]
        return {
            "generated_at": now.isoformat(),
            "window_days": days,
            "providers": providers,
            "claude_accounts": saved,
            "gemini_accounts": [],
        }

    AIUsageService.limits = classmethod(lambda cls: limits())
    AIUsageService.get_usage = classmethod(lambda cls, days=7: get_usage(days))
    AIUsageService.accounts = classmethod(lambda cls: emails)

    # OpenAI-compatible API: two API keys and a short request history
    if not llm_api_service.state()["tokens"]:
        llm_api_service.update_settings({"enabled": True})
        _secret, ci = llm_api_service.create_token({"name": "ci-review-bot"})
        _secret, notebook = llm_api_service.create_token({"name": "notebook"})
        rng = random.Random(7)
        with llm_api_service._lock:
            records = llm_api_service._load()["tokens"]
        for index in range(14):
            public = ci if index % 3 else notebook
            record = next(r for r in records.values() if r["id"] == public["id"])
            model, provider = rng.choice(
                [
                    ("claude/sonnet", "claude"),
                    ("claude/haiku", "claude"),
                    ("codex/gpt-6.2-sol", "codex"),
                    ("gemini/gemini-3.8-flash-low", "gemini"),
                ]
            )
            llm_api_service.record_request(
                record,
                {
                    "model": model,
                    "provider": provider,
                    "account": "alex@example.com",
                    "status": 200 if index != 5 else 429,
                    "error": None if index != 5 else "rate_limit_exceeded",
                    "stream": bool(index % 2),
                    "ms": rng.randrange(1400, 7200),
                    "input_tokens": rng.randrange(300, 5200),
                    "output_tokens": rng.randrange(40, 900),
                    "ip": "10.0.0.12",
                },
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": "Summarize the changes in this pull request.",
                        }
                    ],
                    "answer": "The pull request adds retry handling to the payment webhook and a dead-letter table for events that ran out of attempts.",
                    "error": "",
                },
            )


def serve() -> None:
    os.environ.update(demo_env())
    os.chdir(REPO)
    sys.path.insert(0, str(REPO))
    import uvicorn

    patch_app()
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "up":
        up()
    elif command == "down":
        down()
    elif command == "serve":
        serve()
    else:
        raise SystemExit(__doc__)
