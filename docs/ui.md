# Application UI

This is the implementation guide to Terngram's native application: who owns state, how user actions become requests, and which invariants must survive asynchronous updates. For setup and contributor workflow, start with [development.md](development.md). The [backend reference](backend.md) owns the complete RPC, TDLib, persistence, filesystem and outbox contracts; [tern-api.md](tern-api.md) owns the native SDK/wire contract.

## Task and file map

Paths below are relative to `terngram/ui/`.

| Task | Implementation |
| --- | --- |
| Launch, real hello gate, signals and terminal EOF | [main.ts](../terngram/ui/main.ts) |
| Auth, worker lifecycle, commands, focus, overlays, request orchestration | [app.ts](../terngram/ui/app.ts) |
| Chronological history, revisions, albums, drafts, reply/edit snapshots | [chat-state.ts](../terngram/ui/chat-state.ts) |
| Back/Forward, five recent chats, double-arrow recognition | [chat-navigation.ts](../terngram/ui/chat-navigation.ts) |
| Conversation status versus composer context | [chat-dock.ts](../terngram/ui/chat-dock.ts) |
| Stable message cards, literal entity-formatted text, avatars and preview descriptions | [message-view.ts](../terngram/ui/message-view.ts) |
| Palette and writable forwarding destinations | [command-palette.ts](../terngram/ui/command-palette.ts), [forward-picker.ts](../terngram/ui/forward-picker.ts) |
| Full-photo selection, captions and album navigation | [photo-viewer.ts](../terngram/ui/photo-viewer.ts) |
| Background image deduplication and bounded concurrency | [image-loader.ts](../terngram/ui/image-loader.ts) |
| Read boundaries and on-demand reader counts | [read-receipts.ts](../terngram/ui/read-receipts.ts), [reader-counts.ts](../terngram/ui/reader-counts.ts) |
| Server-directed request deadlines | [request-cooldowns.ts](../terngram/ui/request-cooldowns.ts) |
| Shared controls and contextual keyboard help | [nodes.ts](../terngram/ui/nodes.ts), [shortcut-help.ts](../terngram/ui/shortcut-help.ts) |
| Worker subprocess, JSONL requests and event types | [telegram.ts](../terngram/ui/telegram.ts) |

There is no generic entity/action engine. Components own concrete objects and actions; uncommon operations belong in the palette, and current context stays beside the object.

## Surface ownership

`TerngramApp.describeSurface()` returns `main: [Body]` and `dock: [TerngramApp]`. Body caches its description until invalidated, so typing can update the dock without rebuilding history. Loaded/loading chats retain stable `thread-<chat_id>` nodes; inactive threads are hidden rather than moved into popups.

```text
main
  welcome/auth or logout-confirmation card
  OR selected conversation and hidden cached threads
    earlier-history control, message/album cards, latest tail anchor
dock
  auth fields and controls
  OR optional uncertain-delivery warning + Restore/Stop tracking controls
     conversation status
     composer context: selection / delete confirmation / reply / edit
     transient notice
     native editor + compact sending spinner + Send/Save (writable only)
layer (SDK-owned)
  palette / forward picker / help / photo gallery
```

The editor is the last permanent dock block. Conversation title, type, unread count, TDLib chat ID, participant/subscriber count, connection and loading state remain conversation status; selected-message/reply/edit/delete context must not replace them. Missing participant counts stay unknown, not zero. Full chat metadata is loaded on demand; Ctrl+R can refresh it. `Telegram disconnected` describes transport, not the other person's presence.

The SDK exposes a bottom dock, not a top header region. An overlay obscuring history or a scrolling title is not a substitute for a fixed header. One-line labels retain their full value in `title`; bounds and wrapping express layout intent, while the host determines rendered geometry.

## State and lifecycle

**Process-local:** auth stage, account/connection status, dialog cursor, threads, scroll commands, detached flags, navigation/MRU, selection and confirmation state, overlays and return focus, typing/actions, request identities and image/description caches. Each `ChatState` owns messages, loading/more, draft, reply target, edit snapshot, sending/pending state, incoming-message IDs, revision/change markers, outgoing read maximum and grouped-message cache.

**Persisted:** API credentials and TDLib's private database/files, plus client drafts, selected chat and pending-send intent. Ordinary reply/edit targets, UI history, scroll/detached, overlays and QR images are not restored. While editing, persistence saves the original draft rather than the edit buffer. Draft writes are debounced by 250 ms and serialized; the required write before a new send propagates disk errors and prevents submission. These are local drafts, not Telegram cloud drafts. File formats, migration and private-data boundaries are in [backend.md](backend.md) and [security.md](security.md).

