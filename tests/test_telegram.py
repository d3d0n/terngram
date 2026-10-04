import asyncio
import base64
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from terngram.tdlib import TDLibError
from terngram.telegram import ClientError, TelegramService, _protected, retry_after, retry_scope
from terngram.worker import serve


class CredentialSecurityTest(unittest.TestCase):
    def test_credentials_remain_private_and_symlinks_are_rejected(self):
        async def event(_update):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private = root / "private"
            private.mkdir(mode=0o777)
            os.chmod(private, 0o777)
            service = TelegramService(private, event)
            service._store_private("credentials.json", {"api_id": 12345, "api_hash": "a" * 32})
            credentials = private / "credentials.json"
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(credentials.stat().st_mode), 0o600)
            self.assertEqual(service._load_credentials(), (12345, "a" * 32))
            outside = root / "outside.json"
            credentials.rename(outside)
            os.chmod(outside, 0o644)
            credentials.symlink_to(outside)
            with self.assertRaises(ClientError) as raised:
                service.has_credentials()
            self.assertNotIn(str(outside), str(raised.exception))
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o644)

    def test_private_directory_symlink_is_rejected_without_changing_target(self):
        async def event(_update):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside"
            outside.mkdir()
            outside.chmod(0o755)
            (root / "private").symlink_to(outside, target_is_directory=True)
            service = TelegramService(root / "private", event)
            with self.assertRaises(ClientError):
                service._store_private("credentials.json", {"api_id": 12345, "api_hash": "a" * 32})
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o755)
            self.assertEqual(list(outside.iterdir()), [])

    def test_diagnostics_preserve_operation_and_cause_not_values_or_locals(self):
        async def event(_update):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            service = TelegramService(Path(temporary), event)
            secret = "tg://login?token=private-token-and-message"
            try:
                try:
                    raise OSError(secret)
                except OSError as cause:
                    raise ClientError("Safe public error") from cause
            except ClientError as error:
                code = service.record_error("send", error)
            record = json.loads((Path(temporary) / "tdlib/last-error.json").read_text())
            self.assertEqual(record["operation"], "send")
            self.assertEqual(record["kind"], "OSError")
            self.assertTrue(record["frames"])
            self.assertNotIn(secret, json.dumps(record))
            self.assertNotIn(secret, code)
            self.assertEqual(stat.S_IMODE((Path(temporary) / "tdlib/last-error.json").stat().st_mode), 0o600)


class WorkerConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def run_worker(self, service_type, lines, finish, emitted):
        requests = iter(lines)

        async def input_line(_readline):
            try:
                return next(requests)
            except StopIteration:
                await finish.wait()
                return ""

        with patch("terngram.worker.TelegramService", service_type), patch("terngram.worker.emit", side_effect=emitted.append), patch("terngram.worker.asyncio.to_thread", side_effect=input_line):
            await serve(Path("/unused-test-directory"))

    async def test_updates_and_send_flow_while_history_blocks_but_auth_is_exclusive(self):
        started, release, complete = asyncio.Event(), asyncio.Event(), asyncio.Event()
        emitted = []
        history_finished = False

        class Service:
            def __init__(self, _directory, updated, _connection):
                self.updated = updated

            async def history(self, _chat_id):
                nonlocal history_finished
                started.set()
                await release.wait()
                history_finished = True
                return []

            async def send(self, _chat_id, _text, _reply_to, _token):
                await started.wait()
                await self.updated({"kind": "read", "chat_id": 123, "max_id": 2**40, "outbox": True})
                release.set()
                return {"id": -1, "sending_state": "pending"}

            async def request_qr(self):
                if not history_finished:
                    raise AssertionError("Authentication raced an in-flight request")
                complete.set()
                return {"state": "qr"}

            async def close(self):
                pass

        await self.run_worker(Service, [
            '{"id":1,"method":"history","args":[123]}\n',
            '{"id":2,"method":"send","args":[123,"Hello",null,"123456"]}\n',
            '{"id":3,"method":"request_qr","args":[]}\n',
        ], complete, emitted)
        self.assertEqual(emitted[0], {"event": "update", "kind": "read", "chat_id": 123, "max_id": 2**40, "outbox": True})
        self.assertEqual([item["id"] for item in emitted if "id" in item], [2, 1, 3])
        self.assertEqual(emitted[-1]["result"], {"state": "qr"})

    async def test_stdio_eof_cancels_pending_requests_before_close(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        emitted = []
        closed = False

        class Service:
            def __init__(self, *_args):
                pass

            async def history(self, _chat_id):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

            async def close(self):
                nonlocal closed
                if not cancelled.is_set():
                    raise AssertionError("Service closed before cancellation")
                closed = True

        await self.run_worker(Service, ['{"id":1,"method":"history","args":[123]}\n'], started, emitted)
        self.assertTrue(closed)
        self.assertEqual(emitted, [])

    async def test_phone_login_methods_are_rejected_before_dispatch(self):
        complete = asyncio.Event()
        emitted = []

        class Service:
            def __init__(self, *_args):
                pass

            async def close(self):
                pass

        complete.set()
        await self.run_worker(Service, [json.dumps({"id": index, "method": method, "args": ["private-phone"]}) + "\n" for index, method in enumerate(("request_code", "sign_in_code"), 1)], complete, emitted)
        self.assertEqual(len(emitted), 2)
        self.assertTrue(all("error" in item for item in emitted))
        self.assertNotIn("private-phone", json.dumps(emitted))

    async def test_server_wait_metadata_reaches_wire_without_private_rpc_values(self):
        complete = asyncio.Event()
        emitted = []

        class Service:
            def __init__(self, *_args):
                pass

            async def history(self, _chat_id):
                async with _protected():
                    raise TDLibError(429, "retry after 23 private-rpc-input")

            def record_error(self, _method, _error):
                complete.set()
                return "TDLibError"

            async def close(self):
                pass

        await self.run_worker(Service, ['{"id":1,"method":"history","args":[123]}\n'], complete, emitted)
        self.assertEqual(emitted[0]["retry_after"], 23)
        self.assertEqual(emitted[0]["retry_scope"], "method")
        self.assertNotIn("private-rpc-input", json.dumps(emitted))

    async def test_media_changed_reaches_wire_after_update_without_recording_error(self):
        complete = asyncio.Event()
        emitted = []

        class Service:
            def __init__(self, _directory, updated, _connection):
                self.updated = updated

            async def photo(self, chat_id, message_id):
                await self.updated({"kind": "delete", "chat_id": chat_id, "ids": [message_id]})
                complete.set()
                raise ClientError("Media changed", code="MEDIA_CHANGED")

            def record_error(self, *_args):
                raise AssertionError("Expected media invalidation is not a diagnostic failure")

            async def close(self):
                pass

        await self.run_worker(Service, ['{"id":1,"method":"photo","args":[123,1099511627776]}\n'], complete, emitted)
        self.assertEqual(emitted[0], {"event": "update", "kind": "delete", "chat_id": 123, "ids": [2**40]})
        self.assertEqual(emitted[1]["error_code"], "MEDIA_CHANGED")


def user(user_id=42, name="Alice", **fields):
    return {"@type": "user", "id": user_id, "first_name": name, "last_name": "",
            "type": {"@type": "userTypeRegular"}, "status": {"@type": "userStatusEmpty"}, **fields}


def chat(chat_id=123, title="Alice", **fields):
    return {"@type": "chat", "id": chat_id, "title": title,
            "type": {"@type": "chatTypePrivate", "user_id": 42},
            "permissions": {"@type": "chatPermissions", "can_send_basic_messages": True},
            "positions": [], "unread_count": 0, "last_read_inbox_message_id": 0,
            "last_read_outbox_message_id": 0, **fields}


def message(message_id=2**40, chat_id=123, outgoing=False, **fields):
    return {"@type": "message", "id": message_id, "chat_id": chat_id,
            "sender_id": {"@type": "messageSenderUser", "user_id": 42},
            "is_outgoing": outgoing, "date": 1_800_000_000, "edit_date": 0,
            "media_album_id": "0", "sending_state": None,
            "content": {"@type": "messageText", "text": {"@type": "formattedText", "text": "Hello", "entities": []}},
            **fields}


def failed_message(message_id=2**40, chat_id=123, outgoing=True, state_fields=None, **fields):
    return message(message_id, chat_id, outgoing,
                   sending_state={"@type": "messageSendingStateFailed", "can_retry": True,
                                  "retry_after": 0, "error": {"code": 500, "message": "failure"},
                                  **(state_fields or {})}, **fields)


class FakeTDLib:
    """Only the TDLib JSON transport is replaced; unknown RPCs fail loudly."""

    def __init__(self, on_update):
        self.on_update = on_update
        self.calls = []
        self.handlers = {}
        self.started = False
        self.closed = False

    async def start(self):
        self.started = True

    async def close(self):
        self.closed = True

    async def request(self, query):
        self.calls.append(query)
        kind = query["@type"]
        if kind not in self.handlers:
            raise AssertionError(f"Unexpected TDLib request: {kind}")
        handler = self.handlers[kind]
        result = handler(query) if callable(handler) else handler
        if isinstance(result, Exception):
            raise result
        if hasattr(result, "__await__"):
            result = await result
        return result

    async def update(self, kind, **fields):
        await self.on_update({"@type": kind, **fields})

    def requests(self, kind):
        return [query for query in self.calls if query["@type"] == kind]


class ServiceTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.updates = []
        self.connections = []

        async def updated(event):
            self.updates.append(event)

        async def connected(value):
            self.connections.append(value)

        self.service = TelegramService(self.root / "private", updated, connected)
        self.client = FakeTDLib(self.service._update)
        self.service._client = self.client
        self.service._authorization = {"state": "ready"}
        self.service._me = user(99, "Me")
        self.service._last_connection = True
        for kind in ("openChat", "closeChat", "sendChatAction", "setOption", "openMessageContent", "viewMessages", "deleteMessages"):
            self.client.handlers[kind] = {"@type": "ok"}
        await self.client.update("updateUser", user=user())
        await self.client.update("updateUser", user=user(99, "Me"))
        await self.client.update("updateNewChat", chat=chat())
        self.updates.clear()
        self.addAsyncCleanup(self.service.close)

    async def restart_service(self, data_dir=None):
        previous = self.service
        await previous.close()
        self.service = TelegramService(data_dir or previous.data_dir, previous.on_event, previous.on_connection)
        client = FakeTDLib(self.service._update)
        client.handlers = dict(self.client.handlers)
        client.calls = self.client.calls
        self.client = client
        self.service._client = client
        self.service._authorization = {"state": "ready"}
        self.service._me = user(99, "Me")
        self.service._last_connection = True
        await client.update("updateUser", user=user())
        await client.update("updateUser", user=user(99, "Me"))
        await client.update("updateNewChat", chat=chat())
        self.addAsyncCleanup(self.service.close)


    async def group(self, chat_id=-7, supergroup=False, channel=False):
        kind = {"@type": "chatTypeSupergroup", "supergroup_id": 7, "is_channel": channel} if supergroup else {"@type": "chatTypeBasicGroup", "basic_group_id": 7}
        await self.client.update("updateNewChat", chat=chat(chat_id, "Group", type=kind))
        await self.client.update("updateSupergroup" if supergroup else "updateBasicGroup", **{"supergroup" if supergroup else "basic_group": {"@type": "supergroup" if supergroup else "basicGroup", "id": 7, "member_count": 3, "is_active": True, "status": {"@type": "chatMemberStatusMember"}}})


class TelegramBehaviorTest(ServiceTestCase):
    async def test_history_fills_short_native_pages_with_int53_ids_and_actual_read_maxima(self):
        ids = [2**40 + 30, 2**40 + 20, 2**40 + 10]
        pages = iter([[message(ids[0], outgoing=True)], [message(ids[1], outgoing=True)], [message(ids[2])]])
        self.client.handlers["getChatHistory"] = lambda _query: {"@type": "messages", "messages": next(pages)}
        await self.client.update("updateChatReadOutbox", chat_id=123, last_read_outbox_message_id=ids[1])
        records = await self.service.history(123, limit=3)
        self.assertEqual([record.id for record in records], ids[::-1])
        self.assertEqual([record.read for record in records], [False, True, False])
        self.assertEqual([query["from_message_id"] for query in self.client.requests("getChatHistory")], [0, ids[0], ids[1]])

    async def test_invalid_ids_are_rejected_before_message_rpc(self):
        for value in (True, 0, -1, "9", None, 2**53):
            with self.subTest(message_id=value), self.assertRaises(ClientError):
                await self.service.mark_read(123, value)
        for value in (True, 0, "123", None, 2**53):
            with self.subTest(chat_id=value), self.assertRaises(ClientError):
                await self.service.history(value)
        self.assertEqual(self.client.calls, [])

    async def test_foreign_message_cannot_be_deleted_replied_to_or_read(self):
        self.client.handlers["getMessages"] = {"@type": "messages", "messages": [message(chat_id=777)]}
        intent = await self.service.prepare_send(123, "Hello", 2**40)
        for operation in (lambda: self.service.delete(123, [2**40]), lambda: self.service.send(123, "Hello", 2**40, intent["token"]), lambda: self.service.mark_read(123, 2**40)):
            with self.assertRaises(ClientError):
                await operation()
        self.assertFalse(self.client.requests("deleteMessages"))
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("viewMessages"))

    async def test_live_metadata_reply_forward_and_edits_keep_real_ids(self):
        item = message(reply_to={"@type": "messageReplyToMessage", "chat_id": 123, "message_id": 2**39},
                       forward_info={"origin": {"@type": "messageOriginHiddenUser", "sender_name": "Forwarded Alice"}}, edit_date=1)
        await self.client.update("updateNewMessage", message=item)
        record = self.updates[-1]["message"]
        self.assertEqual((record.sender, record.sender_id, record.reply_to, record.forwarded, record.edited), ("Alice", 42, 2**39, "Forwarded Alice", True))
        await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageText", "text": {"text": "Edited", "entities": []}})
        self.assertEqual(self.updates[-1]["message"].text, "Edited")

    async def test_history_response_cannot_restore_deleted_or_overwrite_edited_message(self):
        await self.client.update("updateNewMessage", message=message())
        async def delayed(_query):
            await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageText", "text": {"text": "New", "entities": []}})
            return {"@type": "messages", "messages": [message()]}
        self.client.handlers["getChatHistory"] = delayed
        self.assertEqual((await self.service.history(123, limit=1))[0].text, "New")
        async def deleted(query):
            await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[2**40], is_permanent=True, from_cache=False)
            return {"@type": "messages", "messages": [message()] if query["from_message_id"] == 0 else []}
        self.client.handlers["getChatHistory"] = deleted
        self.assertEqual(await self.service.history(123, limit=1), [])

    async def test_chat_title_membership_and_write_rights_follow_ordered_updates(self):
        await self.group()
        await self.client.update("updateChatTitle", chat_id=-7, title="Renamed")
        self.client.handlers["getBasicGroupFullInfo"] = {"@type": "basicGroupFullInfo", "members": [{}, {}, {}]}
        self.assertEqual(await self.service.chat_info(-7), {"participants_count": 3})
        await self.client.update("updateBasicGroup", basic_group={"id": 7, "status": {"@type": "chatMemberStatusLeft"}})
        record = await self.service.dialog(-7)
        self.assertEqual(record.title, "Renamed")
        self.assertFalse(record.writable)
        intent = await self.service.prepare_send(-7, "No", None)
        with self.assertRaises(ClientError):
            await self.service.send(-7, "No", None, intent["token"])
        self.assertFalse(self.client.requests("sendMessage"))

    async def test_fresh_full_group_update_supersedes_inflight_metadata(self):
        await self.group(supergroup=True)
        async def stale(_query):
            await self.client.update("updateSupergroupFullInfo", supergroup_id=7, supergroup_full_info={"member_count": 9})
            return {"member_count": 2}
        self.client.handlers["getSupergroupFullInfo"] = stale
        self.assertEqual(await self.service.chat_info(-7), {"participants_count": 9})
        for count in (0, None):
            await self.client.update("updateSupergroupFullInfo", supergroup_id=7, supergroup_full_info={"member_count": count})
            self.assertEqual(await self.service.chat_info(-7), {"participants_count": count})

    async def test_mark_read_never_claims_read_until_native_update(self):
        self.client.handlers["getMessages"] = {"@type": "messages", "messages": [message()]}
        await self.service.mark_read(123, 2**40)
        self.assertFalse((await self.service._message(message())).read)
        self.assertEqual(self.client.requests("viewMessages")[0]["message_ids"], [2**40])
        await self.client.update("updateChatReadInbox", chat_id=123, last_read_inbox_message_id=2**40, unread_count=0)
        self.assertTrue((await self.service._message(message())).read)
        self.client.handlers["viewMessages"] = OSError("private-network-input")
        with self.assertRaises(ClientError) as raised:
            await self.service.mark_read(123, 2**40)
        self.assertNotIn("private-network-input", str(raised.exception))

    async def test_readers_use_native_eligibility_and_actual_list_cardinality(self):
        self.client.handlers["getMessages"] = {"@type": "messages", "messages": [message(outgoing=True)]}
        self.client.handlers["getMessageProperties"] = {"@type": "messageProperties", "can_get_viewers": False}
        self.assertIsNone(await self.service.message_readers(123, 2**40))
        self.assertFalse(self.client.requests("getMessageViewers"))
        self.client.handlers["getMessageProperties"] = {"@type": "messageProperties", "can_get_viewers": True}
        for viewers, expected in (([{"user_id": 1}, {"user_id": 2}], 2), ([], 0)):
            self.client.handlers["getMessageViewers"] = {"@type": "messageViewers", "viewers": viewers}
            self.assertEqual(await self.service.message_readers(123, 2**40), expected)
        self.assertEqual(self.client.requests("getMessageViewers")[-1], {"@type": "getMessageViewers", "chat_id": 123, "message_id": 2**40})

    async def test_unavailable_readers_are_unknown_but_network_and_cooldown_propagate(self):
        self.client.handlers["getMessages"] = {"@type": "messages", "messages": [message(outgoing=True)]}
        self.client.handlers["getMessageProperties"] = {"can_get_viewers": True}
        for code in (400, 403, 404):
            self.client.handlers["getMessageViewers"] = TDLibError(code, "private-input")
            self.assertIsNone(await self.service.message_readers(123, 2**40))
        for error in (OSError("private-input"), TDLibError(429, "retry after 45 private-input")):
            self.client.handlers["getMessageViewers"] = error
            with self.assertRaises(ClientError) as raised:
                await self.service.message_readers(123, 2**40)
            self.assertNotIn("private-input", str(raised.exception))
            if isinstance(error, TDLibError):
                self.assertEqual(retry_after(raised.exception), 45)

    async def test_state_migrates_only_text_and_is_atomic_private_and_validated(self):
        legacy = {"drafts": {"123": "Draft"}, "selected_id": 123, "pending_sends": {"456": {"text": "Unsent", "reply_to": 7, "random_id": "100"}}}
        self.service._store_private("state.json", legacy)
        state = await self.service.load_state()
        self.assertEqual(state, {"drafts": {"123": "Draft", "456": "Unsent"}, "selected_id": None, "pending_sends": {}})
        pending = await self.service.prepare_send(123, "Hello", 2**40)
        self.client.handlers["getMessages"] = {"messages": [message()]}
        self.client.handlers["getMessageProperties"] = {"can_be_replied": True}
        self.client.handlers["sendMessage"] = OSError("offline")
        with self.assertRaises(ClientError):
            await self.service.send(123, "Hello", 2**40, pending["token"])
        pending = (await self.service.load_state())["pending_sends"]["123"]
        state = {"drafts": {"123": "Updated"}, "selected_id": 123, "pending_sends": {"123": pending}}
        await self.service.save_state({**state, "history": ["secret-history"]})
        file = self.service.data_dir / "tdlib/state.json"
        self.assertEqual(await self.service.load_state(), state)
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertNotIn("secret-history", file.read_text())
        self.assertEqual(json.loads((self.service.data_dir / "state.json").read_text()), legacy)
        for invalid in ({**pending, "token": "0"}, {**pending, "reply_to": 2**53}, {**pending, "status": "sent"}):
            with self.assertRaises(ClientError):
                await self.service.save_state({**state, "pending_sends": {"123": invalid}})
        with patch("terngram.telegram.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(ClientError):
                await self.service.save_state({**state, "drafts": {"123": "Lost"}})
        self.assertEqual(await self.service.load_state(), state)
        self.assertEqual(list(file.parent.glob("private-*")), [])


class TelegramSendTest(ServiceTestCase):
    async def test_queued_send_waits_for_confirmation_and_retires_durable_identity(self):
        intent = await self.service.prepare_send(123, "**Hello**", None)
        token = intent["token"]
        queued = asyncio.Event()
        local = message(2**40, outgoing=True, sending_state={"@type": "messageSendingStatePending", "sending_id": int(token)})
        confirmed = message(2**40 + 10, outgoing=True)
        async def send(query):
            queued.set()
            return local
        self.client.handlers["sendMessage"] = send
        pending = asyncio.create_task(self.service.send(123, "**Hello**", None, token))
        self.addAsyncCleanup(self.cancel_task, pending)
        await queued.wait()
        self.assertTrue(any(event.get("status") == "queued" for event in self.updates))
        self.assertFalse(pending.done())
        request, = self.client.requests("sendMessage")
        self.assertEqual(request["options"]["sending_id"], int(token))
        self.assertNotIn("random_id", request)
        self.assertEqual(request["input_message_content"]["text"]["text"], "Hello")
        self.assertEqual(request["input_message_content"]["text"]["entities"][0]["type"], {"@type": "textEntityTypeBold"})
        persisted = json.loads((self.service.data_dir / "tdlib/outbox.json").read_text())
        self.assertEqual(persisted[token]["status"], "queued")
        await self.client.update("updateMessageSendSucceeded", message=confirmed, old_message_id=local["id"])
        self.assertEqual((await pending).id, confirmed["id"])
        self.assertNotIn("Hello", (self.service.data_dir / "tdlib/outbox.json").read_text())
        self.assertEqual((await self.service.load_state())["pending_sends"], {})
        self.client.handlers["getMessage"] = confirmed
        self.client.handlers["getMessages"] = {"messages": [confirmed]}
        for text in ("**Hello**", "Changed"):
            with self.subTest(text=text), self.assertRaises(ClientError):
                await self.service.send(123, text, None, token)
        self.assertEqual(len(self.client.requests("sendMessage")), 1)

    async def test_confirmation_before_send_reply_is_not_lost(self):
        intent = await self.service.prepare_send(123, "Hello", None)
        token = intent["token"]
        local = message(2**40, outgoing=True, sending_state={"@type": "messageSendingStatePending", "sending_id": int(token)})
        confirmed = message(2**40 + 1, outgoing=True)
        async def send(_query):
            await self.client.update("updateMessageSendSucceeded", message=confirmed, old_message_id=local["id"])
            return local
        self.client.handlers["sendMessage"] = send
        self.assertEqual((await self.service.send(123, "Hello", None, token)).id, confirmed["id"])
        self.assertEqual((await self.service.load_state())["pending_sends"], {})
        self.assertNotIn("Hello", (self.service.data_dir / "tdlib/outbox.json").read_text())

    async def test_failed_send_requires_explicit_native_resend_and_preserves_text(self):
        token = (await self.service.prepare_send(123, "Keep my text", None))["token"]
        local = message(2**40, outgoing=True, sending_state={"@type": "messageSendingStatePending", "sending_id": int(token)})
        failed = message(2**40, outgoing=True, sending_state={"@type": "messageSendingStateFailed", "can_retry": True, "retry_after": 0, "error": {"code": 500, "message": "private-input"}})
        confirmed = message(2**40 + 10, outgoing=True)
        async def send(_query):
            await self.client.update("updateMessageSendFailed", message=failed, old_message_id=local["id"], error={"code": 500, "message": "private-input"})
            return local
        self.client.handlers["sendMessage"] = send
        with self.assertRaises(ClientError) as raised:
            await self.service.send(123, "Keep my text", None, token)
        self.assertNotIn("private-input", str(raised.exception))
        pending = (await self.service.load_state())["pending_sends"]["123"]
        self.assertEqual((pending["text"], pending["status"]), ("Keep my text", "failed"))
        self.client.handlers["getMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.send(123, "Keep my text", None, token)
        self.client.handlers["resendMessages"] = {"@type": "messages", "messages": [confirmed]}
        self.assertEqual((await self.service.retry_send(123, token)).id, confirmed["id"])
        request, = self.client.requests("resendMessages")
        self.assertEqual(request["message_ids"], [local["id"]])
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertNotIn("Keep my text", (self.service.data_dir / "tdlib/outbox.json").read_text())

    async def test_history_failed_adoption_survives_reload_and_resends_original_identity(self):
        body, reply_id = "Recovered unsent text", 2**38 + 41
        content = {"@type": "messageText", "text": {"text": body, "entities": []}}
        failed = failed_message(content=content, reply_to={"@type": "messageReplyToMessage", "chat_id": 123, "message_id": reply_id})
        await self.service.save_state({"drafts": {"123": "Newer draft"}, "selected_id": 123, "pending_sends": {}})
        self.client.handlers["getChatHistory"] = {"messages": [failed]}
        record, = await self.service.history(123, limit=1)
        self.assertEqual((record.id, record.sending_state), (failed["id"], "failed"))
        self.client.handlers["getMessage"] = failed
        intent = await self.service.adopt_failed_send(123, record.id)
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))
        await self.restart_service()
        state = await self.service.load_state()
        pending = state["pending_sends"]["123"]
        self.assertEqual((pending["token"], pending["message_id"], pending["text"], pending["reply_to"], pending["status"]),
                         (intent["token"], failed["id"], body, reply_id, "failed"))
        self.assertEqual(state["drafts"]["123"], "Newer draft")
        queued = asyncio.Event()
        replacement = message(failed["id"] + 10, outgoing=True, content=content,
                              sending_state={"@type": "messageSendingStatePending"})
        confirmed = message(failed["id"] + 20, outgoing=True, content=content)

        async def resend(_query):
            await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[failed["id"]], is_permanent=True, from_cache=False)
            queued.set()
            return {"messages": [replacement]}

        self.client.handlers["resendMessages"] = resend
        retry = asyncio.create_task(self.service.retry_send(123, intent["token"]))
        self.addAsyncCleanup(self.cancel_task, retry)
        await queued.wait()
        self.assertFalse(retry.done())
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["status"], "queued")
        request, = self.client.requests("resendMessages")
        self.assertEqual((request["chat_id"], request["message_ids"]), (123, [failed["id"]]))
        await self.client.update("updateMessageSendSucceeded", message=confirmed, old_message_id=replacement["id"])
        self.assertEqual((await retry).id, confirmed["id"])
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertEqual(state["drafts"]["123"], "Newer draft")
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertNotIn(body, (self.service.data_dir / "tdlib/outbox.json").read_text())
        self.assertTrue(any(event.get("kind") == "send_state" and event.get("token") == intent["token"]
                            and event.get("status") == "sent" for event in self.updates))

    async def test_matching_failed_adoption_reuses_prepared_identity_and_snapshot(self):
        body = "**Keep original formatting**"
        intent = await self.service.prepare_send(123, body, None)
        failed = failed_message(content={"@type": "messageText", "text": {
            "text": "Keep original formatting", "entities": [{"offset": 0, "length": 24, "type": {"@type": "textEntityTypeBold"}}]}})
        self.client.handlers["sendMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.send(123, body, None, intent["token"])
        self.client.handlers["getMessage"] = failed
        ledger_file = self.service.data_dir / "tdlib/outbox.json"
        tokens = set(json.loads(ledger_file.read_text()))
        first = await self.service.adopt_failed_send(123, failed["id"])
        await self.restart_service()
        second = await self.service.adopt_failed_send(123, failed["id"])
        self.assertEqual((first["token"], second["token"], second["text"]), (intent["token"], intent["token"], body))
        self.assertEqual(set(json.loads(ledger_file.read_text())), tokens)
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["token"], intent["token"])
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_concurrent_failed_adoptions_reserve_only_one_durable_identity(self):
        failed = failed_message()
        both_reading, release = asyncio.Event(), asyncio.Event()
        reads = 0

        async def resolve(_query):
            nonlocal reads
            reads += 1
            if reads == 2:
                both_reading.set()
            await release.wait()
            return failed

        self.client.handlers["getMessage"] = resolve
        adoptions = [asyncio.create_task(self.service.adopt_failed_send(123, failed["id"])) for _ in range(2)]
        for adoption in adoptions:
            self.addAsyncCleanup(self.cancel_task, adoption)
        await both_reading.wait()
        release.set()
        first, second = await asyncio.gather(*adoptions)
        self.assertEqual(first["token"], second["token"])
        await self.restart_service()
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["token"], first["token"])
        ledger = json.loads((self.service.data_dir / "tdlib/outbox.json").read_text())
        self.assertEqual({token for token, item in ledger.items() if item.get("message_id") == failed["id"]}, {first["token"]})
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_abandoned_failed_message_gets_fresh_adoption_without_reactivating_token(self):
        body = "Previously abandoned native failure"
        failed = failed_message(content={"@type": "messageText", "text": {"text": body, "entities": []}})
        original = await self.service.prepare_send(123, body, None)
        self.client.handlers["sendMessage"] = failed
        self.client.handlers["getMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.send(123, body, None, original["token"])
        await self.service.abandon_send(123, original["token"])
        await self.restart_service()
        ledger_file = self.service.data_dir / "tdlib/outbox.json"
        tombstone = json.loads(ledger_file.read_text())[original["token"]]
        adopted = await self.service.adopt_failed_send(123, failed["id"])
        self.assertGreater(int(adopted["token"]), int(original["token"]))
        self.assertEqual(json.loads(ledger_file.read_text())[original["token"]], tombstone)
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, original["token"])
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["token"], adopted["token"])
        self.assertFalse(self.client.requests("resendMessages"))
        confirmed = message(failed["id"] + 10, outgoing=True, content=failed["content"])
        self.client.handlers["resendMessages"] = {"messages": [confirmed]}
        self.assertEqual((await self.service.retry_send(123, adopted["token"])).id, confirmed["id"])
        request, = self.client.requests("resendMessages")
        self.assertEqual(request["message_ids"], [failed["id"]])
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertEqual(json.loads(ledger_file.read_text())[original["token"]], tombstone)
        self.assertNotIn(body, ledger_file.read_text())

    async def test_pruned_retired_token_in_stale_state_cannot_replace_fresh_failed_adoption(self):
        body = "Retired failed message still visible in native history"
        failed = failed_message(content={"@type": "messageText", "text": {"text": body, "entities": []}})
        original = await self.service.prepare_send(123, body, None)
        self.client.handlers["sendMessage"] = failed
        self.client.handlers["getMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.send(123, body, None, original["token"])
        stale = (await self.service.load_state())["pending_sends"]["123"]
        await self.service.abandon_send(123, original["token"])
        # Simulate a pruned terminal ledger and a late saved UI snapshot without
        # depending on the terminal retention limit.
        self.service._store_private("tdlib/outbox.json", {})
        self.service._store_private("tdlib/state.json", {
            "drafts": {"123": "Newer private draft"}, "selected_id": 123, "pending_sends": {"123": stale}})
        await self.restart_service()
        adopted = await self.service.adopt_failed_send(123, failed["id"])
        self.assertGreater(int(adopted["token"]), int(original["token"]))
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual((state["pending_sends"]["123"]["token"], state["pending_sends"]["123"]["status"]),
                         (adopted["token"], "failed"))
        self.assertEqual(state["drafts"]["123"], "Newer private draft")
        ledger_file = self.service.data_dir / "tdlib/outbox.json"
        self.assertNotIn(original["token"], json.loads(ledger_file.read_text()))
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, original["token"])
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["token"], adopted["token"])
        self.assertFalse(self.client.requests("resendMessages"))
        confirmed = message(failed["id"] + 1, outgoing=True, content=failed["content"])
        self.client.handlers["resendMessages"] = {"messages": [confirmed]}
        self.assertEqual((await self.service.retry_send(123, adopted["token"])).id, confirmed["id"])
        request, = self.client.requests("resendMessages")
        self.assertEqual(request["message_ids"], [failed["id"]])
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertEqual(state["drafts"]["123"], "Newer private draft")
        self.assertNotIn(original["token"], json.loads(ledger_file.read_text()))
        self.assertEqual(len(self.client.requests("sendMessage")), 1)

    async def test_failed_adoption_rejects_unrelated_active_chat_intents_without_losing_them(self):
        for status in ("prepared", "queued", "uncertain", "failed", "saved_only"):
            with self.subTest(status=status):
                await self.restart_service(self.root / f"active-{status}")
                body = "Unrelated " + status + " send"
                active_id = 2**40 + 50
                if status == "saved_only":
                    await self.service.load_state()
                    active = {"token": "271828", "chat_id": 123, "text": body, "reply_to": None,
                              "status": "uncertain", "message_id": active_id}
                else:
                    active = await self.service.prepare_send(123, body, None)
                await self.service.save_state({"drafts": {"123": "Different composer draft"}, "selected_id": 123, "pending_sends": {"123": active}})
                sending = None
                if status == "queued":
                    started = asyncio.Event()

                    async def send(_query):
                        started.set()
                        return message(active_id, outgoing=True, sending_state={"@type": "messageSendingStatePending", "sending_id": int(active["token"])})

                    self.client.handlers["sendMessage"] = send
                    sending = asyncio.create_task(self.service.send(123, body, None, active["token"]))
                    self.addAsyncCleanup(self.cancel_task, sending)
                    await started.wait()
                elif status in ("uncertain", "failed"):
                    self.client.handlers["sendMessage"] = OSError("offline") if status == "uncertain" else failed_message(active_id)
                    with self.assertRaises(ClientError):
                        await self.service.send(123, body, None, active["token"])
                state_file = self.service.data_dir / "tdlib/state.json"
                ledger_file = self.service.data_dir / "tdlib/outbox.json"
                saved, ledger = json.loads(state_file.read_text()), json.loads(ledger_file.read_text())
                sends = len(self.client.requests("sendMessage"))
                self.client.handlers["getMessage"] = failed_message()
                with self.assertRaises(ClientError) as raised:
                    await self.service.adopt_failed_send(123, 2**40)
                self.assertEqual(raised.exception.code, "SEND_RECONCILIATION_REQUIRED")
                self.assertEqual(json.loads(state_file.read_text()), saved)
                self.assertEqual(json.loads(ledger_file.read_text()), ledger)
                self.assertEqual(len(self.client.requests("sendMessage")), sends)
                if sending is not None:
                    confirmed = message(active_id + 1, outgoing=True)
                    await self.client.update("updateMessageSendSucceeded", message=confirmed, old_message_id=active_id)
                    self.assertEqual((await sending).id, confirmed["id"])
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_adoption_rechecks_chat_intent_created_during_native_lookup(self):
        started, release = asyncio.Event(), asyncio.Event()
        failed = failed_message()

        async def resolve(_query):
            started.set()
            await release.wait()
            return failed

        self.client.handlers["getMessage"] = resolve
        adoption = asyncio.create_task(self.service.adopt_failed_send(123, failed["id"]))
        self.addAsyncCleanup(self.cancel_task, adoption)
        await started.wait()
        active = await self.service.prepare_send(123, "Concurrent composer send", None)
        saved = {"drafts": {"123": "Newer draft"}, "selected_id": 123, "pending_sends": {"123": active}}
        await self.service.save_state(saved)
        release.set()
        with self.assertRaises(ClientError) as raised:
            await adoption
        self.assertEqual(raised.exception.code, "SEND_RECONCILIATION_REQUIRED")
        self.assertEqual(json.loads((self.service.data_dir / "tdlib/state.json").read_text()), saved)
        ledger = json.loads((self.service.data_dir / "tdlib/outbox.json").read_text())
        self.assertEqual(ledger[active["token"]]["status"], "prepared")
        self.assertFalse(any(item.get("message_id") == failed["id"] for item in ledger.values()))
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_adoption_and_retry_revalidate_native_identity_state_and_required_decisions(self):
        failed = failed_message()
        cases = [
            ("incoming", {**failed, "is_outgoing": False}, "SEND_RECONCILIATION_REQUIRED"),
            ("foreign_chat", {**failed, "chat_id": 456}, "SEND_RECONCILIATION_REQUIRED"),
            ("foreign_id", {**failed, "id": failed["id"] + 1}, "SEND_RECONCILIATION_REQUIRED"),
            ("queued", {**failed, "sending_state": {"@type": "messageSendingStatePending", "can_retry": True}}, "SEND_RECONCILIATION_REQUIRED"),
            ("sent", {**failed, "sending_state": None}, "SEND_RECONCILIATION_REQUIRED"),
        ]
        cases.extend((name, failed_message(state_fields={field: value}), code) for name, field, value, code in (
            ("nonretryable", "can_retry", False, "SEND_RETRY_REQUIRES_DECISION"),
            ("payment", "required_paid_message_star_count", 9, "SEND_RETRY_REQUIRES_DECISION"),
            ("sender_change", "need_another_sender", True, "SEND_RETRY_REQUIRES_DECISION"),
            ("reply_change", "need_drop_reply", True, "SEND_RETRY_REQUIRES_DECISION"),
            ("reply_quote_change", "need_another_reply_quote", True, "SEND_RETRY_REQUIRES_DECISION"),
            ("cooldown", "retry_after", 27, "TDLIB_RATE_LIMIT"),
        ))
        for name, unsafe, code in cases:
            for stage in ("adoption", "before_retry", "inside_retry"):
                with self.subTest(native_state=name, stage=stage):
                    await self.restart_service(self.root / f"guard-{name}-{stage}")
                    saved = {"drafts": {"123": "Untouched user draft"}, "selected_id": 123, "pending_sends": {}}
                    await self.service.save_state(saved)
                    if stage == "adoption":
                        self.client.handlers["getMessage"] = unsafe
                        operation = self.service.adopt_failed_send(123, failed["id"])
                    else:
                        self.client.handlers["getMessage"] = failed
                        adopted = await self.service.adopt_failed_send(123, failed["id"])
                        responses = iter([failed, unsafe] if stage == "inside_retry" else [unsafe, unsafe])
                        self.client.handlers["getMessage"] = lambda _query: next(responses)
                        operation = self.service.retry_send(123, adopted["token"])
                    with self.assertRaises(ClientError) as raised:
                        await operation
                    self.assertEqual(raised.exception.code, code)
                    if name == "cooldown":
                        self.assertEqual(retry_after(raised.exception), 27)
                        self.assertEqual(retry_scope(raised.exception), "peer")
                    if stage == "adoption":
                        self.assertEqual(await self.service.load_state(), saved)
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_stale_failed_native_response_cannot_adopt_or_retry_after_confirmation_or_deletion(self):
        for change in ("confirmed", "deleted"):
            for stage in ("adoption", "retry"):
                with self.subTest(change=change, stage=stage):
                    await self.restart_service(self.root / f"stale-{change}-{stage}")
                    failed = failed_message()
                    self.client.handlers["getMessage"] = failed
                    intent = await self.service.adopt_failed_send(123, failed["id"]) if stage == "retry" else None
                    started, release = asyncio.Event(), asyncio.Event()
                    reads = 0

                    async def resolve(_query):
                        nonlocal reads
                        reads += 1
                        if stage == "retry" and reads == 1:
                            return failed
                        started.set()
                        await release.wait()
                        return failed

                    self.client.handlers["getMessage"] = resolve
                    operation = self.service.retry_send(123, intent["token"]) if intent else self.service.adopt_failed_send(123, failed["id"])
                    pending = asyncio.create_task(operation)
                    self.addAsyncCleanup(self.cancel_task, pending)
                    await started.wait()
                    if change == "confirmed":
                        await self.client.update("updateMessageSendSucceeded", message=message(failed["id"] + 1, outgoing=True), old_message_id=failed["id"])
                    else:
                        await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[failed["id"]], is_permanent=True, from_cache=False)
                    release.set()
                    with self.assertRaises(ClientError) as raised:
                        await pending
                    self.assertEqual(raised.exception.code, "SEND_RECONCILIATION_REQUIRED")
                    saved = (await self.service.load_state())["pending_sends"]
                    if stage == "retry" and change == "deleted":
                        self.assertEqual((saved["123"]["token"], saved["123"]["status"]), (intent["token"], "uncertain"))
                    else:
                        self.assertEqual(saved, {})
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_captionless_failed_media_reloads_retries_original_content_without_phantom_drafts(self):
        content = {"@type": "messagePhoto", "photo": {"id": "native-photo-identity", "sizes": []},
                   "caption": {"@type": "formattedText", "text": "", "entities": []}}
        failed = failed_message(content=content)
        self.client.handlers["getMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.prepare_send(123, "", None)
        adopted = await self.service.adopt_failed_send(123, failed["id"])
        self.assertEqual((adopted["text"], adopted["message_id"]), ("", failed["id"]))
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"]["123"]["text"], "")
        self.assertEqual(state["drafts"], {})
        await self.service.abandon_send(123, adopted["token"])
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertEqual(state["drafts"], {})
        await self.service.save_state({"drafts": {"123": "Unrelated written draft"}, "selected_id": 123, "pending_sends": {}})
        adopted = await self.service.adopt_failed_send(123, failed["id"])
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"]["123"]["text"], "")
        self.assertEqual(state["drafts"]["123"], "Unrelated written draft")
        confirmed = message(failed["id"] + 1, outgoing=True, content=content)
        self.client.handlers["resendMessages"] = {"messages": [confirmed]}
        result = await self.service.retry_send(123, adopted["token"])
        self.assertTrue(result.photo)
        self.assertEqual(result.id, confirmed["id"])
        request, = self.client.requests("resendMessages")
        self.assertEqual(request["message_ids"], [failed["id"]])
        self.assertNotIn("input_message_content", request)
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertEqual(state["drafts"]["123"], "Unrelated written draft")
        self.assertFalse(self.client.requests("sendMessage"))

    async def test_captionless_resend_uncertainty_survives_reload_without_repeating_old_native_id(self):
        failed = failed_message(content={"@type": "messagePhoto", "photo": {"sizes": []},
                                         "caption": {"text": "", "entities": []}})
        await self.service.save_state({"drafts": {"123": "Unrelated user draft"}, "selected_id": 123, "pending_sends": {}})
        self.client.handlers["getMessage"] = failed
        adopted = await self.service.adopt_failed_send(123, failed["id"])
        self.client.handlers["resendMessages"] = OSError("lost native replacement reply")
        with self.assertRaises(ClientError) as raised:
            await self.service.retry_send(123, adopted["token"])
        self.assertEqual(raised.exception.code, "SEND_UNCERTAIN")
        request, = self.client.requests("resendMessages")
        self.assertEqual(request["message_ids"], [failed["id"]])
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual((state["pending_sends"]["123"]["token"], state["pending_sends"]["123"]["text"],
                          state["pending_sends"]["123"]["status"], state["pending_sends"]["123"]["message_id"]),
                         (adopted["token"], "", "uncertain", failed["id"]))
        self.assertEqual(state["drafts"]["123"], "Unrelated user draft")
        lookups = list(self.client.requests("getMessage"))
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, adopted["token"])
        self.assertEqual(self.client.requests("getMessage"), lookups, "the retired failed ID is display continuity, not a retry identity")
        self.assertEqual(self.client.requests("resendMessages"), [request])
        await self.service.abandon_send(123, adopted["token"])
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertEqual(state["drafts"]["123"], "Unrelated user draft")
        self.assertFalse(self.client.requests("sendMessage"))

    async def test_ambiguous_transport_failure_survives_restart_without_resubmission(self):
        token = (await self.service.prepare_send(123, "Never lose this", None))["token"]
        self.client.handlers["sendMessage"] = OSError("private-input")
        with self.assertRaises(ClientError):
            await self.service.send(123, "Never lose this", None, token)
        await self.restart_service()
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["status"], "uncertain")
        with self.assertRaises(ClientError):
            await self.service.send(123, "Never lose this", None, token)
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, token)
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_malformed_tokens_and_utf16_overflow_never_send(self):
        for token in (None, 1, True, "", "0", "-1", "+1", "01", " 1", "1.0", "١", str(2**31)):
            with self.subTest(token=token), self.assertRaises(ClientError):
                await self.service.send(123, "Hello", None, token)
        with self.assertRaises(ClientError):
            await self.service.prepare_send(123, "😀" * 2049, None)
        self.assertFalse(self.client.requests("sendMessage"))

    async def test_confirmed_reply_forgets_plaintext_and_never_resurrects_after_delete(self):
        body, reply_id = "confirmed-secret-body", 2**38 + 73
        intent = await self.service.prepare_send(123, body, reply_id)
        token = intent["token"]
        await self.service.save_state({"drafts": {"123": body}, "selected_id": 123, "pending_sends": {"123": intent}})
        self.client.handlers["getMessages"] = {"messages": [message(reply_id)]}
        self.client.handlers["getMessageProperties"] = {"can_be_replied": True}
        confirmed = message(2**40 + 17, outgoing=True, content={"@type": "messageText", "text": {"text": body, "entities": []}})
        self.client.handlers["sendMessage"] = confirmed
        self.assertEqual((await self.service.send(123, body, reply_id, token)).id, confirmed["id"])
        ledger = (self.service.data_dir / "tdlib/outbox.json").read_text()
        self.assertNotIn(body, ledger)
        self.assertNotIn(str(reply_id), ledger, "a completed reply must not retain its reply snapshot")
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"], {})
        self.assertNotIn(body, json.dumps(state))
        self.assertNotIn(body, (self.service.data_dir / "tdlib/state.json").read_text())
        await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[confirmed["id"]], is_permanent=True, from_cache=False)
        self.client.handlers["getMessage"] = TDLibError(404, "deleted")
        self.client.handlers["getMessages"] = {"messages": [None]}
        self.client.handlers["getChatHistory"] = {"messages": []}
        self.updates.clear()
        await self.service.reconcile_send(123, token)
        with self.assertRaises(ClientError):
            await self.service.send(123, body, reply_id, token)
        self.assertEqual(await self.service.history(123), [])
        self.assertFalse(any(event.get("kind") == "message" or event.get("message") for event in self.updates))
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        await self.restart_service()
        self.assertNotIn(body, json.dumps(await self.service.load_state()))

    async def test_abandoned_reply_keeps_only_user_draft_after_reload_and_delete(self):
        body, reply_id = "abandoned-secret-body", 2**38 + 91
        intent = await self.service.prepare_send(123, body, reply_id)
        token = intent["token"]
        await self.service.save_state({"drafts": {"123": "New draft"}, "selected_id": 123, "pending_sends": {"123": intent}})
        self.client.handlers["getMessages"] = {"messages": [message(reply_id)]}
        self.client.handlers["getMessageProperties"] = {"can_be_replied": True}
        failed = message(2**40, outgoing=True, sending_state={"@type": "messageSendingStateFailed", "can_retry": True, "retry_after": 0, "error": {"code": 500, "message": "failure"}})
        self.client.handlers["sendMessage"] = failed
        self.client.handlers["getMessage"] = failed
        with self.assertRaises(ClientError):
            await self.service.send(123, body, reply_id, token)
        await self.service.abandon_send(123, token)
        ledger = (self.service.data_dir / "tdlib/outbox.json").read_text()
        self.assertNotIn(body, ledger)
        self.assertNotIn(str(reply_id), ledger)
        await self.restart_service()
        state = await self.service.load_state()
        self.assertEqual(state["drafts"]["123"], "New draft\n\n" + body)
        self.assertEqual(state["pending_sends"], {})
        await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[failed["id"]], is_permanent=True, from_cache=False)
        self.client.handlers["getMessage"] = TDLibError(404, "deleted")
        self.updates.clear()
        await self.service.reconcile_send(123, token)
        await self.service.abandon_send(123, token)
        with self.assertRaises(ClientError):
            await self.service.send(123, body, reply_id, token)
        self.assertFalse(any(event.get("kind") == "message" or event.get("message") for event in self.updates))
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertFalse(self.client.requests("resendMessages"))
        await self.restart_service()
        self.assertEqual((await self.service.load_state())["drafts"]["123"], "New draft\n\n" + body)

    async def test_pre_admission_reply_network_and_permission_failures_release_draft(self):
        for failure in ("deleted_reply", "properties_network", "cannot_reply", "chat_network", "readonly"):
            with self.subTest(failure=failure):
                body, reply_id = "Draft for " + failure, 2**39
                intent = await self.service.prepare_send(123, body, reply_id)
                token = intent["token"]
                await self.service.save_state({"drafts": {"123": body}, "selected_id": 123, "pending_sends": {"123": intent}})
                self.client.handlers["getMessages"] = {"messages": [None if failure == "deleted_reply" else message(reply_id)]}
                self.client.handlers["getMessageProperties"] = OSError("private-properties") if failure == "properties_network" else {"can_be_replied": failure != "cannot_reply"}
                if failure == "chat_network":
                    self.service._chats.pop(123)
                    self.client.handlers["getChat"] = OSError("private-network")
                elif failure == "readonly":
                    await self.group(chat_id=123)
                    await self.client.update("updateChatPermissions", chat_id=123, permissions={"can_send_basic_messages": False})
                before = len(self.client.requests("sendMessage"))
                with self.assertRaises(ClientError):
                    await self.service.send(123, body, reply_id, token)
                state = await self.service.load_state()
                self.assertEqual(state["pending_sends"], {})
                self.assertEqual(state["drafts"]["123"], body)
                terminal = [event for event in self.updates if event.get("kind") == "send_state" and event.get("token") == token][-1]
                self.assertEqual((terminal["status"], terminal["admitted"]), ("abandoned", False))
                self.assertEqual(len(self.client.requests("sendMessage")), before)
                await self.client.update("updateNewChat", chat=chat())
                fresh = await self.service.prepare_send(123, "Recovered send", None)
                self.assertNotEqual(fresh["token"], token)
                self.client.handlers["sendMessage"] = message(2**40 + before, outgoing=True)
                await self.service.send(123, fresh["text"], None, fresh["token"])
                self.assertEqual(len(self.client.requests("sendMessage")), before + 1)

    async def test_validation_failure_keeps_draft_and_allows_corrected_send(self):
        body = "😀" * 2049
        await self.service.save_state({"drafts": {"123": body}, "selected_id": 123, "pending_sends": {}})
        with self.assertRaises(ClientError):
            await self.service.prepare_send(123, body, None)
        state = await self.service.load_state()
        self.assertEqual(state["drafts"]["123"], body)
        self.assertEqual(state["pending_sends"], {})
        self.assertFalse(self.client.requests("sendMessage"))
        intent = await self.service.prepare_send(123, "Corrected text", None)
        self.client.handlers["sendMessage"] = message(outgoing=True)
        await self.service.send(123, intent["text"], None, intent["token"])
        self.assertEqual(len(self.client.requests("sendMessage")), 1)

    async def test_prepared_and_missing_intents_recover_on_restart_without_duplication(self):
        for source in ("missing", "prepared"):
            with self.subTest(source=source):
                body = source + " unsubmitted text"
                intent = await self.service.prepare_send(123, body, 2**39) if source == "prepared" else {"token": "1000", "chat_id": 123, "text": body, "reply_to": 2**39, "status": "queued"}
                state = {"drafts": {"123": "Newer draft"}, "selected_id": 123, "pending_sends": {"123": intent}}
                if source == "missing":
                    self.service._store_private("tdlib/state.json", state)  # Legacy crash before native admission existed.
                else:
                    await self.service.save_state(state)
                await self.restart_service()
                state = await self.service.load_state()
                self.assertEqual(state["pending_sends"], {})
                self.assertEqual(state["drafts"]["123"], "Newer draft\n\n" + body)
                await self.restart_service()
                self.assertEqual((await self.service.load_state())["drafts"], state["drafts"])
                with self.assertRaises(ClientError):
                    await self.service.send(123, body, 2**39, intent["token"])
                fresh = await self.service.prepare_send(123, "A new deliberate send", None)
                self.assertNotEqual(fresh["token"], intent["token"])
                self.client.handlers["sendMessage"] = message(2**40 + len(self.client.requests("sendMessage")), outgoing=True)
                await self.service.send(123, fresh["text"], None, fresh["token"])
        self.assertEqual(len(self.client.requests("sendMessage")), 2)
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_never_submitted_intents_can_be_cleared_by_all_recovery_actions(self):
        for index, (source, action) in enumerate((source, action) for source in ("prepared", "missing") for action in ("reconcile_send", "retry_send", "abandon_send")):
            with self.subTest(source=source, action=action):
                await self.restart_service(self.root / f"recovery-{index}")
                body = source + " " + action
                intent = await self.service.prepare_send(123, body, None) if source == "prepared" else {"token": str(2000 + index), "chat_id": 123, "text": body, "reply_to": None, "status": "queued"}
                state = {"drafts": {"123": body}, "selected_id": 123, "pending_sends": {"123": intent}}
                if source == "missing":
                    self.service._store_private("tdlib/state.json", state)
                else:
                    await self.service.save_state(state)
                operation = getattr(self.service, action)
                if action == "retry_send":
                    with self.assertRaises(ClientError):
                        await operation(123, intent["token"])
                else:
                    await operation(123, intent["token"])
                state = await self.service.load_state()
                self.assertEqual(state["pending_sends"], {})
                self.assertEqual(state["drafts"]["123"], body)
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_token_allocation_survives_reload_and_retirement_without_collisions(self):
        for chat_id in (456, 789):
            await self.client.update("updateNewChat", chat=chat(chat_id))
        intents = await asyncio.gather(*(self.service.prepare_send(chat_id, "Same body", None) for chat_id in (123, 456, 789)))
        tokens = [intent["token"] for intent in intents]
        self.assertEqual(len(set(tokens)), len(tokens))
        self.assertTrue(all(0 < int(token) < 2**31 for token in tokens))
        for index, intent in enumerate(intents):
            self.client.handlers["sendMessage"] = message(2**40 + index, chat_id=intent["chat_id"], outgoing=True)
            await self.service.send(intent["chat_id"], intent["text"], None, intent["token"])
        await self.restart_service()
        next_intent = await self.service.prepare_send(123, "Same body", None)
        self.assertGreater(int(next_intent["token"]), max(map(int, tokens)))
        for intent in intents:
            with self.subTest(token=intent["token"]), self.assertRaises(ClientError):
                await self.service.send(intent["chat_id"], "Same body", None, intent["token"])
        with self.assertRaises(ClientError):
            await self.service.send(123, "Different body", None, next_intent["token"])
        self.assertEqual(len(self.client.requests("sendMessage")), len(intents))
        self.client.handlers["sendMessage"] = message(2**40 + len(intents), outgoing=True)
        await self.service.send(123, next_intent["text"], None, next_intent["token"])
        self.assertEqual(len(self.client.requests("sendMessage")), len(intents) + 1)

    async def test_retired_token_stays_blocked_when_terminal_tombstone_is_absent(self):
        intent = await self.service.prepare_send(123, "Already delivered", None)
        self.client.handlers["sendMessage"] = message(outgoing=True)
        await self.service.send(123, intent["text"], None, intent["token"])
        # A pruned terminal record is absent; its durable allocation watermark still exists.
        self.service._store_private("tdlib/outbox.json", {})
        await self.restart_service()
        await self.service.save_state({"drafts": {"123": intent["text"]}, "selected_id": 123, "pending_sends": {"123": intent}})
        state = await self.service.load_state()
        self.assertEqual(state["pending_sends"]["123"]["status"], "uncertain")
        await self.service.reconcile_send(123, intent["token"])
        with self.assertRaises(ClientError):
            await self.service.send(123, intent["text"], None, intent["token"])
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, intent["token"])
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertFalse(self.client.requests("resendMessages"))
        await self.service.abandon_send(123, intent["token"])
        self.assertEqual((await self.service.load_state())["drafts"]["123"], intent["text"])
        fresh = await self.service.prepare_send(123, intent["text"], None)
        self.assertGreater(int(fresh["token"]), int(intent["token"]))

    async def test_legacy_missing_uncertain_intent_is_not_mistaken_for_unsubmitted(self):
        pending = {"token": "21", "chat_id": 123, "text": "Unknown delivery", "reply_to": None, "status": "uncertain"}
        self.service._store_private("tdlib/state.json", {"drafts": {"123": pending["text"]}, "selected_id": 123, "pending_sends": {"123": pending}})
        await self.restart_service()
        self.assertEqual((await self.service.load_state())["pending_sends"]["123"]["status"], "uncertain")
        await self.service.reconcile_send(123, pending["token"])
        with self.assertRaises(ClientError):
            await self.service.send(123, pending["text"], None, pending["token"])
        with self.assertRaises(ClientError):
            await self.service.retry_send(123, pending["token"])
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_legacy_terminal_compaction_prunes_only_unreferenced_completed_sends(self):
        snapshot, reply_id = "legacy-terminal-server-snapshot", 2**38 + 193
        terminal = {
            str(index): {"token": str(index), "chat_id": 123 if index == 1 else 456,
                         "text": snapshot if index % 2 else "", "reply_to": reply_id,
                         "status": "sent" if index % 2 else "abandoned", "message_id": 2**40 + index}
            for index in range(1, 601)
        }
        uncertain = {"token": "601", "chat_id": 789, "text": "Uncertain draft must survive", "reply_to": None, "status": "uncertain"}
        failed = {"token": "602", "chat_id": 987, "text": "Failed draft must survive", "reply_to": None, "status": "failed", "message_id": 2**40 + 800}
        reference = {"token": "1", "chat_id": 123, "text": "Confirmed original draft", "reply_to": reply_id, "status": "queued", "message_id": 2**40 + 1}
        self.service._store_private("tdlib/outbox.json", {**terminal, uncertain["token"]: uncertain, failed["token"]: failed})
        self.service._store_private("tdlib/state.json", {"drafts": {"123": reference["text"]}, "selected_id": 123, "pending_sends": {"123": reference}})
        # Public preparation initializes/migrates the ledger without releasing the
        # persisted terminal reference. No assertion depends on the retention count.
        fresh = await self.service.prepare_send(555, "Another deliberate draft", None)
        ledger_file = self.service.data_dir / "tdlib/outbox.json"
        compacted = json.loads(ledger_file.read_text())
        self.assertIn(reference["token"], compacted, "a referenced completion must remain provable until recovery clears its UI intent")
        self.assertIn(uncertain["token"], compacted)
        self.assertIn(failed["token"], compacted)
        retired = [token for token in terminal if token not in compacted]
        self.assertTrue(retired, "historical terminal snapshots must not grow without bound")
        self.assertNotIn(snapshot, ledger_file.read_text())
        self.assertNotIn(str(reply_id), ledger_file.read_text())
        self.assertGreater(int(fresh["token"]), max(map(int, terminal)))
        await self.restart_service()
        self.updates.clear()
        state = await self.service.load_state()
        self.assertNotIn("123", state["pending_sends"])
        self.assertNotIn("123", state["drafts"], "referenced sent text is not an unsent draft")
        self.assertEqual(state["pending_sends"]["789"]["text"], uncertain["text"])
        self.assertEqual(state["pending_sends"]["987"]["text"], failed["text"])
        self.assertFalse(any(event.get("message") for event in self.updates), "terminal migration must not replay old server messages")
        await self.service.save_state(state)
        self.assertNotIn(reference["token"], json.loads(ledger_file.read_text()), "released old references become eligible for pruning")
        with self.assertRaises(ClientError):
            await self.service.send(456, snapshot, reply_id, retired[0])
        self.assertFalse(self.client.requests("sendMessage"))
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_well_formed_unknown_token_is_not_a_new_send_admission(self):
        with self.assertRaises(ClientError):
            await self.service.send(123, "Unprepared", None, "17")
        self.assertFalse(self.client.requests("sendMessage"))

    async def cancel_task(self, task):
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


