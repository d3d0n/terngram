"""Personal-account Telegram access; secrets live only in the private data directory."""

from __future__ import annotations

import asyncio
import base64
import json
import locale
import logging
import os
import platform
import re
import stat
import struct
import tempfile
import traceback
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from telethon import TelegramClient, errors, events, functions, types, utils

from .formatting import display_markdown, parse_markdown
from .readers import ReadParticipants


class ClientError(Exception):
    """A user-facing error containing no Telegram inputs or session material."""


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
    media_id: str | None


def _root_cause(error: Exception) -> Exception:
    seen = set()
    while id(error) not in seen:
        seen.add(id(error))
        nested = error.__cause__ or error.__context__
        if nested is None or id(nested) in seen:
            break
        error = nested
    return error


def retry_after(error: Exception) -> int | None:
    cause = _root_cause(error)
    if isinstance(cause, (errors.FloodWaitError, errors.FloodPremiumWaitError, errors.SlowModeWaitError)):
        seconds = cause.seconds
        if type(seconds) is int and seconds >= 0:
            return seconds
    return None


def retry_scope(error: Exception) -> str | None:
    if retry_after(error) is None:
        return None
    return "peer" if isinstance(_root_cause(error), errors.SlowModeWaitError) else "method"


_METADATA_UPDATES = (
    types.UpdateUser, types.UpdateUserName, types.UpdateChat, types.UpdateChannel,
    types.UpdateChatParticipants, types.UpdateChatParticipant,
    types.UpdateChatParticipantAdd, types.UpdateChatParticipantDelete,
    types.UpdateChatParticipantAdmin, types.UpdateChatParticipantRank, types.UpdateChatDefaultBannedRights,
    types.UpdateChannelParticipant, types.UpdateChannelTooLong, types.UpdateConfig,
    types.UpdateNewMessage, types.UpdateNewChannelMessage,
)

_ACTIVITY_UPDATES = (
    types.UpdateUserStatus, types.UpdateUserTyping,
    types.UpdateChatUserTyping, types.UpdateChannelUserTyping,
)


def _presence(status) -> dict:
    for cls, state, field in (
        (types.UserStatusOnline, "online", "expires"),
        (types.UserStatusOffline, "offline", "was_online"),
        (types.UserStatusRecently, "recently", None),
        (types.UserStatusLastWeek, "last_week", None),
        (types.UserStatusLastMonth, "last_month", None),
    ):
        if isinstance(status, cls):
            value = getattr(status, field, None) if field else None
            return {"state": state, **({field: int(value.timestamp())} if isinstance(value, datetime) else {})}
    return {"state": "unknown"}


def _safe_error(exc: Exception) -> ClientError:
    if isinstance(exc, ClientError):
        return exc
    if isinstance(exc, (errors.FloodWaitError, errors.FloodPremiumWaitError, errors.SlowModeWaitError)):
        return ClientError(f"Telegram asks you to wait {exc.seconds} seconds. Try again afterward.")
    if isinstance(exc, errors.PhoneCodeExpiredError):
        return ClientError("The login code expired. Request a new code.")
    if isinstance(exc, (errors.PhoneCodeInvalidError, errors.PhoneCodeEmptyError)):
        return ClientError("The login code is invalid. Check it and try again.")
    if isinstance(exc, errors.PasswordHashInvalidError):
        return ClientError("The two-step verification password is incorrect.")
    if isinstance(exc, errors.PhoneNumberInvalidError):
        return ClientError("The phone number is invalid. Include the country code.")
    if isinstance(exc, errors.ApiIdInvalidError):
        return ClientError("The Telegram API ID or API hash is invalid.")
    if isinstance(exc, errors.PhoneNumberBannedError):
        return ClientError("Telegram has banned this phone number.")
    if isinstance(exc, errors.AuthKeyError) or isinstance(exc, errors.UnauthorizedError):
        return ClientError("Telegram authorization is unavailable or expired. Sign in again.")
    if isinstance(exc, errors.ForbiddenError):
        return ClientError("Telegram does not permit this action in this chat.")
    if isinstance(exc, errors.MessageTooLongError):
        return ClientError("Telegram rejected this message as too long. Nothing was truncated.")
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return ClientError("The connection or private local storage is unavailable. Check it and try again. If sending, check the chat before retrying; delivery may have succeeded.")
    if isinstance(exc, errors.RPCError):
        return ClientError("Telegram could not complete this action. Try again later. If sending, check the chat before retrying.")
    return ClientError("The action could not be completed. Reconnect and try again. If sending, check the chat before retrying.")


@asynccontextmanager
async def _protected():
    try:
        yield
    except Exception as exc:
        raise _safe_error(exc) from None


def _name(entity) -> str:
    if entity is None:
        return "Unknown sender"
    return utils.get_display_name(entity) or getattr(entity, "username", None) or "Deleted account"


def _kind(value, prefix: str) -> str:
    name = type(value).__name__.removeprefix(prefix)
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name)


_IMAGE_MIMES = frozenset(("image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"))


def _image_media(message):
    media = getattr(message, "media", None)
    if isinstance(media, types.MessageMediaPhoto) and isinstance(media.photo, types.Photo):
        return media.photo, "image/jpeg"
    if isinstance(media, types.MessageMediaDocument) and isinstance(media.document, types.Document):
        document = media.document
        if document.mime_type in _IMAGE_MIMES and not any(isinstance(attr, types.DocumentAttributeSticker) for attr in document.attributes):
            return document, document.mime_type
    return None, None


_PREVIEW_EDGE = 320  # Telegram's "m" photo size: enough inline, small enough to fetch automatically.


def _dimensioned(sizes) -> list:
    """Downloadable sizes smallest first; stripped and path previews have no dimensions."""
    return sorted(
        (size for size in sizes or () if getattr(size, "w", 0) > 0 and getattr(size, "h", 0) > 0),
        key=lambda size: size.w * size.h,
    )


def _preview_size(sizes):
    sized = _dimensioned(sizes)
    return next((size for size in sized if max(size.w, size.h) >= _PREVIEW_EDGE), sized[-1] if sized else None)


