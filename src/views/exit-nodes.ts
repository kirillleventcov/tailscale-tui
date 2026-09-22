// The exit-node screen: search and filters, the node list, a details panel. This is the screen
// tsexit started as; every other view reuses its parts.
import {
  BoxRenderable,
  InputRenderableEvents,
  TextRenderable,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import {
  fit,
  fmtLatency,
  humanBytes,
  osLabel,
  relTime,
  truncate,
} from "../format";
import {
  FILTERS,
  SORTS,
  applyQuery,
  findNodeByName,
  locationLong,
  statusLabel,
  type ExitNode,
  type FilterKind,
  type Latency,
  type NodeStatus,
  type Query,
  type SortKey,
} from "../model";
import { theme } from "../theme";
import {
  COL_GAP,
  DETAILS_INNER,
  DETAILS_WIDTH,
  DetailsPanel,
  LABEL_W,
  ListPanel,
  SearchBox,
  btn,
  ch,
  columnAt,
  headerChunks,
  makeChip,
  makeLabel,
  setChip,
  type Chip,
  type ListColumn,
} from "../ui";
import type { View, ViewContext } from "../view";
import {
  connectExitNode,
  disconnectExitNode,
  toggleAutoExitNode,
  toggleLanAccess,
} from "../actions";

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ColId =
  "mark" | "name" | "status" | "location" | "latency" | "os" | "priority";

interface Column extends ListColumn {
  id: ColId;
  sort?: SortKey;
}

const NAME_MIN = 14;

/**
 * Pick the columns that fit in `total` cells; the name column absorbs the remainder.
 * The OS column is dropped when no node reports one (Tailscale reports no OS for Mullvad nodes).
 */
export function computeColumns(total: number, showOs = true): Column[] {
  const cols: Column[] = [
    { id: "mark", label: "", width: 3, align: "left" },
    { id: "name", label: "Node", width: NAME_MIN, align: "left", sort: "name" },
  ];
  const optional: Column[] = [
    { id: "status", label: "Status", width: 8, align: "left", sort: "status" },
    {
      id: "location",
      label: "Location",
      width: 18,
      align: "left",
      sort: "location",
    },
    {
      id: "latency",
      label: "Latency",
      width: 8,
      align: "right",
      sort: "latency",
    },
    { id: "os", label: "OS", width: 8, align: "left", sort: "os" },
    {
      id: "priority",
      label: "Prio",
      width: 5,
      align: "right",
      sort: "priority",
    },
  ];
  let used = 3 + COL_GAP + NAME_MIN;
  for (const c of optional) {
    if (c.id === "os" && !showOs) continue;
    if (used + COL_GAP + c.width > total) break;
    cols.push(c);
    used += COL_GAP + c.width;
  }
  cols[1]!.width = Math.max(8, NAME_MIN + (total - used));
  return cols;
}

// ---------------------------------------------------------------------------
// Shared status and latency chunks (the devices view and the dashboard use them too)
// ---------------------------------------------------------------------------

export function statusDot(st: NodeStatus): TextChunk {
  switch (st) {
    case "active":
      return ch("◉", { fg: theme.green, bold: true });
    case "online":
      return ch("●", { fg: theme.green });
    case "offline":
      return ch("○", { fg: theme.textMuted });
    case "expired":
      return ch("✗", { fg: theme.red });
  }
}

export function statusChunk(st: NodeStatus, w: number): TextChunk {
  const text = st === "active" ? "ACTIVE" : st;
  const s = w > 0 ? fit(text, w) : text;
  switch (st) {
    case "active":
      return ch(s, { fg: theme.green, bold: true });
    case "online":
      return ch(s, { fg: theme.green });
    case "offline":
      return ch(s, { fg: theme.textMuted });
    case "expired":
      return ch(s, { fg: theme.red });
  }
}

export function latencyChunk(v: Latency | undefined, w: number): TextChunk {
  const text = w > 0 ? fit(fmtLatency(v), w, "right") : fmtLatency(v);
  if (v === undefined) return ch(text, { fg: theme.textMuted });
  if (v === "pending") return ch(text, { fg: theme.accent });
  if (v === null) return ch(text, { fg: theme.red });
  const fg = v < 60 ? theme.green : v < 150 ? theme.yellow : theme.orange;
  return ch(text, { fg });
}

export function pathLabel(n: ExitNode): string {
  if (n.curAddr) return `direct ${n.curAddr}`;
  if (n.peerRelay) return `via peer relay ${n.peerRelay}`;
  if (n.relay) return `relayed via DERP ${n.relay}`;
  return n.active ? "negotiating path…" : "—";
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

type Mode = "list" | "search";

const FORCE_WINDOW_MS = 4000;
const DETAILS_MIN_TOTAL = 100;
const COMPACT_HEIGHT = 21;

export class ExitNodesView implements View {
  readonly id = "exit" as const;
  readonly title = "Exit nodes";
  readonly short = "Exit";

  private ctx!: ViewContext;
  private allNodes: ExitNode[] = [];
  private query: Query = {
    text: "",
    filter: "all",
    sort: "status",
    desc: false,
  };
  private mode: Mode = "list";
  private showOs = true;
  private forceArm: { id: string; until: number } | null = null;
  private detailsWanted: boolean;
  private cols: Column[] = computeColumns(80);
  private width = 120;

  private toolbar!: BoxRenderable;
  private search!: SearchBox;
  private showLabel!: TextRenderable;
  private sortLabel!: TextRenderable;
  private filterChips: { id: FilterKind; chip: Chip }[] = [];
  private sortChip!: Chip;
  private autoChip!: Chip;
  private lanChip!: Chip;
  private pingAllChip!: Chip;
  private list!: ListPanel<ExitNode>;
  private details!: DetailsPanel;
  private btnConnect!: Chip;
  private btnPing!: Chip;
  private btnCopy!: Chip;

  constructor(opts: { showDetails?: boolean } = {}) {
    this.detailsWanted = opts.showDetails ?? true;
  }

  help(): [string, string][] {
    return [
      [
        "Navigate",
        "↑/k ↓/j move · PgUp/PgDn page · Home/g End/G · Tab or / search",
      ],
      [
        "Exit node",
        "Enter connect or disconnect · d/x disconnect · a auto exit node on/off · A use suggested node",
      ],
      [
        "Search",
        "type to filter by name, IP, country, city, OS, owner · !word excludes",
      ],
      [
        "In search",
        "Enter apply and back · Esc clear and back · ↑↓ move selection · Tab back to list",
      ],
      [
        "Filter, sort",
        "f/F filter · s sort field · S reverse · click column headers",
      ],
      [
        "Measure",
        "p ping selected · P ping all visible · right-click pings · Mullvad nodes: ICMP to their relay",
      ],
      ["Options", "l LAN access while connected · i details panel"],
      ["Clipboard", "y or c copy Tailscale IP · middle-click a row copies it"],
      [
        "Mouse",
        "click select · double-click connect · wheel scroll · drag scrollbar · click chips and Ping all",
      ],
    ];
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  build(ctx: ViewContext, parent: BoxRenderable): void {
    this.ctx = ctx;
    const r = ctx.r;

    this.toolbar = new BoxRenderable(r, {
      id: "exit-toolbar",
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      paddingX: 1,
      gap: 1,
    });
    this.search = new SearchBox(
      r,
      "exit",
      "search name, IP, country, city, OS…  (/)",
      () => this.focusSearch(),
    );
    this.showLabel = makeLabel(r, "exit-show", "Show");
    for (const f of FILTERS) {
      const chip = makeChip(r, `filter-${f.id}`, f.label, () =>
        this.setFilter(f.id),
      );
      this.filterChips.push({ id: f.id, chip });
    }
    this.sortLabel = makeLabel(r, "exit-sort-label", "Sort");
    this.sortChip = makeChip(r, "sort", "", (e) =>
      e.modifiers.shift ? this.toggleDesc() : this.nextSort(1),
    );
    this.autoChip = makeChip(r, "auto", "★ Auto", () => void this.toggleAuto());
    this.lanChip = makeChip(r, "lan", "LAN", () => void this.toggleLan());
    this.pingAllChip = makeChip(r, "pingall", "Ping all", () => this.pingAll());

    this.toolbar.add(this.search.box);
    this.toolbar.add(this.showLabel);
    for (const f of this.filterChips) this.toolbar.add(f.chip.box);
    this.toolbar.add(this.sortLabel);
    this.toolbar.add(this.sortChip.box);
    this.toolbar.add(this.autoChip.box);
    this.toolbar.add(this.lanChip.box);
    this.toolbar.add(this.pingAllChip.box);

    const main = new BoxRenderable(r, {
      id: "exit-main",
      flexGrow: 1,
      flexDirection: "row",
      paddingX: 1,
      gap: 1,
    });
    this.list = new ListPanel<ExitNode>(r, {
      id: "exit",
      title: "Exit nodes",
      key: (n) => n.id,
      row: (n, selected) => this.rowChunks(n, selected),
      onHeaderClick: (x) => this.onHeaderClick(x),
      onSelect: () => this.render(),
      onActivate: () => this.activateSelected(),
      onRightClick: (n) => this.ctx.pinger.ping(n),
      onMiddleClick: (n) => this.copyIp(n),
      onRowClick: () => {
        if (this.mode === "search") this.focusList();
      },
      onResize: (w) => {
        this.cols = computeColumns(w, this.showOs);
      },
    });
    this.details = new DetailsPanel(r, "exit");
    this.btnConnect = this.details.addButton(
      makeChip(r, "btn-connect", "Connect", () => this.activateSelected()),
    );
    this.btnPing = this.details.addButton(
      makeChip(r, "btn-ping", "Ping", () => this.pingSelected()),
    );
    this.btnCopy = this.details.addButton(
      makeChip(r, "btn-copy", "Copy IP", () => this.copySelected()),
    );
    main.add(this.list.panel);
    main.add(this.details.box);

    parent.add(this.toolbar);
    parent.add(main);

    this.search.input.on(InputRenderableEvents.INPUT, () => {
      const v = this.search.input.value;
      if (v === this.query.text) return;
      this.query.text = v;
      this.requery(true);
      this.render();
    });
    r.on("focused_renderable", (current) => {
      const searching = current === this.search.input;
      if (searching !== (this.mode === "search")) {
        this.mode = searching ? "search" : "list";
        this.updateFocusVisuals();
      }
    });
  }

  dispose(): void {
    this.list.dispose();
  }

  onShow(select?: string): void {
    this.syncState();
    if (select) {
      const n = findNodeByName(this.allNodes, select);
      if (n) {
        if (!this.list.selectKey(n.id)) {
          // Not in the current filter: show everything so the node can be selected.
          this.query = { ...this.query, text: "", filter: "all" };
          this.search.input.value = "";
          this.requery(false);
          this.list.selectKey(n.id);
        }
      }
    }
    this.updateFocusVisuals();
  }

  onHide(): void {
    if (this.search.input.focused) this.search.input.blur();
    this.mode = "list";
  }

  typing(): boolean {
    return this.mode === "search";
  }

  onLatency(): void {
    if (this.query.sort === "latency") this.requery(false);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  layout(W: number, H: number): void {
    this.width = W;
    const compact = H < COMPACT_HEIGHT;
    const toolbarH = compact ? 1 : 3;
    this.toolbar.height = toolbarH;
    this.search.setCompact(compact);

    const showDetails = this.detailsWanted && W >= DETAILS_MIN_TOTAL;
    this.details.visible = showDetails;
    // Toolbar chips are dropped from the right as the terminal narrows; every one has a key binding.
    for (const f of this.filterChips) f.chip.box.visible = W >= 60;
    this.sortChip.box.visible = W >= 72;
    this.lanChip.box.visible = W >= 82;
    this.pingAllChip.box.visible = W >= 96;
    this.autoChip.box.visible = W >= 108;
    this.showLabel.visible = W >= 132;
    this.sortLabel.visible = W >= 132;

    // The row pool is sized from the same numbers Yoga will produce: content height minus
    // toolbar, list border (2) and column header (1); width minus main padding (2),
    // the details panel with its gap, list border (2) and scrollbar (1).
    const rowsH = Math.max(0, H - toolbarH - 3);
    const rowsW = Math.max(
      20,
      W - 2 - (showDetails ? DETAILS_WIDTH + 1 : 0) - 3,
    );
    if (rowsW !== this.list.width || this.cols.length === 0)
      this.cols = computeColumns(rowsW, this.showOs);
    this.list.sync(rowsH, rowsW);
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /** Pull the shared snapshot into the list; keeps the selection. */
  private syncState(): void {
    const s = this.ctx.state;
    if (!s) return;
    if (s.nodes !== this.allNodes) {
      this.allNodes = s.nodes;
      const showOs = s.nodes.some((n) => n.os !== "");
      if (showOs !== this.showOs) {
        this.showOs = showOs;
        this.cols = computeColumns(this.list.width, showOs);
      }
      this.requery(false);
    }
  }

  /** Re-run filter + sort; keep the selected node when possible. */
  private requery(resetOnMiss: boolean): void {
    const nodes = applyQuery(this.allNodes, this.query, (id) =>
      this.ctx.pinger.get(id),
    );
    this.list.setItems(nodes, resetOnMiss);
  }

  private suggestedNode(): ExitNode | undefined {
    return findNodeByName(this.allNodes, this.ctx.suggested);
  }

  private selected(): ExitNode | undefined {
    return this.list.selected();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    this.syncState();
    this.renderToolbar();
    this.renderList();
    this.renderDetails();
  }

  renderBusy(): void {
    this.renderListTitle();
  }

  private renderToolbar(): void {
    for (const f of this.filterChips) {
      const def = FILTERS.find((d) => d.id === f.id)!;
      setChip(f.chip, def.label, { active: this.query.filter === f.id });
    }
    const sort = SORTS.find((x) => x.id === this.query.sort)!;
    setChip(this.sortChip, `${sort.label} ${this.query.desc ? "▾" : "▴"}`, {
      fg: theme.accent,
    });
    const auto = this.ctx.state?.autoExitNode;
    setChip(
      this.autoChip,
      auto === null || auto === undefined
        ? "★ Auto ?"
        : auto
          ? "★ Auto on"
          : "★ Auto off",
      { fg: auto ? theme.yellow : theme.chipFg, bold: auto === true },
    );
    const lan = this.ctx.state?.allowLan;
    setChip(
      this.lanChip,
      lan === null || lan === undefined ? "LAN ?" : lan ? "LAN on" : "LAN off",
      {
        fg: lan ? theme.green : theme.chipFg,
        bold: lan === true,
      },
    );
    const pinging = this.ctx.pinger.allRunning;
    setChip(this.pingAllChip, pinging ? "Pinging…" : "Ping all", {
      fg: pinging ? theme.accent : theme.chipFg,
    });
  }

  private rowChunks(n: ExitNode, selected: boolean): TextChunk[] {
    const out: TextChunk[] = [];
    const st = statusLabel(n);
    const isSuggested = n.id === this.suggestedNode()?.id;
    const nameFg =
      st === "active"
        ? theme.green
        : st === "online"
          ? theme.text
          : st === "expired"
            ? theme.red
            : theme.textDim;
    this.cols.forEach((c, i) => {
      if (i > 0) out.push(ch(" "));
      switch (c.id) {
        case "mark":
          out.push(ch(selected ? "▸" : " ", { fg: theme.accent, bold: true }));
          out.push(statusDot(st));
          out.push(ch(isSuggested ? "★" : " ", { fg: theme.yellow }));
          break;
        case "name":
          out.push(
            ch(fit(n.name, c.width), { fg: nameFg, bold: st === "active" }),
          );
          break;
        case "status":
          out.push(statusChunk(st, c.width));
          break;
        case "location": {
          const cc = n.countryCode ?? "";
          const city = n.city ?? n.country ?? "";
          if (!cc && !city) {
            out.push(
              ch(fit(n.isMullvad ? "" : "tailnet", c.width), {
                fg: theme.textMuted,
              }),
            );
          } else {
            out.push(ch(fit(cc, 2), { fg: theme.text, bold: true }));
            out.push(ch(" "));
            out.push(ch(fit(city, c.width - 3), { fg: theme.textDim }));
          }
          break;
        }
        case "latency":
          out.push(latencyChunk(this.ctx.pinger.get(n.id), c.width));
          break;
        case "os":
          out.push(ch(fit(osLabel(n.os), c.width), { fg: theme.textDim }));
          break;
        case "priority":
          out.push(
            ch(
              fit(
                n.priority !== undefined ? String(n.priority) : "—",
                c.width,
                "right",
              ),
              {
                fg: theme.textMuted,
              },
            ),
          );
          break;
      }
    });
    return out;
  }

  private renderList(): void {
    this.renderListTitle();
    this.list.setHeader(
      headerChunks(this.cols, this.query.sort, this.query.desc),
    );
    const s = this.ctx.state;
    const total = this.allNodes.length;
    const shown = this.list.items.length;
    let empty: string | null = null;
    if (!s)
      empty = this.ctx.error
        ? `Could not read Tailscale status.\n${this.ctx.error}`
        : "Loading exit nodes…";
    else if (s.backendState !== "Running")
      empty = `Tailscale is ${s.backendState}.\nStart it from the Home view (1) and the list fills in.`;
    else if (total === 0)
      empty =
        "No exit nodes in this tailnet.\n\nAdvertise one with:\ntailscale set --advertise-exit-node\nthen approve it in the admin console.";
    else if (shown === 0)
      empty = `No exit nodes match "${this.query.text}" with filter ${this.query.filter}.\nEsc clears the search, f changes the filter.`;
    this.list.setEmpty(empty);
    this.list.renderRows();
  }

  /** The list title carries the count and, while an action runs, the spinner. */
  private renderListTitle(): void {
    const total = this.allNodes.length;
    const shown = this.list.items.length;
    const title =
      (total === shown
        ? ` Exit nodes · ${total} `
        : ` Exit nodes · ${shown} of ${total} `) + this.ctx.busyTitle();
    this.list.setTitle(title);
  }

  private detailsChunks(n: ExitNode | undefined, innerW: number): TextChunk[] {
    if (!n)
      return [
        ch("Select an exit node to see its details.", { fg: theme.textMuted }),
      ];
    const out: TextChunk[] = [];
    const valW = Math.max(8, innerW - LABEL_W);
    const line = (label: string, ...vals: TextChunk[]) => {
      out.push(
        ch(fit(label, LABEL_W), { fg: theme.textMuted }),
        ...vals,
        ch("\n"),
      );
    };
    const st = statusLabel(n);
    out.push(
      ch(truncate(n.name, innerW), { fg: theme.accent, bold: true }),
      ch("\n"),
    );
    out.push(
      ch(truncate(n.dnsName || n.hostName, innerW), { fg: theme.textDim }),
      ch("\n\n"),
    );
    line(
      "Status",
      statusDot(st),
      ch(" "),
      statusChunk(st, 0),
      ch(n.online && !n.active ? "  (Enter to use)" : "", {
        fg: theme.textMuted,
      }),
    );
    if (n.active && (!n.online || this.ctx.state?.exitNode?.online === false))
      line("", ch("exit node is offline", { fg: theme.yellow, bold: true }));
    line("Address", ch(fit(n.ip || "—", valW), { fg: theme.text }));
    const v6 = n.ips.find((ip) => ip.includes(":"));
    if (v6) line("", ch(fit(v6, valW), { fg: theme.textDim }));
    line("Location", ch(fit(locationLong(n), valW)));
    line(
      "Type",
      ch(n.isMullvad ? "Mullvad exit node" : "Tailnet device", {
        fg: n.isMullvad ? theme.purple : theme.cyan,
      }),
    );
    if (n.active && this.ctx.state?.autoExitNode)
      line("Mode", ch("auto, chosen by Tailscale", { fg: theme.yellow }));
    if (n.os) line("OS", ch(osLabel(n.os)));
    if (n.owner) line("Owner", ch(fit(n.owner, valW)));
    if (n.tags.length > 0)
      line("Tags", ch(fit(n.tags.join(" "), valW), { fg: theme.textDim }));
    if (n.priority !== undefined) line("Priority", ch(String(n.priority)));
    line(
      "Last seen",
      ch(n.online ? "online now" : relTime(n.lastSeen), {
        fg: n.online ? theme.green : theme.textDim,
      }),
    );
    if (n.lastHandshake) line("Handshake", ch(relTime(n.lastHandshake)));
    line("Path", ch(fit(pathLabel(n), valW), { fg: theme.textDim }));
    line(
      "Traffic",
      ch(`↓ ${humanBytes(n.rxBytes)}  ↑ ${humanBytes(n.txBytes)}`),
    );
    const lat = this.ctx.pinger.get(n.id);
    const via = this.ctx.pinger.via(n.id);
    line(
      "Latency",
      latencyChunk(lat, 0),
      ch(lat === undefined ? "  (p to ping)" : "", { fg: theme.textMuted }),
    );
    if (lat !== undefined && lat !== "pending" && via)
      line("", ch(fit(via, valW), { fg: theme.textMuted }));
    if (n.id === this.suggestedNode()?.id)
      line("Suggested", ch("★ Tailscale's pick now (A)", { fg: theme.yellow }));
    if (n.expired)
      line("Key", ch("expired, re-authenticate it", { fg: theme.red }));
    else if (n.keyExpiry)
      line(
        "Key expiry",
        ch(n.keyExpiry.toISOString().slice(0, 10), { fg: theme.textDim }),
      );
    if (this.forceArm?.id === n.id && Date.now() < this.forceArm.until) {
      out.push(
        ch("\n"),
        ch("Offline node. Press Enter again to use it anyway.", {
          fg: theme.yellow,
        }),
      );
    }
    return out;
  }

  private renderDetails(): void {
    if (!this.details.visible) return;
    const n = this.selected();
    this.details.set(this.detailsChunks(n, DETAILS_INNER));
    if (!n) {
      setChip(this.btnConnect, "Connect", btn.off);
      setChip(this.btnPing, "Ping", btn.off);
      setChip(this.btnCopy, "Copy IP", btn.off);
      return;
    }
    if (n.active) setChip(this.btnConnect, "Disconnect", btn.danger);
    else if (!n.online && this.forceArm?.id === n.id)
      setChip(this.btnConnect, "Connect anyway", btn.danger);
    else setChip(this.btnConnect, "Connect", btn.primary);
    setChip(
      this.btnPing,
      this.ctx.pinger.get(n.id) === "pending" ? "Pinging…" : "Ping",
      btn.normal,
    );
    setChip(this.btnCopy, "Copy IP", btn.normal);
  }

  private updateFocusVisuals(): void {
    const searching = this.mode === "search";
    this.search.setFocused(searching);
    this.list.setFocused(!searching);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private focusSearch(): void {
    this.mode = "search";
    this.search.input.focus();
    this.updateFocusVisuals();
  }

  private focusList(): void {
    if (this.search.input.focused) this.search.input.blur();
    this.mode = "list";
    this.updateFocusVisuals();
  }

  private setSearch(text: string): void {
    this.search.input.value = text;
    if (this.query.text !== text) {
      this.query.text = text;
      this.requery(true);
      this.render();
    }
  }

  onKey(key: KeyEvent): boolean {
    return this.mode === "search" ? this.onSearchKey(key) : this.onListKey(key);
  }

  private onSearchKey(key: KeyEvent): boolean {
    switch (key.name) {
      case "escape":
        key.preventDefault();
        this.setSearch("");
        this.focusList();
        return true;
      case "return":
      case "tab":
        key.preventDefault();
        this.focusList();
        return true;
      case "up":
      case "down":
      case "pageup":
      case "pagedown": {
        key.preventDefault();
        const page = this.list.pageSize();
        this.list.move(
          key.name === "up"
            ? -1
            : key.name === "down"
              ? 1
              : key.name === "pageup"
                ? -page
                : page,
        );
        this.render();
        return true;
      }
      default:
        return false;
    }
  }

  private onListKey(key: KeyEvent): boolean {
    const k = key.name;
    const shift = key.shift;
    const ctrl = key.ctrl;
    if (this.list.navKey(key)) {
      this.render();
      return true;
    }
    if (k === "return") this.activateSelected();
    else if (k === "d" || k === "x" || k === "backspace" || k === "delete")
      void this.disconnect();
    else if (k === "p" && !shift) this.pingSelected();
    else if (k === "p" && shift) this.pingAll();
    else if (k === "a" && shift) void this.connectSuggested();
    else if (k === "a") void this.toggleAuto();
    else if (k === "l") void this.toggleLan();
    else if (k === "s" && !shift) this.nextSort(1);
    else if (k === "s" && shift) this.toggleDesc();
    else if (k === "f" && !shift && !ctrl) this.nextFilter(1);
    else if (k === "f" && shift) this.nextFilter(-1);
    else if (k === "/" || k === "tab" || (ctrl && k === "f")) {
      key.preventDefault();
      this.focusSearch();
    } else if (k === "y" || k === "c") this.copySelected();
    else if (k === "i") this.toggleDetails();
    else if (k === "escape" && this.query.text) this.setSearch("");
    else return false;
    return true;
  }

  private onHeaderClick(x: number): void {
    const c = columnAt(this.cols, x) as Column | undefined;
    if (!c?.sort) return;
    if (this.query.sort === c.sort) this.query.desc = !this.query.desc;
    else {
      this.query.sort = c.sort;
      this.query.desc = false;
    }
    this.requery(false);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private activateSelected(): void {
    const n = this.selected();
    if (!n) {
      this.ctx.notify("Nothing selected", "info");
      return;
    }
    if (n.active) {
      void this.disconnect();
      return;
    }
    void this.connect(n);
  }

  private async connect(n: ExitNode): Promise<void> {
    if (n.expired) {
      this.ctx.notify(
        `${n.name} has an expired key and cannot be used`,
        "warn",
      );
      return;
    }
    if (!n.online) {
      const armed =
        this.forceArm !== null &&
        this.forceArm.id === n.id &&
        Date.now() < this.forceArm.until;
      if (!armed) {
        this.forceArm = { id: n.id, until: Date.now() + FORCE_WINDOW_MS };
        this.ctx.notify(
          `${n.name} is offline. Press Enter again within 4s to use it anyway.`,
          "warn",
          FORCE_WINDOW_MS,
        );
        this.renderDetails();
        return;
      }
    }
    this.forceArm = null;
    await connectExitNode(this.ctx, n);
  }

  private async disconnect(): Promise<void> {
    await disconnectExitNode(this.ctx);
  }

  private async toggleAuto(): Promise<void> {
    await toggleAutoExitNode(this.ctx);
  }

  private async connectSuggested(): Promise<void> {
    let node = this.suggestedNode();
    if (!node) {
      const ok = await this.ctx.runAction(
        "Asking Tailscale for a suggestion",
        () => this.ctx.fetchSuggestion(),
        { refresh: false },
      );
      if (!ok) return;
      node = this.suggestedNode();
    }
    if (!node) {
      this.ctx.notify(
        "Tailscale has no exit node suggestion right now",
        "warn",
      );
      return;
    }
    if (!this.list.selectKey(node.id)) this.onShow(node.dnsName);
    this.render();
    if (node.active) {
      this.ctx.notify(`Already using the suggested node ${node.name}`, "info");
      return;
    }
    await this.connect(node);
  }

  private async toggleLan(): Promise<void> {
    await toggleLanAccess(this.ctx);
  }

  private pingSelected(): void {
    const n = this.selected();
    if (n) this.ctx.pinger.ping(n);
  }

  private pingAll(): void {
    this.ctx.pinger.pingAll(this.list.items);
  }

  private copySelected(): void {
    const n = this.selected();
    if (n) this.copyIp(n);
  }

  private copyIp(n: ExitNode): void {
    this.ctx.copy(n.ip || n.dnsName);
  }

  private setFilter(id: FilterKind): void {
    if (this.query.filter === id) return;
    this.query.filter = id;
    this.requery(true);
    this.render();
  }

  private nextFilter(delta: number): void {
    const i = FILTERS.findIndex((f) => f.id === this.query.filter);
    const next = FILTERS[(i + delta + FILTERS.length) % FILTERS.length]!;
    this.setFilter(next.id);
  }

  private nextSort(delta: number): void {
    const i = SORTS.findIndex((s) => s.id === this.query.sort);
    this.query.sort = SORTS[(i + delta + SORTS.length) % SORTS.length]!.id;
    this.query.desc = false;
    this.requery(false);
    this.render();
  }

  private toggleDesc(): void {
    this.query.desc = !this.query.desc;
    this.requery(false);
    this.render();
  }

  private toggleDetails(): void {
    this.detailsWanted = !this.detailsWanted;
    if (this.detailsWanted && this.width < DETAILS_MIN_TOTAL) {
      this.ctx.notify(
        `Details need at least ${DETAILS_MIN_TOTAL} columns (terminal is ${this.width})`,
        "warn",
      );
    }
    this.layout(this.width, this.lastHeight());
    this.render();
  }

  private lastHeight(): number {
    return this.ctx.r.height - 1;
  }
}
