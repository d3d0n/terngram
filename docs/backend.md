# Backend, IPC and persistence

This guide describes the shipped Python service and its local TypeScript contract. Use it when changing TDLib integration, worker RPC, update handling or storage. The source is authoritative; this is not a second transport API or a promise of exactly-once delivery.

See [development.md](development.md) for setup and workflows, [ui.md](ui.md) for frontend policy and pending-send controls, and [security.md](security.md) for the trust boundary and Telegram API obligations.

## Responsibilities and source map

| Source | Ownership | Paired callers/tests |
| --- | --- | --- |
| [`terngram/tdlib.py`](../terngram/tdlib.py) | Official TDLib C JSON binding, native discovery/version gate, request correlation, ordered callbacks and native shutdown | [`tests/test_tdlib.py`](../tests/test_tdlib.py) |
| [`terngram/telegram.py`](../terngram/telegram.py) | QR/2FA authorization, account caches, chat/message operations, media permissions, private JSON and send reconciliation | [`ui/app.ts`](../terngram/ui/app.ts), [`tests/test_telegram.py`](../tests/test_telegram.py), [`tests/test_activity.py`](../tests/test_activity.py) |
| [`terngram/worker.py`](../terngram/worker.py) | JSONL framing, method allowlist, concurrent dispatch, exclusive authorization transitions, safe errors and EOF shutdown | [`ui/telegram.ts`](../terngram/ui/telegram.ts), worker cases in `test_telegram.py` |
| [`terngram/ui/telegram.ts`](../terngram/ui/telegram.ts) | DTO declarations, Bun subprocess, RPC promises, event routing and identifier validation | [`ui/request-cooldowns.ts`](../terngram/ui/request-cooldowns.ts), [`tests/request-cooldowns.test.ts`](../tests/request-cooldowns.test.ts) |
| [`terngram/formatting.py`](../terngram/formatting.py) | Composer Markdown ↔ Telegram entities, UTF-16 offsets and literal escaping | [`tests/test_formatting.py`](../tests/test_formatting.py) |

TelegramService is the only Telegram service. There is no Bot API, legacy MTProto runtime fallback, public arbitrary-TDLib RPC or secret-chat implementation. TDLib owns transport retries and its native outbox; application tokens do not replace native transport identities. A TDLib database is not a complete offline browsing or offline send-queue UI.

## Native binding contract

### Discovery and startup

The binding loads the modern official C JSON symbols `td_create_client_id`, `td_send`, `td_receive` and `td_execute` with `ctypes`.

* `TERNGRAM_TDLIB_LIBRARY`, when set, is the sole candidate (with `~` expansion).
* Otherwise `ctypes.util.find_library("tdjson")` is tried first if available, followed by platform candidates: Homebrew Apple Silicon/Intel paths and `libtdjson.dylib` on macOS; `tdjson.dll`/`libtdjson.dll` on Windows; `libtdjson.so` and `/usr/local/lib/libtdjson.so` elsewhere.
* Missing libraries or symbols fail explicitly. Platform discovery branches alone do not establish supported frontend platforms.
* `start()` creates a native client, requests `getOption("version")`, requires a string semantic version at least **1.8.67**, then requests `getAuthorizationState`. Callback delivery is held behind readiness until these requests succeed. Failed or cancelled startup closes the native client.

TDLib is an external system artifact, not pinned by `uv.lock`. Homebrew stable 1.8.0 is too old; the current macOS setup uses `brew install tdlib --HEAD`. A minimum version and moving HEAD are not artifact provenance guarantees; see [security.md](security.md).

Native logging is disabled with `logStreamEmpty` and verbosity 0 **before client creation**. Receive/execute results are copied under a shared lock so another native call cannot invalidate the returned C buffer. Encoding is UTF-8 JSON with non-finite numbers rejected; results must decode to objects. Native `error` objects become `TDLibError`, and `@extra`/`@client_id` are removed from exposed results.

### Correlation, ordered updates and shutdown

One receiver thread owns `td_receive` for all clients sharing the native API. It routes by `@client_id` onto each client's asyncio loop. Each request gets a binding-owned string `@extra` of `client-serial:request-sequence`; caller-provided `@extra` is replaced. Replies resolve their own futures and can complete out of order. Cancelled, unknown or late correlated replies are discarded, never treated as updates.

Uncorrelated updates enter a per-client FIFO, consumed by one async callback task. **Reply delivery does not wait for callback delivery.** An authorization callback can await `setTdlibParameters`, `getMe` or another TDLib request without blocking receipt of its reply or reordering subsequent callbacks. Do not collapse receive and callback consumption into one awaited loop: that creates a callback/request deadlock.

