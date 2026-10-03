"""Launch the native Tern frontend with this project's Python environment."""

import argparse
import os
import shutil
import sys
from importlib.metadata import version
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="terngram",
        description="Native Telegram text client for Tern. Credentials are entered locally and stored privately, outside the project.",
        epilog="First run: obtain your own API ID/hash at https://my.telegram.org/apps. Never share account.session; it grants access to your account. In the app: Tab changes fields; Enter submits; Ctrl+C quits.",
    )
    parser.add_argument("--version", action="version", version=f"terngram {version('terngram')}")
    parser.add_argument(
        "--data-dir", type=Path,
        default=Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "terngram",
        help="private account data directory (default: ~/.local/share/terngram)",
    )
    args = parser.parse_args()
    bun = shutil.which("bun")
    if bun is None:
        parser.error("Bun is required for the native frontend. Install it with mise install bun.")
    frontend = Path(__file__).with_name("ui") / "main.ts"
    root = frontend.parent.parent.parent
    if not (root / "node_modules/@oh-my-pi/pi-tui/package.json").is_file():
        parser.error("Native UI dependencies are missing. Run bun install in the terngram project first.")
    os.execv(bun, [bun, str(frontend), "--python", sys.executable, "--data-dir", str(args.data_dir.expanduser().absolute())])


if __name__ == "__main__":
    main()
