"""A stand-in coding agent for the demo: draws a believable agent screen in a tmux pane and waits.

It is started through a symlink named `claude`, `codex` or `agy` (→ python3) so tmux reports the same
process name as the real CLI. It never talks to any service and ignores whatever is typed into it.

    claude tools/demo/agent.py --agent claude --state busy --title "Refactor billing webhooks" --log <file>
"""

import argparse
import os
import shutil
import signal
import sys
import termios
import time

SPIN = {"claude": "✶", "codex": "•", "gemini": "⣽"}


def screen(
    agent: str, state: str, model: str, lines: list[str], cols: int
) -> list[str]:
    rule = "─" * cols
    out = list(lines)
    if agent == "claude":
        if state == "busy":
            out += ["", "✶ Forging… (1m 12s · ↓ 3.4k tokens · esc to interrupt)"]
        if state == "waiting":
            return out + [
                "",
                "Bash command",
                "",
                "  pnpm prisma migrate deploy",
                "  Apply pending migrations to the staging database",
                "",
                "Do you want to proceed?",
                "❯ 1. Yes",
                "  2. Yes, and don't ask again for pnpm prisma commands",
                "  3. No, and tell Claude what to do differently (esc)",
            ]
        return out + [
            "",
            rule,
            "❯ ",
            rule,
            f"  ⏵⏵ bypass permissions on (shift+tab to cycle){' · esc to interrupt' if state == 'busy' else ''}",
        ]
    if agent == "codex":
        if state == "busy":
            out += ["", "• Working (48s • esc to interrupt)"]
        return out + ["", "› ", "", f"  {model} · ~/projects · ? for shortcuts"]
    # gemini (Antigravity CLI)
    effort = "high"
    footer_left = "esc to cancel" if state == "busy" else "? for shortcuts"
    footer = (
        footer_left
        + " " * max(2, cols - len(footer_left) - len(model) - len(effort) - 3)
        + f"{model} · {effort}"
    )
    if state == "busy":
        out += ["⣽  Generating..."]
    return out + [rule, "> ", rule, footer]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True)
    parser.add_argument("--state", default="idle")
    parser.add_argument("--title", default="")
    parser.add_argument("--model", default="")
    parser.add_argument(
        "--log", default=""
    )  # read by the demo server to find this window's conversation
    parser.add_argument(
        "--screen", default=""
    )  # text file with the visible conversation
    args = parser.parse_args()

    body: list[str] = []
    if args.screen and os.path.exists(args.screen):
        with open(args.screen, encoding="utf-8") as handle:
            body = handle.read().splitlines()

    def draw(*_) -> None:
        size = shutil.get_terminal_size((120, 40))
        rows = screen(args.agent, args.state, args.model, body, size.columns)
        rows = rows[-(size.lines - 1) :]
        prefix = (
            "⠐ "
            if args.state == "busy" and args.agent == "claude"
            else "✳ "
            if args.agent == "claude"
            else ""
        )
        sys.stdout.write(
            f"\033]2;{prefix}{args.title}\007\033[2J\033[H" + "\n".join(rows)
        )
        sys.stdout.flush()

    try:  # typed keys are not echoed
        attrs = termios.tcgetattr(sys.stdin)
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(sys.stdin, termios.TCSANOW, attrs)
    except (termios.error, OSError):
        pass
    signal.signal(signal.SIGWINCH, draw)
    draw()
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
