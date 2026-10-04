import { expect, test } from "bun:test";
import type { NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { encodeTspJson, splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import { TSP_KINDS, type TspFrame } from "@oh-my-pi/pi-wire";
import { CommandPalette, type PaletteItem } from "../terngram/ui/command-palette";

const items: PaletteItem[] = [
  { value: "refresh", label: "Refresh", description: "Reload conversation" },
  { value: "chat:1", label: "Alice", searchText: "@alice work" },
  { value: "chat:2", label: "Alice team", description: "Group · 5 unread" },
  { value: "logout", label: "Sign out", disabled: true },
];

function setup(chatsOnly = false, initial = items) {
  const chosen: string[] = [];
  const queries: string[] = [];
  let cancelled = 0;
  const palette = new CommandPalette(initial, value => chosen.push(value), () => cancelled++, query => queries.push(query), chatsOnly);
  const view = () => {
    const node = palette.describe();
    if (node.k !== "picker") throw new Error("Expected native picker");
    return node.p!;
  };
  const ids = () => view().items!.map(item => item.id);
  const event = (event: NativeUiEvent) => palette.handleNativeEvent(event);
  const action = (act: string) => event({ type: "action", key: "", act, mods: [] });
  const replace = (text: string) => event({ type: "edit", key: "", from: 0, to: view().query!.length, text, len: view().query!.length, cursor: text.length });
  return { palette, chosen, queries, view, ids, event, action, replace, cancelled: () => cancelled };
}

test("native row selection previews without activation; activation and confirm choose", () => {
  const s = setup();
  s.event({ type: "select", key: "", item: "chat:2" });
  expect(s.chosen).toEqual([]);
  expect(s.view().selected).toBe("chat:2");
  s.action("confirm");
  s.event({ type: "activate", key: "", item: "refresh" });
  expect(s.chosen).toEqual(["chat:2", "refresh"]);
});

test("commands and chats prefixes filter case-insensitively and search hidden aliases", () => {
  const s = setup();
  s.replace("  > REf ");
  expect(s.ids()).toEqual(["refresh"]);
  expect(s.queries).toEqual([""]);
  s.replace("@ ALICE");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.queries.at(-1)).toBe("ALICE");
  s.replace("work");
  expect(s.ids()).toEqual(["chat:1"]);
  s.replace("@");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.queries.at(-1)).toBe("");
});

test("chat loading leaves unprefixed commands searchable and actionable", () => {
  const s = setup();
  s.palette.setLoading(true);
  s.replace("ref");
  expect(s.ids()).toEqual(["refresh"]);
  expect(s.view().state).toBe("ready");
  s.action("confirm");
  expect(s.chosen).toEqual(["refresh"]);
  s.replace("missing");
  expect(s.ids()).toEqual([]);
  s.replace(">missing");
  expect(s.view().state).toBe("ready");
  s.replace("@Alice");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.view().state).toBe("ready");
});

test("native edits retain their caret for subsequent keyboard filtering and ignore stale edits", () => {
  const s = setup();
  s.replace("Alce");
  s.event({ type: "edit", key: "", from: 2, to: 2, text: "i", len: 4, cursor: 3 });
  expect([s.view().query, s.view().cursor]).toEqual(["Alice", 3]);
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  s.palette.handleInput("\x7f");
  expect([s.view().query, s.view().cursor]).toEqual(["Alce", 2]);
  const queries = [...s.queries];
  s.event({ type: "edit", key: "", from: 0, to: 5, text: "wrong", len: 5, cursor: 5 });
  expect(s.view().query).toBe("Alce");
  expect(s.queries).toEqual(queries);
  s.event({ type: "edit", key: "other", from: 0, to: 4, text: "wrong", len: 4, cursor: 5 });
  expect(s.view().query).toBe("Alce");
});

test("caret-only edits do not search remotely and native paste uses single-line input cleanup", () => {
  const s = setup();
  s.replace("Alice");
  s.event({ type: "edit", key: "^", from: 2, to: 2, text: "", len: 5, cursor: 2 });
  expect(s.view().cursor).toBe(2);
  expect(s.queries).toEqual(["Alice"]);
  s.replace("Al\nice\r\n");
  expect(s.view().query).toBe("Alice");
  expect(s.queries).toEqual(["Alice"]);
});

