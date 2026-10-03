# Native Tern integration

Terngram uses the native Tern Surface Protocol (TSP), through `@oh-my-pi/pi-tui` and `@oh-my-pi/pi-wire`. This is a semantic component tree, not HTML/CSS or an ANSI application with images layered over terminal rows. Dependency versions are recorded in [package.json](../package.json) and [bun.lock](../bun.lock).

This document separates **installed SDK/wire contracts** from **host behavior**. Tern renderer sources and the normative `crates/tern/SURFACE_PROTOCOL.md` referenced by the SDK are not in this checkout. Types establish available descriptions, not proof that a particular host supports, paints or plays them. Runtime hello establishes advertised capabilities; real-host observation establishes geometry and interaction behavior.

For app policies use [ui.md](ui.md); for the separate Python JSONL/TDLib transport, native library loading and filesystem catalog use [backend.md](backend.md). TSP does not implement Telegram networking or download files itself.

## Implementation and source map

| Change | Repository integration |
| --- | --- |
| Launch/hello and surface title/role | [main.ts](../terngram/ui/main.ts) |
| Plugin tab launch and shell quoting | [window.luau](../packaging/tern/window.luau), [runtime bootstrap](../scripts/launch_release.sh) |
| Frame provider, focus, native actions and overlay orchestration | [app.ts](../terngram/ui/app.ts) |
| Message identity, literal text/entity formatting, portraits and preview nodes | [message-view.ts](../terngram/ui/message-view.ts) |
| Dock roles and composer order | [chat-dock.ts](../terngram/ui/chat-dock.ts) |
| Native picker query/caret/filter/selection | [command-palette.ts](../terngram/ui/command-palette.ts), [forward-picker.ts](../terngram/ui/forward-picker.ts) |
| Full-photo overlay and stable selection | [photo-viewer.ts](../terngram/ui/photo-viewer.ts) |
| Shared action controls and background images | [nodes.ts](../terngram/ui/nodes.ts), [image-loader.ts](../terngram/ui/image-loader.ts) |

Plugin tab commands are interpreted by the user's login shell. The launcher invokes `/bin/sh -c` explicitly for its POSIX conditional and quotes the outer argument for both fish and POSIX shells, including paths containing spaces or apostrophes. Do not pass `if … then … fi` directly to the login shell.

After dependency installation, inspect these **local package source paths** when changing or upgrading the integration (not generated-declaration links that assume `node_modules` exists in a repository browser):

- `node_modules/@oh-my-pi/pi-wire/src/tsp.ts`: kinds, props, events, hello, frames and wire comments.
- `node_modules/@oh-my-pi/pi-tui/src/native/node.ts`: describe boundaries, surface types, events and UTF-16 editing.
- `native/describe.ts`, `native/memo.ts`, `native/blobs.ts` in that package: builders, reference memoization and image bytes.
- `native/picker.ts` and `components/select-list.ts`: sheets, query/event helpers and selection policy.
- `native/backend.ts`, `native/reconcile.ts`, `native/encode.ts`: transport, event routing, identity, diffing and APC encoding.
- `tui.ts`: component, overlay and focus lifecycle; `native/apply.ts`: reference document, not a renderer.

## Describe contract and stable identity

A component implements `describe(cx): NativeNode | null`. Nodes have `k` (kind), `p` (kind-specific props), `c` (nodes or component children), and optional **top-level** `key`, `reveal` and `scroll`. The reconciler assigns wire IDs; do not replace them with Telegram IDs.

- A component child is a separate describe boundary with its own stable ID prefix and event owner.
- `key` identifies siblings within the owning component; absent keys default to index. Insertable/reorderable messages, albums and results need stable keys.
- `p.key` in wire props does not replace `NativeNode.key` for reconciliation.
- Returning the same description object means the subtree is unchanged. Do not mutate already-returned descriptions; rebuild or clear memo when dependencies change.
- `Memo.get(deps, build)` compares with `Object.is`; `OwnerMemo` associates memo with an owner. Include selection, caret, members, reply, appearance and external decorations that affect the tree.
- Application `invalidate()` clears cached descriptions; `requestRender()` schedules work. Neither substitutes for the other.

Terngram uses stable `thread-<chat>` and message/album keys. Message descriptions depend on member object identities, sender/reply names, selection, loading, reader count, avatar and preview nodes. A selected card adds a reveal anchor under its portrait without replacing the card key. Media cache identity includes `media_id`, while the full-image node key stays stable by chat/message.