`close()` marks the client closing, rejects pending requests, sends native `close`, and waits for `authorizationStateClosed`, not merely the close reply. A shielded shutdown task survives cancellation of a close waiter. The last client waits for its exact retired receiver thread to finish; one client closing does not stop another live client. Callback-initiated close avoids awaiting/cancelling its own callback task. Receiver/callback failures reject requests with safe boundary errors and initiate shutdown. A restart must await close; retired client replies/updates cannot leak into the new client.

TelegramService adds an account `_epoch` fence. Close invalidates old callbacks and clears account caches, read/message versions, transient activity and send waiters; durable send records remain for reconciliation.

## Worker JSONL protocol

The frontend starts `python -m terngram.worker --data-dir PATH` with pipe stdin/stdout and ignored stderr. Each frame is one UTF-8 JSON object followed by a newline. Stdout is exclusively protocol data, not diagnostics.

```json
{"id":1,"method":"history","args":[123,0,50]}
{"id":1,"result":[]}
{"id":2,"error":"Telegram does not permit this action in this chat.","error_code":"TDLIB_FORBIDDEN"}
{"id":3,"error":"Telegram asks you to wait 12 seconds. Try again afterward.","error_code":"TDLIB_RATE_LIMIT","retry_after":12,"retry_scope":"method"}
{"event":"connection","connected":true}
{"event":"update","kind":"read","chat_id":123,"max_id":1099511627776,"outbox":false}
```

These are shape examples, not account/session data. Request `id` must be a Python integer (not bool); the frontend allocates sequential integers. `method` must be in `METHODS`, and `args` must be a positional array (default `[]`). The worker validates the envelope; service methods validate values. Dataclass results serialize to objects, Python `None` to JSON `null`. Responses match frontend pending promises by ID and are not ordered by request arrival.

`TelegramRequestError.code` retains the structured worker `error_code` separately from its display message and retry-after metadata. `MEDIA_CHANGED` is an expected photo-request cancellation: the service emits an authoritative `message` or genuine `delete` update before the failure response. The worker forwards that code without overwriting `tdlib/last-error.json`; it is not a global error banner or an instruction to reuse old bytes.

Ordinary methods execute concurrently. `connect`, `request_qr`, `sign_in_password`, `logout` and `close` are exclusive transitions:

1. A transition waits until no transition or ordinary request is active.
2. Waiting transitions block admission of new ordinary requests, avoiding starvation by background history/media requests.
3. Completion releases admission in `finally`, including errors and cancellation.

TDLib updates continue independently of RPC admission. The barrier is not a global TDLib-update lock and does not serialize ordinary requests with each other. Per-token send locks and the dialogs lock protect their own operations.

EOF cancels/gathers dispatch tasks before closing the service. Frontend parse failure, EOF or process exit rejects all pending promises and reports disconnection. There is **no general frontend RPC timeout**. Frontend `Telegram.close()` ends stdin, waits for process exit and permits a kill after two seconds; this is not session revocation or proof that a pending send was cancelled.

### DTOs and identifiers

The declarations live in `ui/telegram.ts`; Python dataclasses/serializers produce the wire values. `?` below means an optional key, not permission to fabricate a value.

| DTO | Fields |
| --- | --- |
| `Dialog` | `id:number`, `title:string`, `unread_count:number`, `preview:string`, `writable:boolean`, `last_message_id:number\|null`, `kind:"user"\|"bot"\|"group"\|"channel"\|"saved"`, `presence?:PeerPresence\|null` (Python emits it, including null) |
| `DialogCursor` | `{offset:number}` |
| `DialogPage` | `{dialogs:Dialog[], cursor:DialogCursor\|null}` |
| `ChatMessage` | `id:number`, `chat_id:number`, `sender:string`, `text:string`, `time:string`, `outgoing:boolean`, `reply_to:number\|null`, `edited:boolean`, `photo:boolean`, `media_id:string\|null`, `forwarded:string\|null`, `read:boolean`, `grouped_id:string\|null`, `sender_id:number\|null`, `markdown:string`, `entities:MessageEntity[]`, `sending_state` as described below |
| `PeerPresence` | `state:"online"\|"offline"\|"recently"\|"last_week"\|"last_month"\|"unknown"`, `expires?:number`, `was_online?:number`; times are epoch seconds |
| `Photo` | `{data:string, mime:string, width:number, height:number}`; data is base64, not a path or URL |
| `Authorization` | `{state:"credentials"\|"qr"\|"password"\|"ready"\|"closed", qr?:Photo, hint?:string}`; no separate login-link URL |
| `PendingSend` | `text:string`, `reply_to:number\|null`, `token:string`, `chat_id:number`, `message_id?:number`, `status:"queued"\|"failed"\|"uncertain"`, `error?:string` |
| `ClientState` | `{drafts:Record<string,string>, selected_id:number\|null, pending_sends:Record<string,PendingSend>}`; map keys are decimal chat IDs, one tracked pending per chat |
| Reconciliation record | Active record: `token`, `chat_id`, `status`, `admitted:boolean`, `text`, `reply_to`, optional `message_id`/safe `error`. Terminal record: only `token`, `chat_id`, `status:"sent"\|"abandoned"`, optional `message_id`, and `admitted` |

