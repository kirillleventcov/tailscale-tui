// In-memory backend for the UI tests. The node data is a `tailscale status --json` document in the
// exact shape the CLI emits (Tailscale 1.102), fed through the real parser, so the tests exercise
// the same code path as a live tailnet. Tailnet devices carry an OS and key expiry; Mullvad peers
// have no OS, a zero LastSeen and a Location block, as in real output. Every other command the
// views run (get, set, netcheck, dns status, serve, drive, file, switch, up, down, login, logout,
// bugreport) answers with output in the shape the real CLI prints, and changes state the way
// tailscaled would.
import { parseStatus } from "../src/backend/tailscale";
import type { CliResult } from "../src/backend/cli";
import {
  BackendError,
  type Backend,
  type PingResult,
} from "../src/backend/types";
import type { ExitNode, Peer, TailscaleState } from "../src/model";

const SUFFIX = "tail0000.ts.net";
const USER = "1001";
const TAGGED = "2002";
const ZERO = "0001-01-01T00:00:00Z";

interface PeerSpec {
  id: string;
  host: string;
  ip: string;
  mullvad?: boolean;
  os?: string;
  online?: boolean;
  expired?: boolean;
  keyExpiry?: string;
  tags?: string[];
  location?: {
    country: string;
    cc: string;
    city: string;
    cityCode: string;
    priority: number;
  };
  relay?: string;
  curAddr?: string;
  lastSeen?: string;
  exitNodeOption?: boolean;
  /** Publishes SSH host keys (runs Tailscale SSH). */
  ssh?: boolean;
  /** TaildropTargetStatus; 1 means it can receive files. */
  taildrop?: number;
  routes?: string[];
  /** Measured round-trip time in ms; omitted means no reply. */
  rtt?: number;
  /** Public relay address (Mullvad) or endpoint (tailnet) the ping reply comes from. */
  via?: string;
}

const h = (n: number) => `2026-09-18T${String(n).padStart(2, "0")}:00:00Z`;

export const TAILNET_PEERS: PeerSpec[] = [
  {
    id: "nHOMESRVCNTRL",
    host: "home-server",
    ip: "100.64.0.20",
    os: "linux",
    online: true,
    keyExpiry: "2027-03-01T10:00:00Z",
    curAddr: "192.168.0.20:41641",
    lastSeen: h(12),
    rtt: 12,
    via: "via 192.168.0.20:41641",
  },
  {
    id: "nOFFICEGWCNTRL",
    host: "office-gw",
    ip: "100.64.0.21",
    os: "linux",
    online: true,
    tags: ["tag:exit"],
    relay: "hel",
    lastSeen: h(12),
    rtt: 9,
    via: "via DERP(hel)",
  },
  {
    id: "nPIXEL8CNTRL",
    host: "pixel-8",
    ip: "100.64.0.22",
    os: "android",
    online: false,
    keyExpiry: "2027-01-07T15:48:10Z",
    lastSeen: "2026-09-16T08:00:00Z",
  },
  {
    id: "nTHINKPADCNTRL",
    host: "old-thinkpad",
    ip: "100.64.0.23",
    os: "windows",
    online: false,
    expired: true,
    keyExpiry: "2026-06-01T00:00:00Z",
    lastSeen: "2026-05-30T08:00:00Z",
  },
  // Not an exit node: must be filtered out of the exit-node list.
  {
    id: "nPHONECNTRL",
    host: "phone",
    ip: "100.64.0.24",
    os: "iOS",
    online: true,
    exitNodeOption: false,
    taildrop: 1,
  },
  // A server that is not an exit node: Tailscale SSH, Taildrop and a subnet route.
  {
    id: "nNASCNTRL",
    host: "nas",
    ip: "100.64.0.25",
    os: "linux",
    online: true,
    exitNodeOption: false,
    ssh: true,
    taildrop: 1,
    routes: ["192.168.1.0/24"],
    curAddr: "192.168.1.10:41641",
    lastSeen: h(12),
    rtt: 3,
    via: "via 192.168.1.10:41641",
  },
];

