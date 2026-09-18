import type { ExitNode, TailscaleState } from "../model"

export interface Backend {
  readonly kind: "tailscale" | "demo"
  /** Short label shown in the UI, e.g. "tailscale", "tailscale (sudo)", "demo". */
  readonly label: string
  /** Full status snapshot: self, exit-node capable peers, current exit node, prefs. */
  status(): Promise<TailscaleState>
  /** Name/DNS name of the exit node Tailscale suggests, or null when there is none. */
  suggest(): Promise<string | null>
  /** Route traffic through `node`, or stop using an exit node when `null`. */
  setExitNode(node: ExitNode | null): Promise<void>
  /** Toggle direct LAN access while an exit node is in use. */
  setAllowLan(allow: boolean): Promise<void>
  /** Round-trip time in milliseconds, or null on timeout. */
  ping(node: ExitNode): Promise<number | null>
}

export class BackendError extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = "BackendError"
    this.hint = hint
  }
}
