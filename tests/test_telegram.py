import asyncio
import base64
import json
import os
import stat
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from telethon import TelegramClient, errors, events, functions, types, utils

from terngram.telegram import ClientError, TelegramService, _protected, retry_after, retry_scope
from terngram.worker import serve


class CredentialSecurityTest(unittest.TestCase):
    def test_credentials_remain_private_and_symlinks_are_rejected(self):
        async def event(_chat_id):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private = root / "private"
            private.mkdir(mode=0o777)
            os.chmod(private, 0o777)
            service = TelegramService(private, event)
            service._store_credentials(12345, "a" * 32)
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


def message(message_id=9, chat_id=123, outgoing=False, **fields):
    values = dict(
        id=message_id, chat_id=chat_id, out=outgoing, message="Hello",
        sender=types.User(id=42, first_name="Alice"), media=None, action=None,
        date=datetime(2026, 10, 3, tzinfo=timezone.utc), edit_date=None,
        reply_to=None, fwd_from=None, forward=None, post_author=None,
    )
    values.update(fields)
    return SimpleNamespace(**values)


class TelegramBehaviorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.updates = []
        self.statuses = []

        async def updated(update):
            self.updates.append(update)

        async def status(connected):
            self.statuses.append(connected)

        self.service = TelegramService(self.root / "private", updated, status)
        self.client = AsyncMock()
        self.client.is_connected = Mock(return_value=True)
        self.client.add_event_handler = Mock()
        self.client._sender = SimpleNamespace(
            _reconnecting=False, _connection=SimpleNamespace(_connected=True),
        )
        self.service._client = self.client
        self.service._peers[123] = types.InputPeerUser(123, 456)

    async def test_error_diagnostics_keep_operation_and_cause_without_message_or_locals(self):
        secret = "private-message-and-api-hash"
        try:
            try:
                raise ValueError(secret)
            except ValueError:
                raise ClientError("Safe generic error") from None
        except ClientError as error:
            code = self.service.record_error("avatar", error)
        path = self.service.data_dir / "last-error.json"
        text = path.read_text()
        report = json.loads(text)
        self.assertEqual((report["operation"], report["kind"]), ("avatar", "ValueError"))
        self.assertEqual(report["frames"][-1]["file"], "test_telegram.py")
        self.assertNotIn(secret, text)
        self.assertNotIn(secret, code)
        self.assertNotIn(str(self.root), text)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    async def test_chat_info_reads_channel_count_and_keeps_unknown_distinct_from_zero(self):
        channel_id = utils.get_peer_id(types.PeerChannel(7))
        self.service._peers[channel_id] = types.InputPeerChannel(7, 77)
        for count in (42, 0, None):
            self.client.return_value = SimpleNamespace(full_chat=SimpleNamespace(participants_count=count))
            self.assertEqual(await self.service.chat_info(channel_id, refresh=True), {"participants_count": count})
        self.assertEqual(await self.service.chat_info(123), {"participants_count": None})
        self.assertEqual(self.client.await_count, 3)

    async def test_chat_info_counts_basic_group_participants_when_entity_count_is_missing(self):
        self.service._peers[-7] = types.InputPeerChat(7)
        self.client.return_value = SimpleNamespace(
            chats=[], full_chat=SimpleNamespace(participants=SimpleNamespace(participants=[1, 2, 3])),
        )
        self.assertEqual(await self.service.chat_info(-7), {"participants_count": 3})

    async def test_unavailable_peer_metadata_is_cached_as_unknown_without_hiding_network_failures(self):
        channel_id = utils.get_peer_id(types.PeerChannel(7))
        self.service._peers[channel_id] = types.InputPeerChannel(7, 77)
        self.client.side_effect = errors.ChannelPrivateError(request=None)
        self.assertEqual(await self.service.chat_info(channel_id), {"participants_count": None})
        self.assertEqual(await self.service.chat_info(channel_id), {"participants_count": None})
        self.client.assert_awaited_once()
        self.assertIsNone(await self.service.dialog(channel_id))
        self.client.side_effect = ConnectionError("offline")
        with self.assertRaises(ClientError):
            await self.service.dialog(channel_id)

    async def test_chat_info_is_single_flight_and_invalidated_only_for_changed_chat(self):
        self.service._peers[-7] = types.InputPeerChat(7)
        self.client.return_value = SimpleNamespace(
            chats=[], full_chat=SimpleNamespace(participants=SimpleNamespace(participants=[1, 2])),
        )
        results = await asyncio.gather(self.service.chat_info(-7), self.service.chat_info(-7))
        self.assertEqual(results, [{"participants_count": 2}] * 2)
        self.client.assert_awaited_once()
        await self.service._metadata_update(types.UpdateUserStatus(123, types.UserStatusEmpty()))
        await self.service._metadata_update(types.UpdateChat(8))
        await self.service.chat_info(-7)
        self.client.assert_awaited_once()
        await self.service._metadata_update(types.UpdateChatParticipantAdd(7, 42, 1, datetime.now(timezone.utc), 2))
        await self.service.chat_info(-7)
        self.assertEqual(self.client.await_count, 2)
        self.assertEqual(self.updates[-1], {"kind": "dialog_changed", "chat_id": -7, "participants_changed": True})

    async def test_update_supersedes_inflight_full_chat_response(self):
        self.service._peers[-7] = types.InputPeerChat(7)
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def request(_request):
            nonlocal calls
            calls += 1
            count = calls
            if calls == 1:
                started.set()
                await release.wait()
            return SimpleNamespace(chats=[], full_chat=SimpleNamespace(
                participants=SimpleNamespace(participants=list(range(count))),
            ))

        self.client.side_effect = request
        pending = asyncio.create_task(self.service.chat_info(-7))
        await started.wait()
        await self.service._metadata_update(types.UpdateChat(7))
        release.set()
        self.assertEqual(await pending, {"participants_count": 2})
        self.assertEqual(calls, 2)

    async def test_service_titles_survive_membership_updates_and_old_dialog_snapshots(self):
        entity = types.Chat(id=7, title="Old", photo=types.ChatPhotoEmpty(), participants_count=2, date=datetime.now(timezone.utc), version=1)
        record = SimpleNamespace(peer=types.PeerChat(7), read_outbox_max_id=0, read_inbox_max_id=0, unread_count=0, top_message=0)
        self.service._dialog(entity, record, None)
        await self.service._service_metadata(-7, message(action=types.MessageActionChatEditTitle("New")))
        await self.service._service_metadata(-7, message(action=types.MessageActionChatAddUser([42])))
        entity.title = "Old snapshot"
        self.assertEqual(self.service._dialog(entity, record, None).title, "New")
        self.assertEqual(self.updates[0], {"kind": "dialog_changed", "chat_id": -7, "title": "New"})
        await self.service._metadata_update(types.UpdateChat(7))
        self.assertNotIn(-7, self.service._avatar_entities)
        self.assertNotIn(-7, self.service._titles)
        self.assertTrue(self.updates[-1]["avatar_changed"])

    async def test_raw_user_name_keeps_marked_channel_identity_and_min_avatar(self):
        channel_id = utils.get_peer_id(types.PeerChannel(123))
        minimum = types.User(id=123, first_name="Old", min=True)
        channel = types.Channel(id=123, access_hash=7, title="Channel", photo=types.ChatPhotoEmpty(), date=datetime.now(timezone.utc), megagroup=True)
        self.service._avatar_entities.update({123: minimum, channel_id: channel})
        await self.service._metadata_update(types.UpdateUserName(123, "New", "Name", []))
        self.assertEqual(self.updates[-1], {"kind": "dialog_changed", "chat_id": 123, "title": "New Name"})
        self.assertIs(self.service._avatar_entities[123], minimum)
        self.assertIs(self.service._avatar_entities[channel_id], channel)
        await self.service._metadata_update(types.UpdateUser(123))
        self.assertNotIn(123, self.service._avatar_entities)
        self.assertIs(self.service._avatar_entities[channel_id], channel)
        self.service._me = minimum
        await self.service._metadata_update(types.UpdateUserName(123, "My", "Name", []))
        self.assertEqual(self.updates[-1]["title"], "Saved Messages")

    async def test_default_rights_update_invalidates_the_marked_peer_without_assuming_chat_id(self):
        for peer in (types.PeerChat(7), types.PeerChannel(7)):
            await self.service._metadata_update(types.UpdateChatDefaultBannedRights(
                peer=peer, default_banned_rights=types.ChatBannedRights(until_date=None, send_messages=True), version=1,
            ))
        self.assertEqual([update["chat_id"] for update in self.updates], [-7, utils.get_peer_id(types.PeerChannel(7))])
        self.assertTrue(all(update["kind"] == "dialog_changed" for update in self.updates))
        self.client.assert_not_awaited()

    async def test_own_participant_role_change_invalidates_permissions_but_other_members_do_not(self):
        self.service._me = types.User(id=1, first_name="Me")
        await self.service._metadata_update(types.UpdateChatParticipantAdmin(chat_id=7, user_id=1, is_admin=True, version=2))
        self.assertTrue(self.updates[-1]["permissions_changed"])
        await self.service._metadata_update(types.UpdateChatParticipantAdmin(chat_id=7, user_id=2, is_admin=True, version=3))
        self.assertTrue(self.updates[-1]["participants_changed"])
        self.assertNotIn("permissions_changed", self.updates[-1])

    async def test_service_title_change_is_observed_through_raw_updates(self):
        service = types.MessageService(
            id=9, peer_id=types.PeerChat(7), date=datetime.now(timezone.utc),
            action=types.MessageActionChatEditTitle("Renamed group"),
        )
        await self.service._metadata_update(types.UpdateNewMessage(service, pts=1, pts_count=1))
        self.assertEqual(self.updates, [{"kind": "dialog_changed", "chat_id": -7, "title": "Renamed group"}])
        self.assertEqual(self.service._titles[-7], "Renamed group")
        self.client.assert_not_awaited()

    async def test_fresh_sender_metadata_releases_an_invalidated_avatar_placeholder(self):
        sender = types.User(id=42, access_hash=456, min=True, first_name="Alice")
        await self.service._message(message(sender=sender), 123)
        await self.service._metadata_update(types.UpdateUser(user_id=42))
        self.assertIsNone(await self.service.avatar(42))
        self.updates.clear()
        await self.service._message(message(sender=sender), 123)
        self.assertEqual(self.updates, [{"kind": "dialog_changed", "chat_id": 42, "avatar_changed": True, "title": "Alice"}])
        self.assertNotIn(42, self.service._avatar_dirty)
        self.assertIs(self.service._avatar_entities[42], sender)

    async def test_readers_require_group_and_own_message_and_reset_on_account_transition(self):
        readers = SimpleNamespace(count=AsyncMock(return_value=2), supports_size=AsyncMock(return_value=True))
        self.service._readers = readers
        self.assertIsNone(await self.service.message_readers(123, 9))
        self.client.get_messages.assert_not_awaited()
        self.service._peers[-7] = types.InputPeerChat(7)
        self.service._chat_info[-7] = {"participants_count": 3}
        self.client.get_messages.return_value = [message(9, -7, outgoing=False)]
        self.assertIsNone(await self.service.message_readers(-7, 9))
        self.client.get_messages.return_value = [message(9, -7, outgoing=True)]
        self.service._chat_info[-7] = {"participants_count": 3}
        self.assertEqual(await self.service.message_readers(-7, 9), 2)
        readers.count.assert_awaited_once_with(types.InputPeerChat(7), self.client.get_messages.return_value[0], 3)
        self.service._full_chats[-7] = SimpleNamespace(participants_hidden=True)
        self.assertIsNone(await self.service.message_readers(-7, 9))
        self.assertEqual(readers.count.await_count, 1)
        self.service._clear_account()
        self.assertIsNone(self.service._readers)
        self.assertEqual(self.service._chat_info, {})
        self.assertEqual(self.service._full_chats, {})

    async def test_reader_config_update_invalidates_only_reader_config(self):
        self.service._readers = SimpleNamespace(invalidate_config=Mock())
        self.service._chat_info[-7] = {"participants_count": 3}
        await self.service._metadata_update(types.UpdateConfig())
        self.service._readers.invalidate_config.assert_called_once_with()
        self.assertEqual(self.service._chat_info[-7], {"participants_count": 3})
        self.assertEqual(self.updates, [])

    async def test_cooldown_metadata_uses_only_actual_server_wait_root_cause(self):
        for kind in (errors.FloodWaitError, errors.FloodPremiumWaitError, errors.SlowModeWaitError):
            try:
                async with _protected():
                    raise kind(request=None, capture=17)
            except ClientError as error:
                self.assertEqual(retry_after(error), 17)
                self.assertEqual(retry_scope(error), "peer" if kind is errors.SlowModeWaitError else "method")
                code = self.service.record_error("chat_info", error)
                self.assertIn(kind.__name__, code)
                report = (self.service.data_dir / "last-error.json").read_text()
                self.assertNotIn("seconds", report)
        self.assertIsNone(retry_after(ClientError("Wait 17 seconds")))
        error = ClientError("Safe")
        error.__context__ = error
        self.assertIsNone(retry_after(error))

    async def test_dialog_kind_distinguishes_bots_groups_channels_and_saved(self):
        self.service._me = types.User(id=1, access_hash=10, first_name="Me")
        entities = [
            (self.service._me, "saved"),
            (types.User(id=2, access_hash=20, first_name="Alice"), "user"),
            (types.User(id=3, access_hash=30, first_name="Bot", bot=True), "bot"),
            (types.Chat(id=4, title="Group", photo=types.ChatPhotoEmpty(), participants_count=2, date=datetime.now(timezone.utc), version=1), "group"),
            (types.Channel(id=5, access_hash=50, title="Supergroup", photo=types.ChatPhotoEmpty(), date=datetime.now(timezone.utc), megagroup=True), "group"),
            (types.Channel(id=6, access_hash=60, title="News", photo=types.ChatPhotoEmpty(), date=datetime.now(timezone.utc), broadcast=True), "channel"),
        ]
        for entity, kind in entities:
            with self.subTest(kind=kind, id=entity.id):
                record = SimpleNamespace(peer=utils.get_peer(entity), read_outbox_max_id=0, read_inbox_max_id=0, unread_count=3, top_message=0)
                dialog = self.service._dialog(entity, record, None)
                self.assertEqual(dialog.kind, kind)
                self.assertEqual(dialog.unread_count, 3)

    async def test_live_message_populates_sender_and_edit_reply_forward_metadata(self):
        incoming = message(
            sender=None, get_sender=AsyncMock(return_value=types.User(id=42, first_name="Alice")),
            edit_date=datetime.now(timezone.utc), reply_to=SimpleNamespace(reply_to_msg_id=7),
            grouped_id=9223372036854775806,
            fwd_from=SimpleNamespace(from_name="Hidden author"),
        )
        await self.service._update(SimpleNamespace(chat_id=123, input_chat=None, message=incoming))
        self.assertEqual(len(self.updates), 1)
        update = self.updates[0]
        self.assertEqual((update["kind"], update["chat_id"]), ("message", 123))
        self.assertEqual(update["message"].sender, "Alice")
        self.assertEqual(update["message"].reply_to, 7)
        self.assertEqual(update["message"].forwarded, "Hidden author")
        self.assertTrue(update["message"].edited)
        self.assertEqual(update["message"].grouped_id, "9223372036854775806")
        self.client.get_messages.assert_not_awaited()

    async def test_private_deletion_does_not_confuse_matching_channel_message_ids(self):
        channel_id = utils.get_peer_id(types.PeerChannel(321))
        await self.service._message(message(9, 123), 123)
        await self.service._message(message(9, channel_id), channel_id)
        await self.service._update(events.MessageDeleted.Event([9, 99], peer=None))
        self.assertEqual(self.updates, [
            {"kind": "delete", "chat_id": 123, "ids": [9]},
            {"kind": "delete", "chat_id": 0, "ids": [99]},
        ])
        self.updates.clear()
        await self.service._update(events.MessageDeleted.Event([9], types.PeerChannel(321)))
        self.assertEqual(self.updates, [{"kind": "delete", "chat_id": channel_id, "ids": [9]}])

    async def test_history_uses_actual_read_maxima_and_read_events_are_monotonic(self):
        # An event can arrive before the initial dialog snapshot.
        await self.service._update(events.MessageRead.Event(types.PeerUser(123), 7, out=True))
        self.client.return_value = SimpleNamespace(dialogs=[
            SimpleNamespace(peer=types.PeerUser(123), read_outbox_max_id=5, read_inbox_max_id=4),
        ])
        self.client.get_messages.return_value = [message(9, outgoing=True), message(7, outgoing=True)]
        history = await self.service.history(123)
        self.assertEqual([(item.id, item.read) for item in history], [(7, True), (9, False)])
        self.client.assert_awaited_once()
        await self.service._update(events.MessageRead.Event(types.PeerUser(123), 9, out=True))
        await self.service._update(events.MessageRead.Event(types.PeerUser(123), 8, out=True))
        self.assertEqual(self.updates[-1], {"kind": "read", "chat_id": 123, "max_id": 9, "outbox": True})
        edited = await self.service._message(message(9, outgoing=True, edit_date=datetime.now(timezone.utc)), 123)
        self.assertTrue(edited.read)
        # Reading a voice-note's contents is not a history read receipt.
        count = len(self.updates)
        await self.service._update(events.MessageRead.Event(types.PeerUser(123), message_ids=[12], contents=True))
        self.assertEqual(len(self.updates), count)

    async def test_account_wide_message_ids_cannot_delete_or_reply_in_wrong_chat(self):
        self.client.get_messages.return_value = [message(9, chat_id=777)]
        with self.assertRaises(ClientError):
            await self.service.delete(123, [9])
        with self.assertRaises(ClientError):
            await self.service.send(123, "Reply", 9, "123456")
        self.client.delete_messages.assert_not_awaited()
        self.client.assert_not_awaited()

    def album_history(self, entries):
        def iterator(_peer, *, offset_id, reverse, limit):
            neighbors = sorted(
                (entry for entry in entries if (entry.id > offset_id if reverse else entry.id < offset_id)),
                key=lambda entry: entry.id, reverse=not reverse,
            )[:limit]

            async def history():
                for entry in neighbors:
                    yield entry

            return history()

        self.client.iter_messages = Mock(side_effect=iterator)

    async def test_album_crosses_history_page_boundary_and_account_wide_id_gaps(self):
        members = [message(item, grouped_id=77) for item in (20, 500, 9000)]
        self.album_history([message(1), *members, message(10000)])
        self.service._read_loaded.add(123)
        self.client.get_messages.return_value = [members[1]]
        page = await self.service.history(123, limit=1)
        self.assertEqual([item.id for item in page], [500])
        complete = await self.service.album(123, 500)
        self.assertEqual([item.id for item in complete], [20, 500, 9000])
        self.client.get_messages.assert_awaited_with(self.service._peers[123], ids=[500])
        self.assertEqual(self.client.iter_messages.call_count, 2)

    async def test_delete_and_forward_expand_albums_and_deduplicate_in_selection_order(self):
        members = [message(item, grouped_id=77) for item in (20, 500, 9000)]
        single = message(10000)
        self.album_history([message(1), *members, single])
        self.client.get_messages.return_value = [single, members[1], members[0]]
        self.service._peers[999] = types.InputPeerUser(999, 888)
        self.client.forward_messages.return_value = [message(item, 999, outgoing=True) for item in (10000, 20, 500, 9000)]
        forwarded = await self.service.forward(123, [10000, 500, 20, 500], 999)
        self.assertEqual([item.id for item in forwarded], [10000, 20, 500, 9000])
        self.client.forward_messages.assert_awaited_once_with(
            self.service._peers[999], [10000, 20, 500, 9000], from_peer=self.service._peers[123],
        )
        await self.service.delete(123, [10000, 500, 20, 500])
        self.client.delete_messages.assert_awaited_once_with(
            self.service._peers[123], [10000, 20, 500, 9000], revoke=True,
        )
        self.assertEqual(self.updates[-1]["ids"], [10000, 20, 500, 9000])

    async def test_album_rejects_foreign_seed_and_foreign_neighbor_before_actions(self):
        self.client.get_messages.return_value = [message(500, 777, grouped_id=77)]
        with self.assertRaises(ClientError):
            await self.service.album(123, 500)
        self.client.get_messages.return_value = [message(500, grouped_id=77)]
        self.album_history([message(20, 777, grouped_id=77)])
        for action in (
            self.service.album(123, 500), self.service.delete(123, [500]),
            self.service.forward(123, [500], 999),
        ):
            with self.assertRaises(ClientError):
                await action
        self.client.delete_messages.assert_not_awaited()
        self.client.forward_messages.assert_not_awaited()

    async def test_album_refuses_unbounded_group_instead_of_partial_action(self):
        members = [message(item * 100, grouped_id=77) for item in range(1, 13)]
        self.album_history(members)
        self.client.get_messages.return_value = [members[0]]
        with self.assertRaises(ClientError):
            await self.service.delete(123, [100])
        self.client.delete_messages.assert_not_awaited()

    async def test_send_uses_same_raw_random_id_formatting_and_reply_on_retry(self):
        self.client.get_messages.return_value = [message(7)]
        self.client._self_id = 1
        self.client._mb_entity_cache.get = Mock(return_value=None)
        self.client.return_value = types.UpdateShortSentMessage(
            id=10, pts=1, pts_count=1, date=datetime.now(timezone.utc), out=True,
        )
        for _ in range(2):
            sent = await self.service.send(123, "**Hello**", 7, "9223372036854775807")
            self.assertEqual((sent.id, sent.text, sent.reply_to), (10, "Hello", 7))
        for call in self.client.await_args_list:
            request = call.args[0]
            self.assertIsInstance(request, functions.messages.SendMessageRequest)
            self.assertEqual(request.random_id, 9223372036854775807)
            self.assertEqual(request.message, "Hello")
            self.assertTrue(request.no_webpage)
            self.assertEqual(request.reply_to.reply_to_msg_id, 7)
            self.assertIsInstance(request.entities[0], types.MessageEntityBold)
        self.client.send_message.assert_not_awaited()

    async def test_saved_message_short_response_uses_the_known_self_id(self):
        self.service._peers[123] = types.InputPeerSelf()
        self.service._me = types.User(id=123, is_self=True, first_name="Me")
        self.client._self_id = 123
        self.client._mb_entity_cache.get = Mock(return_value=None)
        self.client.return_value = types.UpdateShortSentMessage(
            id=11, pts=1, pts_count=1, date=datetime.now(timezone.utc), out=True,
        )
        sent = await self.service.send(123, "Saved message", None, "456")
        self.assertEqual((sent.chat_id, sent.id, sent.text, sent.sender_id), (123, 11, "Saved message", 123))

    async def test_send_extracts_full_updates_using_random_id_mapping(self):
        self.client._self_id = 1
        self.client._mb_entity_cache.get = Mock(return_value=None)
        self.client._get_response_message = lambda request, result, peer: TelegramClient._get_response_message(self.client, request, result, peer)
        sent = types.Message(id=10, peer_id=types.PeerUser(123), message="Hello", out=True, date=datetime.now(timezone.utc))
        unrelated = types.Message(id=11, peer_id=types.PeerUser(123), message="Unrelated", out=True, date=datetime.now(timezone.utc))
        self.client.return_value = types.Updates(
            updates=[
                types.UpdateMessageID(id=10, random_id=123456),
                types.UpdateNewMessage(message=unrelated, pts=1, pts_count=1),
                types.UpdateNewMessage(message=sent, pts=2, pts_count=1),
            ], users=[], chats=[], date=datetime.now(timezone.utc), seq=1,
        )
        result = await self.service.send(123, "Hello", None, "123456")
        self.assertEqual((result.id, result.text), (10, "Hello"))

    async def test_send_rejects_malformed_random_ids_before_network_access(self):
        for value in (None, 1, True, "", "0", "-1", "+1", "01", " 1", "1.0", "١", "9223372036854775808", "9" * 100):
            with self.subTest(value=value), self.assertRaises(ClientError):
                await self.service.send(123, "Hello", None, value)
        self.client.assert_not_awaited()
        self.client.get_messages.assert_not_awaited()

    async def test_media_identity_changes_when_same_message_image_is_edited(self):
        def photo(photo_id):
            return types.MessageMediaPhoto(photo=types.Photo(
                id=photo_id, access_hash=2, file_reference=b"", date=datetime.now(timezone.utc), dc_id=1, sizes=[],
            ))

        original = await self.service._message(message(media=photo(100)), 123)
        edited = await self.service._message(message(media=photo(101), edit_date=datetime.now(timezone.utc)), 123)
        plain = await self.service._message(message(), 123)
        document = types.Document(
            id=200, access_hash=2, file_reference=b"", date=datetime.now(timezone.utc),
            mime_type="image/png", size=20, dc_id=1, attributes=[],
        )
        image_document = await self.service._message(message(media=types.MessageMediaDocument(document=document)), 123)
        self.assertEqual((original.media_id, edited.media_id, plain.media_id, image_document.media_id), ("100", "101", None, "200"))


    async def test_min_sender_avatar_uses_message_entity_without_resolving_a_bare_id(self):
        sender = types.User(
            id=42, access_hash=456, min=True, first_name="Alice",
            photo=types.UserProfilePhoto(photo_id=789, dc_id=2),
        )
        await self.service._message(message(sender=sender), 123)
        self.client.get_input_entity.side_effect = ValueError("Cannot resolve this sender ID")
        jpeg = b"\xff\xd8\xff\xc0\x00\x07\x08\x00\x02\x00\x03"
        self.client.download_profile_photo.return_value = jpeg
        avatar = await self.service.avatar(42)
        self.assertEqual((avatar["width"], avatar["height"]), (3, 2))
        self.assertEqual(base64.b64decode(avatar["data"]), jpeg)
        self.client.get_input_entity.assert_not_awaited()
        self.client.download_profile_photo.assert_awaited_once_with(sender, file=bytes, download_big=False)
        self.assertIsNone(await self.service.avatar(999))
        self.assertEqual(self.client.download_profile_photo.await_count, 1)

    async def test_read_acknowledgement_accepts_false_but_never_claims_a_failed_rpc(self):
        self.client.send_read_acknowledge.side_effect = ConnectionError("offline")
        with self.assertRaises(ClientError):
            await self.service.mark_read(123, 9)
        self.assertNotIn(123, self.service._inbox_max)
        self.assertEqual(self.updates, [])
        self.client.send_read_acknowledge.side_effect = None
        self.client.send_read_acknowledge.return_value = False
        await self.service.mark_read(123, 9)
        await self.service.mark_read(123, 7)
        self.assertEqual(self.updates, [{"kind": "read", "chat_id": 123, "max_id": 9, "outbox": False}])
        self.assertEqual(self.client.send_read_acknowledge.await_count, 2)

    async def test_marked_peer_resolution_rejects_user_channel_cache_collision(self):
        self.service._peers.clear()
        channel_id = utils.get_peer_id(types.PeerChannel(123))
        self.client.get_input_entity.return_value = types.InputPeerUser(123, 456)
        self.client.session.get_input_entity = Mock(return_value=types.InputPeerChannel(123, 789))
        peer = await self.service._peer(channel_id)
        self.assertIsInstance(peer, types.InputPeerChannel)
        self.client.session.get_input_entity.assert_called_once()
        self.service._peers.clear()
        self.client.session.get_input_entity.return_value = types.InputPeerUser(123, 456)
        with self.assertRaises(ClientError):
            await self.service.send(channel_id, "Never send to the colliding user", None, "123456")
        self.client.assert_not_awaited()

    async def test_image_document_download_is_explicit_in_memory_and_header_dimensions_work(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + (80).to_bytes(4, "big") + (60).to_bytes(4, "big")
        document = types.Document(
            id=1, access_hash=2, file_reference=b"", date=datetime.now(timezone.utc),
            mime_type="image/png", size=len(png), dc_id=1, attributes=[],
        )
        photo_message = message(media=types.MessageMediaDocument(document=document))
        self.client.get_messages.return_value = [photo_message]
        metadata = await self.service._message(photo_message, 123)
        self.assertTrue(metadata.photo)
        self.client.download_media.assert_not_awaited()
        self.client.download_media.return_value = png
        result = await self.service.photo(123, 9)
        self.assertEqual(result, {"data": base64.b64encode(png).decode("ascii"), "mime": "image/png", "width": 80, "height": 60})
        self.client.download_media.assert_awaited_once_with(photo_message, file=bytes, thumb=None)
        self.assertFalse(self.service.data_dir.exists())

    async def test_photo_preview_uses_the_smallest_sufficient_size_and_viewer_the_largest(self):
        photo = types.Photo(id=1, access_hash=2, file_reference=b"", date=datetime.now(timezone.utc), dc_id=1, sizes=[
            types.PhotoStrippedSize(type="i", bytes=b"\x01\x08\x08"),
            types.PhotoSize(type="s", w=90, h=67, size=1000),
            types.PhotoSize(type="x", w=800, h=600, size=40000),
            types.PhotoSize(type="m", w=320, h=240, size=9000),
            types.PhotoSizeProgressive(type="y", w=1280, h=960, sizes=[1, 2]),
        ])
        photo_message = message(media=types.MessageMediaPhoto(photo=photo))
        self.client.get_messages.return_value = [photo_message]
        self.client.download_media.return_value = b"jpeg"
        preview = await self.service.photo(123, 9, True)
        self.assertEqual((preview["width"], preview["height"], preview["mime"]), (320, 240, "image/jpeg"))
        self.client.download_media.assert_awaited_with(photo_message, file=bytes, thumb="m")
        full = await self.service.photo(123, 9)
        self.assertEqual((full["width"], full["height"]), (1280, 960))
        self.client.download_media.assert_awaited_with(photo_message, file=bytes, thumb="y")

    async def test_image_document_preview_prefers_thumbnail_and_never_downloads_original(self):
        thumbnail = types.PhotoSize(type="m", w=320, h=180, size=9000)
        document = types.Document(
            id=1, access_hash=2, file_reference=b"", date=datetime.now(timezone.utc),
            mime_type="image/png", size=5_000_000, dc_id=1, attributes=[], thumbs=[thumbnail],
        )
        document_message = message(media=types.MessageMediaDocument(document=document))
        self.client.get_messages.return_value = [document_message]
        self.client.download_media.return_value = b"jpeg"
        preview = await self.service.photo(123, 9, True)
        self.assertEqual((preview["width"], preview["height"], preview["mime"]), (320, 180, "image/jpeg"))
        self.client.download_media.assert_awaited_once_with(document_message, file=bytes, thumb="m")
        document.thumbs = None
        self.client.download_media.reset_mock()
        for size in (500, 5_000_000):
            document.size = size
            self.assertIsNone(await self.service.photo(123, 9, True))
        self.client.download_media.assert_not_awaited()

    async def test_chat_pages_keep_pinned_order_and_cursor_without_loading_the_account(self):
        self.client.get_me.return_value = types.User(id=123, access_hash=456, first_name="Me")
        ids = [500, 900, 100, 700]
        entries = []
        for index, chat_id in enumerate(ids):
            entity = types.User(id=chat_id, access_hash=chat_id, first_name=str(chat_id))
            record = SimpleNamespace(
                peer=types.PeerUser(chat_id), top_message=90 - index,
                unread_count=0, read_outbox_max_id=0, read_inbox_max_id=0,
            )
            entries.append(SimpleNamespace(
                id=chat_id, entity=entity, dialog=record,
                message=message(90 - index, chat_id=chat_id),
            ))

        def iterator(*, limit, offset_peer, **_kwargs):
            start = ids.index(offset_peer.user_id) + 1 if isinstance(offset_peer, types.InputPeerUser) else 0

            async def page():
                for entry in entries[start:start + limit]:
                    yield entry
            return page()

        self.client.iter_dialogs = Mock(side_effect=iterator)
        first = await self.service.dialogs(limit=2)
        second = await self.service.dialogs(first["cursor"], limit=2)
        end = await self.service.dialogs(second["cursor"], limit=2)
        self.assertEqual([dialog.id for dialog in first["dialogs"]], [123, 500, 900])
        self.assertEqual([dialog.id for dialog in second["dialogs"]], [100, 700])
        self.assertEqual(end, {"dialogs": [], "cursor": None})

    async def test_transport_status_is_false_while_telethon_is_reconnecting(self):
        await self.service._connection_status()
        self.client._sender._reconnecting = True
        await self.service._connection_status()
        self.client._sender._reconnecting = False
        self.client._sender._connection._connected = False
        await self.service._connection_status()
        self.client._sender._connection._connected = True
        await self.service._connection_status()
        self.assertEqual(self.statuses, [True, False, True])

    async def test_state_is_private_atomic_account_scoped_and_contains_no_history(self):
        self.assertEqual(await self.service.load_state(), {"drafts": {}, "selected_id": None, "pending_sends": {}})
        await self.service.save_state({"drafts": {"123": "draft\ntext"}, "selected_id": 123, "history": ["not stored"]})
        state_file = self.service.data_dir / "state.json"
        self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.service.data_dir.stat().st_mode), 0o700)
        self.assertEqual(json.loads(state_file.read_text()), {"drafts": {"123": "draft\ntext"}, "selected_id": 123, "pending_sends": {}})
        self.assertEqual(await self.service.load_state(), {"drafts": {"123": "draft\ntext"}, "selected_id": 123, "pending_sends": {}})
        outside = self.root / "outside-state.json"
        state_file.rename(outside)
        os.chmod(outside, 0o644)
        state_file.symlink_to(outside)
        with self.assertRaises(ClientError) as raised:
            await self.service.load_state()
        self.assertNotIn(str(outside), str(raised.exception))
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o644)
        # An atomic replacement does not follow the symlink.
        await self.service.save_state({"drafts": {}, "selected_id": None})
        self.assertFalse(state_file.is_symlink())
        self.client.log_out.return_value = True
        await self.service.logout()
        self.assertFalse(state_file.exists())
        self.assertTrue(outside.exists())

    async def test_pending_sends_roundtrip_and_legacy_state_defaults(self):
        pending = {"123": {"text": "**Hello**", "reply_to": 7, "random_id": "9223372036854775807"}}
        state = {"drafts": {"123": "new draft"}, "selected_id": 123, "pending_sends": pending}
        await self.service.save_state(state)
        self.assertEqual(await self.service.load_state(), state)
        state_file = self.service.data_dir / "state.json"
        self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
        self.service._store_private("state.json", {"drafts": {}, "selected_id": None})
        self.assertEqual(await self.service.load_state(), {"drafts": {}, "selected_id": None, "pending_sends": {}})

    async def test_pending_sends_reject_invalid_records_without_replacing_saved_state(self):
        valid = {"text": "Hello", "reply_to": None, "random_id": "123456"}
        invalid = [
            {"0": valid}, {"123": {**valid, "random_id": "0"}},
            {"123": {**valid, "reply_to": True}}, {"123": {**valid, "text": ""}},
            {"123": {"text": "Hello", "random_id": "123456"}}, [],
        ]
        state = {"drafts": {}, "selected_id": None, "pending_sends": {"123": valid}}
        await self.service.save_state(state)
        for pending in invalid:
            with self.subTest(pending=pending), self.assertRaises(ClientError):
                await self.service.save_state({**state, "pending_sends": pending})
        self.assertEqual(await self.service.load_state(), state)


class WorkerConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_server_wait_metadata_reaches_worker_wire_without_rpc_inputs(self):
        finished = asyncio.Event()
        emitted = []
        calls = 0

        async def input_line(_readline):
            nonlocal calls
            calls += 1
            if calls == 1:
                return '{"id":1,"method":"history","args":[123]}\n'
            await finished.wait()
            return ""

        def capture(value):
            emitted.append(value)
            finished.set()

        class Service:
            def __init__(self, *_args):
                pass

            async def history(self, _chat_id):
                async with _protected():
                    raise errors.SlowModeWaitError(request="private-rpc-input", capture=23)

            def record_error(self, _method, _error):
                return "SlowModeWaitError"

            async def close(self):
                pass

        with patch("terngram.worker.TelegramService", Service), patch("terngram.worker.emit", side_effect=capture), patch("terngram.worker.asyncio.to_thread", side_effect=input_line):
            await serve(Path("/unused-test-directory"))
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["retry_after"], 23)
        self.assertEqual(emitted[0]["retry_scope"], "peer")
        self.assertNotIn("private-rpc-input", json.dumps(emitted))

    async def test_updates_and_sending_flow_during_history_and_auth_waits_for_requests(self):
        started = asyncio.Event()
        release = asyncio.Event()
        complete = asyncio.Event()
        history_finished = False
        emitted = []
        requests = iter([
            '{"id":1,"method":"history","args":[123]}\n',
            '{"id":2,"method":"send","args":[123,"Hello",null,"123456"]}\n',
            '{"id":3,"method":"connect","args":[]}\n',
        ])

        async def input_line(_readline):
            try:
                return next(requests)
            except StopIteration:
                await complete.wait()
                return ""

        class Service:
            def __init__(self, _directory, updated, _connection):
                self.updated = updated

            async def history(self, _chat_id):
                nonlocal history_finished
                started.set()
                await release.wait()
                history_finished = True
                return []

            async def send(self, _chat_id, _text, _reply_to, _random_id):
                await started.wait()
                await self.updated({"kind": "read", "chat_id": 123, "max_id": 7, "outbox": True})
                release.set()
                return {"id": 9}

            async def connect(self):
                self.assert_finished()
                complete.set()
                return True

            def assert_finished(self):
                if not history_finished:
                    raise AssertionError("Authentication raced an in-flight request")

            async def close(self):
                pass

        with patch("terngram.worker.TelegramService", Service), patch("terngram.worker.emit", side_effect=emitted.append), patch("terngram.worker.asyncio.to_thread", side_effect=input_line):
            await serve(Path("/unused-test-directory"))
        self.assertEqual(emitted[0], {"event": "update", "kind": "read", "chat_id": 123, "max_id": 7, "outbox": True})
        self.assertEqual([item["id"] for item in emitted if "id" in item], [2, 1, 3])
        self.assertTrue(emitted[-1]["result"])

    async def test_stdio_eof_cancels_pending_requests_before_closing_service(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        emitted = []
        calls = 0
        closed = False

        async def input_line(_readline):
            nonlocal calls
            calls += 1
            if calls == 1:
                return '{"id":1,"method":"history","args":[123]}\n'
            await started.wait()
            return ""

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
                    raise AssertionError("Service closed before its request was cancelled")
                closed = True

        with patch("terngram.worker.TelegramService", Service), patch("terngram.worker.emit", side_effect=emitted.append), patch("terngram.worker.asyncio.to_thread", side_effect=input_line):
            await serve(Path("/unused-test-directory"))
        self.assertTrue(closed)
        self.assertEqual(emitted, [])


if __name__ == "__main__":
    unittest.main()
