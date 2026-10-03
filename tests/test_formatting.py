import unittest

from telethon import types

from terngram.formatting import display_markdown, parse_markdown
from terngram.telegram import ClientError, TelegramService


class MarkdownBehaviorTest(unittest.TestCase):
    def test_emoji_offsets_links_and_code_language_survive_edit_roundtrip(self):
        source = "😀 **bold** and *italic* [site](https://example.com)\n```python\nprint('🙂')\n```"
        text, entities = parse_markdown(source)
        self.assertEqual(text, "😀 bold and italic site\nprint('🙂')")
        bold = next(entity for entity in entities if isinstance(entity, types.MessageEntityBold))
        self.assertEqual((bold.offset, bold.length), (3, 4))
        pre = next(entity for entity in entities if isinstance(entity, types.MessageEntityPre))
        self.assertEqual(pre.language, "python")
        self.assertEqual(text.encode("utf-16-le")[pre.offset * 2:(pre.offset + pre.length) * 2].decode("utf-16-le"), "print('🙂')")
        rendered = display_markdown(text, entities)
        edited, edited_entities = parse_markdown(rendered)
        self.assertEqual(edited, text)
        link = next(entity for entity in edited_entities if isinstance(entity, types.MessageEntityTextUrl))
        self.assertEqual(link.url, "https://example.com")
        self.assertEqual(next(entity.language for entity in edited_entities if isinstance(entity, types.MessageEntityPre)), "python")

    def test_literal_markdown_and_backslashes_are_not_reinterpreted_on_edit(self):
        text = "A *literal* [brackets] <tag> and \\ path"
        edited, entities = parse_markdown(display_markdown(text, []))
        self.assertEqual(edited, text)
        self.assertEqual(entities, [])

    def test_message_limit_applies_to_content_not_formatting_markers(self):
        text, entities = TelegramService._compose("**" + "x" * 4096 + "**")
        self.assertEqual(text, "x" * 4096)
        self.assertEqual(entities[0].length, 4096)
        with self.assertRaises(ClientError):
            TelegramService._compose("**" + "🙂" * 2049 + "**")
