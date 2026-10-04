"""Launch an isolated, content-free Tern focus diagnostic (no Telegram worker)."""

import argparse
import os
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new JSONL log file; existing files are never overwritten")
    args = parser.parse_args()
    bun = shutil.which("bun")
    if bun is None:
        parser.error("Bun is required. Install it with mise install bun.")
    frontend = Path(__file__).with_name("ui") / "focus-probe.ts"
    root = frontend.parent.parent.parent
    if not (root / "node_modules/@oh-my-pi/pi-tui/package.json").is_file():
        parser.error("Run bun install --frozen-lockfile in this project first.")
    command = [bun, str(frontend)]
    if args.output is not None:
        command += ["--output", str(args.output.expanduser().absolute())]
    # The SDK's optional raw recorder is unsafe for this content-free diagnostic.
    os.environ.pop("PI_TUI_TSP_RECORD", None)
    os.execv(bun, command)


if __name__ == "__main__":
    main()
