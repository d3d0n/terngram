import os
import platform
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


@unittest.skipUnless(
    platform.system() == "Darwin"
    and platform.machine() == "arm64"
    and int(platform.mac_ver()[0].split(".")[0] or "0") >= 27,
    "The bundled plugin runtime requires Apple Silicon and macOS 27+",
)
class PluginBootstrapTests(unittest.TestCase):
    def test_failed_download_leaves_no_runtime_or_install_lock(self):
        script = Path(__file__).resolve().parents[1] / "scripts/launch_release.sh"
        with tempfile.TemporaryDirectory(prefix="terngram bootstrap ") as directory:
            cache = Path(directory) / "cache with spaces"
            # A bound, non-listening socket refuses the proxy connection without
            # contacting GitHub, while preventing another process taking the port.
            with socket.socket() as proxy:
                proxy.bind(("127.0.0.1", 0))
                url = f"http://127.0.0.1:{proxy.getsockname()[1]}"
                env = os.environ | {
                    "HOME": directory,
                    "XDG_CACHE_HOME": str(cache),
                    "https_proxy": url,
                    "HTTPS_PROXY": url,
                    "ALL_PROXY": url,
                    "all_proxy": url,
                    "NO_PROXY": "",
                    "no_proxy": "",
                }
                result = subprocess.run(
                    ["/bin/sh", str(script), "--version"],
                    env=env, capture_output=True, text=True, timeout=10,
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((cache / "terngram").is_dir(), result.stderr)
            self.assertEqual(list((cache / "terngram").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