Generation, connection/thread identity, search versions and per-request markers fence late responses. A reply from a previous account or superseded request must not mutate current state or clear a newer request's loading marker. Account reset clears navigation and account-scoped caches. Reconnect preserves drafts, replaces the worker and refreshes the selected history. Quit waits for persistence, clears overlays/loaders/secret fields and closes worker/TUI without logging out; signals and stdin EOF take this same path. Logout requires confirmation and only clears account state after successful revocation. A failed logout is not successful cleanup or secure erasure.

### Authorization frontend

Start checks saved credentials, then connects to TDLib. Its authoritative authorization updates select credentials, QR, password, ready or closed UI. Login is **QR-only with optional two-step verification**: no phone, code, email or signup form. The service encodes TDLib's actual login link as PNG; it does not invent a local token. Every new authorization update can replace the QR. There is no app countdown or idle refresh pretending to rotate it; error-only **Retry QR login** obtains available auth state.

The user scans with an already signed-in Telegram device and confirms there. Password stage shows the hint and masked **Unlock** field. **Use a different account** genuinely discards an unfinished scanned login and starts a fresh QR flow; it does not revoke an already-ready session. Ready bootstraps account name, dialogs and client state, then restores selection. Password/API hash fields are cleared after transfer; QR nodes disappear on stage change, disconnect, reset or quit.

The app does not persist QR PNG/login link or plaintext 2FA password in its state/logs. This does not mean no native auth state reaches disk: TDLib retains QR-stage state/token in its private binlog for up to five minutes and password-stage state for up to 24 hours. Nor does removing a node erase SDK/host blob bytes; see [native privacy and blobs](tern-api.md).

## Palette, paging and focus

Ctrl+K opens chats and commands; Ctrl+F opens chats only. `>` restricts commands and `@` restricts chats. Filtering uses locally loaded names and search text, not a Telegram contacts/message search. With no effective query, native `picker.order` separates the five unique recently visited chats from other results without duplicating items. A nonempty query removes Recent grouping and searches the unified catalog. Result descriptions expose Current, Draft, unread and availability context.

Missing dialogs load sequentially in pages of 60, sharing one in-flight page request across input/open actions. Closing or clearing search stops further paging, but an already-started page can still populate cache. An exhausted cursor is not reset by refreshing page one. Near the last five chat results, palette/forward selection can request another page. The palette remains `state=ready` while loading, retaining usable commands/results and reporting loading in its message instead of replacing them with a skeleton.

Native **select changes context; activate or confirm executes**. Disabled results are neither selected nor activated, and confirmation is disabled without an available result. The forwarding picker contains loaded writable chats. Back/Forward uses visit history, not dialog order: a new visit after going back drops the forward branch, unavailable chats are skipped, selecting the current chat adds no duplicate, and navigation updates MRU without adding another history entry.

Focus belongs to TUI components. Writable chats cycle messages ↔ editor with Tab/Shift+Tab; read-only chats have messages only. Overlays capture their own keys and restore the saved focus target. Palette opening is restricted to chats, outside busy state and other modal contexts. Hide/Show contextual hints is a session-local palette setting: it removes instructional chrome, not object data, errors, reply/edit context or confirmations.

### Keyboard contract

Use **Control**, not Command. Core paths do not require function keys, Home/End or Page Up/Down.

| Context | Keys |
| --- | --- |
| Anywhere | Ctrl+Q / Ctrl+C quit, including overlays |
| Chats, no overlay | Ctrl+K palette; Ctrl+F chats; Ctrl+G help; Ctrl+R refresh; Ctrl+L latest |
| Messages or empty editor, no modal/busy/delete confirmation | Double ← / → within 350 ms: Back/Forward |
| Messages | ↑/↓ select a message/album; ↑ at first loaded group loads older; Ctrl+U/D scroll a page |
| Selected message, messages focus | Enter reply (Retry for failed message); R reply; E edit own text without photo; F forward; P photo; X/Backspace/Delete request deletion of own/outgoing messages only |
| Editor | Enter/Ctrl+Enter send or save; Shift+Enter newline; ↑ in empty editor edits latest own text without photo |
| Picker | Type filter; ↑/↓ select; Enter activate; Esc cancel |
| Gallery | ←/→ album photo; Esc/Close close; zoom is host-owned |
| Help | Esc/Ctrl+G close |
| Delete/logout confirmation | Enter confirms; Esc cancels |
| Auth | Tab fields; Enter submit credentials/password; QR scan occurs in official Telegram |

