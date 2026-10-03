import asyncio
from unittest.mock import patch

from terngram.tdlib import TDLibError
from terngram.telegram import ClientError
from test_telegram import FakeTDLib, ServiceTestCase, chat, user


class TelegramActivityTest(ServiceTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.now = 1000.0
        self.clock = patch("terngram.telegram.monotonic", side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        await self.client.update("updateNewChat", chat=chat(124, "Bob", type={"@type": "chatTypePrivate", "user_id": 43}))
        await self.client.update("updateUser", user=user(43, "Bob"))
        self.updates.clear()

    async def test_typing_requires_selected_writable_chat_and_valid_inputs(self):
        await self.service.select_peer(123)
        for chat_id in (124, True, 0, "123", None, 2**53):
            with self.subTest(chat_id=chat_id), self.assertRaises(ClientError):
                await self.service.typing(chat_id, True)
        for active in (1, 0, "true", None):
            with self.subTest(active=active), self.assertRaises(ClientError):
                await self.service.typing(123, active)
        await self.group(supergroup=True, channel=True)
        await self.service.select_peer(-7)
        with self.assertRaises(ClientError):
            await self.service.typing(-7, True)
        self.assertEqual(self.client.requests("sendChatAction"), [])
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        request, = self.client.requests("sendChatAction")
        self.assertEqual((request["chat_id"], request["action"]), (123, {"@type": "chatActionTyping"}))

    async def test_cadence_cancel_and_selection_manage_native_open_chat(self):
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        for elapsed in (0, 1, 3.99):
            self.now = 1000 + elapsed
            await self.service.typing(123, True)
        self.assertEqual(len(self.client.requests("sendChatAction")), 1)
        self.now = 1004
        await self.service.typing(123, True)
        await self.service.typing(124, False)
        await self.service.select_peer(124)
        await self.service.select_peer(124)
        await self.service.typing(124, True)
        await self.service.typing(124, False)
        await self.service.typing(124, False)
        await self.service.select_peer(None)
        requests = self.client.requests("sendChatAction")
        self.assertEqual([query["chat_id"] for query in requests], [123, 123, 123, 124, 124])
        self.assertEqual([query["action"]["@type"] for query in requests], ["chatActionTyping", "chatActionTyping", "chatActionCancel", "chatActionTyping", "chatActionCancel"])
        self.assertEqual([query["chat_id"] for query in self.client.requests("openChat")], [123, 124])
        self.assertEqual([query["chat_id"] for query in self.client.requests("closeChat")], [123, 124])

    async def test_server_cooldown_suppresses_requests_until_deadline(self):
        await self.service.select_peer(123)
        self.client.handlers["sendChatAction"] = TDLibError(429, "retry after 12")
        await self.service.typing(123, True)
        self.client.handlers["sendChatAction"] = {"@type": "ok"}
        for now in (1004, 1008):
            self.now = now
            await self.service.typing(123, True)
        self.assertEqual(len(self.client.requests("sendChatAction")), 1)
        self.now = 1012
        await self.service.typing(123, True)
        self.assertEqual(len(self.client.requests("sendChatAction")), 2)

    async def test_presence_privacy_is_preserved_in_events_and_dialogs(self):
        cases = [("userStatusOnline", {"expires": 1800000000}, {"state": "online", "expires": 1800000000}),
                 ("userStatusOffline", {"was_online": 1799999999}, {"state": "offline", "was_online": 1799999999}),
                 ("userStatusRecently", {"by_my_privacy_settings": True}, {"state": "recently"}),
                 ("userStatusLastWeek", {"by_my_privacy_settings": True}, {"state": "last_week"}),
                 ("userStatusLastMonth", {"by_my_privacy_settings": False}, {"state": "last_month"}),
                 ("userStatusEmpty", {}, {"state": "unknown"})]
        for kind, fields, expected in cases:
            with self.subTest(status=kind):
                await self.client.update("updateUserStatus", user_id=42, status={"@type": kind, **fields})
                self.assertEqual(self.updates[-1], {"kind": "presence", "chat_id": 123, "presence": expected})
                self.assertEqual((await self.service.dialog(123)).presence, expected)

    async def test_incoming_actions_route_chat_ids_and_exclude_own_activity(self):
        for action in ("chatActionTyping", "chatActionCancel"):
            for chat_id in (123, -7, -1001234567890):
                with self.subTest(action=action, chat_id=chat_id):
                    count = len(self.updates)
                    await self.client.update("updateChatAction", chat_id=chat_id, topic_id=None, sender_id={"@type": "messageSenderUser", "user_id": 42}, action={"@type": action})
                    self.assertEqual(len(self.updates), count + 1)
                    event = self.updates[-1]
                    self.assertEqual(event["kind"], "typing")
                    self.assertEqual(event["chat_id"], chat_id)
                    self.assertEqual((event["sender_id"], event["sender"]), (42, "Alice"))
                    await self.client.update("updateChatAction", chat_id=chat_id, topic_id=None, sender_id={"@type": "messageSenderUser", "user_id": 99}, action={"@type": action})
                    self.assertEqual(len(self.updates), count + 1)

    async def test_idle_offline_and_online_refresh_without_wall_clock_sleep(self):
        await self.service.activity()
        self.now = 1059
        await self.service.activity()
        self.assertEqual(len(self.client.requests("setOption")), 1)

        async def stop_watch(_delay):
            raise asyncio.CancelledError

        for now, count in ((1118, 1), (1119, 2), (1120, 2)):
            self.now = now
            with patch("terngram.telegram.asyncio.sleep", side_effect=stop_watch):
                with self.assertRaises(asyncio.CancelledError):
                    await self.service._watch_activity()
            self.assertEqual(len(self.client.requests("setOption")), count)
        self.assertFalse(self.client.requests("setOption")[-1]["value"]["value"])
        await self.service.activity()
        self.assertTrue(self.client.requests("setOption")[-1]["value"]["value"])

    async def test_disconnect_drops_typing_and_presence_without_cancel_rpc(self):
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        await self.service.activity()
        await self.client.update("updateConnectionState", state={"@type": "connectionStateConnecting"})
        await self.service.typing(123, False)
        self.assertEqual(len(self.client.requests("sendChatAction")), 1)
        self.assertEqual(self.connections, [False])
        await self.client.update("updateConnectionState", state={"@type": "connectionStateReady"})
        self.assertEqual(self.connections, [False, True])
        self.now += 4
        await self.service.typing(123, True)
        self.assertEqual(len(self.client.requests("sendChatAction")), 2)

    async def test_old_account_cooldown_cannot_suppress_new_account(self):
        entered, release = asyncio.Event(), asyncio.Event()
        old_client = self.client
        async def delayed(query):
            if query["action"]["@type"] == "chatActionCancel":
                return {"@type": "ok"}
            entered.set()
            await release.wait()
            raise TDLibError(429, "retry after 120")
        old_client.handlers["sendChatAction"] = delayed
        await self.service.select_peer(123)
        pending = asyncio.create_task(self.service.typing(123, True))
        self.addAsyncCleanup(self.cancel_pending, pending)
        await entered.wait()
        await self.service.close()
        self.client = FakeTDLib(self.service._update)
        self.client.handlers["openChat"] = {"@type": "ok"}
        self.client.handlers["closeChat"] = {"@type": "ok"}
        self.client.handlers["sendChatAction"] = {"@type": "ok"}
        self.client.handlers["setOption"] = {"@type": "ok"}
        self.service._client = self.client
        self.service._authorization = {"state": "ready"}
        self.service._me = user(199, "New account")
        await self.client.update("updateConnectionState", state={"@type": "connectionStateReady"})
        await self.client.update("updateUser", user=user())
        await self.client.update("updateNewChat", chat=chat())
        release.set()
        await pending
        await self.service.select_peer(123)
        await self.service.typing(123, True)
        self.assertEqual(len(self.client.requests("sendChatAction")), 1)
        self.assertEqual(self.client.requests("sendChatAction")[0]["action"], {"@type": "chatActionTyping"})

    async def cancel_pending(self, task):
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
