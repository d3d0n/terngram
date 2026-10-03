import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

/** Wrapped informational text. */
export function label(text: string, key?: string): NativeNode {
  return { k: "text", key, p: { text, wrap: "word" } };
}

/** Clickable item whose key is also the action dispatched to its owning component. */
export function button(action: string, text: string, disabled = false): NativeNode {
  return { k: "item", key: action, p: { label: text, disabled, aria: text, grow: 0, shrink: 0, basis: "content", actions: { click: action } } };
}

/** Single-line text that yields width first; the full value remains available as its title. */
export function line(key: string, text: string): NativeNode {
  return { k: "text", key, p: { text, title: text, lines: 1, truncate: "end", grow: 1, shrink: 1, min: { w: 0 } } };
}

/** Message previews used inside compact single-line contexts. */
export function preview(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 120);
}
