# Terngram @VERSION@ — macOS Apple Silicon

Requires **Tern 0.4 or newer**, an Apple Silicon Mac, and **macOS @MIN_MACOS@ or newer**. The minimum macOS version is the highest deployment target found in every bundled Mach-O binary, not the build host's marketing version. This package is arm64-only, not universal. Python, Bun, TDLib and their non-system dynamic libraries are bundled; installing Homebrew, uv, Python or Bun is not required.

This is an unofficial Telegram client. It is not affiliated with Telegram. **No signing or notarization was performed for this local package.** Native runtime files and any signatures they already contained are preserved unchanged. The package is not presented as Apple Developer ID signed or notarized. Do not treat its checksum as proof of publisher identity, and do not disable Gatekeeper globally. Verify the archive against a checksum obtained through a trusted channel; macOS may still require an explicit approval for a downloaded, unnotarized application.

## Install

1. Check the archive against its adjacent `.sha256` file: `shasum -a 256 -c terngram-@VERSION@-macos-arm64.zip.sha256` in the download directory.
2. Unzip the archive. Keep the entire `terngram` directory together; its launcher and plugin use package-relative paths, including paths containing spaces.
3. Put that directory at `~/.config/tern/plugins/terngram`, or `plugins/terngram` inside your configured `TERN_CONFIG_DIR`. Do not merge it with an older installation: replace the package directory, keeping personal Telegram data outside it. Tern must discover `plugin.toml` directly inside that directory.
4. Restart Tern, then open its command palette and select **Open Terngram**. The plugin opens the bundled native client in a new tab. It does not load account data itself.

To inspect CLI options without opening Telegram or a Tern pane:

```sh
"/path with spaces/terngram/bin/terngram" --version
"/path with spaces/terngram/bin/terngram" --help
```

For normal use, launch from Tern. Obtain your own API ID and hash at https://my.telegram.org/apps; authentication is QR-only and may require your Telegram 2FA password. Account data defaults to `~/.local/share/terngram` (or `$XDG_DATA_HOME/terngram`). Use `--data-dir "/private/path"` to select a different directory. The launcher forwards all CLI arguments and does not change application storage or authentication defaults. Never share that directory: it grants access to the Telegram account. The release contains no personal data, credentials, QR codes or existing sessions.

## Inspect the package

`BUILD-INFO.json` records the actual runtime versions, hashes, architecture and deployment floor. `DEPENDENCIES.json` inventories copied distributions and the native dependency closure, including unchanged install names and package-scoped dyld lookup policy. `licenses/` retains available installed license texts and notices only; its inventory is explicitly **not complete**. `SHA256SUMS` covers package files (except itself), and `SYMLINKS.json` records relative symlink targets. From the unpacked `terngram` directory, run `shasum -a 256 -c SHA256SUMS` to check file contents. These are integrity records, not a notarization, publisher authentication or security certification.

Maintainers must verify relocation using an unpacked path containing spaces and a clean PATH, and use only disposable empty `--data-dir` directories or worker fixtures. Do not use an existing account for a packaging check.