The interceptor ignores key-release, records activity, recognizes double-taps only in the permitted context, handles global quit, then delegates to the top overlay before chat/editor actions. Explicit Kitty repeats do not retrigger single-press modal/submit/refresh actions or count as a double-tap. Legacy input cannot distinguish holding an arrow from repeated physical presses. Single arrows are not delayed. Message-letter shortcuts and paging do not steal ordinary nonempty editor input.

Without an overlay, Esc cancels a pending gallery opening first, then deletion confirmation, selection, and reply/edit; it preserves ordinary draft text. Deletion confirmation absorbs normal typing/submit, although global chat shortcuts have earlier priority. Server permissions/time limits remain authoritative: owning a message is not a promise Telegram will allow editing or deletion.

## Draft, edit and pending-send transitions

Opening a chat immediately selects it, restores its draft/focus, schedules persistence and decorations; history is awaited only if not yet loaded. Reply preserves draft text. Edit snapshots the original draft/reply target and uses the message's Markdown; cancel restores that snapshot. A successful edit restores it only if the user has not changed the buffer/mode meanwhile. Delete updates clear removed reply/edit targets. Albums are one selection unit; a missing reply target displays its message number.

Message bodies and captions use native text spans derived from Telegram entities, with separate native code blocks for preformatted ranges. The renderer preserves literal parentheses, brackets, dollars, backslashes and URL text rather than passing compose syntax through Tern's Markdown/LaTeX parser. Bold, italic, strike, inline code and link targets remain semantic formatting. Invalid UTF-16 ranges, including mid-surrogate offsets, do not split the original text. The message's `markdown` field remains editable compose syntax; it is never drawn as the message body.

A new send follows **prepare → persist client pending → submit → confirmed outcome**, never an optimistic success card. `prepare_send` allocates a durable local intent before UI persistence; a persistence failure blocks `send`. A queued TDLib message remains awaiting confirmation, not sent. Live events and RPC replies pass through the same ID-deduplicated receive path. Confirmation can replace a local message ID with the server ID and clears only matching pending text/reply, never newer user input. A successful new send in the selected chat goes to latest; editing is not a new send.

Queued state uses a compact native dots spinner beside Send/Save, not a large pending card or an application animation timer. It remains while awaiting confirmation even after the request finishes and with contextual hints hidden. Pending non-edit sends disable ordinary submission, but the editor still accepts a newer draft; Save keeps its separate edit semantics.

Native send-state updates are primary. Restored pending attempts are reconciled automatically during bootstrap/reconnect, and ambiguous submission responses trigger reconciliation rather than requiring a manual check action. A response timeout is not a delivery failure or reason to show a failure toast for an ordinary queued send. Automatic reconciliation checks an existing attempt; it never blindly sends uncertain text again. There is no **Check delivery** button, palette entry or manual workflow.

| Pending UI | Meaning/action |
| --- | --- |
| Compact sending spinner | Queued, not confirmed delivered |
| Failed transcript message | Remains at the same position with native `tone:error` / `status:error` styling; selecting/clicking it exposes **Retry · Enter** for its existing TDLib failed identity |
| Uncertain warning | Appears above the entire conversation dock, including status; retains Restore text (if nonempty) and Stop tracking buttons; no automatic resend |
| **Restore pending text** via Ctrl+K / warning's **Restore text to composer** | Restore/append text without replacing a newer draft; ordinary Send stays blocked while tracked |
| **Stop tracking this send…** | Uncertain only, button or palette; explicit **I checked this chat · Keep draft and stop tracking** confirmation for text, or **I checked this chat · Stop tracking** for captionless media |

Retry does not create another message/recovery card. The same failed message keeps its error styling while retrying, can show native sending progress, and loses the error state only on actual server confirmation; another failure leaves it failed. The palette also exposes **Retry failed message** where eligible. A local response timeout must never manufacture failed delivery.

A failed message loaded from history may have no current UI pending token. Its retry path adopts the existing native failed identity with `adopt_failed_send`, persists the admitted client pending intent, then calls `retry_send`; it does not prepare a new ordinary send. Album-member actions retain the actual failed member identity. The backend admission/eligibility contract is in [backend.md](backend.md).

