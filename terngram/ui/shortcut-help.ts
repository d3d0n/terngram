import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { button } from "./nodes";

export class ShortcutHelp implements Component {
  constructor(private close: () => void) {}
  handleInput(data: string): void { if (matchesKey(data, "escape") || matchesKey(data, "ctrl+g")) this.close(); }
  handleNativeEvent(event: NativeUiEvent): void { if (event.type === "action" && event.act === "close-help") this.close(); }
  describe(): NativeNode {
    return { k: "col", key: "shortcut-help", p: { gap: "sm", max: { w: "76ch" } }, c: [
      { k: "text", p: { text: "Keyboard shortcuts", tone: "accent" } },
      ...[
        ["Anywhere", "Ctrl+K commands & chats · Ctrl+F find chat · Ctrl+G this help · Ctrl+Q quit"],
        ["Conversation", "Tab / Shift+Tab switch messages ↔ editor · Ctrl+L latest · Ctrl+R refresh"],
        ["Chat history", "Double ← back · Double → forward (messages or empty editor) · Ctrl+K shows the five recent chats and Back / Forward commands"],
        ["Editor", "Enter send / save edit · Shift+Enter new line · ↑ in empty editor edit last sent message"],
        ["Messages (after Tab)", "↑ / ↓ select (↑ at the first loaded message loads earlier history) · Ctrl+U / Ctrl+D page up / down · Enter / R reply · E edit own text · F forward · P photo · X or ⌫ request deletion confirmation"],
        ["Palette / forwarding", "Type to filter · ↑ / ↓ select · Enter activate · Esc close · > commands only · @ chats only (palette)"],
        ["Photo gallery", "← / → previous / next album photo · Esc close"],
        ["Escape", "Close the topmost popup first; otherwise cancel deletion, message selection, then reply / edit. Draft text is preserved."],
        ["Deletion / sign out", "Enter confirms only in the explicit confirmation context · Esc cancels"],
      ].map(([title, text]): NativeNode => ({ k: "col", p: { gap: "xs" }, c: [{ k: "text", p: { text: title!, tone: "accent" } }, { k: "text", p: { text: text!, wrap: "word" } }] })),
      button("close-help", "Close · Esc"),
    ] };
  }
  invalidate(): void {}
  render(): readonly string[] { throw new Error("Shortcut help requires native Tern rendering."); }
}
