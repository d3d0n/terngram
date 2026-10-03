"""Offline transport checks against an injected C JSON API, not Telegram accounts."""

import asyncio
import json
import queue
import threading
import unittest

from terngram.tdlib import TDLib, TDLibError


class JSONAPI:
    """A controllable, thread-safe TDLib JSON boundary with real send/receive queues."""

    def __init__(self):
        self.incoming = queue.Queue()
        self.outgoing = asyncio.Queue()
        self.trace = []
        self.active = set()
        self.next_id = 1
        self.version = "1.8.67"
        self.auto_version = True
        self.auto_close = True
        self.send_errors = set()
        self.execute_result = {"@type": "ok"}
        self.initialized = set()
        self.lock = threading.Lock()
        self.receiving = 0
        self.maximum_receivers = 0

    def td_create_client_id(self):
        client_id = self.next_id
        self.next_id += 1
        self.active.add(client_id)
        self.trace.append(("create", client_id))
        return client_id

    def td_send(self, client_id, raw):
        request = json.loads(raw)
        self.trace.append(("send", client_id, request))
        if request["@type"] in self.send_errors:
            raise RuntimeError("private input must not become diagnostics")
        self.outgoing.put_nowait((client_id, request))
        if client_id not in self.initialized:
            self.initialized.add(client_id)
            self.emit(client_id, {
                "@type": "updateAuthorizationState",
                "authorization_state": {"@type": "authorizationStateWaitTdlibParameters"},
            })
        if request["@type"] == "getOption" and self.auto_version:
            self.respond(client_id, request, {"@type": "optionValueString", "value": self.version})
        elif request["@type"] == "getAuthorizationState":
            self.respond(client_id, request, {"@type": "authorizationStateWaitTdlibParameters"})
        elif request["@type"] == "close" and self.auto_close:
            self.respond(client_id, request, {"@type": "ok"})
            self.closed(client_id)

    def td_receive(self, timeout):
        with self.lock:
            self.receiving += 1
            self.maximum_receivers = max(self.maximum_receivers, self.receiving)
        try:
            try:
                value = self.incoming.get(timeout=timeout)
            except queue.Empty:
                return None
            if value.get("authorization_state", {}).get("@type") == "authorizationStateClosed":
                self.active.discard(value["@client_id"])
            return json.dumps(value).encode()
        finally:
            with self.lock:
                self.receiving -= 1

    def td_execute(self, raw):
        request = json.loads(raw)
        self.trace.append(("execute", request))
        result = {"@type": "ok"} if request["@type"].startswith("setLog") else self.execute_result
        return json.dumps(result).encode()

    def emit(self, client_id, value):
        self.incoming.put({**value, "@client_id": client_id})

    def respond(self, client_id, request, value):
        self.emit(client_id, {**value, "@extra": request["@extra"]})

    def closed(self, client_id):
        self.emit(client_id, {
            "@type": "updateAuthorizationState",
            "authorization_state": {"@type": "authorizationStateClosed"},
        })

    async def sent(self, method):
        while True:
            item = await asyncio.wait_for(self.outgoing.get(), 2)
            if item[1]["@type"] == method:
                return item


class TDLibTransportTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.api = JSONAPI()
        self.clients = []
        self.updates = []
        self.initial_update = asyncio.Event()

        async def updated(value):
            self.updates.append(value)
            self.initial_update.set()

        self.updated = updated

    def client(self, callback=None):
        client = TDLib(callback or self.updated, _api=self.api)
        self.clients.append(client)
        return client

    async def asyncTearDown(self):
        self.api.auto_close = True
        for client in self.clients:
            await asyncio.wait_for(client.close(), 2)
        self.assertFalse(self.api.active)
        self.assertEqual(self.api.receiving, 0)
        self.assertEqual(self.api.maximum_receivers, 1)

    async def test_start_disables_logs_and_delivers_initial_authorization(self):
        client = self.client()
        await client.start()
        await asyncio.wait_for(self.initial_update.wait(), 2)
        self.assertEqual(self.api.trace[:3], [
            ("execute", {"@type": "setLogStream", "log_stream": {"@type": "logStreamEmpty"}}),
            ("execute", {"@type": "setLogVerbosityLevel", "new_verbosity_level": 0}),
            ("create", 1),
        ])
        self.assertEqual(self.updates, [{
            "@type": "updateAuthorizationState",
            "authorization_state": {"@type": "authorizationStateWaitTdlibParameters"},
        }])
        await client.start()
        self.assertEqual(self.api.next_id, 2)

    async def test_out_of_order_responses_preserve_requests_and_match_extra(self):
        client = self.client()
        await client.start()
        original = {"@type": "first", "@extra": "caller-value", "text": "private"}
        first = asyncio.create_task(client.request(original))
        second = asyncio.create_task(client.request({"@type": "second"}))
        client_id, first_request = await self.api.sent("first")
        _, second_request = await self.api.sent("second")
        self.assertNotEqual(first_request["@extra"], second_request["@extra"])
        self.api.respond(client_id, second_request, {"@type": "answer", "value": 2})
        self.api.respond(client_id, first_request, {"@type": "answer", "value": 1})
        self.assertEqual(await second, {"@type": "answer", "value": 2})
        self.assertEqual(await first, {"@type": "answer", "value": 1})
        self.assertEqual(original["@extra"], "caller-value")
        self.assertEqual(original["text"], "private")

    async def test_callback_can_await_request_without_reordering_updates(self):
        order = []
        finished = asyncio.Event()
        client = None

        async def updated(value):
            if value["@type"] == "firstUpdate":
                order.append("first-begin")
                result = await client.request({"@type": "nestedRequest"})
                order.append(result["value"])
                order.append("first-end")
            elif value["@type"] == "secondUpdate":
                order.append("second")
                finished.set()

        client = self.client(updated)
        await client.start()
        self.api.emit(1, {"@type": "firstUpdate"})
        client_id, request = await self.api.sent("nestedRequest")
        self.api.emit(client_id, {"@type": "secondUpdate"})
        self.api.respond(client_id, request, {"@type": "answer", "value": "response"})
        await asyncio.wait_for(finished.wait(), 2)
        self.assertEqual(order, ["first-begin", "response", "first-end", "second"])

    async def test_request_error_has_code_message_and_retry_after(self):
        client = self.client()
        await client.start()
        pending = asyncio.create_task(client.request({"@type": "limited"}))
        client_id, request = await self.api.sent("limited")
        self.api.respond(client_id, request, {
            "@type": "error", "code": 429, "message": "Too Many Requests: retry after 17",
        })
        with self.assertRaises(TDLibError) as caught:
            await pending
        self.assertEqual(caught.exception.code, 429)
        self.assertEqual(caught.exception.message, "Too Many Requests: retry after 17")
        self.assertEqual(caught.exception.retry_after, 17.0)
        self.assertIsNone(TDLibError(400, "Bad Request").retry_after)
        self.assertEqual(TDLibError(420, "FLOOD_WAIT_8").retry_after, 8.0)

    async def test_cancelled_request_late_response_is_not_an_update(self):
        seen = asyncio.Event()

        async def updated(value):
            self.updates.append(value)
            if value["@type"] == "barrier":
                seen.set()

        client = self.client(updated)
        await client.start()
        pending = asyncio.create_task(client.request({"@type": "cancelled"}))
        client_id, request = await self.api.sent("cancelled")
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.api.respond(client_id, request, {"@type": "lateResponse"})
        self.api.emit(client_id, {"@type": "barrier"})
        await asyncio.wait_for(seen.wait(), 2)
        self.assertNotIn("lateResponse", [value["@type"] for value in self.updates])
        self.assertFalse(client._client.pending)

    async def test_close_rejects_pending_and_waits_for_native_closed(self):
        client = self.client()
        await client.start()
        session = client._client
        self.api.auto_close = False
        pending = asyncio.create_task(client.request({"@type": "unanswered"}))
        await self.api.sent("unanswered")
        closing = asyncio.create_task(client.close())
        client_id, _ = await self.api.sent("close")
        with self.assertRaises(TDLibError) as caught:
            await pending
        self.assertEqual(caught.exception.code, 503)
        with self.assertRaises(TDLibError):
            await client.request({"@type": "afterClose"})
        self.assertFalse(closing.done())
        self.api.closed(client_id)
        await asyncio.wait_for(closing, 2)
        self.assertTrue(session.worker.done())
        self.assertFalse(session.thread.is_alive())
        self.assertFalse(session.pending)
        await client.close()
        close_sends = [item for item in self.api.trace if item[0] == "send" and item[2]["@type"] == "close"]
        self.assertEqual(len(close_sends), 1)

    async def test_cancelled_close_waiter_does_not_cancel_native_shutdown(self):
        client = self.client()
        await client.start()
        session = client._client
        self.api.auto_close = False
        closing = asyncio.create_task(client.close())
        client_id, _ = await self.api.sent("close")
        closing.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertFalse(session._shutdown.cancelled())
        self.api.closed(client_id)
        await asyncio.wait_for(asyncio.shield(session._shutdown), 2)
        self.assertFalse(session.thread.is_alive())
        self.assertTrue(session.worker.done())

    async def test_callback_can_close_its_own_client(self):
        finished = asyncio.Event()
        client = None

        async def updated(value):
            if value["@type"] == "closeFromCallback":
                await client.close()
                finished.set()

        client = self.client(updated)
        await client.start()
        session = client._client
        self.api.emit(1, {"@type": "closeFromCallback"})
        await asyncio.wait_for(finished.wait(), 2)
        await asyncio.wait_for(session.worker, 2)
        self.assertFalse(session.thread.is_alive())

    async def test_reconnect_ignores_retired_client_updates_and_responses(self):
        fresh = asyncio.Event()

        async def updated(value):
            self.updates.append(value)
            if value["@type"] == "freshUpdate":
                fresh.set()

        client = self.client(updated)
        await client.start()
        old = client._client
        pending = asyncio.create_task(client.request({"@type": "oldRequest"}))
        old_id, request = await self.api.sent("oldRequest")
        await client.close()
        with self.assertRaises(TDLibError):
            await pending
        await client.start()
        new_id = client._client.client_id
        self.assertNotEqual(old_id, new_id)
        self.api.respond(old_id, request, {"@type": "retiredResponse"})
        self.api.emit(old_id, {"@type": "retiredUpdate"})
        self.api.emit(new_id, {"@type": "freshUpdate"})
        await asyncio.wait_for(fresh.wait(), 2)
        self.assertNotIn("retiredUpdate", [value["@type"] for value in self.updates])
        self.assertNotIn("retiredResponse", [value["@type"] for value in self.updates])
        self.assertFalse(old.thread.is_alive())

    async def test_multiple_clients_share_one_receiver_and_close_independently(self):
        first = self.client()
        second = self.client()
        await first.start()
        await second.start()
        first_session = first._client
        second_session = second._client
        self.assertIs(first_session.thread, second_session.thread)
        await first.close()
        self.assertTrue(second_session.thread.is_alive())
        pending = asyncio.create_task(second.request({"@type": "survivor"}))
        client_id, request = await self.api.sent("survivor")
        self.api.respond(client_id, request, {"@type": "ok"})
        self.assertEqual(await pending, {"@type": "ok"})
        await second.close()
        self.assertFalse(second_session.thread.is_alive())

    async def test_start_checks_version_before_delivering_updates(self):
        client = self.client()
        self.api.auto_version = False
        starting = asyncio.create_task(client.start())
        client_id, request = await self.api.sent("getOption")
        self.assertFalse(self.updates)
        self.api.respond(client_id, request, {"@type": "optionValueString", "value": "1.8.0"})
        with self.assertRaises(TDLibError) as caught:
            await asyncio.wait_for(starting, 2)
        self.assertIn("1.8.67", caught.exception.message)
        self.assertIn("brew install tdlib --HEAD", caught.exception.message)
        self.assertFalse(self.updates)
        self.assertFalse(self.api.active)

    async def test_cancelled_start_closes_native_client(self):
        client = self.client()
        self.api.auto_version = False
        starting = asyncio.create_task(client.start())
        await self.api.sent("getOption")
        session = client._client
        starting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(starting, 2)
        self.assertFalse(self.api.active)
        self.assertFalse(session.thread.is_alive())
        self.assertTrue(session.worker.done())
        self.assertIsNone(client._client)

    async def test_callback_failure_closes_and_rejects_without_exposing_content(self):
        async def updated(value):
            if value["@type"] == "failUpdate":
                raise RuntimeError("secret login token")

        client = self.client(updated)
        await client.start()
        session = client._client
        pending = asyncio.create_task(client.request({"@type": "pending"}))
        client_id, _ = await self.api.sent("pending")
        self.api.emit(client_id, {"@type": "failUpdate"})
        with self.assertRaises(TDLibError) as caught:
            await asyncio.wait_for(pending, 2)
        self.assertEqual(caught.exception.message, "TDLib update handler failed.")
        await client.close()
        self.assertTrue(session.worker.done())
        self.assertFalse(session.thread.is_alive())

    async def test_send_failure_removes_pending_and_reports_safe_error(self):
        client = self.client()
        await client.start()
        self.api.send_errors.add("failSend")
        with self.assertRaises(TDLibError) as caught:
            await client.request({"@type": "failSend", "text": "private input"})
        self.assertEqual(caught.exception.message, "TDLib could not send the request.")
        self.assertFalse(client._client.pending)

    async def test_execute_matches_sync_result_and_raises_native_error(self):
        client = self.client()
        await client.start()
        self.api.execute_result = {"@type": "formattedText", "text": "bold", "entities": []}
        query = {"@type": "parseTextEntities", "text": "**bold**", "parse_mode": {"@type": "textParseModeMarkdown", "version": 2}}
        self.assertEqual(client.execute(query), self.api.execute_result)
        self.assertEqual(self.api.trace[-1], ("execute", query))
        self.api.execute_result = {"@type": "error", "code": 400, "message": "Invalid parse mode"}
        with self.assertRaises(TDLibError) as caught:
            client.execute(query)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(caught.exception.message, "Invalid parse mode")

    async def test_request_before_start_is_a_real_error(self):
        client = self.client()
        with self.assertRaises(TDLibError) as caught:
            await client.request({"@type": "getOption", "name": "version"})
        self.assertEqual(caught.exception.code, 503)
        self.assertFalse(self.api.trace)
        # Start here so teardown also verifies the receive-owner lifecycle.
        await client.start()
