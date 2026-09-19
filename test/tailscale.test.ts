import { describe, expect, test } from "bun:test";
import { icmpPingCommand, parseIcmpPing } from "../src/backend/icmp";
import { parseRelayList } from "../src/backend/mullvad";
import { parsePong, parseStatus, parseSuggest } from "../src/backend/tailscale";

// Shapes taken from `tailscale status --json` on Tailscale 1.102.
const statusFixture = {
  Version: "1.102.4",
  TUN: true,
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
  Self: {
    ID: "nSELF",
    PublicKey: "nodekey:self",
    HostName: "my-laptop",
    DNSName: "my-laptop.tail0000.ts.net.",
    OS: "linux",
    UserID: 1001,
    TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
    Online: true,
    ExitNode: false,
    ExitNodeOption: true,
    KeyExpiry: "2027-03-11T07:24:59Z",
  },
  ExitNodeStatus: {
    ID: "nHEL",
    Online: true,
    TailscaleIPs: ["100.64.0.12/32", "fd7a:115c:a1e0::12/128"],
  },
  Health: [
    "systemd-resolved and NetworkManager are wired together incorrectly; MagicDNS will probably not work.",
  ],
  MagicDNSSuffix: "tail0000.ts.net",
  CurrentTailnet: {
    Name: "you@example.com",
    MagicDNSSuffix: "tail0000.ts.net",
    MagicDNSEnabled: true,
  },
  Peer: {
    "nodekey:hel": {
      ID: "nHEL",
      HostName: "hel-vps",
      DNSName: "hel-vps.tail0000.ts.net.",
      OS: "linux",
      UserID: 2002,
      TailscaleIPs: ["100.64.0.12", "fd7a:115c:a1e0::12"],
      Tags: ["tag:exit"],
      Relay: "hel",
      CurAddr: "95.216.1.2:41641",
      PeerRelay: "",
      RxBytes: 12345,
      TxBytes: 678,
      LastSeen: "2026-09-18T10:00:00Z",
      LastHandshake: "2026-09-18T10:00:30Z",
      Online: true,
      ExitNode: true,
      ExitNodeOption: true,
      Active: true,
      KeyExpiry: "2027-02-06T09:08:16Z",
    },
    "nodekey:mullvad": {
      ID: "nMUL",
      HostName: "us-lax-wg-402",
      DNSName: "us-lax-wg-402.mullvad.ts.net.",
      OS: "",
      UserID: 2002,
      TailscaleIPs: ["100.75.147.32", "fd7a:115c:a1e0::e601:93c7"],
      Tags: ["tag:mullvad-exit-node"],
      Relay: "",
      CurAddr: "",
      PeerRelay: "",
      Location: {
        Country: "USA",
        CountryCode: "US",
        City: "Los Angeles, CA",
        CityCode: "LAX",
        Latitude: 34.05,
        Longitude: -118.24,
        Priority: 100,
      },
      LastSeen: "0001-01-01T00:00:00Z",
      LastHandshake: "0001-01-01T00:00:00Z",
      Online: true,
      ExitNode: false,
      ExitNodeOption: true,
    },
    "nodekey:expired": {
      ID: "nOLD",
      HostName: "old-thinkpad",
      DNSName: "old-thinkpad.tail0000.ts.net.",
      OS: "windows",
      UserID: 1001,
      TailscaleIPs: ["100.64.0.23"],
      Online: false,
      ExitNode: false,
      ExitNodeOption: true,
      Expired: true,
      KeyExpiry: "2026-06-01T00:00:00Z",
    },
    "nodekey:plain": {
      ID: "nPLAIN",
      HostName: "phone",
      DNSName: "phone.tail0000.ts.net.",
      OS: "iOS",
      UserID: 1001,
      TailscaleIPs: ["100.64.0.9"],
      Online: false,
      ExitNode: false,
      ExitNodeOption: false,
    },
  },
  User: {
    "1001": { ID: 1001, LoginName: "you@example.com", DisplayName: "You" },
    "2002": {
      ID: 2002,
      LoginName: "tagged-devices",
      DisplayName: "Tagged Devices",
    },
  },
};