export const MULLVAD_PEERS: PeerSpec[] = [
  {
    id: "nFIHEL203CNTRL",
    host: "fi-hel-wg-203",
    ip: "100.64.1.203",
    location: {
      country: "Finland",
      cc: "FI",
      city: "Helsinki",
      cityCode: "HEL",
      priority: 500,
    },
    rtt: 6.2,
    via: "icmp 203.0.113.203",
  },
  {
    id: "nSESTO001CNTRL",
    host: "se-sto-wg-001",
    ip: "100.64.1.1",
    location: {
      country: "Sweden",
      cc: "SE",
      city: "Stockholm",
      cityCode: "STO",
      priority: 100,
    },
    rtt: 14,
    via: "icmp 203.0.113.1",
  },
  {
    id: "nDEFRA001CNTRL",
    host: "de-fra-wg-001",
    ip: "100.64.1.2",
    location: {
      country: "Germany",
      cc: "DE",
      city: "Frankfurt",
      cityCode: "FRA",
      priority: 100,
    },
    rtt: 31,
    via: "icmp 203.0.113.2",
  },
  {
    id: "nDEFRA002CNTRL",
    host: "de-fra-wg-002",
    ip: "100.64.1.3",
    location: {
      country: "Germany",
      cc: "DE",
      city: "Frankfurt",
      cityCode: "FRA",
      priority: 90,
    },
    rtt: 33,
    via: "icmp 203.0.113.3",
  },
  {
    id: "nDEBER001CNTRL",
    host: "de-ber-wg-001",
    ip: "100.64.1.4",
    location: {
      country: "Germany",
      cc: "DE",
      city: "Berlin",
      cityCode: "BER",
      priority: 100,
    },
    rtt: 29,
    via: "icmp 203.0.113.4",
  },
  {
    id: "nGBLON001CNTRL",
    host: "gb-lon-wg-001",
    ip: "100.64.1.5",
    location: {
      country: "UK",
      cc: "GB",
      city: "London",
      cityCode: "LON",
      priority: 100,
    },
    rtt: 41,
    via: "icmp 203.0.113.5",
  },
  {
    id: "nUSLAX402CNTRL",
    host: "us-lax-wg-402",
    ip: "100.64.1.6",
    location: {
      country: "USA",
      cc: "US",
      city: "Los Angeles, CA",
      cityCode: "LAX",
      priority: 100,
    },
    rtt: 166,
    via: "icmp 203.0.113.6",
  },
  {
    id: "nUSNYC301CNTRL",
    host: "us-nyc-wg-301",
    ip: "100.64.1.7",
    location: {
      country: "USA",
      cc: "US",
      city: "New York, NY",
      cityCode: "NYC",
      priority: 100,
    },
    rtt: 112,
    via: "icmp 203.0.113.7",
  },
  {
    id: "nCATOR204CNTRL",
    host: "ca-tor-wg-204",
    ip: "100.64.1.8",
    location: {
      country: "Canada",
      cc: "CA",
      city: "Toronto",
      cityCode: "YYZ",
      priority: 100,
    },
    rtt: 121,
    via: "icmp 203.0.113.8",
  },
  {
    id: "nAUSYD001CNTRL",
    host: "au-syd-wg-001",
    ip: "100.64.1.9",
    location: {
      country: "Australia",
      cc: "AU",
      city: "Sydney",
      cityCode: "SYD",
      priority: 100,
    },
    rtt: 297,
    via: "icmp 203.0.113.9",
  },
  {
    id: "nNLAMS001CNTRL",
    host: "nl-ams-wg-001",
    ip: "100.64.1.10",
    online: false,
    location: {
      country: "Netherlands",
      cc: "NL",
      city: "Amsterdam",
      cityCode: "AMS",
      priority: 100,
    },
  },
].map((p) => ({ ...p, mullvad: true }));

