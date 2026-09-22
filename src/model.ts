import { osLabel, relTime } from "./format";

/** A device in the tailnet: one entry of the `Peer` map of `tailscale status --json`. */
export interface Peer {
  /** Stable node id (tailcfg.StableNodeID). */
  id: string;
  /** Node public key (map key in `tailscale status --json`). */
  key: string;
  /** Short display name: first label of the DNS name, or the hostname. */
  name: string;
  hostName: string;
  dnsName: string;
  /** Preferred (IPv4) Tailscale address. */
  ip: string;
  ips: string[];
  /** Empty for Mullvad nodes; Tailscale does not report their OS. */
  os: string;
  online: boolean;
  /** Currently selected as the exit node for this device. */
  active: boolean;
  /** Advertises (and is approved as) an exit node. */
  exitNodeOption: boolean;
  expired: boolean;
  keyExpiry?: Date;
  country?: string;
  countryCode?: string;
  city?: string;
  priority?: number;
  isMullvad: boolean;
  tags: string[];
  owner?: string;
  lastSeen?: Date;
  lastHandshake?: Date;
  rxBytes: number;
  txBytes: number;
  /** DERP region the connection is relayed through, when not direct. */
  relay?: string;
  /** Direct endpoint in use, when the path is direct. */
  curAddr?: string;
  /** Peer relay in use (Tailscale peer relays), when any. */
  peerRelay?: string;
  /** A WireGuard session with the peer is up (the "active" of `tailscale status`). */
  inSession: boolean;
  /** Runs Tailscale SSH (it publishes SSH host keys). */
  ssh: boolean;
  /** Taildrop can send files to it right now. */
  taildrop: boolean;
  /** Shared into this tailnet from another one. */
  shared: boolean;
  /** Subnet routes it serves to this device (exit routes excluded). */
  routes: string[];
  created?: Date;
}

/** Exit nodes are peers that advertise an approved exit route. */
export type ExitNode = Peer;

export interface SelfInfo {
  id: string;
  name: string;
  hostName: string;
  dnsName: string;
  ips: string[];
  os: string;
  online: boolean;
  /** This device advertises an exit node itself. */
  exitNodeOption: boolean;
  keyExpiry?: Date;
  /** Home DERP region code, e.g. "fra". */
  relay?: string;
  /** Public and LAN endpoints this device is reachable on. */
  endpoints: string[];
  created?: Date;
}

export interface ExitNodeStatus {
  id: string;
  online: boolean;
  ips: string[];
}

export interface TailscaleState {
  backendState: string;
  version: string;
  self: SelfInfo | null;
  /** Login name and display name of the account this device is logged in with. */
  user: { login: string; name: string } | null;
  tailnet: string | null;
  magicDnsSuffix: string | null;
  magicDns: boolean | null;
  /** Login URL while the backend waits for authentication. */
  authUrl: string;
  exitNode: ExitNodeStatus | null;
  /** `null` when the preference could not be read. */
  allowLan: boolean | null;
  /** Tailscale picks and follows the best exit node (`--exit-node=auto:any`); `null` when unknown. */
  autoExitNode: boolean | null;
  health: string[];
  /** Newer client version, when Tailscale reports that one is available. */
  update: string | null;
  /** Exit-node capable peers. */
  nodes: ExitNode[];
  /** Every peer, exit nodes included. */
  peers: Peer[];
  fetchedAt: number;
}

export type Latency = number | null | "pending";
export type LatencyLookup = (id: string) => Latency | undefined;

export type FilterKind = "all" | "online" | "tailnet" | "mullvad";

export interface FilterDef {
  id: FilterKind;
  label: string;
  test: (n: ExitNode) => boolean;
}

export const FILTERS: readonly FilterDef[] = [
  { id: "all", label: "All", test: () => true },
  { id: "online", label: "Online", test: (n) => n.online },
  { id: "tailnet", label: "Tailnet", test: (n) => !n.isMullvad },
  { id: "mullvad", label: "Mullvad", test: (n) => n.isMullvad },
];

export type SortKey =
  "status" | "name" | "location" | "latency" | "priority" | "os";