test("keyboard input, word deletion and navigation keep filtering and search callbacks distinct", () => {
  const s = setup();
  s.palette.handleInput("Alice");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.queries).toEqual(["Alice"]);
  s.palette.handleInput("\x1b[B");
  expect(s.view().selected).toBe("chat:2");
  expect(s.queries).toEqual(["Alice"]);
  s.palette.handleInput("\r");
  expect(s.chosen).toEqual(["chat:2"]);
  s.palette.handleInput("\x17");
  expect(s.view().query).toBe("");
  expect(s.queries).toEqual(["Alice", ""]);
});

test("async item replacements preserve query, caret and selection by stable value", () => {
  const s = setup();
  s.replace("@Alice");
  s.event({ type: "select", key: "", item: "chat:2" });
  s.event({ type: "edit", key: "", from: 2, to: 2, text: "", len: 6, cursor: 2 });
  s.palette.setItems([
    { value: "chat:3", label: "Alice new" },
    { value: "chat:2", label: "Alice renamed" },
    ...items,
  ].filter((item, index, all) => all.findIndex(other => other.value === item.value) === index));
  expect([s.view().query, s.view().cursor, s.view().selected]).toEqual(["@Alice", 2, "chat:2"]);
  expect(s.queries).toEqual(["Alice"]);
  s.palette.setItems([{ value: "chat:3", label: "Alice new" }]);
  expect(s.view().selected).toBe("chat:3");
  expect(s.view().query).toBe("@Alice");
  s.palette.setItems([]);
  expect(s.ids()).toEqual([]);
  expect(s.view().actions!.find(action => action.id === "confirm")!.disabled).toBe(true);
});

test("chats-only mode stays restricted after clearing its prefix and replacing items", () => {
  const s = setup(true);
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  s.replace("");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  s.palette.setItems(items);
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  s.replace(">Refresh");
  expect(s.ids()).toEqual([]);
  expect(s.queries.at(-1)).toBe("");
});

test("disabled rows cannot select or activate and empty or unavailable results disable confirm", () => {
  const s = setup();
  s.event({ type: "select", key: "", item: "logout" });
  expect(s.view().selected).toBe("refresh");
  s.event({ type: "activate", key: "", item: "logout" });
  expect(s.chosen).toEqual([]);
  s.replace("Sign out");
  expect(s.view().actions!.find(action => action.id === "confirm")!.disabled).toBe(true);
  s.action("confirm");
  s.palette.handleInput("\r");
  expect(s.chosen).toEqual([]);
  s.replace("No matching name");
  s.action("confirm");
  expect(s.chosen).toEqual([]);
});

test("cancel routes only matching native keys and keyboard Escape closes without selecting", () => {
  const s = setup();
  s.event({ type: "action", key: "unrelated", act: "close", mods: [] });
  expect(s.cancelled()).toBe(0);
  s.action("close");
  s.action("cancel");
  s.palette.handleInput("\x1b");
  expect(s.cancelled()).toBe(3);
  expect(s.chosen).toEqual([]);
  expect(s.queries).toEqual([]);
});

test("recent chats are grouped only without search and remain searchable with every other chat", () => {
  const s = setup(false, [{ ...items[1]!, recent: true }, items[2]!, items[0]!]);
  expect(s.view().order?.filter(item => typeof item !== "string").map(group => group.group)).toEqual(["recent", "other"]);
  expect(s.view().order?.filter(item => typeof item === "string")).toEqual(["chat:1", "chat:2", "refresh"]);
  s.replace("alice");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.view().order).toBeUndefined();
  s.palette.setItems([{ ...items[1]!, recent: true }, { ...items[2]!, recent: true }, items[0]!]);
  expect(s.view().order).toBeUndefined();
  s.replace("");
  s.palette.handleInput("\x1b[B");
  s.palette.handleInput("\r");
  expect(s.chosen).toEqual(["chat:2"]);
});

test("chat-only search flattens recent groups after the scope prefix", () => {
  const s = setup(true, [{ ...items[1]!, recent: true }, items[2]!]);
  expect(s.view().order?.filter(item => typeof item !== "string").map(group => group.group)).toEqual(["recent", "other"]);
  s.replace("@alice");
  expect(s.ids()).toEqual(["chat:1", "chat:2"]);
  expect(s.view().order).toBeUndefined();
});