A component without `describe` falls back to `rows` and calls `render(cx.cols)`. That SDK migration path is not native Markdown. Terngram's principal components deliberately throw on ANSI rendering; there is no browser/ANSI fallback.

## Surfaces, dock and overlays

| Construct | Ownership/meaning |
| --- | --- |
| Surface | SDK-owned ID; wire `o` opens/adopts `inline` or `screen`, `x` closes |
| `main` | Flowing document; close with `keep: true` can retain it in scrollback |
| `dock` | Sticky bottom chrome while the surface is live |
| `layer` | Wire overlay region, managed by SDK backend |
| Generic overlay | `tui.showOverlay(component)` wraps it in an `overlay` node in `layer` |
| Native sheet | `nativeSheet(cx) === true` describes `picker`/`prefs` directly in `layer`, without another overlay frame |
| Screen page | `describeScreen(cx)` supplies `main`, `dock` and `role` for a separate screen surface |

`NativeSurface` contains **only `main` and `dock`**; do not add `layer`. Terngram returns `{ main: [this.body], dock: [this] }`, and the SDK manages gallery/help overlays and palette/forward sheets. `dockedPicker()` can hoist a selector from dock/editor into layer; use `pickerEvent` to normalize its special keypath.

The whole dock is sticky, not an arbitrary editor inside it. Large lists or multiline content increase dock content; the API does not establish a fixed-height independent panel or top-dock/header. Generic anchor (`center/top/bottom`, node side or caret) and size (`sm/md/lg/full`) are semantic hints, not pixel offsets. Native sheet is not a screen merely because an overlay option says fullscreen.

Keep the overlay handle and saved focus. `hide()` permanently removes the overlay; that handle cannot be shown again. `setHidden(true/false)` is temporary hiding; `isHidden()` reports it. On close, clear app popup state and restore focus to an available component. Esc/custom close is app policy; hiding an overlay does not cancel a domain edit or restore a reply draft automatically.

## Kinds, props and geometry

Hello's `kinds` and `cx.supports(kind)` decide advertised support; kind existence in wire types is not sufficient. `cx.feature(name)` checks features such as `scroll` or `aside` (a prefs sheet docking beside a narrowed transcript). `DescribeContext` also provides `dark`, `reduceMotion` and `cols`; it is not a clock. `cols` is cell width for rows fallback/ANSI wrap hints, not universal native pixel width.

Common props include semantic `role`, `tone`, `hidden`, `grow/shrink`, `basis`, `min/max`, `title/aria`, `href`, `actions` and transient `mark: pick/drop`. A role is not a CSS class. Bounds use extent strings such as `40ch`/`10lines` or a fraction of available extent such as `0.4`; these are not pixel or terminal-cell measurements. Numeric `basis` must not be assumed to be CSS pixels. Row/column alignment, wrapping and `none/xs/sm/md/lg` spacing are supported descriptions, not arbitrary CSS.

| Vocabulary group | Kinds and important contracts |
| --- | --- |
| Layout | `col`, `row`, `card`, `section`, `rule`, `spacer`; row supports wrap/justify, card supports head/status/collapse/selection/preview |
| Text | `text` (spans, wrap, truncate, lines, measure), `md`, `code`, `diff`, `ansi`, `math`, `rows` |
| Images/data | `image` (blob or `builtin: omp`, alt, intrinsic w/h, max extent), `kv`, `table`, `tree` |
| Indicators | `badge`, `kbd`, `icon`, `spinner`, `shimmer`, `elapsed`, `progress`, `rate` |
| Input/selection | `list`, `item`, `tabs`, `editor`, `input` |
| Chrome | `status`, `seg`, `overlay`, `toast` |
| Data-first sheets | `picker`, `prefs` |
| Additional semantic displays | `tool`, `checklist`, `agent`, `effort`, `meter`, `chart` |

Exact optional/required fields belong to installed `TspPropsByKind`, not this summary. Terngram does not implement prefs/charts/agent/tool/checklist features merely because the SDK has kinds for them.

Important integration details:

- `TspText` is a string or spans `{t, s?, fx?, href?}`. Styles are semantic/theme tokens; motion is `shimmer/pulse/none`, not arbitrary HTML/ANSI styling.
- `md` has text/stream/marks but **no `wrap` or `measure` prop**. Adding unsupported fields does not solve long Markdown lines. Native Markdown and SDK ANSI Markdown rendering are different paths.
- `editor` exposes text, UTF-16 cursor/anchor, decorations/ghost/placeholder/prompt/mode/lang/readonly/maxLines; `input` is single-line and has no maxLines.
- For ordinary `list`, use **`max: { lines: N }`**, matching `SelectList.describe`, rather than treating `max: N` as equivalent. This caps the viewport, not the underlying items. The object form has been observed to produce an internally scrollable list; that does not establish universal layout behavior for other nodes. `virtual` does not prove a particular host virtualization strategy.
- There is no general row/column width/height/overflow/scrollTop, CSS grid, DOM measurement/query API or action-event pointer coordinates. Flex intent such as `grow:1, shrink:1, basis:0, min:{w:0}` is meaningful, but host intrinsic minimums/shrink/wrapping still need observation.
- Image intrinsic `w/h` are pixels; image `max.w/max.h` are extents. Do not conflate them.

These limits do not make native geometry impossible: the app can describe bounds, flex and semantic layout and inspect the tree. What cannot be proven from that tree alone is exact painted width, clipping, radius, dock height or host pointer/zoom behavior. Test those in real Tern, especially narrow panes and long Markdown.

## Native inputs, events and focus

TUI keyboard focus belongs to a component through `setFocus`, not a result string. Pointer wire `focus` identifies a node; the backend finds owners/field and calls `focusFromPointer`, allowing a modal overlay to retain keyboard focus. It does not deliver `focus` as an ordinary `NativeUiEvent`.

The pinned SDK carries a Bun patch in `patches/` that invalidates its native focus cache on `visible=true` and requests a frame. Returning to a Tern tab therefore reasserts the current component's focus even when the tree and target ID are unchanged. It preserves editor text/caret and overlay ownership; a palette retains the keys rather than focusing the underlying editor. This is surface-focus recovery, not an app foreground/read signal. `bun install --frozen-lockfile` applies the patch, and release packaging includes it with the installed runtime.

| Component event | Application meaning |
| --- | --- |
| `toggle` | Persist requested collapsed state |
| `select` | Change selection/preview only |
| `activate` | Execute the selected result |
| `action` | Named operation, optional value and modifiers |
| `change` | Typed pointer value; `null` resets default |
| `edit` | UTF-16 text/caret replacement |

Event `key` is an owner-local keypath (`""` for root), not global wire ID. Backend translates ordinary list item IDs to described keys; data-first picker/prefs use their own data IDs. `open/copy/zoom` can be handled locally by the host and need not invoke an app handler. `href` is an open target, not an image downloader. Custom actions route to the app. Keycap labels are not registered keyboard bindings; action buttons and keys must call the same explicit application operation.

### UTF-16 editing

Native input/editor describes full text and caret; an edit replaces `[from,to)` with `text`, then places `cursor`. All offsets and `len` are **UTF-16 code units**, not bytes, Unicode code points or graphemes. Multiline editor text is joined with `\n`; an empty replacement at equal endpoints can be a pure caret move.

`resolveTextEdit(current, event, clean, widen?)` rejects differing `len`, clamps/reorders ranges, avoids splitting surrogate pairs, cleans replacement and maps the caret. Length is not a hash/version: it cannot identify every same-length race. Use SDK `Input`/`Editor` rather than a text imitation; preserve current cursor as a memo dependency, including native caret-only changes. Readonly props and application guards protect different layers.

Masked password fields still send secret input through local IPC and host memory. A mask is not secure storage or permission to publish traces.

### Picker integration

Terngram uses `Input`, `SelectList` and `SelectListSheet(..., { docked: false })`. The app owns query/filtering and keyboard policy. `items` is the catalog; `order` is filtered order/group headings; `hits` are separate UTF-16 match ranges. `pickerQuery(input)` ties text to caret; the app's palette describes the current input cursor explicitly.

`SelectListSheet.handle(event)` routes selection/activation/close, and `pickerEvent` handles root/hoisted keypaths. External options/decorations require invalidation. Disabled items must be guarded for both native select and activate, and confirm disabled without a usable item. `select` must never be treated as activation. Palette search and local catalog paging are described once in [ui.md](ui.md).

## Scroll is not Telegram pagination

`reveal: start/end/nearest` applies when a node is **added**. Changing reveal on an existing node is not another scroll command; replacing its key creates new identity and may lose host view state. Terngram uses a new keyed tail anchor for first latest and a selection anchor for selected cards.

For repeatable keyboard scroll keep the node key and change `scroll.n`:

```ts
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

function thread(children: NativeNode[], n: number): NativeNode {
  return { k: "col", key: "thread-42", c: children,
    scroll: { by: "page-up", n } };
}
```

`by` is line-up/down, page-up/down, start or end. It targets the scroller at or above the node; the wire comment defines a page as viewport less a line. Freshly added nodes do not scroll. Changed counters on an existing node repeat the latest direction for accumulated presses, capped at 32 operations per node/frame; start/end emit once. Scroll ops require hello feature `scroll`.

Ctrl+U/D requests viewport movement only with messages focused. Loading older messages is a separate backend history operation. Latest explicitly follows end and updates read state; incoming events do not forcibly reveal latest. `ansi.follow` belongs to ANSI blocks, not `col/md` transcripts.

**No app-visible actual scroll offset, visible-message enumeration or pane foreground callback is established.** Wire `visible` describes surface visibility, not message viewport or keyboard/pane focus; the patched backend uses `visible=true` only to reassert native focus, without notifying app activity/read policy. Resize carries cols/cell/visible, but backend only updates cols. `gone` represents missing tree IDs, not messages scrolled offscreen. Theme/motion update appearance; errors are logged warnings, not necessarily component exceptions. The existence of `NativeTerminalEvent` types does not mean all terminal events reach component handlers. Thus ACK, scroll request, mirror state and lack of a visibility callback are not proofs of reading or painted geometry.

## Image blobs and sensitive lifecycle

`image.p.blob` names registered bytes by SHA-256, **not a URL or path**. `registerNativeBlob(bytes, mime)` stores content-addressed bytes in a process-global Map and memoizes the bytes-object identity; do not mutate bytes after registration. `base64ImageNode(data, mime, props, key)` decodes/registers and adds intrinsic dimensions when it recognizes the image header.

```ts
import { base64ImageNode } from "@oh-my-pi/pi-tui/native/blobs";

const preview = base64ImageNode(data, mime, {
  alt: "Photo preview", title: "Open full photo",
  max: { w: "32ch", h: "10lines" },
  actions: { click: "photo:123" },
}, "preview-chat-42-message-123");
```

The backend sends blob `b` before the first referencing frame and deduplicates uploads **per surface**; another screen/surface can require upload again. `NativeImageCache` caches nodes by slot and payload, not a bounded eviction policy; changing only MIME for the same payload does not rebuild its node. Terngram uses its own media-aware caches for actions/bounds.

There is **no unregister/blob-drop API** here. Closing an overlay, dropping app caches, replacing QR nodes or even receiving ACK does not guarantee release from the SDK's global registry or host media cache. App cache LRU alone would not solve that lifetime.

Inline preview click explicitly overrides default image zoom with `photo:<id>` and opens the app's fully resolved album/gallery. Full gallery images retain normal host zoom behavior; it is not a Telegram gallery/download callback or evidence of GIF/WebM/TGS playback. App previews/loaders/full-gallery intent and expiry fences are in [ui.md](ui.md).

QR is sensitive login approval content. The app removes QR nodes on rotation/stage change and does not save QR/link in its JSON/logs, but TDLib persists unfinished auth state and SDK/host bytes have no demonstrated secure-release lifecycle. Tern receives messages, images, QR and secret input as a separate trusted process. Mirror/frame/blob traces and screenshots can contain private data; never treat them as anonymized diagnostics. See [security.md](security.md) for the complete trust boundary.

## Wire transport and backpressure

TSP travels through the PTY in APC messages:

```text
ESC _ tsp ; verb [; key=value]* ; body ESC \
```

JSON bodies are UTF-8; blobs are base64. Wire comments say unknown fields/verbs are ignored, which does not justify relying on unadvertised capabilities.

| Message | Contract |
| --- | --- |
| `q/r hello` | Offered versions/app, then chosen version/terminal, kinds and optional features, APC limit, credits, cols/cell, theme/motion |
| `q/r blobs` | Requested IDs / `have`; available wire path, not necessarily used by current uploader |
| `o` | Open/adopt surface with mode/title/role |
| `t` | Resolved theme token palettes, after open and before first frame, then on change |
| `b` | Blob ID/MIME and base64 bytes |
| `f` | Atomic `{sf, s, ops}` frame with monotonically increasing per-surface sequence |
| `e ack` | Acknowledge sequence for surface |
| `x` | Close surface, retain main scrollback or remove it |

