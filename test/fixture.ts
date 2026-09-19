// In-memory backend for the UI tests. The node data is a `tailscale status --json` document in the
// exact shape the CLI emits (Tailscale 1.102), fed through the real parser, so the tests exercise
// the same code path as a live tailnet. Tailnet devices carry an OS and key expiry; Mullvad peers
// have no OS, a zero LastSeen and a Location block, as in real output.
import { parseStatus } from "../src/backend/tailscale";
import {
  BackendError,
  type Backend,
  type PingResult,
} from "../src/backend/types";
import type { ExitNode, TailscaleState } from "../src/model";

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
  // Not an exit node: must be filtered out by the parser.
  {
    id: "nPHONECNTRL",
    host: "phone",
    ip: "100.64.0.24",
    os: "iOS",
    online: true,
    exitNodeOption: false,
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
    Active: p.id === activeId,
  };
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
}

export class FixtureBackend implements Backend {
  readonly label = "fixture";
  /** Every state-changing CLI call the app made, in order, as `tailscale set` arguments. */
  readonly calls: string[] = [];
  readonly peers: PeerSpec[];
  exitNodeId: string | null;
  autoExitNode: boolean;
  allowLan: boolean;
  readonly suggested = "fi-hel-wg-203.mullvad.ts.net.";
  private readonly delayMs: number;

  constructor(opts: FixtureOptions = {}) {
    this.peers = opts.mullvadOnly
      ? MULLVAD_PEERS
      : [...TAILNET_PEERS, ...MULLVAD_PEERS];
    this.exitNodeId = opts.exitNodeId ?? null;
    this.autoExitNode = opts.autoExitNode ?? false;
    this.allowLan = opts.allowLan ?? false;
    this.delayMs = opts.delayMs ?? 0;
  }

  private delay(): Promise<void> {
    return this.delayMs > 0 ? Bun.sleep(this.delayMs) : Promise.resolve();
  }

  private find(id: string | null): PeerSpec | undefined {
    return id ? this.peers.find((p) => p.id === id) : undefined;
  }

  /** The document `tailscale status --json` would print for the current state. */
  statusJson(): Record<string, unknown> {
    const active = this.find(this.exitNodeId);
    const Peer: Record<string, unknown> = {};
    for (const p of this.peers)
      Peer[`nodekey:${p.id.toLowerCase()}`] = peerJson(p, this.exitNodeId);
    return {
      Version: "1.102.4",
      TUN: true,
      BackendState: "Running",
      HaveNodeKey: true,
      AuthURL: "",
      TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
      Self: {
        ID: "nSELFCNTRL",
        HostName: "my-laptop",
        DNSName: `my-laptop.${SUFFIX}.`,
        OS: "linux",
        UserID: Number(USER),
        TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
        Online: true,
        ExitNode: false,
        ExitNodeOption: false,
        KeyExpiry: "2027-03-11T07:24:59Z",
      },
      ExitNodeStatus: active
        ? {
            ID: active.id,
            Online: active.online ?? true,
            TailscaleIPs: [`${active.ip}/32`],
          }
        : null,
      Health: [],
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
    this.allowLan = allow;
  }

  async ping(node: ExitNode): Promise<PingResult> {
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