Python always emits `sending_state` and uses `null` for confirmed messages; TypeScript accepts that nullable value. Consumers treat a falsy value as no sending state. State validation strips `PendingSend.error` before persistence/return; live safe errors may still be supplied in events and reconciliation records.

Adopted captionless native media may have `PendingSend.text:""`; saved state requires a valid `message_id` for that empty-text case. It is not an empty composer send or a synthesized `[Photo]` draft.

Chat IDs are nonzero signed safe JS integers (`abs(id) <= 2^53-1`). Message/reply IDs are positive TDLib `int53`, not old 32-bit message IDs. A local outgoing message ID is not itself a server confirmation. Frontend recursively checks named ID fields and `ids` arrays for safe integers. Album `grouped_id` is a decimal **string** because TDLib album IDs are int64; `media_id` is also a string. Tokens are canonical positive decimal strings from `1` through `2^31-1`, with no leading zero, and become native `sending_id` integers.

`ChatMessage.time` is local `YYYY-MM-DD HH:MM` display text, not a sortable server timestamp. `text` is plain content/caption or a readable unsupported/restricted-content label. `entities` carries TDLib UTF-16 ranges and entity types for native literal text runs and code blocks; ordinary punctuation, URLs and LaTeX-looking text are never reparsed as Markdown. `markdown` is reconstructed **compose syntax for editing and send recovery only**, not display input. Reply references are exposed only for the same chat. `read` derives from the appropriate native inbox/outbox maximum and is false while sending. Sender chat identities use negative `sender_id`; user identities use positive IDs.

### Events

Every row below is wrapped as `{"event":"update", ...payload}`.

| `kind` | Payload and meaning |
| --- | --- |
| `authorization` | `authorization:Authorization`; authoritative auth/QR stage replacement |
| `send_state` | `chat_id:number`, `token:string`, `status:"queued"\|"failed"\|"uncertain"\|"sent"\|"abandoned"`, `admitted?:boolean`, `message_id?:number`, `error?:string`, `message?:ChatMessage`; message body only with confirmed `sent` |
| `presence` | `chat_id:number`, `presence:PeerPresence` |
| `typing` | `chat_id:number`, `sender_id:number`, `sender:string`, `action:string`, `expires_in:number` (currently 6); action is the TDLib action constructor name, including cancel |
| `message` | `chat_id:number`, `message:ChatMessage`; new, edited or repeated data, not necessarily a new incoming message |
| `delete` | `chat_id:number`, `ids:number[]`; permanent deletion or replacement of an outgoing local ID on send outcome |
| `read` | `chat_id:number`, `max_id:number`, `outbox:boolean` |
| `dialog_changed` | `chat_id:number`, `title?:string`, `participants_changed?:boolean`, `avatar_changed?:boolean`, `permissions_changed?:boolean` |
| `refresh` | `chat_id:number`; refresh current data after an uncached change or update-handler failure |

`{"event":"connection","connected":boolean}` is separate: true means TDLib `connectionStateReady`, **not** contact presence. Event/RPC ordering may interleave; deduplicate by identity and apply generation/revision guards on the frontend.

### Complete RPC allowlist

Arguments are positional; defaults below are implemented service defaults. All void results are `null`.