function peerJson(
  p: PeerSpec,
  activeId: string | null,
): Record<string, unknown> {
  const mullvad = p.mullvad === true;
  const online = p.online ?? true;
  const json: Record<string, unknown> = {
    ID: p.id,
    PublicKey: `nodekey:${p.id.toLowerCase()}`,
    HostName: p.host,
    DNSName: mullvad ? `${p.host}.mullvad.ts.net.` : `${p.host}.${SUFFIX}.`,
    OS: mullvad ? "" : (p.os ?? "linux"),
    UserID: Number(p.tags || mullvad ? TAGGED : USER),
    TailscaleIPs: [
      p.ip,
      `fd7a:115c:a1e0::${p.ip.split(".").slice(2).join(":")}`,
    ],
    Tags: mullvad ? ["tag:mullvad-exit-node"] : p.tags,
    Relay: p.relay ?? "",
    CurAddr: p.curAddr ?? "",
    PeerRelay: "",
    RxBytes: p.id === activeId ? 102_898_756 : 0,
    TxBytes: p.id === activeId ? 2_744_692 : 0,
    LastSeen: mullvad ? ZERO : (p.lastSeen ?? ZERO),
    LastHandshake: p.id === activeId ? h(15) : ZERO,
    Online: online,
    ExitNode: p.id === activeId,
    ExitNodeOption: p.exitNodeOption ?? true,
    Active: p.id === activeId || (online && !!p.curAddr),
    TaildropTarget: p.taildrop ?? (mullvad ? 9 : online ? 1 : 5),
    Created: "2026-01-12T09:30:00Z",
  };
  if (p.ssh)
    json.sshHostKeys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD/A1nhozBWREbVfp31ipRNXmSUl8pGVbr+0JV0TXEx",
    ];
  if (p.routes) json.PrimaryRoutes = p.routes;
  if (p.expired) json.Expired = true;
  if (p.keyExpiry) json.KeyExpiry = p.keyExpiry;
  if (p.location) {
    json.Location = {
      Country: p.location.country,
      CountryCode: p.location.cc,
      City: p.location.city,
      CityCode: p.location.cityCode,
      Priority: p.location.priority,
    };
  }
  return json;
}

export interface FixtureOptions {
  exitNodeId?: string | null;
  autoExitNode?: boolean;
  allowLan?: boolean;
  /** Only Mullvad peers, as in a tailnet without its own exit nodes. */
  mullvadOnly?: boolean;
  /** Simulated command latency in ms; 0 resolves immediately. */
  delayMs?: number;
  backendState?: "Running" | "Stopped" | "NeedsLogin";
  health?: string[];
  /** Newer version reported through ClientVersion. */
  update?: string;
  /** Taildrive enabled for this node (the drive:share attribute). */
  drive?: boolean;
  /** Initial `tailscale serve status --json` document. */
  serve?: Record<string, unknown>;
  /** Files waiting in the Taildrop inbox. */
  inbox?: { name: string; bytes: number }[];
  /** State-changing commands fail with access denied, as without root or the operator. */
  denied?: boolean;
}

/** `tailscale get --json` on a fresh Linux install, as Tailscale 1.102 prints it. */
export function defaultPrefs(): Record<string, string | boolean> {
  return {
    "accept-dns": true,
    "accept-routes": false,
    "advertise-connector": false,
    "advertise-exit-node": false,
    "advertise-routes": "",
    "auto-update": false,
    "exit-node": "",
    "exit-node-allow-lan-access": false,
    hostname: "",
    "netfilter-mode": "on",
    nickname: "",
    operator: process.env.USER ?? "",
    "relay-server-port": "",
    "relay-server-static-endpoints": "",
    "report-posture": false,
    "shields-up": false,
    "snat-subnet-routes": true,
    ssh: false,
    "stateful-filtering": false,
    "update-check": true,
    webclient: false,
  };
}

/** `tailscale netcheck` report text, as the CLI prints it. */
export const NETCHECK_OUTPUT = `
Report:
	* Time: 2026-09-22 22:08:57.464337642+03:00
	* UDP: true
	* IPv4: yes, 203.0.113.50:40708
	* IPv6: no, but OS has support
	* MappingVariesByDestIP: false
	* PortMapping: UPnP
	* Nearest DERP: Helsinki
	* DERP latency:
		- hel: 16.5ms  (Helsinki)
		- ams: 33.6ms  (Amsterdam)
		- fra: 44ms    (Frankfurt)
		- nyc: 103.7ms (New York City)
		- sfo: 170.8ms (San Francisco)
`;

const ACCESS_DENIED =
  "Access denied: prefs write access denied\n\nUse 'sudo tailscale set'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n";

const ok = (stdout = ""): CliResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
const fail = (stderr: string, code = 1): CliResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
});

/** Commands that only read state; everything else is recorded in `calls`. */
const READS = [
  /^status/,
  /^get/,
  /^netcheck/,
  /^dns status/,
  /^serve status/,
  /^drive list/,
  /^switch --list/,
];

