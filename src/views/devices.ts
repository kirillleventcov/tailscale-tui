// Your tailnet's devices: who is online, how you reach them, and the things you do with a device
// from a terminal: SSH into it, send it a file, ping it, copy its address.
import { basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { BoxRenderable, KeyEvent, TextChunk } from "@opentui/core";
import { connectExitNode } from "../actions";
import { cliError } from "../backend/cli";
import { fit, humanBytes, osLabel, relTime, truncate } from "../format";
import { NAME } from "../meta";
import {
  DEVICE_FILTERS,
  DEVICE_SORTS,
  applyDeviceQuery,
  connectionLabel,
  mayRunSsh,
  statusLabel,
  tailnetDevices,
  type DeviceFilter,
  type DeviceQuery,
  type DeviceSort,
  type Peer,
} from "../model";
import { theme } from "../theme";
import {
  COL_GAP,
  DetailsPanel,
  btn,
  ch,
  columnAt,
  headerChunks,
  makeLabel,
  setChip,
  type Chip,
  type Lines,
  type ListColumn,
} from "../ui";
import { untilLabel } from "./home";
import { latencyChunk, pathLabel, statusChunk, statusDot } from "./exit-nodes";
import { ListView } from "./list-view";

/** A row of the list: a peer, or this device (which is not in the Peer map). */
export interface Device extends Peer {
  self?: boolean;
  endpoints?: string[];
}

type ColId = "mark" | "name" | "address" | "os" | "conn" | "owner" | "latency";

interface Column extends ListColumn {
  id: ColId;
  sort?: DeviceSort;
}

const NAME_MIN = 16;

/** `showOwner` is false when every device has the same owner, as in a personal tailnet. */
export function deviceColumns(total: number, showOwner = true): Column[] {
  const cols: Column[] = [
    { id: "mark", label: "", width: 2, align: "left" },
    {
      id: "name",
      label: "Device",
      width: NAME_MIN,
      align: "left",
      sort: "name",
    },
  ];
  const optional: Column[] = [
    { id: "address", label: "Address", width: 15, align: "left" },
    { id: "conn", label: "Status", width: 12, align: "left", sort: "status" },
    { id: "os", label: "OS", width: 8, align: "left", sort: "os" },
    {
      id: "latency",
      label: "Latency",
      width: 8,
      align: "right",
      sort: "latency",
    },
    { id: "owner", label: "Owner", width: 18, align: "left", sort: "owner" },
  ];
  let used = 2 + COL_GAP + NAME_MIN;
  for (const c of optional) {
    if (c.id === "owner" && !showOwner) continue;
    if (used + COL_GAP + c.width > total) break;
    cols.push(c);
    used += COL_GAP + c.width;
  }
  // The name takes what is left, up to a readable width; the rest stays blank at the right.
  cols[1]!.width = Math.min(32, NAME_MIN + (total - used));
  return cols;
}

function ownerLabel(p: Peer): string {
  if (p.tags.length > 0) return p.tags.join(" ");
  return p.owner ?? "";
}

export class DevicesView extends ListView<Device> {
  readonly id = "devices" as const;
  readonly title = "Devices";
  readonly short = "Devices";

  private q: DeviceQuery = {
    text: "",
    filter: "all",
    sort: "status",
    desc: false,
  };
  private cols: Column[] = deviceColumns(80);
  private readonly sshUser = new Map<string, string>();

  private showLabel!: ReturnType<typeof makeLabel>;
  private sortLabel!: ReturnType<typeof makeLabel>;
  private filterChips: { id: DeviceFilter; chip: Chip }[] = [];
  private sortChip!: Chip;
  private pingAllChip!: Chip;
  private btnMain!: Chip;
  private btnSend!: Chip;
  private btnPing!: Chip;
  private btnCopy!: Chip;

  protected listTitle(): string {
    return "Devices";
  }

  protected helpLines(): [string, string][] {
    return [
      [
        "Device",
        "Enter SSH (ping for phones) · u SSH as another user · t send a file · e use as exit node",
      ],
      ["Measure", "p ping selected · P ping all visible · right-click pings"],
      [
        "Filter, sort",
        "f/F filter · s sort field · S reverse · click column headers",
      ],
      [
        "Clipboard",
        "y or c copy the IP · Y copy the DNS name · middle-click copies the IP",
      ],
      ["Mouse", "click select · double-click SSH · wheel scroll · click chips"],
    ];
  }

  protected override searchPlaceholder(): string {
    return "search name, IP, OS, owner, tag…  (/)";
  }

  protected override haystack(p: Device): string {
    return [
      p.name,
      p.dnsName,
      p.hostName,
      ...p.ips,
      p.os,
      osLabel(p.os),
      p.owner ?? "",
      ...p.tags,
      statusLabel(p),
      p.self ? "this device self" : "",
    ].join(" ");
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  protected override buildToolbar(toolbar: BoxRenderable): void {
    this.showLabel = makeLabel(this.r, "devices-show", "Show");
    toolbar.add(this.showLabel);
    for (const f of DEVICE_FILTERS) {
      const chip = this.chip(`filter-${f.id}`, f.label, () =>
        this.setFilter(f.id),
      );
      this.filterChips.push({ id: f.id, chip });
      toolbar.add(chip.box);
    }
    this.sortLabel = makeLabel(this.r, "devices-sort-label", "Sort");
    toolbar.add(this.sortLabel);
    this.sortChip = this.chip("sort", "", () => this.nextSort());
    toolbar.add(this.sortChip.box);
    this.pingAllChip = this.chip("pingall", "Ping all", () => this.pingAll());
    toolbar.add(this.pingAllChip.box);
  }

  protected override layoutToolbar(W: number): void {
    for (const f of this.filterChips) f.chip.box.visible = W >= 64;
    this.sortChip.box.visible = W >= 80;
    this.pingAllChip.box.visible = W >= 92;
    this.showLabel.visible = W >= 124;
    this.sortLabel.visible = W >= 124;
  }

  protected override buildDetails(d: DetailsPanel): void {
    this.btnMain = d.addButton(
      this.chip("btn-main", "SSH", () =>
        this.withSelected((p) => this.activate(p)),
      ),
    );
    this.btnSend = d.addButton(
      this.chip("btn-send", "Send file", () =>
        this.withSelected((p) => this.sendFile(p)),
      ),
    );
    this.btnPing = d.addButton(
      this.chip("btn-ping", "Ping", () =>
        this.withSelected((p) => this.ping(p)),
      ),
    );
    this.btnCopy = d.addButton(
      this.chip("btn-copy", "Copy IP", () =>
        this.withSelected((p) => this.copyIp(p)),
      ),
    );
  }

  override layout(W: number, H: number): void {
    super.layout(W, H);
    this.cols = deviceColumns(this.list.width, this.showOwner());
  }

  private showOwner(): boolean {
    const peers = this.ctx.state ? tailnetDevices(this.ctx.state.peers) : [];
    return new Set(peers.map(ownerLabel)).size > 1;
  }

  override render(): void {
    const owner = this.showOwner();
    if (owner !== this.cols.some((c) => c.id === "owner"))
      this.cols = deviceColumns(this.list.width, owner);
    super.render();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private selfDevice(): Device | null {
    const s = this.ctx.state;
    const me = s?.self;
    if (!me) return null;
    return {
      id: me.id || "self",
      key: "self",
      name: me.name,
      hostName: me.hostName,
      dnsName: me.dnsName,
      ip: me.ips.find((ip) => ip.includes(".")) ?? me.ips[0] ?? "",
      ips: me.ips,
      os: me.os,
      online: s!.backendState === "Running",
      active: false,
      exitNodeOption: me.exitNodeOption,
      expired: false,
      keyExpiry: me.keyExpiry,
      isMullvad: false,
      tags: [],
      owner: s!.user?.login,
      rxBytes: 0,
      txBytes: 0,
      relay: me.relay,
      inSession: false,
      ssh: false,
      taildrop: false,
      shared: false,
      routes: [],
      created: me.created,
      self: true,
      endpoints: me.endpoints,
    };
  }

  protected allItems(): Device[] {
    const s = this.ctx.state;
    if (!s) return [];
    const devices = applyDeviceQuery(
      tailnetDevices(s.peers),
      { ...this.q, text: "" },
      s.user?.login ?? null,
      (id) => this.ctx.pinger.get(id),
    );
    const me = this.selfDevice();
    const keepSelf =
      me &&
      (this.q.filter === "all" ||
        this.q.filter === "online" ||
        this.q.filter === "mine");
    return keepSelf ? [me, ...devices] : devices;
  }

  protected key(p: Device): string {
    return p.id;
  }

  /** Filters narrow the list; the title counts every device, as the exit-node list does. */
  protected override totalCount(): number {
    const s = this.ctx.state;
    return s ? tailnetDevices(s.peers).length + (s.self ? 1 : 0) : 0;
  }

  onLatency(): void {
    if (this.q.sort === "latency") this.requery(false);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  protected override renderToolbar(): void {
    for (const f of this.filterChips) {
      const def = DEVICE_FILTERS.find((d) => d.id === f.id)!;
      setChip(f.chip, def.label, { active: this.q.filter === f.id });
    }
    const sort = DEVICE_SORTS.find((x) => x.id === this.q.sort)!;
    setChip(this.sortChip, `${sort.label} ${this.q.desc ? "▾" : "▴"}`, {
      fg: theme.accent,
    });
    const pinging = this.ctx.pinger.allRunning;
    setChip(this.pingAllChip, pinging ? "Pinging…" : "Ping all", {
      fg: pinging ? theme.accent : theme.chipFg,
    });
  }

  protected override header(): TextChunk[] {
    return headerChunks(this.cols, this.q.sort, this.q.desc);
  }

  protected override onHeaderClick(x: number): void {
    const c = columnAt(this.cols, x) as Column | undefined;
    if (!c?.sort) return;
    if (this.q.sort === c.sort) this.q.desc = !this.q.desc;
    else this.q = { ...this.q, sort: c.sort, desc: false };
    this.render();
  }

  protected row(p: Device, selected: boolean): TextChunk[] {
    const out: TextChunk[] = [];
    const st = statusLabel(p);
    this.cols.forEach((c, i) => {
      if (i > 0) out.push(ch(" "));
      switch (c.id) {
        case "mark":
          out.push(
            ch(selected ? "▸" : " ", { fg: theme.accent, bold: true }),
            statusDot(st),
          );
          break;
        case "name":
          out.push(
            ch(fit(p.name, c.width), {
              fg: p.self
                ? theme.accent
                : st === "active"
                  ? theme.green
                  : st === "online"
                    ? theme.text
                    : st === "expired"
                      ? theme.red
                      : theme.textDim,
              bold: p.self || st === "active",
            }),
          );
          break;
        case "address":
          out.push(ch(fit(p.ip, c.width), { fg: theme.textDim }));
          break;
        case "conn": {
          const label = p.self
            ? "this device"
            : p.active
              ? "exit node"
              : connectionLabel(p);
          out.push(
            ch(fit(label, c.width), {
              fg: p.self
                ? theme.accent
                : p.active
                  ? theme.green
                  : label === "direct"
                    ? theme.text
                    : p.online
                      ? theme.textDim
                      : st === "expired"
                        ? theme.red
                        : theme.textMuted,
            }),
          );
          break;
        }
        case "os":
          out.push(ch(fit(osLabel(p.os), c.width), { fg: theme.textDim }));
          break;
        case "latency":
          out.push(
            p.self
              ? ch(" ".repeat(c.width))
              : latencyChunk(this.ctx.pinger.get(p.id), c.width),
          );
          break;
        case "owner":
          out.push(ch(fit(ownerLabel(p), c.width), { fg: theme.textMuted }));
          break;
      }
    });
    return out;
  }

  protected override emptyText(shown: number, total: number): string | null {
    const base = super.emptyText(shown, total);
    if (base) return base;
    if (total === 0)
      return "No devices yet.\n\nInstall Tailscale on another device and log in with the same account.";
    if (shown === 0)
      return `No devices with filter ${this.q.filter}.\nf changes the filter.`;
    return null;
  }

  private sshTarget(p: Device): {
    user: string;
    argv: string[];
    label: string;
  } {
    const user = this.sshUser.get(p.id) ?? process.env.USER ?? "root";
    const s = this.ctx.state;
    const host = s?.magicDns && p.dnsName ? p.dnsName : p.ip;
    if (p.ssh) {
      const argv = this.ctx.backend.command(["ssh", `${user}@${p.name}`]);
      return { user, argv, label: `tailscale ssh ${user}@${p.name}` };
    }
    return {
      user,
      argv: ["ssh", `${user}@${host}`],
      label: `ssh ${user}@${host}`,
    };
  }

  protected describe(p: Device | undefined, L: Lines): void {
    if (!p) {
      L.line(
        ch("Select a device to see its details.", { fg: theme.textMuted }),
      );
      return;
    }
    const st = statusLabel(p);
    L.title(p.name);
    L.line(
      ch(truncate(p.dnsName || p.hostName, L.width), { fg: theme.textDim }),
    );
    L.blank();
    if (p.self)
      L.kv(
        "Status",
        statusDot(st),
        ch(" this device", { fg: theme.accent, bold: true }),
      );
    else
      L.kv(
        "Status",
        statusDot(st),
        ch(" "),
        statusChunk(st === "active" ? "online" : st, 0),
        ch(p.online && !p.self ? ` · ${connectionLabel(p)}` : "", {
          fg: theme.textDim,
        }),
      );
    L.kvText("Address", p.ip || "—");
    const v6 = p.ips.find((ip) => ip.includes(":"));
    if (v6) L.kv("", ch(truncate(v6, L.valueW), { fg: theme.textDim }));
    if (p.os) L.kvText("OS", osLabel(p.os));
    if (p.tags.length > 0)
      L.kvText("Tags", p.tags.join(" "), { fg: theme.textDim });
    else if (p.owner) L.kvText("Owner", p.owner);
    if (p.shared)
      L.kv(
        "Shared",
        ch("into this tailnet from another", { fg: theme.purple }),
      );
    if (p.self) {
      p.endpoints
        ?.slice(0, 3)
        .forEach((e, i) =>
          L.kv(
            i === 0 ? "Endpoints" : "",
            ch(truncate(e, L.valueW), { fg: theme.textDim }),
          ),
        );
      if (p.relay)
        L.kv(
          "Home relay",
          ch(p.relay, { bold: true }),
          ch(" (DERP)", { fg: theme.textDim }),
        );
    } else {
      if (p.online) {
        L.kvText("Path", pathLabel(p), { fg: theme.textDim });
        if (p.rxBytes || p.txBytes)
          L.kv(
            "Traffic",
            ch(`↓ ${humanBytes(p.rxBytes)}  ↑ ${humanBytes(p.txBytes)}`),
          );
        if (p.lastHandshake) L.kvText("Handshake", relTime(p.lastHandshake));
      } else
        L.kv(
          "Last seen",
          ch(p.lastSeen ? relTime(p.lastSeen) : "never", { fg: theme.textDim }),
        );
      const lat = this.ctx.pinger.get(p.id);
      const via = this.ctx.pinger.via(p.id);
      L.kv(
        "Latency",
        latencyChunk(lat, 0),
        ch(lat === undefined ? "  (p to ping)" : "", { fg: theme.textMuted }),
      );
      if (lat !== undefined && lat !== "pending" && via)
        L.kv("", ch(truncate(via, L.valueW), { fg: theme.textMuted }));
      if (mayRunSsh(p)) {
        const t = this.sshTarget(p);
        L.kv(
          "SSH",
          ch(p.ssh ? "Tailscale SSH" : "ssh", {
            fg: p.ssh ? theme.green : theme.text,
          }),
          ch(` as ${t.user}`, { fg: theme.textDim }),
          ch(p.online ? "  (Enter)" : "", { fg: theme.textMuted }),
        );
      }
      L.kv(
        "Taildrop",
        p.taildrop
          ? ch("can receive files", { fg: theme.text })
          : ch(p.online ? "not available" : "when online", {
              fg: theme.textMuted,
            }),
        ch(p.taildrop ? "  (t)" : "", { fg: theme.textMuted }),
      );
      if (p.routes.length > 0)
        L.kvText("Routes", p.routes.join(" "), { fg: theme.cyan });
      if (p.exitNodeOption)
        L.kv(
          "Exit node",
          p.active
            ? ch("in use", { fg: theme.green, bold: true })
            : ch("offered", { fg: theme.text }),
          ch(p.active ? "" : "  (e uses it)", { fg: theme.textMuted }),
        );
    }
    if (p.expired)
      L.kv("Key", ch("expired, re-authenticate it", { fg: theme.red }));
    else if (p.keyExpiry)
      L.kv("Key expiry", ch(untilLabel(p.keyExpiry), { fg: theme.textDim }));
    if (p.created && !p.self)
      L.kv(
        "Added",
        ch(p.created.toISOString().slice(0, 10), { fg: theme.textMuted }),
      );
  }

  protected renderButtons(p: Device | undefined): void {
    const chips = [this.btnMain, this.btnSend, this.btnPing, this.btnCopy];
    for (const c of chips) c.box.visible = true;
    if (!p) {
      setChip(this.btnMain, "SSH", btn.off);
      setChip(this.btnSend, "Send file", btn.off);
      setChip(this.btnPing, "Ping", btn.off);
      setChip(this.btnCopy, "Copy IP", btn.off);
      return;
    }
    if (p.self) {
      this.btnMain.box.visible = false;
      this.btnSend.box.visible = false;
      this.btnPing.box.visible = false;
      setChip(this.btnCopy, "Copy IP", btn.normal);
      return;
    }
    const ssh = mayRunSsh(p);
    this.btnMain.box.visible = ssh;
    setChip(this.btnMain, "SSH", p.online ? btn.primary : btn.off);
    setChip(this.btnSend, "Send file", p.taildrop ? btn.normal : btn.off);
    const pending = this.ctx.pinger.get(p.id) === "pending";
    setChip(
      this.btnPing,
      pending ? "Pinging…" : "Ping",
      ssh ? btn.normal : p.online ? btn.primary : btn.normal,
    );
    setChip(this.btnCopy, "Copy IP", btn.normal);
  }

  // -------------------------------------------------------------------------
  // Input and actions
  // -------------------------------------------------------------------------

  protected override onListKey(key: KeyEvent): boolean {
    const k = key.name;
    const shift = key.shift;
    if (k === "p" && shift) this.pingAll();
    else if (k === "p") this.withSelected((p) => this.ping(p));
    else if (k === "t") this.withSelected((p) => this.sendFile(p));
    else if (k === "u") this.withSelected((p) => this.sshAs(p));
    else if (k === "e") this.withSelected((p) => void this.useAsExitNode(p));
    else if (k === "y" && shift)
      this.withSelected((p) => this.ctx.copy(p.dnsName || p.name));
    else if (k === "y" || k === "c") this.withSelected((p) => this.copyIp(p));
    else if (k === "s" && !shift) this.nextSort();
    else if (k === "s" && shift) {
      this.q.desc = !this.q.desc;
      this.render();
    } else if (k === "f" && !shift && !key.ctrl) this.nextFilter(1);
    else if (k === "f" && shift) this.nextFilter(-1);
    else return false;
    return true;
  }

  protected override onRightClick(p: Device): void {
    this.ping(p);
  }

  protected override onMiddleClick(p: Device): void {
    this.copyIp(p);
  }

  private withSelected(fn: (p: Device) => void): void {
    const p = this.selected();
    if (p) fn(p);
  }

  /** Enter: SSH into computers, ping phones. */
  protected activate(p: Device): void {
    if (p.self) {
      this.copyIp(p);
      return;
    }
    if (!mayRunSsh(p)) {
      this.ping(p);
      return;
    }
    void this.ssh(p);
  }

  private async ssh(p: Device): Promise<void> {
    if (!p.online) {
      this.ctx.notify(`${p.name} is offline`, "warn");
      return;
    }
    const t = this.sshTarget(p);
    await this.ctx.runInteractive(
      t.argv,
      `${t.label}   (${NAME} comes back when the session ends)`,
    );
  }

  private sshAs(p: Device): void {
    if (p.self || !mayRunSsh(p)) return;
    const t = this.sshTarget(p);
    this.ctx.prompt({
      title: `SSH to ${p.name}`,
      label: "User name",
      value: t.user,
      confirm: "Connect",
      hint: p.ssh
        ? "Tailscale SSH checks the user against the tailnet policy."
        : `Runs: ssh <user>@${p.dnsName || p.ip}`,
      onSubmit: (v) => {
        if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(v)) return "Not a valid user name";
        this.sshUser.set(p.id, v);
        this.render();
        void this.ssh(p);
      },
    });
  }

  private ping(p: Device): void {
    if (p.self) return;
    this.ctx.pinger.ping(p);
  }

  private pingAll(): void {
    this.ctx.pinger.pingAll(this.list.items.filter((p) => !p.self));
  }

  private copyIp(p: Device): void {
    this.ctx.copy(p.ip || p.dnsName);
  }

  private sendFile(p: Device): void {
    if (p.self) return;
    if (!p.taildrop) {
      this.ctx.notify(
        p.online
          ? `${p.name} cannot receive files with Taildrop`
          : `${p.name} is offline`,
        "warn",
      );
      return;
    }
    this.ctx.prompt({
      title: `Send a file to ${p.name}`,
      label: "File",
      placeholder: "~/path/to/file",
      value: this.lastDir,
      confirm: "Send",
      completePaths: true,
      hint: "Tab completes the path. The file lands in the device's Taildrop inbox.",
      onSubmit: (v) => {
        const path = v.startsWith("~") ? homedir() + v.slice(1) : v;
        if (!path) return "Enter a path";
        if (!existsSync(path)) return "No such file";
        this.lastDir = v.slice(0, v.lastIndexOf("/") + 1);
        void this.ctx.runAction(
          `Sending ${basename(path)} to ${p.name}`,
          async () => {
            const res = await this.ctx.backend.cli(
              ["file", "cp", path, `${p.ip || p.name}:`],
              {
                timeoutMs: 30 * 60_000,
              },
            );
            if (res.code !== 0) throw cliError(res, `send ${basename(path)}`);
          },
          {
            refresh: false,
            onOk: () =>
              this.ctx.notify(`Sent ${basename(path)} to ${p.name}`, "ok"),
          },
        );
      },
    });
  }

  private lastDir = "~/";

  private async useAsExitNode(p: Device): Promise<void> {
    if (!p.exitNodeOption) {
      this.ctx.notify(`${p.name} does not offer an exit node`, "info");
      return;
    }
    if (p.active) {
      this.ctx.notify(`Already using ${p.name} as the exit node`, "info");
      return;
    }
    await connectExitNode(this.ctx, p);
  }

  private setFilter(id: DeviceFilter): void {
    if (this.q.filter === id) return;
    this.q.filter = id;
    this.requery(true);
    this.render();
  }

  private nextFilter(delta: number): void {
    const i = DEVICE_FILTERS.findIndex((f) => f.id === this.q.filter);
    this.setFilter(
      DEVICE_FILTERS[
        (i + delta + DEVICE_FILTERS.length) % DEVICE_FILTERS.length
      ]!.id,
    );
  }

  private nextSort(): void {
    const i = DEVICE_SORTS.findIndex((s) => s.id === this.q.sort);
    this.q = {
      ...this.q,
      sort: DEVICE_SORTS[(i + 1) % DEVICE_SORTS.length]!.id,
      desc: false,
    };
    this.render();
  }
}
