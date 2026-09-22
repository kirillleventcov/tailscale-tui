// The network as a checklist: connectivity from `tailscale netcheck`, DNS from `tailscale dns
// status`, health warnings, and the DERP relays by latency. The details panel explains the
// selected finding and what to do about it.
import type { KeyEvent, TextChunk } from "@opentui/core";
import { cliError } from "../backend/cli";
import { dnsStatus, type DnsStatus } from "../backend/dns";
import type { DerpRegion, NetcheckReport } from "../backend/netcheck";
import { fit, relTime, truncate } from "../format";
import { theme } from "../theme";
import { DetailsPanel, btn, ch, setChip, type Chip, type Lines } from "../ui";
import { ListView, prose } from "./list-view";

type Level = "ok" | "warn" | "bad" | "off" | "pending";

interface Heading {
  kind: "heading";
  label: string;
}

interface Check {
  kind: "check";
  id: string;
  label: string;
  level: Level;
  value: string;
  /** What it means and what to do, shown in the details panel. */
  explain: string;
  /** Extra values listed in the details panel. */
  more?: string[];
}

interface Region {
  kind: "region";
  region: DerpRegion;
  rank: number;
  home: boolean;
  max: number;
}

type Item = Heading | Check | Region;

const LABEL_COL = 16;

function glyph(level: Level): TextChunk {
  switch (level) {
    case "ok":
      return ch("✓", { fg: theme.green, bold: true });
    case "warn":
      return ch("⚠", { fg: theme.yellow, bold: true });
    case "bad":
      return ch("✗", { fg: theme.red, bold: true });
    case "off":
      return ch("○", { fg: theme.textMuted });
    case "pending":
      return ch("…", { fg: theme.accent });
  }
}

function levelColor(level: Level): string {
  return level === "ok"
    ? theme.text
    : level === "warn"
      ? theme.yellow
      : level === "bad"
        ? theme.red
        : level === "pending"
          ? theme.accent
          : theme.textDim;
}

function msColor(ms: number): string {
  return ms < 60 ? theme.green : ms < 150 ? theme.yellow : theme.orange;
}

/** The checks for one netcheck report; `null` renders them as pending. */
export function connectivityChecks(
  rep: NetcheckReport | null,
  running: boolean,
): Check[] {
  const pending = (id: string, label: string): Check => ({
    kind: "check",
    id,
    label,
    level: running ? "pending" : "off",
    value: running ? "measuring…" : "not measured",
    explain: "Press r to measure the network with tailscale netcheck.",
  });
  if (!rep)
    return [
      pending("udp", "UDP"),
      pending("ipv4", "IPv4"),
      pending("ipv6", "IPv6"),
      pending("nat", "NAT"),
      pending("portmap", "Port mapping"),
      pending("nearest", "Nearest relay"),
    ];
  const checks: Check[] = [
    {
      kind: "check",
      id: "udp",
      label: "UDP",
      level: rep.udp === null ? "off" : rep.udp ? "ok" : "bad",
      value: rep.udp === null ? "unknown" : rep.udp ? "works" : "blocked",
      explain: rep.udp
        ? "WireGuard runs over UDP and it gets through here, so direct connections to peers are possible."
        : "UDP is blocked on this network. Every connection falls back to a DERP relay over HTTPS: it works, but with more latency. Allowing outbound UDP (port 41641 and above) fixes it.",
    },
    {
      kind: "check",
      id: "ipv4",
      label: "IPv4",
      level: rep.ipv4 ? "ok" : "bad",
      value: rep.ipv4 ?? "no connectivity",
      explain: rep.ipv4
        ? "Your public IPv4 address and port as the relay servers see them."
        : "No IPv4 connectivity to the relay servers.",
    },
    {
      kind: "check",
      id: "ipv6",
      label: "IPv6",
      level: rep.ipv6 ? "ok" : "off",
      value: rep.ipv6 ?? "none",
      explain: rep.ipv6
        ? "IPv6 works. Peers that also have IPv6 can usually connect directly, without NAT traversal."
        : "No IPv6 on this network. Nothing is wrong; connections use IPv4.",
    },
    {
      kind: "check",
      id: "nat",
      label: "NAT",
      level:
        rep.mappingVaries === null ? "off" : rep.mappingVaries ? "warn" : "ok",
      value:
        rep.mappingVaries === null
          ? "unknown"
          : rep.mappingVaries
            ? "hard, port varies per destination"
            : "easy, stable public port",
      explain: rep.mappingVaries
        ? "Your router picks a new public port for every destination (hard NAT). Direct connections often fail and traffic goes through relays. Port mapping on the router (UPnP, NAT-PMP or PCP) or a peer relay helps."
        : "Your router keeps one public port for every destination (easy NAT), so direct connections to peers usually succeed.",
    },
    {
      kind: "check",
      id: "portmap",
      label: "Port mapping",
      level: rep.portMapping ? "ok" : "off",
      value: rep.portMapping || "none",
      explain: rep.portMapping
        ? `The router speaks ${rep.portMapping}, so Tailscale can open a port for direct connections.`
        : "The router answered no port mapping protocol (UPnP, NAT-PMP, PCP). Tailscale gets through most NATs without one.",
    },
  ];
  if (rep.captivePortal)
    checks.push({
      kind: "check",
      id: "captive",
      label: "Captive portal",
      level: "bad",
      value: "login page intercepts traffic",
      explain:
        "A captive portal (hotel, airport or café login) intercepts traffic. Open a browser and log in to the network.",
    });
  const near = rep.derps[0];
  checks.push({
    kind: "check",
    id: "nearest",
    label: "Nearest relay",
    level: near ? "ok" : "bad",
    value: near
      ? `${near.code} ${near.name} · ${Math.round(near.ms)} ms`
      : "none reachable",
    explain: near
      ? "The DERP relay with the lowest latency. Tailscale uses relays to set up connections and as the fallback path when a direct one is impossible."
      : "No DERP relay answered. Tailscale cannot reach its relays from this network.",
  });
  return checks;
}