| Method | Result and contract |
| --- | --- |
| `has_credentials()` | boolean; validates saved API credentials |
| `connect(api_id=null, api_hash=null)` | `Authorization`; no arguments use saved credentials; supplying credentials requires both and closes the old client before storing them |
| `auth_state()` | `Authorization` snapshot |
| `request_qr()` | `Authorization`; native QR snapshot/restart semantics below, never phone login |
| `sign_in_password(password:string)` | `Authorization`; nonempty 2FA password at password stage only |
| `me()` | account display-name string; requires ready |
| `dialogs(cursor=null, limit=60)` | `DialogPage`; exact cursor shape `{offset: nonnegative integer}`, limit 1–100 |
| `dialog(chat_id)` | `Dialog\|null`; native 404 gives null, other failures remain errors |
| `chat_info(chat_id, refresh=false)` | `{participants_count:number\|null}`; boolean refresh, cached full-group metadata; non-group returns null count without full-profile lookup |
| `message_readers(chat_id, message_id)` | `number\|null`; TDLib viewers count, permission/unavailability behavior below |
| `history(chat_id, before_id=0, limit=50)` | `ChatMessage[]` ascending by ID; before is exclusive, limit 1–100 |
| `album(chat_id, message_id)` | Complete album `ChatMessage[]` ascending by ID, or singleton |
| `prepare_send(chat_id, text, reply_to=null)` | `PendingSend` with allocated token and outward `status:"queued"`; actually durable **prepared**, no native send or live preflight |
| `send(chat_id, text, reply_to, token)` | Confirmed `ChatMessage`; requires exact matching prepared record; no default reply/token arguments |
| `reconcile_send(chat_id, token)` | Reconciliation record; resolves known native identity or preserves uncertainty, never resubmits |
| `adopt_failed_send(chat_id, message_id)` | `PendingSend` with `status:"failed"` and durable native identity; adopts an actual outgoing failed message for explicit retry, without sending or resending |
| `retry_send(chat_id, token)` | Confirmed `ChatMessage`; only retryable failed native local message via `resendMessages` |
| `abandon_send(chat_id, token)` | null; explicit release of failed/uncertain tracking, not native cancellation |
| `edit(chat_id, message_id, text)` | `ChatMessage`; checks native edit permission, edits text or media caption |
| `delete(chat_id, message_ids:number[])` | null; expands albums, checks all deletion permissions, `revoke=true` |
| `forward(chat_id, message_ids:number[], destination_id)` | Confirmed `ChatMessage[]`; expands albums and checks destination/source permissions, at most 100 expanded messages |
| `mark_read(chat_id, max_id)` | null; validates message membership, calls native `viewMessages` with chat-history source and `force_read=true`; only native updates advance backend read state |
| `photo(chat_id, message_id, preview=false)` | `Photo\|null`; supported image and native permission checks; previews may return null |
| `avatar(sender_id)` | `Photo\|null`; small cached user/chat profile photo; missing metadata/photo gives null |
| `select_peer(chat_id:number\|null)` | null; cancels prior typing, closes prior native chat and opens the selected chat |
| `typing(chat_id, active:boolean)` | null; selected writable-chat guard for active typing, cancellation for inactive; no draft text |
| `activity()` | null; records observed input and requests own online status best-effort |
| `load_state()` | normalized/recovered `ClientState`; may emit terminal send outcomes |
| `save_state(state:ClientState)` | null; validates state and folds terminal outcomes before private persistence |
| `logout()` | null; requires ready, native `logOut`, close and removal of new application state/outbox/sequence |
| `close()` | null; disconnects and clears in-memory account state, retains authorization/private files |

## QR-only authorization

`connect` either asks for API credentials, resumes a saved session or waits up to 30 seconds for an authoritative QR/password/ready/closed stage. Credentials must be the application's own API ID (positive int31) and 32-hex-character API hash from [my.telegram.org/apps](https://my.telegram.org/apps).

The authorization callback supplies truthful device/OS/application parameters to `setTdlibParameters`, uses the private database/files directories, enables file/chat/message databases, supplies an empty database encryption key and disables secret chats. `authorizationStateWaitPhoneNumber` immediately requests `requestQrCodeAuthentication(other_user_ids=[])`; it does **not** offer a phone field. `WaitOtherDeviceConfirmation.link` is encoded with `qrcode` into a PNG. Every new native update replaces the authorization object/QR. A successful ready transition first fetches `getMe` and sets own online status false.

Native TDLib rotates QR tokens. `request_qr()` during QR confirmation returns the current snapshot instead of pretending to force rotation; ready returns ready without revoking that session. At password stage, the explicit different-account operation logs out only the unfinished scanned key, closes and starts a fresh connection. Other supported retry situations request QR auth and await a newer stage. `sign_in_password` submits `checkAuthenticationPassword` and awaits the next authoritative stage. Wrong passwords/rate limits remain errors; unsupported phone/code/email/signup steps produce `AUTH_STEP_UNSUPPORTED`, not an alternate login path.

The application does not persist QR PNGs, login links or plaintext 2FA passwords in its state/logs. This does not mean native auth is memory-only: TDLib's private binlog retains QR-stage auth state/token for up to five minutes and password-stage state for up to 24 hours. Password-stage persistence is not plaintext password retention. Host/SDK memory and blob lifetimes are separate; see [security.md](security.md) and [tern-api.md](tern-api.md).

## Chats, history and authoritative updates

Dialogs are ordered by positive main-list TDLib positions, descending `(order, chat_id)`. `dialogs` serializes page loading, calls `loadChats` until enough positions exist or native 404 marks the main list exhausted, then obtains a `getChats` snapshot and waits up to ten seconds for matching position callbacks before slicing. The cursor is an offset into the **current** ordered cache, not an immutable server snapshot. Frontend page merging must tolerate concurrent reorderings and duplicates. This is local loaded-dialog search, not global Telegram search.

