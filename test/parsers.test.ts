import { describe, expect, test } from "bun:test";
import { cliError } from "../src/backend/cli";
import { parseDnsStatus } from "../src/backend/dns";
import { parseNetcheck } from "../src/backend/netcheck";
import {
  parsePrefs,
  parseProfiles,
  prefsFromDebug,
} from "../src/backend/prefs";
import {
  driveShareName,
  normalizeServeTarget,
  parseDriveList,
  parseFileGet,
  parseServeStatus,
  serveAddress,
  serveTarget,
} from "../src/backend/share";
import { parseStatus } from "../src/backend/tailscale";
import {
  applyDeviceQuery,
  connectionLabel,
  mayRunSsh,
  tailnetDevices,
  type Peer,
} from "../src/model";
import { FixtureBackend, NETCHECK_OUTPUT } from "./fixture";

const res = (stderr: string, stdout = "", code = 1) => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

describe("tailscale netcheck", () => {
  test("parses the report and sorts relays by latency", () => {
    const r = parseNetcheck(NETCHECK_OUTPUT, 1);
    expect(r.udp).toBe(true);
    expect(r.ipv4).toBe("203.0.113.50:40708");
    expect(r.ipv6).toBeNull();
    expect(r.mappingVaries).toBe(false);
    expect(r.portMapping).toBe("UPnP");
    expect(r.nearestDerp).toBe("Helsinki");
    expect(r.derps.map((d) => d.code)).toEqual([
      "hel",
      "ams",
      "fra",
      "nyc",
      "sfo",
    ]);
    expect(r.derps[0]).toEqual({ code: "hel", name: "Helsinki", ms: 16.5 });
  });

  test("handles hard NAT, blocked UDP, captive portals and other units", () => {
    const r = parseNetcheck(
      [
        "Report:",
        "\t* UDP: false",
        "\t* IPv4: yes, 198.51.100.7:1234",
        "\t* IPv6: yes, [2001:db8::1]:41641",
        "\t* MappingVariesByDestIP: true",
        "\t* CaptivePortal: true",
        "\t* PortMapping: ",
        "\t\t- sin: 1.2s  (Singapore)",
        "\t\t- lon: 900µs (London)",
      ].join("\n"),
    );
    expect(r.udp).toBe(false);
    expect(r.ipv6).toBe("[2001:db8::1]:41641");
    expect(r.mappingVaries).toBe(true);
    expect(r.captivePortal).toBe(true);
    expect(r.portMapping).toBe("");
    expect(r.derps).toEqual([
      { code: "lon", name: "London", ms: 0.9 },
      { code: "sin", name: "Singapore", ms: 1200 },
    ]);
  });
});

describe("tailscale dns status --json", () => {
  test("reads the tailnet DNS configuration", () => {
    const d = parseDnsStatus({
      TailscaleDNS: true,
      CurrentTailnet: {
        MagicDNSEnabled: false,
        MagicDNSSuffix: "tail803383.ts.net",
        SelfDNSName: "k-pc.tail803383.ts.net.",
      },
      Resolvers: [{ Addr: "100.89.133.58" }],
      SplitDNSRoutes: {
        "corp.example.com.": [{ Addr: "10.0.0.53" }],
        "b.example.": [],
      },
      SearchDomains: ["tail803383.ts.net."],
      SystemDNSError: "Access denied: dns-osconfig dump access denied",
    });
    expect(d.tailscaleDns).toBe(true);
    expect(d.magicDns).toBe(false);
    expect(d.suffix).toBe("tail803383.ts.net");
    expect(d.resolvers).toEqual(["100.89.133.58"]);
    expect(d.routes).toEqual([
      { domain: "b.example", resolvers: [] },
      { domain: "corp.example.com", resolvers: ["10.0.0.53"] },
    ]);
    expect(d.searchDomains).toEqual(["tail803383.ts.net"]);
    expect(d.systemError).toContain("access denied");
  });

  test("tolerates an empty document", () => {
    expect(parseDnsStatus(null)).toMatchObject({
      tailscaleDns: false,
      resolvers: [],
      routes: [],
    });
  });
});