class TelegramQRAuthTest(ServiceTestCase):
    async def test_qr_rotation_password_ready_and_close_never_persist_tokens(self):
        self.service._authorization = {"state": "credentials"}
        self.service._store_private("credentials.json", {"api_id": 12345, "api_hash": "a" * 32})
        self.client.handlers["setTdlibParameters"] = {"@type": "ok"}
        self.client.handlers["requestQrCodeAuthentication"] = {"@type": "ok"}
        self.client.handlers["getMe"] = user(99, "Me")
        await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitTdlibParameters"})
        await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitPhoneNumber"})
        self.assertEqual(self.client.requests("requestQrCodeAuthentication"), [{"@type": "requestQrCodeAuthentication", "other_user_ids": []}])
        images = []
        for token in ("private-login-token-one", "private-login-token-two"):
            await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitOtherDeviceConfirmation", "link": "tg://login?token=" + token})
            auth = await self.service.auth_state()
            images.append(auth["qr"]["data"])
            self.assertEqual(auth["state"], "qr")
            self.assertEqual(auth["qr"]["mime"], "image/png")
            self.assertTrue(base64.b64decode(images[-1]).startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertGreater(auth["qr"]["width"], 0)
            self.assertEqual(auth["qr"]["width"], auth["qr"]["height"])
        self.assertNotEqual(images[0], images[1])
        self.assertNotIn(images[0], json.dumps(await self.service.auth_state()))
        await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitPassword", "password_hint": "Hint"})
        self.assertEqual(await self.service.auth_state(), {"state": "password", "hint": "Hint"})
        async def check(_query):
            await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateReady"})
            return {"@type": "ok"}
        self.client.handlers["checkAuthenticationPassword"] = check
        self.assertEqual(await self.service.sign_in_password("private-password"), {"state": "ready"})
        self.assertEqual(await self.service.me(), "Me")
        await self.service.close()
        self.assertEqual(await self.service.auth_state(), {"state": "closed"})
        diagnostic = TDLibError(400, "tg://login?token=private-login-token-two private-password")
        self.service.record_error("auth", diagnostic)
        for file in self.service.data_dir.rglob("*.json"):
            value = file.read_text()
            for secret in ("private-login-token-one", "private-login-token-two", "private-password", *images):
                self.assertNotIn(secret, value)
        self.assertFalse(any(query["@type"] in ("setAuthenticationPhoneNumber", "checkAuthenticationCode") for query in self.client.calls))
        self.assertEqual([event["authorization"]["state"] for event in self.updates if event["kind"] == "authorization"][:4], ["qr", "qr", "password", "ready"])

    async def test_connect_uses_injected_transport_and_old_client_updates_are_ignored(self):
        old_callback = self.client.on_update
        await self.service.close()
        await old_callback({"@type": "updateAuthorizationState", "authorization_state": {"@type": "authorizationStateClosed"}})
        created = []
        class LoginTransport(FakeTDLib):
            async def start(transport):
                await super().start()
                await transport.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitPhoneNumber"})
                await transport.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitOtherDeviceConfirmation", "link": "tg://login?token=offline-test"})
        def construct(callback):
            transport = LoginTransport(callback)
            transport.handlers["requestQrCodeAuthentication"] = {"@type": "ok"}
            created.append(transport)
            return transport
        with patch("terngram.telegram.TDLib", side_effect=construct):
            auth = await self.service.connect(12345, "a" * 32)
        self.assertEqual(auth["state"], "qr")
        self.assertTrue(created[0].started)
        await self.service.close()
        await created[0].update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitOtherDeviceConfirmation", "link": "tg://login?token=stale"})
        self.assertEqual(await self.service.auth_state(), {"state": "closed"})

    async def test_unsupported_auth_state_is_explanatory_not_phone_fallback(self):
        self.service._authorization = {"state": "credentials"}
        self.service._store_private("credentials.json", {"api_id": 12345, "api_hash": "a" * 32})
        await self.client.update("updateAuthorizationState", authorization_state={"@type": "authorizationStateWaitCode"})
        with self.assertRaises(ClientError) as raised:
            await self.service.connect()
        self.assertEqual(raised.exception.code, "AUTH_STEP_UNSUPPORTED")
        self.assertIn("QR-only", str(raised.exception))
        self.assertEqual(await self.service.auth_state(), {"state": "closed"})
        self.assertEqual(self.client.calls, [])


class TelegramMediaTest(ServiceTestCase):
    def downloaded_file(self, file_id, data=b"image-bytes", directory="tdlib/files"):
        directory = self.service.data_dir / directory
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / str(file_id)
        path.write_bytes(data)
        return {"@type": "file", "id": file_id, "local": {"path": str(path), "is_downloading_completed": True}}

    async def test_avatar_decodes_native_profile_photo_and_ordinary_files_cache(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (37, 29), (77, 77, 77)).save(stream, "JPEG")
        data = stream.getvalue()
        await self.client.update("updateUser", user=user(profile_photo={"small": {"id": 10}}))
        for directory in ("tdlib/db/profile_photos", "tdlib/files/photos"):
            with self.subTest(directory=directory):
                self.client.handlers["downloadFile"] = self.downloaded_file(10, data, directory)
                result = await self.service.avatar(42)
                self.assertEqual((result["mime"], result["width"], result["height"]), ("image/jpeg", 37, 29))
                decoded = base64.b64decode(result["data"])
                self.assertEqual(decoded, data)
                with Image.open(BytesIO(decoded)) as image:
                    image.load()
                    self.assertEqual(image.size, (37, 29))
                    self.assertEqual(image.getpixel((18, 14)), (77, 77, 77))
        self.assertEqual([query["file_id"] for query in self.client.requests("downloadFile")], [10, 10])

    async def test_avatar_accepts_canonical_path_beneath_symlinked_data_parent(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (19, 17), (77, 77, 77)).save(stream, "JPEG")
        file = self.downloaded_file(10, stream.getvalue(), "tdlib/db/profile_photos")
        alias = self.root / "data-parent"
        alias.symlink_to(self.root, target_is_directory=True)
        self.service.data_dir = alias / "private"
        await self.client.update("updateUser", user=user(profile_photo={"small": {"id": 10}}))
        for path in (self.service.data_dir / "tdlib/db/profile_photos/10", Path(file["local"]["path"]).resolve(strict=True)):
            with self.subTest(path=path):
                self.client.handlers["downloadFile"] = {"@type": "file", "id": 10, "local": {"path": str(path), "is_downloading_completed": True}}
                result = await self.service.avatar(42)
                self.assertEqual((result["width"], result["height"]), (19, 17))
                self.assertEqual(base64.b64decode(result["data"]), stream.getvalue())

    async def test_avatar_rejects_symlinked_private_cache_ancestors(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (19, 17), (77, 77, 77)).save(stream, "JPEG")
        file = self.downloaded_file(10, stream.getvalue(), "tdlib/db/profile_photos")
        await self.client.update("updateUser", user=user(profile_photo={"small": {"id": 10}}))
        self.client.handlers["downloadFile"] = file
        for index, relative in enumerate(("", "tdlib", "tdlib/db", "tdlib/db/profile_photos")):
            ancestor = self.service.data_dir / relative
            moved = self.root / f"redirected-cache-{index}"
            image = Path(file["local"]["path"])
            image.chmod(0o644)
            ancestor.rename(moved)
            ancestor.symlink_to(moved, target_is_directory=True)
            try:
                with self.subTest(ancestor=relative), self.assertRaises(ClientError):
                    await self.service.avatar(42)
                redirected_image = moved / image.relative_to(ancestor)
                self.assertEqual(redirected_image.read_bytes(), stream.getvalue())
                self.assertEqual(stat.S_IMODE(redirected_image.stat().st_mode), 0o644)
            finally:
                ancestor.unlink()
                moved.rename(ancestor)

    async def test_photo_preview_smallest_sufficient_full_largest_and_media_edit_identity(self):
        sizes = [{"@type": "photoSize", "width": width, "height": height, "photo": {"id": file_id}} for width, height, file_id in ((90, 67, 1), (320, 240, 2), (800, 600, 3))]
        content = {"@type": "messagePhoto", "photo": {"sizes": sizes}, "caption": {"text": "", "entities": []}}
        item = message(content=content)
        self.client.handlers["getMessages"] = {"messages": [item]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        files = {file_id: self.downloaded_file(file_id) for file_id in (1, 2, 3)}
        self.client.handlers["downloadFile"] = lambda query: files[query["file_id"]]
        preview = await self.service.photo(123, 2**40, True)
        full = await self.service.photo(123, 2**40)
        self.assertEqual((preview["width"], preview["height"]), (320, 240))
        self.assertEqual((full["width"], full["height"]), (800, 600))
        self.assertEqual([query["file_id"] for query in self.client.requests("downloadFile")], [2, 3])
        self.assertEqual(len(self.client.requests("openMessageContent")), 1)
        await self.client.update("updateNewMessage", message=item)
        self.assertEqual(self.updates[-1]["message"].media_id, "3")
        await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageExpiredPhoto"})
        self.assertFalse(self.updates[-1]["message"].photo)
        self.assertIsNone(self.updates[-1]["message"].media_id)

    async def test_document_thumbnail_never_downloads_original_and_full_reads_dimensions(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (80, 60)).save(stream, "PNG")
        original = self.downloaded_file(10, stream.getvalue())
        thumbnail_stream = BytesIO()
        Image.new("RGB", (320, 180), (77, 77, 77)).save(thumbnail_stream, "JPEG")
        content = {"@type": "messageDocument", "document": {"mime_type": "image/png", "document": {"id": 10}, "thumbnail": {"format": {"@type": "thumbnailFormatJpeg"}, "width": 320, "height": 180, "file": {"id": 11}}}, "caption": {"text": "Image", "entities": []}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        for directory in ("tdlib/db/thumbnails", "tdlib/db/secret_thumbnails"):
            with self.subTest(directory=directory):
                thumbnail = self.downloaded_file(11, thumbnail_stream.getvalue(), directory)
                self.client.handlers["downloadFile"] = lambda query: {10: original, 11: thumbnail}[query["file_id"]]
                preview = await self.service.photo(123, 2**40, True)
                self.assertEqual((preview["mime"], preview["width"], preview["height"]), ("image/jpeg", 320, 180))
                decoded = base64.b64decode(preview["data"])
                self.assertEqual(decoded, thumbnail_stream.getvalue())
                with Image.open(BytesIO(decoded)) as image:
                    image.load()
                    self.assertEqual(image.size, (320, 180))
                    self.assertEqual(image.getpixel((160, 90)), (77, 77, 77))
        self.assertEqual([query["file_id"] for query in self.client.requests("downloadFile")], [11, 11])
        full = await self.service.photo(123, 2**40)
        self.assertEqual((full["mime"], full["width"], full["height"]), ("image/png", 80, 60))
        self.assertEqual(base64.b64decode(full["data"]), stream.getvalue())
        content["document"].pop("thumbnail")
        self.assertIsNone(await self.service.photo(123, 2**40, True))
        self.assertEqual(len(self.client.requests("downloadFile")), 3)

    async def test_protected_media_and_changed_download_never_return_stale_image(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content, self_destruct_type={"@type": "messageSelfDestructTypeImmediately"})]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": False}
        self.assertIsNone(await self.service.photo(123, 2**40, True))
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_PROTECTED_VIEWER_REQUIRED")
        self.assertFalse(self.client.requests("downloadFile"))
        self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True, "has_protected_content_by_other_user": True}
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_PROTECTED")
        self.assertFalse(self.client.requests("downloadFile"))
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        file = self.downloaded_file(1)
        async def changed(_query):
            await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageExpiredPhoto"})
            return file
        self.client.handlers["downloadFile"] = changed
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertFalse(self.updates[-1]["message"].photo)
        self.assertIsNone(self.updates[-1]["message"].media_id)
        self.assertFalse(self.client.requests("openMessageContent"))

    async def test_concurrent_photo_properties_and_expiry_never_return_stale_bytes(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        original = message(content=content)
        # Each native response is a distinct dictionary, as overlapping getMessages calls are.
        self.client.handlers["getMessages"] = lambda _query: {"messages": [json.loads(json.dumps(original))]}
        properties_started = [asyncio.Event(), asyncio.Event()]
        release_properties = asyncio.Event()
        finish_download = asyncio.Event()
        file = self.downloaded_file(1, b"expired-photo-must-not-escape")
        property_calls = 0

        async def properties(_query):
            nonlocal property_calls
            index = property_calls
            property_calls += 1
            properties_started[index].set()
            await release_properties.wait()
            return {"can_be_saved": True}

        async def download(_query):
            await finish_download.wait()
            return file

        self.client.handlers["getMessageProperties"] = properties
        self.client.handlers["downloadFile"] = download
        preview = asyncio.create_task(self.service.photo(123, 2**40, True))
        full = None
        try:
            await properties_started[0].wait()
            full = asyncio.create_task(self.service.photo(123, 2**40))
            await properties_started[1].wait()
            await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageExpiredPhoto"})
            release_properties.set()
            finish_download.set()
            outcomes = await asyncio.gather(preview, full, return_exceptions=True)
            self.assertTrue(all(isinstance(outcome, ClientError) for outcome in outcomes), outcomes)
            self.assertTrue(all(outcome.code == "MEDIA_CHANGED" for outcome in outcomes))
            self.assertFalse(self.updates[-1]["message"].photo)
            self.assertIsNone(self.updates[-1]["message"].media_id)
            self.assertFalse(self.client.requests("openMessageContent"), "expired media must not be opened or returned as usable bytes")
        finally:
            for task in (preview, full):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (preview, full) if task is not None), return_exceptions=True)

    async def test_photo_replacement_during_download_publishes_latest_before_failure(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        replacement = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 640, "height": 480, "photo": {"id": 2}}]}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        old_file = self.downloaded_file(1, b"old-photo-must-not-escape")

        async def download(_query):
            await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content=replacement)
            return old_file

        self.client.handlers["downloadFile"] = download
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertEqual(self.updates[-1]["message"].media_id, "2")
        self.assertTrue(self.updates[-1]["message"].photo)
        self.assertFalse(self.client.requests("openMessageContent"))
        self.assertEqual(len(self.client.requests("getMessages")), 1)

    async def test_photo_initial_removed_or_missing_snapshot_publishes_truthful_model(self):
        for snapshot in (message(content={"@type": "messageExpiredPhoto"}), None):
            with self.subTest(snapshot=snapshot):
                self.client.handlers["getMessages"] = {"messages": [snapshot]}
                with self.assertRaises(ClientError) as raised:
                    await self.service.photo(123, 2**40)
                self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
                if snapshot is None:
                    self.assertEqual(self.updates[-1], {"kind": "delete", "chat_id": 123, "ids": [2**40]})
                else:
                    self.assertFalse(self.updates[-1]["message"].photo)
                    self.assertIsNone(self.updates[-1]["message"].media_id)
        self.assertFalse(self.client.requests("getMessageProperties"))
        self.assertFalse(self.client.requests("downloadFile"))

    async def test_photo_lookup_cannot_resurrect_deletion_or_overwrite_new_media(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        replacement = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 640, "height": 480, "photo": {"id": 2}}]}}
        original = message(content=content)
        await self.client.update("updateNewMessage", message=json.loads(json.dumps(original)))

        async def lookup(_query):
            await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content=replacement)
            return {"messages": [original]}

        self.client.handlers["getMessages"] = lookup
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertEqual(self.updates[-1]["message"].media_id, "2")

        async def deleted_lookup(_query):
            await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[2**40], is_permanent=True)
            return {"messages": [original]}

        self.client.handlers["getMessages"] = deleted_lookup
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertEqual(self.updates[-1], {"kind": "delete", "chat_id": 123, "ids": [2**40]})
        self.assertNotIn((123, 2**40), self.service._messages)
        self.assertFalse(self.client.requests("downloadFile"))

    async def test_photo_network_and_storage_failures_are_not_expected_invalidation(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        for failure in (TDLibError(500, "offline"), OSError("storage unavailable")):
            with self.subTest(failure=type(failure).__name__):
                self.client.handlers["downloadFile"] = failure
                with self.assertRaises(ClientError) as raised:
                    await self.service.photo(123, 2**40)
                self.assertNotEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertFalse(self.client.requests("openMessageContent"))

    async def test_photo_changes_at_access_and_open_and_deletion_during_download(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        file = self.downloaded_file(1, b"removed-photo-must-not-escape")
        for stage in ("access", "open", "delete"):
            with self.subTest(stage=stage):
                self.client.calls.clear()
                self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
                self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
                self.client.handlers["downloadFile"] = file
                self.client.handlers["openMessageContent"] = {"@type": "ok"}

                async def changed(_query):
                    await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content={"@type": "messageExpiredPhoto"})
                    return {"can_be_saved": True} if stage == "access" else {"@type": "ok"}

                async def deleted(_query):
                    await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[2**40], is_permanent=True)
                    return file

                if stage == "access":
                    self.client.handlers["getMessageProperties"] = changed
                elif stage == "open":
                    self.client.handlers["openMessageContent"] = changed
                else:
                    self.client.handlers["downloadFile"] = deleted
                with self.assertRaises(ClientError) as raised:
                    await self.service.photo(123, 2**40)
                self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
                if stage == "delete":
                    self.assertEqual(self.updates[-1], {"kind": "delete", "chat_id": 123, "ids": [2**40]})
                    self.assertNotIn((123, 2**40), self.service._messages)
                else:
                    self.assertFalse(self.updates[-1]["message"].photo)
                if stage != "open":
                    self.assertFalse(self.client.requests("openMessageContent"))
                if stage == "access":
                    self.assertFalse(self.client.requests("downloadFile"))

    async def test_uncached_photo_change_fetches_current_model_without_stale_resurrection(self):
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        current = message(content={"@type": "messageExpiredPhoto"})
        calls = 0

        async def lookup(_query):
            nonlocal calls
            calls += 1
            if calls == 1:
                await self.client.update("updateMessageContent", chat_id=123, message_id=2**40, new_content=current["content"])
                return {"messages": [message(content=content)]}
            return {"messages": [current]}

        self.client.handlers["getMessages"] = lookup
        with self.assertRaises(ClientError) as raised:
            await self.service.photo(123, 2**40)
        self.assertEqual(raised.exception.code, "MEDIA_CHANGED")
        self.assertEqual(calls, 2)
        self.assertFalse(self.updates[-1]["message"].photo)
        self.assertIsNone(self.updates[-1]["message"].media_id)
        self.assertEqual(self.service._messages[(123, 2**40)], current)
        self.assertFalse(self.client.requests("downloadFile"))

    async def test_download_rejects_database_files_outside_paths_traversal_and_symlinks(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (13, 11), (77, 77, 77)).save(stream, "JPEG")
        data = stream.getvalue()
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 13, "height": 11, "photo": {"id": 1}}]}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content)]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        await self.client.update("updateUser", user=user(profile_photo={"small": {"id": 1}}))
        database = self.service.data_dir / "tdlib/db"
        database.mkdir(parents=True)
        outside = self.root / "outside.jpg"
        forbidden = [outside, database / "db.sqlite", database / "td.binlog", database / "arbitrary.jpg"]
        for name in ("temp", "passport", "secret", "profile_photos-untrusted"):
            directory = database / name
            directory.mkdir()
            forbidden.append(directory / "image.jpg")
        for path in forbidden:
            # Valid image bytes ensure rejection is the path boundary, not decoding.
            path.write_bytes(data)
            path.chmod(0o644)
        paths = list(forbidden)
        for relative in ("tdlib/files", "tdlib/db/profile_photos", "tdlib/db/thumbnails", "tdlib/db/secret_thumbnails"):
            directory = self.service.data_dir / relative
            directory.mkdir(parents=True, exist_ok=True)
            safe = directory / "safe"
            safe.mkdir()
            (safe / "image.jpg").write_bytes(data)
            (directory / "outside-link").symlink_to(outside)
            (directory / "inside-link").symlink_to(safe / "image.jpg")
            (directory / "outside-nested").symlink_to(self.root, target_is_directory=True)
            (directory / "inside-nested").symlink_to(safe, target_is_directory=True)
            paths.extend((
                directory / "outside-link", directory / "inside-link",
                directory / "outside-nested/outside.jpg", directory / "inside-nested/image.jpg",
                directory / "safe/../safe/image.jpg",
                str(directory) + "/safe/./image.jpg",
                directory / ("../db/db.sqlite" if relative == "tdlib/files" else "../db.sqlite"),
            ))
        for path in paths:
            self.client.handlers["downloadFile"] = {"@type": "file", "id": 1, "local": {"path": str(path), "is_downloading_completed": True}}
            for method in ("photo", "avatar"):
                with self.subTest(path=path, method=method):
                    with self.assertRaises(ClientError) as raised:
                        if method == "photo":
                            await self.service.photo(123, 2**40)
                        else:
                            await self.service.avatar(42)
                    self.assertNotIn(str(path), str(raised.exception))
                    self.assertNotIn(base64.b64encode(data).decode(), str(raised.exception))
        self.assertFalse(self.client.requests("openMessageContent"))
        for path in forbidden:
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    async def test_album_expands_across_short_pages_and_actions_use_sorted_unique_ids(self):
        members = [message(item, media_album_id="9223372036854775807") for item in (2**40, 2**40 + 500, 2**40 + 9000)]
        all_messages = [message(1), *members, message(2**40 + 10000)]
        self.client.handlers["getMessages"] = lambda query: {"messages": [next(item for item in all_messages if item["id"] == key) for key in query["message_ids"]]}
        def history(query):
            anchor = query["from_message_id"]
            candidates = [item for item in all_messages if item["id"] > anchor] if query["offset"] < 0 else [item for item in all_messages if item["id"] < anchor]
            candidates.sort(key=lambda item: item["id"], reverse=query["offset"] == 0)
            return {"messages": candidates[:1]}
        self.client.handlers["getChatHistory"] = history
        self.client.handlers["getMessageProperties"] = {"can_be_deleted_for_all_users": True, "can_be_forwarded": True}
        records = await self.service.album(123, members[1]["id"])
        self.assertEqual([record.id for record in records], [item["id"] for item in members])
        self.assertTrue(all(record.grouped_id == "9223372036854775807" for record in records))
        await self.service.delete(123, [members[1]["id"], members[0]["id"], members[1]["id"]])
        self.assertEqual(self.client.requests("deleteMessages")[0]["message_ids"], [item["id"] for item in members])
        await self.client.update("updateNewChat", chat=chat(456, "Destination"))
        self.client.handlers["forwardMessages"] = {"messages": [message(item["id"] + 10000, chat_id=456, outgoing=True) for item in members]}
        forwarded = await self.service.forward(123, [members[1]["id"]], 456)
        self.assertEqual(len(forwarded), 3)
        self.assertEqual(self.client.requests("forwardMessages")[0]["message_ids"], [item["id"] for item in members])

    async def test_foreign_album_neighbor_and_unbounded_album_refuse_partial_action(self):
        seed = message(media_album_id="7")
        self.client.handlers["getMessages"] = {"messages": [seed]}
        self.client.handlers["getChatHistory"] = {"messages": [message(2**40 - 1, chat_id=777, media_album_id="7")]}
        with self.assertRaises(ClientError):
            await self.service.delete(123, [seed["id"]])
        self.assertFalse(self.client.requests("deleteMessages"))
        self.client.handlers["getChatHistory"] = {"messages": [message(2**40 - index, media_album_id="7") for index in range(1, 12)]}
        with self.assertRaises(ClientError):
            await self.service.album(123, seed["id"])

    async def test_same_message_id_deletion_remains_chat_scoped_and_cache_eviction_is_not_deletion(self):
        await self.client.update("updateNewChat", chat=chat(-1001234567890, "Channel"))
        await self.client.update("updateNewMessage", message=message())
        await self.client.update("updateNewMessage", message=message(chat_id=-1001234567890))
        self.updates.clear()
        await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[2**40], is_permanent=False, from_cache=True)
        self.assertEqual(self.updates, [])
        await self.client.update("updateDeleteMessages", chat_id=123, message_ids=[2**40], is_permanent=True, from_cache=False)
        self.assertEqual(self.updates[-1], {"kind": "delete", "chat_id": 123, "ids": [2**40]})
        self.assertIn((-1001234567890, 2**40), self.service._messages)


