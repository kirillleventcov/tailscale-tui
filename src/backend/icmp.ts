import { run } from "./exec";
import { BackendError, type PingResult } from "./types";

/** Arguments for one ICMP echo with the platform's `ping` binary. */
export function icmpPingCommand(
  ip: string,
  timeoutSec: number,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32")
    return ["ping", "-n", "1", "-w", String(timeoutSec * 1000), ip];
  // -n: no reverse DNS. Linux -W is seconds; macOS and the BSDs take milliseconds.
  if (platform === "linux")
    return ["ping", "-n", "-c", "1", "-W", String(timeoutSec), ip];
  return ["ping", "-n", "-c", "1", "-W", String(timeoutSec * 1000), ip];
}

/** "64 bytes from 1.1.1.1: icmp_seq=1 ttl=60 time=2.75 ms" -> 2.75; Windows "time<1ms" -> 1 */
export function parseIcmpPing(output: string): number | null {
  const m = /\btime\s*[=<]\s*(\d+(?:[.,]\d+)?)\s*ms\b/i.exec(output);
  if (!m) return null;
  return Number(m[1]!.replace(",", "."));
}

export async function icmpPing(
  ip: string,
  timeoutSec = 3,
): Promise<PingResult> {
  const via = `icmp ${ip}`;
  const res = await run(
    icmpPingCommand(ip, timeoutSec),
    timeoutSec * 1000 + 1500,
  );
  const rtt = parseIcmpPing(res.stdout);
  if (rtt !== null) return { rtt, via };
  if (res.timedOut || res.code <= 1) return { rtt: null, via };
  const text =
    (res.stderr.trim() || res.stdout.trim()).split("\n").pop() ??
    `exit code ${res.code}`;
  throw new BackendError(
    `ping ${ip}: ${text}`,
    "Check that the ping command works for your user",
  );
}