export function dnsChecks(d: DnsStatus | null, err: string | null): Check[] {
  if (!d)
    return [
      {
        kind: "check",
        id: "dns",
        label: "DNS",
        level: err ? "warn" : "pending",
        value: err ? "could not read" : "reading…",
        explain: err ?? "Reading tailscale dns status.",
      },
    ];
  const checks: Check[] = [
    {
      kind: "check",
      id: "acceptdns",
      label: "Tailnet DNS",
      level: d.tailscaleDns ? "ok" : "warn",
      value: d.tailscaleDns
        ? "used by this device"
        : "ignored (accept-dns off)",
      explain: d.tailscaleDns
        ? "This device follows the tailnet's DNS settings: MagicDNS names, split DNS and global nameservers."
        : "This device ignores the tailnet's DNS settings, so device names do not resolve here. Turn on Accept DNS in Settings (6).",
    },
    {
      kind: "check",
      id: "magicdns",
      label: "MagicDNS",
      level: d.magicDns ? "ok" : "off",
      value: d.magicDns ? `on · ${d.suffix}` : "off",
      explain: d.magicDns
        ? `Devices resolve by name, so "ssh raspberrypi" works. Full names end in ${d.suffix}.`
        : "Device names do not resolve; use Tailscale IPs. An admin can turn MagicDNS on in the admin console under DNS.",
    },
    {
      kind: "check",
      id: "resolvers",
      label: "Nameservers",
      level: "off",
      value: d.resolvers.length ? d.resolvers.join(", ") : "system default",
      explain: d.resolvers.length
        ? "Global nameservers set in the admin console. Queries that are not for the tailnet go to them."
        : "No global nameservers: the operating system's resolvers answer everything outside the tailnet.",
      more: d.resolvers.length > 2 ? d.resolvers : undefined,
    },
  ];
  if (d.routes.length > 0)
    checks.push({
      kind: "check",
      id: "split",
      label: "Split DNS",
      level: "off",
      value: `${d.routes.length} domain${d.routes.length === 1 ? "" : "s"}`,
      explain: "These domains are resolved by their own nameservers.",
      more: d.routes.map(
        (r) => `${r.domain} → ${r.resolvers.join(", ") || "tailnet"}`,
      ),
    });
  if (d.searchDomains.length > 0)
    checks.push({
      kind: "check",
      id: "search",
      label: "Search domains",
      level: "off",
      value: d.searchDomains.join(" "),
      explain: "Short names are tried with these suffixes.",
      more: d.searchDomains.length > 1 ? d.searchDomains : undefined,
    });
  if (d.systemError)
    checks.push({
      kind: "check",
      id: "sysdns",
      label: "System DNS",
      level: "off",
      value: "not readable",
      explain: `Tailscale could not read the operating system's DNS configuration: ${d.systemError}. Only this diagnostic is affected.`,
    });
  return checks;
}

export class NetworkView extends ListView<Item> {
  readonly id = "network" as const;
  readonly title = "Network";
  readonly short = "Net";

  private dns: DnsStatus | null = null;
  private dnsError: string | null = null;
  private dnsAt = 0;
  private btnMeasure!: Chip;
  private btnCopy!: Chip;
  private btnBug!: Chip;
  private bugId: string | null = null;

  protected listTitle(): string {
    return "Network";
  }

