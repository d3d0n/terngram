# Terngram

Terngram is an unofficial, native Telegram client for Tern. The UI is TypeScript/Bun using the oh-my-pi TSP toolkit; a Python worker hosts official TDLib through its C JSON API. Authentication is QR-only, with optional 2FA. There is no Telethon or ANSI fallback.

## Read for your task

| Task | Start here |
| --- | --- |
| Set up the project, find ownership, choose checks | [Development](docs/development.md) |
| Change TDLib, authorization, worker RPC, storage or send recovery | [Backend](docs/backend.md) |
| Change commands, focus, conversation state, delivery UI or galleries | [UI](docs/ui.md) |
| Work with native nodes, input events, blobs, scrolling or host capabilities | [Tern API](docs/tern-api.md) |
| Handle credentials, private content, protected media or API Terms | [Security](docs/security.md) |
| Compare a behavior with Telegram Desktop/Web | [Desktop parity](docs/desktop-parity.md) |

## Keep these boundaries

- Read the relevant guide and implementation before editing. Update both sides of any worker/UI contract; code is the source of truth.
- Preserve draft and delivery identity. Queued is not sent; an ambiguous result is not permission to send another copy.
- Use isolated fixtures by default. Live account access requires explicit permission and must stay within the authorized chat and operation scope. Never publish account data, QR codes or protocol traces.
- A native tree or ACK is not proof of painted geometry, visibility or full Terms compliance. Report the checks actually run and their limits.
