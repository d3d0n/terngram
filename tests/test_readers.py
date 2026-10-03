import asyncio
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from telethon import errors, functions, types

from terngram.readers import ReadParticipants


NOW = 1_800_000_000


def message(**fields):
    values = dict(id=9, out=True, date=datetime.fromtimestamp(NOW - 10, timezone.utc),
                  action=None, post=False, is_group=True, chat=None)
    values.update(fields)
    return SimpleNamespace(**values)


def config(hash=7, **values):
    return types.help.AppConfig(hash=hash, config=types.JsonObject([
        types.JsonObjectValue(key=key, value=types.JsonNumber(value))
        for key, value in values.items()
    ]))


class ReadParticipantsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = [NOW]
        self.calls = []
        self.configuration = config(chat_read_mark_size_threshold=100, chat_read_mark_expire_period=60)
        self.participants = [types.ReadParticipantDate(user_id=1, date=NOW), types.ReadParticipantDate(user_id=2, date=NOW)]
        self.config_error = None
        self.query_error = None

        async def client(request):
            self.calls.append(request)
            if isinstance(request, functions.help.GetAppConfigRequest):
                if self.config_error:
                    raise self.config_error
                return self.configuration
            if self.query_error:
                raise self.query_error
            return self.participants

        self.client = client
        self.readers = ReadParticipants(client, now=lambda: self.clock[0])
        self.peer = types.InputPeerChat(7)

    def requests(self, kind):
        return [request for request in self.calls if isinstance(request, kind)]

    async def test_actual_list_cardinality_not_outbox_read_or_sender_inference(self):
        self.assertEqual(await self.readers.count(self.peer, message(read=False, sender_id=1), 3), 2)
        self.participants = []
        self.assertEqual(await self.readers.count(self.peer, message(read=True), 3), 0)
        request = self.requests(functions.messages.GetMessageReadParticipantsRequest)[0]
        self.assertEqual((request.peer, request.msg_id), (self.peer, 9))
        self.assertEqual(len(self.requests(functions.help.GetAppConfigRequest)), 1)

    async def test_minimum_size_unknown_and_inclusive_maximum_follow_desktop(self):
        for count in (None, 0, -1):
            self.assertIsNone(await self.readers.count(self.peer, message(), count))
        self.assertEqual(self.calls, [])
        for count in (1, 99, 100):
            self.assertEqual(await self.readers.count(self.peer, message(), count), 2)
        self.assertIsNone(await self.readers.count(self.peer, message(), 101))
        self.assertEqual(len(self.requests(functions.messages.GetMessageReadParticipantsRequest)), 3)

    async def test_runtime_config_not_hardcoded_hundred_and_exact_expiry(self):
        self.configuration = config(chat_read_mark_size_threshold=150, chat_read_mark_expire_period=20)
        self.assertEqual(await self.readers.count(self.peer, message(), 120), 2)
        self.assertIsNone(await self.readers.count(self.peer, message(), 151))
        self.clock[0] += 10
        self.assertIsNone(await self.readers.count(self.peer, message(), 120))
        self.assertEqual(len(self.requests(functions.messages.GetMessageReadParticipantsRequest)), 1)

    async def test_unsupported_messages_make_no_requests(self):
        cases = [
            (types.InputPeerUser(7, 8), message()),
            (types.InputPeerSelf(), message()),
            (self.peer, message(out=False)),
            (self.peer, message(id=0)),
            (self.peer, message(date=None)),
            (self.peer, message(action=object())),
            (types.InputPeerChannel(7, 8), message(is_group=False)),
            (types.InputPeerChannel(7, 8), message(post=True)),
            (types.InputPeerChannel(7, 8), message(chat=SimpleNamespace(participants_hidden=True))),
            (types.InputPeerChannel(7, 8), message(chat=SimpleNamespace(monoforum=True))),
        ]
        for peer, item in cases:
            self.assertIsNone(await self.readers.count(peer, item, 3))
        self.assertEqual(self.calls, [])

    async def test_supergroup_and_real_telethon_basic_group_message_supported(self):
        self.assertEqual(await self.readers.count(types.InputPeerChannel(7, 8), message(), 3), 2)
        item = types.Message(id=10, peer_id=types.PeerChat(7), from_id=types.PeerUser(1),
                             out=True, date=datetime.fromtimestamp(NOW, timezone.utc), message="Hello")
        self.assertEqual(await self.readers.count(self.peer, item, 3), 2)

    async def test_documented_unavailable_results_are_unknown_not_zero(self):
        for kind in (errors.ChatTooBigError, errors.MsgTooOldError, errors.MsgIdInvalidError, errors.PeerIdInvalidError):
            self.query_error = kind(request=None)
            self.assertIsNone(await self.readers.count(self.peer, message(), 3))

    async def test_reader_floodwait_and_network_failures_propagate(self):
        for error in (errors.FloodWaitError(request=None, capture=45), OSError("offline"),
                      errors.ServerError(request=None, message="server", code=500)):
            self.query_error = error
            with self.assertRaises(type(error)):
                await self.readers.count(self.peer, message(), 3)

    async def test_configuration_floodwait_and_network_failures_propagate_without_cache(self):
        for error in (errors.FloodWaitError(request=None, capture=45), errors.SlowModeWaitError(request=None, capture=45),
                      OSError("offline"), errors.ServerError(request=None, message="server", code=500)):
            self.config_error = error
            with self.assertRaises(type(error)):
                await self.readers.count(self.peer, message(), 3)
        self.config_error = None
        self.assertEqual(await self.readers.count(self.peer, message(), 3), 2)
        self.assertEqual(len(self.requests(functions.help.GetAppConfigRequest)), 5)

    async def test_missing_config_and_bad_request_still_allow_small_eligible_groups(self):
        for response, error in ((config(), None), (None, errors.BadRequestError(request=None, message="invalid", code=400))):
            self.configuration, self.config_error = response, error
            readers = ReadParticipants(self.client, now=lambda: NOW)
            self.assertEqual(await readers.count(self.peer, message(), 3), 2)

    async def test_config_hash_notmodified_hourly_refresh_and_update_invalidation(self):
        await self.readers.count(self.peer, message(), 3)
        self.clock[0] += 3599
        await self.readers.count(self.peer, message(date=datetime.fromtimestamp(self.clock[0], timezone.utc)), 3)
        self.assertEqual(len(self.requests(functions.help.GetAppConfigRequest)), 1)
        self.clock[0] += 1
        self.configuration = types.help.AppConfigNotModified()
        await self.readers.count(self.peer, message(date=datetime.fromtimestamp(self.clock[0], timezone.utc)), 3)
        self.assertEqual([call.hash for call in self.requests(functions.help.GetAppConfigRequest)], [0, 7])
        self.readers.invalidate_config()
        self.configuration = config(hash=8, chat_read_mark_size_threshold=2)
        self.assertIsNone(await self.readers.count(self.peer, message(date=datetime.fromtimestamp(self.clock[0], timezone.utc)), 3))
        self.assertEqual([call.hash for call in self.requests(functions.help.GetAppConfigRequest)], [0, 7, 7])

    async def test_config_fetch_singleflight_and_invalidation_during_fetch(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def client(request):
            calls.append(request)
            if isinstance(request, functions.help.GetAppConfigRequest):
                entered.set()
                await release.wait()
                return self.configuration
            return []

        readers = ReadParticipants(client, now=lambda: NOW)
        first = asyncio.create_task(readers.count(self.peer, message(), 3))
        await entered.wait()
        second = asyncio.create_task(readers.count(self.peer, message(), 3))
        release.set()
        self.assertEqual(await asyncio.gather(first, second), [0, 0])
        self.assertEqual(sum(isinstance(call, functions.help.GetAppConfigRequest) for call in calls), 1)
        readers.invalidate_config()
        release.clear()
        entered.clear()
        third = asyncio.create_task(readers.count(self.peer, message(), 3))
        await entered.wait()
        readers.invalidate_config()
        release.set()
        await third
        await readers.count(self.peer, message(), 3)
        self.assertEqual(sum(isinstance(call, functions.help.GetAppConfigRequest) for call in calls), 3)
