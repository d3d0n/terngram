import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { isKeyRelease, matchesKey } from "@oh-my-pi/pi-tui/keys";
import { encodeTspJson, splitTspMessage, TSP_PREFIX } from "@oh-my-pi/pi-tui/native/encode";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";

export type DebugState = Record<string, unknown>;
const SYMBOL = /^[a-zA-Z0-9_.:/-]{1,128}$/;
const FRAME_OPS: Record<string, true> = { add: true, set: true, text: true, splice: true, move: true, del: true, settle: true, focus: true, reveal: true, scroll: true, suspend: true, resume: true };
const LEVELS: Record<string, "info" | "warn"> = { start: "info", stop: "info", step_begin: "info", step_end: "info", overlay: "info", protocol_invalid: "warn", input_broken: "warn" };
const KEYS = ["ctrl+n", "ctrl+g", "ctrl+q", "ctrl+c", "ctrl+k", "ctrl+f", "ctrl+r", "ctrl+l", "ctrl+u", "ctrl+d", "ctrl+enter", "shift+enter", "shift+tab", "escape", "tab", "enter", "up", "down", "left", "right", "backspace", "delete"] as const;

/** Manual fields and snapshots must be content-free; protocol bodies are allowlisted here. */
export class DebugLog {
  private fd: number;
  private started = performance.now();
  private chunks = new Map<string, string>();
  private nodes = new Map<string, string>();
  private surfaces = new Map<string, string>();
  private closed = false;
  failure: string | undefined;
  snapshot: () => DebugState = () => ({});
  captureEdits: () => boolean = () => true;

  constructor(readonly path: string) {
    this.fd = openSync(path, "wx", 0o600);
  }

  private fail(error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    this.failure ??= typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "EIO";
    this.chunks.clear();
    this.nodes.clear();
    this.surfaces.clear();
  }

  private alias(value: string, aliases: Map<string, string>, prefix: string): string {
    let alias = aliases.get(value);
    if (!alias) { alias = `${prefix}${aliases.size + 1}`; aliases.set(value, alias); }
    return alias;
  }

  record(kind: string, fields: DebugState = {}): void {
    if (this.closed || this.failure) return;
    try {
      const level = kind === "tsp" && fields.ev === "error" ? "warn"
        : Object.hasOwn(LEVELS, kind) ? LEVELS[kind] : "trace";
      const bytes = Buffer.from(JSON.stringify({ ...fields, at: new Date().toISOString(), ms: Math.round(performance.now() - this.started), level, kind, state: this.snapshot() }) + "\n");
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (!written) { this.fail(undefined); return; }
        offset += written;
      }
    } catch (error) { this.fail(error); }
  }

  message(direction: "in" | "out", sequence: string): void {
    if (this.closed || this.failure) return;
    try {
      // ProcessTerminal frames input; an outgoing write may contain several APC chunks.
      for (const match of sequence.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
        const raw = splitTspMessage(match[0]);
        if (!raw) continue;
        // Blob payloads are not JSON, and neither their contents nor size belong in diagnostics.
        if (raw.verb === "b") continue;
        let body = raw.body;
        if (raw.params.c !== undefined) {
          const key = `${direction}:${raw.verb}:${raw.params.c}`;
          body = (this.chunks.get(key) ?? "") + body;
          if (raw.params.m === "1") { this.chunks.set(key, body); continue; }
          this.chunks.delete(key);
        }
        let value: DebugState;
        try { value = JSON.parse(body); }
        catch { this.record("protocol_invalid", { direction }); continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          this.record("protocol_invalid", { direction }); continue;
        }
        const fields: DebugState = { direction, verb: /^[qroftxe]$/.test(raw.verb) ? raw.verb : "unknown" };
        for (const name of ["ev", "r", "q"]) {
          if (typeof value[name] === "string" && SYMBOL.test(value[name])) fields[name] = value[name];
        }
        if (typeof value.sf === "string") fields.sf = this.alias(value.sf, this.surfaces, "surface:");
        if (typeof value.id === "string") fields.id = raw.verb === "o" || raw.verb === "x"
          ? this.alias(value.id, this.surfaces, "surface:") : this.alias(value.id, this.nodes, "node:");
        if (value.mode === "inline" || value.mode === "screen") fields.mode = value.mode;
        if (value.role === "terngram") fields.role = value.role;
        for (const name of ["v", "cols", "s", "op", "credits", "apc"]) {
          if (typeof value[name] === "number" && Number.isFinite(value[name])) fields[name] = value[name];
        }
        if (value.ev === "edit" && this.captureEdits()) {
          for (const name of ["from", "to", "cursor", "len"]) {
            if (typeof value[name] === "number" && Number.isFinite(value[name])) fields[name] = value[name];
          }
          if (typeof value.text === "string") fields.textUnits = value.text.length;
        }
        for (const name of ["visible", "dark", "reduce", "reduceMotion", "adopt", "keep", "collapsed"]) {
          if (typeof value[name] === "boolean") fields[name] = value[name];
        }
        if (Array.isArray(value.ids)) fields.idsCount = value.ids.length;
        if (value.cell && typeof value.cell === "object") {
          const cell = value.cell as DebugState;
          fields.cell = Object.fromEntries(["w", "h"].filter(key => typeof cell[key] === "number" && Number.isFinite(cell[key])).map(key => [key, cell[key]]));
        }
        if (Array.isArray(value.ops)) {
          const counts: Record<string, number> = Object.create(null);
          const focus: (string | null)[] = [];
          for (const op of value.ops) {
            if (!Array.isArray(op) || typeof op[0] !== "string") continue;
            const name = Object.hasOwn(FRAME_OPS, op[0]) ? op[0] : "unknown";
            counts[name] = (counts[name] ?? 0) + 1;
            if (op[0] === "focus") {
              if (op[1] === null) focus.push(null);
              else if (typeof op[1] === "string") focus.push(this.alias(op[1], this.nodes, "node:"));
            }
          }
          fields.ops = counts; fields.focus = focus;
        }
        this.record("tsp", fields);
        if (this.failure) return;
      }
    } catch (error) { this.fail(error); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fsyncSync(this.fd); } catch (error) { this.fail(error); }
    try { closeSync(this.fd); } catch (error) { this.fail(error); }
    this.chunks.clear(); this.nodes.clear(); this.surfaces.clear();
  }
}