class TelegramAdditionalBehaviorTest(ServiceTestCase):
    async def test_dialog_pages_fill_short_loads_preserve_positions_and_offset_cursor(self):
        ids = [500, 900, 100, 700]
        remaining = iter(ids)
        async def load(_query):
            try:
                chat_id = next(remaining)
            except StopIteration:
                raise TDLibError(404, "All chats loaded")
            rank = 10000 - ids.index(chat_id)
            await self.client.update("updateNewChat", chat=chat(chat_id, f"Chat {chat_id}", positions=[{"list": {"@type": "chatListMain"}, "order": str(rank), "is_pinned": chat_id == 500}]))
            return {"@type": "ok"}
        self.client.handlers["loadChats"] = load
        self.client.handlers["getChats"] = lambda _query: {"@type": "chats", "chat_ids": [chat_id for chat_id in ids if chat_id in self.service._chats]}
        first = await self.service.dialogs(limit=2)
        self.assertEqual([record.id for record in first["dialogs"]], [500, 900])
        self.assertEqual(first["cursor"], {"offset": 2})
        second = await self.service.dialogs(first["cursor"], limit=2)
        self.assertEqual([record.id for record in second["dialogs"]], [100, 700])
        self.assertIsNone(second["cursor"])
        self.assertEqual(len(self.client.requests("loadChats")), 5)

    async def test_dialog_kinds_and_channel_post_rights_use_native_entity_roles(self):
        await self.client.update("updateNewChat", chat=chat(99, "Me", type={"@type": "chatTypePrivate", "user_id": 99}))
        self.assertEqual((await self.service.dialog(99)).kind, "saved")
        self.assertEqual((await self.service.dialog(99)).title, "Saved Messages")
        await self.client.update("updateUser", user=user(type={"@type": "userTypeBot"}))
        self.assertEqual((await self.service.dialog(123)).kind, "bot")
        await self.group(supergroup=True, channel=True)
        self.assertEqual((await self.service.dialog(-7)).kind, "channel")
        self.assertFalse((await self.service.dialog(-7)).writable)
        for permission in (False, True):
            await self.client.update("updateSupergroup", supergroup={"id": 7, "status": {"@type": "chatMemberStatusAdministrator", "rights": {"can_post_messages": permission}}})
            self.assertEqual((await self.service.dialog(-7)).writable, permission)
        await self.group()
        await self.client.update("updateChatPermissions", chat_id=-7, permissions={"can_send_basic_messages": False})
        self.assertFalse((await self.service.dialog(-7)).writable)
        self.assertTrue(self.updates[-1]["permissions_changed"])

    async def test_read_events_cannot_regress_int53_read_maximum(self):
        for kind, field, outbox in (("updateChatReadInbox", "last_read_inbox_message_id", False), ("updateChatReadOutbox", "last_read_outbox_message_id", True)):
            for maximum in (2**40 + 10, 2**40):
                await self.client.update(kind, chat_id=123, **{field: maximum}, **({} if outbox else {"unread_count": 0}))
            self.assertEqual(self.updates[-1]["max_id"], 2**40 + 10)
            self.assertTrue((await self.service._message(message(outgoing=outbox))).read)

    async def test_edit_checks_server_permission_and_preserves_reply_and_formatting(self):
        original = message(outgoing=True, reply_to={"@type": "messageReplyToMessage", "chat_id": 123, "message_id": 2**39})
        self.client.handlers["getMessages"] = {"messages": [original]}
        self.client.handlers["getMessageProperties"] = {"can_be_edited": False}
        with self.assertRaises(ClientError):
            await self.service.edit(123, 2**40, "**Changed**")
        self.assertFalse(self.client.requests("editMessageText"))
        self.client.handlers["getMessageProperties"] = {"can_be_edited": True}
        self.client.handlers["editMessageText"] = message(outgoing=True, reply_to=original["reply_to"], edit_date=1, content={"@type": "messageText", "text": {"text": "Changed", "entities": [{"offset": 0, "length": 7, "type": {"@type": "textEntityTypeBold"}}]}})
        edited = await self.service.edit(123, 2**40, "**Changed**")
        self.assertEqual((edited.text, edited.reply_to, edited.edited), ("Changed", 2**39, True))
        self.assertEqual(self.client.requests("editMessageText")[0]["input_message_content"]["text"]["text"], "Changed")

    async def test_retry_respects_native_cooldown_and_required_user_decisions(self):
        for fields, code in (({"retry_after": 12}, "TDLIB_RATE_LIMIT"), ({"need_drop_reply": True}, "SEND_RETRY_REQUIRES_DECISION"), ({"can_retry": False}, "SEND_RETRY_REQUIRES_DECISION")):
            token = (await self.service.prepare_send(123, "Keep", None))["token"]
            failed = message(outgoing=True, sending_state={"@type": "messageSendingStateFailed", "can_retry": True, "retry_after": 0, "error": {"code": 500, "message": "error"}, **fields})
            self.client.handlers["sendMessage"] = failed
            with self.assertRaises(ClientError):
                await self.service.send(123, "Keep", None, token)
            self.client.handlers["getMessage"] = failed
            with self.subTest(fields=fields), self.assertRaises(ClientError) as raised:
                await self.service.retry_send(123, token)
            self.assertEqual(raised.exception.code, code)
            if code == "TDLIB_RATE_LIMIT":
                self.assertEqual(retry_after(raised.exception), 12)
                self.assertEqual(retry_scope(raised.exception), "peer")
        self.assertFalse(self.client.requests("resendMessages"))

    async def test_abandon_restores_text_without_releasing_duplicate_protection(self):
        await self.service.save_state({"drafts": {"123": "New draft"}, "selected_id": 123, "pending_sends": {}})
        self.client.handlers["sendMessage"] = OSError("offline")
        token = (await self.service.prepare_send(123, "Older unsent text", None))["token"]
        with self.assertRaises(ClientError):
            await self.service.send(123, "Older unsent text", None, token)
        await self.service.abandon_send(123, token)
        state = await self.service.load_state()
        self.assertEqual(state["drafts"]["123"], "New draft\n\nOlder unsent text")
        self.assertEqual(state["pending_sends"], {})
        with self.assertRaises(ClientError):
            await self.service.send(123, "Older unsent text", None, token)
        self.assertEqual(len(self.client.requests("sendMessage")), 1)
        self.assertNotIn("Older unsent text", (self.service.data_dir / "tdlib/outbox.json").read_text())

    async def test_user_and_chat_avatars_use_distinct_tdlib_file_identity(self):
        from io import BytesIO
        from PIL import Image
        stream = BytesIO()
        Image.new("RGB", (32, 24)).save(stream, "JPEG")
        directory = self.service.data_dir / "tdlib/files"
        directory.mkdir(parents=True)
        file = directory / "avatar"
        file.write_bytes(stream.getvalue())
        self.client.handlers["downloadFile"] = {"local": {"path": str(file), "is_downloading_completed": True}}
        await self.client.update("updateUser", user=user(profile_photo={"small": {"id": 10}}))
        await self.client.update("updateNewChat", chat=chat(-1001234567890, "Channel", photo={"small": {"id": 20}}))
        private = await self.service.avatar(42)
        channel = await self.service.avatar(-1001234567890)
        self.assertEqual((private["width"], private["height"]), (32, 24))
        self.assertEqual(channel["data"], base64.b64encode(stream.getvalue()).decode())
        self.assertEqual([query["file_id"] for query in self.client.requests("downloadFile")], [10, 20])
        await self.client.update("updateUser", user=user(profile_photo=None))
        self.assertIsNone(await self.service.avatar(42))
        self.assertEqual(len(self.client.requests("downloadFile")), 2)

    async def test_permitted_self_destruct_full_photo_opens_content_but_preview_does_not(self):
        directory = self.service.data_dir / "tdlib/files"
        directory.mkdir(parents=True)
        file = directory / "permitted"
        file.write_bytes(b"photo-bytes")
        content = {"@type": "messagePhoto", "photo": {"sizes": [{"width": 320, "height": 240, "photo": {"id": 1}}]}}
        self.client.handlers["getMessages"] = {"messages": [message(content=content, self_destruct_type={"@type": "messageSelfDestructTypeTimer", "self_destruct_time": 60})]}
        self.client.handlers["getMessageProperties"] = {"can_be_saved": True}
        self.client.handlers["downloadFile"] = {"local": {"path": str(file), "is_downloading_completed": True}}
        self.assertIsNone(await self.service.photo(123, 2**40, True))
        self.assertFalse(self.client.requests("downloadFile"))
        full = await self.service.photo(123, 2**40)
        self.assertEqual((full["width"], full["height"]), (320, 240))
        self.assertEqual(base64.b64decode(full["data"]), b"photo-bytes")
        self.assertEqual(self.client.requests("openMessageContent"), [{"@type": "openMessageContent", "chat_id": 123, "message_id": 2**40}])
