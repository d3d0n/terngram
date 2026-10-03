import { Input } from "@oh-my-pi/pi-tui/components/input";
import { SelectList, type SelectItem } from "@oh-my-pi/pi-tui/components/select-list";
import { getKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { extractPrintableText } from "@oh-my-pi/pi-tui/keys";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { SelectListSheet } from "@oh-my-pi/pi-tui/native/picker";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

export interface PaletteItem extends SelectItem {
  recent?: boolean;
}

export class CommandPalette implements Component {
  private list: SelectList;
  private sheet: SelectListSheet;
  private input = new Input();
  private recent = new Set<string>();
  private loading = false;
  private catalogSize = 0;
  private loadStamp?: string;

  constructor(items: readonly PaletteItem[], choose: (value: string) => void, cancel: () => void, private search: (query: string) => void, private chatsOnly = false, private loadMore?: () => void) {
    this.list = new SelectList([], 10, getSelectListTheme(), {
      search: "always",
      filterItems: (items, raw) => {
        const query = raw.trim().toLocaleLowerCase();
        const prefix = query[0];
        const text = prefix === ">" || prefix === "@" ? query.slice(1).trim() : query;
        return items.filter(item => (!chatsOnly || item.value.startsWith("chat:")) && (prefix !== ">" || !item.value.startsWith("chat:")) && (prefix !== "@" || item.value.startsWith("chat:")) && `${item.label} ${item.searchText ?? ""}`.toLocaleLowerCase().includes(text));
      },
    });
    this.list.onSelect = item => choose(item.value);
    this.list.onCancel = cancel;
    this.setItems(items);
    this.sheet = new SelectListSheet(this.list, { title: chatsOnly ? "Terngram · chats" : "Terngram · commands & chats", noun: "results", searchable: true, confirm: chatsOnly ? "Open chat" : "Run / open", subtitle: chatsOnly ? "Type to find a chat" : "Type to search · > commands · @ chats" }, { docked: false });
    if (chatsOnly) { this.input.setValue("@"); this.list.setFilter("@"); }
  }
  setItems(items: readonly PaletteItem[]): void {
    this.catalogSize = items.length;
    this.recent = new Set(items.filter(item => item.recent).map(item => item.value));
    this.list.setItems(this.chatsOnly ? items.filter(item => item.value.startsWith("chat:")) : items);
  }
  setLoading(loading: boolean): void { this.loading = loading; }
  loadNearEnd(): void {
    if (!this.loadMore || this.loading) return;
    const view = this.list.pickerView();
    if (view.query.trim().startsWith(">")) return;
    const chats = view.items.filter(item => item.value.startsWith("chat:"));
    const index = chats.findIndex(item => item.value === view.selected);
    if (chats.length && (index < 0 || index < chats.length - 5)) { this.loadStamp = undefined; return; }
    const stamp = `${this.catalogSize}:${view.query}`;
    if (stamp === this.loadStamp) return;
    this.loadStamp = stamp;
    this.loadMore();
  }
  private changed(): void {
    const query = this.input.getValue();
    if (query === this.list.getFilter()) return;
    this.list.setFilter(query);
    this.search(query.trim().startsWith(">") ? "" : query.replace(/^\s*@/, "").trim());
  }
  handleInput(data: string): void {
    const kb = getKeybindings();
    if (extractPrintableText(data) === undefined && (
      kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown") ||
      kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel") || data === "\n"
    )) this.list.handleInput(data);
    else this.input.handleInput(data);
    this.changed();
    this.loadNearEnd();
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if ((event.type === "select" || event.type === "activate") && this.list.pickerView().items.find(item => item.value === event.item)?.disabled) return;
    if (event.type === "edit" && event.key.replaceAll("^", "") === "") this.input.handleNativeEvent(event);
    else this.sheet.handle(event);
    this.changed();
    this.loadNearEnd();
  }
  describe(): NativeNode {
    const node = this.sheet.describe();
    if (node.k !== "picker") return node;
    const view = this.list.pickerView();
    const selected = view.items.find(item => item.value === view.selected);
    const disabled = !selected || !!selected.disabled;
    const query = this.input.getValue().trim().replace(/^[>@]\s*/, "");
    let order: TspPickerProps["order"];
    if (!query) {
      const recent = view.items.filter(item => this.recent.has(item.value));
      const other = view.items.filter(item => !this.recent.has(item.value));
      if (recent.length) order = [
        { group: "recent", label: "Recent chats", count: recent.length },
        ...recent.map(item => item.value),
        ...(other.length ? [{ group: "other", label: this.chatsOnly ? "Other chats" : "Other chats & commands", count: other.length }, ...other.map(item => item.value)] : []),
      ];
    }
    const loadingChats = this.loading && !this.input.getValue().trim().startsWith(">");
    const message = selected
      ? `${selected.label}${selected.description ? ` · ${selected.description}` : ""}${disabled ? " · Unavailable" : selected.value.startsWith("chat:") ? " · Enter open chat" : " · Enter run command"}`
      : loadingChats ? "Searching cached chats · Loading more chats…" : "No matching results · Type to search · Esc close";
    return { ...node, p: { ...node.p, state: "ready", order, cursor: this.input.getCursor(), message: selected && loadingChats ? `${message} · Loading more chats…` : message, actions: node.p?.actions?.map(action => action.id === "confirm" ? { ...action, disabled: disabled ? true as const : undefined } : action) } };
  }
  invalidate(): void { this.sheet.invalidate(); }
  render(): readonly string[] { throw new Error("Command palette requires native Tern rendering."); }
  nativeSheet(cx: DescribeContext): boolean { return cx.supports("picker"); }
}
