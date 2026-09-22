import type { BoxRenderable, CliRenderer, KeyEvent } from "@opentui/core";
import type { Backend } from "./backend/types";
import type { NetcheckReport } from "./backend/netcheck";
import type { Latency, Peer, TailscaleState } from "./model";

export type ViewId =
  "home" | "exit" | "devices" | "network" | "sharing" | "settings";

export type ToastKind = "info" | "ok" | "warn" | "error";

export interface PromptOptions {
  title: string;
  /** Line above the input. */
  label?: string;
  value?: string;
  placeholder?: string;
  /** Muted line below the input. */
  hint?: string;
  /** Label of the confirm button, e.g. "Send". */
  confirm: string;
  /** Tab completes file system paths. */
  completePaths?: boolean;
  /** Return an error message to keep the prompt open. */
  onSubmit: (value: string) => string | void | Promise<string | void>;
}

/** Latency measurements shared by every view that pings. */
export interface Pinger {
  get(id: string): Latency | undefined;
  via(id: string): string | undefined;
  readonly allRunning: boolean;
  /** `quiet` skips the error toast (background measurements). */
  ping(p: Peer, opts?: { quiet?: boolean }): void;
  /** Ping every target with up to eight in flight; the result is reported as a toast. */
  pingAll(targets: Peer[]): void;
}

/** `tailscale netcheck`, cached for the session; the dashboard and the Network view share it. */
export interface NetcheckCache {
  readonly report: NetcheckReport | null;
  readonly error: string | null;
  readonly running: boolean;
  run(): Promise<void>;
}

/** Everything a view can use. Views never touch the shell's renderables directly. */
export interface ViewContext {
  readonly r: CliRenderer;
  readonly backend: Backend;
  /** Latest status snapshot; null before the first refresh or when it failed. */
  readonly state: TailscaleState | null;
  /** Why the last status refresh failed, if it did. */
  readonly error: string | null;
  /** Label of the running action, if any. */
  readonly busy: string | null;
  /** DNS name of the exit node Tailscale suggests. */
  readonly suggested: string | null;
  readonly pinger: Pinger;
  readonly netcheck: NetcheckCache;
  readonly version: string;
  readonly refreshMs: number;

  refresh(): Promise<void>;
  fetchSuggestion(): Promise<void>;
  notify(text: string, kind?: ToastKind, ms?: number): void;
  /**
   * Run a state-changing action with the busy spinner; errors become toasts.
   * The status is refreshed afterwards unless `refresh` is false.
   */
  runAction(
    label: string,
    fn: () => Promise<void>,
    opts?: { onOk?: () => void; refresh?: boolean },
  ): Promise<boolean>;
  /**
   * Two-step confirmation for risky actions: the first call arms `key` and shows `warning`,
   * a second call within four seconds returns true.
   */
  confirm(key: string, warning: string): boolean;
  /** The key currently armed by `confirm`, if it has not expired. */
  armed(): string | null;
  go(id: ViewId, select?: string): void;
  copy(text: string, what?: string): void;
  prompt(opts: PromptOptions): void;
  /** Leave the UI, run an interactive command in the terminal, come back when it exits. */
  runInteractive(argv: string[], banner: string): Promise<number>;
  /** " · ⠋ Connecting " while an action runs; list titles append it. */
  busyTitle(): string;
}

export interface View {
  readonly id: ViewId;
  /** Tab label. */
  readonly title: string;
  /** Short tab label for narrow terminals. */
  readonly short: string;
  /** Help overlay sections for this view. */
  help(): [string, string][];
  build(ctx: ViewContext, parent: BoxRenderable): void;
  /** Size of the content area below the tab strip. */
  layout(width: number, height: number): void;
  /** Redraw from the shared state. */
  render(): void;
  /** Redraw only the parts that carry the busy spinner. */
  renderBusy(): void;
  onShow(select?: string): void;
  onHide(): void;
  /** Return true when the key was handled. */
  onKey(key: KeyEvent): boolean;
  /** A text field has the keyboard: the shell must not treat letters and digits as shortcuts. */
  typing(): boolean;
  /** A latency measurement arrived. */
  onLatency?(): void;
  /** `r` was pressed: reload what only this view shows. */
  reload?(): void;
  dispose(): void;
}
