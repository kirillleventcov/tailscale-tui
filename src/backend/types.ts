import type { ExitNode, Peer, TailscaleState } from "../model";
import type { CliResult } from "./cli";

export interface PingResult {
  /** Round-trip time in milliseconds, or null when there was no reply. */
  rtt: number | null;
  /** How the measurement was taken, e.g. "tailscale ping via 192.168.0.5:41641" or "icmp 185.65.133.165". */
  via: string;
}

export interface Backend {
  /** Short label shown in the help overlay, e.g. "tailscale" or "tailscale (sudo)". */
  readonly label: string;
  /** Full status snapshot: self, exit-node capable peers, current exit node, prefs. */
  status(): Promise<TailscaleState>;
  /** Run `tailscale <args...>`; `privileged` commands are prefixed with `sudo -n` under --sudo. */
  cli(
    args: string[],
    opts?: { privileged?: boolean; timeoutMs?: number },
  ): Promise<CliResult>;
  /** argv for an interactive `tailscale` command that takes over the terminal (ssh). */
  command(args: string[]): string[];
  /** DNS name of the exit node Tailscale suggests, or null when there is none. */
  suggest(): Promise<string | null>;
  /** Route traffic through `node`, or stop using an exit node when `null`. Either turns auto mode off. */
  setExitNode(node: ExitNode | null): Promise<void>;
  /** Let Tailscale pick and follow the best exit node (`--exit-node=auto:any`). */
  setAutoExitNode(): Promise<void>;
  /** Toggle direct LAN access while an exit node is in use. */
  setAllowLan(allow: boolean): Promise<void>;
  /** Measure the round-trip time to a peer. Rejects when the measurement cannot be attempted. */
  ping(node: Peer): Promise<PingResult>;
}

export class BackendError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "BackendError";
    this.hint = hint;
  }
}