Captionless failed media adopts an empty-text intent, not a fabricated `[Photo]` composition. It has no Restore text action. Retry still uses the original native message; confirmation, reload and uncertainty abandonment leave unrelated composer draft/reply/edit state unchanged. Captionless stop-tracking labels say the composer remains unchanged and still warn that delivery is not canceled.

Stopping tracking is not canceling TDLib delivery or proving nondelivery. The attempt can finish later; a subsequent new send can duplicate it. Never-submitted prepared recovery is a separate safe case, not permission to discard ambiguous sends. Local tokens are monotonic sending identities, not transport random IDs or an exactly-once guarantee. The complete ledger, admission, reconciliation, migration and retention rules belong in [backend.md](backend.md).

## History, revisions and read decisions

Initial/latest history requests 50 messages; older uses the minimum loaded ID. The backend fills short native cache pages rather than treating one short page as EOF. `ChatState` merges sorted pages linearly by ID, with page overlap winning only where no newer live revision exists. Refresh replaces the requested latest tail while retaining earlier history and changes made after request start. Live edits/deletes/read changes must survive slow pages. Group caches invalidate on message changes; album IDs remain decimal strings. Metadata renames invalidate descriptions/search without pretending the message was edited.

Refresh requests dialogs and latest history concurrently, coalesces duplicate dialog refreshes and preserves newer live previews. Targeted `dialog_changed` updates refresh only affected title/avatar/permissions/participants. Full metadata and request identities are account-isolated. Server cooldowns are monotonic and scoped by method or method+peer; shorter subsequent deadlines cannot shorten them. Reconnect retains them within an account, account change clears them. User operations are not automatically replayed or resent. Automatic send reconciliation may defer its read-only check until a server-directed retry-after expires; that is not a new submission.

`newMessages` is a local set awaiting UI acknowledgment, not Telegram's `unread_count`; own/duplicate/edit/already-read messages do not create another new arrival. Outgoing sent→read is Telegram's read receipt, not local scrolling.

1. First successful current-chat load explicitly follows latest and requests reading through the last loaded ID. Latest/Ctrl+L/the new-message control and confirmed ordinary send do likewise.
2. Older loading, either keyboard page direction, selecting an older group or clicking an older card sets per-chat **detached**. Switching away/back or merely selecting the final card does not clear it; explicit latest does.
3. `catchUp` runs only in chats, selected and non-detached, outside busy/quit/palette/help/gallery/forward, with observed app input within 60 seconds. Incoming messages, selecting an already-loaded chat, keyboard input and composer changes can trigger it. Incoming events do not force scroll/reveal.
4. `ReadReceipts` separates requested from confirmed boundaries, allows one RPC per chat and coalesces the exact requested maximum. Completion does not reread the current tail and accidentally include messages received after the decision. Failure does not advance confirmed; a later decision can retry. Account/reset/reconnect/quit detach old queues.
5. Unread reaches zero only when confirmed maximum covers the dialog's last message. Acknowledgment removes local incoming IDs through that boundary. Latest is the explicit user path; there is no separate palette mark-read command.

This is a **recent-input/follow heuristic**, not visible-pixel reading. TSP provides neither actual message viewport nor foreground pane focus to the app; trackpad scrolling is unobserved. TDLib `viewMessages` success confirms the request, not that the host painted or the person saw the message. Desktop/Web comparisons and compliance consequences are in [desktop-parity.md](desktop-parity.md).

Own read group messages request viewer count only after 300 ms of settled selection. Fast navigation cancels not-yet-started lookup. `ReaderCounts` is single-flight, keeps at most 256 entries, waits at least 30 seconds after completion, honors longer server retry-after and does not poll background chats. Invalidating data does not remove the safety interval. Unknown/unavailable stays ordinary sent/read, not `read 0`; zero requires an actually empty viewer list.

## Transient actions and privacy-preserving presence

These signals are distinct from transport connection and the read heuristic:

- Composer user edits with nonempty text send typing at most every four seconds for the selected writable chat. Programmatic draft restoration is not typing. Empty input, five seconds without edits, chat change, send/edit, logout confirmation, disconnect/reset/quit stop it where possible. Backend repeats selected-peer/throttle guards. Draft text is never part of typing RPC.
- Incoming sender actions are memory-only and expire after six seconds, cancellation or that sender's message. Own actions are excluded; the current dock displays typing/recording/uploading and known action labels.
- Telegram-provided personal presence retains coarse privacy states rather than inventing exact last-seen. Online expires at the server's absolute deadline. Each timer wait is capped at **2³¹−1 ms**, then remaining time is recomputed; the cap does not shorten expiry or cause a one-millisecond overflow loop.
- Observed keyboard/native actions and composer edits call activity at most every five seconds. Backend transitions its TDLib online option, with 60 seconds idle becoming offline. This is not host foreground detection.
- Transient errors honor server cooldowns and are best effort, not a notice per keystroke or evidence that send succeeded. Network failure cannot guarantee cancel/offline delivery. Generation/connection identity isolate old-account events.

