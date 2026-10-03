import unittest

from terngram.formatting import display_markdown, parse_markdown
from terngram.telegram import ClientError, TelegramService


def entity(offset, length, kind, **fields):
    return {"@type": "textEntity", "offset": offset, "length": length,
            "type": {"@type": "textEntityType" + kind, **fields}}


class MarkdownBehaviorTest(unittest.TestCase):
    def test_emoji_offsets_links_and_code_language_survive_edit_roundtrip(self):
        source = "😀 **bold** and *italic* [site](https://example.com)\n```python\nprint('🙂')\n```"
        text, entities = parse_markdown(source)
        self.assertEqual(text, "😀 bold and italic site\nprint('🙂')")
        expected = [entity(3, 4, "Bold"), entity(12, 6, "Italic"),
                    entity(19, 4, "TextUrl", url="https://example.com"),
                    entity(24, 11, "PreCode", language="python")]
        self.assertEqual(entities, expected)
        rendered = display_markdown(text, entities)
        self.assertEqual(rendered, "😀 **bold** and *italic* [site](<https://example.com>)\n```python\nprint('🙂')\n```")
        self.assertEqual(parse_markdown(rendered), (text, expected))

    def test_literal_markdown_and_backslashes_are_not_reinterpreted_on_edit(self):
        text = "A *literal* [brackets] <tag> and \\ path"
        rendered = display_markdown(text, [])
        self.assertEqual(rendered, "A \\*literal\\* \\[brackets\\] \\<tag\\> and \\\\ path")
        self.assertEqual(parse_markdown(rendered), (text, []))

    def test_compose_dialect_and_escaped_literals(self):
        text, entities = parse_markdown(r"**a** __b__ *c* _d_ ~~e~~ \*literal\* \_x\_ \\ end")
        self.assertEqual(text, "a b c d e *literal* _x_ \\ end")
        self.assertEqual(entities, [entity(0, 1, "Bold"), entity(2, 1, "Bold"),
                                    entity(4, 1, "Italic"), entity(6, 1, "Italic"),
                                    entity(8, 1, "Strikethrough")])

    def test_nested_spans_with_surrogate_pair_in_both_nesting_orders(self):
        cases = [
            ("**a *😀* z**", "a 😀 z", [entity(0, 6, "Bold"), entity(2, 2, "Italic")]),
            ("*a **😀** z*", "a 😀 z", [entity(0, 6, "Italic"), entity(2, 2, "Bold")]),
            ("***😀***", "😀", [entity(0, 2, "Bold"), entity(0, 2, "Italic")]),
        ]
        for source, plain, expected in cases:
            with self.subTest(source=source):
                self.assertEqual(parse_markdown(source), (plain, expected))
                self.assertEqual(display_markdown(plain, expected), source)

    def test_code_does_not_parse_markup_or_escapes(self):
        self.assertEqual(parse_markdown(r"`**bold** \* [x](url)`"),
                         (r"**bold** \* [x](url)", [entity(0, 20, "Code")]))
        body = "**bold** _italic_ \\* [x](url) 🙂"
        source = "````c++\n" + body + "\n````"
        expected = [entity(0, len(body.encode("utf-16-le")) // 2, "PreCode", language="c++")]
        self.assertEqual(parse_markdown(source), (body, expected))
        self.assertEqual(parse_markdown(display_markdown(body, expected)), (body, expected))

    def test_fenced_code_without_language_and_trailing_newlines(self):
        self.assertEqual(parse_markdown("```\nx\n```"), ("x", [entity(0, 1, "Pre")]))
        body = "x\n"
        expected = [entity(0, 2, "Pre")]
        self.assertEqual(display_markdown(body, expected), "```\nx\n\n```")
        self.assertEqual(parse_markdown(display_markdown(body, expected)), (body, expected))

    def test_inline_code_backticks_and_spaces_remain_literal(self):
        for body in ("`code`", " code ", " ", "x``y", "**x**"):
            with self.subTest(body=body):
                rendered = display_markdown(body, [entity(0, len(body), "Code")])
                plain, entities = parse_markdown(rendered)
                self.assertEqual(plain, body)
                self.assertEqual(len(entities), 1)
                self.assertEqual(entities[0]["offset"], 0)
                self.assertEqual(entities[0]["length"], len(body))

    def test_links_balance_parentheses_and_nested_label_formatting(self):
        expected = [entity(0, 2, "TextUrl", url="https://example.com/a_(b)"), entity(0, 2, "Bold")]
        self.assertEqual(parse_markdown("[**😀**](https://example.com/a_(b))"), ("😀", expected))
        self.assertEqual(display_markdown("😀", expected), "[**😀**](<https://example.com/a_(b)>)")
        self.assertEqual(parse_markdown(display_markdown("😀", expected)), ("😀", expected))

    def test_display_consumes_tdlib_entities_and_escapes_unknown_formats(self):
        self.assertEqual(display_markdown("😀hi!", [entity(2, 2, "Bold")]), "😀**hi**\\!")
        self.assertEqual(display_markdown("*literal*", [entity(0, 9, "Underline")]), "\\*literal\\*")
        self.assertEqual(display_markdown("Alice", [entity(0, 5, "MentionName", user_id=42)]),
                         "[Alice](<tg://user?id=42>)")
        self.assertEqual(display_markdown("x", [entity(0, 1, "TextUrl", url="https://e/<x>")]),
                         "[x](<https://e/%3Cx%3E>)")

    def test_invalid_ranges_including_mid_surrogate_are_literal_safe(self):
        invalid = [entity(-1, 2, "Bold"), entity(0, 100, "Italic"),
                   entity(0, 0, "Bold"), entity(1, 1, "Bold"),
                   entity(0, 1, "Bold"), entity("0", 2, "Bold"),
                   {"offset": 0, "length": 2, "type": None}, None]
        self.assertEqual(display_markdown("😀*x*", invalid), "😀\\*x\\*")

    def test_crossing_spans_and_markup_inside_code_are_not_emitted(self):
        self.assertEqual(display_markdown("abcd", [entity(0, 3, "Bold"), entity(2, 2, "Italic")]),
                         "**abc**d")
        self.assertEqual(display_markdown("*x*", [entity(0, 3, "Code"), entity(1, 1, "Bold")]), "`*x*`")

    def test_empty_entities_are_pruned_and_unmatched_markers_stay_literal(self):
        self.assertEqual(parse_markdown("**** ~~~~ [](<https://example.com>) ```\n```"), ("   ", []))
        self.assertEqual(parse_markdown("**open [broken](url `code"), ("**open [broken](url `code", []))

    def test_message_limit_applies_to_content_not_formatting_markers(self):
        text, entities = TelegramService._compose("**" + "x" * 4096 + "**")
        self.assertEqual(text, "x" * 4096)
        self.assertEqual(entities, [entity(0, 4096, "Bold")])
        with self.assertRaises(ClientError):
            TelegramService._compose("**" + "🙂" * 2049 + "**")
