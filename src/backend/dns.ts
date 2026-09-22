import { parseJson } from "./cli";
import type { Backend } from "./types";

/** `tailscale dns status --json`, reduced to what the Network view shows. */
export interface DnsStatus {
  /** This device uses the tailnet's DNS settings (`--accept-dns`). */
  tailscaleDns: boolean;
  magicDns: boolean;
  suffix: string;
  resolvers: string[];
  /** Split DNS: domain suffix -> resolvers. */
  routes: { domain: string; resolvers: string[] }[];
  searchDomains: string[];
  /** Why the OS DNS configuration could not be read, if it could not. */
  systemError: string;
  systemNameservers: string[];
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Obj)
    : null;
}

function strs(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** Resolver entries are objects with an Addr (IP, DoH URL or "http://..."). */
function addrs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (typeof r === "string" ? r : String(obj(r)?.Addr ?? "")))
    .filter((a) => a.length > 0);
}

export function parseDnsStatus(raw: unknown): DnsStatus {
  const j = obj(raw) ?? {};
  const tn = obj(j.CurrentTailnet) ?? {};
  const routes = obj(j.SplitDNSRoutes) ?? {};
  const sys = obj(j.SystemDNS) ?? {};
  return {
    tailscaleDns: j.TailscaleDNS === true,
    magicDns: tn.MagicDNSEnabled === true,
    suffix: String(tn.MagicDNSSuffix ?? "").replace(/\.$/, ""),
    resolvers: addrs(j.Resolvers),
    routes: Object.entries(routes)
      .map(([domain, r]) => ({
        domain: domain.replace(/\.$/, ""),
        resolvers: addrs(r),
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
    searchDomains: strs(j.SearchDomains).map((d) => d.replace(/\.$/, "")),
    systemError: typeof j.SystemDNSError === "string" ? j.SystemDNSError : "",
    systemNameservers: strs(sys.Nameservers),
  };
}

export async function dnsStatus(backend: Backend): Promise<DnsStatus> {
  const res = await backend.cli(["dns", "status", "--json"], {
    timeoutMs: 8000,
  });
  return parseDnsStatus(parseJson(res, "tailscale dns status"));
}