History starts at the latest messages (`before_id=0`) or walks strictly below an anchor. It fills short native cache pages until the requested count or an empty advancing batch; **one short page is not EOF**. It deduplicates IDs and returns chronological ascending IDs. A non-advancing anchor errors instead of looping.

Chat/message version counters fence awaited results against live updates. History and `getMessages` cannot resurrect permanent deletions or overwrite newer edits; message conversion rechecks its version after awaited sender/chat lookup. Full-group requests retain newer native metadata updates. Account epochs isolate callbacks after reconnect. Frontend generation, connection/thread identity and revision guards are also required; backend fencing does not replace [UI merge policy](ui.md).

Content updates **replace**, rather than merge, content so expired media loses its old identity. Expired content takes precedence over temporary ephemeral overlays. Ephemeral/edit/interaction/pin/opened updates revise cached messages or request a refresh if uncached. Permanent deletion evicts the message and increments its version; native cache eviction is not a UI deletion. A deleted pending native identity becomes uncertain, not delivered or safely retryable. Chat read maxima are monotonic and emitted from native read updates.

Before mutation, `_existing` validates every message's ID and actual membership in the specified chat using `getMessages`. Album resolution walks adjacent peer history in both directions until another album/boundary, not a numeric ID interval: private message IDs have gaps. More than ten members or foreign/unavailable selection fails. Forward/delete expand and deduplicate full albums **before** a server mutation, then check properties for every member. A partially returned forward raises `FORWARD_PARTIAL`; some members may already have been sent, so check the destination before retrying. Forward is not covered by the prepared-text-send ledger or an exactly-once guarantee.

Composer parsing supports bold, italic, strike, inline/fenced code (including language) and Markdown links. Send/text-edit limits are 4096 UTF-16 units **after parsing**; captions are additionally limited to 1024. Nothing is silently truncated. Native `formattedText` carries entities, link previews are disabled and cloud drafts are not cleared by send. Backend can edit permitted captions even though the current UI restricts its edit action more narrowly.

## Durable send state machine

The frontend sequence is **prepare → persist UI intent → send**. Draft persistence failure must stop before send. A queued-looking `PendingSend` from preparation is not evidence that TDLib was called.

An actual failed native message loaded from history or otherwise untracked uses **adopt failed native identity → persist UI intent → explicit retry**. This makes Retry available for displayed failures without recreating the message through `sendMessage`; adoption itself never sends.

| State | Evidence | Safe next operation |
| --- | --- | --- |
| `prepared`, `admitted=false` | Durable local intent; native send has not been invoked | Persist pending then call matching `send`; recovery returns text to draft and abandons safely |
| `uncertain`, `admitted=true`, no ID | Admission/resend ambiguity was persisted before native invocation | Internal read-only reconciliation; user must inspect chat before deciding on a new send |
| `queued`, native ID | TDLib returned a local sending message | Wait for outcome or reconcile; queued is not confirmed or discardable |
| `failed`, native ID | Native failed message/outcome | Explicit retry only if current native failure permits it; otherwise preserve draft/seek user decision |
| `sent` | Confirmed outcome or native message without sending state | Compact terminal metadata; remove matching pending, never replay token |
| `abandoned` | Safe prepared release or explicit stop-tracking decision | Restore/preserve draft, compact terminal metadata; not proof of non-delivery if admitted |

### Preparation and native admission

`prepare_send` validates text/IDs locally, releases older unlocked prepared records for that chat, then reserves a monotonically increasing token in `tdlib/send-sequence.json` **before** writing the prepared outbox item. A later write failure must not make the token reusable. Exhaustion at `2^31-1` errors with nothing sent. It does not perform live chat/reply permission checks.

`send` locks the token and requires the same chat, text and reply target. Missing/retired/unprepared tokens fail; terminal or mismatched tokens fail as reuse. A repeat call for a non-prepared active record reconciles and errors rather than starting a second send. Live writable/reply membership/`can_be_replied` checks happen before admission; preflight failure safely abandons prepared intent and restores text.

Immediately before `sendMessage`, the ledger durably becomes `uncertain, admitted=true`. `messageSendOptions.sending_id=int(token)` lets current updates correlate to the application intent, but **is not persistent TDLib state or an idempotency key**. A crash or request exception before a durable local ID is returned remains uncertain. No text/hash heuristic proves non-delivery, and no application retry recreates the send automatically.

### Native outcomes and retry

`sendMessage` may return a queued local message. The service records its ID and waits up to 30 seconds for `updateMessageSendSucceeded`/`Failed`. Early outcomes are kept by `(chat_id, old_local_id)`, so an update arriving before the request response is not lost. The outcome replaces the old identity, emits deletion of the old ID and the current message, and persists the ledger before emitting send state. Delayed updates cannot resurrect `sent`/`abandoned` records.

