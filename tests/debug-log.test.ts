import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeTspJson } from "@oh-my-pi/pi-tui/native/encode";
import { DebugLog, type DebugState } from "../terngram/ui/debug-log";

function fixture(run: (log: DebugLog, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "terngram-debug-log-"));
  const path = join(directory, "events.jsonl");
  const log = new DebugLog(path);
  try { run(log, path); } finally { log.close(); rmSync(directory, { recursive: true }); }
}

function rows(path: string): DebugState[] {
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").map(line => JSON.parse(line)) : [];
}

function breakRecorder(log: DebugLog): void {
  // Inject a real I/O failure without adding a production-only test API.
  const fd: unknown = Reflect.get(log, "fd");
  if (typeof fd !== "number") throw new Error("Recorder descriptor missing");
  closeSync(fd);
}

test("verbose capture aliases private identities and preserves unknown events without private content", () => {
  fixture((log, path) => {
    const secret = "private-fixture-content-not-for-logs";
    const surface = "surface-private-fixture-8321";
    const node = "s:1.main/chat:741/message:9287";
    log.snapshot = () => ({ stage: "chats", focusRole: "composer", composerLength: 7 });
    log.message("in", encodeTspJson("e", { ev: "resize", sf: surface, cols: 110, visible: false, cell: { w: 9, h: 18, extra: secret } }));
    // Unknown future events survive even when the SDK cannot decode their type.
    log.message("in", encodeTspJson("e", { ev: "pane_focus", sf: surface, visible: true, payload: secret }));
    log.message("in", encodeTspJson("e", { ev: "edit", sf: surface, id: node, from: 0, to: 0, len: 0, cursor: secret.length, text: secret }));
    log.message("in", encodeTspJson("e", { ev: "error", sf: surface, s: 4, op: 2, msg: secret }));
    log.message("out", encodeTspJson("f", { sf: surface, s: 5, ops: [
      ["add", node, "s:1.dock", null, { id: node, k: "editor", p: { text: secret } }],
      ["focus", node], ["focus", null], [secret, secret],
    ] }));
    log.message("in", encodeTspJson("e", { ev: "focus", sf: surface, id: node, key: secret, item: secret, action: secret, clipboard: secret }));
    log.message("in", encodeTspJson("e", { ev: "action", sf: surface, id: node, act: secret, value: { private: secret } }));
    log.message("in", `\x1b_tsp;e;not-json-${secret}\x1b\\`);
    log.message("out", `\x1b_tsp;b;id=${node};${secret}\x1b\\`);
    log.message("out", encodeTspJson("o", { id: surface, mode: "screen" }));
    log.message("out", encodeTspJson("x", { id: surface, keep: false }));
    log.close();
    const raw = readFileSync(path, "utf8");
    for (const privateValue of [secret, surface, node, "chat:741", "message:9287", "s:1.dock"]) expect(raw.includes(privateValue)).toBe(false);
    const captured = rows(path);
    expect(captured[0]).toMatchObject({ ev: "resize", cols: 110, visible: false, cell: { w: 9, h: 18 }, state: { stage: "chats", focusRole: "composer", composerLength: 7 }, level: "trace" });
    expect(captured[1]).toMatchObject({ ev: "pane_focus", visible: true });
    expect(captured[2]).toMatchObject({ ev: "edit", from: 0, to: 0, len: 0, cursor: secret.length, textUnits: secret.length });
    expect(captured[3]).toMatchObject({ ev: "error", s: 4, op: 2, level: "warn" });
    expect(captured[4]).toMatchObject({ direction: "out", sf: captured[0]!.sf, s: 5, ops: { add: 1, focus: 2, unknown: 1 }, focus: [captured[2]!.id, null] });
    expect(captured[5]).toMatchObject({ ev: "focus", id: captured[2]!.id, sf: captured[4]!.sf });
    expect(captured[6]).toMatchObject({ ev: "action", id: captured[2]!.id });
    expect(captured[7]).toMatchObject({ kind: "protocol_invalid", direction: "in", level: "warn" });
    expect(captured[8]).toMatchObject({ id: captured[0]!.sf, mode: "screen" });
    expect(captured[9]).toMatchObject({ id: captured[0]!.sf, keep: false });
    expect(captured).toHaveLength(10);
  });
});

test("capture reassembles chunked unknown events across calls and creates an exclusive private file", () => {
  fixture((log, path) => {
    const secret = "Ж".repeat(100);
    const encoded = encodeTspJson("e", { ev: "future_focus_change", sf: "private-surface", id: "private-node", visible: false, payload: secret }, undefined, 32);
    const parts = [...encoded.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)].map(match => match[0]);
    expect(parts.length).toBeGreaterThan(1);
    log.message("in", parts[0]!);
    expect(readFileSync(path, "utf8")).toBe("");
    for (const part of parts.slice(1)) log.message("in", part);
    log.close();
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ ev: "future_focus_change", sf: expect.any(String), id: expect.any(String), visible: false });
    for (const value of [secret, "private-surface", "private-node"]) expect(raw.includes(value)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => new DebugLog(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
});

test("auth edit capture removes all text, caret, range, length and malformed-body size metadata", () => {
  fixture((log, path) => {
    log.captureEdits = () => false;
    log.snapshot = () => ({ stage: "password", focusRole: "auth-password" });
    const secret = "auth-fixture-secret";
    const encoded = encodeTspJson("e", { ev: "edit", sf: "auth-surface", id: "auth-password-node", from: 17, to: 23, cursor: 31, len: 41, text: secret }, undefined, 32);
    for (const match of encoded.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) log.message("in", match[0]);
    log.message("in", encodeTspJson("e", { ev: "future_auth_edit", from: 17, to: 23, cursor: 31, len: 41, text: secret }));
    log.message("in", `\x1b_tsp;e;${secret}\x1b\\`);
    log.message("out", encodeTspJson("f", { sf: "auth-surface", s: 1, ops: [["text", "auth-password-node", secret], ["splice", "auth-password-node", 17, 23, secret]] }));
    const captured = rows(path);
    expect(captured[0]).toMatchObject({ ev: "edit", id: expect.any(String), state: { stage: "password", focusRole: "auth-password" } });
    for (const row of captured) {
      for (const name of ["text", "from", "to", "cursor", "len", "textUnits", "bytes"]) expect(row).not.toHaveProperty(name);
    }
    const raw = readFileSync(path, "utf8");
    for (const value of [secret, "auth-password-node", "auth-surface"]) expect(raw.includes(value)).toBe(false);
  });
});


test("failed file writes report a safe code and leave prior diagnostic records intact", () => {
  fixture((log, path) => {
    log.record("start");
    const before = readFileSync(path, "utf8");
    breakRecorder(log);
    log.record("app_state");
    expect(log.failure).toBe("EBADF");
    log.message("in", encodeTspJson("e", { ev: "visible", visible: true }));
    log.record("stop");
    log.close();
    log.close();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(rows(path)).toMatchObject([{ kind: "start", level: "info" }]);
  });
  fixture(log => {
    breakRecorder(log);
    log.close();
    expect(log.failure).toBe("EBADF");
  });
});