describe("preferences and accounts", () => {
  test("tailscale get --json keeps booleans and strings by flag name", () => {
    const p = parsePrefs({
      "accept-dns": true,
      hostname: "",
      "relay-server-port": 41642,
      junk: null,
    });
    expect(p).toEqual({
      "accept-dns": true,
      hostname: "",
      "relay-server-port": "41642",
    });
  });

  test("tailscale debug prefs stands in for get --json before Tailscale 1.100", () => {
    const p = prefsFromDebug({
      RouteAll: false,
      CorpDNS: true,
      RunSSH: false,
      RunWebClient: false,
      WantRunning: true,
      ShieldsUp: false,
      Hostname: "",
      AdvertiseRoutes: ["0.0.0.0/0", "::/0", "192.168.1.0/24"],
      NoSNAT: false,
      NoStatefulFiltering: true,
      NetfilterMode: 2,
      AutoUpdate: { Check: true, Apply: null },
      AppConnector: { Advertise: false },
      PostureChecking: false,
      ExitNodeAllowLANAccess: true,
    });
    expect(p).toEqual({
      "accept-routes": false,
      "accept-dns": true,
      ssh: false,
      webclient: false,
      "shields-up": false,
      "snat-subnet-routes": true,
      "stateful-filtering": false,
      "report-posture": false,
      "exit-node-allow-lan-access": true,
      hostname: "",
      operator: "",
      "advertise-exit-node": true,
      "advertise-routes": "192.168.1.0/24",
      "netfilter-mode": "on",
      "update-check": true,
      "auto-update": false,
      "advertise-connector": false,
    });
  });

  test("tailscale switch --list --json", () => {
    expect(
      parseProfiles([
        {
          id: "a1b2",
          nickname: "",
          tailnet: "example.com",
          account: "you@example.com",
          selected: true,
        },
        { id: "", account: "broken" },
        "nonsense",
      ]),
    ).toEqual([
      {
        id: "a1b2",
        nickname: "",
        tailnet: "example.com",
        account: "you@example.com",
        selected: true,
      },
    ]);
    expect(parseProfiles({})).toEqual([]);
  });
});

describe("tailscale serve status --json", () => {
  const host = "k-pc.tail0000.ts.net";
  const doc = {
    TCP: {
      "443": { HTTPS: true },
      "8080": { HTTP: true },
      "5432": { TCPForward: "127.0.0.1:5432" },
    },
    Web: {
      [`${host}:443`]: {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:3000" },
          "/docs": { Path: "/srv/docs" },
        },
      },
      [`${host}:8080`]: { Handlers: { "/": { Text: "hello" } } },
    },
    AllowFunnel: { [`${host}:443`]: true },
    Foreground: {
      abc: {
        TCP: { "8443": { HTTPS: true } },
        Web: {
          [`${host}:8443`]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } },
          },
        },
      },
    },
  };

  test("lists web handlers, TCP forwarders and foreground serves", () => {
    const entries = parseServeStatus(doc, host);
    expect(
      entries.map((e) => [
        e.id,
        e.kind,
        e.target,
        e.url,
        e.funnel,
        e.foreground,
      ]),
    ).toEqual([
      [
        "443/",
        "proxy",
        "http://127.0.0.1:3000",
        `https://${host}/`,
        true,
        false,
      ],
      ["443/docs", "path", "/srv/docs", `https://${host}/docs`, true, false],
      ["tcp/5432", "tcp", "127.0.0.1:5432", `tcp://${host}:5432`, false, false],
      ["8080/", "text", "hello", `http://${host}:8080/`, false, false],
      [
        "8443/",
        "proxy",
        "http://127.0.0.1:9000",
        `https://${host}:8443/`,
        false,
        true,
      ],
    ]);
    expect(parseServeStatus({}, host)).toEqual([]);
  });

  test("addresses entries for serve ... off and for re-serving", () => {
    const [root, docs, tcp, text] = parseServeStatus(doc, host);
    expect(serveAddress(root!)).toEqual(["--https=443"]);
    expect(serveAddress(docs!)).toEqual(["--https=443", "--set-path=/docs"]);
    expect(serveAddress(tcp!)).toEqual(["--tcp=5432"]);
    expect(serveAddress(text!)).toEqual(["--http=8080"]);
    expect(serveTarget(text!)).toBe("text:hello");
    expect(serveTarget(tcp!)).toBe("tcp://127.0.0.1:5432");
  });

  test("accepts ports, local URLs and paths as share targets", () => {
    expect(normalizeServeTarget(" 3000 ")).toBe("3000");
    expect(normalizeServeTarget("localhost:8080/api")).toBe(
      "localhost:8080/api",
    );
    expect(normalizeServeTarget("https+insecure://localhost:8443")).toBe(
      "https+insecure://localhost:8443",
    );
    expect(normalizeServeTarget("~/public")).toBe("~/public");
    expect(normalizeServeTarget("example.com")).toBeNull();
    expect(normalizeServeTarget("")).toBeNull();
  });
});

