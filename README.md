# Terngram

**Telegram, at home in Tern.**

A keyboard-first unofficial Telegram client drawn natively by [Tern](https://stencil.so/tern).

Built with the [oh-my-pi](https://github.com/can1357/oh-my-pi) native UI toolkit and the official [TDLib](https://core.telegram.org/tdlib). 

[Quick start](#quick-start) · [Sign in](#sign-in) · [Keyboard](#keyboard) · [Current limits](#current-limits) · [Developing](#developing)

## Quick start

### macOS release

Requires **Apple Silicon, macOS 27+, Tern 0.4+**. Install with one command:

```sh
tern plugin install github.com/d3d0n/terngram
```

Choose **Open Terngram** from Tern's command palette. On first launch, the plugin downloads the standalone 0.1.0 runtime and checks its pinned SHA256 before extracting or executing it. Bun, Python, TDLib and their runtime dependencies are included; no Homebrew or uv setup is needed. Later launches use the cached runtime without downloading again. If `tern` is not on your PATH, use `/Applications/Tern.app/Contents/MacOS/tern`.

The runtime lives under `$XDG_CACHE_HOME/terngram`, or `~/Library/Caches/terngram` by default; account data remains separate. To replace an existing installed copy, add `--force` to the install command (linked plugins must be unlinked first).

For an offline installation, download the ZIP and `.sha256` from [release 0.1.0](https://github.com/d3d0n/terngram/releases/tag/v0.1.0), verify with `shasum -a 256 -c terngram-0.1.0-macos-arm64.zip.sha256`, unzip, then run `tern plugin install ./terngram`.

The package has no new Developer ID signature or Apple notarization; supplied runtime signatures are preserved. macOS may require explicit approval. Do not disable Gatekeeper globally. The macOS 27 minimum comes from the bundled native binaries, not from Tern's own minimum version. See the archive's `INSTALL.md` and `BUILD-INFO.json` for details.

### Run from source

Use an interactive **Tern** terminal. The current setup has been exercised on macOS with Tern 0.3.0; an ordinary terminal is not a substitute for its native surface protocol.

You need [Bun](https://bun.sh/) **1.3.14+**, [uv](https://docs.astral.sh/uv/), Python **3.12+** and a native TDLib build **1.8.67 or newer**.

From this checkout:

```sh
# Build the official native Telegram engine on macOS.
brew install tdlib --HEAD

# Install the UI dependencies, then launch inside Tern.
bun install --frozen-lockfile
uv run terngram
```

`uv` manages the Python environment, including QR-image dependencies. It **does not install TDLib**. The older TDLib 1.8.0 Homebrew build does not meet this client's version floor; the command above builds current upstream sources instead. A minimum-version check is not a guarantee that every future native API change is compatible.

The loader searches system and Homebrew locations. For a specific compatible library:

```sh
TERNGRAM_TDLIB_LIBRARY=/opt/homebrew/opt/tdlib/lib/libtdjson.dylib uv run terngram
```

See [development setup](docs/development.md) for dependency checks, troubleshooting and the native-library boundary.

## Sign in

1. Obtain an API ID and API hash for your own application at [my.telegram.org/apps](https://my.telegram.org/apps), then enter them locally in Terngram.
2. In an already signed-in Telegram app, open **Settings → Devices → Link Desktop Device** and scan the QR code.
3. Enter your **two-step verification password** if requested.

TDLib rotates the QR code automatically. Subsequent launches use the saved session. 
**QR and optional 2FA are the only login path:** there is no phone-number/code form, email login or signup flow.

Closing Terngram keeps the session. 
**Sign out…** revokes this client's session after confirmation.

## Keyboard

Use **Control**, not Command. No function-key row, Home/End or Page Up/Down required.

| Where | Keys | Action |
| --- | --- | --- |
| Chats, no overlay | `Ctrl+K` / `Ctrl+F` | Chats and commands / chats only |
| No overlay or busy operation | `Ctrl+G` | Contextual keyboard help |
| Conversation | `Tab` / `Shift+Tab` | Move between messages and composer |
| Composer | `Enter` / `Shift+Enter` | Send / insert a newline |
| Messages | `↑` / `↓` | Select a message or album |
| Messages | `Enter` | Reply; retry when a failed message is selected |
| Messages | `R`, `E`, `F`, `P`, `X` | Reply, edit own text, forward, view photo, request deletion of an own message |
| Messages | `Ctrl+U` / `Ctrl+D` | Page through the conversation |
| Conversation | `Ctrl+L` | Jump to the latest messages |
| Messages or empty composer | Double `←` / `→` | Back / forward through visited chats |
| Photo gallery | `←` / `→` | Previous / next photo |
| Overlay, confirmation, selection or reply/edit | `Esc` | Close or cancel that context—not an in-flight send |
| Anywhere | `Ctrl+Q` / `Ctrl+C` | Save local state and quit |

In the palette, `>` limits results to commands and `@` to chats. Without either prefix, both are searchable. The [UI guide](docs/ui.md) covers action eligibility, focus and destructive confirmations.

## Your account stays local

The default data directory is `~/.local/share/terngram`, or `$XDG_DATA_HOME/terngram`. Override it when needed:

```sh
uv run terngram --data-dir /path/to/private/terngram-data
```

It contains API credentials, TDLib authorization and message/media caches, drafts and delivery-recovery state. **Treat the entire directory as sensitive account data.** Private file permissions are not encryption at rest.

Terngram does not write QR images, login links or your 2FA password into its own state or diagnostics. TDLib manages its own private authorization persistence. Tern receives the content it renders, including QR images and secret input: the host is part of the trust boundary. See [privacy and security](docs/security.md).


## Current limits

This is a focused client, not feature parity with Telegram Desktop.

- No calls, secret chats, file/photo sending, audio/video playback, stickers, reactions or polls.
- No global user search or message search; palette search covers your loaded chat catalog.
- No cloud-draft synchronization or multi-account switcher.
- Protected/view-once media that needs an enforceable protected viewer is not displayed.


## Developing

Start with [AGENTS.md](AGENTS.md) for the documentation index, or go straight to the [development guide](docs/development.md).

```sh
bun run check          # TypeScript contracts
bun run test           # Bun tests and Python unittest suite
bun .smoke-client.ts   # Native frames, app transitions and isolated worker storage
```

The automated suite uses isolated fixtures, not your Telegram account. The smoke harness exercises the real native backend/document machinery, but it does not prove Tern's painted geometry or live Telegram delivery.

| Guide | What it owns |
| --- | --- |
| [Development](docs/development.md) | Runtime map, change routing, checks and debugging |
| [Backend](docs/backend.md) | TDLib, worker RPC, authorization, storage and the outbox |
| [UI](docs/ui.md) | App state, keyboard behavior, delivery feedback and media |
| [Tern API](docs/tern-api.md) | Native nodes, events, blobs, scrolling and host boundaries |
| [Security](docs/security.md) | Private data, trust boundaries and API Terms status |
| [Desktop parity](docs/desktop-parity.md) | Behavior comparisons and upstream references |