const prefsFixture = {
  ControlURL: "https://controlplane.tailscale.com",
  ExitNodeID: "nHEL",
  ExitNodeIP: "",
  AutoExitNode: "any",
  ExitNodeAllowLANAccess: true,
};

describe("parseStatus", () => {
  test("keeps only exit-node capable peers and maps fields", () => {
    const s = parseStatus(statusFixture, prefsFixture);
    expect(s.backendState).toBe("Running");
    expect(s.version).toBe("1.102.4");
    expect(s.tailnet).toBe("you@example.com");
    expect(s.self?.hostName).toBe("my-laptop");
    expect(s.self?.dnsName).toBe("my-laptop.tail0000.ts.net");
    expect(s.self?.exitNodeOption).toBe(true);
    expect(s.self?.keyExpiry?.toISOString()).toBe("2027-03-11T07:24:59.000Z");
    expect(s.allowLan).toBe(true);
    expect(s.autoExitNode).toBe(true);
    expect(s.health).toHaveLength(1);
    expect(s.exitNode?.id).toBe("nHEL");
    expect(s.exitNode?.ips).toEqual(["100.64.0.12", "fd7a:115c:a1e0::12"]);
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["nHEL", "nMUL", "nOLD"]);

    const hel = s.nodes.find((n) => n.id === "nHEL")!;
    expect(hel.name).toBe("hel-vps");
    expect(hel.dnsName).toBe("hel-vps.tail0000.ts.net");
    expect(hel.ip).toBe("100.64.0.12");
    expect(hel.active).toBe(true);
    expect(hel.owner).toBe("tagged-devices");
    expect(hel.relay).toBe("hel");
    expect(hel.curAddr).toBe("95.216.1.2:41641");
    expect(hel.peerRelay).toBeUndefined();
    expect(hel.rxBytes).toBe(12345);
    expect(hel.lastHandshake?.toISOString()).toBe("2026-09-18T10:00:30.000Z");
    expect(hel.keyExpiry?.toISOString()).toBe("2027-02-06T09:08:16.000Z");
    expect(hel.expired).toBe(false);
    expect(hel.isMullvad).toBe(false);

    const mul = s.nodes.find((n) => n.id === "nMUL")!;
    expect(mul.name).toBe("us-lax-wg-402");
    expect(mul.isMullvad).toBe(true);
    expect(mul.os).toBe("");
    expect(mul.countryCode).toBe("US");
    expect(mul.country).toBe("USA");
    expect(mul.city).toBe("Los Angeles, CA");
    expect(mul.priority).toBe(100);
    expect(mul.lastSeen).toBeUndefined();
    expect(mul.keyExpiry).toBeUndefined();

    const old = s.nodes.find((n) => n.id === "nOLD")!;
    expect(old.expired).toBe(true);
    expect(old.online).toBe(false);
  });

  test("uses ExitNodeStatus to mark the active node even if the peer flag lags", () => {
    const fixture = structuredClone(statusFixture);
    fixture.Peer["nodekey:hel"].ExitNode = false;
    const s = parseStatus(fixture);
    expect(s.nodes.find((n) => n.id === "nHEL")?.active).toBe(true);
    expect(s.allowLan).toBeNull();
    expect(s.autoExitNode).toBeNull();
  });

  test("auto exit node is off when the pref is an empty string", () => {
    const s = parseStatus(statusFixture, { ...prefsFixture, AutoExitNode: "" });
    expect(s.autoExitNode).toBe(false);
    const s2 = parseStatus(statusFixture, { ExitNodeAllowLANAccess: false });
    expect(s2.autoExitNode).toBe(false);
  });

  test("tolerates lowerCamel keys and missing sections", () => {
    const s = parseStatus({
      backendState: "Stopped",
      peer: {},
      self: { hostName: "x", tailscaleIps: [] },
    });
    expect(s.backendState).toBe("Stopped");
    expect(s.self?.hostName).toBe("x");
    expect(s.nodes).toEqual([]);
    expect(s.exitNode).toBeNull();
  });
});

