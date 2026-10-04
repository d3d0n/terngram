import { expect, test } from "bun:test";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { NativeBackend, type NativeHost } from "@oh-my-pi/pi-tui/native/backend";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { encodeTspJson, splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { TSP_KINDS, type TspFrame, type TspOpen } from "@oh-my-pi/pi-wire";

for (const mode of ["inline", "screen"] as const) {
  test(`${mode} root preserves edits across eviction and resume without changing placement`, () => {
    const opens: TspOpen[] = [];
    const frames: TspFrame[] = [];
    const closes: Array<{ id: string; keep?: boolean }> = [];
    const documents = new Map<string, TspDocument>();
    const input = new Input();
    input.setValue("draft");
    const terminal = {
      columns: 110, rows: 40,
      write(data: string) {
        const message = splitTspMessage(data);
        if (!message) return;
        if (message.verb === "o") {
          const open: TspOpen = JSON.parse(message.body);
          opens.push(open);
          if (!open.adopt || !documents.has(open.id)) documents.set(open.id, new TspDocument(open.id));
        } else if (message.verb === "f") {
          const frame: TspFrame = JSON.parse(message.body);
          frames.push(frame);
          expect(documents.get(frame.sf)!.applyFrame(frame)).toEqual([]);
        } else if (message.verb === "x") {
          const close: { id: string; keep?: boolean } = JSON.parse(message.body);
          closes.push(close);
          if (close.keep) documents.get(close.id)?.close();
          else documents.delete(close.id);
        }
      },
    } as unknown as Terminal;
    const host: NativeHost = {
      terminal, describeSurface: () => ({ main: [], dock: [input] }), overlays: () => [],
      focused: () => input, focusFromPointer() {}, requestRender() {},
      appearanceChanged() {}, motionChanged() {}, invalidate() {},
    };
    const hello = { r: "hello" as const, v: 1 as const, term: "fixture", kinds: TSP_KINDS, credits: 10, cols: 110 };
    // Omitting the option protects the existing inline default used by omp/probes.
    const backend = new NativeBackend(host, hello, { recordPath: "", ...(mode === "screen" ? { surfaceMode: mode } : {}) });
    let acknowledged = 0;
    const draw = () => {
      backend.render();
      for (const frame of frames.slice(acknowledged)) backend.handleInput(encodeTspJson("e", { ev: "ack", sf: frame.sf, s: frame.s }));
      acknowledged = frames.length;
    };
    const liveDocument = () => documents.get(opens.at(-1)!.id)!;
    const visibleText = () => {
      const doc = liveDocument();
      expect(doc.focus).not.toBeNull();
      const node = doc.get(doc.focus!)!;
      if (node.k !== "input") throw new Error("Focused node is not the input");
      return node.p && "text" in node.p ? node.p.text : undefined;
    };
    try {
      backend.start(); draw();
      expect(opens.at(-1)!.mode).toBe(mode);
      expect(visibleText()).toBe("draft");
      const first = opens.at(-1)!.id;
      const edit = { ev: "edit", sf: first, id: liveDocument().focus, from: 5, to: 5, text: "!", cursor: 6, len: 5 };
      backend.handleInput(encodeTspJson("e", edit)); draw();
      expect(input.getValue()).toBe("draft!");
      expect(visibleText()).toBe("draft!");

      backend.handleInput(encodeTspJson("e", { ev: "visible", sf: first, visible: false }));
      input.setValue("updated while away");
      backend.handleInput(encodeTspJson("e", { ev: "visible", sf: first, visible: true })); draw();
      expect(visibleText()).toBe("updated while away");
      backend.handleInput(encodeTspJson("e", { ev: "gone", ids: [first] })); draw();
      expect(opens.at(-1)!.id).not.toBe(first);
      expect(opens.at(-1)!.mode).toBe(mode);
      expect(visibleText()).toBe("updated while away");

      const beforePause = opens.at(-1)!.id;
      backend.stop();
      expect(closes.at(-1)).toEqual({ id: beforePause, keep: mode === "inline" });
      input.setValue("updated while suspended");
      backend.resume(hello); draw();
      expect(opens.at(-1)!.mode).toBe(mode);
      expect(visibleText()).toBe("updated while suspended");
      if (mode === "screen") {
        expect(opens.at(-1)!.id).not.toBe(beforePause);
        expect(opens.at(-1)!.adopt).not.toBe(true);
      } else {
        expect(opens.at(-1)!.id).toBe(beforePause);
        expect(opens.at(-1)!.adopt).toBe(true);
      }
    } finally { backend.stop(); }
  });
}

test("hidden chats consume pending scroll commands without moving or replaying the active viewport", () => {
  let thread: NativeNode = { k: "col", key: "thread", scroll: { by: "end", n: 1 }, p: { hidden: false } };
  const host: NativeHost = {
    terminal: { columns: 110 } as Terminal,
    describeSurface: () => ({ main: [thread], dock: [] }), overlays: () => [],
    focused: () => null, focusFromPointer() {}, requestRender() {},
    appearanceChanged() {}, motionChanged() {}, invalidate() {},
  };
  const backend = new NativeBackend(host, { r: "hello", v: 1, term: "fixture", kinds: TSP_KINDS, features: ["scroll"], cols: 110 }, { recordPath: "" });
  const reconciler = new Reconciler("fixture");
  reconciler.reconcile({ main: [thread], dock: [], layer: [] }, backend.context);
  thread = { ...thread, scroll: { by: "page-up", n: 2 }, p: { hidden: true } };
  const hidden = reconciler.reconcile({ main: [thread], dock: [], layer: [] }, backend.context);
  expect(hidden.filter(op => op[0] === "scroll")).toEqual([]);
  thread = { ...thread, p: { hidden: false } };
  const shown = reconciler.reconcile({ main: [thread], dock: [], layer: [] }, backend.context);
  expect(shown.filter(op => op[0] === "scroll")).toEqual([]);
  thread = { ...thread, scroll: { by: "page-up", n: 3 } };
  const page = reconciler.reconcile({ main: [thread], dock: [], layer: [] }, backend.context);
  expect(page.filter(op => op[0] === "scroll").map(op => op[2])).toEqual(["page-up"]);
  thread = { ...thread, scroll: { by: "end", n: 4 } };
  const latest = reconciler.reconcile({ main: [thread], dock: [], layer: [] }, backend.context);
  expect(latest.filter(op => op[0] === "scroll").map(op => op[2])).toEqual(["end"]);
});