export class DebugTerminal extends ProcessTerminal {
  constructor(private readonly log?: DebugLog, private readonly title = "terngram") {
    if (log) {
      delete process.env.PI_TUI_TSP_RECORD;
      delete process.env.PI_TUI_WRITE_LOG;
    }
    super();
    if (!log) return;
    this.onTspHello(hello => log.record("hello", hello ? {
      v: hello.v, cols: hello.cols, credits: hello.credits, apc: hello.apc,
      kinds: hello.kinds.filter(kind => SYMBOL.test(kind)), features: hello.features?.filter(feature => SYMBOL.test(feature)),
    } : { supported: false }));
  }

  override start(...args: Parameters<ProcessTerminal["start"]>): void {
    const log = this.log;
    if (!log) { super.start(...args); return; }
    const [input, resize, disconnect, options] = args;
    super.start(data => {
      const protocol = data.startsWith(TSP_PREFIX);
      let ack = false;
      if (protocol) {
        const raw = splitTspMessage(data);
        if (raw?.verb === "e" && raw.params.c === undefined) {
          try { ack = JSON.parse(raw.body)?.ev === "ack"; } catch {}
        }
      }
      if (protocol) log.message("in", data);
      else {
        const key = data === "\x1b[I" ? "focus-in" : data === "\x1b[O" ? "focus-out"
          : KEYS.find(key => matchesKey(data, key)) ?? "other";
        log.record("keyboard", { key, release: isKeyRelease(data) });
      }
      input(data);
      if (!ack) {
        log.record("dispatch");
      }
    }, () => {
      log.record("tty_resize", { cols: this.columns, rows: this.rows });
      resize();
    }, disconnect, options);
  }

  override write(data: string): void {
    const message = splitTspMessage(data);
    if (message?.verb === "o" && message.params.c === undefined) {
      // Preserve the standalone app's surface identity; SDK surface ownership is unchanged.
      const surface = JSON.parse(message.body);
      surface.title = this.title; surface.role = "terngram";
      data = encodeTspJson("o", surface, message.params);
    }
    this.log?.message("out", data);
    super.write(data);
  }
}