test("chat paging is requested near the result edge without issuing repeated loads for the same page", () => {
  const chats = Array.from({ length: 12 }, (_, id): PaletteItem => ({ value: `chat:${id}`, label: `Chat ${id}` }));
  let loads = 0;
  const palette = new CommandPalette(chats, () => {}, () => {}, () => {}, false, () => { loads++; });
  palette.loadNearEnd();
  expect(loads).toBe(0);
  for (let index = 0; index < 7; index++) palette.handleInput("\x1b[B");
  expect(loads).toBe(1);
  palette.handleInput("\x1b[B"); palette.handleInput("\x1b[B");
  expect(loads).toBe(1);
  palette.setLoading(true);
  palette.handleNativeEvent({ type: "select", key: "", item: "chat:11" });
  expect(loads).toBe(1);
  palette.setItems([...chats, { value: "chat:12", label: "Chat 12" }]);
  palette.setLoading(false);
  palette.loadNearEnd();
  expect(loads).toBe(2);
});

test("deleting the final search character delivers the full Unicode catalog within the host APC limit", () => {
  const catalog: PaletteItem[] = Array.from({ length: 226 }, (_, index) => ({
    value: `chat:${index}`,
    label: `Тестовый чат ${index}`,
    description: "Подробное описание сообщения ".repeat(8),
  }));
  catalog.push({ value: "chat:999", label: "zzneedle" });
  const palette = new CommandPalette(catalog, () => {}, () => {}, () => {});
  palette.handleInput("zzneedle");
  const limit = 65_536;
  const chunks = new Map<string, string>();
  let document: TspDocument;
  const accepted: TspFrame[] = [];
  const terminal = {
    columns: 110, rows: 40,
    write(data: string) {
      for (const part of data.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
        // Reproduce a host that rejects oversized APC payloads before decoding JSON.
        if (Buffer.byteLength(part[0].slice(2, -2), "utf8") > limit) continue;
        const raw = splitTspMessage(part[0])!;
        let body = raw.body;
        if (raw.params.c !== undefined) {
          const key = `${raw.verb}:${raw.params.c}`;
          body = (chunks.get(key) ?? "") + body;
          if (raw.params.m === "1") { chunks.set(key, body); continue; }
          chunks.delete(key);
        }
        let value;
        try { value = JSON.parse(body); } catch { continue; }
        if (raw.verb === "o") document = new TspDocument(value.id);
        else if (raw.verb === "f") {
          expect(document.applyFrame(value)).toEqual([]);
          accepted.push(value);
        }
      }
    },
  } as unknown as Terminal;
  const host: NativeHost = {
    terminal, describeSurface: () => ({ main: [], dock: [] }),
    overlays: () => [{ component: palette, options: undefined, focused: true }],
    focused: () => palette, focusFromPointer() {}, requestRender() {},
    appearanceChanged() {}, motionChanged() {}, invalidate() {},
  };
  const backend = new NativeBackend(host, { r: "hello", v: 1, term: "fixture", kinds: TSP_KINDS, apc: limit, credits: 1000, cols: 110 }, { recordPath: "", surfaceMode: "screen" });
  let acknowledged = 0;
  try {
    backend.start();
    for (let remaining = "zzneedle".length; remaining > 0; remaining--) {
      palette.handleInput("\x7f"); backend.render();
      for (const frame of accepted.slice(acknowledged)) backend.handleInput(encodeTspJson("e", { ev: "ack", sf: frame.sf, s: frame.s }));
      acknowledged = accepted.length;
    }
    const picker = document!.get("layer")!.c?.find(node => node.k === "picker");
    if (!picker || picker.k !== "picker" || !picker.p || !("query" in picker.p)) throw new Error("Missing displayed picker query");
    expect(palette.describe()).toMatchObject({ p: { query: "", cursor: 0 } });
    expect(picker.p.query).toBe("");
    expect(picker.p && "items" in picker.p ? picker.p.items?.map(item => item.id) : []).toEqual(catalog.map(item => item.value));
    palette.handleInput("zz"); backend.render();
    const typed = document!.get(picker.id)!;
    expect(typed.p && "query" in typed.p ? typed.p.query : undefined).toBe("zz");
  } finally { backend.stop(); }
});