export const SORTS: readonly { id: SortKey; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "name", label: "Name" },
  { id: "location", label: "Location" },
  { id: "latency", label: "Latency" },
  { id: "priority", label: "Priority" },
  { id: "os", label: "OS" },
];

export interface Query {
  text: string;
  filter: FilterKind;
  sort: SortKey;
  desc: boolean;
}

export type NodeStatus = "active" | "online" | "offline" | "expired";

export function statusLabel(n: ExitNode): NodeStatus {
  if (n.active) return "active";
  if (n.expired) return "expired";
  return n.online ? "online" : "offline";
}

export function statusRank(n: ExitNode): number {
  switch (statusLabel(n)) {
    case "active":
      return 0;
    case "online":
      return 1;
    case "offline":
      return 2;
    case "expired":
      return 3;
  }
}

/** "Helsinki, FI" | "Finland" | "" */
export function locationLabel(n: ExitNode): string {
  if (n.city && n.countryCode) return `${n.city}, ${n.countryCode}`;
  if (n.city) return n.city;
  if (n.country) return n.country;
  return "";
}

/** "Helsinki, Finland (FI)" | "Finland (FI)" | "unknown" */
export function locationLong(n: ExitNode): string {
  const parts: string[] = [];
  if (n.city) parts.push(n.city);
  if (n.country) parts.push(n.country);
  let s = parts.join(", ");
  if (n.countryCode) s = s ? `${s} (${n.countryCode})` : n.countryCode;
  return s || "unknown";
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "!");
}

