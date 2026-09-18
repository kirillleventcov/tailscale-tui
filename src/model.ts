import { osLabel } from "./format"

export interface ExitNode {
  /** Stable node id (tailcfg.StableNodeID). */
  id: string
  /** Node public key (map key in `tailscale status --json`). */
  key: string
  /** Short display name: first label of the DNS name, or the hostname. */
  name: string
  hostName: string
  dnsName: string
  /** Preferred (IPv4) Tailscale address. */
  ip: string
  ips: string[]
  os: string
  online: boolean
  /** Currently selected as the exit node for this device. */
  active: boolean
  /** Advertises (and is approved as) an exit node. */
  exitNodeOption: boolean
  expired: boolean
  country?: string
  countryCode?: string
  city?: string
  priority?: number
  isMullvad: boolean
  tags: string[]
  owner?: string
  lastSeen?: Date
  lastHandshake?: Date
  rxBytes: number
  txBytes: number
  relay?: string
  curAddr?: string
}

export interface SelfInfo {
  hostName: string
  dnsName: string
  ips: string[]
  os: string
  online: boolean
}

export interface ExitNodeStatus {
  id: string
  online: boolean
  ips: string[]
}

export interface TailscaleState {
  backendState: string
  version: string
  self: SelfInfo | null
  tailnet: string | null
  magicDnsSuffix: string | null
  exitNode: ExitNodeStatus | null
  /** `null` when the preference could not be read. */
  allowLan: boolean | null
  health: string[]
  nodes: ExitNode[]
  fetchedAt: number
}

export type Latency = number | null | "pending"
export type LatencyLookup = (id: string) => Latency | undefined

export type FilterKind = "all" | "online" | "tailnet" | "mullvad"

export interface FilterDef {
  id: FilterKind
  label: string
  hotkey: string
  test: (n: ExitNode) => boolean
}

export const FILTERS: readonly FilterDef[] = [
  { id: "all", label: "All", hotkey: "1", test: () => true },
  { id: "online", label: "Online", hotkey: "2", test: (n) => n.online },
  { id: "tailnet", label: "Tailnet", hotkey: "3", test: (n) => !n.isMullvad },
  { id: "mullvad", label: "Mullvad", hotkey: "4", test: (n) => n.isMullvad },
]

export type SortKey = "status" | "name" | "location" | "latency" | "priority" | "os"

export const SORTS: readonly { id: SortKey; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "name", label: "Name" },
  { id: "location", label: "Location" },
  { id: "latency", label: "Latency" },
  { id: "priority", label: "Priority" },
  { id: "os", label: "OS" },
]

export interface Query {
  text: string
  filter: FilterKind
  sort: SortKey
  desc: boolean
}

export type NodeStatus = "active" | "online" | "offline" | "expired"

export function statusLabel(n: ExitNode): NodeStatus {
  if (n.active) return "active"
  if (n.expired) return "expired"
  return n.online ? "online" : "offline"
}

export function statusRank(n: ExitNode): number {
  switch (statusLabel(n)) {
    case "active":
      return 0
    case "online":
      return 1
    case "offline":
      return 2
    case "expired":
      return 3
  }
}

/** "Helsinki, FI" | "Finland" | "" */
export function locationLabel(n: ExitNode): string {
  if (n.city && n.countryCode) return `${n.city}, ${n.countryCode}`
  if (n.city) return n.city
  if (n.country) return n.country
  return ""
}

/** "Helsinki, Finland (FI)" | "Finland (FI)" | "unknown" */
export function locationLong(n: ExitNode): string {
  const parts: string[] = []
  if (n.city) parts.push(n.city)
  if (n.country) parts.push(n.country)
  let s = parts.join(", ")
  if (n.countryCode) s = s ? `${s} (${n.countryCode})` : n.countryCode
  return s || "unknown"
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "!")
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
    .toLowerCase()
}

/**
 * Every token must match (substring, case-insensitive).
 * A token starting with `!` must NOT match.
 */
export function matchesTokens(n: ExitNode, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const hay = haystack(n)
  for (const tok of tokens) {
    if (tok.startsWith("!")) {
      if (hay.includes(tok.slice(1))) return false
    } else if (!hay.includes(tok)) {
      return false
    }
  }
  return true
}

function cmpStr(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
}

function latencyOrder(v: Latency | undefined): [number, number] {
  if (typeof v === "number") return [0, v]
  if (v === "pending") return [1, 0]
  if (v === undefined) return [2, 0]
  return [3, 0]
}

export function compareNodes(a: ExitNode, b: ExitNode, key: SortKey, lat: LatencyLookup): number {
  switch (key) {
    case "status":
      // Same status: your own tailnet nodes before the (much longer) Mullvad list.
      return statusRank(a) - statusRank(b) || Number(a.isMullvad) - Number(b.isMullvad) || cmpStr(a.name, b.name)
    case "name":
      return cmpStr(a.name, b.name)
    case "location":
      return (
        cmpStr(a.countryCode ?? a.country ?? "￿", b.countryCode ?? b.country ?? "￿") ||
        cmpStr(a.city ?? "￿", b.city ?? "￿") ||
        cmpStr(a.name, b.name)
      )
    case "latency": {
      const [ga, va] = latencyOrder(lat(a.id))
      const [gb, vb] = latencyOrder(lat(b.id))
      return ga - gb || va - vb || cmpStr(a.name, b.name)
    }
    case "priority": {
      const pa = a.priority ?? Number.NEGATIVE_INFINITY
      const pb = b.priority ?? Number.NEGATIVE_INFINITY
      return pb - pa || cmpStr(a.name, b.name)
    }
    case "os":
      return cmpStr(osLabel(a.os), osLabel(b.os)) || cmpStr(a.name, b.name)
  }
}

export function applyQuery(nodes: readonly ExitNode[], q: Query, lat: LatencyLookup): ExitNode[] {
  const filter = FILTERS.find((f) => f.id === q.filter) ?? FILTERS[0]!
  const tokens = tokenize(q.text)
  const out = nodes.filter((n) => filter.test(n) && matchesTokens(n, tokens))
  out.sort((a, b) => {
    const c = compareNodes(a, b, q.sort, lat)
    return q.desc ? -c : c
  })
  return out
}

/** Resolve a name from `tailscale exit-node suggest` (or an IP) to a node. */
export function findNodeByName(nodes: readonly ExitNode[], name: string | null): ExitNode | undefined {
  if (!name) return undefined
  const needle = name.replace(/\.$/, "").toLowerCase()
  return nodes.find(
    (n) =>
      n.dnsName.toLowerCase() === needle ||
      n.name.toLowerCase() === needle ||
      n.hostName.toLowerCase() === needle ||
      n.ips.includes(needle) ||
      n.id === name,
  )
}