def _image_dimensions(data: bytes, mime: str) -> tuple[int, int]:
    """Read raster headers for image documents which lack Telegram dimensions."""
    if mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if mime == "image/gif" and data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        return struct.unpack("<HH", data[6:10])
    if mime == "image/bmp" and data.startswith(b"BM") and len(data) >= 26:
        size = int.from_bytes(data[14:18], "little")
        if size == 12:
            return struct.unpack("<HH", data[18:22])
        width, height = struct.unpack("<ii", data[18:26])
        return abs(width), abs(height)
    if mime == "image/webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8X" and len(data) >= 30:
            return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if data[12:16] == b"VP8 " and data[23:26] == b"\x9d\x01\x2a" and len(data) >= 30:
            width, height = struct.unpack("<HH", data[26:30])
            return width & 0x3fff, height & 0x3fff
        if data[12:16] == b"VP8L" and len(data) >= 25 and data[20] == 0x2f:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
    if mime == "image/jpeg" and data.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 0xff:
                break
            while offset < len(data) and data[offset] == 0xff:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
                continue
            size = int.from_bytes(data[offset:offset + 2], "big")
            if size < 2 or offset + size > len(data):
                break
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and size >= 7:
                height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
                return width, height
            offset += size
    raise ClientError("This image format or its dimensions cannot be displayed.")


def _text(message) -> str:
    text = getattr(message, "message", None) or ""
    action = getattr(message, "action", None)
    if action is not None:
        return f"[Service message: {_kind(action, 'MessageAction')}]"
    if _image_media(message)[0] is not None:
        return text or "[Photo]"
    media = getattr(message, "media", None)
    if media is not None and not isinstance(media, (types.MessageMediaEmpty, types.MessageMediaWebPage)):
        label = f"[Attachment: {_kind(media, 'MessageMedia')}; viewing is not supported]"
        return f"{text}\n{label}" if text else label
    return text or "[Empty or unavailable message]"


def _writable(entity) -> bool:
    if isinstance(entity, types.User):
        return not entity.deleted
    if getattr(entity, "left", False) or getattr(entity, "deactivated", False):
        return False
    if getattr(entity, "creator", False):
        return True
    rights = getattr(entity, "admin_rights", None)
    if isinstance(entity, types.Channel) and entity.broadcast:
        return bool(rights and rights.post_messages)
    if rights:
        return True
    for attr in ("banned_rights", "default_banned_rights"):
        banned = getattr(entity, attr, None)
        if banned and (banned.send_messages or getattr(banned, "send_plain", False)):
            return False
    return True


