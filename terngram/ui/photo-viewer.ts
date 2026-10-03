import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { button, label } from "./nodes";

/** One full-size image at a time; native image nodes retain their click-to-zoom behavior. */
export class PhotoViewer implements Component {
  focused = false;
  readonly nativeOverlay = { size: "lg" as const, role: "terngram.photo-overlay" };
  private index = 0;

  constructor(private images: readonly NativeNode[], private caption: readonly string[], private close: () => void, private showHints = true) {}

  describe(): NativeNode {
    const image = this.images[this.index];
    const caption = this.caption[this.index] ?? "";
    return { k: "col", key: "photo-viewer", p: { role: "terngram.gallery", gap: "md" }, c: [
      { k: "row", key: "header", p: { justify: "between", gap: "sm", wrap: true }, c: [
        label(`${this.images.length > 1 ? "Photos" : "Photo"} · ${image ? this.index + 1 : 0}/${this.images.length}`, "photo-status"),
        ...(this.showHints ? [button("close-photo", "Esc · Close")] : []),
      ] },
      ...(image ? [image] : []), ...(image && caption ? [label(caption, "photo-caption")] : []),
      ...(this.showHints || this.images.length > 1 ? [{ k: "row", key: "navigation", p: { justify: "between", gap: "sm", wrap: true }, c: [
        ...(this.images.length > 1 ? [
          button("previous-photo", "← · Previous", this.index === 0),
          button("next-photo", "→ · Next", this.index >= this.images.length - 1),
        ] : []),
        ...(this.showHints ? [label("Click image to zoom")] : []),
      ] } satisfies NativeNode] : []),
    ] };
  }

  setContent(images: readonly NativeNode[], caption: readonly string[]): void {
    const key = this.images[this.index]?.key;
    const retained = key === undefined ? -1 : images.findIndex(image => image.key === key);
    this.index = retained >= 0 ? retained : Math.max(0, Math.min(this.index, images.length - 1));
    this.images = images; this.caption = caption;
  }

  selectImage(key: string): void {
    const index = this.images.findIndex(image => image.key === key);
    if (index >= 0) this.index = index;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.close();
    else if (matchesKey(data, "left")) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, "right")) this.index = Math.max(0, Math.min(this.index + 1, this.images.length - 1));
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type !== "action") return;
    if (event.act === "close-photo") this.close();
    else if (event.act === "previous-photo") this.handleInput("\x1b[D");
    else if (event.act === "next-photo") this.handleInput("\x1b[C");
  }

  render(): readonly string[] { throw new Error("Photo viewing requires native Tern rendering."); }
  invalidate(): void {}
}
