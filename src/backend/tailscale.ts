import { existsSync } from "node:fs"
import { parseTime } from "../format"
import type { ExitNode, ExitNodeStatus, SelfInfo, TailscaleState } from "../model"
import { BackendError, type Backend } from "./types"

const KNOWN_PATHS = [
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
]

/** Locate the `tailscale` CLI: $TAILSCALE_BIN, then PATH, then well-known install paths. */
export function findTailscaleBinary(): string | null {
  const fromEnv = process.env.TAILSCALE_BIN
  if (fromEnv) return fromEnv
  const onPath = Bun.which("tailscale")
  if (onPath) return onPath
  for (const p of KNOWN_PATHS) {
    try {
      if (existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}

export interface TailscaleBackendOptions {
  bin: string
  /** Prefix privileged commands (`tailscale set ...`) with `sudo -n`. */
  sudo?: boolean
  timeoutMs?: number
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export class TailscaleBackend implements Backend {
  readonly kind = "tailscale" as const
  readonly label: string
  private readonly bin: string
  private readonly sudo: boolean
  private readonly timeoutMs: number

  constructor(opts: TailscaleBackendOptions) {
    this.bin = opts.bin
    this.sudo = opts.sudo ?? false
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.label = this.sudo ? "tailscale (sudo)" : "tailscale"
  }

  private async run(args: string[], opts: { privileged?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
    const usesSudo = opts.privileged === true && this.sudo && process.platform !== "win32"
    const cmd = usesSudo ? ["sudo", "-n", this.bin, ...args] : [this.bin, ...args]
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    } catch (e) {
      throw new BackendError(`Cannot run ${cmd[0]}: ${(e as Error).message}`)
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutMs ?? this.timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ])
      return { code, stdout, stderr, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }

  private toError(res: RunResult, what: string): BackendError {
    if (res.timedOut) return new BackendError(`${what}: timed out`)
    const text = (res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`).split("\n").pop() ?? ""
    const lower = text.toLowerCase()
    if (lower.includes("access denied") || lower.includes("permission denied") || lower.includes("operation not permitted")) {
      return new BackendError(
        `${what}: access denied`,
        "Run once: sudo tailscale set --operator=$USER   (or start tsexit with --sudo)",
      )
    }
    if (lower.includes("sudo") && lower.includes("password")) {
      return new BackendError(`${what}: sudo needs a password`, "Use passwordless sudo, or: sudo tailscale set --operator=$USER")
    }
    if (lower.includes("failed to connect to local tailscaled") || lower.includes("is tailscale running")) {
      return new BackendError(`${what}: tailscaled is not running`, "Start it with: sudo systemctl start tailscaled")
    }
    return new BackendError(`${what}: ${text}`)
  }

  async status(): Promise<TailscaleState> {
    const res = await this.run(["status", "--json"])
    let json: unknown
    try {
      json = JSON.parse(res.stdout)
    } catch {
      throw this.toError(res, "tailscale status")
    }
    const prefs = await this.prefs()
    return parseStatus(json, prefs)
  }

  /** `tailscale debug prefs` exposes ExitNodeAllowLANAccess; best effort. */
  private async prefs(): Promise<unknown> {
    try {
      const res = await this.run(["debug", "prefs"], { timeoutMs: 4000 })
      if (res.code !== 0) return null
      return JSON.parse(res.stdout)
    } catch {
      return null
    }
  }

  async suggest(): Promise<string | null> {
    const res = await this.run(["exit-node", "suggest"], { timeoutMs: 15_000 })
    return parseSuggest(`${res.stdout}\n${res.stderr}`)
  }

  async setExitNode(node: ExitNode | null): Promise<void> {
    const target = node ? node.ip || node.dnsName || node.hostName : ""
    const res = await this.run(["set", `--exit-node=${target}`], { privileged: true })
    if (res.code !== 0) throw this.toError(res, node ? `connect to ${node.name}` : "disconnect")
  }

  async setAllowLan(allow: boolean): Promise<void> {
    const res = await this.run(["set", `--exit-node-allow-lan-access=${allow ? "true" : "false"}`], { privileged: true })
    if (res.code !== 0) throw this.toError(res, "LAN access")
  }

  async ping(node: ExitNode): Promise<number | null> {
    const target = node.ip || node.dnsName
    const res = await this.run(["ping", "-c", "1", "--timeout", "3s", target], { timeoutMs: 6000 })
    return parsePing(`${res.stdout}\n${res.stderr}`)
  }
}

// ---------------------------------------------------------------------------
// Parsing (exported for tests)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Read a field tolerating both Go-style (`HostName`) and lowerCamel (`hostName`) keys. */
function g(o: unknown, key: string): unknown {
  if (!isObj(o)) return undefined
  if (key in o) return o[key]
  const lower = key.charAt(0).toLowerCase() + key.slice(1)
  return o[lower]
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function bool(v: unknown): boolean {
  return v === true
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function stripDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s
}

function firstV4(ips: string[]): string {
  return ips.find((ip) => ip.includes(".")) ?? ips[0] ?? ""
}

function parsePeer(key: string, p: unknown, users: Map<string, string>): ExitNode {
  const ips = strList(g(p, "TailscaleIPs")).map((ip) => ip.replace(/\/\d+$/, ""))
  const dnsName = stripDot(str(g(p, "DNSName")))
  const hostName = str(g(p, "HostName"))
  const tags = strList(g(p, "Tags"))
  const loc = g(p, "Location")
  const priority = g(loc, "Priority")
  const userId = g(p, "UserID")
  const isMullvad = tags.includes("tag:mullvad-exit-node") || dnsName.endsWith(".mullvad.ts.net")
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
  }
}

export function parseStatus(json: unknown, prefs: unknown = null): TailscaleState {
  const users = new Map<string, string>()
  const userMap = g(json, "User")
  if (isObj(userMap)) {
    for (const [id, u] of Object.entries(userMap)) {
      const login = str(g(u, "LoginName")) || str(g(u, "DisplayName"))
      if (login) users.set(id, login)
    }
  }

  const peers = g(json, "Peer")
  const nodes: ExitNode[] = []
  if (isObj(peers)) {
    for (const [key, p] of Object.entries(peers)) {
      if (!isObj(p)) continue
      if (!bool(g(p, "ExitNodeOption")) && !bool(g(p, "ExitNode"))) continue
      nodes.push(parsePeer(key, p, users))
    }
  }

  const selfRaw = g(json, "Self")
  const self: SelfInfo | null = isObj(selfRaw)
    ? {
        hostName: str(g(selfRaw, "HostName")),
        dnsName: stripDot(str(g(selfRaw, "DNSName"))),
        ips: strList(g(selfRaw, "TailscaleIPs")),
        os: str(g(selfRaw, "OS")),
        online: bool(g(selfRaw, "Online")),
      }
    : null

  const ens = g(json, "ExitNodeStatus")
  const exitNode: ExitNodeStatus | null = isObj(ens)
    ? {
        id: str(g(ens, "ID")),
        online: bool(g(ens, "Online")),
        ips: strList(g(ens, "TailscaleIPs")).map((ip) => ip.replace(/\/\d+$/, "")),
      }
    : null

  // ExitNodeStatus is authoritative for "which node is in use"; make the peer flag agree.
  if (exitNode?.id) {
    for (const n of nodes) n.active = n.active || n.id === exitNode.id
  }

  const allowLanRaw = g(prefs, "ExitNodeAllowLANAccess")
  const tailnet = g(json, "CurrentTailnet")

  return {
    backendState: str(g(json, "BackendState"), "Unknown"),
    version: str(g(json, "Version")),
    self,
    tailnet: str(g(tailnet, "Name")) || null,
    magicDnsSuffix: str(g(json, "MagicDNSSuffix")) || str(g(tailnet, "MagicDNSSuffix")) || null,
    exitNode,
    allowLan: typeof allowLanRaw === "boolean" ? allowLanRaw : null,
    health: strList(g(json, "Health")),
    nodes,
    fetchedAt: Date.now(),
  }
}

/** "Suggested exit node: de-fra-wg-001.mullvad.ts.net." -> "de-fra-wg-001.mullvad.ts.net" */
export function parseSuggest(output: string): string | null {
  const m = /suggested exit node:\s*([^\s,]+)/i.exec(output)
  if (!m) return null
  return stripDot(m[1]!)
}

/** "pong from foo (100.64.0.1) via DERP(fra) in 45ms" -> 45 */
export function parsePing(output: string): number | null {
  const m = /\bin\s+(\d+(?:\.\d+)?)\s*(ms|µs|us|s)\b/i.exec(output)
  if (!m) return null
  const v = Number(m[1])
  switch (m[2]!.toLowerCase()) {
    case "s":
      return v * 1000
    case "µs":
    case "us":
      return v / 1000
    default:
      return v
  }
}