Ops are `add/set/text/splice/move/del/settle/focus/reveal/scroll/suspend/resume`. Primary text/splice addresses only text/md/code/ansi/math/editor/input/shimmer. Let the reconciler be the sole owner of IDs, tree state, sequences and ACKs; do not emit parallel raw frames into its surface.

Encoder chunks oversized messages using chunk ID `c` and continuation `m=1`, preserving UTF-8 code-point boundaries. Defaults are APC limit 65536 and credits 2; hello can override them. Do not manually split JS strings by supposed byte offsets.

Backend counts in-flight frames, defers/coalesces dirty work when credits run out, and schedules it when ACK frees credits. The installed SDK also has stalled-ACK recovery: after its timeout it warns and resumes without the credit block. This is local scheduling policy, not guaranteed host delivery, replay or reliable retry.

An optimistic `assumedTspHello` from `TERM_PROGRAM=tern` is not actual capability confirmation. [main.ts](../terngram/ui/main.ts) requires interactive Tern stdin/stdout and a real hello v1 with `input` and `picker`, otherwise exits with code 2. This guard does **not** verify every used kind or the `scroll` feature. Its terminal adapter sets open title/role to `terngram`; surface ownership remains SDK-managed.

## Evidence and integration checklist

The SDK mirror and `TspDocument` apply frames to a reference tree; they do not render a window. The [offline smoke harness](../.smoke-client.ts) uses synthetic hello, controlled Telegram responses and artificial ACKs. It can check keys/props/regions, operations, blob-before-frame, focus routing, paging intent and app state transitions. It cannot establish real hello compatibility, live Telegram delivery, precise dock/card/image size, clipping, smooth scroll, trackpad visibility, actual pointer behavior or host zoom. Use [development.md](development.md) for checks, then observe geometry in real Tern with safe fixtures; do not publish private traces.

When changing native integration:

1. Compare installed wire types, SDK implementations and real hello separately.
2. Preserve stable keys/component boundaries and immutable descriptions with complete dependencies.
3. Keep UTF-16 editing, caret updates and select-versus-activate semantics intact.
4. Distinguish paging requests from scroll commands and read heuristics from visibility.
5. Preserve blob-before-frame and single-owner sequencing; consider retained bytes in privacy claims.
6. Validate narrow-pane layout in the host rather than declaring success from mirror props.

## Future GIF, sticker and custom-emoji constraints

**Research, not shipped functionality.** Terngram has no animation/sticker/custom-emoji playback UI. Wire has `image` but no video/animated-media kind, and image props define no playback clock/seek. Text spans have no inline image attachment. A host file association for GIF or successful static decoding does not prove TSP animation.

Telegram asset semantics differ: GIF-style animations can be MP4, static stickers WebP, animated stickers TGS (gzip/Lottie), video stickers WebM/VP9 with alpha. Custom emoji retain text entities and document identities and can use WebP/TGS/WebM assets. See Telegram's [stickers](https://core.telegram.org/api/stickers) and [custom emoji](https://core.telegram.org/api/custom-emoji) references. Premium/free sending restrictions are not grounds to hide received content.

Constraints for a future implementation:

- Transfer an immutable asset once and let a negotiated host contract decode/play it. A new blob every frame wastes transport/CPU and indefinitely retains bytes in the current SDK.
- Clearly label any static poster as static; one-time WebP→PNG conversion could address format support, not create animation.
- Motion needs negotiated format/blob/poster, play/pause/loop, intrinsic size, reduced-motion and host-owned clock. MP4/WebM requires video decoding; TGS requires a compatible Lottie renderer. These fields do not exist in current image props.
- Inline emoji needs an asset run with alt text, baseline, size and tint while preserving original text and UTF-16 entities. Telegram offsets cannot index already-escaped Markdown. Splitting sentences into text/image rows damages wrapping, selection and copy.
- Batch/deduplicate emoji document lookups and shared asset decoding; bound both encoded bytes and decoded frames. Decoded variants need size/scale/tint identity, not all RGBA frames retained forever.
- Autoplay/pause needs real viewport and active-surface signals, not recent-input heuristics. Explicit Play and reduced-motion posters avoid pretending those signals exist.
- SDK/host need reference lifetime/release and bounded decoded caches; app cache eviction does not release global blobs.
- Premium sticker effects are separate assets/layers with once-on-visible semantics, not simply looping the base sticker.

Static assets may be feasible app-side, but full animation and enforceable playback/resource lifetimes require additional host evidence/contracts. They are not promised capabilities of the current image node.