class TelegramService:
    def __init__(
        self, data_dir: Path, on_event: Callable[[dict], Awaitable[None]],
        on_connection: Callable[[bool], Awaitable[None]] | None = None,
    ):
        self.data_dir = Path(data_dir).expanduser().absolute()
        self.on_event = on_event
        self.on_connection = on_connection
        self._client: TelegramClient | None = None
        self._me = None
        self._phone: str | None = None
        self._code_hash: str | None = None
        self._peers: dict[int, object] = {}
        self._avatar_entities: dict[int, object] = {}
        self._avatar_dirty: set[int] = set()
        self._nonchannel_messages: dict[int, int] = {}
        self._outbox_max: dict[int, int] = {}
        self._inbox_max: dict[int, int] = {}
        self._read_loaded: set[int] = set()
        self._chat_info: dict[int, dict] = {}
        self._full_chats: dict[int, object] = {}
        self._metadata_versions: dict[int, int] = {}
        self._info_locks: dict[int, asyncio.Lock] = {}
        self._titles: dict[int, str] = {}
        self._readers: ReadParticipants | None = None
        self._connection_task: asyncio.Task | None = None
        self._last_connection: bool | None = None
        self._activity_lock = asyncio.Lock()
        self._selected_peer: int | None = None
        self._typing_peer: int | None = None
        self._typing_sent: dict[int, float] = {}
        self._activity_waits: dict[str, float] = {}
        self._last_activity: float | None = None
        self._status_sent = 0.0
        self._own_online = False
        self._activity_epoch = 0
        # Never allow Telethon's diagnostic output to expose request contents.
        self._logger = logging.getLogger("terngram.mtproto")
        self._logger.addHandler(logging.NullHandler())
        self._logger.propagate = False
        self._logger.setLevel(logging.CRITICAL)

    def _private_dir(self) -> None:
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.data_dir.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ClientError("The private data directory must be owned by you and cannot be a symbolic link.")
        self.data_dir.chmod(0o700)

    def _load_private(self, name: str):
        self._private_dir()
        try:
            fd = os.open(self.data_dir / name, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ClientError("Local account data must be a private file owned by you.")
            os.fchmod(stream.fileno(), 0o600)
            return json.load(stream)

    def _load_credentials(self) -> tuple[int, str] | None:
        data = self._load_private("credentials.json")
        if data is None:
            return None
        api_id, api_hash = data["api_id"], data["api_hash"]
        self._validate_credentials(api_id, api_hash)
        return api_id, api_hash

    @staticmethod
    def _validate_credentials(api_id, api_hash) -> None:
        if type(api_id) is not int or api_id <= 0 or not isinstance(api_hash, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", api_hash):
            raise ClientError("Enter a valid Telegram API ID and 32-character API hash from my.telegram.org.")

    def _store_private(self, filename: str, data) -> None:
        self._private_dir()
        fd, name = tempfile.mkstemp(prefix="private-", dir=self.data_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.data_dir / filename)
        finally:
            Path(name).unlink(missing_ok=True)

    def record_error(self, operation: str, error: Exception) -> str:
        """Keep operation and stack locations only: no message text, RPC arguments, locals or exception values."""
        cause = _root_cause(error)
        frames = [
            {"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
            for frame in traceback.extract_tb(cause.__traceback__)[-12:]
        ]
        kind = type(cause).__name__
        record = {"operation": operation, "kind": kind, "frames": frames}
        try:
            self._store_private("last-error.json", record)
        except (ClientError, OSError):
            pass  # The original failure must still reach the UI when diagnostic storage itself is unavailable.
        return f"{kind} @ {frames[-1]['file']}:{frames[-1]['line']}" if frames else kind

    def _store_credentials(self, api_id: int, api_hash: str) -> None:
        self._validate_credentials(api_id, api_hash)
        self._store_private("credentials.json", {"api_id": api_id, "api_hash": api_hash})

    @staticmethod
    def _validate_chat_id(chat_id) -> None:
        if type(chat_id) is not int or chat_id == 0 or abs(chat_id) > 2**53 - 1:
            raise ClientError("Select a valid Telegram chat.")

    @staticmethod
    def _validate_message_id(message_id) -> None:
        if type(message_id) is not int or not 0 < message_id < 2**31:
            raise ClientError("Select a valid Telegram message.")

    @staticmethod
    def _random_id(value: str) -> int:
        if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", value) or int(value) > 2**63 - 1:
            raise ClientError("The pending message identifier is invalid.")
        return int(value)

    def _state(self, state) -> dict:
        if not isinstance(state, dict) or not isinstance(state.get("drafts"), dict):
            raise ClientError("The saved chat selection and drafts are invalid.")
        drafts = {}
        for key, value in state["drafts"].items():
            if not isinstance(key, str) or not re.fullmatch(r"-?[1-9]\d*", key) or not isinstance(value, str):
                raise ClientError("The saved chat selection and drafts are invalid.")
            self._validate_chat_id(int(key))
            drafts[key] = value
        pending_sends = state.get("pending_sends", {})
        if not isinstance(pending_sends, dict):
            raise ClientError("The saved pending messages are invalid.")
        pending = {}
        for key, value in pending_sends.items():
            if not isinstance(key, str) or not re.fullmatch(r"-?[1-9][0-9]*", key) or not isinstance(value, dict) or not {"text", "reply_to", "random_id"} <= value.keys():
                raise ClientError("The saved pending messages are invalid.")
            self._validate_chat_id(int(key))
            text, reply_to, random_id = value.get("text"), value.get("reply_to"), value.get("random_id")
            self._compose(text)
            if reply_to is not None:
                self._validate_message_id(reply_to)
            self._random_id(random_id)
            pending[key] = {"text": text, "reply_to": reply_to, "random_id": random_id}
        selected = state.get("selected_id")
        if selected is not None:
            self._validate_chat_id(selected)
        return {"drafts": drafts, "selected_id": selected, "pending_sends": pending}

    async def load_state(self) -> dict:
        async with _protected():
            state = self._load_private("state.json")
            return self._state(state) if state is not None else {"drafts": {}, "selected_id": None, "pending_sends": {}}

    async def save_state(self, state: dict) -> None:
        async with _protected():
            self._store_private("state.json", self._state(state))

    async def _connection_status(self) -> None:
        # is_connected() remains true during automatic reconnects in Telethon.
        sender = getattr(self._client, "_sender", None)
        transport = getattr(sender, "_connection", None)
        connected = bool(
            self._client and self._client.is_connected()
            and not getattr(sender, "_reconnecting", False)
            and getattr(transport, "_connected", False)
        )
        if connected != self._last_connection:
            self._last_connection = connected
            if not connected:
                self._activity_epoch += 1
                self._typing_peer = None
                self._last_activity = None
                self._own_online = False
            if self.on_connection is not None:
                await self.on_connection(connected)

    async def _watch_connection(self) -> None:
        while True:
            await self._connection_status()
            if self._last_connection and self._me is not None:
                async with self._activity_lock:
                    await self._own_status(self._last_activity is not None and asyncio.get_running_loop().time() - self._last_activity < 60)
            await asyncio.sleep(0.5)

    async def _stop_connection_watch(self) -> None:
        if self._connection_task is not None:
            self._connection_task.cancel()
            await asyncio.gather(self._connection_task, return_exceptions=True)
            self._connection_task = None

    def has_credentials(self) -> bool:
        try:
            return self._load_credentials() is not None
        except (ValueError, KeyError, TypeError):
            return False
        except Exception as exc:
            raise _safe_error(exc) from None

    def _connected(self) -> TelegramClient:
        if self._client is None or not self._client.is_connected():
            raise ClientError("Not connected to Telegram. Connect again.")
        return self._client

    async def connect(self, api_id: int | None = None, api_hash: str | None = None) -> bool:
        async with _protected():
            if api_id is not None or api_hash is not None:
                self._validate_credentials(api_id, api_hash)
                await self.close()
                self._store_credentials(api_id, api_hash)
            credentials = self._load_credentials()
            if credentials is None:
                raise ClientError("Enter your Telegram API ID and API hash first.")
            if self._client is None:
                path = self.data_dir / "account.session"
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                        raise ClientError("The session must be a private file owned by you.")
                    os.fchmod(fd, 0o600)
                finally:
                    os.close(fd)
                system = platform.system()
                mac_version = platform.mac_ver()[0] if system == "Darwin" else ""
                system_version = f"macOS {mac_version}" if mac_version else f"{system} {platform.release()}"
                system_language = (locale.getlocale()[0] or "en").replace("-", "_").split("_")[0].lower()
                self._client = TelegramClient(
                    str(path), *credentials, request_retries=0,
                    flood_sleep_threshold=0, raise_last_call_error=True,
                    base_logger=self._logger, device_model=f"Desktop ({platform.machine() or 'unknown architecture'})",
                    system_version=system_version, app_version=f"Terngram {version('terngram')}",
                    lang_code="en", system_lang_code=system_language if re.fullmatch(r"[a-z]{2}", system_language) else "en",
                    receive_updates=True, catch_up=True,
                )
                for event in (
                    events.NewMessage(), events.MessageEdited(), events.MessageDeleted(),
                    events.MessageRead(), events.MessageRead(inbox=True),
                ):
                    self._client.add_event_handler(self._update, event)
                self._client.add_event_handler(self._metadata_update, events.Raw(types=_METADATA_UPDATES))
                activity_client = self._client
                async def activity_update(update) -> None:
                    if self._client is activity_client:
                        await self._activity_update(update)
                self._client.add_event_handler(activity_update, events.Raw(types=_ACTIVITY_UPDATES))
                self._readers = ReadParticipants(self._client)
            if self._connection_task is None:
                self._connection_task = asyncio.create_task(self._watch_connection())
            await self._client.connect()
            await self._connection_status()
            authorized = await self._client.is_user_authorized()
            if authorized:
                self._me = await self._client.get_me()
                await self._client.set_receive_updates(True)
            return authorized

    async def request_code(self, phone: str) -> None:
        async with _protected():
            if not phone.strip():
                raise ClientError("Enter your phone number including the country code.")
            result = await self._connected().send_code_request(phone.strip())
            self._phone = phone.strip()
            self._code_hash = result.phone_code_hash

    async def sign_in_code(self, code: str) -> bool:
        async with _protected():
            if not self._phone or not self._code_hash:
                raise ClientError("Request a login code first.")
            try:
                await self._connected().sign_in(phone=self._phone, code=code.strip(), phone_code_hash=self._code_hash)
            except errors.SessionPasswordNeededError:
                return False
            self._phone = self._code_hash = None
            await self._connected().set_receive_updates(True)
            return True

    async def sign_in_password(self, password: str) -> None:
        async with _protected():
            await self._connected().sign_in(password=password)
            self._phone = self._code_hash = None
            await self._connected().set_receive_updates(True)

    async def me(self) -> str:
        async with _protected():
            user = self._me or await self._connected().get_me()
            if user is None:
                raise ClientError("Sign in to your Telegram account first.")
            self._me = user
            return _name(user)

    @staticmethod
    def _channel(chat_id: int) -> bool:
        return utils.resolve_id(chat_id)[1] is types.PeerChannel

    async def _peer(self, chat_id: int):
        self._validate_chat_id(chat_id)
        if chat_id in self._peers:
            return self._peers[chat_id]
        client = self._connected()
        real_id, peer_type = utils.resolve_id(chat_id)
        peer = peer_type(real_id)
        entity = await client.get_input_entity(peer)
        if isinstance(entity, types.InputPeerSelf):
            user = await client.get_me()
            actual_id = utils.get_peer_id(user) if user is not None else None
        else:
            actual_id = utils.get_peer_id(entity)
        # Telethon's in-memory cache is keyed by unmarked IDs. Never let an
        # identically numbered user/channel resolve to the wrong conversation.
        if actual_id != chat_id:
            entity = await utils.maybe_async(client.session.get_input_entity(peer))
            if utils.get_peer_id(entity) != chat_id:
                raise ClientError("Telegram could not resolve the selected chat.")
        self._peers[chat_id] = entity
        return entity

    def _remember(self, message, chat_id: int) -> None:
        if not self._channel(chat_id):
            self._nonchannel_messages[message.id] = chat_id

    def _read_state(self, chat_id: int, dialog) -> None:
        self._outbox_max[chat_id] = max(self._outbox_max.get(chat_id, 0), dialog.read_outbox_max_id)
        self._inbox_max[chat_id] = max(self._inbox_max.get(chat_id, 0), dialog.read_inbox_max_id)
        self._read_loaded.add(chat_id)

    def _dialog(self, entity, record, message) -> Dialog:
        chat_id = utils.get_peer_id(record.peer)
        self._peers[chat_id] = utils.get_input_peer(entity)
        self._avatar_entities[chat_id] = entity
        self._avatar_dirty.discard(chat_id)
        self._read_state(chat_id, record)
        if message is not None:
            self._remember(message, chat_id)
        return Dialog(
            chat_id, "Saved Messages" if self._me and chat_id == self._me.id else self._titles.get(chat_id, _name(entity)),
            record.unread_count, _text(message) if message else "",
            _writable(entity), record.top_message or None,
            "saved" if self._me and chat_id == self._me.id else
            "bot" if getattr(entity, "bot", False) else
            "channel" if getattr(entity, "broadcast", False) else
            "group" if isinstance(entity, (types.Chat, types.ChatForbidden, types.Channel, types.ChannelForbidden)) else "user",
            _presence(getattr(entity, "status", None)) if isinstance(entity, types.User) else None,
        )

    def _dialog_records(self, result) -> list[Dialog]:
        entities = {utils.get_peer_id(entity): entity for entity in (*result.users, *result.chats)}
        messages = {
            (utils.get_peer_id(message.peer_id), message.id): message
            for message in result.messages if not isinstance(message, types.MessageEmpty)
        }
        return [
            self._dialog(entities[utils.get_peer_id(record.peer)], record,
                         messages.get((utils.get_peer_id(record.peer), record.top_message)))
            for record in result.dialogs if utils.get_peer_id(record.peer) in entities
        ]

    async def dialogs(self, cursor: dict | None = None, limit: int = 60) -> dict:
        async with _protected():
            if type(limit) is not int or not 1 <= limit <= 100:
                raise ClientError("Chat pages must contain between 1 and 100 chats.")
            client = self._connected()
            self._me = self._me or await client.get_me()
            if self._me is None:
                raise ClientError("Sign in to your Telegram account first.")
            saved_id = self._me.id
            self._peers[saved_id] = utils.get_input_peer(self._me)
            offset_date, offset_id, offset_peer = None, 0, types.InputPeerEmpty()
            if cursor is not None:
                if not isinstance(cursor, dict) or type(cursor.get("date")) is not int or type(cursor.get("id")) is not int or cursor["id"] < 0:
                    raise ClientError("This chat page is invalid.")
                offset_date = datetime.fromtimestamp(cursor["date"], timezone.utc) if cursor["date"] else None
                offset_id = cursor["id"]
                offset_peer = await self._peer(cursor.get("peer_id"))
            result = []
            last = last_message = None
            async for dialog in client.iter_dialogs(
                limit=limit, offset_date=offset_date, offset_id=offset_id,
                offset_peer=offset_peer, ignore_pinned=cursor is not None,
            ):
                result.append(self._dialog(dialog.entity, dialog.dialog, dialog.message))
                last = dialog
                if dialog.message is not None:
                    last_message = dialog.message
            next_cursor = None
            if len(result) == limit and last is not None:
                next_cursor = {
                    "date": int(last_message.date.timestamp()) if last_message else 0,
                    "id": last_message.id if last_message else 0, "peer_id": last.id,
                }
            if cursor is None and not any(dialog.id == saved_id for dialog in result):
                result.insert(0, Dialog(saved_id, "Saved Messages", 0, "", True, None, "saved"))
            return {"dialogs": result, "cursor": next_cursor}

    async def dialog(self, chat_id: int) -> Dialog | None:
        async with _protected():
            peer = await self._peer(chat_id)
            try:
                result = await self._connected()(functions.messages.GetPeerDialogsRequest([types.InputDialogPeer(peer)]))
            except (errors.ChannelPrivateError, errors.PeerIdInvalidError, errors.ChatIdInvalidError):
                return None
            return next((dialog for dialog in self._dialog_records(result) if dialog.id == chat_id), None)

    async def chat_info(self, chat_id: int, refresh: bool = False) -> dict:
        async with _protected():
            self._validate_chat_id(chat_id)
            if type(refresh) is not bool:
                raise ClientError("Choose whether to refresh chat information.")
            real_id, kind = utils.resolve_id(chat_id)
            if kind is types.PeerUser:
                return {"participants_count": None}
            async with self._info_locks.setdefault(chat_id, asyncio.Lock()):
                if refresh:
                    self._chat_info.pop(chat_id, None)
                while chat_id not in self._chat_info:
                    version = self._metadata_versions.get(chat_id, 0)
                    peer = await self._peer(chat_id)
                    try:
                        if kind is types.PeerChannel:
                            result = await self._connected()(functions.channels.GetFullChannelRequest(utils.get_input_channel(peer)))
                            count = getattr(result.full_chat, "participants_count", None)
                        else:
                            result = await self._connected()(functions.messages.GetFullChatRequest(real_id))
                            entity = next((chat for chat in result.chats if utils.get_peer_id(chat) == chat_id), None)
                            count = getattr(entity, "participants_count", None)
                            participants = getattr(getattr(result.full_chat, "participants", None), "participants", None)
                            if count is None and participants is not None:
                                count = len(participants)
                    except (errors.ChannelPrivateError, errors.ChatAdminRequiredError):
                        if version != self._metadata_versions.get(chat_id, 0):
                            continue
                        self._full_chats.pop(chat_id, None)
                        self._chat_info[chat_id] = {"participants_count": None}
                        return dict(self._chat_info[chat_id])
                    if version != self._metadata_versions.get(chat_id, 0):
                        continue  # An update superseded the full-info response while it was in flight.
                    for entity in getattr(result, "chats", ()):
                        entity_id = utils.get_peer_id(entity)
                        if entity_id in self._titles:
                            entity.title = self._titles[entity_id]
                        self._avatar_entities[entity_id] = entity
                        self._avatar_dirty.discard(entity_id)
                    self._full_chats[chat_id] = result.full_chat
                    self._chat_info[chat_id] = {"participants_count": count if type(count) is int and count >= 0 else None}
                return dict(self._chat_info[chat_id])

    async def message_readers(self, chat_id: int, message_id: int) -> int | None:
        async with _protected():
            self._validate_chat_id(chat_id)
            self._validate_message_id(message_id)
            if utils.resolve_id(chat_id)[1] is types.PeerUser:
                return None
            info = await self.chat_info(chat_id)
            entity = self._avatar_entities.get(chat_id)
            if self._channel(chat_id) and not getattr(entity, "megagroup", False):
                return None
            full = self._full_chats.get(chat_id)
            if getattr(full, "participants_hidden", False) or getattr(entity, "monoforum", False):
                return None
            if self._readers is None:
                self._readers = ReadParticipants(self._connected())
            if not await self._readers.supports_size(info["participants_count"]):
                return None
            peer, messages = await self._existing(chat_id, [message_id])
            message = messages[0]
            if not message.out:
                return None
            return await self._readers.count(peer, message, info["participants_count"])

    async def _message(self, message, chat_id: int) -> ChatMessage:
        self._remember(message, chat_id)
        sender = getattr(message, "sender", None)
        if not message.out and sender is None:
            try:
                sender = await message.get_sender()
            except Exception:
                pass  # An unavailable sender must not discard the message.
        sender_name = "You" if message.out else (
            _name(sender) if sender is not None else getattr(message, "post_author", None) or "Unknown sender"
        )
        forward = getattr(message, "forward", None)
        forwarded = None
        if getattr(message, "fwd_from", None) is not None:
            forwarded = getattr(message.fwd_from, "from_name", None)
            if not forwarded and forward is not None:
                source = forward.sender or forward.chat
                if source is None:
                    try:
                        source = await forward.get_sender() or await forward.get_chat()
                    except Exception:
                        pass
                forwarded = _name(source)
            forwarded = forwarded or "Unknown sender"
        reply = getattr(message, "reply_to", None)
        maxima = self._outbox_max if message.out else self._inbox_max
        sender_id = utils.get_peer_id(sender) if sender is not None else getattr(message, "sender_id", None)
        if sender_id is None and message.out and self._me is not None:
            sender_id = self._me.id
        if sender_id is not None:
            avatar_entity = sender if sender is not None else self._me if message.out else None
            if avatar_entity is not None:
                # Min sender objects still contain valid profile-photo access information; a bare ID may not resolve.
                self._avatar_entities[sender_id] = avatar_entity
                if sender_id in self._avatar_dirty:
                    self._avatar_dirty.discard(sender_id)
                    await self.on_event({
                        "kind": "dialog_changed", "chat_id": sender_id, "avatar_changed": True,
                        "title": "Saved Messages" if self._me is not None and sender_id == self._me.id else self._titles.get(sender_id, _name(avatar_entity)),
                    })
        media, _ = _image_media(message)
        return ChatMessage(
            message.id, chat_id, sender_name, _text(message),
            message.date.astimezone().strftime("%Y-%m-%d %H:%M"), bool(message.out),
            getattr(reply, "reply_to_msg_id", None), bool(getattr(message, "edit_date", None)),
            media is not None, forwarded,
            message.id <= maxima.get(chat_id, 0),
            str(message.grouped_id) if getattr(message, "grouped_id", None) is not None else None,
            sender_id, display_markdown(_text(message), getattr(message, "entities", None)),
            str(media.id) if media is not None else None,
        )

    async def history(self, chat_id: int, before_id: int = 0, limit: int = 50) -> list[ChatMessage]:
        async with _protected():
            if type(limit) is not int or limit <= 0 or type(before_id) is not int or before_id < 0:
                raise ClientError("The history page size must be positive and the message offset cannot be negative.")
            client = self._connected()
            peer = await self._peer(chat_id)
            if chat_id not in self._read_loaded:
                result = await client(functions.messages.GetPeerDialogsRequest([types.InputDialogPeer(peer)]))
                for dialog in result.dialogs:
                    if utils.get_peer_id(dialog.peer) == chat_id:
                        self._read_state(chat_id, dialog)
            messages = await client.get_messages(peer, limit=limit, offset_id=before_id)
            return [await self._message(message, chat_id) for message in reversed(messages) if not isinstance(message, types.MessageEmpty)]

    @staticmethod
    def _compose(text: str):
        if not isinstance(text, str):
            raise ClientError("Enter a text message.")
        text, entities = parse_markdown(text)
        if not text.strip():
            raise ClientError("Enter a message before sending or editing.")
        if len(text.encode("utf-16-le")) // 2 > 4096:
            raise ClientError("Messages cannot exceed 4096 UTF-16 characters. Nothing was sent or truncated.")
        return text, entities

    async def _existing(self, chat_id: int, message_ids: list[int]):
        if not isinstance(message_ids, list) or not message_ids:
            raise ClientError("Select at least one message.")
        for message_id in message_ids:
            self._validate_message_id(message_id)
        if len(set(message_ids)) != len(message_ids):
            raise ClientError("Select each message only once.")
        peer = await self._peer(chat_id)
        messages = await self._connected().get_messages(peer, ids=message_ids)
        # Private/small-group message IDs are account-wide, even with a peer.
        if len(messages) != len(message_ids) or any(
            message is None or isinstance(message, types.MessageEmpty) or message.chat_id != chat_id
            or message.id != expected for message, expected in zip(messages, message_ids)
        ):
            raise ClientError("A selected message is no longer available in this chat.")
        for message in messages:
            self._remember(message, chat_id)
        return peer, messages

    async def _album(self, chat_id: int, peer, message) -> list:
        group = getattr(message, "grouped_id", None)
        if group is None:
            return [message]
        members = {message.id: message}
        # Telegram albums are contiguous in peer history, not in account-wide IDs.
        # Read through a different group or the history end in both directions.
        for reverse in (False, True):
            async for neighbor in self._connected().iter_messages(
                peer, offset_id=message.id, reverse=reverse, limit=11,
            ):
                if neighbor is None or isinstance(neighbor, types.MessageEmpty) or neighbor.chat_id != chat_id:
                    raise ClientError("The complete album is unavailable in this chat. Nothing was changed.")
                if getattr(neighbor, "grouped_id", None) != group:
                    break
                members[neighbor.id] = neighbor
                if len(members) > 10:
                    raise ClientError("The complete album could not be resolved. Nothing was changed.")
        return [members[key] for key in sorted(members)]

    async def album(self, chat_id: int, message_id: int) -> list[ChatMessage]:
        async with _protected():
            peer, messages = await self._existing(chat_id, [message_id])
            return [await self._message(member, chat_id) for member in await self._album(chat_id, peer, messages[0])]

    async def _expanded(self, chat_id: int, message_ids: list[int]):
        if not isinstance(message_ids, list) or not message_ids:
            raise ClientError("Select at least one message.")
        for message_id in message_ids:
            self._validate_message_id(message_id)
        peer, messages = await self._existing(chat_id, list(dict.fromkeys(message_ids)))
        expanded = {}
        groups = set()
        for message in messages:
            group = getattr(message, "grouped_id", None)
            if group is not None and group in groups:
                continue
            for member in await self._album(chat_id, peer, message):
                expanded[member.id] = member
            if group is not None:
                groups.add(group)
        return peer, list(expanded)

    async def send(self, chat_id: int, text: str, reply_to: int | None, random_id: str) -> ChatMessage:
        async with _protected():
            await self.typing(chat_id, False)
            random_id = self._random_id(random_id)
            text, entities = self._compose(text)
            peer = await self._peer(chat_id)
            if reply_to is not None:
                await self._existing(chat_id, [reply_to])
            client = self._connected()
            request = functions.messages.SendMessageRequest(
                peer=peer, message=text, random_id=random_id, entities=entities,
                no_webpage=True,
                reply_to=types.InputReplyToMessage(reply_to) if reply_to is not None else None,
            )
            result = await client(request)
            if isinstance(result, types.UpdateShortSentMessage):
                real_id, peer_type = utils.resolve_id(chat_id)
                message = types.Message(
                    id=result.id, peer_id=peer_type(real_id), message=text,
                    date=result.date, out=result.out, media=result.media,
                    entities=result.entities, ttl_period=result.ttl_period,
                    reply_to=types.MessageReplyHeader(reply_to_msg_id=reply_to) if reply_to is not None else None,
                )
                message._finish_init(client, {}, peer)
            else:
                message = client._get_response_message(request, result, peer)
            if message is None:
                raise ClientError("Telegram did not confirm the message. Check the chat before retrying.")
            return await self._message(message, chat_id)

    async def edit(self, chat_id: int, message_id: int, text: str) -> ChatMessage:
        async with _protected():
            await self.typing(chat_id, False)
            text, entities = self._compose(text)
            peer, _ = await self._existing(chat_id, [message_id])
            message = await self._connected().edit_message(peer, message_id, text, parse_mode=None, formatting_entities=entities, link_preview=False)
            if message is None:
                raise ClientError("Telegram did not confirm the edit. Check the chat before retrying.")
            return await self._message(message, chat_id)

    async def delete(self, chat_id: int, message_ids: list[int]) -> None:
        async with _protected():
            peer, message_ids = await self._expanded(chat_id, message_ids)
            await self._connected().delete_messages(peer, message_ids, revoke=True)
            if not self._channel(chat_id):
                for message_id in message_ids:
                    self._nonchannel_messages.pop(message_id, None)
            await self.on_event({"kind": "delete", "chat_id": chat_id, "ids": message_ids})

    async def forward(self, chat_id: int, message_ids: list[int], destination_id: int) -> list[ChatMessage]:
        async with _protected():
            peer, message_ids = await self._expanded(chat_id, message_ids)
            destination = await self._peer(destination_id)
            messages = await self._connected().forward_messages(destination, message_ids, from_peer=peer)
            if len(messages) != len(message_ids) or any(message is None for message in messages):
                raise ClientError("Telegram did not confirm the complete forward. Check the destination chat before retrying.")
            return [await self._message(message, destination_id) for message in messages]

    async def mark_read(self, chat_id: int, max_id: int) -> None:
        async with _protected():
            self._validate_message_id(max_id)
            peer = await self._peer(chat_id)
            if max_id <= self._inbox_max.get(chat_id, 0):
                return
            # MTProto Bool is not an RPC success flag. Desktop accepts the completed request even when it is false.
            await self._connected().send_read_acknowledge(peer, max_id=max_id)
            self._inbox_max[chat_id] = max(self._inbox_max.get(chat_id, 0), max_id)
            await self.on_event({"kind": "read", "chat_id": chat_id, "max_id": max_id, "outbox": False})

    async def photo(self, chat_id: int, message_id: int, preview: bool = False) -> dict | None:
        async with _protected():
            if type(preview) is not bool:
                raise ClientError("Choose a photo or its preview.")
            _, messages = await self._existing(chat_id, [message_id])
            message = messages[0]
            media, mime = _image_media(message)
            if media is None:
                raise ClientError("This message does not contain a supported photo or image document.")
            if isinstance(media, types.Photo):
                sizes = _dimensioned(media.sizes)
                if not sizes:
                    raise ClientError("Telegram does not have a viewable size for this photo.")
                size = _preview_size(sizes) if preview else sizes[-1]
            else:
                size = _preview_size(media.thumbs) if preview else None
                if size is None and preview:
                    return None  # Originals download only when the user opens them, regardless of file size.
            width = height = 0
            thumb = None
            if size is not None:
                # Telegram photo sizes and document thumbnails are JPEG.
                width, height, thumb, mime = size.w, size.h, size.type, "image/jpeg"
            else:
                for attribute in media.attributes:
                    if isinstance(attribute, types.DocumentAttributeImageSize):
                        width, height = attribute.w, attribute.h
                        break
            # No filesystem path: downloads and base64 exist only for this RPC.
            data = await self._connected().download_media(message, file=bytes, thumb=thumb)
            if not isinstance(data, bytes) or not data:
                raise ClientError("Telegram did not return this image.")
            if width <= 0 or height <= 0:
                width, height = _image_dimensions(data, mime)
            if width <= 0 or height <= 0:
                raise ClientError("This image has invalid dimensions.")
            return {"data": base64.b64encode(data).decode("ascii"), "mime": mime, "width": width, "height": height}

    async def avatar(self, sender_id: int) -> dict | None:
        async with _protected():
            self._validate_chat_id(sender_id)
            entity = self._avatar_entities.get(sender_id)
            if entity is None:
                return None  # Unknown/deleted senders have no available profile metadata; the UI keeps their initials.
            data = await self._connected().download_profile_photo(entity, file=bytes, download_big=False)
            if data is None:
                return None
            if not isinstance(data, bytes) or not data:
                raise ClientError("Telegram did not return this avatar.")
            width, height = _image_dimensions(data, "image/jpeg")
            return {"data": base64.b64encode(data).decode("ascii"), "mime": "image/jpeg", "width": width, "height": height}

    async def _dialog_changed(
        self, chat_id: int, *, title: str | None = None,
        participants_changed: bool = False, avatar_changed: bool = False, invalidate_title: bool = False,
        permissions_changed: bool = False,
    ) -> None:
        self._metadata_versions[chat_id] = self._metadata_versions.get(chat_id, 0) + 1
        self._chat_info.pop(chat_id, None)
        self._full_chats.pop(chat_id, None)
        update = {"kind": "dialog_changed", "chat_id": chat_id}
        if title is not None:
            if self._me is not None and chat_id == self._me.id:
                title = "Saved Messages"
            self._titles[chat_id] = title
            entity = self._avatar_entities.get(chat_id)
            if entity is not None and not isinstance(entity, types.User):
                entity.title = title
            update["title"] = title
        elif invalidate_title:
            self._titles.pop(chat_id, None)
        if participants_changed:
            update["participants_changed"] = True
        if permissions_changed:
            update["permissions_changed"] = True
        if avatar_changed:
            self._avatar_entities.pop(chat_id, None)
            self._avatar_dirty.add(chat_id)
            update["avatar_changed"] = True
        await self.on_event(update)

    async def _metadata_update(self, update) -> None:
        if isinstance(update, types.UpdateConfig):
            if self._readers is not None:
                self._readers.invalidate_config()
            return
        if isinstance(update, (types.UpdateNewMessage, types.UpdateNewChannelMessage)):
            if isinstance(update.message, types.MessageService):
                await self._service_metadata(utils.get_peer_id(update.message.peer_id), update.message)
            return
        if isinstance(update, types.UpdateChatDefaultBannedRights):
            await self._dialog_changed(utils.get_peer_id(update.peer), permissions_changed=True)
            return
        if not isinstance(update, _METADATA_UPDATES):
            return
        if isinstance(update, (types.UpdateUser, types.UpdateUserName)):
            chat_id = utils.get_peer_id(types.PeerUser(update.user_id))
            title = None
            if isinstance(update, types.UpdateUserName):
                username = next((name.username for name in update.usernames if name.active), None)
                entity = self._avatar_entities.get(chat_id)
                if isinstance(entity, types.User):
                    entity.first_name, entity.last_name = update.first_name, update.last_name
                    entity.username = username
                title = _name(types.User(id=update.user_id, first_name=update.first_name,
                                         last_name=update.last_name, username=username))
            await self._dialog_changed(chat_id, title=title, avatar_changed=isinstance(update, types.UpdateUser),
                                       invalidate_title=isinstance(update, types.UpdateUser))
            return
        if hasattr(update, "channel_id"):
            chat_id = utils.get_peer_id(types.PeerChannel(update.channel_id))
        else:
            real_id = update.participants.chat_id if isinstance(update, types.UpdateChatParticipants) else update.chat_id
            chat_id = utils.get_peer_id(types.PeerChat(real_id))
        generic = isinstance(update, (types.UpdateChat, types.UpdateChannel, types.UpdateChannelTooLong))
        own_change = self._me is not None and getattr(update, "user_id", None) == self._me.id
        await self._dialog_changed(chat_id, participants_changed=True, avatar_changed=generic,
                                   invalidate_title=generic, permissions_changed=generic or own_change)

    async def _service_metadata(self, chat_id: int, message) -> None:
        action = getattr(message, "action", None)
        if isinstance(action, (types.MessageActionChatEditTitle, types.MessageActionChatCreate, types.MessageActionChannelCreate)):
            await self._dialog_changed(chat_id, title=action.title, permissions_changed=not isinstance(action, types.MessageActionChatEditTitle))
        elif isinstance(action, (types.MessageActionChatEditPhoto, types.MessageActionChatDeletePhoto)):
            await self._dialog_changed(chat_id, avatar_changed=True)
        elif isinstance(action, (
            types.MessageActionChatAddUser, types.MessageActionChatDeleteUser,
            types.MessageActionChatJoinedByLink, types.MessageActionChatJoinedByRequest,
            types.MessageActionChatJoinedViaCommunity,
            types.MessageActionChatMigrateTo, types.MessageActionChannelMigrateFrom,
        )):
            own_change = self._me is not None and (
                self._me.id in getattr(action, "users", ())
                or self._me.id == getattr(action, "user_id", None)
                or self._me.id == getattr(message, "sender_id", None)
            )
            await self._dialog_changed(chat_id, participants_changed=True, permissions_changed=own_change)

    async def _update(self, event) -> None:
        chat_id = event.chat_id or 0
        try:
            if isinstance(event, events.MessageDeleted.Event):
                grouped: dict[int, list[int]] = {}
                for message_id in event.deleted_ids:
                    origin = chat_id or self._nonchannel_messages.pop(message_id, 0)
                    if not self._channel(origin):
                        self._nonchannel_messages.pop(message_id, None)
                    grouped.setdefault(origin, []).append(message_id)
                for origin, ids in grouped.items():
                    await self.on_event({"kind": "delete", "chat_id": origin, "ids": ids})
            elif isinstance(event, events.MessageRead.Event):
                if event.contents or not chat_id or event.max_id is None:
                    return
                maxima = self._outbox_max if event.outbox else self._inbox_max
                maxima[chat_id] = max(maxima.get(chat_id, 0), event.max_id)
                await self.on_event({"kind": "read", "chat_id": chat_id, "max_id": maxima[chat_id], "outbox": event.outbox})
            elif chat_id and getattr(event, "message", None) is not None:
                peer = getattr(event, "input_chat", None)
                if peer is not None and not isinstance(peer, types.InputPeerSelf) and utils.get_peer_id(peer) == chat_id:
                    self._peers[chat_id] = peer
                await self._service_metadata(chat_id, event.message)
                await self.on_event({"kind": "message", "chat_id": chat_id, "message": await self._message(event.message, chat_id)})
        except Exception:
            logging.getLogger("terngram").error("A Telegram update could not be displayed; refresh is required.")
            await self.on_event({"kind": "refresh", "chat_id": chat_id})

    async def _activity_rpc(self, method: str, request) -> bool:
        now = asyncio.get_running_loop().time()
        if now < self._activity_waits.get(method, 0) or not self._last_connection or self._me is None:
            return False
        epoch = self._activity_epoch
        try:
            result = await asyncio.wait_for(self._connected()(request), timeout=5)
            if epoch != self._activity_epoch:
                return False
            if result is False:
                self._activity_waits[method] = asyncio.get_running_loop().time() + 5
                return False
            return True
        except Exception as exc:
            if epoch != self._activity_epoch:
                return False
            # Transient signals are best effort, never an error toast per keystroke.
            seconds = retry_after(exc)
            self._activity_waits[method] = asyncio.get_running_loop().time() + (seconds if seconds is not None else 5)
            return False

    async def _own_status(self, online: bool) -> None:
        now = asyncio.get_running_loop().time()
        if online == self._own_online and (not online or now - self._status_sent < 55):
            return
        # Remember ambiguous online sends too, so idle/close still sends offline.
        if online and now >= self._activity_waits.get("status", 0) and self._last_connection and self._me is not None:
            self._own_online = True
        if await self._activity_rpc("status", functions.account.UpdateStatusRequest(offline=not online)):
            self._own_online = online
            self._status_sent = now

    async def activity(self) -> None:
        # Host focus is unavailable: observed keyboard/native input, not exact foreground state.
        async with self._activity_lock:
            self._last_activity = asyncio.get_running_loop().time()
            await self._own_status(True)

    async def _cancel_typing(self) -> None:
        peer_id, self._typing_peer = self._typing_peer, None
        if peer_id is not None and peer_id in self._peers:
            await self._activity_rpc("typing", functions.messages.SetTypingRequest(
                self._peers[peer_id], types.SendMessageCancelAction()))

    async def select_peer(self, chat_id: int | None) -> None:
        if chat_id is not None:
            self._validate_chat_id(chat_id)
            if chat_id not in self._avatar_entities or chat_id not in self._peers:
                raise ClientError("Choose a loaded conversation first.")
        async with self._activity_lock:
            if chat_id != self._selected_peer:
                await self._cancel_typing()
                self._selected_peer = chat_id

    async def typing(self, chat_id: int, active: bool) -> None:
        self._validate_chat_id(chat_id)
        if type(active) is not bool:
            raise ClientError("Typing activity must be a boolean.")
        async with self._activity_lock:
            if not active:
                if self._typing_peer == chat_id:
                    await self._cancel_typing()
                return
            entity = self._avatar_entities.get(chat_id)
            if chat_id != self._selected_peer or entity is None or not _writable(entity):
                raise ClientError("Typing requires the selected writable conversation.")
            if self._me is None:
                return
            now = asyncio.get_running_loop().time()
            if now - self._typing_sent.get(chat_id, -10) < 4:
                return
            self._typing_sent[chat_id] = now
            # Even an ambiguous timeout may have reached the server; cancel it on stop.
            self._typing_peer = chat_id
            await self._activity_rpc("typing", functions.messages.SetTypingRequest(
                self._peers[chat_id], types.SendMessageTypingAction()))

    async def _activity_update(self, update) -> None:
        if self._me is None:
            return
        if isinstance(update, types.UpdateUserStatus):
            entity = self._avatar_entities.get(update.user_id)
            if isinstance(entity, types.User):
                entity.status = update.status
            await self.on_event({"kind": "presence", "chat_id": update.user_id, "presence": _presence(update.status)})
            return
        if isinstance(update, types.UpdateUserTyping):
            sender_id = chat_id = update.user_id
        elif isinstance(update, types.UpdateChatUserTyping):
            sender_id = update.from_id if type(update.from_id) is int else utils.get_peer_id(update.from_id)
            chat_id = utils.get_peer_id(types.PeerChat(update.chat_id))
        else:
            sender_id = utils.get_peer_id(update.from_id)
            chat_id = utils.get_peer_id(types.PeerChannel(update.channel_id))
        if sender_id == self._me.id:
            return
        entity = getattr(update, "_entities", {}).get(sender_id) or self._avatar_entities.get(sender_id)
        action = type(update.action).__name__
        await self.on_event({"kind": "typing", "chat_id": chat_id, "sender_id": sender_id,
                             "sender": _name(entity) if entity else f"User {sender_id}",
                             "action": action, "expires_in": 6})

    def _clear_account(self) -> None:
        self._activity_epoch += 1
        self._selected_peer = self._typing_peer = None
        self._typing_sent.clear()
        self._activity_waits.clear()
        self._last_activity = None
        self._status_sent = 0.0
        self._own_online = False
        self._phone = self._code_hash = None
        self._me = None
        self._peers.clear()
        self._avatar_entities.clear()
        self._avatar_dirty.clear()
        self._nonchannel_messages.clear()
        self._outbox_max.clear()
        self._inbox_max.clear()
        self._read_loaded.clear()
        self._chat_info.clear()
        self._full_chats.clear()
        self._metadata_versions.clear()
        self._info_locks.clear()
        self._titles.clear()
        self._readers = None

    async def logout(self) -> None:
        async with _protected():
            client = self._connected()
            async with self._activity_lock:
                await self._cancel_typing()
                await self._own_status(False)
            if not await client.log_out():
                raise ClientError("Telegram did not confirm session revocation. Try logging out again.")
            self._client = None
            await self._stop_connection_watch()
            self._clear_account()
            (self.data_dir / "state.json").unlink(missing_ok=True)
            for suffix in ("", "-journal", "-wal", "-shm"):
                (self.data_dir / f"account.session{suffix}").unlink(missing_ok=True)
            await self._connection_status()

    async def close(self) -> None:
        async with _protected():
            await self._stop_connection_watch()
            async with self._activity_lock:
                await self._cancel_typing()
                await self._own_status(False)
            if self._client is not None:
                await self._client.disconnect()
                self._client = None
            self._clear_account()
            await self._connection_status()
