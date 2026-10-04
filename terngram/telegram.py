"""Personal-account Telegram through official TDLib; account data stays private."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import locale
import os
import platform
import re
import stat
import tempfile
import traceback
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import monotonic

import qrcode
from PIL import Image

from .formatting import compose_markdown, parse_markdown
from .tdlib import TDLib, TDLibError


class ClientError(Exception):
    """Safe local error; never includes request contents or authorization material."""

    def __init__(self, message: str, *, code: str | None = None, cooldown: float | None = None, scope: str = "method"):
        super().__init__(message)
        self.code = code
        self.cooldown = cooldown
        self.scope = scope


@dataclass(frozen=True)
class Dialog:
    id: int
    title: str
    unread_count: int
    preview: str
    writable: bool
    last_message_id: int | None
    kind: str
    presence: dict | None = None


@dataclass(frozen=True)
class ChatMessage:
    id: int
    chat_id: int
    sender: str
    text: str
    time: str
    outgoing: bool
    reply_to: int | None
    edited: bool
    photo: bool
    forwarded: str | None
    read: bool
    grouped_id: str | None
    sender_id: int | None
    markdown: str
    entities: list[dict]
    media_id: str | None
    sending_state: str | None = None


def _root_cause(error: Exception) -> Exception:
    seen = set()
    while id(error) not in seen:
        seen.add(id(error))
        nested = error.__cause__ or error.__context__
        if nested is None or id(nested) in seen:
            break
        error = nested
    return error


def retry_after(error: Exception) -> float | None:
    if isinstance(error, ClientError):
        return error.cooldown
    cause = _root_cause(error)
    return cause.retry_after if isinstance(cause, TDLibError) else None


def retry_scope(error: Exception) -> str | None:
    if retry_after(error) is None:
        return None
    if isinstance(error, ClientError):
        return error.scope
    return "peer" if "SLOWMODE_WAIT" in getattr(_root_cause(error), "message", "") else "method"


def _safe_error(exc: Exception) -> ClientError:
    if isinstance(exc, ClientError):
        return exc
    if isinstance(exc, TDLibError):
        message = exc.message
        codes = {
            "PASSWORD_HASH_INVALID": "The two-step verification password is incorrect.",
            "API_ID_INVALID": "The Telegram API ID or API hash is invalid.",
            "API_ID_PUBLISHED_FLOOD": "Telegram rejected these application credentials. Use your own API ID and hash.",
            "MESSAGE_TOO_LONG": "Telegram rejected this message as too long. Nothing was truncated.",
            "MESSAGE_NOT_MODIFIED": "The message already has this content.",
            "CHAT_WRITE_FORBIDDEN": "Telegram does not permit sending in this chat.",
            "CHAT_FORWARDS_RESTRICTED": "Telegram does not permit forwarding protected content.",
            "MESSAGE_DELETE_FORBIDDEN": "Telegram does not permit deleting these messages for everyone.",
        }
        symbol = next((code for code in codes if code in message), None)
        if exc.retry_after is not None:
            return ClientError(f"Telegram asks you to wait {exc.retry_after:g} seconds. Try again afterward.", code="TDLIB_RATE_LIMIT", cooldown=exc.retry_after, scope="peer" if "SLOWMODE_WAIT" in message else "method")
        if symbol:
            return ClientError(codes[symbol], code=symbol)
        if exc.code == 401:
            return ClientError("Telegram authorization is unavailable or expired. Sign in again.", code="TDLIB_UNAUTHORIZED")
        if exc.code == 403:
            return ClientError("Telegram does not permit this action in this chat.", code="TDLIB_FORBIDDEN")
        if exc.code == 404:
            return ClientError("This Telegram item is no longer available.", code="TDLIB_NOT_FOUND")
        return ClientError("Telegram could not complete this action. If sending, check the chat before retrying.", code=f"TDLIB_{exc.code}")
    return ClientError("The connection or private local storage is unavailable. If sending, check the chat before retrying.", code="LOCAL_FAILURE")


@asynccontextmanager
async def _protected():
    try:
        yield
    except Exception as exc:
        raise _safe_error(exc) from None


def _presence(status: dict | None) -> dict:
    status = status or {}
    names = {"userStatusOnline": "online", "userStatusOffline": "offline", "userStatusRecently": "recently", "userStatusLastWeek": "last_week", "userStatusLastMonth": "last_month"}
    result = {"state": names.get(status.get("@type"), "unknown")}
    for field in ("expires", "was_online"):
        if type(status.get(field)) is int:
            result[field] = status[field]
    return result


def _name(user: dict | None) -> str:
    if not user:
        return "Unknown sender"
    return " ".join(filter(None, (user.get("first_name"), user.get("last_name")))) or "Deleted account"


def _visible_content(message: dict) -> dict | None:
    restriction = message.get("restriction_info") or {}
    if restriction.get("restriction_reason"):
        return None
    content = message.get("content", {})
    if content.get("@type", "").startswith("messageExpired"):
        return content
    return (message.get("ephemeral_content") or {}).get("content", content)


def _content_text(content: dict | None) -> tuple[str, list]:
    if content is None:
        return "[Content restricted by Telegram; open it in Telegram]", []
    formatted = content.get("text") or content.get("caption")
    if isinstance(formatted, dict):
        text = formatted.get("text", "")
        if text:
            return text, formatted.get("entities") or []
    kind = content.get("@type", "messageUnsupported").removeprefix("message")
    return "[" + re.sub(r"(?<!^)(?=[A-Z])", " ", kind) + "]", []


def _image_media(message: dict) -> tuple[dict | None, str | None]:
    content = _visible_content(message) or {}
    if content.get("@type") == "messagePhoto":
        return content.get("photo"), "image/jpeg"
    if content.get("@type") == "messageDocument":
        document = content.get("document", {})
        mime = document.get("mime_type")
        if mime in {"image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"}:
            return document, mime
    return None, None


def _image_dimensions(data: bytes, mime: str) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.size
    except (OSError, ValueError) as exc:
        raise ClientError("This image format or its dimensions cannot be displayed.") from exc


class TelegramService:
    def __init__(self, data_dir: Path, on_event: Callable[[dict], Awaitable[None]], on_connection: Callable[[bool], Awaitable[None]] | None = None):
        self.data_dir = Path(data_dir).expanduser().absolute()
        self.on_event = on_event
        self.on_connection = on_connection
        self._client: TDLib | None = None
        self._epoch = 0
        self._authorization = {"state": "closed"}
        self._auth_type = "authorizationStateClosed"
        self._auth_seq = 0
        self._auth_error: ClientError | None = None
        self._auth_changed = asyncio.Condition()
        self._auth_lock = asyncio.Lock()
        self._chats: dict[int, dict] = {}
        self._users: dict[int, dict] = {}
        self._groups: dict[tuple[str, int], dict] = {}
        self._full_groups: dict[tuple[str, int], dict] = {}
        self._messages: dict[tuple[int, int], dict] = {}
        self._message_versions: dict[tuple[int, int], int] = {}
        self._deleted_messages: set[tuple[int, int]] = set()
        self._chat_versions: dict[int, int] = {}
        self._outbox: dict[str, dict] | None = None
        self._send_sequence: int | None = None
        self._send_waiters: dict[tuple[int, int], asyncio.Future] = {}
        self._send_results: dict[tuple[int, int], dict | ClientError] = {}
        self._send_locks: dict[str, asyncio.Lock] = {}
        self._dialogs_lock = asyncio.Lock()
        self._lists_exhausted: set[str] = set()
        self._cache_changed = asyncio.Condition()
        self._me: dict | None = None
        self._selected_peer: int | None = None
        self._typing_peer: int | None = None
        self._typing_sent: dict[int, float] = {}
        self._activity_waits: dict[str, float] = {}
        self._last_activity: float | None = None
        self._own_online: bool | None = None
        self._activity_task: asyncio.Task | None = None
        self._last_connection = False

    def _private_dir(self, path: Path | None = None) -> None:
        path = path or self.data_dir
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ClientError("The private data directory must be owned by you and cannot be a symbolic link.")
        path.chmod(0o700)

    def _load_private(self, name: str):
        self._private_dir()
        path = self.data_dir / name
        self._private_dir(path.parent)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ClientError("Local account data must be a private file owned by you.")
            os.fchmod(stream.fileno(), 0o600)
            return json.load(stream)

    def _store_private(self, filename: str, data) -> None:
        self._private_dir()
        destination = self.data_dir / filename
        self._private_dir(destination.parent)
        fd, name = tempfile.mkstemp(prefix="private-", dir=destination.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, destination)
            directory = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(name).unlink(missing_ok=True)

    def record_error(self, operation: str, error: Exception) -> str:
        cause = _root_cause(error)
        frames = [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno} for frame in traceback.extract_tb(cause.__traceback__)[-12:]]
        kind = type(cause).__name__
        try:
            self._store_private("tdlib/last-error.json", {"operation": operation, "kind": kind, "frames": frames})
        except (ClientError, OSError):
            pass
        return getattr(error, "code", None) or (f"{kind} @ {frames[-1]['file']}:{frames[-1]['line']}" if frames else kind)

    @staticmethod
    def _validate_credentials(api_id, api_hash) -> None:
        if type(api_id) is not int or not 0 < api_id < 2**31 or not isinstance(api_hash, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", api_hash):
            raise ClientError("Enter a valid Telegram API ID and 32-character API hash from my.telegram.org.")

    def _load_credentials(self) -> tuple[int, str] | None:
        data = self._load_private("credentials.json")
        if data is None:
            return None
        self._validate_credentials(data.get("api_id"), data.get("api_hash"))
        return data["api_id"], data["api_hash"]

    def has_credentials(self) -> bool:
        try:
            return self._load_credentials() is not None
        except (ValueError, KeyError, TypeError):
            return False
        except Exception as exc:
            raise _safe_error(exc) from None

    @staticmethod
    def _validate_chat_id(chat_id) -> None:
        if type(chat_id) is not int or chat_id == 0 or abs(chat_id) > 2**53 - 1:
            raise ClientError("Select a valid Telegram chat.")

    @staticmethod
    def _validate_message_id(message_id) -> None:
        if type(message_id) is not int or not 0 < message_id <= 2**53 - 1:
            raise ClientError("Select a valid Telegram message.")

    @staticmethod
    def _token(token: str) -> int:
        if not isinstance(token, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", token) or int(token) >= 2**31:
            raise ClientError("The pending message token is invalid.")
        return int(token)

    @staticmethod
    def _compose(text: str):
        if not isinstance(text, str):
            raise ClientError("Enter a text message.")
        plain, entities = parse_markdown(text)
        if not plain.strip():
            raise ClientError("Enter a message before sending or editing.")
        if len(plain.encode("utf-16-le")) // 2 > 4096:
            raise ClientError("Messages cannot exceed 4096 UTF-16 characters. Nothing was sent or truncated.")
        return plain, entities

    @classmethod
    def _input_text(cls, text: str) -> dict:
        plain, entities = cls._compose(text)
        return {"@type": "inputMessageText", "text": {"@type": "formattedText", "text": plain, "entities": entities}, "link_preview_options": {"@type": "linkPreviewOptions", "is_disabled": True}, "clear_draft": False}

    def _state(self, state) -> dict:
        if not isinstance(state, dict) or not isinstance(state.get("drafts"), dict):
            raise ClientError("The saved chat selection and drafts are invalid.")
        drafts = {}
        for key, value in state["drafts"].items():
            if not isinstance(key, str) or not re.fullmatch(r"-?[1-9]\d*", key) or not isinstance(value, str):
                raise ClientError("The saved chat selection and drafts are invalid.")
            self._validate_chat_id(int(key))
            drafts[key] = value
        selected = state.get("selected_id")
        if selected is not None:
            self._validate_chat_id(selected)
        pending = state.get("pending_sends", {})
        if not isinstance(pending, dict):
            raise ClientError("The saved pending messages are invalid.")
        validated = {}
        for key, item in pending.items():
            if not isinstance(item, dict):
                raise ClientError("The saved pending messages are invalid.")
            self._validate_chat_id(int(key))
            self._token(item.get("token"))
            if item.get("text") == "":
                self._validate_message_id(item.get("message_id"))
            else:
                self._compose(item.get("text"))
            if item.get("chat_id") != int(key) or item.get("status") not in ("queued", "failed", "uncertain"):
                raise ClientError("The saved pending messages are invalid.")
            if item.get("reply_to") is not None:
                self._validate_message_id(item["reply_to"])
            if item.get("message_id") is not None:
                self._validate_message_id(item["message_id"])
            validated[key] = {field: item[field] for field in ("token", "chat_id", "text", "reply_to", "status", "message_id") if field in item}
        return {"drafts": drafts, "selected_id": selected, "pending_sends": validated}

    @staticmethod
    def _empty_state() -> dict:
        return {"drafts": {}, "selected_id": None, "pending_sends": {}}

    @staticmethod
    def _restore_draft(state: dict, chat_id: int, text: str) -> None:
        if not text:
            return
        key = str(chat_id)
        existing = state["drafts"].get(key, "")
        state["drafts"][key] = text if not existing else existing if existing == text else existing + "\n\n" + text

    def _terminal_state(self, state: dict, item: dict) -> None:
        key = str(item["chat_id"])
        pending = state["pending_sends"].get(key)
        if pending and pending["token"] == item["token"]:
            state["pending_sends"].pop(key)
            if item["status"] == "sent":
                if pending["text"] and state["drafts"].get(key) == pending["text"]:
                    state["drafts"].pop(key, None)
            else:
                self._restore_draft(state, item["chat_id"], pending["text"])

    def _abandon_item(self, item: dict) -> None:
        saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
        pending = saved["pending_sends"].get(str(item["chat_id"]))
        if not pending or pending["token"] != item["token"]:
            self._restore_draft(saved, item["chat_id"], item["text"])
        item["status"] = "abandoned"
        self._terminal_state(saved, item)
        self._store_private("tdlib/state.json", saved)
        self._persist_outbox()

    def _load_outbox(self) -> dict[str, dict]:
        if self._outbox is None:
            data = self._load_private("tdlib/outbox.json")
            if data is not None and not isinstance(data, dict):
                raise ClientError("The private TDLib outbox is invalid.")
            outbox = data or {}
            for token, item in outbox.items():
                self._token(token)
                if not isinstance(item, dict) or item.get("token") != token or item.get("status") not in ("prepared", "queued", "failed", "uncertain", "sent", "abandoned"):
                    raise ClientError("The private TDLib outbox is invalid.")
                self._validate_chat_id(item.get("chat_id"))
                if item["status"] not in ("sent", "abandoned"):
                    if item.get("text") == "" and item["status"] != "prepared":
                        self._validate_message_id(item.get("message_id") or item.get("retry_from_message_id"))
                    else:
                        self._compose(item.get("text"))
                    if item.get("reply_to") is not None:
                        self._validate_message_id(item["reply_to"])
                if item.get("message_id") is not None:
                    self._validate_message_id(item["message_id"])
                if "admitted" in item and type(item["admitted"]) is not bool:
                    raise ClientError("The private TDLib outbox is invalid.")
                item.setdefault("admitted", item["status"] != "prepared")
                if item["status"] == "prepared" and item["admitted"]:
                    raise ClientError("The private TDLib outbox is invalid.")
                if "retry_from_message_id" in item:
                    self._validate_message_id(item["retry_from_message_id"])
                    if item["status"] != "uncertain" or item.get("message_id") is not None or not item["admitted"]:
                        raise ClientError("The private TDLib outbox is invalid.")
                if item["status"] in ("sent", "abandoned"):
                    compact = {field: item[field] for field in ("token", "chat_id", "status", "message_id", "admitted") if field in item}
                    item.clear()
                    item.update(compact)
            sequence = self._load_private("tdlib/send-sequence.json")
            if sequence is None:
                # The old ledger never pruned: only here does absence prove non-submission.
                saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
                for pending in saved["pending_sends"].values():
                    if pending["token"] not in outbox:
                        unsubmitted = pending["status"] == "queued" and pending.get("message_id") is None
                        outbox[pending["token"]] = {"token": pending["token"], "chat_id": pending["chat_id"], "status": "abandoned", "admitted": False} if unsubmitted else {**pending, "status": "uncertain", "admitted": True}
                sequence = max((int(token) for token in outbox), default=0)
                self._store_private("tdlib/outbox.json", outbox)
                self._store_private("tdlib/send-sequence.json", sequence)
            if type(sequence) is not int or not 0 <= sequence < 2**31 or any(int(token) > sequence for token in outbox):
                raise ClientError("The private TDLib send sequence is invalid.")
            self._send_sequence = sequence
            self._outbox = outbox
            self._persist_outbox()
        return self._outbox

    def _persist_outbox(self) -> None:
        outbox = self._load_outbox()
        saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
        for item in outbox.values():
            if item["status"] in ("sent", "abandoned"):
                compact = {field: item[field] for field in ("token", "chat_id", "status", "message_id", "admitted") if field in item}
                item.clear()
                item.update(compact)
        referenced = {item["token"] for item in saved["pending_sends"].values()}
        terminal = sorted((token for token, item in outbox.items() if item["status"] in ("sent", "abandoned") and token not in referenced), key=int)
        for token in terminal[:-256]:
            outbox.pop(token)
        self._store_private("tdlib/outbox.json", outbox)

    async def load_state(self) -> dict:
        async with _protected():
            data = self._load_private("tdlib/state.json")
            if data is None:
                # Do not translate legacy message/reply IDs. Only plain user drafts migrate.
                legacy = self._load_private("state.json")
                drafts = legacy.get("drafts", {}) if isinstance(legacy, dict) else {}
                data = {"drafts": drafts, "selected_id": None, "pending_sends": {}}
                if isinstance(legacy, dict):
                    for key, pending in legacy.get("pending_sends", {}).items():
                        if isinstance(pending, dict) and isinstance(pending.get("text"), str) and not drafts.get(key):
                            drafts[key] = pending["text"]
                self._store_private("tdlib/state.json", self._state(data))
            outbox = self._load_outbox()
            state = self._state(self._load_private("tdlib/state.json") or self._empty_state())
            for pending in state["pending_sends"].values():
                if pending["token"] not in outbox:
                    # A retired token may already have been sent. Never infer non-delivery.
                    sequence = max(self._send_sequence, int(pending["token"]))
                    self._send_sequence = sequence
                    self._store_private("tdlib/send-sequence.json", sequence)
                    outbox[pending["token"]] = {**pending, "status": "uncertain", "admitted": True}
            for item in list(outbox.values()):
                key = str(item["chat_id"])
                lock = self._send_locks.get(item["token"])
                if item["status"] == "prepared" and not (lock and lock.locked()):
                    pending = state["pending_sends"].get(key)
                    if not pending or pending["token"] != item["token"]:
                        self._restore_draft(state, item["chat_id"], item["text"])
                    item["status"] = "abandoned"
                if item["status"] in ("sent", "abandoned"):
                    self._terminal_state(state, item)
                else:
                    state["pending_sends"][key] = {**item, "status": "queued" if item["status"] == "prepared" else item["status"]}
                    if not item["text"] and item.get("retry_from_message_id") is not None:
                        state["pending_sends"][key]["message_id"] = item["retry_from_message_id"]
            terminal_events = [item for item in outbox.values() if item["status"] in ("sent", "abandoned")]
            self._store_private("tdlib/state.json", self._state(state))
            self._persist_outbox()
            for item in terminal_events:
                await self._send_state(item)
            return self._state(state)

    async def save_state(self, state: dict) -> None:
        async with _protected():
            saved = self._state(state)
            if self._outbox is not None:
                for item in self._outbox.values():
                    if item["status"] in ("sent", "abandoned"):
                        self._terminal_state(saved, item)
            self._store_private("tdlib/state.json", saved)
            initializing = self._outbox is None
            outbox = self._load_outbox()
            if initializing:
                for item in outbox.values():
                    if item["status"] in ("sent", "abandoned"):
                        self._terminal_state(saved, item)
                self._store_private("tdlib/state.json", saved)
            self._persist_outbox()

    def _connected(self) -> TDLib:
        if self._client is None:
            raise ClientError("Not connected to Telegram. Connect again.")
        return self._client

    def _ready(self) -> TDLib:
        client = self._connected()
        if self._authorization["state"] != "ready":
            raise ClientError("Sign in to your Telegram account first.")
        return client

    async def _request(self, method: str, **fields) -> dict:
        return await self._ready().request({"@type": method, **fields})

    async def _publish_auth(self, authorization: dict) -> None:
        self._authorization = authorization
        self._auth_seq += 1
        async with self._auth_changed:
            self._auth_changed.notify_all()
        await self.on_event({"kind": "authorization", "authorization": dict(authorization)})

    async def _wait_auth(self, previous: int | None = None) -> dict:
        async with self._auth_changed:
            await asyncio.wait_for(self._auth_changed.wait_for(lambda: self._auth_error is not None or (self._authorization["state"] in ("qr", "password", "ready", "closed") and (previous is None or self._auth_seq > previous))), timeout=30)
        if self._auth_error:
            raise self._auth_error
        return dict(self._authorization)

    async def auth_state(self) -> dict:
        return dict(self._authorization)

    async def connect(self, api_id: int | None = None, api_hash: str | None = None) -> dict:
        async with _protected():
            async with self._auth_lock:
                if api_id is not None or api_hash is not None:
                    self._validate_credentials(api_id, api_hash)
                    await self.close()
                    self._store_private("credentials.json", {"api_id": api_id, "api_hash": api_hash})
                credentials = self._load_credentials()
                if credentials is None:
                    await self._publish_auth({"state": "credentials"})
                    return dict(self._authorization)
                if self._client is None:
                    for path in (self.data_dir / "tdlib", self.data_dir / "tdlib/db", self.data_dir / "tdlib/files"):
                        self._private_dir(path)
                    self._epoch += 1
                    epoch = self._epoch
                    self._auth_error = None
                    self._auth_type = "starting"
                    self._authorization = {"state": "credentials"}
                    async def updated(update):
                        if self._epoch == epoch:
                            await self._update(update)
                    self._client = TDLib(updated)
                    await self._client.start()
                if self._authorization["state"] == "ready":
                    return dict(self._authorization)
                return await self._wait_auth()

    async def request_qr(self) -> dict:
        async with _protected():
            async with self._auth_lock:
                if self._authorization["state"] == "ready":
                    return dict(self._authorization)
                if self._client is None:
                    raise ClientError("Connect with your own API credentials first.")
                if self._auth_type == "authorizationStateReady":
                    return await self._wait_auth(self._auth_seq)
                # Native QR rotation is automatic; this state rejects QR requests.
                if self._auth_type == "authorizationStateWaitOtherDeviceConfirmation":
                    return dict(self._authorization)
                if self._authorization["state"] == "password":
                    # Explicitly abandon only the never-authorized QR key. Re-exporting
                    # its token would just request the same account's password again.
                    await self._client.request({"@type": "logOut"})
                    await self.close()
                else:
                    previous = self._auth_seq
                    self._auth_error = None
                    await self._client.request({"@type": "requestQrCodeAuthentication", "other_user_ids": []})
                    return await self._wait_auth(previous)
            return await self.connect()


    async def sign_in_password(self, password: str) -> dict:
        async with _protected():
            async with self._auth_lock:
                if self._authorization["state"] != "password" or not isinstance(password, str) or not password:
                    raise ClientError("Enter your two-step verification password at the password stage.")
                previous = self._auth_seq
                await self._connected().request({"@type": "checkAuthenticationPassword", "password": password})
                return await self._wait_auth(previous)

    async def _authorization_update(self, state: dict) -> None:
        kind = state["@type"]
        self._auth_type = kind
        self._auth_error = None
        if kind == "authorizationStateWaitTdlibParameters":
            credentials = self._load_credentials()
            if credentials is None:
                await self._publish_auth({"state": "credentials"})
                return
            await self._connected().request({"@type": "setTdlibParameters", "use_test_dc": False, "database_directory": str(self.data_dir / "tdlib/db"), "files_directory": str(self.data_dir / "tdlib/files"), "database_encryption_key": "", "use_file_database": True, "use_chat_info_database": True, "use_message_database": True, "use_secret_chats": False, "api_id": credentials[0], "api_hash": credentials[1], "system_language_code": (locale.getlocale()[0] or "en").split("_")[0], "device_model": f"Desktop ({platform.machine()})", "system_version": f"{platform.system()} {platform.release()}", "application_version": "Terngram TDLib"})
        elif kind == "authorizationStateWaitPhoneNumber":
            await self._connected().request({"@type": "requestQrCodeAuthentication", "other_user_ids": []})
        elif kind == "authorizationStateWaitOtherDeviceConfirmation":
            image = qrcode.make(state["link"])
            stream = io.BytesIO()
            image.save(stream, format="PNG")
            await self._publish_auth({"state": "qr", "qr": {"data": base64.b64encode(stream.getvalue()).decode("ascii"), "mime": "image/png", "width": image.size[0], "height": image.size[1]}})
        elif kind == "authorizationStateWaitPassword":
            await self._publish_auth({"state": "password", "hint": state.get("password_hint", "")})
        elif kind == "authorizationStateReady":
            self._me = await self._connected().request({"@type": "getMe"})
            self._users[self._me["id"]] = self._me
            await self._connected().request({"@type": "setOption", "name": "online", "value": {"@type": "optionValueBoolean", "value": False}})
            self._own_online = False
            await self._publish_auth({"state": "ready"})
            if self._activity_task is None:
                self._activity_task = asyncio.create_task(self._watch_activity())
        elif kind in ("authorizationStateClosing", "authorizationStateClosed", "authorizationStateLoggingOut"):
            await self._publish_auth({"state": "closed"})
        else:
            self._auth_error = ClientError("Telegram requested an authorization step unavailable in this QR-only client. Restart QR login in Telegram; phone, email and registration login are not supported.", code="AUTH_STEP_UNSUPPORTED")
            await self._publish_auth({"state": "closed"})

    async def me(self) -> str:
        async with _protected():
            self._ready()
            return _name(self._me)

    async def _chat(self, chat_id: int) -> dict:
        self._validate_chat_id(chat_id)
        if chat_id not in self._chats:
            version = self._chat_versions.get(chat_id, 0)
            chat = await self._request("getChat", chat_id=chat_id)
            if version == self._chat_versions.get(chat_id, 0):
                self._chats[chat_id] = chat
        return self._chats[chat_id]

    def _group_key(self, chat: dict) -> tuple[str, int] | None:
        kind = chat["type"]
        if kind["@type"] == "chatTypeBasicGroup":
            return "basic", kind["basic_group_id"]
        if kind["@type"] == "chatTypeSupergroup":
            return "super", kind["supergroup_id"]
        return None

    def _writable(self, chat: dict) -> bool:
        kind = chat["type"]
        if kind["@type"] == "chatTypePrivate":
            return True
        key = self._group_key(chat)
        group = self._groups.get(key, {})
        status = group.get("status", {})
        role = status.get("@type")
        if role in ("chatMemberStatusLeft", "chatMemberStatusBanned"):
            return False
        if role == "chatMemberStatusCreator":
            return status.get("is_member", True)
        if role == "chatMemberStatusAdministrator":
            if kind.get("is_channel"):
                return status.get("rights", {}).get("can_post_messages", False)
            return True
        if kind.get("is_channel"):
            return False
        if key and key[0] == "basic" and not group.get("is_active", True):
            return False
        if role == "chatMemberStatusRestricted":
            return status.get("is_member", False) and status.get("permissions", {}).get("can_send_basic_messages", False) and chat.get("permissions", {}).get("can_send_basic_messages", False)
        return chat.get("permissions", {}).get("can_send_basic_messages", False)

    def _dialog(self, chat: dict) -> Dialog:
        kind = chat["type"]
        user_id = kind.get("user_id")
        user = self._users.get(user_id, {})
        saved = self._me is not None and user_id == self._me["id"]
        name = "saved" if saved else "bot" if user.get("type", {}).get("@type") == "userTypeBot" else "channel" if kind.get("is_channel") else "group" if self._group_key(chat) else "user"
        last = chat.get("last_message")
        return Dialog(chat["id"], "Saved Messages" if saved else chat["title"], chat.get("unread_count", 0), _content_text(_visible_content(last))[0] if last else "", self._writable(chat), last["id"] if last else None, name, _presence(user.get("status")) if user_id else None)

    def _ordered_chats(self) -> list[int]:
        orders = {}
        for chat_id, chat in self._chats.items():
            for position in chat.get("positions", []):
                if position["list"]["@type"] == "chatListMain" and int(position["order"]) > 0:
                    orders[chat_id] = int(position["order"])
        return sorted(orders, key=lambda chat_id: (orders[chat_id], chat_id), reverse=True)

    async def dialogs(self, cursor: dict | None = None, limit: int = 60) -> dict:
        async with _protected():
            self._ready()
            if type(limit) is not int or not 1 <= limit <= 100:
                raise ClientError("Chat pages must contain between 1 and 100 chats.")
            if cursor is not None and (not isinstance(cursor, dict) or set(cursor) != {"offset"} or type(cursor["offset"]) is not int or cursor["offset"] < 0):
                raise ClientError("This chat page is invalid.")
            offset = cursor["offset"] if cursor else 0
            async with self._dialogs_lock:
                while len(self._ordered_chats()) <= offset + limit and "main" not in self._lists_exhausted:
                    try:
                        await self._request("loadChats", chat_list={"@type": "chatListMain"}, limit=limit)
                    except TDLibError as exc:
                        if exc.code != 404:
                            raise
                        self._lists_exhausted.add("main")
                    # Replies may precede callback delivery. Wait for position updates
                    # corresponding to the native list snapshot before slicing our cache.
                    snapshot = await self._request("getChats", chat_list={"@type": "chatListMain"}, limit=offset + limit + 1)
                    wanted = set(snapshot["chat_ids"])
                    async with self._cache_changed:
                        await asyncio.wait_for(self._cache_changed.wait_for(lambda: wanted <= set(self._ordered_chats())), timeout=10)
                ids = self._ordered_chats()
                page = [self._dialog(self._chats[chat_id]) for chat_id in ids[offset:offset + limit]]
                return {"dialogs": page, "cursor": {"offset": offset + len(page)} if offset + len(page) < len(ids) or "main" not in self._lists_exhausted else None}

    async def dialog(self, chat_id: int) -> Dialog | None:
        async with _protected():
            try:
                return self._dialog(await self._chat(chat_id))
            except TDLibError as exc:
                if exc.code == 404:
                    return None
                raise

    async def chat_info(self, chat_id: int, refresh: bool = False) -> dict:
        async with _protected():
            if type(refresh) is not bool:
                raise ClientError("Choose whether to refresh chat information.")
            chat = await self._chat(chat_id)
            key = self._group_key(chat)
            if key is None:
                return {"participants_count": None}
            if refresh or key not in self._full_groups:
                version = self._chat_versions.get(chat_id, 0)
                method, field = ("getBasicGroupFullInfo", "basic_group_id") if key[0] == "basic" else ("getSupergroupFullInfo", "supergroup_id")
                result = await self._request(method, **{field: key[1]})
                if version == self._chat_versions.get(chat_id, 0):
                    self._full_groups[key] = result
            full = self._full_groups.get(key, {})
            count = len(full["members"]) if key[0] == "basic" and "members" in full else full.get("member_count", self._groups.get(key, {}).get("member_count"))
            return {"participants_count": count if type(count) is int and count >= 0 else None}

    async def _properties(self, chat_id: int, message_id: int) -> dict:
        return await self._request("getMessageProperties", chat_id=chat_id, message_id=message_id)

    async def message_readers(self, chat_id: int, message_id: int) -> int | None:
        async with _protected():
            await self._existing(chat_id, [message_id])
            if not (await self._properties(chat_id, message_id)).get("can_get_viewers", False):
                return None
            try:
                result = await self._request("getMessageViewers", chat_id=chat_id, message_id=message_id)
            except TDLibError as exc:
                if exc.code in (400, 403, 404):
                    return None
                raise
            return len(result["viewers"])

    async def _sender_name(self, sender: dict | None) -> tuple[str, int | None]:
        sender = sender or {}
        if sender.get("@type") == "messageSenderUser":
            user_id = sender["user_id"]
            if user_id not in self._users:
                try:
                    self._users[user_id] = await self._request("getUser", user_id=user_id)
                except TDLibError:
                    return "Unknown sender", user_id
            return _name(self._users[user_id]), user_id
        if sender.get("@type") == "messageSenderChat":
            chat_id = sender["chat_id"]
            try:
                return (await self._chat(chat_id))["title"], chat_id
            except TDLibError:
                return "Unknown sender", chat_id
        return "Unknown sender", None

    async def _message(self, message: dict) -> ChatMessage:
        key = message["chat_id"], message["id"]
        version = self._message_versions.get(key, 0)
        chat_id = message["chat_id"]
        chat = await self._chat(chat_id)
        text, entities = _content_text(_visible_content(message))
        sender, sender_id = await self._sender_name(message.get("sender_id"))
        forwarded = None
        origin = (message.get("forward_info") or {}).get("origin", {})
        if origin:
            if origin.get("sender_name"):
                forwarded = origin["sender_name"]
            elif origin.get("sender_user_id"):
                forwarded, _ = await self._sender_name({"@type": "messageSenderUser", "user_id": origin["sender_user_id"]})
            elif origin.get("sender_chat_id") or origin.get("chat_id"):
                forwarded, _ = await self._sender_name({"@type": "messageSenderChat", "chat_id": origin.get("sender_chat_id") or origin["chat_id"]})
            else:
                forwarded = "Unknown sender"
        outgoing = message.get("is_outgoing", False)
        reply = message.get("reply_to") or {}
        reply_id = reply.get("message_id") if reply.get("@type") == "messageReplyToMessage" and reply.get("chat_id", chat_id) in (0, chat_id) else None
        media, _ = _image_media(message)
        media_id = None
        if media:
            if "sizes" in media:
                sizes = media["sizes"]
                media_id = str(sizes[-1]["photo"]["id"]) if sizes else None
            else:
                media_id = str(media["document"]["id"])
        maximum = chat.get("last_read_outbox_message_id" if outgoing else "last_read_inbox_message_id", 0)
        if version != self._message_versions.get(key, 0):
            current = self._messages.get(key)
            if current is None:
                raise ClientError("This message was deleted while displaying it.")
            return await self._message(current)
        sending = message.get("sending_state") or {}
        sending_state = "failed" if sending.get("@type") == "messageSendingStateFailed" else "queued" if sending else None
        return ChatMessage(message["id"], chat_id, "You" if outgoing else sender, text, datetime.fromtimestamp(message.get("date", 0)).astimezone().strftime("%Y-%m-%d %H:%M"), outgoing, reply_id, bool(message.get("edit_date")), media is not None, forwarded, not sending and message["id"] <= maximum, str(message["media_album_id"]) if int(message.get("media_album_id", 0)) else None, sender_id, compose_markdown(text, entities), entities, media_id, sending_state)

    def _remember(self, message: dict, version: int | None = None) -> dict | None:
        key = message["chat_id"], message["id"]
        if key not in self._deleted_messages and (version is None or version == self._message_versions.get(key, 0)):
            self._messages[key] = message
        return self._messages.get(key)

    async def history(self, chat_id: int, before_id: int = 0, limit: int = 50) -> list[ChatMessage]:
        async with _protected():
            await self._chat(chat_id)
            if type(limit) is not int or not 1 <= limit <= 100 or type(before_id) is not int or not 0 <= before_id <= 2**53 - 1:
                raise ClientError("History pages must contain 1 to 100 messages with a valid offset.")
            found = {}
            anchor = before_id
            while len(found) < limit:
                versions = dict(self._message_versions)
                result = await self._request("getChatHistory", chat_id=chat_id, from_message_id=anchor, offset=0, limit=min(100, limit - len(found) + (1 if anchor else 0)), only_local=False)
                batch = [message for message in result["messages"] if message and (not before_id or message["id"] < before_id) and (not anchor or message["id"] < anchor)]
                if not batch:
                    break
                for message in batch:
                    key = chat_id, message["id"]
                    current = self._remember(message, versions.get(key, 0))
                    if current:
                        found[current["id"]] = current
                next_anchor = min(message["id"] for message in batch)
                if anchor and next_anchor >= anchor:
                    raise ClientError("Telegram history did not advance. Refresh the chat.")
                anchor = next_anchor
            return [await self._message(found[key]) for key in sorted(found, reverse=True)[:limit][::-1]]

    async def _existing(self, chat_id: int, message_ids: list[int]) -> list[dict]:
        await self._chat(chat_id)
        if not isinstance(message_ids, list) or not message_ids or len(set(message_ids)) != len(message_ids):
            raise ClientError("Select each message only once.")
        for message_id in message_ids:
            self._validate_message_id(message_id)
        versions = {message_id: self._message_versions.get((chat_id, message_id), 0) for message_id in message_ids}
        result = await self._request("getMessages", chat_id=chat_id, message_ids=message_ids)
        messages = []
        for expected, message in zip(message_ids, result["messages"], strict=True):
            if message is None or message["chat_id"] != chat_id or message["id"] != expected:
                raise ClientError("A selected message is no longer available in this chat.")
            current = self._remember(message, versions[expected])
            if current is None:
                raise ClientError("A selected message was deleted while loading.")
            messages.append(current)
        return messages

    async def _media_changed(self, chat_id: int, message_id: int) -> None:
        key = chat_id, message_id
        while True:
            version = self._message_versions.get(key, 0)
            current = self._messages.get(key)
            if current is None and key not in self._deleted_messages:
                result = await self._request("getMessages", chat_id=chat_id, message_ids=[message_id])
                if version != self._message_versions.get(key, 0):
                    continue
                current, = result["messages"]
                if current is not None:
                    if current["chat_id"] != chat_id or current["id"] != message_id:
                        raise ClientError("A selected message is no longer available in this chat.")
                    self._remember(current, version)
                else:
                    self._deleted_messages.add(key)
                    self._message_versions[key] = version + 1
            if current is None:
                await self.on_event({"kind": "delete", "chat_id": chat_id, "ids": [message_id]})
                break
            try:
                model = await self._message(current)
            except ClientError:
                if version != self._message_versions.get(key, 0):
                    continue
                raise
            if version != self._message_versions.get(key, 0):
                continue
            await self.on_event({"kind": "message", "chat_id": chat_id, "message": model})
            break
        raise ClientError("This message's media changed.", code="MEDIA_CHANGED")

    async def _album(self, chat_id: int, message: dict) -> list[dict]:
        group = int(message.get("media_album_id", 0))
        if not group:
            return [message]
        members = {message["id"]: message}
        # Albums contain at most ten contiguous history messages; IDs are not consecutive.
        for newer in (False, True):
            anchor = message["id"]
            while True:
                result = await self._request("getChatHistory", chat_id=chat_id, from_message_id=anchor, offset=-11 if newer else 0, limit=12, only_local=False)
                neighbors = sorted((item for item in result["messages"] if item and (item["id"] > anchor if newer else item["id"] < anchor)), key=lambda item: item["id"], reverse=not newer)
                if not neighbors:
                    break
                boundary = False
                for item in neighbors:
                    if item["chat_id"] != chat_id:
                        raise ClientError("The complete album is unavailable in this chat. Nothing was changed.")
                    if int(item.get("media_album_id", 0)) != group:
                        boundary = True
                        break
                    members[item["id"]] = item
                    anchor = item["id"]
                    if len(members) > 10:
                        raise ClientError("The complete album could not be resolved. Nothing was changed.")
                if boundary:
                    break
        return [members[key] for key in sorted(members)]

    async def album(self, chat_id: int, message_id: int) -> list[ChatMessage]:
        async with _protected():
            messages = await self._existing(chat_id, [message_id])
            return [await self._message(member) for member in await self._album(chat_id, messages[0])]

    async def _expanded(self, chat_id: int, message_ids: list[int]) -> list[dict]:
        messages = await self._existing(chat_id, list(dict.fromkeys(message_ids)) if isinstance(message_ids, list) else message_ids)
        expanded = {}
        for message in messages:
            if message["id"] not in expanded:
                for member in await self._album(chat_id, message):
                    expanded[member["id"]] = member
        return [expanded[key] for key in sorted(expanded)]

    async def _send_state(self, item: dict, message: dict | None = None) -> None:
        event = {"kind": "send_state", **{field: item[field] for field in ("chat_id", "token", "status", "message_id", "error", "admitted") if field in item}}
        if message and item["status"] == "sent":
            event["message"] = await self._message(message)
        await self.on_event(event)

    async def _track_send(self, item: dict, message: dict) -> None:
        if item["status"] in ("sent", "abandoned"):
            return  # A delayed native update cannot resurrect a compact terminal record.
        item.pop("retry_from_message_id", None)
        # An update may already have confirmed this local ID before the request returns.
        key = message["chat_id"], message["id"]
        outcome = self._send_results.get(key)
        if isinstance(outcome, dict):
            item.update(status="sent", message_id=outcome["id"])
        elif isinstance(outcome, ClientError):
            item.update(status="uncertain" if outcome.code == "SEND_UNCERTAIN" else "failed", message_id=message["id"], error=str(outcome))
        else:
            state = message.get("sending_state")
            item.update(status="failed" if state and state["@type"] == "messageSendingStateFailed" else "queued" if state else "sent", message_id=message["id"])
            if state and state["@type"] == "messageSendingStateFailed":
                item["error"] = str(_safe_error(TDLibError(state["error"]["code"], state["error"]["message"])))
        self._persist_outbox()
        await self._send_state(item, outcome if isinstance(outcome, dict) else message)

    async def _await_sent(self, message: dict) -> dict:
        if not message.get("sending_state"):
            return message
        state = message["sending_state"]
        if state["@type"] == "messageSendingStateFailed":
            raise _safe_error(TDLibError(state["error"]["code"], state["error"]["message"]))
        key = message["chat_id"], message["id"]
        outcome = self._send_results.get(key)
        if isinstance(outcome, Exception):
            raise outcome
        if outcome:
            return outcome
        future = self._send_waiters.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            self._send_waiters[key] = future
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=30)
        except TimeoutError:
            raise ClientError("TDLib is still reconciling this send. Check the chat; do not submit it again. Reconcile this pending message after reconnecting.", code="SEND_PENDING") from None

    async def prepare_send(self, chat_id: int, text: str, reply_to: int | None = None) -> dict:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._compose(text)
            if reply_to is not None:
                self._validate_message_id(reply_to)
            outbox = self._load_outbox()
            for previous in list(outbox.values()):
                if previous["chat_id"] == chat_id and previous["status"] == "prepared":
                    lock = self._send_locks.get(previous["token"])
                    if not (lock and lock.locked()):
                        self._abandon_item(previous)
            if self._send_sequence >= 2**31 - 1:
                raise ClientError("The private TDLib send token sequence is exhausted. Nothing was sent.", code="SEND_TOKEN_EXHAUSTED")
            sequence = self._send_sequence + 1
            # Reserve first: a failed subsequent write must not make this token reusable.
            self._send_sequence = sequence
            self._store_private("tdlib/send-sequence.json", sequence)
            item = {"token": str(sequence), "chat_id": chat_id, "text": text, "reply_to": reply_to, "status": "prepared", "admitted": False}
            outbox[item["token"]] = item
            self._persist_outbox()
            return {field: ("queued" if field == "status" else item[field]) for field in ("token", "chat_id", "text", "reply_to", "status")}

    async def send(self, chat_id: int, text: str, reply_to: int | None, token: str) -> ChatMessage:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._token(token)
            async with self._send_locks.setdefault(token, asyncio.Lock()):
                item = self._load_outbox().get(token)
                if item is None:
                    raise ClientError("This send token was not prepared or has been retired. Its text is still your draft; prepare a new send.", code="SEND_NOT_PREPARED")
                if item["status"] in ("sent", "abandoned") or item["chat_id"] != chat_id:
                    raise ClientError("This send token has already been used. It cannot identify a new message.", code="SEND_TOKEN_REUSED")
                if (item["text"], item.get("reply_to")) != (text, reply_to):
                    raise ClientError("This send token belongs to a different message.", code="SEND_TOKEN_REUSED")
                if item["status"] != "prepared":
                    await self._reconcile_send(chat_id, token)
                    raise ClientError("This message already has a pending or failed TDLib send. Reconcile it or explicitly retry its failed local message; a new send would risk a duplicate.", code="SEND_RECONCILIATION_REQUIRED")
                try:
                    content = self._input_text(text)
                    chat = await self._chat(chat_id)
                    if not self._writable(chat):
                        raise ClientError("Telegram does not permit sending in this chat.")
                    if reply_to is not None:
                        await self._existing(chat_id, [reply_to])
                        if not (await self._properties(chat_id, reply_to)).get("can_be_replied"):
                            raise ClientError("Telegram does not permit replying to this message.")
                    await self.typing(chat_id, False)
                except Exception as exc:
                    self._abandon_item(item)
                    await self._send_state({**item, "error": str(_safe_error(exc))})
                    raise
                # Native admission is durable before invoking TDLib. A crash from here is
                # ambiguous: sending_id is non-persistent, not an idempotency key.
                item.update(status="uncertain", admitted=True)
                self._persist_outbox()
                try:
                    message = await self._request("sendMessage", chat_id=chat_id, topic_id=None, reply_to={"@type": "inputMessageReplyToMessage", "message_id": reply_to} if reply_to else None, options={"@type": "messageSendOptions", "sending_id": int(token)}, reply_markup=None, input_message_content=content)
                except Exception:
                    item["error"] = "No durable TDLib message identity was returned. Check the chat before composing a new send; this token cannot safely be resubmitted."
                    self._persist_outbox()
                    await self._send_state(item)
                    raise ClientError(item["error"], code="SEND_UNCERTAIN") from None
                await self._track_send(item, message)
                result = await self._await_sent(message)
                return await self._message(result)

    async def reconcile_send(self, chat_id: int, token: str) -> dict:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._token(token)
            async with self._send_locks.setdefault(token, asyncio.Lock()):
                return await self._reconcile_send(chat_id, token)

    async def _reconcile_send(self, chat_id: int, token: str) -> dict:
        item = self._load_outbox().get(token)
        if item is None:
            saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
            pending = saved["pending_sends"].get(str(chat_id))
            if not pending or pending["token"] != token:
                raise ClientError("This token has no tracked prepared send.", code="SEND_NOT_PREPARED")
            # The compact ledger may have retired a completed token. Absence alone
            # is not proof that TDLib never saw it after the sequence migration.
            sequence = max(self._send_sequence, int(token))
            self._send_sequence = sequence
            self._store_private("tdlib/send-sequence.json", sequence)
            item = {**pending, "status": "uncertain", "admitted": True}
            self._load_outbox()[token] = item
        if item["chat_id"] != chat_id:
            raise ClientError("This send token belongs to a different chat.", code="SEND_TOKEN_REUSED")
        if item["status"] == "prepared":
            self._abandon_item(item)
        if item["status"] in ("sent", "abandoned"):
            saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
            self._terminal_state(saved, item)
            self._store_private("tdlib/state.json", saved)
            self._persist_outbox()
            await self._send_state(item)
            return dict(item)
        if item.get("message_id") is not None:
            try:
                message = await self._send_message(chat_id, item["message_id"])
            except TDLibError as exc:
                if exc.code not in (400, 404):
                    raise
                item.update(status="uncertain", error="TDLib no longer has this local message identity. Delivery cannot be proved. Check the chat; automatic resubmission is blocked.")
            else:
                await self._track_send(item, message)
        else:
            item.update(status="uncertain", error="The earlier send has no durable TDLib identity. Check the chat; automatic resubmission would risk a duplicate.")
        self._persist_outbox()
        await self._send_state(item)
        return {field: value for field, value in item.items() if field != "retry_from_message_id"}

    async def _send_message(self, chat_id: int, message_id: int) -> dict:
        key = chat_id, message_id
        epoch, version = self._epoch, self._message_versions.get(key, 0)
        message = await self._request("getMessage", chat_id=chat_id, message_id=message_id)
        if (epoch != self._epoch or version != self._message_versions.get(key, 0)
                or message.get("@type") != "message"
                or type(message.get("chat_id")) is not int or message["chat_id"] != chat_id
                or type(message.get("id")) is not int or message["id"] != message_id
                or message.get("is_outgoing") is not True):
            raise ClientError("This outgoing TDLib message is unavailable or changed while checking its state. Refresh the chat.", code="SEND_RECONCILIATION_REQUIRED")
        return message

    async def _failed_send_message(self, chat_id: int, message_id: int) -> dict:
        message = await self._send_message(chat_id, message_id)
        state = message.get("sending_state") or {}
        if state.get("@type") != "messageSendingStateFailed":
            raise ClientError("Only a confirmed failed outgoing TDLib message in this chat can be retried. Refresh its current state.", code="SEND_RECONCILIATION_REQUIRED")
        if state.get("can_retry") is not True or any(state.get(field) for field in ("need_another_sender", "need_another_reply_quote", "need_drop_reply", "required_paid_message_star_count")):
            raise ClientError("Telegram requires changing the sender, reply, or payment, or disallows retry. This client will not silently change your message. Keep its draft and decide in Telegram.", code="SEND_RETRY_REQUIRES_DECISION")
        if state.get("retry_after", 0) > 0:
            raise ClientError("Telegram asks you to wait before retrying this failed message.", code="TDLIB_RATE_LIMIT", cooldown=state["retry_after"], scope="peer")
        return message

    async def adopt_failed_send(self, chat_id: int, message_id: int) -> dict:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._validate_message_id(message_id)
            self._load_outbox()
            message = await self._failed_send_message(chat_id, message_id)
            # Re-read after native lookup: another adoption/send may have run while
            # awaiting TDLib. Reservation and persistence below do not yield.
            outbox = self._load_outbox()
            matching = None
            for item in outbox.values():
                if item["chat_id"] != chat_id or item["status"] in ("sent", "abandoned"):
                    continue
                lock = self._send_locks.get(item["token"])
                if (matching is not None or item["status"] != "failed"
                        or item.get("message_id") != message_id or not item.get("admitted")
                        or (lock and lock.locked())):
                    raise ClientError("This chat already has an unresolved send. Resolve it before tracking another failed message.", code="SEND_RECONCILIATION_REQUIRED")
                matching = item
            saved = self._state(self._load_private("tdlib/state.json") or self._empty_state())
            pending = saved["pending_sends"].get(str(chat_id))
            previous = outbox.get(pending["token"]) if pending else None
            if (pending and (previous is None or previous["status"] not in ("sent", "abandoned"))
                    and pending.get("message_id") != message_id):
                raise ClientError("This chat already has an unresolved send. Resolve it before tracking another failed message.", code="SEND_RECONCILIATION_REQUIRED")
            if matching is not None:
                if pending and pending["token"] != matching["token"]:
                    sequence = max(self._send_sequence, int(pending["token"]))
                    if sequence != self._send_sequence:
                        self._send_sequence = sequence
                        self._store_private("tdlib/send-sequence.json", sequence)
                    saved["pending_sends"][str(chat_id)] = matching
                    self._store_private("tdlib/state.json", self._state(saved))
                return {field: matching[field] for field in ("token", "chat_id", "text", "reply_to", "status", "message_id") if field in matching}
            content = _visible_content(message) or {}
            formatted = content.get("text") or content.get("caption") or {}
            text = compose_markdown(formatted.get("text", ""), formatted.get("entities", []))
            if text:
                self._compose(text)
            reply = message.get("reply_to") or {}
            reply_to = (reply.get("message_id") or None) if reply.get("@type") == "messageReplyToMessage" and reply.get("chat_id", chat_id) in (0, chat_id) else None
            if reply_to is not None:
                self._validate_message_id(reply_to)
            sequence = max(self._send_sequence, int(pending["token"]) if pending else 0)
            if sequence >= 2**31 - 1:
                raise ClientError("The private TDLib send token sequence is exhausted. Nothing was sent.", code="SEND_TOKEN_EXHAUSTED")
            sequence += 1
            # A retired/abandoned token is never reactivated, even for the same ID.
            self._send_sequence = sequence
            self._store_private("tdlib/send-sequence.json", sequence)
            item = {"token": str(sequence), "chat_id": chat_id, "text": text, "reply_to": reply_to, "status": "failed", "message_id": message_id, "admitted": True}
            if pending:
                # Transfer a stale saved reference before persisting the new ledger
                # record, so recovery cannot resurrect the older retired token.
                saved["pending_sends"][str(chat_id)] = item
                self._store_private("tdlib/state.json", self._state(saved))
            outbox[item["token"]] = item
            self._persist_outbox()
            return {field: item[field] for field in ("token", "chat_id", "text", "reply_to", "status", "message_id")}

    async def retry_send(self, chat_id: int, token: str) -> ChatMessage:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._token(token)
            async with self._send_locks.setdefault(token, asyncio.Lock()):
                item = await self._reconcile_send(chat_id, token)
                if item["status"] == "abandoned" and not item.get("admitted"):
                    raise ClientError("This message was never submitted. Its text is restored as a draft; prepare a new send.", code="SEND_NOT_PREPARED")
                item = self._load_outbox().get(token, item)
                if item["status"] != "failed" or not item.get("message_id"):
                    raise ClientError("Only a confirmed failed TDLib local message can be retried. Check unresolved sends in the chat.", code="SEND_RECONCILIATION_REQUIRED")
                message_id = item["message_id"]
                await self._failed_send_message(chat_id, message_id)
                if item["status"] != "failed" or item.get("message_id") != message_id:
                    raise ClientError("This failed message changed while checking retry. Reconcile its current state.", code="SEND_RECONCILIATION_REQUIRED")
                # resendMessages deletes the failed local ID and returns a new local ID.
                # Persist ambiguity first; never create a second send after a crash in this gap.
                old_id = item.pop("message_id")
                if not item["text"]:
                    # Recovery identity only: it must never be reconciled or resent
                    # after admission, but keeps captionless intent valid on reload.
                    item["retry_from_message_id"] = old_id
                item.update(status="uncertain")
                item.pop("error", None)
                self._persist_outbox()
                try:
                    result = await self._request("resendMessages", chat_id=chat_id, message_ids=[old_id], quote=None, paid_message_star_count=0)
                    message = result["messages"][0] if result["messages"] else None
                    if not message:
                        raise ClientError("Telegram did not return a retried local message.", code="SEND_UNCERTAIN")
                except Exception:
                    item["error"] = "Telegram did not return a durable retried message identity. Check the chat; this attempt cannot safely be repeated."
                    self._persist_outbox()
                    await self._send_state(item)
                    raise ClientError(item["error"], code="SEND_UNCERTAIN") from None
                await self._track_send(item, message)
                return await self._message(await self._await_sent(message))

    async def abandon_send(self, chat_id: int, token: str) -> None:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._token(token)
            async with self._send_locks.setdefault(token, asyncio.Lock()):
                item = await self._reconcile_send(chat_id, token)
                if item["status"] in ("sent", "abandoned"):
                    return
                item = self._load_outbox()[token]
                if item["status"] not in ("failed", "uncertain"):
                    raise ClientError("A queued Telegram send cannot be discarded as a retry. Wait for its actual result.", code="SEND_PENDING")
                # This is an explicit release of tracking, not cancellation or proof
                # of non-delivery. The sequence prevents this token being sent again.
                self._abandon_item(item)
                await self._send_state(item)

    async def edit(self, chat_id: int, message_id: int, text: str) -> ChatMessage:
        async with _protected():
            message = (await self._existing(chat_id, [message_id]))[0]
            if not (await self._properties(chat_id, message_id)).get("can_be_edited"):
                raise ClientError("Telegram does not permit editing this message.")
            await self.typing(chat_id, False)
            if message["content"]["@type"] == "messageText":
                result = await self._request("editMessageText", chat_id=chat_id, message_id=message_id, reply_markup=None, input_message_content=self._input_text(text))
            else:
                plain, entities = self._compose(text)
                if len(plain.encode("utf-16-le")) // 2 > 1024:
                    raise ClientError("Media captions cannot exceed 1024 UTF-16 characters. Nothing was truncated.")
                result = await self._request("editMessageCaption", chat_id=chat_id, message_id=message_id, reply_markup=None, caption={"@type": "formattedText", "text": plain, "entities": entities}, show_caption_above_media=message["content"].get("show_caption_above_media", False))
            self._remember(result)
            return await self._message(result)

    async def delete(self, chat_id: int, message_ids: list[int]) -> None:
        async with _protected():
            messages = await self._expanded(chat_id, message_ids)
            for message in messages:
                if not (await self._properties(chat_id, message["id"])).get("can_be_deleted_for_all_users"):
                    raise ClientError("Telegram does not permit deleting the complete selection for everyone. Nothing was changed.")
            await self._request("deleteMessages", chat_id=chat_id, message_ids=[message["id"] for message in messages], revoke=True)

    async def forward(self, chat_id: int, message_ids: list[int], destination_id: int) -> list[ChatMessage]:
        async with _protected():
            messages = await self._expanded(chat_id, message_ids)
            if len(messages) > 100:
                raise ClientError("At most 100 messages can be forwarded at once. Nothing was sent.")
            destination = await self._chat(destination_id)
            if not self._writable(destination):
                raise ClientError("Telegram does not permit sending in the destination chat.")
            for message in messages:
                if not (await self._properties(chat_id, message["id"])).get("can_be_forwarded"):
                    raise ClientError("Telegram does not permit forwarding the complete selection. Nothing was sent.")
            result = await self._request("forwardMessages", chat_id=destination_id, topic_id=None, from_chat_id=chat_id, message_ids=[message["id"] for message in messages], options=None, send_copy=False, remove_caption=False)
            if len(result["messages"]) != len(messages) or any(message is None for message in result["messages"]):
                raise ClientError("Telegram did not queue the complete forward. Check the destination before retrying; some messages may have been sent.", code="FORWARD_PARTIAL")
            confirmed = await asyncio.gather(*(self._await_sent(message) for message in result["messages"]))
            return [await self._message(message) for message in confirmed]

    async def mark_read(self, chat_id: int, max_id: int) -> None:
        async with _protected():
            await self._existing(chat_id, [max_id])
            await self._request("viewMessages", chat_id=chat_id, message_ids=[max_id], source={"@type": "messageSourceChatHistory"}, force_read=True)
            # Only updateChatReadInbox/Outbox advances read state, never the RPC itself.

    async def _download(self, file: dict) -> bytes:
        result = await self._request("downloadFile", file_id=file["id"], priority=16, offset=0, limit=0, synchronous=True)
        local = result["local"]
        if not local.get("is_downloading_completed") or not local.get("path"):
            raise ClientError("Telegram did not finish downloading this image.")
        raw_path = local["path"]
        if any(part in (".", "..") for part in raw_path.split(os.sep)):
            raise ClientError("Telegram returned an unsafe private image path.")
        path = Path(raw_path)
        # TDLib canonicalizes directory parents (e.g. macOS /var -> /private/var).
        # Resolve only above our private root, never a returned/cache component.
        canonical_root = self.data_dir.parent.resolve(strict=True) / self.data_dir.name
        for root in (self.data_dir, canonical_root):
            try:
                relative = path.relative_to(root)
                break
            except ValueError:
                continue
        else:
            raise ClientError("Telegram returned an image outside the private media directories.")
        parts = relative.parts
        # TDLib's Secure image types use database_directory, not files_directory.
        # FileType.cpp / FileLoaderUtils.cpp at 42e6a5259551178d1dab54a22ad96d14bd906e20.
        database_images = {"profile_photos", "thumbnails", "secret_thumbnails", "stickers", "wallpapers", "stories", "photos"}
        if not (
            len(parts) >= 3 and parts[:2] == ("tdlib", "files")
            or len(parts) >= 4 and parts[:2] == ("tdlib", "db") and parts[2] in database_images
        ):
            raise ClientError("Telegram returned an image outside the private media directories.")
        # Open every private component without following symlinks, including roots.
        directory = os.open(self.data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(directory)
            if info.st_uid != os.getuid():
                raise ClientError("Downloaded image directories must be owned by you.")
            os.fchmod(directory, 0o700)
            for component in relative.parts[:-1]:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
                info = os.fstat(directory)
                if info.st_uid != os.getuid():
                    raise ClientError("Downloaded image directories must be owned by you.")
                os.fchmod(directory, 0o700)
            fd = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    raise ClientError("Downloaded images must be private regular files owned by you.")
                os.fchmod(stream.fileno(), 0o600)
                return stream.read()
        finally:
            os.close(directory)

    async def photo(self, chat_id: int, message_id: int, preview: bool = False) -> dict | None:
        async with _protected():
            if type(preview) is not bool:
                raise ClientError("Choose a photo or its preview.")
            await self._chat(chat_id)
            self._validate_message_id(message_id)
            key = chat_id, message_id
            version = self._message_versions.get(key, 0)
            result = await self._request("getMessages", chat_id=chat_id, message_ids=[message_id])
            message, = result["messages"]
            if message is not None and (message["chat_id"] != chat_id or message["id"] != message_id):
                raise ClientError("A selected message is no longer available in this chat.")
            if version != self._message_versions.get(key, 0) or key in self._deleted_messages:
                await self._media_changed(chat_id, message_id)
            if message is None:
                self._messages.pop(key, None)
                self._deleted_messages.add(key)
                self._message_versions[key] = version + 1
                await self._media_changed(chat_id, message_id)
            self._remember(message, version)
            content = _visible_content(message)
            if content is None:
                raise ClientError("Telegram restricts this content or requires protected age-verification/spoiler viewing. Open it in Telegram.", code="MEDIA_RESTRICTED")
            ephemeral = message.get("ephemeral_content")
            if ephemeral and not ephemeral.get("can_be_saved"):
                raise ClientError("Telegram does not permit saving this temporary content.", code="MEDIA_PROTECTED")
            media, mime = _image_media(message)
            if media is None:
                await self._media_changed(chat_id, message_id)
            self_destruct = bool(message.get("self_destruct_type") or content.get("is_secret"))
            if self_destruct and preview:
                return None  # Previews must never consume protected or view-once media.
            props = await self._properties(chat_id, message_id)
            if not props.get("can_be_saved", False) or props.get("has_protected_content_by_current_user") or props.get("has_protected_content_by_other_user") or (await self._chat(chat_id)).get("has_protected_content"):
                if self_destruct:
                    raise ClientError("Telegram requires a protected viewer for this self-destructing or view-once media. Open it in Telegram.", code="MEDIA_PROTECTED_VIEWER_REQUIRED")
                raise ClientError("Telegram protects this content from local saving. This client will not download it.", code="MEDIA_PROTECTED")
            if version != self._message_versions.get((chat_id, message_id), 0):
                await self._media_changed(chat_id, message_id)
            if "sizes" in media:
                sizes = sorted((size for size in media["sizes"] if size.get("width", 0) > 0 and size.get("height", 0) > 0), key=lambda size: size["width"] * size["height"])
                if not sizes:
                    raise ClientError("Telegram has no viewable size for this photo.")
                size = next((size for size in sizes if max(size["width"], size["height"]) >= 320), sizes[-1]) if preview else sizes[-1]
                file, width, height = size["photo"], size["width"], size["height"]
            elif preview:
                thumbnail = media.get("thumbnail")
                if not thumbnail:
                    return None
                if thumbnail.get("format", {}).get("@type") not in ("thumbnailFormatJpeg", "thumbnailFormatPng", "thumbnailFormatWebp"):
                    return None
                mime = {"thumbnailFormatJpeg": "image/jpeg", "thumbnailFormatPng": "image/png", "thumbnailFormatWebp": "image/webp"}[thumbnail["format"]["@type"]]
                file, width, height = thumbnail["file"], thumbnail["width"], thumbnail["height"]
            else:
                file, width, height = media["document"], 0, 0
            data = await self._download(file)
            if version != self._message_versions.get((chat_id, message_id), 0):
                await self._media_changed(chat_id, message_id)
            if not width or not height:
                width, height = _image_dimensions(data, mime)
            if not preview:
                await self._request("openMessageContent", chat_id=chat_id, message_id=message_id)
            if version != self._message_versions.get((chat_id, message_id), 0):
                await self._media_changed(chat_id, message_id)
            return {"data": base64.b64encode(data).decode("ascii"), "mime": mime, "width": width, "height": height}

    async def avatar(self, sender_id: int) -> dict | None:
        async with _protected():
            self._validate_chat_id(sender_id)
            if sender_id > 0 and sender_id in self._users:
                photo = self._users[sender_id].get("profile_photo")
            elif sender_id in self._chats:
                photo = self._chats[sender_id].get("photo")
            else:
                return None
            if not photo:
                return None
            data = await self._download(photo["small"])
            width, height = _image_dimensions(data, "image/jpeg")
            return {"data": base64.b64encode(data).decode("ascii"), "mime": "image/jpeg", "width": width, "height": height}

    async def _activity_rpc(self, method: str, **fields) -> bool:
        now = monotonic()
        if self._authorization["state"] != "ready" or not self._last_connection or now < self._activity_waits.get(method, 0):
            return False
        epoch, client = self._epoch, self._client
        try:
            await asyncio.wait_for(self._request(method, **fields), timeout=5)
            return epoch == self._epoch and client is self._client
        except Exception as exc:
            if epoch != self._epoch or client is not self._client:
                return False
            self._activity_waits[method] = now + (retry_after(exc) or 5)
            return False

    async def _own_status(self, online: bool) -> None:
        if self._own_online != online:
            if await self._activity_rpc("setOption", name="online", value={"@type": "optionValueBoolean", "value": online}):
                self._own_online = online

    async def _watch_activity(self) -> None:
        while True:
            await self._own_status(self._last_activity is not None and monotonic() - self._last_activity < 60)
            await asyncio.sleep(1)

    async def activity(self) -> None:
        self._last_activity = monotonic()
        await self._own_status(True)

    async def _cancel_typing(self) -> None:
        chat_id, self._typing_peer = self._typing_peer, None
        if chat_id is not None:
            await self._activity_rpc("sendChatAction", chat_id=chat_id, topic_id=None, business_connection_id="", action={"@type": "chatActionCancel"})

    async def select_peer(self, chat_id: int | None) -> None:
        async with _protected():
            if chat_id is not None:
                await self._chat(chat_id)
            if chat_id != self._selected_peer:
                await self._cancel_typing()
                if self._selected_peer is not None:
                    await self._request("closeChat", chat_id=self._selected_peer)
                self._selected_peer = chat_id
                if chat_id is not None:
                    await self._request("openChat", chat_id=chat_id)

    async def typing(self, chat_id: int, active: bool) -> None:
        async with _protected():
            self._validate_chat_id(chat_id)
            if type(active) is not bool:
                raise ClientError("Typing activity must be a boolean.")
            if not active:
                if self._typing_peer == chat_id:
                    await self._cancel_typing()
                return
            if chat_id != self._selected_peer or not self._writable(await self._chat(chat_id)):
                raise ClientError("Typing requires the selected writable conversation.")
            now = monotonic()
            if now - self._typing_sent.get(chat_id, -10) < 4:
                return
            self._typing_sent[chat_id] = now
            self._typing_peer = chat_id
            await self._activity_rpc("sendChatAction", chat_id=chat_id, topic_id=None, business_connection_id="", action={"@type": "chatActionTyping"})

    async def _dialog_changed(self, chat_id: int, **fields) -> None:
        self._chat_versions[chat_id] = self._chat_versions.get(chat_id, 0) + 1
        await self.on_event({"kind": "dialog_changed", "chat_id": chat_id, **fields})

    def _positions(self, chat: dict, positions: list[dict], *, replace: bool = False) -> None:
        existing = {} if replace else {json.dumps(position["list"], sort_keys=True): position for position in chat.get("positions", [])}
        for position in positions:
            existing[json.dumps(position["list"], sort_keys=True)] = position
        chat["positions"] = list(existing.values())

    async def _finish_send(self, update: dict) -> None:
        message = update["message"]
        chat_id, old_id = message["chat_id"], update["old_message_id"]
        key = chat_id, old_id
        failed = update["@type"] == "updateMessageSendFailed"
        error = _safe_error(TDLibError(update["error"]["code"], update["error"]["message"])) if failed else None
        self._send_results[key] = error or message
        self._messages.pop(key, None)
        self._message_versions[key] = self._message_versions.get(key, 0) + 1
        self._remember(message)
        for item in list(self._load_outbox().values()):
            if item["chat_id"] == chat_id and item.get("message_id") == old_id and item["status"] not in ("sent", "abandoned"):
                item.update(status="failed" if failed else "sent", message_id=message["id"])
                if failed:
                    item["error"] = str(error)
                else:
                    item.pop("error", None)
                self._persist_outbox()
                await self._send_state(item, message)
        future = self._send_waiters.pop(key, None)
        if future is not None and not future.done():
            if error:
                future.set_exception(error)
            else:
                future.set_result(message)
        await self.on_event({"kind": "delete", "chat_id": chat_id, "ids": [old_id]})
        await self.on_event({"kind": "message", "chat_id": chat_id, "message": await self._message(message)})

    async def _update(self, update: dict) -> None:
        kind = update.get("@type")
        chat_id = update.get("chat_id", 0)
        try:
            if kind == "updateAuthorizationState":
                await self._authorization_update(update["authorization_state"])
                return
            if kind == "updateConnectionState":
                connected = update["state"]["@type"] == "connectionStateReady"
                if connected != self._last_connection:
                    self._last_connection = connected
                    if not connected:
                        self._own_online = None
                        self._typing_peer = None
                    if self.on_connection:
                        await self.on_connection(connected)
                return
            if kind == "updateNewChat":
                chat = update["chat"]
                self._chats[chat["id"]] = chat
                if chat.get("last_message"):
                    self._remember(chat["last_message"])
                async with self._cache_changed:
                    self._cache_changed.notify_all()
                return
            if kind == "updateUser":
                user = update["user"]
                old = self._users.get(user["id"], {})
                self._users[user["id"]] = user
                for chat in self._chats.values():
                    if chat["type"].get("user_id") == user["id"]:
                        await self._dialog_changed(chat["id"], avatar_changed=old.get("profile_photo") != user.get("profile_photo"))
                return
            if kind in ("updateBasicGroup", "updateSupergroup", "updateBasicGroupFullInfo", "updateSupergroupFullInfo"):
                basic = "Basic" in kind
                category = "basic" if basic else "super"
                field = "basic_group" if basic else "supergroup"
                full = kind.endswith("FullInfo")
                data = update[field + "_full_info"] if full else update[field]
                identifier = update[field + "_id"] if full else data["id"]
                key = category, identifier
                (self._full_groups if full else self._groups)[key] = data
                for chat in self._chats.values():
                    if self._group_key(chat) == key:
                        await self._dialog_changed(chat["id"], participants_changed=True, permissions_changed=not full)
                return
            if kind == "updateChatMember":
                chat = self._chats.get(chat_id)
                if chat:
                    key = self._group_key(chat)
                    if key:
                        self._full_groups.pop(key, None)
                    await self._dialog_changed(chat_id, participants_changed=True, permissions_changed=True)
                return
            if kind == "updateUserStatus":
                user = self._users.get(update["user_id"])
                if user:
                    user["status"] = update["status"]
                for chat in self._chats.values():
                    if chat["type"].get("user_id") == update["user_id"]:
                        await self.on_event({"kind": "presence", "chat_id": chat["id"], "presence": _presence(update["status"])})
                return
            if kind == "updateChatAction":
                sender, sender_id = await self._sender_name(update["sender_id"])
                if self._me and sender_id == self._me["id"]:
                    return
                action = update["action"]["@type"]
                await self.on_event({"kind": "typing", "chat_id": chat_id, "sender_id": sender_id, "sender": sender, "action": action, "expires_in": 6})
                return
            if kind in ("updateMessageSendSucceeded", "updateMessageSendFailed"):
                await self._finish_send(update)
                return
            if kind == "updateNewMessage":
                message = update["message"]
                key = message["chat_id"], message["id"]
                self._message_versions[key] = self._message_versions.get(key, 0) + 1
                self._remember(message)
                state = message.get("sending_state") or {}
                token = str(state.get("sending_id", ""))
                item = self._load_outbox().get(token)
                if item and item["chat_id"] == message["chat_id"] and item.get("admitted") and item["status"] not in ("sent", "abandoned"):
                    await self._track_send(item, message)
                await self.on_event({"kind": "message", "chat_id": message["chat_id"], "message": await self._message(message)})
                return
            if kind == "updateDeleteMessages":
                if not update.get("is_permanent"):
                    return  # Cache eviction is not a user-visible deletion.
                for message_id in update["message_ids"]:
                    key = chat_id, message_id
                    self._messages.pop(key, None)
                    self._deleted_messages.add(key)
                    self._message_versions[key] = self._message_versions.get(key, 0) + 1
                    error = ClientError("TDLib deleted this pending message without confirming delivery. Check the chat before a new send.", code="SEND_UNCERTAIN")
                    self._send_results[key] = error
                    future = self._send_waiters.pop(key, None)
                    if future and not future.done():
                        future.set_exception(error)
                    for item in list(self._load_outbox().values()):
                        if item["chat_id"] == chat_id and item.get("message_id") == message_id and item["status"] not in ("sent", "abandoned"):
                            item.update(status="uncertain", error=str(error))
                            self._persist_outbox()
                            await self._send_state(item)
                await self.on_event({"kind": "delete", "chat_id": chat_id, "ids": update["message_ids"]})
                return
            if kind in ("updateMessageContent", "updateMessageEphemeralContent", "updateMessageEdited", "updateMessageInteractionInfo", "updateMessageIsPinned", "updateMessageContentOpened"):
                key = chat_id, update["message_id"]
                self._message_versions[key] = self._message_versions.get(key, 0) + 1
                message = self._messages.get(key)
                if message:
                    if kind == "updateMessageContent":
                        # Replace, never merge: expired/deleted photos must lose file/media identity.
                        message["content"] = update["new_content"]
                        last = self._chats.get(chat_id, {}).get("last_message")
                        if last and last["id"] == message["id"]:
                            last["content"] = update["new_content"]
                    elif kind == "updateMessageEphemeralContent":
                        message["ephemeral_content"] = update.get("ephemeral_content")
                    elif kind == "updateMessageEdited":
                        message["edit_date"] = update["edit_date"]
                        message["reply_markup"] = update.get("reply_markup")
                    elif kind == "updateMessageInteractionInfo":
                        message["interaction_info"] = update.get("interaction_info")
                    elif kind == "updateMessageIsPinned":
                        message["is_pinned"] = update["is_pinned"]
                    await self.on_event({"kind": "message", "chat_id": chat_id, "message": await self._message(message)})
                else:
                    await self.on_event({"kind": "refresh", "chat_id": chat_id})
                return
            if kind and kind.startswith("updateChat") and chat_id in self._chats:
                chat = self._chats[chat_id]
                fields = {field: value for field, value in update.items() if field not in ("@type", "chat_id", "positions", "position")}
                for field in ("last_read_inbox_message_id", "last_read_outbox_message_id"):
                    if field in fields:
                        fields[field] = max(chat.get(field, 0), fields[field])
                chat.update(fields)
                if "positions" in update:
                    self._positions(chat, update["positions"], replace=True)
                elif "position" in update:
                    self._positions(chat, [update["position"]])
                if kind in ("updateChatReadInbox", "updateChatReadOutbox"):
                    outbox = kind == "updateChatReadOutbox"
                    maximum = chat["last_read_outbox_message_id" if outbox else "last_read_inbox_message_id"]
                    await self.on_event({"kind": "read", "chat_id": chat_id, "max_id": maximum, "outbox": outbox})
                else:
                    await self._dialog_changed(chat_id, **({"title": chat["title"]} if kind == "updateChatTitle" else {"avatar_changed": True} if kind == "updateChatPhoto" else {"permissions_changed": True} if kind == "updateChatPermissions" else {}))
                async with self._cache_changed:
                    self._cache_changed.notify_all()
        except Exception as exc:
            if kind == "updateAuthorizationState":
                self._auth_error = _safe_error(exc)
                await self._publish_auth({"state": "closed"})
            else:
                self.record_error("update", exc)
                await self.on_event({"kind": "refresh", "chat_id": chat_id})

    async def logout(self) -> None:
        async with _protected():
            await self._ready().request({"@type": "logOut"})
            await self.close()
            # Legacy personal session and state are deliberately untouched.
            for filename in ("tdlib/state.json", "tdlib/outbox.json", "tdlib/send-sequence.json"):
                (self.data_dir / filename).unlink(missing_ok=True)
            self._outbox = None
            self._send_sequence = None

    async def close(self) -> None:
        async with _protected():
            if self._activity_task:
                self._activity_task.cancel()
                await asyncio.gather(self._activity_task, return_exceptions=True)
                self._activity_task = None
            await self._cancel_typing()
            await self._own_status(False)
            if self._client:
                await self._client.close()
                self._client = None
            self._epoch += 1
            self._me = None
            self._selected_peer = self._typing_peer = None
            self._last_activity = None
            self._own_online = False
            self._chats.clear()
            self._users.clear()
            self._groups.clear()
            self._full_groups.clear()
            self._messages.clear()
            self._message_versions.clear()
            self._deleted_messages.clear()
            self._chat_versions.clear()
            self._lists_exhausted.clear()
            self._typing_sent.clear()
            self._activity_waits.clear()
            for future in self._send_waiters.values():
                if not future.done():
                    future.set_exception(ClientError("The client closed before send confirmation. Reconcile the pending message after reconnecting.", code="SEND_UNCERTAIN"))
            self._send_waiters.clear()
            self._send_results.clear()
            self._auth_type = "authorizationStateClosed"
            await self._publish_auth({"state": "closed"})
            if self._last_connection and self.on_connection:
                await self.on_connection(False)
            self._last_connection = False
