import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { isKeyRelease, matchesKey } from "@oh-my-pi/pi-tui/keys";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { type Component, type OverlayFocusOwner, type OverlayHandle, TUI } from "@oh-my-pi/pi-tui/tui";
import { DebugLog, type DebugState, DebugTerminal } from "./debug-log";
import { button, label } from "./nodes";

const STEPS = [
  "База: напечатай aaa в редакторе. Ctrl+N — следующий шаг.",
  "Окно: Cmd+Tab в другое приложение на 10 секунд, вернись и напечатай bbb.",
  "Вкладка: открой другую вкладку Tern на 10 секунд, вернись и напечатай ccc.",
  "Панель: переключись в соседнюю split-панель на 10 секунд, вернись и напечатай ddd.",
  "Долгая пауза: оставь другую вкладку/приложение активным на 2–3 минуты, вернись и напечатай eee.",
  "Размер: уйди в другую вкладку, измени размер окна, вернись и напечатай fff.",
  "Overlay: Ctrl+G, напечатай ggg; уйди на 10 секунд, вернись и напечатай hhh. Esc, затем iii в основном редакторе.",
] as const;

export class FocusProbe {
  readonly editor = new Editor(getEditorTheme());
  private popup?: Editor;
  private overlay?: OverlayHandle;
  private step = 0;
  private changes = 0;
  private lastInput = performance.now();
  constructor(private tui: TUI, private log: DebugLog, private quit: () => void) {
    this.editor.placeholder = () => "Только тестовые буквы; текст не записывается";
    this.editor.onChange = () => { this.lastInput = performance.now(); this.changes++; this.log.record("model_edit", this.snapshot()); this.tui.requestRender(); };
    this.tui.addInputListener(data => {
      this.lastInput = performance.now();
      if (isKeyRelease(data)) return undefined;
      if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+q")) { this.quit(); return { consume: true }; }
      if (matchesKey(data, "ctrl+n")) { this.next(); return { consume: true }; }
      if (matchesKey(data, "ctrl+g")) { this.toggleOverlay(); return { consume: true }; }
      if (this.overlay && matchesKey(data, "escape")) { this.toggleOverlay(); return { consume: true }; }
      return undefined;
    });
  }
  snapshot(): DebugState {
    const focused = this.tui.getFocused();
    return { step: this.step + 1, owner: focused === this.editor ? "editor" : this.popup && focused === this.popup ? "overlay-editor" : focused ? "other" : "none",
      editorUnits: this.editor.getText().length, overlayUnits: this.popup?.getText().length ?? 0,
      overlay: !!this.overlay, changes: this.changes, idleMs: Math.round(performance.now() - this.lastInput) };
  }
  begin(): void { this.log.record("step_begin", { instruction: STEPS[this.step], ...this.snapshot() }); }
  private next(): void {
    this.log.record("step_end", this.snapshot());
    if (this.step < STEPS.length - 1) this.step++;
    this.begin(); this.tui.requestRender();
  }
  private toggleOverlay(): void {
    if (this.overlay) {
      this.overlay.hide(); this.overlay = undefined; this.popup = undefined;
      this.tui.setFocus(this.editor);
    } else {
      const editor = new Editor(getEditorTheme());
      editor.placeholder = () => "Тестовый редактор overlay";
      editor.onChange = () => { this.lastInput = performance.now(); this.changes++; this.log.record("model_edit", this.snapshot()); this.tui.requestRender(); };
      this.popup = editor;
      const owner: Component & OverlayFocusOwner = {
        ownsOverlayFocusTarget: component => component === editor,
        describe: () => ({ k: "col", c: [label("Overlay · Esc закрывает"), editor] }),
        render: () => { throw new Error("This probe requires native Tern."); },
      };
      this.overlay = this.tui.showOverlay(owner);
      this.tui.setFocus(editor);
    }
    this.log.record("overlay", this.snapshot()); this.tui.requestRender();
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type !== "action") return;
    if (event.act === "next") this.next();
    else if (event.act === "broken") this.log.record("input_broken", this.snapshot());
    else if (event.act === "quit") this.quit();
  }
  describe(): NativeNode {
    return { k: "col", p: { gap: "sm" }, c: [
      label("Tern focus probe · без Telegram и аккаунта"),
      label(`Лог: ${this.log.path}`),
      label(`Шаг ${this.step + 1}/${STEPS.length}: ${STEPS[this.step]}`),
      label("После каждого шага Ctrl+N. Не кликай редактор после возврата: сначала проверь ввод. Ctrl+G — overlay; Ctrl+Q — сохранить и выйти."),
      label("Если ввод пропал: подожди 10 секунд, нажми кнопку «Ввод сломался», затем заверши. Лог пишется сразу; heartbeat не перерисовывает UI."),
      { k: "row", p: { gap: "sm", wrap: true }, c: [button("next", "Следующий шаг · Ctrl+N"), button("broken", "Ввод сломался"), button("quit", "Завершить · Ctrl+Q")] },
    ] };
  }
  describeSurface() { return { main: [this], dock: [this.editor] }; }
  render(): readonly string[] { throw new Error("This probe requires native Tern."); }
  renderFrame(): never { throw new Error("This probe requires native Tern."); }
  acknowledgeHistory(): never { throw new Error("This probe requires native Tern."); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { output: { type: "string" } } });
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run uv run python -m terngram.focus_probe inside an interactive Tern pane.");
  }
  delete process.env.PI_TUI_TSP_RECORD;
  const path = resolve(values.output ?? `tern-focus-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const log = new DebugLog(path);
  const terminal = new DebugTerminal(log, "Tern focus probe");
  const tui = new TUI(terminal, false);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let stopped = false;
  const quit = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    try { tui.stop(); } finally {
      try { log.record("stop", probe.snapshot()); } finally { log.close(); finish(); }
    }
  };
  const probe = new FocusProbe(tui, log, quit);
  log.snapshot = () => probe.snapshot();
  const heartbeat = setInterval(() => log.record("heartbeat", probe.snapshot()), 5_000);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, quit);
  process.stdin.once("end", quit);
  terminal.onTspHello(hello => {
    if (!hello || !hello.kinds.includes("editor")) { process.exitCode = 2; quit(); }
  });
  try {
    log.record("start", { bun: Bun.version, sdkPin: "18.4.9", pid: process.pid });
    tui.addChild(probe); tui.setFrameProvider(probe); tui.setFocus(probe.editor);
    probe.begin(); tui.start(); await finished;
  } finally {
    quit();
    for (const signal of signals) process.removeListener(signal, quit);
    process.stdin.removeListener("end", quit);
  }
  console.log(log.failure ? `Focus probe stopped recording: ${log.failure}` : `Focus probe saved: ${path}`);
}

if (import.meta.main) await main();