  protected helpLines(): [string, string][] {
    return [
      [
        "Network",
        "r measure again (tailscale netcheck) · y or c copy the report · b bug report",
      ],
      ["Mouse", "click a finding for what it means · click the buttons"],
    ];
  }

  protected override buildDetails(d: DetailsPanel): void {
    this.btnMeasure = d.addButton(
      this.chip("measure", "Measure again", () => this.reload()),
    );
    this.btnCopy = d.addButton(
      this.chip("copy", "Copy report", () => this.copyReport()),
    );
    this.btnBug = d.addButton(
      this.chip("bug", "Bug report", () => void this.bugReport()),
    );
  }

  override onShow(select?: string): void {
    super.onShow(select);
    const nc = this.ctx.netcheck;
    if (!nc.report && !nc.running) void nc.run();
    if (!this.dns || Date.now() - this.dnsAt > 60_000) void this.loadDns();
  }

  reload(): void {
    void this.ctx.netcheck.run();
    void this.loadDns();
  }

  private async loadDns(): Promise<void> {
    try {
      this.dns = await dnsStatus(this.ctx.backend);
      this.dnsError = null;
      this.dnsAt = Date.now();
    } catch (e) {
      this.dnsError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  protected allItems(): Item[] {
    const nc = this.ctx.netcheck;
    const rep = nc.report;
    const items: Item[] = [{ kind: "heading", label: "Connectivity" }];
    items.push(...connectivityChecks(rep, nc.running));
    if (nc.error && !rep)
      items.push({
        kind: "check",
        id: "ncerr",
        label: "netcheck",
        level: "bad",
        value: "failed",
        explain: nc.error,
      });
    items.push({ kind: "heading", label: "DNS" });
    items.push(...dnsChecks(this.dns, this.dnsError));
    items.push({ kind: "heading", label: "Health" });
    const health = this.ctx.state?.health ?? [];
    if (health.length === 0)
      items.push({
        kind: "check",
        id: "health",
        label: "Warnings",
        level: "ok",
        value: "none",
        explain: "tailscaled reports no health warnings.",
      });
    health.forEach((h, i) =>
      items.push({
        kind: "check",
        id: `health-${i}`,
        label: "Warning",
        level: "warn",
        value: h,
        explain: h,
      }),
    );
    if (rep && rep.derps.length > 0) {
      items.push({ kind: "heading", label: "Relays (DERP)" });
      const home = this.ctx.state?.self?.relay;
      const max = Math.max(...rep.derps.map((d) => d.ms));
      rep.derps.forEach((region, i) =>
        items.push({
          kind: "region",
          region,
          rank: i + 1,
          home: region.code === home,
          max,
        }),
      );
    }
    return items;
  }

  protected key(it: Item): string {
    return it.kind === "heading"
      ? `h:${it.label}`
      : it.kind === "check"
        ? `c:${it.id}`
        : `r:${it.region.code}`;
  }

  protected override selectable(it: Item): boolean {
    return it.kind !== "heading";
  }

  protected override emptyText(): string | null {
    return null;
  }

  protected override renderTitle(): void {
    const rep = this.ctx.netcheck.report;
    const when = this.ctx.netcheck.running
      ? "measuring…"
      : rep
        ? `checked ${relTime(new Date(rep.at))}`
        : "";
    this.list.setTitle(
      ` Network ${when ? `· ${when} ` : ""}${this.ctx.busyTitle()}`,
    );
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  protected row(it: Item, selected: boolean, w: number): TextChunk[] {
    const mark = ch(selected ? "▸" : " ", { fg: theme.accent, bold: true });
    if (it.kind === "heading")
      return [
        ch(" "),
        ch(it.label.toUpperCase(), { fg: theme.textDim, bold: true }),
      ];
    if (it.kind === "check") {
      const valW = Math.max(8, w - 3 - LABEL_COL - 1);
      return [
        mark,
        glyph(it.level),
        ch(" "),
        ch(fit(it.label, LABEL_COL), { fg: theme.text }),
        ch(" "),
        ch(truncate(it.value, valW), { fg: levelColor(it.level) }),
      ];
    }
    const r = it.region;
    const nameW = 18;
    const barMax = Math.max(4, Math.min(30, w - 3 - 5 - nameW - 9 - 8));
    const bar = Math.max(1, Math.round((r.ms / Math.max(1, it.max)) * barMax));
    return [
      mark,
      it.home ? ch("●", { fg: theme.accent }) : ch(" "),
      ch(" "),
      ch(fit(r.code, 5), { fg: theme.text, bold: true }),
      ch(fit(r.name, nameW), { fg: theme.textDim }),
      ch(
        fit(`${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`, 8, "right"),
        { fg: msColor(r.ms) },
      ),
      ch("  "),
      ch("▬".repeat(bar), { fg: msColor(r.ms) }),
      ch(it.home ? "  home" : "", { fg: theme.accent }),
    ];
  }

  protected describe(it: Item | undefined, L: Lines): void {
    if (!it || it.kind === "heading") {
      L.line(
        ch("Select a finding to see what it means.", { fg: theme.textMuted }),
      );
      return;
    }
    if (it.kind === "check") {
      L.title(it.label);
      L.line(
        glyph(it.level),
        ch(" "),
        ch(truncate(it.value, L.width - 2), { fg: levelColor(it.level) }),
      );
      L.blank();
      prose(L, it.explain, theme.text);
      if (it.more && it.more.length > 0) {
        L.blank();
        for (const m of it.more.slice(0, 12))
          L.line(ch(truncate(m, L.width), { fg: theme.textDim }));
      }
      return;
    }
    const r = it.region;
    const peers = (this.ctx.state?.peers ?? []).filter(
      (p) =>
        p.online &&
        p.inSession &&
        !p.curAddr &&
        !p.peerRelay &&
        p.relay === r.code,
    );
    L.title(`${r.code} · ${r.name}`);
    L.line(ch("DERP relay region", { fg: theme.textDim }));
    L.blank();
    L.kv(
      "Latency",
      ch(`${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`, {
        fg: msColor(r.ms),
        bold: true,
      }),
    );
    L.kv(
      "Rank",
      ch(`${it.rank} of ${this.ctx.netcheck.report?.derps.length ?? it.rank}`, {
        fg: theme.textDim,
      }),
    );
    L.kv(
      "Home",
      it.home
        ? ch("yes, this device's home relay", { fg: theme.accent })
        : ch("no", { fg: theme.textDim }),
    );
    if (peers.length > 0)
      L.kv(
        "Relaying",
        ch(`${peers.length} peer${peers.length === 1 ? "" : "s"}: `),
        ch(truncate(peers.map((p) => p.name).join(", "), L.valueW - 10), {
          fg: theme.textDim,
        }),
      );
    L.blank();
    prose(
      L,
      it.home
        ? "Peers reach this device through its home relay until a direct path is found."
        : "Relays are used when a direct connection is impossible. Lower latency means a faster fallback.",
    );
  }

  protected renderButtons(): void {
    const running = this.ctx.netcheck.running;
    setChip(
      this.btnMeasure,
      running ? "Measuring…" : "Measure again",
      running ? btn.off : btn.normal,
    );
    setChip(
      this.btnCopy,
      "Copy report",
      this.ctx.netcheck.report ? btn.normal : btn.off,
    );
    setChip(this.btnBug, this.bugId ? "Copy bug ID" : "Bug report", btn.normal);
  }

  protected activate(): void {}

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  protected override onListKey(key: KeyEvent): boolean {
    const k = key.name;
    if (k === "y" || k === "c") this.copyReport();
    else if (k === "b") void this.bugReport();
    else return false;
    return true;
  }

  /** The findings as plain text, for pasting into an issue or a chat. */
  private reportText(): string {
    const lines: string[] = [];
    for (const it of this.allItems()) {
      if (it.kind === "heading") lines.push("", it.label);
      else if (it.kind === "check") lines.push(`  ${it.label}: ${it.value}`);
      else
        lines.push(
          `  ${it.region.code} ${it.region.name}: ${Math.round(it.region.ms)} ms${it.home ? " (home)" : ""}`,
        );
    }
    return lines.join("\n").trim();
  }

  private copyReport(): void {
    if (!this.ctx.netcheck.report) {
      this.ctx.notify("Nothing measured yet", "info");
      return;
    }
    this.ctx.copy(this.reportText(), "the network report");
  }

  /** `tailscale bugreport` marks the logs and prints an ID to give to Tailscale support. */
  private async bugReport(): Promise<void> {
    if (this.bugId) {
      this.ctx.copy(this.bugId);
      return;
    }
    await this.ctx.runAction(
      "Creating a bug report",
      async () => {
        const res = await this.ctx.backend.cli(["bugreport"], {
          timeoutMs: 30_000,
        });
        const id = /BUG-[\w-]+/.exec(res.stdout)?.[0];
        if (res.code !== 0 || !id) throw cliError(res, "tailscale bugreport");
        this.bugId = id;
      },
      {
        refresh: false,
        onOk: () => {
          if (this.bugId)
            this.ctx.copy(
              this.bugId,
              `${this.bugId} (share it with Tailscale support)`,
            );
        },
      },
    );
  }
}
