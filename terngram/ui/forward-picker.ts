import { SelectList } from "@oh-my-pi/pi-tui/components/select-list";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { SelectListSheet } from "@oh-my-pi/pi-tui/native/picker";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { Dialog } from "./telegram";
import { preview } from "./nodes";

/** Chooses a writable destination for forwarding a message or album. */
export class ForwardPicker implements Component {
  private list: SelectList;
  private sheet: SelectListSheet;
  private loading = false;
  private catalogSize = 0;
  private loadStamp?: string;

  constructor(dialogs: readonly Dialog[], choose: (id: number) => void, cancel: () => void, private loadMore?: () => void, private queryChanged?: (query: string) => void) {
    this.list = new SelectList([], 15, getSelectListTheme(), {
      search: "always",
      filterItems: (items, query) => items.filter(item => item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
    });
    this.setDialogs(dialogs);
    this.list.onSelect = item => choose(Number(item.value));
    this.list.onCancel = cancel;
    this.sheet = new SelectListSheet(this.list, { title: "Forward to…", noun: "chats", searchable: true, confirm: "Forward here" }, { docked: false });
  }

  setDialogs(dialogs: readonly Dialog[]): void {
    this.catalogSize = dialogs.length;
    this.list.setItems(dialogs.filter(dialog => dialog.writable).map(dialog => ({
      value: String(dialog.id),
      label: dialog.title,
      description: [dialog.unread_count ? `${dialog.unread_count} unread` : "", preview(dialog.preview, 160)].filter(Boolean).join(" · "),
    })));
  }

  get searching(): boolean { return !!this.list.getFilter().trim(); }
  setLoading(loading: boolean): void { this.loading = loading; }
  loadNearEnd(): void {
    if (!this.loadMore || this.loading) return;
    const view = this.list.pickerView();
    const index = view.items.findIndex(item => item.value === view.selected);
    if (view.items.length && (index < 0 || index < view.items.length - 5)) { this.loadStamp = undefined; return; }
    const stamp = `${this.catalogSize}:${view.query}`;
    if (stamp === this.loadStamp) return;
    this.loadStamp = stamp; this.loadMore();
  }
  handleInput(data: string): void {
    const query = this.list.getFilter();
    this.list.handleInput(data);
    if (query !== this.list.getFilter()) this.queryChanged?.(this.list.getFilter());
    this.loadNearEnd();
  }
  handleNativeEvent(event: NativeUiEvent): void {
    const query = this.list.getFilter();
    this.sheet.handle(event);
    if (query !== this.list.getFilter()) this.queryChanged?.(this.list.getFilter());
    this.loadNearEnd();
  }
  nativeSheet(cx: DescribeContext): boolean { return cx.supports("picker"); }
  describe(): NativeNode {
    const node = this.sheet.describe();
    return node.k === "picker" ? { ...node, p: { ...node.p, state: this.loading ? "loading" : "ready" } } : node;
  }
  render(width: number): readonly string[] { return this.list.render(width); }
  invalidate(): void { this.sheet.invalidate(); }
}
