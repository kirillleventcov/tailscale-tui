import { cliError } from "./cli";
import type { Backend } from "./types";

export interface DerpRegion {
  /** Region code, e.g. "fra". */
  code: string;
  name: string;
  ms: number;
}

/** `tailscale netcheck`, parsed from its report format (the JSON form has no region names). */
export interface NetcheckReport {
  udp: boolean | null;
  /** Public IPv4 endpoint as seen by the DERP servers, or null when IPv4 does not work. */
  ipv4: string | null;
  ipv6: string | null;
  /** Easy NAT when false: the public port does not change per destination. */
  mappingVaries: boolean | null;
  hairPinning: boolean | null;
  /** UPnP, NAT-PMP or PCP on the router; empty when none answered. */
  portMapping: string;
  captivePortal: boolean | null;
  nearestDerp: string;
  /** Regions sorted by latency, fastest first. */
  derps: DerpRegion[];
  at: number;
}

function boolOf(raw: string): boolean | null {
  return raw === "true" ? true : raw === "false" ? false : null;
}

/** "yes, 62.78.205.81:40708" -> "62.78.205.81:40708"; "no" -> null. */
function endpointOf(raw: string): string | null {
  const v = raw.trim();
  if (!v.startsWith("yes")) return null;
  return v.replace(/^yes,?\s*/, "") || "yes";
}

export function parseNetcheck(output: string, at = Date.now()): NetcheckReport {
  const rep: NetcheckReport = {
    udp: null,
    ipv4: null,
    ipv6: null,
    mappingVaries: null,
    hairPinning: null,
    portMapping: "",
    captivePortal: null,
    nearestDerp: "",
    derps: [],
    at,
  };
  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^\*\s*/, "");
    const kv = /^([A-Za-z0-9 ]+):\s*(.*)$/.exec(line);
    if (kv && !line.startsWith("-")) {
      const [, key, value] = kv as unknown as [string, string, string];
      switch (key) {
        case "UDP":
          rep.udp = boolOf(value);
          break;
        case "IPv4":
          rep.ipv4 = endpointOf(value);
          break;
        case "IPv6":
          rep.ipv6 = endpointOf(value);
          break;
        case "MappingVariesByDestIP":
          rep.mappingVaries = boolOf(value);
          break;
        case "HairPinning":
          rep.hairPinning = boolOf(value);
          break;
        case "PortMapping":
          rep.portMapping = value.trim();
          break;
        case "CaptivePortal":
          rep.captivePortal = boolOf(value);
          break;
        case "Nearest DERP":
          rep.nearestDerp = value.trim();
          break;
      }
      continue;
    }
    const m = /^-\s*([a-z0-9-]+):\s*([\d.]+)\s*(ms|µs|s)\s*\(([^)]+)\)/i.exec(
      line,
    );
    if (m) {
      const v = Number(m[2]);
      const ms = m[3] === "s" ? v * 1000 : m[3] === "µs" ? v / 1000 : v;
      rep.derps.push({ code: m[1]!, name: m[4]!, ms });
    }
  }
  rep.derps.sort((a, b) => a.ms - b.ms);
  return rep;
}

export async function netcheck(backend: Backend): Promise<NetcheckReport> {
  const res = await backend.cli(["netcheck"], { timeoutMs: 30_000 });
  if (res.code !== 0 || !/DERP latency|Report:/.test(res.stdout))
    throw cliError(res, "tailscale netcheck");
  return parseNetcheck(res.stdout);
}