## Images, albums and gallery

### Background decorations

Only the selected chat's loaded history queues previews, up to four photo nodes per known group. This is not viewport lazy loading. Previews use `32ch × 10lines` bounds in a wrapping row and explicit photo-open actions; **View photo(s)** remains available without a thumbnail. Backend chooses a dimensioned Telegram thumbnail with long side at least 320 px where available, otherwise the largest; 320 is a selection target, not a hard size cap. An image document without thumbnail returns no preview regardless of original size; opening explicitly downloads the original.

Preview and avatar loaders each allow two concurrent tasks, deduplicate and take newest queued requests first. `undefined` is not loaded, `null` means unavailable, errors remain errors and allow a later request. Media cache keys include `chat_id:message_id:media_id`, so replacement does not reuse old bytes. Invalidation fences old success/failure/finally against replacement entry identity. Switching chats drops queued work but keeps completed/active cache; account reset/quit clears entries. Already-running RPCs retain their slots until completion and are not canceled by clearing the loader, but their old results cannot publish.

Avatars use sender identity and TDLib metadata. Unavailable photos use centered initials in a **rounded-square native card**, not a pill badge, with fixed `4ch × 2lines` bounds matching the photo slot. Loading does not change the reserved footprint. Actual radius and pixel geometry remain host-owned.

### Explicit full viewing

Local grouped history is not proof of a complete album. First gallery open resolves `album(chat,id)` independently of loaded pages and revision-fences the result; backend traverses peer history, not an ID range, and limits albums to ten members. Completeness is reused until refresh/reconnect/gap. Forward/delete independently resolve full albums before changing the server.

Missing full photos load together with `Promise.all`, not lazily by gallery index. Nodes use `80ch × 28lines` bounds and media-aware cache keys; full-image wire keys stay stable by chat/message to preserve selection on byte replacement. The viewer shows one image, its caption and index/count; it starts on the clicked image, keeps the selected key across updates, clamps when removed and hides extra navigation for singletons. Delete/expiry removes unavailable members or closes the viewer. Closing restores focus.

Account generation and a separate opening-intent counter prevent late downloads from replacing newer choices, opening after Escape/chat change or displacing palette/help/forward. Request cleanup removes only its own loading marker. Gallery size `lg`, wrapped controls and nonsqueezing buttons are semantic layout choices, not pixel promises. Inline click opens the app's full gallery; ordinary gallery image click delegates zoom to the host.

### Expiry and limits

Authoritative content/ephemeral updates replace media identity; expiry must outrank stale temporary content, and deletion invalidates caches. Backend permission/version fences reject stale downloads. Self-destruct/view-once content is not auto-downloaded or consumed by preview. Explicit full open follows actual TDLib permissions and calls `openMessageContent` only on permitted paths. Protected/non-saveable or policy-restricted media is rejected; `MEDIA_PROTECTED_VIEWER_REQUIRED` means this host/viewer lacks the required protected surface, not that Telegram universally forbids viewing it. Exact checks are in [backend.md](backend.md).

App image caches have no TTL/LRU; TDLib separately has a disk media cache. Removing UI nodes/cache entries does not release the process-global SDK blob registry or prove host-byte erasure. The native lifecycle caveats and unimplemented GIF/sticker/custom-emoji research are in [tern-api.md](tern-api.md); privacy/compliance limits are in [security.md](security.md) and [desktop-parity.md](desktop-parity.md).

## Change checklist

- Keep stable thread/message/album keys and complete cache dependencies; invalidate descriptions as well as request rendering.
- Fence asynchronous work by account, object/request identity and content revision as appropriate.
- Preserve newer drafts across edit/send/recovery; never infer send success from queued state.
- Keep read boundaries tied to the decision, not the tail at RPC completion; describe the heuristic honestly.
- Keep conversation status separate from composer/confirmation context and return focus after overlays.
- Exercise affected offline state, palette, navigation, images, viewer, read-receipt and cooldown tests through the workflow in [development.md](development.md). The native smoke proves frames/state routing, not real host geometry, live auth or Telegram delivery.
