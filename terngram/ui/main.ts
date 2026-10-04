import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { TerngramApp } from "./app";
import { DebugLog, DebugTerminal } from "./debug-log";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { python: { type: "string" }, "data-dir": { type: "string" }, "debug-log": { type: "string" } },
});
if (!values.python || !values["data-dir"]) throw new Error("Launch with uv run terngram.");
if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("terngram requires an interactive Tern pane with native surface support. Run uv run terngram inside Tern.");
  process.exit(2);
}


const debugLog = values["debug-log"] ? new DebugLog(resolve(values["debug-log"])) : undefined;
if (debugLog) {
  delete process.env.PI_TUI_TSP_RECORD;
  delete process.env.OMP_TUI_DEBUG;
}
const terminal = new DebugTerminal(debugLog);
const tui = new TUI(terminal, false, { nativeSurfaceMode: "screen" });
let finish!: () => void;
const finished = new Promise<void>(resolve => { finish = resolve; });
let heartbeat: NodeJS.Timeout | undefined;
const app = new TerngramApp(tui, values.python, values["data-dir"], resolve(import.meta.dir, "../.."), async () => {
  try { tui.stop(); } finally {
    clearInterval(heartbeat);
    debugLog?.record("stop", { state: app.debugState() });
    debugLog?.close();
    finish();
  }
}, debugLog);
if (debugLog) {
  debugLog.snapshot = () => app.debugState();
  debugLog.captureEdits = () => app.stage === "chats";
  debugLog.record("start", { mode: "client", bun: Bun.version, sdkPin: "18.4.9", pid: process.pid });
  console.log(`Debug log: ${debugLog.path}`);
  heartbeat = setInterval(() => debugLog.record("heartbeat", { state: app.debugState() }), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => { void app.quit(); });
process.stdin.once("end", () => { void app.quit(); });
terminal.onTspHello(hello => {
  if (hello && hello.v === 1 && hello.kinds.includes("input") && hello.kinds.includes("picker")) return;
  void app.quit().then(() => {
    console.error("This terminal did not confirm native Tern input/picker support. Update Tern and try again.");
    process.exitCode = 2;
  });
});

try {
  tui.addChild(app);
  tui.setFrameProvider(app);
  tui.setFocus(app);
  tui.start();
  void app.start();
  await finished;
} finally {
  clearInterval(heartbeat);
  tui.stop();
  debugLog?.close();
}
if (debugLog) {
  console.log(debugLog.failure ? `Debug log stopped recording: ${debugLog.failure}` : `Debug log saved: ${debugLog.path}`);
}
