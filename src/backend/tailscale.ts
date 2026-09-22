import { existsSync } from "node:fs";
import { parseTime } from "../format";
import type {
  ExitNode,
  ExitNodeStatus,
  Peer,
  SelfInfo,
  TailscaleState,
} from "../model";
import { run, type RunResult } from "./exec";
import { icmpPing } from "./icmp";
import { MullvadRelays } from "./mullvad";
import { BackendError, type Backend, type PingResult } from "./types";
import { cliError, type CliResult } from "./cli";

const KNOWN_PATHS = [
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

/** Locate the `tailscale` CLI: $TAILSCALE_BIN, then PATH, then well-known install paths. */
export function findTailscaleBinary(): string | null {
  const fromEnv = process.env.TAILSCALE_BIN;
  if (fromEnv) return fromEnv;
  const onPath = Bun.which("tailscale");
  if (onPath) return onPath;
  for (const p of KNOWN_PATHS) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export interface TailscaleBackendOptions {
  bin: string;
  /** Prefix privileged commands (`tailscale set ...`) with `sudo -n`. */
  sudo?: boolean;
  timeoutMs?: number;
  /** Measure Mullvad nodes with ICMP to their relay's public address (needs api.mullvad.net). Default true. */
  mullvadPing?: boolean;
}

const PING_TIMEOUT_SEC = 3;

export class TailscaleBackend implements Backend {
  readonly label: string;
  private readonly bin: string;
  private readonly sudo: boolean;
  private readonly timeoutMs: number;
  private readonly relays: MullvadRelays | null;

  constructor(opts: TailscaleBackendOptions) {
    this.bin = opts.bin;
    this.sudo = opts.sudo ?? false;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.relays = opts.mullvadPing === false ? null : new MullvadRelays();
    this.label = this.sudo ? "tailscale (sudo)" : "tailscale";
  }

  private run(
    args: string[],
    opts: { privileged?: boolean; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const usesSudo =
      opts.privileged === true && this.sudo && process.platform !== "win32";
    const cmd = usesSudo
      ? ["sudo", "-n", this.bin, ...args]
      : [this.bin, ...args];
    return run(cmd, opts.timeoutMs ?? this.timeoutMs);
  }

  /** Run `tailscale <args...>`; `privileged` commands honor --sudo. */
  cli(
    args: string[],
    opts: { privileged?: boolean; timeoutMs?: number } = {},
  ): Promise<CliResult> {
    return this.run(args, opts);
  }

  /** argv for an interactive `tailscale` command run in the foreground (ssh). */
  command(args: string[]): string[] {
    return [this.bin, ...args];
  }

  private toError(res: RunResult, what: string): BackendError {
    return cliError(res, what);
  }

  async status(): Promise<TailscaleState> {
    const res = await this.run(["status", "--json"]);
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw this.toError(res, "tailscale status");
    }
    const prefs = await this.prefs();
    return parseStatus(json, prefs);
  }

  /** `tailscale debug prefs` exposes ExitNodeAllowLANAccess and AutoExitNode; best effort. */
  private async prefs(): Promise<unknown> {
    try {
      const res = await this.run(["debug", "prefs"], { timeoutMs: 4000 });
      if (res.code !== 0) return null;
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  }

  async suggest(): Promise<string | null> {
    const res = await this.run(["exit-node", "suggest"], { timeoutMs: 15_000 });
    return parseSuggest(`${res.stdout}\n${res.stderr}`);
  }

  async setExitNode(node: ExitNode | null): Promise<void> {
    const target = node ? node.ip || node.dnsName || node.hostName : "";
    const res = await this.run(["set", `--exit-node=${target}`], {
      privileged: true,
    });
    if (res.code !== 0)
      throw this.toError(res, node ? `connect to ${node.name}` : "disconnect");
  }

  async setAutoExitNode(): Promise<void> {
    const res = await this.run(["set", "--exit-node=auto:any"], {
      privileged: true,
    });
    if (res.code !== 0) throw this.toError(res, "auto exit node");
  }

  async setAllowLan(allow: boolean): Promise<void> {
    const res = await this.run(
      ["set", `--exit-node-allow-lan-access=${allow ? "true" : "false"}`],
      { privileged: true },
    );
    if (res.code !== 0) throw this.toError(res, "LAN access");
  }

  async ping(node: Peer): Promise<PingResult> {
    if (node.isMullvad) {
      if (!this.relays) {
        throw new BackendError(
          "Mullvad nodes do not answer Tailscale pings",
          "Start without --no-mullvad-ping to measure them via their relay's public address",
        );
      }
      const ip = await this.relays.lookup(node.hostName || node.name);
      return icmpPing(ip, PING_TIMEOUT_SEC);
    }
    const target = node.ip || node.dnsName;
    const res = await this.run(
      ["ping", "-c", "1", "--timeout", `${PING_TIMEOUT_SEC}s`, target],
      {
        timeoutMs: PING_TIMEOUT_SEC * 1000 + 3000,
      },
    );
    const out = `${res.stdout}\n${res.stderr}`;
    const pong = parsePong(out);
    if (pong) return pong;
    if (res.timedOut || /timed out|no reply/i.test(out))
      return { rtt: null, via: "tailscale ping" };
    throw this.toError(res, `ping ${node.name}`);
  }
}

// ---------------------------------------------------------------------------
// Parsing (exported for tests)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a field tolerating both Go-style (`HostName`) and lowerCamel (`hostName`) keys. */
function g(o: unknown, key: string): unknown {
  if (!isObj(o)) return undefined;
  if (key in o) return o[key];
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  return o[lower];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function stripDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function firstV4(ips: string[]): string {
  return ips.find((ip) => ip.includes(".")) ?? ips[0] ?? "";
}

/** TaildropTargetStatus 1 means the peer can receive files right now. */
const TAILDROP_AVAILABLE = 1;
const EXIT_ROUTES = new Set(["0.0.0.0/0", "::/0"]);

function parsePeer(key: string, p: unknown, users: Map<string, string>): Peer {
  const ips = strList(g(p, "TailscaleIPs")).map((ip) =>
    ip.replace(/\/\d+$/, ""),
  );
  const dnsName = stripDot(str(g(p, "DNSName")));
  const hostName = str(g(p, "HostName"));
  const tags = strList(g(p, "Tags"));
  const loc = g(p, "Location");
  const priority = g(loc, "Priority");
  const userId = g(p, "UserID");
  const isMullvad =
    tags.includes("tag:mullvad-exit-node") ||
    dnsName.endsWith(".mullvad.ts.net");
  return {
    id: str(g(p, "ID"), key),
    key,
    name: dnsName.split(".")[0] || hostName || key.slice(0, 12),
    hostName,
    dnsName,
    ip: firstV4(ips),
    ips,
    os: str(g(p, "OS")),
    online: bool(g(p, "Online")),
    active: bool(g(p, "ExitNode")),
    exitNodeOption: bool(g(p, "ExitNodeOption")),
    expired: bool(g(p, "Expired")),
    keyExpiry: parseTime(g(p, "KeyExpiry")),
    country: str(g(loc, "Country")) || undefined,
    countryCode: str(g(loc, "CountryCode")).toUpperCase() || undefined,
    city: str(g(loc, "City")) || undefined,
    priority: typeof priority === "number" ? priority : undefined,
    isMullvad,
    tags,
    owner: userId !== undefined ? users.get(String(userId)) : undefined,
    lastSeen: parseTime(g(p, "LastSeen")),
    lastHandshake: parseTime(g(p, "LastHandshake")),
    rxBytes: num(g(p, "RxBytes")),
    txBytes: num(g(p, "TxBytes")),
    relay: str(g(p, "Relay")) || undefined,
    curAddr: str(g(p, "CurAddr")) || undefined,
    peerRelay: str(g(p, "PeerRelay")) || undefined,
    inSession: bool(g(p, "Active")),
    ssh: strList(g(p, "sshHostKeys")).length > 0,
    taildrop: g(p, "TaildropTarget") === TAILDROP_AVAILABLE,
    shared: bool(g(p, "ShareeNode")),
    routes: strList(g(p, "PrimaryRoutes")).filter((r) => !EXIT_ROUTES.has(r)),
    created: parseTime(g(p, "Created")),
  };
}

function parseSelf(raw: unknown): SelfInfo | null {
  if (!isObj(raw)) return null;
  const dnsName = stripDot(str(g(raw, "DNSName")));
  const hostName = str(g(raw, "HostName"));
  return {
    id: str(g(raw, "ID")),
    name: dnsName.split(".")[0] || hostName,
    hostName,
    dnsName,
    ips: strList(g(raw, "TailscaleIPs")),
    os: str(g(raw, "OS")),
    online: bool(g(raw, "Online")),
    exitNodeOption: bool(g(raw, "ExitNodeOption")),
    keyExpiry: parseTime(g(raw, "KeyExpiry")),
    relay: str(g(raw, "Relay")) || undefined,
    endpoints: strList(g(raw, "Addrs")),
    created: parseTime(g(raw, "Created")),
  };
}

export function parseStatus(
  json: unknown,
  prefs: unknown = null,
): TailscaleState {
  const users = new Map<string, { login: string; name: string }>();
  const userMap = g(json, "User");
  if (isObj(userMap)) {
    for (const [id, u] of Object.entries(userMap)) {
      const login = str(g(u, "LoginName")) || str(g(u, "DisplayName"));
      if (login)
        users.set(id, { login, name: str(g(u, "DisplayName")) || login });
    }
  }
  const logins = new Map([...users].map(([id, u]) => [id, u.login]));

  const peerMap = g(json, "Peer");
  const peers: Peer[] = [];
  if (isObj(peerMap)) {
    for (const [key, p] of Object.entries(peerMap)) {
      if (isObj(p)) peers.push(parsePeer(key, p, logins));
    }
  }

  const selfRaw = g(json, "Self");
  const self = parseSelf(selfRaw);
  const selfUser = g(selfRaw, "UserID");

  const ens = g(json, "ExitNodeStatus");
  const exitNode: ExitNodeStatus | null = isObj(ens)
    ? {
        id: str(g(ens, "ID")),
        online: bool(g(ens, "Online")),
        ips: strList(g(ens, "TailscaleIPs")).map((ip) =>
          ip.replace(/\/\d+$/, ""),
        ),
      }
    : null;

  // ExitNodeStatus is authoritative for "which node is in use"; make the peer flag agree.
  if (exitNode?.id) {
    for (const n of peers) n.active = n.active || n.id === exitNode.id;
  }

  const allowLanRaw = g(prefs, "ExitNodeAllowLANAccess");
  const autoRaw = g(prefs, "AutoExitNode");
  const tailnet = g(json, "CurrentTailnet");
  const magicDns = g(tailnet, "MagicDNSEnabled");
  const cv = g(json, "ClientVersion");
  const latest = str(g(cv, "LatestVersion"));

  return {
    backendState: str(g(json, "BackendState"), "Unknown"),
    version: str(g(json, "Version")),
    self,
    user: selfUser !== undefined ? (users.get(String(selfUser)) ?? null) : null,
    tailnet: str(g(tailnet, "Name")) || null,
    magicDnsSuffix:
      str(g(json, "MagicDNSSuffix")) ||
      str(g(tailnet, "MagicDNSSuffix")) ||
      null,
    magicDns: typeof magicDns === "boolean" ? magicDns : null,
    authUrl: str(g(json, "AuthURL")),
    exitNode,
    allowLan: typeof allowLanRaw === "boolean" ? allowLanRaw : null,
    autoExitNode: isObj(prefs)
      ? typeof autoRaw === "string" && autoRaw !== ""
      : null,
    health: strList(g(json, "Health")),
    update: latest && g(cv, "RunningLatest") !== true ? latest : null,
    nodes: peers.filter((p) => p.exitNodeOption || p.active),
    peers,
    fetchedAt: Date.now(),
  };
}

/** "Suggested exit node: de-fra-wg-001.mullvad.ts.net." -> "de-fra-wg-001.mullvad.ts.net" */
export function parseSuggest(output: string): string | null {
  const m = /suggested exit node:\s*([^\s,]+)/i.exec(output);
  if (!m) return null;
  return stripDot(m[1]!);
}

/** "pong from foo (100.64.0.1) via DERP(fra) in 45ms" -> { rtt: 45, via: "via DERP(fra)" } */
export function parsePong(output: string): PingResult | null {
  const m =
    /pong from \S+ \([^)]*\)(?: via (\S+))? in (\d+(?:\.\d+)?)\s*(ms|µs|us|s)\b/i.exec(
      output,
    );
  if (!m) return null;
  const v = Number(m[2]);
  const unit = m[3]!.toLowerCase();
  const rtt = unit === "s" ? v * 1000 : unit === "ms" ? v : v / 1000;
  return { rtt, via: m[1] ? `via ${m[1]}` : "tailscale ping" };
}
