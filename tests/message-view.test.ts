import { expect, test } from "bun:test";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ChatState } from "../terngram/ui/chat-state";
import { MessageView } from "../terngram/ui/message-view";
import type { ChatMessage, MessageEntity } from "../terngram/ui/telegram";

function content(text: string, entities: MessageEntity[] = []): NativeNode[] {
  const message: ChatMessage = {
    id: 1, chat_id: 123, sender: "Fixture", sender_id: 42, text, entities,
    markdown: "Never render this compose syntax", time: "12:00", outgoing: false,
    reply_to: null, edited: false, photo: false, media_id: null, forwarded: null,
    read: false, grouped_id: null,
  };
  const view = new MessageView().describe([message], {
    thread: new ChatState(), selectedMessageId: null, loading: false,
    avatar: null, previews: [],
  });
  const bubble = view.c?.find(child => "k" in child && child.k === "card") as NativeNode;
  const body = bubble.c?.find(child => "k" in child && child.key === "text-1") as NativeNode;
  return body.c as NativeNode[];
}

test("Telegram punctuation and LaTeX-looking text stay literal rather than becoming Markdown", () => {
  const text = "(Score: 151+ in 13 hours)\n[x] $5 + $10\n\\(literal\\) $$not math$$";
  const rendered = content(text);
  expect(rendered.map(node => node.k)).toEqual(["text"]);
  const literal = rendered[0]!;
  if (literal.k !== "text") throw new Error("Expected literal text");
  expect(literal.p?.spans).toEqual([{ t: text }]);
});

test("nested Telegram entities use UTF-16 offsets and preserve clickable link destinations", () => {
  const rendered = content("😀 Bold and site", [
    { offset: 0, length: 7, type: { "@type": "textEntityTypeBold" } },
    { offset: 3, length: 4, type: { "@type": "textEntityTypeItalic" } },
    { offset: 12, length: 4, type: { "@type": "textEntityTypeTextUrl", url: "https://example.com/a_(b)" } },
  ]);
  expect(rendered[0]!.k).toBe("text");
  if (rendered[0]!.k !== "text") throw new Error("Expected literal text runs");
  expect(rendered[0]!.p?.spans).toEqual([
    { t: "😀 ", s: "strong" }, { t: "Bold", s: "strong em" },
    { t: " and " }, { t: "site", href: "https://example.com/a_(b)" },
  ]);
});

test("preformatted Telegram text keeps its language and literal body between prose", () => {
  const rendered = content("Before\n$x$ \\(x\\)\nAfter", [
    { offset: 7, length: 9, type: { "@type": "textEntityTypePreCode", language: "python" } },
  ]);
  expect(rendered.map(node => node.k)).toEqual(["text", "code", "text"]);
  const code = rendered[1]!;
  if (code.k !== "code") throw new Error("Expected code block");
  expect(code.p?.text).toBe("$x$ \\(x\\)");
  expect(code.p?.lang).toBe("python");
});

test("invalid entity offsets cannot split emoji or remove literal punctuation", () => {
  const rendered = content("😀(x)", [
    { offset: 1, length: 1, type: { "@type": "textEntityTypeBold" } },
    { offset: -1, length: 2, type: { "@type": "textEntityTypeCode" } },
    { offset: 2, length: 99, type: { "@type": "textEntityTypeItalic" } },
  ]);
  const text = rendered[0]!;
  if (text.k !== "text") throw new Error("Expected literal text");
  expect(text.p?.spans).toEqual([{ t: "😀(x)" }]);
});

test("URL entities retain unescaped displayed text and link targets", () => {
  const url = "https://example.com/a_(b)";
  const rendered = content(url, [{ offset: 0, length: url.length, type: { "@type": "textEntityTypeUrl" } }]);
  const text = rendered[0]!;
  if (text.k !== "text") throw new Error("Expected literal link text");
  expect(text.p?.spans).toEqual([{ t: url, href: url }]);
});