`SEND_PENDING` after the confirmation wait means TDLib may still finish; it is neither failure nor cancellation. Close also cannot prove delivery and rejects confirmation waiters as uncertain. `reconcile_send` queries `getMessage` for a known local ID: queued stays queued, native failure stays failed, a confirmed message becomes sent, and missing native identity (400/404) becomes uncertain. Without a local ID it remains uncertain. Terminal reconciliation returns metadata only, without refetching/replaying a body.

`reconcile_send` remains an internal RPC. The frontend automates read-only reconciliation on bootstrap/reconnect and response problems, with native updates as the primary outcome source; it does not offer a manual **Check delivery** action. Automatic reconciliation is safe because it does not submit or resend a message. Unresolved delivery stays honestly uncertain, rather than triggering a new send.

`adopt_failed_send` fetches the current native message and validates its exact int53 chat/message identity, outgoing status and `messageSendingStateFailed`. It shares retry eligibility/cooldown checks with `retry_send`: `can_retry` must be true, sender/reply/payment decision flags must be absent, and a positive `retry_after` remains a peer cooldown. Account/message versions fence the lookup; mismatched identity, a live change or a different unresolved intent in the same chat raises `SEND_RECONCILIATION_REQUIRED`.

After the awaited native lookup, adoption rescans the ledger and persisted pending. It reuses only a matching **unlocked admitted failed** record; it never reactivates a sent, abandoned or retired token. Otherwise it reserves a fresh monotonic token first, then persists `failed, admitted=true` with the native message ID. Its `PendingSend` result contains only `token`, `chat_id`, `text`, `reply_to`, `status:"failed"` and `message_id`. Text/caption is reconstructed from native formatted entities, and reply is retained only for the same chat. Captionless media uses empty text, not a display placeholder; empty recovery text never appends to or clears an unrelated draft. Token exhaustion fails with `SEND_TOKEN_EXHAUSTED`.

If adoption is replacing an allowed stale/terminal saved pending reference, it transfers that reference to the adopted intent **before** persisting a fresh outbox record, after reserving the high watermark. Matching failed-ledger reuse also transfers a stale saved token and raises the watermark first when necessary. This ordering prevents crash recovery from resurrecting the older missing/pruned token; drafts are unchanged. It does not remove the frontend's obligation to persist its returned full state before calling `retry_send`.

`retry_send` first reconciles, then fetches and validates the failed outgoing identity again immediately before native retry. Only an actual failed local message with `can_retry` is eligible. Requirements to change sender, reply quote, drop reply or pay Stars produce `SEND_RETRY_REQUIRES_DECISION`; the service never silently changes the user's message. Native `retry_after` becomes a peer cooldown. Before `resendMessages`, the old local ID is removed and uncertainty is persisted because native resend deletes/replaces that identity. A missing new ID leaves the retry uncertain and blocks blindly repeating it.

`abandon_send` first reconciles and refuses a still-queued attempt. Failed/uncertain release restores text and writes an abandoned tombstone. This is an explicit **stop tracking**, not cancel, success or proof that Telegram did not deliver. The user must inspect the chat before preparing a new send; a duplicate remains possible. See [ui.md](ui.md) for the confirmation controls.

### Recovery, retention and migration

Active records retain plaintext text/reply for recovery. `sent`/`abandoned` records retain only `token`, `chat_id`, `status`, optional `message_id` and admission marker; body/reply/errors are removed, including when loading old terminal records. No digest/body snapshot is retained.

Captionless retry has one private recovery-only field, `retry_from_message_id`, while an admitted resend is uncertain and has no active `message_id`. It preserves empty-text state validity across restart, not delivery evidence: the backend must **never fetch or resend that old ID** after admission. `load_state` maps it to the recovered empty-text pending's `message_id`, but reconciliation still sees no active native ID and cannot infer retry eligibility. The field is not returned in RPC reconciliation records or send events, is cleared when a replacement message is tracked, and is removed with terminal compaction.

The ledger keeps the latest **256 unreferenced terminal records**, plus all terminals referenced by persisted UI pending and **all unresolved records**. This is not a cap of 256 total records or a forever archive. Pruning never decreases the high watermark or allows token reuse.

`load_state` folds terminal outcomes into saved pending/drafts and emits outcomes for live UI reconciliation. A confirmed send removes only an exactly matching saved draft; newer text survives. Abandon/restoration preserves existing text, appending recovered text with a blank separator when different. Unlocked prepared records recover to drafts and abandon without native submission. `save_state` also folds terminal outcomes so stale UI writes cannot restore a terminal pending.

