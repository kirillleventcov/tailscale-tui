import { describe, expect, test } from "bun:test"
import { parsePing, parseStatus, parseSuggest } from "../src/backend/tailscale"

const statusFixture = {
  Version: "1.90.2-t1234",
  TUN: true,
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
  Self: {
    ID: "nSELF",
    PublicKey: "nodekey:self",
    HostName: "my-laptop",
    DNSName: "my-laptop.tail4a2b.ts.net.",
    OS: "linux",
    UserID: 1001,
    TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
    Online: true,
    ExitNode: false,
    ExitNodeOption: false,
  },
  ExitNodeStatus: { ID: "nHEL", Online: true, TailscaleIPs: ["100.64.0.12/32", "fd7a:115c:a1e0::12/128"] },
  Health: [],
  MagicDNSSuffix: "tail4a2b.ts.net",
  CurrentTailnet: { Name: "kirill.github", MagicDNSSuffix: "tail4a2b.ts.net", MagicDNSEnabled: true },
  Peer: {
    "nodekey:hel": {
      ID: "nHEL",
      HostName: "hel-vps",
      DNSName: "hel-vps.tail4a2b.ts.net.",
      OS: "linux",
      UserID: 2002,
      TailscaleIPs: ["100.64.0.12", "fd7a:115c:a1e0::12"],
      Tags: ["tag:exit"],
      Relay: "hel",
      CurAddr: "95.216.1.2:41641",
      RxBytes: 12345,
      TxBytes: 678,
      LastSeen: "2026-09-18T10:00:00Z",
      LastHandshake: "2026-09-18T10:00:30Z",
      Online: true,
      ExitNode: true,
      ExitNodeOption: true,
      Active: true,
    },
    "nodekey:mullvad": {
      ID: "nMUL",
      HostName: "de-fra-wg-001.mullvad.ts.net",
      DNSName: "de-fra-wg-001.mullvad.ts.net.",
      OS: "linux",
      UserID: 0,
      TailscaleIPs: ["100.99.1.1"],
      Tags: ["tag:mullvad-exit-node"],
      Location: { Country: "Germany", CountryCode: "de", City: "Frankfurt", CityCode: "fra", Priority: 100 },
      LastSeen: "0001-01-01T00:00:00Z",
      Online: true,
      ExitNode: false,
      ExitNodeOption: true,
    },
    "nodekey:plain": {
      ID: "nPLAIN",
      HostName: "phone",
      DNSName: "phone.tail4a2b.ts.net.",
      OS: "android",
      UserID: 1001,
      TailscaleIPs: ["100.64.0.9"],
      Online: false,
      ExitNode: false,
      ExitNodeOption: false,
    },
  },
  User: {
    "1001": { ID: 1001, LoginName: "kirill@github", DisplayName: "Kirill" },
    "2002": { ID: 2002, LoginName: "tagged-devices", DisplayName: "Tagged Devices" },
  },
}

describe("parseStatus", () => {
  test("keeps only exit-node capable peers and maps fields", () => {
    const s = parseStatus(statusFixture, { ExitNodeAllowLANAccess: true })
    expect(s.backendState).toBe("Running")
    expect(s.tailnet).toBe("kirill.github")
    expect(s.self?.hostName).toBe("my-laptop")
    expect(s.self?.dnsName).toBe("my-laptop.tail4a2b.ts.net")
    expect(s.allowLan).toBe(true)
    expect(s.exitNode?.id).toBe("nHEL")
    expect(s.exitNode?.ips).toEqual(["100.64.0.12", "fd7a:115c:a1e0::12"])
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["nHEL", "nMUL"])

    const hel = s.nodes.find((n) => n.id === "nHEL")!
    expect(hel.name).toBe("hel-vps")
    expect(hel.dnsName).toBe("hel-vps.tail4a2b.ts.net")
    expect(hel.ip).toBe("100.64.0.12")
    expect(hel.active).toBe(true)
    expect(hel.owner).toBe("tagged-devices")
    expect(hel.relay).toBe("hel")
    expect(hel.curAddr).toBe("95.216.1.2:41641")
    expect(hel.rxBytes).toBe(12345)
    expect(hel.lastHandshake?.toISOString()).toBe("2026-09-18T10:00:30.000Z")
    expect(hel.isMullvad).toBe(false)

    const mul = s.nodes.find((n) => n.id === "nMUL")!
    expect(mul.name).toBe("de-fra-wg-001")
    expect(mul.isMullvad).toBe(true)
    expect(mul.countryCode).toBe("DE")
    expect(mul.city).toBe("Frankfurt")
    expect(mul.priority).toBe(100)
    expect(mul.lastSeen).toBeUndefined()
  })

  test("uses ExitNodeStatus to mark the active node even if the peer flag lags", () => {
    const fixture = structuredClone(statusFixture)
    fixture.Peer["nodekey:hel"].ExitNode = false
    const s = parseStatus(fixture)
    expect(s.nodes.find((n) => n.id === "nHEL")?.active).toBe(true)
    expect(s.allowLan).toBeNull()
  })

  test("tolerates lowerCamel keys and missing sections", () => {
    const s = parseStatus({ backendState: "Stopped", peer: {}, self: { hostName: "x", tailscaleIps: [] } })
    expect(s.backendState).toBe("Stopped")
    expect(s.self?.hostName).toBe("x")
    expect(s.nodes).toEqual([])
    expect(s.exitNode).toBeNull()
  })
})

describe("parseSuggest", () => {
  test("extracts the host name", () => {
    expect(parseSuggest("Suggested exit node: de-fra-wg-001.mullvad.ts.net.\nTo accept this suggestion, use `tailscale set --exit-node=de-fra-wg-001.mullvad.ts.net`.\n")).toBe(
      "de-fra-wg-001.mullvad.ts.net",
    )
    expect(parseSuggest("no exit node suggestion")).toBeNull()
  })
})

describe("parsePing", () => {
  test("parses durations in ms, s and µs", () => {
    expect(parsePing("pong from hel-vps (100.64.0.12) via 95.216.1.2:41641 in 12ms\n")).toBe(12)
    expect(parsePing("pong from x (100.64.0.1) via DERP(fra) in 1.5s")).toBe(1500)
    expect(parsePing("pong from x (100.64.0.1) via DERP(fra) in 800µs")).toBe(0.8)
    expect(parsePing("timeout waiting for ping reply\n")).toBeNull()
  })
})