export class FixtureBackend implements Backend {
  readonly label = "fixture";
  /** Every state-changing command the app ran, in order, as `tailscale` arguments. */
  readonly calls: string[] = [];
  /** Read-only commands, in order. */
  readonly reads: string[] = [];
  readonly peers: PeerSpec[];
  exitNodeId: string | null;
  autoExitNode: boolean;
  backendState: string;
  prefs = defaultPrefs();
  authUrl = "";
  health: string[];
  update: string | null;
  drive: boolean;
  drives: { name: string; path: string; as: string }[] = [];
  serve: Record<string, unknown>;
  inbox: { name: string; bytes: number }[];
  denied: boolean;
  profiles = [
    {
      id: "a1b2",
      nickname: "",
      tailnet: "tsexit-fixture.github",
      account: "you@example.com",
      selected: true,
    },
    {
      id: "c3d4",
      nickname: "work",
      tailnet: "example.com",
      account: "you@work.example",
      selected: false,
    },
  ];
  readonly suggested = "fi-hel-wg-203.mullvad.ts.net.";
  private readonly delayMs: number;

  constructor(opts: FixtureOptions = {}) {
    this.peers = opts.mullvadOnly
      ? MULLVAD_PEERS
      : [...TAILNET_PEERS, ...MULLVAD_PEERS];
    this.exitNodeId = opts.exitNodeId ?? null;
    this.autoExitNode = opts.autoExitNode ?? false;
    this.prefs["exit-node-allow-lan-access"] = opts.allowLan ?? false;
    this.backendState = opts.backendState ?? "Running";
    this.health = opts.health ?? [];
    this.update = opts.update ?? null;
    this.drive = opts.drive ?? false;
    this.serve = opts.serve ?? {};
    this.inbox = opts.inbox ?? [];
    this.denied = opts.denied ?? false;
    this.delayMs = opts.delayMs ?? 0;
  }

  get allowLan(): boolean {
    return this.prefs["exit-node-allow-lan-access"] === true;
  }

  private delay(): Promise<void> {
    return this.delayMs > 0 ? Bun.sleep(this.delayMs) : Promise.resolve();
  }

  private find(id: string | null): PeerSpec | undefined {
    return id ? this.peers.find((p) => p.id === id) : undefined;
  }

  private get running(): boolean {
    return this.backendState === "Running";
  }

  /** The document `tailscale status --json` would print for the current state. */
  statusJson(): Record<string, unknown> {
    const active = this.running ? this.find(this.exitNodeId) : undefined;
    const Peer: Record<string, unknown> = {};
    for (const p of this.peers) {
      const json = peerJson(p, active ? this.exitNodeId : null);
      if (!this.running) json.Online = false;
      Peer[`nodekey:${p.id.toLowerCase()}`] = json;
    }
    return {
      Version: "1.102.4-t3caf7d9e7-g1a2b3c4d5",
      TUN: true,
      BackendState: this.backendState,
      HaveNodeKey: true,
      AuthURL: this.authUrl,
      TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
      Self: {
        ID: "nSELFCNTRL",
        HostName: "my-laptop",
        DNSName: `my-laptop.${SUFFIX}.`,
        OS: "linux",
        UserID: Number(USER),
        TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
        Addrs: ["203.0.113.50:41641", "192.168.1.20:41641"],
        Relay: "hel",
        Online: this.running,
        ExitNode: false,
        ExitNodeOption: this.prefs["advertise-exit-node"] === true,
        Created: "2026-01-02T08:00:00Z",
        KeyExpiry: "2027-03-11T07:24:59Z",
      },
      ExitNodeStatus: active
        ? {
            ID: active.id,
            Online: active.online ?? true,
            TailscaleIPs: [`${active.ip}/32`],
          }
        : null,
      Health: this.health,
      MagicDNSSuffix: SUFFIX,
      CurrentTailnet: {
        Name: "tsexit-fixture.github",
        MagicDNSSuffix: SUFFIX,
        MagicDNSEnabled: true,
      },
      Peer,
      User: {
        [USER]: {
          ID: Number(USER),
          LoginName: "you@example.com",
          DisplayName: "You",
        },
        [TAGGED]: {
          ID: Number(TAGGED),
          LoginName: "tagged-devices",
          DisplayName: "Tagged Devices",
        },
      },
      ...(this.update
        ? {
            ClientVersion: {
              RunningLatest: false,
              LatestVersion: this.update,
              Notify: true,
            },
          }
        : {}),
    };
  }

