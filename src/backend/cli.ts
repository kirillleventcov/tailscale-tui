import { NAME } from "../meta";
import { BackendError } from "./types";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Go log lines ("2026/09/22 21:57:33 portmap: ...") precede some errors; they are noise here. */
const LOG_LINE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /;

/** Turn a failed CLI result into a BackendError with an actionable hint where one exists. */
export function cliError(res: CliResult, what: string): BackendError {
  if (res.timedOut) return new BackendError(`${what}: timed out`);
  const all = res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`;
  const lower = all.toLowerCase();
  if (
    lower.includes("access denied") ||
    lower.includes("permission denied") ||
    lower.includes("operation not permitted")
  ) {
    const reason = /taildrive sharing not enabled|drive:share/.test(lower)
      ? "Taildrive is not enabled for this device"
      : "access denied";
    return new BackendError(
      `${what}: ${reason}`,
      reason === "access denied"
        ? `Run once: sudo tailscale set --operator=$USER   (or start ${NAME} with --sudo)`
        : 'Add the "drive:share" attribute to this node in the tailnet policy file',
    );
  }
  if (lower.includes("sudo") && lower.includes("password")) {
    return new BackendError(
      `${what}: sudo needs a password`,
      "Use passwordless sudo, or: sudo tailscale set --operator=$USER",
    );
  }
  if (
    lower.includes("failed to connect to local tailscaled") ||
    lower.includes("is tailscale running")
  ) {
    return new BackendError(
      `${what}: tailscaled is not running`,
      "Start it with: sudo systemctl start tailscaled",
    );
  }
  // Tailscale prints the error first and usage or advice after it.
  const line =
    all
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !LOG_LINE.test(l)) ?? all;
  return new BackendError(`${what}: ${line.replace(/^error:\s*/i, "")}`);
}

/** Parse stdout as JSON; a failed command or garbage becomes a BackendError. */
export function parseJson<T>(res: CliResult, what: string): T {
  if (res.code !== 0) throw cliError(res, what);
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw cliError(res, what);
  }
}
