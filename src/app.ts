import {
  BoxRenderable,
  InputRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { netcheck, type NetcheckReport } from "./backend/netcheck";
import { BackendError, type Backend } from "./backend/types";
import {
  errorMessage,
  fit,
  relTime,
  truncate,
  width,
  wrapText,
} from "./format";
import { NAME } from "./meta";
import type { Latency, Peer, TailscaleState } from "./model";
import { theme } from "./theme";
import {
  SPINNER,
  btn,
  ch,
  makeChip,
  pointer,
  setChip,
  styled,
  type Chip,
  type Style,
} from "./ui";
import type {
  NetcheckCache,
  Pinger,
  PromptOptions,
  ToastKind,
  View,
  ViewContext,
  ViewId,
} from "./view";
import { DevicesView } from "./views/devices";
import { ExitNodesView } from "./views/exit-nodes";
import { HomeView } from "./views/home";
import { NetworkView } from "./views/network";
import { SettingsView } from "./views/settings";
import { SharingView } from "./views/sharing";

export { computeColumns } from "./views/exit-nodes";

export function errText(e: unknown): string {
  if (e instanceof BackendError && e.hint) return `${e.message}. ${e.hint}`;
  return errorMessage(e);
}

export interface AppOptions {
  backend: Backend;
  /** Auto-refresh interval; 0 disables timers (used by tests). */
  refreshMs?: number;
  showDetails?: boolean;
  version?: string;
  /** View shown first. */
  view?: ViewId;
  /** Runs interactive commands; tests replace it. Defaults to suspending the UI and spawning. */
  spawn?: (argv: string[]) => Promise<number>;
}

const CONFIRM_MS = 4000;
const HELP_WIDTH = 92;
const PROMPT_WIDTH = 68;

export class App {
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  private readonly r: CliRenderer;
  private readonly backend: Backend;
  private readonly refreshMs: number;
  private readonly version: string;
  private readonly spawn?: (argv: string[]) => Promise<number>;

  // ---- shared state
  private state: TailscaleState | null = null;
  private lastError: string | null = null;
  private lastHealth = "";
  private lastRefresh = 0;
  private refreshing = false;
  private busy: string | null = null;
  private spin = 0;
  private suggestedName: string | null = null;
  private armedKey: { key: string; until: number } | null = null;
  private readonly latency = new Map<string, Latency>();
  private readonly latencyVia = new Map<string, string>();
  private pingAllRunning = false;
  private netReport: NetcheckReport | null = null;
  private netError: string | null = null;
  private netRun: Promise<void> | null = null;

  // ---- views
  private readonly views: View[];
  private active!: View;
  private readonly ctx: ViewContext;

  // ---- lifecycle
  private stopped = false;
  private readonly intervals: ReturnType<typeof setInterval>[] = [];
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>();
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private toast: { text: string; kind: ToastKind } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- renderables
  private root!: BoxRenderable;
  private tabBar!: BoxRenderable;
  private tabs: { view: View; chip: Chip }[] = [];
  private helpChip!: Chip;
  private host!: BoxRenderable;
  private viewRoots = new Map<ViewId, BoxRenderable>();
  private toastBox!: BoxRenderable;
  private toastText!: TextRenderable;
  private scrim!: BoxRenderable;
  private helpBox!: BoxRenderable;
  private helpText!: TextRenderable;
  private helpOpen = false;
  private helpHeight = 15;
  private promptBox!: BoxRenderable;
  private promptLabel!: TextRenderable;
  private promptInput!: InputRenderable;
  private promptInputBox!: BoxRenderable;
  private promptHint!: TextRenderable;
  private promptOk!: Chip;
  private promptCancel!: Chip;
  private promptOpts: PromptOptions | null = null;
  private promptError: string | null = null;

  constructor(renderer: CliRenderer, opts: AppOptions) {
    this.r = renderer;
    this.backend = opts.backend;
    this.refreshMs = opts.refreshMs ?? 5000;
    this.version = opts.version ?? "dev";
    this.spawn = opts.spawn;
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.views = [
      new HomeView(),
      new ExitNodesView({ showDetails: opts.showDetails ?? true }),
      new DevicesView(),
      new NetworkView(),
      new SharingView(),
      new SettingsView(),
    ];
    this.ctx = this.makeContext();
    this.build();
    this.bind();
    this.active = this.view(opts.view ?? "home");
    for (const v of this.views)
      this.viewRoots.get(v.id)!.visible = v === this.active;
    this.layout();
  }

  private view(id: ViewId): View {
    return this.views.find((v) => v.id === id) ?? this.views[0]!;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      this.r.setTerminalTitle(NAME);
    } catch {
      // not supported by every output
    }
    this.active.onShow();
    await this.refresh();
    void this.fetchSuggestion();
    if (this.refreshMs > 0) {
      this.intervals.push(
        setInterval(() => void this.refresh(), this.refreshMs),
      );
      this.intervals.push(
        setInterval(
          () => void this.fetchSuggestion(),
          Math.max(60_000, this.refreshMs * 6),
        ),
      );
    }
  }

  /** Stop timers and listeners; does not destroy the renderer (the owner does that). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active.onHide();
    for (const v of this.views) v.dispose();
    for (const t of this.intervals) clearInterval(t);
    this.intervals.length = 0;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.r.keyInput.off("keypress", this.onKey);
    this.resolveDone();
  }

  quit(): void {
    this.stop();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timeouts.add(t);
  }

  // -------------------------------------------------------------------------
  // Context handed to the views
  // -------------------------------------------------------------------------

  private makeContext(): ViewContext {
    const app = this;
    const pinger: Pinger = {
      get: (id) => app.latency.get(id),
      via: (id) => app.latencyVia.get(id),
      get allRunning() {
        return app.pingAllRunning;
      },
      ping: (p, opts) => app.pingOne(p, opts?.quiet === true),
      pingAll: (targets) => app.pingAll(targets),
    };
    const net: NetcheckCache = {
      get report() {
        return app.netReport;
      },
      get error() {
        return app.netError;
      },
      get running() {
        return app.netRun !== null;
      },
      run: () => app.runNetcheck(),
    };
    return {
      r: this.r,
      backend: this.backend,
      get state() {
        return app.state;
      },
      get error() {
        return app.lastError;
      },
      get busy() {
        return app.busy;
      },
      get suggested() {
        return app.suggestedName;
      },
      pinger,
      netcheck: net,
      version: this.version,
      refreshMs: this.refreshMs,
      refresh: () => this.refresh(),
      fetchSuggestion: () => this.fetchSuggestion(),
      notify: (text, kind, ms) => this.notify(text, kind, ms),
      runAction: (label, fn, opts) => this.runAction(label, fn, opts),
      confirm: (key, warning) => this.confirm(key, warning),
      armed: () =>
        this.armedKey && Date.now() < this.armedKey.until
          ? this.armedKey.key
          : null,
      go: (id, select) => this.go(id, select),
      copy: (text, what) => this.copy(text, what),
      prompt: (opts) => this.openPrompt(opts),
      runInteractive: (argv, banner) => this.runInteractive(argv, banner),
      busyTitle: () =>
        this.busy
          ? `· ${SPINNER[this.spin % SPINNER.length]} ${this.busy} `
          : "",
    };
  }

  // -------------------------------------------------------------------------
  // Building the tree
  // -------------------------------------------------------------------------

  private build(): void {
    const r = this.r;
    this.root = new BoxRenderable(r, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
    });

    // ---- tab strip
    this.tabBar = new BoxRenderable(r, {
      id: "tabs",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingX: 1,
      gap: 1,
    });
    for (const v of this.views) {
      const chip = makeChip(r, `tab-${v.id}`, v.title, () => this.go(v.id));
      this.tabs.push({ view: v, chip });
      this.tabBar.add(chip.box);
    }
    this.tabBar.add(
      new BoxRenderable(r, { id: "tabs-spacer", flexGrow: 1, height: 1 }),
    );
    this.helpChip = makeChip(r, "help", "?", () => this.toggleHelp());
    this.tabBar.add(this.helpChip.box);

    // ---- view host
    this.host = new BoxRenderable(r, {
      id: "host",
      flexGrow: 1,
      flexDirection: "column",
    });
    for (const v of this.views) {
      const root = new BoxRenderable(r, {
        id: `view-${v.id}`,
        flexGrow: 1,
        flexDirection: "column",
        visible: false,
      });
      this.viewRoots.set(v.id, root);
      this.host.add(root);
      v.build(this.ctx, root);
    }

    // ---- toast (absolute, bottom right)
    this.toastBox = new BoxRenderable(r, {
      id: "toast",
      position: "absolute",
      right: 1,
      bottom: 0,
      zIndex: 50,
      height: 1,
      paddingX: 1,
      visible: false,
      backgroundColor: theme.toastInfoBg,
      onMouseDown: () => this.hideToast(),
    });
    this.toastText = new TextRenderable(r, {
      id: "toast-text",
      content: "",
      height: 1,
      wrapMode: "none",
      fg: theme.text,
      selectable: false,
    });
    this.toastBox.add(this.toastText);

    // ---- overlays: help and prompt share the scrim
    this.scrim = new BoxRenderable(r, {
      id: "scrim",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 99,
      visible: false,
      backgroundColor: theme.scrim,
      onMouseDown: () => {
        if (this.promptOpts) this.closePrompt();
        else this.toggleHelp(false);
      },
    });
    this.helpBox = new BoxRenderable(r, {
      id: "helpbox",
      position: "absolute",
      zIndex: 100,
      visible: false,
      width: 76,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: " Keyboard and mouse ",
      titleColor: theme.accent,
      backgroundColor: theme.panel,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      onMouseDown: (e) => e.stopPropagation(),
    });
    this.helpText = new TextRenderable(r, {
      id: "help-text",
      content: "",
      wrapMode: "none",
      fg: theme.text,
    });
    this.helpBox.add(this.helpText);
    this.buildPrompt();

    this.root.add(this.tabBar);
    this.root.add(this.host);
    this.root.add(this.toastBox);
    this.root.add(this.scrim);
    this.root.add(this.helpBox);
    this.root.add(this.promptBox);
    r.root.add(this.root);
  }

  private buildPrompt(): void {
    const r = this.r;
    this.promptBox = new BoxRenderable(r, {
      id: "prompt",
      position: "absolute",
      zIndex: 100,
      visible: false,
      width: PROMPT_WIDTH,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      titleColor: theme.accent,
      backgroundColor: theme.panel,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      onMouseDown: (e) => e.stopPropagation(),
    });
    this.promptLabel = new TextRenderable(r, {
      id: "prompt-label",
      content: "",
      wrapMode: "word",
      fg: theme.text,
    });
    this.promptInputBox = new BoxRenderable(r, {
      id: "prompt-inputbox",
      height: 3,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderFocus,
      paddingX: 1,
      onMouseDown: () => this.promptInput.focus(),
      onMouseOver: () => pointer(r, "text"),
      onMouseOut: () => pointer(r, "default"),
    });
    this.promptInput = new InputRenderable(r, {
      id: "prompt-input",
      flexGrow: 1,
      placeholderColor: theme.textMuted,
      textColor: theme.text,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      cursorColor: theme.accent,
    });
    this.promptInputBox.add(this.promptInput);
    this.promptHint = new TextRenderable(r, {
      id: "prompt-hint",
      content: "",
      wrapMode: "word",
      fg: theme.textMuted,
    });
    const buttons = new BoxRenderable(r, {
      id: "prompt-buttons",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      marginTop: 1,
    });
    this.promptOk = makeChip(
      r,
      "prompt-ok",
      "OK",
      () => void this.submitPrompt(),
    );
    this.promptCancel = makeChip(r, "prompt-cancel", "Cancel", () =>
      this.closePrompt(),
    );
    buttons.add(this.promptOk.box);
    buttons.add(this.promptCancel.box);
    this.promptBox.add(this.promptLabel);
    this.promptBox.add(this.promptInputBox);
    this.promptBox.add(this.promptHint);
    this.promptBox.add(buttons);
  }

  private bind(): void {
    this.r.keyInput.on("keypress", this.onKey);
    this.r.on("resize", () => this.layout());
    this.r.once("destroy", () => this.stop());
  }

  // -------------------------------------------------------------------------
  // Layout and rendering
  // -------------------------------------------------------------------------

  private layout(): void {
    if (this.stopped) return;
    const W = this.r.width;
    const H = this.r.height;
    this.renderTabs();
    this.active.layout(W, Math.max(1, H - 1));
    this.helpBox.width = Math.max(30, Math.min(HELP_WIDTH, W - 4));
    if (this.helpOpen) this.renderHelp();
    this.centerOverlays();
    this.active.render();
    this.renderToast();
  }

  private centerOverlays(): void {
    const W = this.r.width;
    const H = this.r.height;
    const hw = Math.max(30, Math.min(HELP_WIDTH, W - 4));
    this.helpBox.left = Math.max(0, Math.floor((W - hw) / 2));
    this.helpBox.top = Math.max(0, Math.floor((H - this.helpHeight) / 2));
    const pw = Math.max(30, Math.min(PROMPT_WIDTH, W - 4));
    this.promptBox.width = pw;
    this.promptBox.left = Math.max(0, Math.floor((W - pw) / 2));
    this.promptBox.top = Math.max(0, Math.floor((H - 12) / 2));
  }

  private renderTabs(): void {
    const W = this.r.width;
    // Full labels, then short ones; the digit that selects a tab stays while there is room.
    const need = (label: (v: View) => string, digits: boolean) =>
      this.views.reduce(
        (w, v) => w + width(label(v)) + (digits ? 2 : 0) + 3,
        0,
      );
    const room = W - 2 - 4;
    const [label, digits] =
      need((v) => v.title, true) <= room
        ? [(v: View) => v.title, true]
        : need((v) => v.short, true) <= room
          ? [(v: View) => v.short, true]
          : [(v: View) => v.short, false];
    this.tabs.forEach(({ view, chip }, i) => {
      const on = view === this.active;
      const chunks: TextChunk[] = [];
      if (digits)
        chunks.push(
          ch(`${i + 1} `, {
            fg: on ? theme.accent : theme.textMuted,
            bold: on,
          }),
        );
      chunks.push(
        ch(label(view), { fg: on ? theme.text : theme.textDim, bold: on }),
      );
      chip.box.backgroundColor = on ? theme.selBg : "transparent";
      chip.text.content = styled(chunks);
    });
    setChip(this.helpChip, "?", { fg: theme.accent, bold: true });
  }

  private renderToast(): void {
    if (this.stopped) return;
    if (!this.toast) {
      this.toastBox.visible = false;
      return;
    }
    const k = this.toast.kind;
    const bg =
      k === "ok"
        ? theme.toastOkBg
        : k === "warn"
          ? theme.toastWarnBg
          : k === "error"
            ? theme.toastErrorBg
            : theme.toastInfoBg;
    const icon =
      k === "ok" ? "✓ " : k === "warn" ? "⚠ " : k === "error" ? "✗ " : "• ";
    this.toastBox.backgroundColor = bg;
    this.toastText.content = styled([
      ch(icon + truncate(this.toast.text, Math.max(10, this.r.width - 8)), {
        fg: theme.text,
        bold: true,
      }),
    ]);
    this.toastBox.visible = true;
  }

  private renderHelp(): void {
    const boxW = Math.max(30, Math.min(HELP_WIDTH, this.r.width - 4));
    const inner = boxW - 6; // border + paddingX on both sides
    const labelW = 14;
    const chunks: TextChunk[] = [];
    let lines = 0;
    const sections: [string, string][] = [
      ...this.active.help(),
      ["Views", "1-6 or click a tab · [ ] previous and next view"],
      ["General", "r/F5 refresh · ? or F1 this help · Esc dismiss · q quit"],
    ];
    for (const [label, text] of sections) {
      const wrapped = wrapText(text, Math.max(10, inner - labelW));
      wrapped.forEach((part, j) => {
        if (lines > 0) chunks.push(ch("\n"));
        chunks.push(
          ch(fit(j === 0 ? label : "", labelW), {
            fg: theme.accent,
            bold: true,
          }),
          ch(part, { fg: theme.text }),
        );
        lines++;
      });
    }
    const refresh =
      this.refreshMs > 0
        ? `every ${Math.round(this.refreshMs / 1000)}s`
        : "manual";
    const status: [string, Style][] = [
      [
        `${NAME} v${this.version} · backend ${this.backend.label} · refresh ${refresh}`,
        { fg: theme.textDim },
      ],
    ];
    const s = this.state;
    if (s) {
      const who: string[] = [];
      if (s.tailnet) who.push(`tailnet ${s.tailnet}`);
      if (s.self)
        who.push(
          `device ${s.self.hostName}${s.self.exitNodeOption ? " (exit node)" : ""}`,
        );
      if (who.length) status.push([who.join(" · "), { fg: theme.textDim }]);
      const online = s.nodes.filter((n) => n.online).length;
      const parts = [
        `LAN access ${s.allowLan === null ? "unknown" : s.allowLan ? "on" : "off"}`,
        `${s.nodes.length} exit nodes (${online} online)`,
      ];
      if (this.lastRefresh)
        parts.push(`updated ${relTime(new Date(this.lastRefresh))}`);
      status.push([parts.join(" · "), { fg: theme.textDim }]);
      for (const h of s.health) status.push([`⚠ ${h}`, { fg: theme.yellow }]);
    }
    if (this.lastError) status.push([`✗ ${this.lastError}`, { fg: theme.red }]);
    chunks.push(ch("\n"));
    lines++;
    for (const [text, style] of status) {
      for (const part of wrapText(text, Math.max(10, inner))) {
        chunks.push(ch("\n"), ch(part, style));
        lines++;
      }
    }
    this.helpText.content = styled(chunks);
    this.helpHeight = Math.min(this.r.height, lines + 4);
    this.helpBox.height = this.helpHeight;
  }

  private renderAll(): void {
    if (this.stopped) return;
    this.renderTabs();
    this.active.render();
    this.renderToast();
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private go(id: ViewId, select?: string): void {
    if (this.stopped) return;
    const next = this.view(id);
    if (next === this.active) {
      if (select) next.onShow(select);
      next.render();
      return;
    }
    this.active.onHide();
    this.viewRoots.get(this.active.id)!.visible = false;
    this.active = next;
    this.viewRoots.get(next.id)!.visible = true;
    this.layout();
    next.onShow(select);
    this.renderAll();
    this.r.requestRender();
  }

  private cycle(delta: number): void {
    const i = this.views.indexOf(this.active);
    const n = this.views.length;
    this.go(this.views[(i + delta + n) % n]!.id);
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const s = await this.backend.status();
      if (this.stopped) return;
      this.state = s;
      this.lastRefresh = Date.now();
      this.lastError = null;
      const health = s.health.join(" · ");
      if (health !== this.lastHealth) {
        this.lastHealth = health;
        if (health) this.notify(health, "warn", 8000);
      }
    } catch (e) {
      const msg = errText(e);
      if (msg !== this.lastError) {
        this.lastError = msg;
        this.notify(msg, "error", 6000);
      }
    } finally {
      this.refreshing = false;
      this.renderAll();
    }
  }

  private async fetchSuggestion(): Promise<void> {
    try {
      const s = await this.backend.suggest();
      if (this.stopped) return;
      if (s !== this.suggestedName) {
        this.suggestedName = s;
        this.renderAll();
      }
    } catch {
      // suggestions are optional
    }
  }

  private runNetcheck(): Promise<void> {
    if (this.netRun) return this.netRun;
    this.netRun = (async () => {
      try {
        this.netReport = await netcheck(this.backend);
        this.netError = null;
      } catch (e) {
        this.netError = errText(e);
      } finally {
        this.netRun = null;
        this.renderAll();
      }
    })();
    this.renderAll();
    return this.netRun;
  }

  private manualRefresh(): void {
    void this.refresh();
    void this.fetchSuggestion();
    this.active.reload?.();
    this.notify("Refreshed", "info", 1200);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private notify(text: string, kind: ToastKind = "info", ms = 3500): void {
    this.toast = { text, kind };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toast = null;
      this.renderToast();
    }, ms);
    this.renderToast();
  }

  private hideToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toast = null;
    this.renderToast();
  }

  private async runAction(
    label: string,
    fn: () => Promise<void>,
    opts: { onOk?: () => void; refresh?: boolean } = {},
  ): Promise<boolean> {
    if (this.busy) {
      this.notify(`Still busy: ${this.busy}`, "warn");
      return false;
    }
    this.busy = label;
    this.spinnerTimer ??= setInterval(() => {
      this.spin++;
      this.active.renderBusy();
    }, 100);
    this.active.renderBusy();
    let ok = false;
    try {
      await fn();
      ok = true;
      if (opts.refresh !== false) {
        this.refreshing = false;
        await this.refresh();
        this.later(1500, () => void this.refresh());
        this.later(4000, () => void this.refresh());
      }
      opts.onOk?.();
    } catch (e) {
      this.notify(errText(e), "error", 8000);
    } finally {
      this.busy = null;
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.renderAll();
    }
    return ok;
  }

  private confirm(key: string, warning: string): boolean {
    const now = Date.now();
    if (this.armedKey?.key === key && now < this.armedKey.until) {
      this.armedKey = null;
      return true;
    }
    this.armedKey = { key, until: now + CONFIRM_MS };
    this.notify(warning, "warn", CONFIRM_MS);
    this.later(CONFIRM_MS + 50, () => this.active.render());
    return false;
  }

  private copy(text: string, what?: string): void {
    let ok = false;
    try {
      ok = this.r.copyToClipboardOSC52(text);
    } catch {
      ok = false;
    }
    if (ok) this.notify(`Copied ${what ?? text} to the clipboard`, "ok");
    else
      this.notify(
        `Clipboard not available in this terminal (${text})`,
        "warn",
        5000,
      );
  }

  private pingOne(p: Peer, quiet = false): void {
    if (this.latency.get(p.id) === "pending") return;
    this.latency.set(p.id, "pending");
    this.active.render();
    this.backend
      .ping(p)
      .then((res) => {
        if (this.stopped) return;
        this.latency.set(p.id, res.rtt);
        this.latencyVia.set(p.id, res.via);
        this.onLatency();
      })
      .catch((e) => {
        if (this.stopped) return;
        this.latency.delete(p.id);
        this.latencyVia.delete(p.id);
        if (!quiet) this.notify(errText(e), "error", 6000);
        this.onLatency();
      });
  }

  private onLatency(): void {
    this.active.onLatency?.();
    this.active.render();
  }

  private pingAll(nodes: Peer[]): void {
    if (this.pingAllRunning) {
      this.notify("Still pinging", "info");
      return;
    }
    const targets = nodes.filter(
      (n) => n.online && this.latency.get(n.id) !== "pending",
    );
    if (targets.length === 0) {
      this.notify("No online nodes to ping in the current view", "info");
      return;
    }
    this.notify(`Pinging ${targets.length} nodes…`, "info", 2500);
    for (const n of targets) this.latency.set(n.id, "pending");
    this.pingAllRunning = true;
    let i = 0;
    let replied = 0;
    let firstError: string | null = null;
    const worker = async () => {
      while (i < targets.length && !this.stopped) {
        const n = targets[i++]!;
        try {
          const res = await this.backend.ping(n);
          this.latency.set(n.id, res.rtt);
          this.latencyVia.set(n.id, res.via);
          if (res.rtt !== null) replied++;
        } catch (e) {
          this.latency.delete(n.id);
          this.latencyVia.delete(n.id);
          firstError ??= errText(e);
        }
        if (!this.stopped) this.onLatency();
      }
    };
    this.active.render();
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(8, targets.length); w++)
      workers.push(worker());
    void Promise.all(workers).then(() => {
      this.pingAllRunning = false;
      if (this.stopped) return;
      this.active.render();
      if (firstError)
        this.notify(
          `${replied} of ${targets.length} replied · ${firstError}`,
          "warn",
          6000,
        );
      else
        this.notify(
          `Pinged ${targets.length} nodes, ${replied} replied`,
          "ok",
          4000,
        );
    });
  }

  private async runInteractive(
    argv: string[],
    banner: string,
  ): Promise<number> {
    if (this.spawn) return this.spawn(argv);
    this.r.suspend();
    try {
      process.stdout.write(`\x1b[2J\x1b[H\x1b[2m${banner}\x1b[0m\n\n`);
      const proc = Bun.spawn(argv, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await proc.exited;
      // Keep a failure on screen until it has been read.
      if (code !== 0) {
        process.stdout.write(
          `\n\x1b[2m${argv[0]} exited with code ${code}. Press Enter to return.\x1b[0m`,
        );
        await new Promise<void>((resolve) => {
          process.stdin.resume();
          process.stdin.once("data", () => {
            process.stdin.pause();
            resolve();
          });
        });
      }
      return code;
    } catch (e) {
      this.later(0, () => this.notify(errText(e), "error", 6000));
      return 1;
    } finally {
      this.r.resume();
      this.layout();
      void this.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // Help and prompt overlays
  // -------------------------------------------------------------------------

  private toggleHelp(open?: boolean): void {
    const next = open ?? !this.helpOpen;
    if (next === this.helpOpen) return;
    this.helpOpen = next;
    if (next) this.renderHelp();
    this.scrim.visible = next;
    this.helpBox.visible = next;
    this.centerOverlays();
  }

  private openPrompt(opts: PromptOptions): void {
    this.toggleHelp(false);
    this.promptOpts = opts;
    this.promptError = null;
    this.promptBox.title = ` ${opts.title} `;
    this.promptLabel.content = opts.label ?? "";
    this.promptLabel.visible = !!opts.label;
    this.promptInput.placeholder = opts.placeholder ?? "";
    this.promptInput.value = opts.value ?? "";
    this.renderPromptHint();
    setChip(this.promptOk, opts.confirm, btn.primary);
    setChip(this.promptCancel, "Cancel", btn.normal);
    this.scrim.visible = true;
    this.promptBox.visible = true;
    this.centerOverlays();
    this.promptInput.focus();
    this.promptInput.gotoLineEnd();
  }

  private renderPromptHint(): void {
    const o = this.promptOpts;
    const chunks: TextChunk[] = [];
    if (this.promptError) chunks.push(ch(this.promptError, { fg: theme.red }));
    else if (o?.hint) chunks.push(ch(o.hint, { fg: theme.textMuted }));
    this.promptHint.content = styled(chunks);
    this.promptHint.visible = chunks.length > 0;
  }

  private closePrompt(): void {
    if (!this.promptOpts) return;
    this.promptOpts = null;
    this.promptInput.blur();
    this.scrim.visible = false;
    this.promptBox.visible = false;
  }

  private async submitPrompt(): Promise<void> {
    const o = this.promptOpts;
    if (!o) return;
    const value = this.promptInput.value.trim();
    const err = await o.onSubmit(value);
    if (typeof err === "string" && err) {
      this.promptError = err;
      this.renderPromptHint();
      return;
    }
    if (this.promptOpts === o) this.closePrompt();
  }

  /** Tab in a path prompt: extend to the longest common prefix, list the candidates when ambiguous. */
  private completePath(): void {
    const raw = this.promptInput.value;
    const home = homedir();
    const abs = raw.startsWith("~") ? home + raw.slice(1) : raw;
    const slash = abs.lastIndexOf("/");
    const dir = slash >= 0 ? abs.slice(0, slash + 1) : "./";
    const base = slash >= 0 ? abs.slice(slash + 1) : abs;
    let names: string[];
    try {
      names = readdirSync(dir).filter(
        (n) =>
          n.startsWith(base) && (base.startsWith(".") || !n.startsWith(".")),
      );
    } catch {
      return;
    }
    if (names.length === 0) return;
    let common = names[0]!;
    for (const n of names)
      while (!n.startsWith(common)) common = common.slice(0, -1);
    let next = (slash >= 0 ? dir : "") + common;
    if (names.length === 1) {
      try {
        if (statSync(join(dir, common)).isDirectory()) next += "/";
      } catch {
        // not a directory we can stat
      }
    }
    if (raw.startsWith("~") && next.startsWith(home))
      next = "~" + next.slice(home.length);
    this.promptInput.value = next;
    this.promptInput.gotoLineEnd();
    this.promptError = null;
    if (names.length > 1 && common === base) {
      const list = names.sort().slice(0, 40).join("  ");
      this.promptHint.content = styled([
        ch(truncate(list, PROMPT_WIDTH * 2), { fg: theme.textDim }),
      ]);
      this.promptHint.visible = true;
    } else this.renderPromptHint();
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private onKey = (key: KeyEvent): void => {
    if (this.stopped) return;
    if (this.promptOpts) {
      this.onPromptKey(key);
      return;
    }
    if (this.helpOpen) {
      key.preventDefault();
      key.stopPropagation();
      if (
        ["escape", "return", "q", "f1", "space"].includes(key.name) ||
        key.sequence === "?"
      )
        this.toggleHelp(false);
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      this.quit();
      return;
    }
    if (this.active.typing()) {
      this.active.onKey(key);
      return;
    }
    const k = key.name;
    const n = Number(key.sequence);
    if (
      !key.ctrl &&
      !key.meta &&
      Number.isInteger(n) &&
      n >= 1 &&
      n <= this.views.length
    ) {
      this.go(this.views[n - 1]!.id);
      return;
    }
    if (key.sequence === "[") return this.cycle(-1);
    if (key.sequence === "]") return this.cycle(1);
    if (k === "?" || key.sequence === "?" || k === "f1")
      return this.toggleHelp(true);
    if (k === "q" && !key.ctrl) return this.quit();
    if ((k === "r" && !key.ctrl && !key.shift) || k === "f5")
      return this.manualRefresh();
    if (this.active.onKey(key)) return;
    if (k === "escape" && this.toast) this.hideToast();
  };

  private onPromptKey(key: KeyEvent): void {
    const k = key.name;
    if (key.ctrl && k === "c") {
      key.preventDefault();
      this.quit();
      return;
    }
    if (k === "escape") {
      key.preventDefault();
      this.closePrompt();
      return;
    }
    if (k === "return" || k === "enter") {
      key.preventDefault();
      void this.submitPrompt();
      return;
    }
    if (k === "tab") {
      key.preventDefault();
      if (this.promptOpts?.completePaths) this.completePath();
    }
  }
}