There is one carefully bounded legacy-sequence migration: before `send-sequence.json` first exists, the old unpruned ledger's missing token plus queued pending **without native message ID** proves non-submission and may become `abandoned, admitted=false`. Other missing legacy attempts become uncertain. Once the high watermark exists, an absent ledger token might have been pruned after delivery: saved pending recreates an **uncertain admitted** record and raises the watermark if necessary. Never generalize the initial migration rule to later missing tokens.

## Reads, viewers and activity

`mark_read` validates the exact boundary message and calls TDLib `viewMessages`. Its RPC success does **not** update backend read maxima; only `updateChatReadInbox`/`Outbox` does. Frontend requested/confirmed boundaries and single-flight merging live in [`ui/read-receipts.ts`](../terngram/ui/read-receipts.ts) and [`tests/read-receipts.test.ts`](../tests/read-receipts.test.ts). Keep the caller's captured boundary: do not extend a completed request to newly arrived messages. UI recent-input/detached heuristics are not measured host visibility; see [ui.md](ui.md).

`message_readers` validates membership, asks `getMessageProperties.can_get_viewers`, and calls `getMessageViewers` only if allowed. It returns the actual vector length; 0 is valid only for a returned empty vector. Viewer-request 400/403/404 returns null; rate/network failures remain errors. The service relies on native permission, rather than duplicating explicit own/read/group conditions; the UI chooses eligible own-read-group selections. Demand caching/throttling is in [`ui/reader-counts.ts`](../terngram/ui/reader-counts.ts) and [`tests/reader-counts.test.ts`](../tests/reader-counts.test.ts).

`select_peer` manages native `openChat`/`closeChat` and prior typing cancellation. Active typing requires that selected writable conversation and is throttled to once per four seconds by the backend. Inactive typing cancels only the currently tracked peer. The service does not contain a special Saved Messages/bot exclusion. Draft text never enters typing RPC. Incoming actions omit the current user and emit a six-second UI lifetime; presence preserves coarse privacy states and server expiry rather than inventing precise last-seen times.

`activity` means observed app input, not pane focus. Ready starts offline; observed activity requests online, a one-second watcher requests offline after 60 seconds idle, and close/logout attempt cancel/offline best-effort. Activity requests require a ready connected client, have five-second waits and per-method cooldowns after failures; account epoch/client identity fence their results. Failure cannot guarantee cancel/offline delivery or turn a send into success. Frontend cadence, expiry timers and host limitations are in [ui.md](ui.md).

## Private files and media access

The CLI default is `$XDG_DATA_HOME/terngram` or `~/.local/share/terngram`; `--data-dir` replaces it. Never inspect or attach a real account directory to routine development tests.

| Path relative to data directory | Contents/lifecycle |
| --- | --- |
| `credentials.json` | API ID/hash, shared with the old layout; not a session |
| `tdlib/db/` | Native authorization, chat/message/file database and native image cache |
| `tdlib/files/` | TDLib downloaded files |
| `tdlib/state.json` | Local drafts, selected chat and pending sends; no restored scroll/reply/edit session |
| `tdlib/outbox.json` | Active prepared/queued/failed/uncertain intents and compact terminal metadata |
| `tdlib/send-sequence.json` | Monotonic token high watermark |
| `tdlib/last-error.json` | Safe last-operation diagnostic locations |

Private root/TDLib directories must be owned by the current UID, non-symlink directories and are tightened to `0700`. JSON reads use `O_NOFOLLOW`, regular-file/owner checks and `0600`. Writes use a private temporary file, flush/file fsync, atomic replace and parent-directory fsync. These are permissions and crash-safety measures, **not encryption at rest**; `database_encryption_key` is empty. Native database/media retention and host memory are distinct from application JSON retention.

The old `account.session`/sidecars and root `state.json` are preserved. If new state is absent, only plain legacy draft texts migrate. Legacy pending text fills a draft only when that chat's draft is empty; otherwise it remains in the untouched old file. Legacy selected/reply/message/transport IDs and unfinished sends are not translated or submitted. Authorization requires a new QR login, not import of the old session.

Successful `logout` calls native `logOut`, closes and deletes **`tdlib/state.json`, `tdlib/outbox.json` and `tdlib/send-sequence.json`**, then clears their memory caches. It preserves credentials, legacy personal files and native directories. TDLib handles its own logout/database lifecycle; this is not secure erase of downloaded files or host blobs. Failed logout is not reported as successful revocation. Ordinary close/quit retains the saved session.

### Media read boundary

