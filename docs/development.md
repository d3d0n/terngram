# Development

Start here to find the right module, make a change across the right boundaries, and choose evidence that actually covers it. For installation and daily use, see the [README](../README.md).

## Runtime map

```text
mise run start → uv run --frozen terngram
  Python launcher ──exec──> Bun: ui/main.ts
                               │
                     Tern <── TSP ──> UI / app state
                                        │
                                      JSONL
                                        │
                                   Python worker
                                        │
                                  TelegramService
                                        │
                                ctypes / TDLib C JSON
                                        │
                                  Telegram / MTProto
```

TSP is the terminal-facing protocol. JSONL is the private UI-to-worker protocol. TDLib owns Telegram networking and its database; the application owns user intent, presentation and its separate recovery ledger. Do not conflate these layers.

| Boundary | Implementation | Responsibility |
| --- | --- | --- |
| Launch | [`__main__.py`](../terngram/__main__.py) | Resolve Bun, pass the Python executable/data directory, replace the launcher with the frontend |
| Native terminal entry | [`ui/main.ts`](../terngram/ui/main.ts) | Require Tern, negotiate the supported surface, initialize the TUI |
| App controller | [`ui/app.ts`](../terngram/ui/app.ts) | Authorization stages, worker lifecycle, chat selection, overlays, commands and transitions |
| UI transport | [`ui/telegram.ts`](../terngram/ui/telegram.ts) | Worker process, JSONL buffering, request correlation, DTOs and errors |
| Worker dispatcher | [`worker.py`](../terngram/worker.py) | Method allowlist, request admission, event envelopes, EOF and safe diagnostics |
| Telegram service | [`telegram.py`](../terngram/telegram.py) | TDLib translation, chat/message caches, media access and durable intent state |
| Native binding | [`tdlib.py`](../terngram/tdlib.py) | Library discovery, version gate, receive ownership, responses, ordered updates and close |
| Formatting | [`formatting.py`](../terngram/formatting.py) | Compose Markdown ↔ TDLib entities using UTF-16 offsets; received entities render as literal native text/code in the UI |

The source map is deliberately small. Detailed contracts live in [backend.md](backend.md), [ui.md](ui.md) and [tern-api.md](tern-api.md), not in this entry guide.

## Set up a checkout

Requirements:

- An interactive Tern host with the required TSP capabilities. The implementation has been exercised against Tern 0.3.0 on macOS; native geometry and behavior are host-owned.
- [mise](https://mise.jdx.dev/) for the pinned Bun, uv and Ruff tools in `mise.toml`. The UI needs Bun **1.3.14+**; Python **3.12+** is managed by uv, not a second mise Python installation.
- Official native TDLib **1.8.67+**, independently installed. Its library is not supplied by `uv.lock`.

```sh
# macOS: the older stable TDLib 1.8.0 package is below the supported floor.
brew install tdlib --HEAD

mise trust
mise install
mise run deps
mise run start -- --help
```

Run `mise run start` **inside Tern**. It installs locked checkout dependencies before launching. Faking `TERM_PROGRAM` in another terminal does not provide native capabilities. The application has no alternate ANSI interface.

Use `TERNGRAM_TDLIB_LIBRARY` to select a specific compatible native library. The explicit override is authoritative; a broken override is not silently replaced with a different library. The [binding guide](backend.md) describes discovery and the version handshake. The [security guide](security.md) records the source revision previously reviewed and explains why a minimum-version check or moving Homebrew HEAD is not an artifact pin.

`mise run start --version` checks the application package version, **not** the loaded TDLib version. Arguments are forwarded to the launcher; use `mise run start -- --help` for application help instead of mise task help.

## Find the change surface

| Change | Read and edit together | Existing checks |
| --- | --- | --- |
| Worker method, DTO or event | `worker.py`, `telegram.py`, `ui/telegram.ts`, the `app.ts` consumer | [`test_telegram.py`](../tests/test_telegram.py), native smoke |
| TDLib load/receive/close behavior | `tdlib.py` and service lifecycle in `telegram.py` | [`test_tdlib.py`](../tests/test_tdlib.py), real-library probe below |
| QR or 2FA flow | Service authorization updates, DTOs, app authorization state and native image/input nodes | Service auth tests, native QR smoke |
| Send, retry or recovery | Service intent ledger and native identity, app transitions, [`chat-state.ts`](../terngram/ui/chat-state.ts), [`message-view.ts`](../terngram/ui/message-view.ts) | Service outbox tests, history tests, native delivery smoke |
| Chat/history ordering or updates | Service caches and pagination, `app.ts`, `chat-state.ts` | [`history.test.ts`](../tests/history.test.ts), service tests, native smoke |
| Palette/search/navigation | [`command-palette.ts`](../terngram/ui/command-palette.ts), [`forward-picker.ts`](../terngram/ui/forward-picker.ts), [`chat-navigation.ts`](../terngram/ui/chat-navigation.ts), app wiring | Palette/navigation tests, native smoke |
| Layout, focus or keyboard behavior | `app.ts`, [`chat-dock.ts`](../terngram/ui/chat-dock.ts), `message-view.ts`, [`shortcut-help.ts`](../terngram/ui/shortcut-help.ts), [`nodes.ts`](../terngram/ui/nodes.ts) | Typecheck and native smoke; inspect the actual Tern surface for visual changes |
| Images, albums or avatars | Service media/permission/path checks, [`image-loader.ts`](../terngram/ui/image-loader.ts), [`photo-viewer.ts`](../terngram/ui/photo-viewer.ts), app/view caches | Image/viewer tests, service media tests, native smoke |
| Read decisions or viewer counts | [`read-receipts.ts`](../terngram/ui/read-receipts.ts), [`reader-counts.ts`](../terngram/ui/reader-counts.ts), app policy and service calls | Read/viewer tests, service tests, native read-race smoke |
| Typing, presence or rate limits | Service activity, app transient state, [`request-cooldowns.ts`](../terngram/ui/request-cooldowns.ts), UI transport | [`test_activity.py`](../tests/test_activity.py), cooldown tests, native smoke |
| Markdown/entities | `formatting.py`, service message conversion, `ui/message-view.ts` and paired DTOs | [`test_formatting.py`](../tests/test_formatting.py), [`message-view.test.ts`](../tests/message-view.test.ts), native formatted-message smoke |
| Private files or migration | Service private-file helpers, state validation, outbox recovery, worker umask | Service filesystem/migration tests; update [security.md](security.md) |

## Verification

[`mise.toml`](../mise.toml) is the task source of truth; `package.json` contains dependencies only. From the repository root:

```sh
mise run check
```

Individual tasks:

- **`typecheck`** runs TypeScript contract checking without emitting files.
- **`lint`** groups TypeScript checking, Ruff's Python runtime-error rules (`E9`, `F63`, `F7`, `F82`) and release-launcher shell syntax checks. No formatter/style migration or separate TypeScript style linter is imposed.
- **`test`** runs the Bun suite and Python `unittest` discovery as independent tasks. Python service tests replace the native request boundary, not the application behavior under test.
- **`smoke`** runs `.smoke-client.ts`, driving the real app/native backend and `TspDocument` with controlled Telegram replies, synthetic QR images and isolated worker storage. It checks accepted frames, action routing and state transitions.
- **`check`** runs `lint`, `test` and `smoke`; independent checks may run concurrently.

Tasks needing checkout dependencies share `deps`, which uses `bun install --frozen-lockfile` and `uv sync --frozen`. Runtime Python commands also use `--frozen`; these tasks do not update lockfiles.

These commands do not use your Telegram account. They are not proof of live delivery, an actual scanned login, host pixel geometry or full API Terms compliance. A green tree is necessary, not a substitute for exercising the changed path.

Useful targeted runs:

```sh
mise run test:ui tests/palette.test.ts
mise run test:python -p 'test_telegram.py'
mise run test:python -p 'test_tdlib.py'
mise run test:python -p 'test_formatting.py'
```

Use promise gates and controlled clocks for ordering, expiry and retry tests. Do not wait real seconds to prove a timer boundary. Keep regression tests about behavior—delivery identity, state transitions, access boundaries and preserved drafts—not source text or incidental wording.

`waitForView` waits for an actual render transition and fails with a bounded diagnostic if that transition never arrives. A fixture RPC can start without requesting a new render: synchronize on the fixture's request-start event in that case, then draw and assert. After dismissing an overlay, draw the restored surface before looking up its controls; do not inspect a stale palette snapshot.

### Exercise the real native library without an account

This probe loads TDLib, verifies the startup contract, prints its version and closes it. It does not call `setTdlibParameters`, open the account database or sign in.

```sh
uv run python - <<'PY'
import asyncio
from terngram.tdlib import TDLib

async def on_update(update):
    if update.get("@type") == "updateAuthorizationState":
        print(update["authorization_state"]["@type"])

async def main():
    client = TDLib(on_update)
    try:
        await client.start()
        result = await client.request({"@type": "getOption", "name": "version"})
        print("TDLib", result["value"])
    finally:
        await client.close()

asyncio.run(main())
PY
```

The native library and its dependencies must match the process architecture. The version probe does not certify every native method, schema revision or cryptographic path.

### Run the screen-surface fix

Close the existing client with **Ctrl+Q** (not logout), then launch this checkout inside Tern:

```sh
uv run --frozen terngram
# Optional verbose diagnostics; choose a new file.
uv run --frozen terngram --debug-log ./terngram-debug.jsonl
```

There is no UI compile step: Bun executes the edited source. If dependencies are not installed, run `mise run deps` first; the lockfile carries the root-screen SDK patch. The app uses a native screen for all authorization and chat views instead of attaching the UI to terminal scrollback. The existing cached **Open Terngram** release will not pick up checkout edits until a new package is built/installed. Pass your usual `--data-dir` if customized, and never run both clients against one TDLib database.

Root mode remains a screen across host eviction and stop/resume; normal input, layers and draft identity are preserved. Screen close discards the terminal UI rather than leaving it in scrollback; it does not log out or delete chat history/drafts. The standalone focus probe deliberately retains inline mode for comparison. The isolated PTY/native-document checks prove protocol, state and lifecycle behavior, not that the intermittent real-host paint stall is gone.

### Capture Tern focus events without an account

Run the isolated diagnostic inside Tern, from the checkout:

```sh
uv run python -m terngram.focus_probe
# Optional fixed destination; it must not already exist.
uv run python -m terngram.focus_probe --output ./tern-focus.jsonl
```

The Python launcher executes [`ui/focus-probe.ts`](../terngram/ui/focus-probe.ts) with the pinned Bun/TUI dependencies. It never starts the Telegram worker or opens account storage. The native surface contains a dock editor, an optional editor overlay, and the current instruction. Use only synthetic letters.

1. Type `aaa` as the baseline.
2. Switch to another application for 10 seconds; return and type `bbb`.
3. Switch to another Tern tab for 10 seconds; return and type `ccc`.
4. Switch to a neighboring split pane for 10 seconds; return and type `ddd`.
5. Leave another application/tab focused for 2–3 minutes; return and type `eee`.
6. Switch tabs, resize the window while away, return and type `fff`.
7. Open the overlay with **Ctrl+G**, type `ggg`, leave for 10 seconds, return and type `hhh`. Press **Esc**, then type `iii` in the main editor.

Press **Ctrl+N** after each step to record its end and advance the instruction. On return, test typing **before clicking the editor**; a click could repair the failure being investigated. If input fails, wait 10 seconds, click **Ввод сломался**, then **Завершить**. **Ctrl+Q/Ctrl+C** also finishes. If neither keyboard nor buttons work, close this diagnostic pane; already-written records remain on disk.

The default file is `tern-focus-<UTC timestamp>.jsonl` in the working directory, displayed by the UI and printed on normal exit. Files are created exclusively with `0600` permissions, never overwritten. JSONL records contain wall/relative timestamps, hello capabilities, incoming TSP event metadata (including unknown event types), outgoing frame-operation counts/focus targets, keyboard categories, editor lengths, step/failure markers and a five-second heartbeat. Heartbeats do **not** request rendering or reset focus. The probe preserves the installed SDK's focus behavior.

Protocol bodies, node contents, typed text, clipboard/paste contents and terminal error messages are not written. SDK raw TSP/write recorders are disabled. Event capture happens before TUI routing; an event in the log is not proof the SDK accepted it. Node and surface identifiers are stable session-local aliases, not original wire keys. A heartbeat proves the probe's event loop ran, not that Tern painted the UI or delivered keyboard input. Privacy/chunking regressions: `mise run test:ui -- tests/debug-log.test.ts`.

### Verbose application logging

To capture the actual application's routing/state rather than just a standalone editor, close any running Terngram client with **Ctrl+Q** first (do not log out), then run the edited checkout inside Tern:

```sh
uv run --frozen terngram --debug-log ./terngram-debug.jsonl
```

This is the normal client with optional verbose diagnostics, not a separate account or a focus-recovery fix. Source launch does not use the old cached release behind **Open Terngram**. It keeps the normal data-directory choice; if your usual client uses an explicit `--data-dir`, pass that same directory after closing it. Do not run both clients against one TDLib database. There is no compilation step for this source launch.

The file must not already exist; select a new filename for another session. Its absolute path is printed at startup and exit. [`ui/debug-log.ts`](../terngram/ui/debug-log.ts) creates an exclusive `0600` JSONL file and records all enabled diagnostic levels: `info` for lifecycle, `warn` for malformed/terminal-error events, `trace` for detailed UI/transport activity. It is not a full worker RPC/content log.

In addition to sanitized Tern events/frame summaries, records contain local app state: stage, busy/quit/online, known focus role and input capability, composer availability/submit state, overlay/confirmation/thread-mode booleans and composer length only in chats. `input_route` records the interceptor's exact consumed result and before/after state; `dispatch` records state after TUI routing; `model_edit` marks user composer changes. A five-second heartbeat never requests a render or changes focus. No debug-only keyboard bindings or controls are added.

Use the same window/tab/pane/idle/resize transitions as the standalone probe, and repeat with **Ctrl+K** palette and **Ctrl+G** help open. Test ordinary draft input without pressing Enter; Enter still sends normally. After returning, type before clicking the editor. If the picture freezes while actions still appear to reach the app, type a few synthetic letters into the composer (no Enter), wait 10 seconds and note the time. Then use the same host scrollback/screen-clear operation that restores the view, noting its time and whether the accumulated draft/actions appear. Do not first press Esc/Tab or click the editor: those can obscure which action restored painting. The useful sequence is `model_edit`/`input_route` → outgoing frame → ACK before and after the clear, together with any `gone`, `resize` or new-surface event. An ACK proves protocol receipt, not painting. Finish with **Ctrl+Q** if possible; already-written records remain if the pane must be closed.

No message/draft/search text, account or peer names, Telegram identifiers, QR/blob contents, password hints, auth edit offsets/lengths, raw key sequences or terminal error text enter the diagnostic file. Keyboard categories/timing remain observable; this is not anonymous telemetry. Node/surface aliases correlate focus operations and events within one session without exposing private keys. `PI_TUI_TSP_RECORD`, `PI_TUI_WRITE_LOG` and `OMP_TUI_DEBUG` are disabled in debug mode. A post-open file I/O failure disables recording without interrupting input/delivery; the safe failure code is reported on exit. Existing diagnostic files are never overwritten.

### Live testing is explicitly scoped

An active session is not blanket permission to use it. Before live work, obtain the permitted chat(s) and operation scope. Read-only access to one chat does not authorize sending there or inspecting another chat.

- Do not open personal databases, export sessions or copy authorization material into fixtures.
- Do not run two clients against the same TDLib database. Coordinate a clean handoff instead of deleting locks or copying a live database.
- Verify the intended chat identity before a mutation. Mark test messages clearly, retain their returned IDs and clean up only those test messages when authorized.
- Never use bulk deletion or send new copies to discover whether an ambiguous attempt succeeded.
- Do not publish login QR codes, API credentials, private message screenshots, native traces or blob payloads.

Report live observations separately from fixture results. Never paste account-specific chat IDs or content into reusable tests or documentation.

## Release workflow

The release is a standalone **macOS arm64 runtime package**, not a compiled UI bundle or a Python wheel. [`build_release.py`](../scripts/build_release.py) copies the whitelisted application sources, pinned UI dependency graph, the current mise Bun executable, the project Python runtime with Pillow/qrcode, and an explicitly selected official TDLib library. It collects non-system native dependencies, preserves Mach-O bytes/signatures/load commands, and measures the highest bundled macOS deployment floor. It does not compile TDLib, sign, notarize or publish.

```sh
# Full local pipeline: check → build → relocated-runtime verification.
mise run release /opt/homebrew/opt/tdlib/lib/libtdjson.dylib

# Or select TDLib through the existing library override.
TERNGRAM_TDLIB_LIBRARY=/path/to/libtdjson.dylib mise run release

# Separate steps; build forwards all original builder options.
mise run build --tdlib /path/to/libtdjson.dylib --expect-version 0.1.3
mise run build -- --help
mise run release:verify dist/terngram-0.1.3-macos-arm64.zip
```

`release` and `release:verify` read the expected application version from `pyproject.toml`. The builder also requires `packaging/tern/plugin.toml` to match. For a version bump, update the builder's default `--expect-version` too, or pass it explicitly when using `build`.

Outputs are `dist/terngram-<version>-macos-arm64.zip` and its `.zip.sha256` sidecar, plus a staged package under `build/macos-release`. The package includes `BUILD-INFO.json`, `DEPENDENCIES.json`, available license texts, `SHA256SUMS` and `SYMLINKS.json`. Existing release files are never overwritten; use `mise run release /path/to/libtdjson.dylib --output-dir dist/another-build --staging-dir build/another-build` for a fresh build.

[`verify_release.py`](../scripts/verify_release.py) checks archive/package integrity and the native dependency inventory, then extracts into a temporary path containing spaces. It runs bundled launcher help/version, a real TDLib version/start/close probe without account startup, and the native fixture smoke with bundled Bun/Python, isolated HOME/XDG paths and no host uv. No live account access or plugin installation is performed. Apple `lipo`/`otool` are required for both packaging and verification.

Publication is intentionally manual: upload the verified ZIP and checksum sidecar to the matching GitHub `v<version>` release, then update `VERSION` and the archive `SHA256` in `scripts/launch_release.sh`. The root Git-installed plugin downloads that pinned runtime; `packaging/tern` supplies the offline standalone plugin. A new local build is not automatically the published runtime, and mise never changes the bootstrap pin.

## Debugging by layer

| Symptom | Start with | Do not do |
| --- | --- | --- |
| Native terminal requirement fails | `ui/main.ts`, actual terminal/hello capabilities | Spoof the environment and call it supported |
| TDLib cannot load or version is too old | `TERNGRAM_TDLIB_LIBRARY`, process architecture, the real-library probe | Assume `uv sync` installs native TDLib |
| Database is already in use | Another Terngram/TDLib process using the same data directory | Delete the database, lock state or authorization files |
| QR does not advance | Authoritative authorization updates, connection state and safe error code | Add phone login or a local fake token countdown |
| Message is still pending | Native updates, durable native identity and automatic reconciliation | Mark it sent after a queued response, or retry an unknown outcome as a new send |
| A failed message cannot retry | Its current native failure/eligibility and explicit retry path | Change reply, sender or payment requirements silently |
| Image path is rejected | Configured roots and TDLib's media-cache placement in [backend.md](backend.md) | Whitelist the database root or follow cache symlinks |
| Presence warnings or redraw loops | Absolute expiry and the bounded timer in `app.ts` | Cast long deadlines to int32 or replace overflow with a 1 ms loop |
| Data changes but the screen does not | Description-cache keys, invalidation, source ownership and native frames | Rebuild unrelated UI or treat an ACK as a screenshot |

Safe application diagnostics live in `tdlib/last-error.json` under the configured private data directory. They contain operation/error class and limited stack locations, not exception values, RPC arguments or message bodies. Keep native logging disabled when investigating a real account; it can expose authorization and content. See [security.md](security.md).

## Change checklist

1. Read the guide for the affected layer and its implementation. Assign disjoint file ownership when working in parallel.
2. Preserve the boundary: UI decisions belong in the app, Telegram semantics in the service, receive/correlation mechanics in the binding.
3. Update every paired DTO, allowlist entry and consumer when a contract changes. Do not add a second transport or stale compatibility path.
4. Preserve user text and native delivery identity across errors, late responses, restart and account changes.
5. Exercise the relevant runtime path, then run the checks covering the changed surface. For UI work, distinguish protocol evidence from actual painted behavior.
6. Update the focused guide and its links. Keep the README for users and [AGENTS.md](../AGENTS.md) as an index, not another manual.
7. State exactly what was verified and what remains unverified. Follow the user's current instructions for Git operations; do not assume a code change authorizes publication.
