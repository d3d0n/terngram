import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { encodeTspJson, splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { TerngramApp } from "./app";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { python: { type: "string" }, "data-dir": { type: "string" } },
});
if (!values.python || !values["data-dir"]) throw new Error("Launch with uv run terngram.");
if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("terngram requires an interactive Tern pane with native surface support. Run uv run terngram inside Tern.");
  process.exit(2);
}

class TerngramTerminal extends ProcessTerminal {
  override write(data: string): void {
    const message = splitTspMessage(data);
    if (message?.verb === "o" && message.params.c === undefined) {
      // The shared SDK labels surfaces as omp; this is a standalone application.
      const surface = JSON.parse(message.body);
      surface.title = "terngram";
      surface.role = "terngram";
      super.write(encodeTspJson("o", surface, message.params));
    } else {
      super.write(data);
    }
  }
}

const terminal = new TerngramTerminal();
const tui = new TUI(terminal, false);
let finish!: () => void;
const finished = new Promise<void>(resolve => { finish = resolve; });
const app = new TerngramApp(tui, values.python, values["data-dir"], resolve(import.meta.dir, "../.."), async () => {
  tui.stop();
  finish();
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => { void app.quit(); });
process.stdin.once("end", () => { void app.quit(); });
terminal.onTspHello(hello => {
  if (hello && hello.v === 1 && hello.kinds.includes("input") && hello.kinds.includes("picker")) return;
  void app.quit().then(() => {
    console.error("This terminal did not confirm native Tern input/picker support. Update Tern and try again.");
    process.exitCode = 2;
  });
});

tui.addChild(app);
tui.setFrameProvider(app);
tui.setFocus(app);
tui.start();
void app.start();
await finished;