describe("Taildrive and Taildrop", () => {
  test("tailscale drive list", () => {
    const out =
      "name    path                   as\n----    ----                   --\ndocs    /home/k/Documents      k\nmy pics    /home/k/Pictures    k\n";
    expect(parseDriveList(out)).toEqual([
      { name: "docs", path: "/home/k/Documents", as: "k" },
      { name: "my pics", path: "/home/k/Pictures", as: "k" },
    ]);
    expect(parseDriveList("name    path    as\n----    ----    --\n")).toEqual(
      [],
    );
  });

  test("share names follow Taildrive's rules", () => {
    expect(driveShareName("My Photos-2026")).toBe("my photos");
    expect(driveShareName("tax_2026 (final)")).toBe("tax_ (final)");
    expect(driveShareName("docs")).toBe("docs");
    expect(driveShareName("---")).toBe("");
  });

  test("tailscale file get --verbose", () => {
    const out =
      "wrote report.pdf as /home/k/Downloads/report (1).pdf (2048 bytes)\nwrote a.txt as /home/k/Downloads/a.txt (5 bytes)\nmoved 2/2 files\n";
    expect(parseFileGet(out, 7)).toEqual([
      {
        name: "report.pdf",
        path: "/home/k/Downloads/report (1).pdf",
        bytes: 2048,
        at: 7,
      },
      { name: "a.txt", path: "/home/k/Downloads/a.txt", bytes: 5, at: 7 },
    ]);
    expect(parseFileGet("moved 0/0 files\n")).toEqual([]);
  });
});

describe("tailscale status --json: devices", () => {
  const b = new FixtureBackend({ update: "1.104.0" });
  const s = parseStatus(b.statusJson(), b.prefsJson());

  test("keeps every peer and reads the fields the devices view needs", () => {
    expect(s.peers.length).toBe(b.peers.length);
    expect(s.nodes.every((n) => n.exitNodeOption)).toBe(true);
    const nas = s.peers.find((p) => p.name === "nas")!;
    expect(nas.exitNodeOption).toBe(false);
    expect(nas.ssh).toBe(true);
    expect(nas.taildrop).toBe(true);
    expect(nas.routes).toEqual(["192.168.1.0/24"]);
    expect(nas.inSession).toBe(true);
    expect(s.peers.find((p) => p.name === "fi-hel-wg-203")!.taildrop).toBe(
      false,
    );
  });

  test("reads this device, the account and a pending update", () => {
    expect(s.self).toMatchObject({
      name: "my-laptop",
      relay: "hel",
      endpoints: ["203.0.113.50:41641", "192.168.1.20:41641"],
    });
    expect(s.user).toEqual({ login: "you@example.com", name: "You" });
    expect(s.magicDns).toBe(true);
    expect(s.update).toBe("1.104.0");
    expect(s.authUrl).toBe("");
  });

  test("exit routes are not listed as subnet routes", () => {
    const st = parseStatus({
      Peer: {
        k: {
          ID: "n1",
          DNSName: "gw.ts.net.",
          PrimaryRoutes: ["0.0.0.0/0", "::/0", "10.1.0.0/16"],
        },
      },
    });
    expect(st.peers[0]!.routes).toEqual(["10.1.0.0/16"]);
  });
});

