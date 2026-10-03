import asyncio
import tempfile
import unittest
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from telethon import errors, functions, types, utils

from terngram.telegram import ClientError, TelegramService


class TelegramActivityTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.updates = []

        async def updated(event):
            self.updates.append(event)

        self.service = TelegramService(Path(temporary.name) / "private", updated)
        self.client = AsyncMock(return_value=True)
        self.client.is_connected = Mock(return_value=True)
        self.client._sender = SimpleNamespace(
            _reconnecting=False, _connection=SimpleNamespace(_connected=True),
        )
        self.service._client = self.client
        self.service._me = types.User(id=99, first_name="Me")
        self.service._last_connection = True
        self.cache(types.User(id=123, access_hash=456, first_name="Alice"))
        self.cache(types.User(id=124, access_hash=457, first_name="Bob"))
        self.now = 1000.0
        loop = asyncio.get_running_loop()
        self.addCleanup(loop.set_debug, loop.get_debug())
        # Advancing the fake clock is not elapsed task execution time.
        loop.set_debug(False)
        clock = patch.object(loop, "time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def cache(self, entity):
        chat_id = utils.get_peer_id(entity)
        self.service._avatar_entities[chat_id] = entity
        self.service._peers[chat_id] = utils.get_input_peer(entity)
        return chat_id

    def requests(self):
        return [call.args[0] for call in self.client.await_args_list]

    async def test_typing_only_targets_selected_loaded_writable_peer(self):
        await self.service.select_peer(123)
        with self.assertRaises(ClientError):
            await self.service.typing(124, True)
        with self.assertRaises(ClientError):
            await self.service.select_peer(125)
        channel_id = self.cache(types.Channel(
            id=7, access_hash=77, title="Announcements", broadcast=True,
            photo=types.ChatPhotoEmpty(), date=datetime.now(timezone.utc),
        ))
        await self.service.select_peer(channel_id)
        with self.assertRaises(ClientError):
            await self.service.typing(channel_id, True)
        self.client.assert_not_awaited()
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        request, = self.requests()
        self.assertIsInstance(request, functions.messages.SetTypingRequest)
        self.assertEqual(utils.get_peer_id(request.peer), 123)
        self.assertIsInstance(request.action, types.SendMessageTypingAction)
        self.client.get_input_entity.assert_not_awaited()

    async def test_invalid_chat_and_active_values_never_send(self):
        await self.service.select_peer(123)
        for chat_id in (True, 0, "123", None, 2**53):
            with self.subTest(chat_id=chat_id):
                with self.assertRaises(ClientError):
                    await self.service.typing(chat_id, True)
        for active in (1, 0, "true", None):
            with self.subTest(active=active):
                with self.assertRaises(ClientError):
                    await self.service.typing(123, active)
        self.client.assert_not_awaited()

    async def test_typing_cadence_cancel_and_selection_change(self):
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        for elapsed in (0, 1, 3.99):
            self.now = 1000 + elapsed
            await self.service.typing(123, True)
        self.assertEqual(len(self.requests()), 1)
        self.now = 1004
        await self.service.typing(123, True)
        self.assertEqual(len(self.requests()), 2)
        await self.service.typing(124, False)
        self.assertEqual(len(self.requests()), 2)
        await self.service.select_peer(124)
        await self.service.select_peer(124)
        await self.service.typing(124, True)
        await self.service.typing(124, False)
        await self.service.typing(124, False)
        await self.service.select_peer(None)
        requests = self.requests()
        self.assertEqual([utils.get_peer_id(request.peer) for request in requests],
                         [123, 123, 123, 124, 124])
        self.assertEqual([type(request.action) for request in requests], [
            types.SendMessageTypingAction, types.SendMessageTypingAction,
            types.SendMessageCancelAction, types.SendMessageTypingAction,
            types.SendMessageCancelAction,
        ])

    async def test_flood_wait_blocks_typing_until_server_deadline(self):
        await self.service.select_peer(123)
        self.client.side_effect = errors.FloodWaitError(request=None, capture=12)
        await self.service.typing(123, True)
        self.client.side_effect = None
        for now in (1004, 1008):
            self.now = now
            await self.service.typing(123, True)
        self.assertEqual(len(self.requests()), 1)
        self.now = 1012
        await self.service.typing(123, True)
        self.assertEqual(len(self.requests()), 2)
        self.assertIsInstance(self.requests()[-1].action, types.SendMessageTypingAction)

    async def test_presence_preserves_privacy_in_updates_and_dialogs(self):
        exact = datetime(2026, 10, 3, tzinfo=timezone.utc)
        cases = [
            (types.UserStatusOnline(exact), {"state": "online", "expires": int(exact.timestamp())}),
            (types.UserStatusOffline(exact), {"state": "offline", "was_online": int(exact.timestamp())}),
            (types.UserStatusRecently(), {"state": "recently"}),
            (types.UserStatusLastWeek(), {"state": "last_week"}),
            (types.UserStatusLastMonth(), {"state": "last_month"}),
            (types.UserStatusEmpty(), {"state": "unknown"}),
        ]
        record = SimpleNamespace(peer=types.PeerUser(123), read_outbox_max_id=0,
                                 read_inbox_max_id=0, unread_count=0, top_message=0)
        for status, expected in cases:
            with self.subTest(status=type(status).__name__):
                await self.service._activity_update(types.UpdateUserStatus(123, status))
                self.assertEqual(self.updates[-1], {
                    "kind": "presence", "chat_id": 123, "presence": expected,
                })
                dialog = self.service._dialog(self.service._avatar_entities[123], record, None)
                self.assertEqual(asdict(dialog)["presence"], expected)

    async def test_incoming_typing_routes_private_basic_and_channel_peers(self):
        channel_id = utils.get_peer_id(types.PeerChannel(7))
        updates = [
            (types.UpdateUserTyping(user_id=123, action=types.SendMessageTypingAction()), 123),
            (types.UpdateChatUserTyping(chat_id=7, from_id=types.PeerUser(123),
                                        action=types.SendMessageTypingAction()), -7),
            (types.UpdateChannelUserTyping(channel_id=7, from_id=types.PeerUser(123),
                                           action=types.SendMessageTypingAction(), top_msg_id=None), channel_id),
        ]
        for update, chat_id in updates:
            await self.service._activity_update(update)
            self.assertEqual(self.updates[-1], {
                "kind": "typing", "chat_id": chat_id, "sender_id": 123,
                "sender": "Alice", "action": "SendMessageTypingAction", "expires_in": 6,
            })
        await self.service._activity_update(types.UpdateUserTyping(
            user_id=123, action=types.SendMessageCancelAction()))
        self.assertEqual(self.updates[-1]["action"], "SendMessageCancelAction")
        self.assertEqual(self.updates[-1]["chat_id"], 123)

    async def test_incoming_own_typing_is_excluded_in_every_peer_kind(self):
        updates = [
            types.UpdateUserTyping(user_id=99, action=types.SendMessageTypingAction()),
            types.UpdateChatUserTyping(chat_id=7, from_id=types.PeerUser(99),
                                       action=types.SendMessageTypingAction()),
            types.UpdateChannelUserTyping(channel_id=7, from_id=types.PeerUser(99),
                                          action=types.SendMessageTypingAction(), top_msg_id=None),
        ]
        for update in updates:
            await self.service._activity_update(update)
        self.assertEqual(self.updates, [])

    async def test_observed_activity_refreshes_online_without_request_spam(self):
        await self.service.activity()
        self.now += 54.99
        await self.service.activity()
        self.assertEqual(len(self.requests()), 1)
        self.now = 1055
        await self.service.activity()
        self.assertEqual(len(self.requests()), 2)
        self.assertTrue(all(isinstance(request, functions.account.UpdateStatusRequest)
                            and not request.offline for request in self.requests()))

    async def test_connection_watch_marks_idle_offline_without_real_sleep(self):
        await self.service.activity()

        async def stop_watch(_delay):
            raise asyncio.CancelledError

        for now, expected_count in ((1059, 2), (1060, 3), (1061, 3)):
            self.now = now
            with patch("terngram.telegram.asyncio.sleep", side_effect=stop_watch):
                with self.assertRaises(asyncio.CancelledError):
                    await self.service._watch_connection()
            self.assertEqual(len(self.requests()), expected_count)
        self.assertIsInstance(self.requests()[-1], functions.account.UpdateStatusRequest)
        self.assertTrue(self.requests()[-1].offline)

    async def test_account_clear_and_disconnect_discard_own_typing(self):
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        self.client.is_connected.return_value = False
        await self.service._connection_status()
        await self.service.typing(123, False)
        self.assertEqual(len(self.requests()), 1)
        self.service._clear_account()
        await self.service._activity_update(types.UpdateUserTyping(
            user_id=123, action=types.SendMessageTypingAction()))
        self.assertEqual(self.updates, [])
        with self.assertRaises(ClientError):
            await self.service.typing(123, True)

    async def test_old_account_flood_response_cannot_suppress_new_account(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed_request(_request):
            started.set()
            await release.wait()
            raise errors.FloodWaitError(request=None, capture=120)

        await self.service.select_peer(123)
        self.client.side_effect = delayed_request
        pending = asyncio.create_task(self.service.typing(123, True))
        self.addAsyncCleanup(self.cancel_pending, pending)
        await started.wait()
        self.service._clear_account()
        old_client = self.client
        self.client = AsyncMock(return_value=True)
        self.client.is_connected = Mock(return_value=True)
        self.client._sender = SimpleNamespace(
            _reconnecting=False, _connection=SimpleNamespace(_connected=True),
        )
        self.service._client = self.client
        self.service._me = types.User(id=199, first_name="New account")
        await self.service._connection_status()
        self.cache(types.User(id=123, access_hash=999, first_name="Alice"))
        release.set()
        await pending
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        requests = [call.args[0] for call in old_client.await_args_list] + self.requests()
        self.assertEqual(len(requests), 2)
        old_client.assert_awaited_once()
        self.client.assert_awaited_once()
        self.assertTrue(self.service._last_connection)
        self.assertEqual(requests[0].peer.access_hash, 456)
        self.assertEqual(requests[-1].peer.access_hash, 999)

    async def cancel_pending(self, task):
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
