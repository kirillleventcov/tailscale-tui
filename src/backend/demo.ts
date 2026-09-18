import type { ExitNode, TailscaleState } from "../model"
import { BackendError, type Backend } from "./types"

/** Small deterministic PRNG so demo data (and tests) are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface City {
  cc: string
  country: string
  code: string
  city: string
  /** Base round-trip time from the demo "self" device. */
  rtt: number
}

const CITIES: City[] = [
  { cc: "FI", country: "Finland", code: "hel", city: "Helsinki", rtt: 6 },
  { cc: "SE", country: "Sweden", code: "sto", city: "Stockholm", rtt: 14 },
  { cc: "SE", country: "Sweden", code: "got", city: "Gothenburg", rtt: 19 },
  { cc: "NO", country: "Norway", code: "osl", city: "Oslo", rtt: 24 },
  { cc: "DK", country: "Denmark", code: "cph", city: "Copenhagen", rtt: 25 },
  { cc: "EE", country: "Estonia", code: "tll", city: "Tallinn", rtt: 9 },
  { cc: "DE", country: "Germany", code: "fra", city: "Frankfurt", rtt: 31 },
  { cc: "DE", country: "Germany", code: "ber", city: "Berlin", rtt: 29 },
  { cc: "NL", country: "Netherlands", code: "ams", city: "Amsterdam", rtt: 33 },
  { cc: "GB", country: "United Kingdom", code: "lon", city: "London", rtt: 41 },
  { cc: "GB", country: "United Kingdom", code: "man", city: "Manchester", rtt: 46 },
  { cc: "FR", country: "France", code: "par", city: "Paris", rtt: 42 },
  { cc: "CH", country: "Switzerland", code: "zrh", city: "Zürich", rtt: 38 },
  { cc: "AT", country: "Austria", code: "vie", city: "Vienna", rtt: 36 },
  { cc: "PL", country: "Poland", code: "waw", city: "Warsaw", rtt: 27 },
  { cc: "CZ", country: "Czechia", code: "prg", city: "Prague", rtt: 33 },
  { cc: "ES", country: "Spain", code: "mad", city: "Madrid", rtt: 58 },
  { cc: "IT", country: "Italy", code: "mil", city: "Milan", rtt: 47 },
  { cc: "PT", country: "Portugal", code: "lis", city: "Lisbon", rtt: 64 },
  { cc: "IE", country: "Ireland", code: "dub", city: "Dublin", rtt: 49 },
  { cc: "BE", country: "Belgium", code: "bru", city: "Brussels", rtt: 37 },
  { cc: "RO", country: "Romania", code: "buh", city: "Bucharest", rtt: 44 },
  { cc: "UA", country: "Ukraine", code: "iev", city: "Kyiv", rtt: 39 },
  { cc: "US", country: "United States", code: "nyc", city: "New York", rtt: 112 },
  { cc: "US", country: "United States", code: "chi", city: "Chicago", rtt: 128 },
  { cc: "US", country: "United States", code: "dal", city: "Dallas", rtt: 141 },
  { cc: "US", country: "United States", code: "lax", city: "Los Angeles", rtt: 166 },
  { cc: "US", country: "United States", code: "sea", city: "Seattle", rtt: 171 },
  { cc: "CA", country: "Canada", code: "tor", city: "Toronto", rtt: 121 },
  { cc: "CA", country: "Canada", code: "van", city: "Vancouver", rtt: 178 },
  { cc: "BR", country: "Brazil", code: "sao", city: "São Paulo", rtt: 228 },
  { cc: "JP", country: "Japan", code: "tyo", city: "Tokyo", rtt: 246 },
  { cc: "SG", country: "Singapore", code: "sin", city: "Singapore", rtt: 203 },
  { cc: "HK", country: "Hong Kong", code: "hkg", city: "Hong Kong", rtt: 231 },
  { cc: "AU", country: "Australia", code: "syd", city: "Sydney", rtt: 297 },
  { cc: "AU", country: "Australia", code: "mel", city: "Melbourne", rtt: 305 },
  { cc: "ZA", country: "South Africa", code: "jnb", city: "Johannesburg", rtt: 214 },
  { cc: "AE", country: "United Arab Emirates", code: "dxb", city: "Dubai", rtt: 137 },
  { cc: "IL", country: "Israel", code: "tlv", city: "Tel Aviv", rtt: 96 },
]

