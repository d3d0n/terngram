import asyncio
import time
from collections.abc import Callable

from telethon import errors, functions, types


class ReadParticipants:
    """On-demand group read lists; unknown or unsupported is never a fabricated zero."""

    def __init__(self, client, *, now: Callable[[], float] = time.time):
        self._client = client
        self._now = now
        self._config_lock = asyncio.Lock()
        self._config_until = 0.0
        self._config_hash = 0
        self._config_generation = 0
        # Match Desktop's conservative fallback; runtime appConfig is authoritative (commonly 100).
        self._max_count = 50
        self._expire_period = 7 * 86400

    def invalidate_config(self):
        self._config_until = 0.0
        self._config_generation += 1

    async def _config(self):
        if self._now() < self._config_until:
            return
        async with self._config_lock:
            if self._now() < self._config_until:
                return
            generation = self._config_generation
            try:
                result = await self._client(functions.help.GetAppConfigRequest(hash=self._config_hash))
            except errors.BadRequestError:
                # The config API specifies defaults (or cached values) for RPC failures.
                pass
            else:
                if isinstance(result, types.help.AppConfig):
                    values = {
                        item.key: item.value.value
                        for item in result.config.value
                        if isinstance(item.value, types.JsonNumber)
                    }
                    self._max_count = int(values.get("chat_read_mark_size_threshold", 50))
                    self._expire_period = int(values.get("chat_read_mark_expire_period", 7 * 86400))
                    self._config_hash = result.hash
            self._config_until = self._now() + 3600 if generation == self._config_generation else 0.0

    async def supports_size(self, participant_count: int | None) -> bool:
        if participant_count is None or participant_count <= 0:
            return False
        await self._config()
        return participant_count <= self._max_count

    async def count(self, peer, message, participant_count: int | None) -> int | None:
        if (
            not message.out or message.id <= 0 or message.date is None
            or getattr(message, "action", None) is not None
            or getattr(message, "post", False)
            or not isinstance(peer, (types.InputPeerChat, types.InputPeerChannel))
            or (isinstance(peer, types.InputPeerChannel) and not message.is_group)
            or participant_count is None or participant_count <= 0
        ):
            return None
        chat = getattr(message, "chat", None)
        if getattr(chat, "participants_hidden", False) or getattr(chat, "monoforum", False):
            return None
        # Desktop's WhoReadExists accepts the maximum itself and rejects unknown/zero size.
        if not await self.supports_size(participant_count) or message.date.timestamp() + self._expire_period <= self._now():
            return None
        try:
            participants = await self._client(functions.messages.GetMessageReadParticipantsRequest(
                peer=peer, msg_id=message.id,
            ))
        except (errors.ChatTooBigError, errors.MsgTooOldError, errors.MsgIdInvalidError, errors.PeerIdInvalidError):
            return None
        # Desktop displays the returned vector unchanged, including any self entry.
        return len(participants)