describe("parseSuggest", () => {
  test("extracts the host name from the CLI output", () => {
    expect(
      parseSuggest(
        "Suggested exit node: fi-hel-wg-203.mullvad.ts.net.\nTo accept this suggestion, use `tailscale set --exit-node=fi-hel-wg-203.mullvad.ts.net.`.\n",
      ),
    ).toBe("fi-hel-wg-203.mullvad.ts.net");
    expect(parseSuggest("no exit node suggestion")).toBeNull();
  });
});

describe("parsePong", () => {
  test("parses tailscale ping replies in ms, s and µs with the path", () => {
    expect(
      parsePong(
        "pong from raspberrypi (100.89.133.58) via 192.168.0.141:41641 in 1ms\n",
      ),
    ).toEqual({
      rtt: 1,
      via: "via 192.168.0.141:41641",
    });
    expect(parsePong("pong from x (100.64.0.1) via DERP(fra) in 1.5s")).toEqual(
      { rtt: 1500, via: "via DERP(fra)" },
    );
    expect(
      parsePong("pong from x (100.64.0.1) via DERP(fra) in 800µs")?.rtt,
    ).toBe(0.8);
    expect(parsePong("pong from x (100.64.0.1) in 12ms")?.via).toBe(
      "tailscale ping",
    );
    expect(parsePong('ping "100.74.4.51" timed out\nno reply\n')).toBeNull();
  });
});

describe("icmp", () => {
  test("builds the platform's ping command", () => {
    expect(icmpPingCommand("203.0.113.1", 3, "linux")).toEqual([
      "ping",
      "-n",
      "-c",
      "1",
      "-W",
      "3",
      "203.0.113.1",
    ]);
    expect(icmpPingCommand("203.0.113.1", 3, "darwin")).toEqual([
      "ping",
      "-n",
      "-c",
      "1",
      "-W",
      "3000",
      "203.0.113.1",
    ]);
    expect(icmpPingCommand("203.0.113.1", 3, "win32")).toEqual([
      "ping",
      "-n",
      "1",
      "-w",
      "3000",
      "203.0.113.1",
    ]);
  });
  test("parses iputils, BSD and Windows replies", () => {
    expect(
      parseIcmpPing(
        "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=60 time=2.75 ms\n",
      ),
    ).toBe(2.75);
    expect(
      parseIcmpPing("64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=120.512 ms"),
    ).toBe(120.512);
    expect(parseIcmpPing("Reply from 1.1.1.1: bytes=32 time=12ms TTL=57")).toBe(
      12,
    );
    expect(parseIcmpPing("Reply from 1.1.1.1: bytes=32 time<1ms TTL=57")).toBe(
      1,
    );
    expect(
      parseIcmpPing(
        "1 packets transmitted, 0 received, 100% packet loss, time 0ms",
      ),
    ).toBeNull();
  });
});

describe("parseRelayList", () => {
  test("maps Mullvad relay host names to their public IPv4", () => {
    const map = parseRelayList([
      {
        hostname: "fi-hel-wg-203",
        ipv4_addr_in: "185.65.133.165",
        active: true,
        type: "wireguard",
      },
      { hostname: "US-LAX-WG-402", ipv4_addr_in: "23.234.85.127" },
      { hostname: "broken" },
      "junk",
    ]);
    expect(map.get("fi-hel-wg-203")).toBe("185.65.133.165");
    expect(map.get("us-lax-wg-402")).toBe("23.234.85.127");
    expect(map.size).toBe(2);
    expect(parseRelayList({ not: "a list" }).size).toBe(0);
  });
});
