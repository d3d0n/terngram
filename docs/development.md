# Development

Start here to find the right module, make a change across the right boundaries, and choose evidence that actually covers it. For installation and daily use, see the [README](../README.md).

## Runtime map

```text
uv run terngram
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
- Bun **1.3.14+** for the pinned UI toolkit, and Python **3.12+** managed by `uv`.
- Official native TDLib **1.8.67+**, independently installed. Its library is not supplied by `uv.lock`.

```sh
# macOS: the older stable TDLib 1.8.0 package is below the supported floor.
brew install tdlib --HEAD

bun install --frozen-lockfile
uv sync --frozen
uv run terngram --help
```

Run `uv run terngram` **inside Tern**. Faking `TERM_PROGRAM` in another terminal does not provide native capabilities. The application has no alternate ANSI interface.

Use `TERNGRAM_TDLIB_LIBRARY` to select a specific compatible native library. The explicit override is authoritative; a broken override is not silently replaced with a different library. The [binding guide](backend.md) describes discovery and the version handshake. The [security guide](security.md) records the source revision previously reviewed and explains why a minimum-version check or moving Homebrew HEAD is not an artifact pin.

`uv run terngram --version` checks the application package version, **not** the loaded TDLib version.

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

From the repository root:

```sh
bun run check
bun run test
bun .smoke-client.ts
```

- **`check`** runs TypeScript contract checking.
- **`test`** runs the Bun suite, then Python `unittest` discovery. Python service tests replace the native request boundary, not the application behavior under test.
- **`.smoke-client.ts`** drives the real app/native backend and `TspDocument` with controlled Telegram replies, synthetic QR images and isolated worker storage. It checks accepted frames, action routing and state transitions.

These commands do not use your Telegram account. They are not proof of live delivery, an actual scanned login, host pixel geometry or full API Terms compliance. A green tree is necessary, not a substitute for exercising the changed path.

Useful targeted runs:

```sh
bun test tests/palette.test.ts
uv run python -m unittest discover -s tests -p 'test_telegram.py'
uv run python -m unittest discover -s tests -p 'test_tdlib.py'
uv run python -m unittest discover -s tests -p 'test_formatting.py'
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

### Live testing is explicitly scoped

An active session is not blanket permission to use it. Before live work, obtain the permitted chat(s) and operation scope. Read-only access to one chat does not authorize sending there or inspecting another chat.

- Do not open personal databases, export sessions or copy authorization material into fixtures.
- Do not run two clients against the same TDLib database. Coordinate a clean handoff instead of deleting locks or copying a live database.
- Verify the intended chat identity before a mutation. Mark test messages clearly, retain their returned IDs and clean up only those test messages when authorized.
- Never use bulk deletion or send new copies to discover whether an ambiguous attempt succeeded.
- Do not publish login QR codes, API credentials, private message screenshots, native traces or blob payloads.

Report live observations separately from fixture results. Never paste account-specific chat IDs or content into reusable tests or documentation.

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
