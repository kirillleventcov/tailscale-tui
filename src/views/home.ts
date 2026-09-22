// The dashboard: this device, the exit node in use, your devices and the network, on one screen.
// Every panel is a details panel of another view in miniature, and acts like it.
import {
  BoxRenderable,
  TextRenderable,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import {
  connectExitNode,
  currentExitNode,
  disconnectExitNode,
  openUrl,
  startLogin,
  tailscaleDown,
  tailscaleUp,
  toggleAutoExitNode,
  toggleLanAccess,
} from "../actions";
import {
  fit,
  humanBytes,
  osLabel,
  relTime,
  truncate,
  wrapText,
} from "../format";
import {
  connectionLabel,
  findNodeByName,
  locationLong,
  statusLabel,
  tailnetDevices,
  type Peer,
} from "../model";
import { theme } from "../theme";
import {
  DETAILS_WIDTH,
  Lines,
  ListPanel,
  btn,
  ch,
  makeChip,
  setChip,
  styled,
  type Chip,
} from "../ui";
import type { View, ViewContext } from "../view";
import { latencyChunk, pathLabel, statusDot } from "./exit-nodes";

const NARROW = 96;

/** "in 5 months", "in 12 days", "expired" */
export function untilLabel(d: Date, now = Date.now()): string {
  const days = Math.floor((d.getTime() - now) / 86_400_000);
  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days < 60) return `in ${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  return months < 24
    ? `in ${months} months`
    : `in ${Math.round(days / 365)} years`;
}

interface Panel {
  box: BoxRenderable;
  text: TextRenderable;
  buttons: BoxRenderable;
}

export class HomeView implements View {
  readonly id = "home" as const;
  readonly title = "Home";
  readonly short = "Home";

  private ctx!: ViewContext;
  private width = 120;
  private height = 33;
  private narrow = false;
  private shown = false;
  private netAttempted = false;
  private pingedExit: string | null = null;

  private top!: BoxRenderable;
  private bottom!: BoxRenderable;
  private self!: Panel;
  private exit!: Panel;
  private net!: Panel;
  private devices!: ListPanel<Peer>;
  private selfPrimary!: Chip;
  private selfSecondary!: Chip;
  private exitChips: Chip[] = [];

  help(): [string, string][] {
    return [
      [
        "Devices",
        "↑/k ↓/j move · Enter open in Devices · p ping · P ping all · y copy its IP",
      ],
      [
        "Exit node",
        "e choose · d disconnect · a auto exit node on/off · A use suggested · l LAN access",
      ],
      ["This device", "o turn Tailscale on or off · Y copy this device's IP"],
      ["Network", "r measures again (tailscale netcheck)"],
      [
        "Mouse",
        "click the buttons · click a device, double-click opens it · wheel scrolls",
      ],
    ];
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private panel(id: string, title: string, width?: number): Panel {
    const r = this.ctx.r;
    const box = new BoxRenderable(r, {
      id: `home-${id}`,
      ...(width
        ? { width, flexShrink: 0 }
        : { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 30 }),
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title: ` ${title} `,
      titleColor: theme.textDim,
      flexDirection: "column",
      paddingX: 1,
      overflow: "hidden",
    });
    const text = new TextRenderable(r, {
      id: `home-${id}-text`,
      content: "",
      flexGrow: 1,
      wrapMode: "none",
      fg: theme.text,
    });
    const buttons = new BoxRenderable(r, {
      id: `home-${id}-buttons`,
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
    });
    box.add(text);
    box.add(buttons);
    return { box, text, buttons };
  }

  build(ctx: ViewContext, parent: BoxRenderable): void {
    this.ctx = ctx;
    const r = ctx.r;
    this.top = new BoxRenderable(r, {
      id: "home-top",
      flexDirection: "row",
      flexShrink: 0,
      height: 12,
      paddingX: 1,
      gap: 1,
    });
    this.self = this.panel("self", "This device");
    this.exit = this.panel("exit", "Exit node");
    this.selfPrimary = makeChip(r, "home-self-primary", "", () =>
      this.selfAction(),
    );
    this.selfSecondary = makeChip(r, "home-self-secondary", "", () =>
      this.selfSecondaryAction(),
    );
    this.self.buttons.add(this.selfPrimary.box);
    this.self.buttons.add(this.selfSecondary.box);
    for (let i = 0; i < 4; i++) {
      const chip = makeChip(r, `home-exit-btn-${i}`, "", () =>
        this.exitButton(i),
      );
      this.exitChips.push(chip);
      this.exit.buttons.add(chip.box);
    }
    this.top.add(this.self.box);
    this.top.add(this.exit.box);

    this.bottom = new BoxRenderable(r, {
      id: "home-bottom",
      flexDirection: "row",
      flexGrow: 1,
      paddingX: 1,
      gap: 1,
    });
    this.devices = new ListPanel<Peer>(r, {
      id: "home-devices",
      title: "Devices",
      header: false,
      key: (p) => p.id,
      row: (p, selected, w) => this.deviceRow(p, selected, w),
      onSelect: () => this.render(),
      onActivate: (p) => this.ctx.go("devices", p.id),
      onRightClick: (p) => this.ctx.pinger.ping(p),
      onMiddleClick: (p) => this.ctx.copy(p.ip || p.dnsName),
    });
    this.net = this.panel("net", "Network", DETAILS_WIDTH);
    this.net.buttons.visible = false;
    this.bottom.add(this.devices.panel);
    this.bottom.add(this.net.box);

    parent.add(this.top);
    parent.add(this.bottom);
  }

  dispose(): void {
    this.devices.dispose();
  }

  onShow(): void {
    this.shown = true;
    this.measure();
  }

  /**
   * The first visit with Tailscale running measures the network once (r measures again) and pings
   * the exit node in use, quietly, when it has no latency yet.
   */
  private measure(): void {
    if (!this.shown || this.ctx.state?.backendState !== "Running") return;
    const nc = this.ctx.netcheck;
    if (!this.netAttempted && !nc.report && !nc.running) {
      this.netAttempted = true;
      void nc.run();
    }
    const cur = currentExitNode(this.ctx);
    if (cur && cur.id !== this.pingedExit) {
      this.pingedExit = cur.id;
      if (this.ctx.pinger.get(cur.id) === undefined)
        this.ctx.pinger.ping(cur, { quiet: true });
    }
  }

  onHide(): void {
    this.shown = false;
    this.pingedExit = null;
  }

  typing(): boolean {
    return false;
  }

  reload(): void {
    void this.ctx.netcheck.run();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  layout(W: number, H: number): void {
    this.width = W;
    this.height = H;
    this.narrow = W < NARROW;
    this.net.box.visible = !this.narrow;
    // Too narrow for two panels side by side: the exit node wins.
    this.self.box.visible = W >= 72;
    const topH = H < 24 ? 10 : H < 30 ? 12 : 13;
    this.top.height = topH;
    this.top.visible = H >= 12;
    this.bottom.visible = !this.top.visible || H - topH >= 4;
    const listH = Math.max(0, H - (this.top.visible ? topH : 0) - 2);
    const listW = Math.max(
      20,
      W - 2 - (this.narrow ? 0 : DETAILS_WIDTH + 1) - 3,
    );
    this.devices.sync(listH, listW);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private deviceList(): Peer[] {
    const s = this.ctx.state;
    if (!s) return [];
    return tailnetDevices(s.peers).sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (b.online
          ? 0
          : (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0)) ||
        a.name.localeCompare(b.name),
    );
  }

  render(): void {
    this.measure();
    this.devices.setItems(this.deviceList());
    this.renderSelf();
    this.renderExit();
    this.renderDevices();
    this.renderNet();
  }

  renderBusy(): void {
    this.renderDevicesTitle();
  }

  private topInner(): number {
    // Two panels share the width minus padding (2) and the gap (1); each loses border + padding (4).
    if (!this.self.box.visible) return Math.max(20, this.width - 2 - 4);
    return Math.max(20, Math.floor((this.width - 3) / 2) - 4);
  }

  private renderSelf(): void {
    const s = this.ctx.state;
    const w = this.topInner();
    const L = new Lines(w);
    if (!s) {
      if (this.ctx.error) {
        L.title("Tailscale is not reachable", { fg: theme.red, bold: true });
        for (const part of wrapText(this.ctx.error, w))
          L.line(ch(part, { fg: theme.textDim }));
      } else L.line(ch("Reading Tailscale status…", { fg: theme.textMuted }));
      this.self.text.content = styled(L.out);
      this.setSelfButtons();
      return;
    }
    const me = s.self;
    L.title(me?.name || me?.hostName || "this device");
    L.line(ch(truncate(me?.dnsName || "", w), { fg: theme.textDim }));
    L.optional(4).blank();
    const state = s.backendState;
    if (state === "Running") {
      L.kv(
        "Status",
        ch("◉ ", { fg: theme.green, bold: true }),
        ch("connected", { fg: theme.green, bold: true }),
      );
    } else if (state === "NeedsLogin" || state === "NoState") {
      L.kv(
        "Status",
        ch("✗ ", { fg: theme.red }),
        ch("logged out", { fg: theme.red, bold: true }),
      );
    } else if (state === "NeedsMachineAuth") {
      L.kv(
        "Status",
        ch("○ ", { fg: theme.yellow }),
        ch("waiting for admin approval", { fg: theme.yellow }),
      );
    } else {
      L.kv(
        "Status",
        ch("○ ", { fg: theme.textMuted }),
        ch(state === "Stopped" ? "off" : state, {
          fg: theme.textDim,
          bold: true,
        }),
      );
    }
    if (s.authUrl && state !== "Running") {
      L.kv(
        "Login",
        ch(truncate(s.authUrl, L.valueW), {
          fg: theme.accent,
          underline: true,
        }),
      );
    }
    if (s.user) L.kvText("Account", s.user.login);
    if (me) {
      const v4 = me.ips.find((ip) => ip.includes(".")) ?? me.ips[0];
      const v6 = me.ips.find((ip) => ip.includes(":"));
      if (v4) L.kvText("Address", v4);
      if (v6)
        L.optional(3).kv("", ch(truncate(v6, L.valueW), { fg: theme.textDim }));
    }
    const ver = s.version.split("-")[0] || "?";
    L.optional(s.update ? 0 : 1).kv(
      "Version",
      ch(ver),
      ch(me?.os ? ` · ${osLabel(me.os)}` : "", { fg: theme.textDim }),
      s.update ? ch(`  ${s.update} available`, { fg: theme.yellow }) : ch(""),
    );
    if (me?.keyExpiry) {
      const until = untilLabel(me.keyExpiry);
      const soon = me.keyExpiry.getTime() - Date.now() < 14 * 86_400_000;
      L.optional(soon ? 0 : 2).kv(
        "Key expiry",
        ch(until, { fg: soon ? theme.yellow : theme.textDim }),
      );
    } else if (me && state === "Running")
      L.optional(2).kv("Key expiry", ch("never", { fg: theme.textDim }));
    for (const h of s.health.slice(0, 2)) {
      wrapText(h, L.valueW)
        .slice(0, 2)
        .forEach((part, i) =>
          L.kv(i === 0 ? "Health" : "", ch(part, { fg: theme.yellow })),
        );
    }
    this.self.text.content = styled(L.fit(this.room()));
    this.setSelfButtons();
  }

  /** Text rows in a top panel: its height minus the border, the buttons and the gap above them. */
  private room(): number {
    return Math.max(3, this.top.height - 4);
  }

  /** The primary chip follows the state: Turn off, Turn on, Log in, Open link. */
  private selfMode(): "off" | "on" | "login" | "link" | null {
    const s = this.ctx.state;
    if (!s) return null;
    if (s.backendState === "Running") return "off";
    if (s.authUrl) return "link";
    if (s.backendState === "NeedsLogin" || s.backendState === "NoState")
      return "login";
    return "on";
  }

  private setSelfButtons(): void {
    const mode = this.selfMode();
    this.selfPrimary.box.visible = mode !== null;
    this.selfSecondary.box.visible = mode !== null;
    if (mode === "off") {
      const armed = this.ctx.armed() === "down";
      setChip(
        this.selfPrimary,
        armed ? "Confirm: turn off" : "Turn off",
        armed ? btn.danger : btn.normal,
      );
      setChip(this.selfSecondary, "Copy IP", btn.normal);
    } else if (mode === "on") {
      setChip(this.selfPrimary, "Turn on", btn.primary);
      this.selfSecondary.box.visible = false;
    } else if (mode === "login") {
      setChip(this.selfPrimary, "Log in", btn.primary);
      this.selfSecondary.box.visible = false;
    } else if (mode === "link") {
      setChip(this.selfPrimary, "Open login link", btn.primary);
      setChip(this.selfSecondary, "Copy link", btn.normal);
    }
  }

  private renderExit(): void {
    const s = this.ctx.state;
    const w = this.topInner();
    const L = new Lines(w);
    const chips = this.exitChips;
    for (const c of chips) c.box.visible = false;
    if (!s || s.backendState !== "Running") {
      L.line(
        ch(s ? "Exit nodes are available once Tailscale runs." : "", {
          fg: theme.textMuted,
        }),
      );
      this.exit.text.content = styled(L.out);
      return;
    }
    const cur = currentExitNode(this.ctx);
    const suggested = findNodeByName(s.nodes, this.ctx.suggested);
    const auto = s.autoExitNode === true;
    if (cur) {
      const st = statusLabel(cur);
      L.line(
        statusDot(st),
        ch(" "),
        ch(truncate(cur.name, w - 2), { fg: theme.green, bold: true }),
      );
      const where = [
        locationLong(cur) === "unknown" ? "" : locationLong(cur),
        cur.isMullvad ? "Mullvad" : "your tailnet",
      ]
        .filter(Boolean)
        .join(" · ");
      L.line(ch(truncate(where, w), { fg: theme.textDim }));
      L.optional(4).blank();
      L.kv(
        "Mode",
        auto
          ? ch("★ auto, chosen by Tailscale", { fg: theme.yellow })
          : ch("manual", { fg: theme.text }),
      );
      if (!cur.online || s.exitNode?.online === false)
        L.kv(
          "Status",
          ch("exit node is offline", { fg: theme.yellow, bold: true }),
        );
      L.kvText("Path", pathLabel(cur), { fg: theme.textDim });
      L.optional(2).kv(
        "Traffic",
        ch(`↓ ${humanBytes(cur.rxBytes)}  ↑ ${humanBytes(cur.txBytes)}`),
      );
      const lat = this.ctx.pinger.get(cur.id);
      L.kv(
        "Latency",
        latencyChunk(lat, 0),
        ch(
          this.ctx.pinger.via(cur.id) ? `  ${this.ctx.pinger.via(cur.id)}` : "",
          { fg: theme.textMuted },
        ),
      );
      // The LAN chip shows the same state, so this line goes first when space is short.
      L.optional(3).kv(
        "LAN access",
        s.allowLan
          ? ch("on", { fg: theme.green })
          : ch("off", { fg: theme.textDim }),
      );
      this.showExitChips([
        ["Change", btn.normal],
        ["Disconnect", btn.danger],
        [
          auto ? "★ Auto on" : "★ Auto off",
          auto ? { ...btn.normal, fg: theme.yellow, bold: true } : btn.normal,
        ],
        [
          s.allowLan ? "LAN on" : "LAN off",
          s.allowLan
            ? { ...btn.normal, fg: theme.green, bold: true }
            : btn.normal,
        ],
      ]);
    } else {
      L.line(
        ch("○ ", { fg: theme.textMuted }),
        ch("No exit node", { fg: theme.text, bold: true }),
      );
      L.line(
        ch(truncate("Internet traffic leaves this device directly.", w), {
          fg: theme.textDim,
        }),
      );
      L.optional(4).blank();
      if (suggested)
        L.kv(
          "Suggested",
          ch("★ ", { fg: theme.yellow }),
          ch(truncate(suggested.name, L.valueW - 2), { fg: theme.text }),
        );
      if (suggested && locationLong(suggested) !== "unknown")
        L.optional(2).kv(
          "",
          ch(truncate(locationLong(suggested), L.valueW), {
            fg: theme.textDim,
          }),
        );
      L.optional(1).kv(
        "Available",
        ch(`${s.nodes.filter((n) => n.online).length} online`, {
          fg: theme.text,
        }),
        ch(` of ${s.nodes.length}`, { fg: theme.textDim }),
      );
      this.showExitChips([
        ["Use suggested", suggested ? btn.primary : btn.off],
        ["★ Auto", btn.normal],
        ["Choose", btn.normal],
      ]);
    }
    this.exit.text.content = styled(L.fit(this.room()));
  }

  private showExitChips(defs: [string, Parameters<typeof setChip>[2]][]): void {
    defs.forEach(([label, style], i) => {
      const chip = this.exitChips[i]!;
      chip.box.visible = true;
      setChip(chip, label, style);
    });
  }

  private deviceRow(p: Peer, selected: boolean, w: number): TextChunk[] {
    const st = statusLabel(p);
    const conn = connectionLabel(p);
    const addrW = 15;
    const osW = this.narrow ? 0 : 8;
    const connW = 12;
    const nameW = Math.min(
      28,
      Math.max(10, w - 2 - addrW - osW - connW - (osW ? 4 : 3)),
    );
    const out: TextChunk[] = [
      ch(selected ? "▸" : " ", { fg: theme.accent, bold: true }),
      statusDot(st),
      ch(" "),
      ch(fit(p.name, nameW), {
        fg:
          st === "offline"
            ? theme.textDim
            : st === "expired"
              ? theme.red
              : st === "active"
                ? theme.green
                : theme.text,
        bold: st === "active",
      }),
      ch(" "),
      ch(fit(p.ip, addrW), { fg: theme.textDim }),
    ];
    if (osW)
      out.push(ch(" "), ch(fit(osLabel(p.os), osW), { fg: theme.textDim }));
    out.push(
      ch(" "),
      ch(fit(p.active ? "exit node" : conn, connW), {
        fg: p.active
          ? theme.green
          : conn === "direct"
            ? theme.text
            : p.online
              ? theme.textDim
              : theme.textMuted,
      }),
    );
    return out;
  }

  private renderDevicesTitle(): void {
    const all = this.devices.items;
    const online = all.filter((p) => p.online).length;
    this.devices.setTitle(
      ` Devices · ${online} of ${all.length} online ` + this.ctx.busyTitle(),
    );
  }

  private renderDevices(): void {
    const s = this.ctx.state;
    this.renderDevicesTitle();
    let empty: string | null = null;
    if (!s) empty = this.ctx.error ? "" : "Loading devices…";
    else if (s.backendState !== "Running" && this.devices.items.length === 0)
      empty = "Your devices appear here once Tailscale runs.";
    else if (this.devices.items.length === 0)
      empty =
        "No other devices in this tailnet yet.\n\nInstall Tailscale on another device and log in with the same account.";
    this.devices.setEmpty(empty);
    this.devices.renderRows();
  }

  private renderNet(): void {
    if (!this.net.box.visible) return;
    const nc = this.ctx.netcheck;
    const s = this.ctx.state;
    const L = new Lines(DETAILS_WIDTH - 4);
    this.net.box.title = nc.running ? " Network · measuring… " : " Network ";
    const rep = nc.report;
    if (!rep) {
      if (nc.error) {
        for (const part of wrapText(nc.error, L.width))
          L.line(ch(part, { fg: theme.red }));
      } else if (s?.backendState === "Running")
        L.line(ch("Measuring the network…", { fg: theme.textMuted }));
      else L.line(ch("Measured once Tailscale runs.", { fg: theme.textMuted }));
    } else {
      const yes = (v: boolean | null, good: string, bad: string) =>
        v === null
          ? ch("unknown", { fg: theme.textMuted })
          : v
            ? ch(`✓ ${good}`, { fg: theme.green })
            : ch(`✗ ${bad}`, { fg: theme.red });
      L.kv("UDP", yes(rep.udp, "works", "blocked, relays only"));
      L.kv(
        "NAT",
        rep.mappingVaries === null
          ? ch("unknown", { fg: theme.textMuted })
          : rep.mappingVaries
            ? ch("hard, often relayed", { fg: theme.yellow })
            : ch("easy, direct paths", { fg: theme.green }),
      );
      L.kvText("IPv4", rep.ipv4 ?? "none", {
        fg: rep.ipv4 ? theme.text : theme.textMuted,
      });
      L.kvText("IPv6", rep.ipv6 ?? "none", {
        fg: rep.ipv6 ? theme.textDim : theme.textMuted,
      });
      const near = rep.derps[0];
      if (near)
        L.kv(
          "Nearest",
          ch(near.code, { fg: theme.text, bold: true }),
          ch(` ${near.name} · ${Math.round(near.ms)} ms`, {
            fg: theme.textDim,
          }),
        );
      L.kvText("Port map", rep.portMapping || "none", { fg: theme.textDim });
    }
    if (s?.magicDnsSuffix) {
      L.kv(
        "MagicDNS",
        s.magicDns
          ? ch("on", { fg: theme.green })
          : ch("off", { fg: theme.textDim }),
        ch(` · ${truncate(s.magicDnsSuffix, L.valueW - 6)}`, {
          fg: theme.textMuted,
        }),
      );
    }
    if (rep)
      L.kv(
        "Checked",
        ch(relTime(new Date(rep.at)), { fg: theme.textMuted }),
        ch("  (r)", { fg: theme.textMuted }),
      );
    this.net.text.content = styled(L.out);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private selfAction(): void {
    const mode = this.selfMode();
    const s = this.ctx.state;
    if (mode === "off") void tailscaleDown(this.ctx);
    else if (mode === "on") void tailscaleUp(this.ctx);
    else if (mode === "login") void startLogin(this.ctx);
    else if (mode === "link" && s?.authUrl) openUrl(this.ctx, s.authUrl);
    this.render();
  }

  private selfSecondaryAction(): void {
    const mode = this.selfMode();
    const s = this.ctx.state;
    if (mode === "off") this.copySelfIp();
    else if (mode === "link" && s?.authUrl)
      this.ctx.copy(s.authUrl, "the login link");
  }

  private copySelfIp(): void {
    const ip =
      this.ctx.state?.self?.ips.find((x) => x.includes(".")) ??
      this.ctx.state?.self?.ips[0];
    if (ip) this.ctx.copy(ip);
  }

  private exitButton(i: number): void {
    const cur = currentExitNode(this.ctx);
    if (cur) {
      if (i === 0) this.chooseExitNode();
      else if (i === 1) void disconnectExitNode(this.ctx);
      else if (i === 2) void toggleAutoExitNode(this.ctx);
      else void toggleLanAccess(this.ctx);
    } else {
      if (i === 0) void this.useSuggested();
      else if (i === 1) void toggleAutoExitNode(this.ctx);
      else this.chooseExitNode();
    }
  }

  private chooseExitNode(): void {
    const cur = currentExitNode(this.ctx);
    this.ctx.go("exit", cur?.dnsName);
  }

  private async useSuggested(): Promise<void> {
    const s = this.ctx.state;
    if (!s) return;
    let node = findNodeByName(s.nodes, this.ctx.suggested);
    if (!node) {
      await this.ctx.fetchSuggestion();
      node = findNodeByName(this.ctx.state?.nodes ?? [], this.ctx.suggested);
    }
    if (!node) {
      this.ctx.notify(
        "Tailscale has no exit node suggestion right now",
        "warn",
      );
      return;
    }
    if (node.active) {
      this.ctx.notify(`Already using the suggested node ${node.name}`, "info");
      return;
    }
    await connectExitNode(this.ctx, node);
  }

  onKey(key: KeyEvent): boolean {
    const k = key.name;
    const shift = key.shift;
    if (this.devices.navKey(key)) {
      this.render();
      return true;
    }
    const running = this.ctx.state?.backendState === "Running";
    const sel = this.devices.selected();
    if (k === "return") {
      if (!running) this.selfAction();
      else if (sel) this.ctx.go("devices", sel.id);
    } else if (k === "o") this.selfAction();
    else if (k === "e") this.chooseExitNode();
    else if (k === "d" || k === "x") void disconnectExitNode(this.ctx);
    else if (k === "a" && shift) void this.useSuggested();
    else if (k === "a") void toggleAutoExitNode(this.ctx);
    else if (k === "l") void toggleLanAccess(this.ctx);
    else if (k === "p" && !shift) {
      if (sel) this.ctx.pinger.ping(sel);
    } else if (k === "p" && shift) this.ctx.pinger.pingAll(this.devices.items);
    else if (k === "y" && shift) this.copySelfIp();
    else if (k === "y" || k === "c") {
      if (sel) this.ctx.copy(sel.ip || sel.dnsName);
    } else return false;
    return true;
  }
}