describe("devices model", () => {
  const b = new FixtureBackend();
  const peers = parseStatus(b.statusJson(), b.prefsJson()).peers;
  const devices = tailnetDevices(peers);

  test("drops Mullvad relays", () => {
    expect(devices.map((d) => d.name).sort()).toEqual([
      "home-server",
      "nas",
      "office-gw",
      "old-thinkpad",
      "phone",
      "pixel-8",
    ]);
  });

  test("connection labels read like tailscale status", () => {
    const by = (n: string) => devices.find((d) => d.name === n)!;
    expect(connectionLabel(by("nas"))).toBe("direct");
    expect(connectionLabel(by("office-gw"))).toBe("idle");
    expect(connectionLabel(by("old-thinkpad"))).toBe("key expired");
    expect(
      connectionLabel(by("pixel-8"), Date.parse("2026-09-18T08:00:00Z")),
    ).toBe("2d ago");
    const relayed: Peer = { ...by("office-gw"), inSession: true, relay: "fra" };
    expect(connectionLabel(relayed)).toBe("relay fra");
  });

  test("phones run no SSH server", () => {
    expect(mayRunSsh(devices.find((d) => d.name === "phone")!)).toBe(false);
    expect(mayRunSsh(devices.find((d) => d.name === "pixel-8")!)).toBe(false);
    expect(mayRunSsh(devices.find((d) => d.name === "nas")!)).toBe(true);
  });

  test("filters and sorts", () => {
    const q = (
      filter: "all" | "online" | "mine" | "tagged",
      sort: "status" | "name" = "status",
    ) =>
      applyDeviceQuery(
        devices,
        { text: "", filter, sort, desc: false },
        "you@example.com",
        () => undefined,
      ).map((d) => d.name);
    expect(q("online")).toEqual(["home-server", "nas", "office-gw", "phone"]);
    expect(q("tagged")).toEqual(["office-gw"]);
    expect(q("mine")).not.toContain("office-gw");
    expect(q("all", "name")).toEqual([
      "home-server",
      "nas",
      "office-gw",
      "old-thinkpad",
      "phone",
      "pixel-8",
    ]);
    // Status: online first, then offline by last seen, expired last.
    expect(q("all").slice(-2)).toEqual(["pixel-8", "old-thinkpad"]);
  });
});

describe("CLI errors", () => {
  test("access denied is found anywhere in a multi-line error and gets the operator hint", () => {
    const e = cliError(
      res(
        "Access denied: profiles access denied\n\nUse 'sudo tailscale switch --list'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n",
      ),
      "tailscale switch --list",
    );
    expect(e.message).toBe("tailscale switch --list: access denied");
    expect(e.hint).toContain("sudo tailscale set --operator=$USER");
  });

  test("Taildrive not enabled names the node attribute", () => {
    const e = cliError(
      res(
        'Access denied: taildrive sharing not enabled, please add the attribute "drive:share" to this node\n',
      ),
      "Taildrive",
    );
    expect(e.message).toBe(
      "Taildrive: Taildrive is not enabled for this device",
    );
    expect(e.hint).toContain("drive:share");
  });

  test("uses the first real line, skipping Go log lines and the Error: prefix", () => {
    const e = cliError(
      res(
        "2026/09/22 21:57:33 portmap: monitor: gateway changed\nError: changing settings via 'tailscale up' requires mentioning all\nnon-default flags.\n",
      ),
      "tailscale up",
    );
    expect(e.message).toBe(
      "tailscale up: changing settings via 'tailscale up' requires mentioning all",
    );
  });

  test("timeouts and a stopped daemon", () => {
    expect(
      cliError({ code: 1, stdout: "", stderr: "", timedOut: true }, "x")
        .message,
    ).toBe("x: timed out");
    const e = cliError(
      res(
        "failed to connect to local tailscaled; it doesn't appear to be running",
      ),
      "status",
    );
    expect(e.message).toBe("status: tailscaled is not running");
  });
});