  /** The document `tailscale debug prefs` would print. */
  prefsJson(): Record<string, unknown> {
    return {
      ExitNodeID: this.exitNodeId ?? "",
      ExitNodeIP: "",
      AutoExitNode: this.autoExitNode ? "any" : "",
      ExitNodeAllowLANAccess: this.allowLan,
    };
  }

  async status(): Promise<TailscaleState> {
    await this.delay();
    return parseStatus(this.statusJson(), this.prefsJson());
  }

  command(args: string[]): string[] {
    return ["tailscale", ...args];
  }

  async cli(
    args: string[],
    opts?: { privileged?: boolean; timeoutMs?: number },
  ): Promise<CliResult> {
    await this.delay();
    const cmd = args.join(" ");
    if (READS.some((re) => re.test(cmd))) {
      this.reads.push(cmd);
      return this.read(args);
    }
    this.calls.push(`${opts?.privileged ? "sudo " : ""}${cmd}`);
    if (this.denied && opts?.privileged) return fail(ACCESS_DENIED);
    return this.write(args);
  }

  private read(args: string[]): CliResult {
    const [a, b] = args;
    if (a === "get")
      return ok(
        JSON.stringify(
          {
            ...this.prefs,
            "exit-node": this.autoExitNode
              ? "auto:any"
              : (this.find(this.exitNodeId)?.ip ?? ""),
          },
          null,
          2,
        ),
      );
    if (a === "netcheck") return ok(NETCHECK_OUTPUT);
    if (a === "dns")
      return ok(
        JSON.stringify({
          TailscaleDNS: this.prefs["accept-dns"],
          CurrentTailnet: {
            MagicDNSEnabled: true,
            MagicDNSSuffix: SUFFIX,
            SelfDNSName: `my-laptop.${SUFFIX}.`,
          },
          Resolvers: [{ Addr: "1.1.1.1" }, { Addr: "9.9.9.9" }],
          SplitDNSRoutes: { "corp.example.com.": [{ Addr: "10.0.0.53" }] },
          SearchDomains: [`${SUFFIX}.`],
          ExitNodeFilteredSet: [".ts.net", ".tailscale.net"],
          SystemDNSError: "Access denied: dns-osconfig dump access denied",
        }),
      );
    if (a === "serve" && b === "status") return ok(JSON.stringify(this.serve));
    if (a === "drive") {
      if (!this.drive)
        return fail(
          'Access denied: taildrive sharing not enabled, please add the attribute "drive:share" to this node in your ACLs\' "nodeAttrs" section\n\nUse \'sudo tailscale drive list\'.\n',
        );
      const w = Math.max(4, ...this.drives.map((d) => d.name.length));
      const pw = Math.max(4, ...this.drives.map((d) => d.path.length));
      const row = (n: string, p: string, as: string) =>
        `${n.padEnd(w)}    ${p.padEnd(pw)}    ${as}\n`;
      return ok(
        row("name", "path", "as") +
          row("-".repeat(w), "-".repeat(pw), "--") +
          this.drives.map((d) => row(d.name, d.path, d.as)).join(""),
      );
    }
    if (a === "switch") return ok(JSON.stringify(this.profiles, null, 2));
    return fail(`unknown command: ${args.join(" ")}`);
  }