`photo` supports native photos and image documents with MIME JPEG, PNG, GIF, WebP or BMP. Photo preview picks the smallest valid size with long side at least 320 pixels, otherwise the largest; full opens select the largest. Document preview uses only JPEG/PNG/WebP thumbnails and returns null if absent/unsupported, regardless of original file size. Full document reads original bytes and derives dimensions with Pillow; Python does not resize originals. Avatars use cached user/chat metadata and the small photo, not legacy access-hash resolution.

The service checks current restriction/ephemeral state, `can_be_saved`, both user protection flags and chat protection before download. Self-destruct/view-once previews return null without consuming content. Non-saveable temporary content is refused; self-destruct content requiring protected viewing gives `MEDIA_PROTECTED_VIEWER_REQUIRED`, a limitation of this host/viewer, not a claim that Telegram cannot display it. Allowed explicit full opens call native `openMessageContent`. Message version fences after access checks, download and open reject media that changed or expired in flight. Content replacement and permanent deletion must invalidate paired frontend image caches; see [ui.md](ui.md).

Replacement/removal during photo lookup, access checking, download or open publishes the current model and returns `MEDIA_CHANGED`, never the old download. Missing/removed photo snapshots no longer leave a stale photo action in the frontend. Permanent deletion markers prevent late native snapshots from resurrecting deleted media; uncached changed messages are refetched with the existing `getMessages` transport and version-fenced. The frontend then evicts obsolete preview/full-image entries, loads the authoritative replacement if it remains a photo, or removes the photo/member/message. No new RPC, generic network retry, protected-content bypass or “photo unavailable” placeholder is added. Other access, protection, identity, network and filesystem failures remain errors.

A returned native path is readable only beneath:

* `tdlib/files/**`;
* `tdlib/db/{profile_photos,thumbnails,secret_thumbnails,stickers,wallpapers,stories,photos}/**`.

The database root, `db.sqlite`, `td.binlog`, `db/temp/` and all other auth/state paths are forbidden. Secure image cache placement follows the audited TDLib [`FileType.cpp`](https://github.com/tdlib/td/blob/42e6a5259551178d1dab54a22ad96d14bd906e20/td/telegram/files/FileType.cpp) and [`FileLoaderUtils.cpp`](https://github.com/tdlib/td/blob/42e6a5259551178d1dab54a22ad96d14bd906e20/td/telegram/files/FileLoaderUtils.cpp); allowing a cache directory does not bypass message permissions.

Download must be complete. Paths containing `.`/`..`, paths outside the private roots and symlink escapes fail. Only ancestors above the private root may be canonicalized (for OS aliases such as `/var`); every private directory and file component is opened relative to directory descriptors with `O_NOFOLLOW`, UID checks and tightened permissions. Final files must be regular. Do not replace this with unrestricted `resolve()` and `read_bytes()` on a native-returned path.

## Safe errors and change checklist

`ClientError` is explicitly safe UI text. Known native errors map to fixed messages/codes; generic exceptions become a generic local failure, never raw Telegram inputs. Native 420/429 retry hints are parsed into `retry_after`; worker responses carry a method or peer scope (`SLOWMODE_WAIT`/explicit retry uses peer scope). Frontend stores monotonic cooldowns and refuses early calls; it does not automatically retry. See `TDLibError`, `_safe_error`, `retry_after`, `retry_scope` and `RequestCooldowns` before adding an error path.

`record_error` writes operation, root exception class and at most 12 stack locations (basename/function/line) to private `last-error.json`. It excludes exception values, arguments, locals, messages, credentials, tokens and full paths. Diagnostic-write failure does not replace the original error. Worker stdout must never receive raw tracebacks; stderr is ignored by the frontend, not a safe place for secrets.

When changing this boundary:

1. Update the service signature, worker allowlist/admission classification, TypeScript DTOs and every caller together. There is no compatibility alias layer.
2. Preserve callback/request separation, native-close waiting and account fences. Pair changes with `test_tdlib.py` and worker concurrency/EOF cases in `test_telegram.py`.
3. Preserve prepare/persist/admit ordering, monotonic tokens, outcome races, compact retention and missing-token recovery distinctions. Cover failure before/after native invocation, disk failure, reconnect, late outcomes and newer user draft preservation.
4. Pair history/update changes with backend race cases and [`tests/history.test.ts`](../tests/history.test.ts); pair reads, viewer counts, activity and cooldowns with their dedicated tests.
5. Pair media/storage changes with private-file/symlink and media-version cases in `test_telegram.py`, [`tests/images.test.ts`](../tests/images.test.ts) and [`tests/photo-viewer.test.ts`](../tests/photo-viewer.test.ts). Never loosen path admission to fix a cache-placement issue.
6. Update this guide and the linked UI/security guide for changed behavior. Test fixtures and native smoke demonstrate contracts, not live QR login, delivery, cryptographic audit or final host visibility/geometry; do not convert them into those claims.