function haystack(n: ExitNode): string {
  return [
    n.name,
    n.hostName,
    n.dnsName,
    ...n.ips,
    n.country ?? "",
    n.countryCode ?? "",
    n.city ?? "",
    n.os,
    osLabel(n.os),
    n.owner ?? "",
    ...n.tags,
    n.isMullvad ? "mullvad" : "tailnet",
    statusLabel(n),
    n.active ? "connected current" : "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Every token must match (substring, case-insensitive).
 * A token starting with `!` must NOT match.
 */
export function matchesTokens(n: ExitNode, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = haystack(n);
  for (const tok of tokens) {
    if (tok.startsWith("!")) {
      if (hay.includes(tok.slice(1))) return false;
    } else if (!hay.includes(tok)) {
      return false;
    }
  }
  return true;
}

function cmpStr(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function latencyOrder(v: Latency | undefined): [number, number] {
  if (typeof v === "number") return [0, v];
  if (v === "pending") return [1, 0];
  if (v === undefined) return [2, 0];
  return [3, 0];
}

export function compareNodes(
  a: ExitNode,
  b: ExitNode,
  key: SortKey,
  lat: LatencyLookup,
): number {
  switch (key) {
    case "status":
      // Same status: your own tailnet nodes before the (much longer) Mullvad list.
      return (
        statusRank(a) - statusRank(b) ||
        Number(a.isMullvad) - Number(b.isMullvad) ||
        cmpStr(a.name, b.name)
      );
    case "name":
      return cmpStr(a.name, b.name);
    case "location":
      return (
        cmpStr(
          a.countryCode ?? a.country ?? "￿",
          b.countryCode ?? b.country ?? "￿",
        ) ||
        cmpStr(a.city ?? "￿", b.city ?? "￿") ||
        cmpStr(a.name, b.name)
      );
    case "latency": {
      const [ga, va] = latencyOrder(lat(a.id));
      const [gb, vb] = latencyOrder(lat(b.id));
      return ga - gb || va - vb || cmpStr(a.name, b.name);
    }
    case "priority": {
      const pa = a.priority ?? Number.NEGATIVE_INFINITY;
      const pb = b.priority ?? Number.NEGATIVE_INFINITY;
      return pb - pa || cmpStr(a.name, b.name);
    }
    case "os":
      return cmpStr(osLabel(a.os), osLabel(b.os)) || cmpStr(a.name, b.name);
  }
}

export function applyQuery(
  nodes: readonly ExitNode[],
  q: Query,
  lat: LatencyLookup,
): ExitNode[] {
  const filter = FILTERS.find((f) => f.id === q.filter) ?? FILTERS[0]!;
  const tokens = tokenize(q.text);
  const out = nodes.filter((n) => filter.test(n) && matchesTokens(n, tokens));
  out.sort((a, b) => {
    const c = compareNodes(a, b, q.sort, lat);
    return q.desc ? -c : c;
  });
  return out;
}

/** Resolve a name from `tailscale exit-node suggest` (or an IP) to a node. */
export function findNodeByName(
  nodes: readonly ExitNode[],
  name: string | null,
): ExitNode | undefined {
  if (!name) return undefined;
  const needle = name.replace(/\.$/, "").toLowerCase();
  return nodes.find(
    (n) =>
      n.dnsName.toLowerCase() === needle ||
      n.name.toLowerCase() === needle ||
      n.hostName.toLowerCase() === needle ||
      n.ips.includes(needle) ||
      n.id === name,
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** Your tailnet's devices: every peer except Mullvad relays, which only matter as exit nodes. */
export function tailnetDevices(peers: readonly Peer[]): Peer[] {
  return peers.filter((p) => !p.isMullvad);
}

const NO_SSH_OS = new Set(["ios", "android", "tvos"]);

/** Phones and TVs run no SSH server; everything else may. */
export function mayRunSsh(p: Peer): boolean {
  return !NO_SSH_OS.has(p.os.toLowerCase());
}

/** How this device reaches the peer right now, or when it was last seen. */
export function connectionLabel(p: Peer, now = Date.now()): string {
  if (p.expired) return "key expired";
  if (!p.online) return p.lastSeen ? relTime(p.lastSeen, now) : "offline";
  if (p.curAddr) return "direct";
  if (p.peerRelay) return "peer relay";
  if (p.inSession && p.relay) return `relay ${p.relay}`;
  return "idle";
}

export type DeviceFilter = "all" | "online" | "mine" | "tagged";

export const DEVICE_FILTERS: readonly { id: DeviceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online" },
  { id: "mine", label: "Mine" },
  { id: "tagged", label: "Tagged" },
];

export type DeviceSort =
  "status" | "name" | "os" | "owner" | "seen" | "latency";

export const DEVICE_SORTS: readonly { id: DeviceSort; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "name", label: "Name" },
  { id: "os", label: "OS" },
  { id: "owner", label: "Owner" },
  { id: "seen", label: "Last seen" },
  { id: "latency", label: "Latency" },
];

export interface DeviceQuery {
  text: string;
  filter: DeviceFilter;
  sort: DeviceSort;
  desc: boolean;
}

function seenRank(p: Peer): number {
  if (p.online) return Number.POSITIVE_INFINITY;
  return p.lastSeen?.getTime() ?? 0;
}

export function applyDeviceQuery(
  devices: readonly Peer[],
  q: DeviceQuery,
  me: string | null,
  lat: LatencyLookup,
): Peer[] {
  const tokens = tokenize(q.text);
  const keep = (p: Peer): boolean => {
    switch (q.filter) {
      case "all":
        return true;
      case "online":
        return p.online;
      case "mine":
        return me !== null && p.owner === me && p.tags.length === 0;
      case "tagged":
        return p.tags.length > 0;
    }
  };
  const out = devices.filter((p) => keep(p) && matchesTokens(p, tokens));
  const cmp = (a: Peer, b: Peer): number => {
    switch (q.sort) {
      case "status":
        return (
          statusRank(a) - statusRank(b) ||
          seenRank(b) - seenRank(a) ||
          cmpStr(a.name, b.name)
        );
      case "name":
        return cmpStr(a.name, b.name);
      case "os":
        return cmpStr(osLabel(a.os), osLabel(b.os)) || cmpStr(a.name, b.name);
      case "owner":
        return (
          cmpStr(a.tags[0] ?? a.owner ?? "", b.tags[0] ?? b.owner ?? "") ||
          cmpStr(a.name, b.name)
        );
      case "seen":
        return seenRank(b) - seenRank(a) || cmpStr(a.name, b.name);
      case "latency": {
        const [ga, va] = latencyOrder(lat(a.id));
        const [gb, vb] = latencyOrder(lat(b.id));
        return ga - gb || va - vb || cmpStr(a.name, b.name);
      }
    }
  };
  out.sort((a, b) => (q.desc ? -cmp(a, b) : cmp(a, b)));
  return out;
}