  private write(args: string[]): CliResult {
    const [a, b] = args;
    const host = `my-laptop.${SUFFIX}`;
    switch (a) {
      case "set":
        for (const arg of args.slice(1)) {
          const m = /^--([a-z-]+)=(.*)$/.exec(arg);
          if (!m || m[1] === "accept-risk") continue;
          const cur = this.prefs[m[1]!];
          this.prefs[m[1]!] =
            typeof cur === "boolean" ? m[2] === "true" : m[2]!;
        }
        return ok();
      case "up":
        this.backendState = "Running";
        return ok();
      case "down":
        this.backendState = "Stopped";
        return ok();
      case "login":
        this.authUrl = "https://login.tailscale.com/a/1a2b3c4d5e6f";
        return fail(
          `\nTo authenticate, visit:\n\n\t${this.authUrl}\n\ntimeout waiting for Tailscale service to enter a Running state; check health with "tailscale status"\n`,
        );
      case "logout":
        this.backendState = "NeedsLogin";
        this.exitNodeId = null;
        return ok();
      case "switch":
        if (b === "remove")
          this.profiles = this.profiles.filter((p) => p.id !== args[2]);
        else for (const p of this.profiles) p.selected = p.id === b;
        return ok();
      case "bugreport":
        return ok(
          "BUG-1b7641a16971a9cd75822c0ed8043fee70ae88cf05c52981dc220eb96a5c49a8-20260922190000Z-a1b2c3d4e5f6a7b8\n",
        );
      case "update":
        this.update = null;
        return ok("Updating Tailscale from 1.102.4 to 1.104.0\n");
      case "file":
        if (b === "cp") return ok();
        if (b === "get") {
          const dir = args[args.length - 1]!;
          const out = this.inbox
            .map(
              (f) => `wrote ${f.name} as ${dir}/${f.name} (${f.bytes} bytes)\n`,
            )
            .join("");
          const n = this.inbox.length;
          this.inbox = [];
          return ok(`${out}moved ${n}/${n} files\n`);
        }
        break;
      case "serve":
      case "funnel": {
        const rest = args.slice(1).filter((x) => x !== "--bg");
        const target = rest[rest.length - 1]!;
        const flags = rest.filter((x) => x.startsWith("--"));
        const port = /^--https=(\d+)/.exec(flags[0] ?? "")?.[1] ?? "443";
        const mount = /^--set-path=(.+)/.exec(flags[1] ?? "")?.[1] ?? "/";
        const hp = `${host}:${port}`;
        const web = (this.serve.Web ??= {}) as Record<
          string,
          { Handlers: Record<string, unknown> }
        >;
        const tcp = (this.serve.TCP ??= {}) as Record<string, unknown>;
        const funnel = (this.serve.AllowFunnel ??= {}) as Record<
          string,
          boolean
        >;
        if (target === "off") {
          delete web[hp]?.Handlers[mount];
          if (web[hp] && Object.keys(web[hp].Handlers).length === 0) {
            delete web[hp];
            delete tcp[port];
            delete funnel[hp];
          }
          return ok();
        }
        const handler = /^\d+$/.test(target)
          ? { Proxy: `http://127.0.0.1:${target}` }
          : target.startsWith("/")
            ? { Path: target }
            : { Proxy: target };
        (web[hp] ??= { Handlers: {} }).Handlers[mount] = handler;
        tcp[port] = { HTTPS: true };
        if (a === "funnel") funnel[hp] = true;
        else delete funnel[hp];
        return ok(
          `Available within your tailnet:\n\nhttps://${host}/\n|-- proxy ${target}\n\nServe started and running in the background.\n`,
        );
      }
      case "drive":
        if (!this.drive)
          return fail("Access denied: taildrive sharing not enabled\n");
        if (b === "share")
          this.drives.push({ name: args[2]!, path: args[3]!, as: "you" });
        else if (b === "unshare")
          this.drives = this.drives.filter((d) => d.name !== args[2]);
        else if (b === "rename")
          for (const d of this.drives)
            if (d.name === args[2]) d.name = args[3]!;
        return ok();
    }
    return fail(`unknown command: ${args.join(" ")}`);
  }

  async suggest(): Promise<string | null> {
    await this.delay();
    return this.suggested.replace(/\.$/, "");
  }

  async setExitNode(node: ExitNode | null): Promise<void> {
    await this.delay();
    this.calls.push(`set --exit-node=${node ? node.ip : ""}`);
    if (node && !this.find(node.id))
      throw new BackendError(`connect to ${node.name}: no such node`);
    this.exitNodeId = node ? node.id : null;
    // Tailscale clears AutoExitNode whenever ExitNodeID/IP is set explicitly.
    this.autoExitNode = false;
  }

  async setAutoExitNode(): Promise<void> {
    await this.delay();
    this.calls.push("set --exit-node=auto:any");
    this.autoExitNode = true;
    const pick = this.peers.find(
      (p) => `${p.host}.mullvad.ts.net.` === this.suggested,
    );
    this.exitNodeId = pick ? pick.id : null;
  }

  async setAllowLan(allow: boolean): Promise<void> {
    await this.delay();
    this.calls.push(`set --exit-node-allow-lan-access=${allow}`);
    this.prefs["exit-node-allow-lan-access"] = allow;
  }

  async ping(node: Peer): Promise<PingResult> {
    await this.delay();
    const p = this.find(node.id);
    const via = node.isMullvad
      ? (p?.via ?? "icmp")
      : (p?.via ?? "tailscale ping");
    if (!p || p.rtt === undefined || p.online === false)
      return { rtt: null, via };
    return { rtt: p.rtt, via };
  }
}