interface DemoNode {
  node: ExitNode
  rtt: number
}

export interface DemoBackendOptions {
  seed?: number
  /** Multiplier for simulated command latency; 0 makes every call resolve immediately. */
  delayScale?: number
}

export class DemoBackend implements Backend {
  readonly kind = "demo" as const
  readonly label = "demo"
  private readonly rand: () => number
  private readonly delayScale: number
  private readonly nodes: DemoNode[] = []
  private activeId: string | null = null
  private allowLan = false
  private rx = 0
  private tx = 0
  private lastTick = Date.now()

  constructor(opts: DemoBackendOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 42)
    this.delayScale = opts.delayScale ?? 1
    this.seed()
  }

  private delay(ms: number): Promise<void> {
    const scaled = ms * this.delayScale
    if (scaled <= 0) return Promise.resolve()
    return new Promise((r) => setTimeout(r, scaled))
  }

  private seed(): void {
    const now = Date.now()
    let hostIdx = 10
    const ip = () => `100.${64 + Math.floor(hostIdx / 250)}.${hostIdx % 250}.${(hostIdx++ * 7) % 250 || 1}`

    const own = (
      name: string,
      os: string,
      online: boolean,
      rtt: number,
      extra: Partial<ExitNode> = {},
    ): void => {
      const addr = ip()
      this.nodes.push({
        rtt,
        node: {
          id: `n${name}`,
          key: `nodekey:${name}`,
          name,
          hostName: name,
          dnsName: `${name}.tail4a2b.ts.net`,
          ip: addr,
          ips: [addr, `fd7a:115c:a1e0::${hostIdx.toString(16)}`],
          os,
          online,
          active: false,
          exitNodeOption: true,
          expired: false,
          isMullvad: false,
          tags: [],
          owner: "kirill@github",
          lastSeen: online ? new Date(now) : new Date(now - (1 + this.rand() * 72) * 3600_000),
          lastHandshake: online ? new Date(now - this.rand() * 90_000) : undefined,
          rxBytes: Math.floor(this.rand() * 5e7),
          txBytes: Math.floor(this.rand() * 2e7),
          relay: online && this.rand() > 0.5 ? "hel" : undefined,
          curAddr: online && this.rand() > 0.4 ? `${Math.floor(80 + this.rand() * 100)}.${Math.floor(this.rand() * 255)}.${Math.floor(this.rand() * 255)}.${Math.floor(1 + this.rand() * 254)}:41641` : undefined,
          ...extra,
        },
      })
    }

    own("hel-vps", "linux", true, 6, { tags: ["tag:exit", "tag:server"], owner: "tagged-devices" })
    own("home-server", "linux", true, 12)
    own("office-gw", "linux", true, 9, { tags: ["tag:exit"], owner: "tagged-devices" })
    own("us-east-vps", "linux", true, 118, { tags: ["tag:exit"], owner: "tagged-devices" })
    own("macbook-pro", "macOS", false, 15)
    own("pixel-8", "android", false, 30)
    own("old-thinkpad", "windows", false, 20, { expired: true })

    for (const c of CITIES) {
      const count = c.cc === "US" || c.cc === "DE" || c.cc === "GB" || c.cc === "SE" ? 2 : 1
      for (let i = 1; i <= count; i++) {
        const name = `${c.cc.toLowerCase()}-${c.code}-wg-${String(i).padStart(3, "0")}`
        const addr = ip()
        const online = this.rand() > 0.08
        this.nodes.push({
          rtt: c.rtt,
          node: {
            id: `n${name}`,
            key: `nodekey:${name}`,
            name,
            hostName: name,
            dnsName: `${name}.mullvad.ts.net`,
            ip: addr,
            ips: [addr],
            os: "linux",
            online,
            active: false,
            exitNodeOption: true,
            expired: false,
            country: c.country,
            countryCode: c.cc,
            city: c.city,
            priority: i === 1 ? 100 : 90,
            isMullvad: true,
            tags: ["tag:mullvad-exit-node"],
            lastSeen: online ? new Date(now) : new Date(now - this.rand() * 40 * 3600_000),
            rxBytes: 0,
            txBytes: 0,
          },
        })
      }
    }
  }

  private find(id: string): DemoNode | undefined {
    return this.nodes.find((d) => d.node.id === id)
  }

  async status(): Promise<TailscaleState> {
    await this.delay(40)
    const now = Date.now()
    const dt = (now - this.lastTick) / 1000
    this.lastTick = now
    if (this.activeId) {
      this.rx += dt * (20_000 + this.rand() * 400_000)
      this.tx += dt * (5_000 + this.rand() * 60_000)
    }
    const active = this.activeId ? this.find(this.activeId) : undefined
    const health: string[] = []
    if (active && !active.node.online) health.push(`exit node ${active.node.name} is offline`)

    const nodes = this.nodes.map((d) => {
      const isActive = d.node.id === this.activeId
      return {
        ...d.node,
        active: isActive,
        rxBytes: isActive ? d.node.rxBytes + Math.floor(this.rx) : d.node.rxBytes,
        txBytes: isActive ? d.node.txBytes + Math.floor(this.tx) : d.node.txBytes,
        lastHandshake: isActive ? new Date(now - 5000) : d.node.lastHandshake,
        curAddr: isActive && !d.node.curAddr && !d.node.relay ? "185.65.135.12:51820" : d.node.curAddr,
        ips: [...d.node.ips],
        tags: [...d.node.tags],
      }
    })

    return {
      backendState: "Running",
      version: "1.90.2-demo",
      self: { hostName: "my-laptop", dnsName: "my-laptop.tail4a2b.ts.net", ips: ["100.64.0.5", "fd7a:115c:a1e0::5"], os: "linux", online: true },
      tailnet: "kirill.github",
      magicDnsSuffix: "tail4a2b.ts.net",
      exitNode: active ? { id: active.node.id, online: active.node.online, ips: active.node.ips } : null,
      allowLan: this.allowLan,
      health,
      nodes,
      fetchedAt: now,
    }
  }

  async suggest(): Promise<string | null> {
    await this.delay(250)
    const best = this.nodes
      .filter((d) => d.node.online && !d.node.expired)
      .sort((a, b) => a.rtt - b.rtt)[0]
    return best ? best.node.dnsName : null
  }

  async setExitNode(node: ExitNode | null): Promise<void> {
    await this.delay(350)
    if (node === null) {
      this.activeId = null
      this.rx = 0
      this.tx = 0
      return
    }
    const d = this.find(node.id)
    if (!d) throw new BackendError(`connect to ${node.name}: unknown node`)
    if (d.node.expired) throw new BackendError(`connect to ${node.name}: node key expired`, "Re-authenticate that device with `tailscale up`")
    if (this.activeId !== d.node.id) {
      this.rx = 0
      this.tx = 0
    }
    this.activeId = d.node.id
  }

  async setAllowLan(allow: boolean): Promise<void> {
    await this.delay(150)
    this.allowLan = allow
  }

  async ping(node: ExitNode): Promise<number | null> {
    const d = this.find(node.id)
    if (!d || !d.node.online) {
      await this.delay(1200)
      return null
    }
    await this.delay(80 + d.rtt)
    return Math.round((d.rtt + this.rand() * d.rtt * 0.35) * 10) / 10
  }
}
