import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBarRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  parseColor,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type MousePointerStyle,
  type RGBA,
  type TextChunk,
} from "@opentui/core"
import { BackendError, type Backend } from "./backend/types"
import { errorMessage, fit, fmtLatency, humanBytes, osLabel, relTime, truncate, width, wrapText } from "./format"
import {
  FILTERS,
  SORTS,
  applyQuery,
  findNodeByName,
  locationLabel,
  locationLong,
  statusLabel,
  type ExitNode,
  type FilterKind,
  type Latency,
  type NodeStatus,
  type Query,
  type SortKey,
  type TailscaleState,
} from "./model"
import { theme } from "./theme"

// ---------------------------------------------------------------------------
// Styled text helpers
// ---------------------------------------------------------------------------

interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

const colorCache = new Map<string, RGBA>()

function color(hex: string): RGBA {
  let c = colorCache.get(hex)
  if (!c) {
    c = parseColor(hex)
    colorCache.set(hex, c)
  }
  return c
}

function ch(text: string, style: Style = {}): TextChunk {
  let attributes = 0
  if (style.bold) attributes |= TextAttributes.BOLD
  if (style.dim) attributes |= TextAttributes.DIM
  if (style.italic) attributes |= TextAttributes.ITALIC
  if (style.underline) attributes |= TextAttributes.UNDERLINE
  return {
    __isChunk: true,
    text,
    fg: style.fg ? color(style.fg) : undefined,
    bg: style.bg ? color(style.bg) : undefined,
    attributes,
  }
}

function styled(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks)
}

function chunksWidth(chunks: TextChunk[]): number {
  let w = 0
  for (const c of chunks) w += width(c.text)
  return w
}

/** Trim a single-line chunk list so it never exceeds `max` cells. */
function trimChunks(chunks: TextChunk[], max: number): TextChunk[] {
  const out: TextChunk[] = []
  let w = 0
  for (const c of chunks) {
    const cw = width(c.text)
    if (w + cw <= max) {
      out.push(c)
      w += cw
      continue
    }
    const room = max - w
    if (room > 0) out.push({ ...c, text: truncate(c.text, room) })
    break
  }
  return out
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ColId = "mark" | "name" | "status" | "location" | "latency" | "os" | "priority"

interface Column {
  id: ColId
  label: string
  width: number
  align: "left" | "right"
  sort?: SortKey
}

const COL_GAP = 1
const NAME_MIN = 14

/** Pick the columns that fit in `total` cells; the name column absorbs the remainder. */
export function computeColumns(total: number): Column[] {
  const cols: Column[] = [
    { id: "mark", label: "", width: 3, align: "left" },
    { id: "name", label: "Node", width: NAME_MIN, align: "left", sort: "name" },
  ]
  const optional: Column[] = [
    { id: "status", label: "Status", width: 8, align: "left", sort: "status" },
    { id: "location", label: "Location", width: 18, align: "left", sort: "location" },
    { id: "latency", label: "Latency", width: 8, align: "right", sort: "latency" },
    { id: "os", label: "OS", width: 8, align: "left", sort: "os" },
    { id: "priority", label: "Prio", width: 5, align: "right", sort: "priority" },
  ]
  let used = 3 + COL_GAP + NAME_MIN
  for (const c of optional) {
    if (used + COL_GAP + c.width > total) break
    cols.push(c)
    used += COL_GAP + c.width
  }
  cols[1]!.width = Math.max(8, NAME_MIN + (total - used))
  return cols
}

function statusDot(st: NodeStatus): TextChunk {
  switch (st) {
    case "active":
      return ch("◉", { fg: theme.green, bold: true })
    case "online":
      return ch("●", { fg: theme.green })
    case "offline":
      return ch("○", { fg: theme.textMuted })
    case "expired":
      return ch("✗", { fg: theme.red })
  }
}

function statusChunk(st: NodeStatus, w: number): TextChunk {
  const text = st === "active" ? "ACTIVE" : st
  const s = w > 0 ? fit(text, w) : text
  switch (st) {
    case "active":
      return ch(s, { fg: theme.green, bold: true })
    case "online":
      return ch(s, { fg: theme.green })
    case "offline":
      return ch(s, { fg: theme.textMuted })
    case "expired":
      return ch(s, { fg: theme.red })
  }
}

function latencyChunk(v: Latency | undefined, w: number): TextChunk {
  const text = w > 0 ? fit(fmtLatency(v), w, "right") : fmtLatency(v)
  if (v === undefined) return ch(text, { fg: theme.textMuted })
  if (v === "pending") return ch(text, { fg: theme.accent })
  if (v === null) return ch(text, { fg: theme.red })
  const fg = v < 60 ? theme.green : v < 150 ? theme.yellow : theme.orange
  return ch(text, { fg })
}

function pathLabel(n: ExitNode): string {
  if (n.curAddr) return `direct ${n.curAddr}`
  if (n.relay) return `relayed via DERP ${n.relay}`
  return n.active ? "negotiating path…" : "—"
}

function errText(e: unknown): string {
  if (e instanceof BackendError && e.hint) return `${e.message}. ${e.hint}`
  return errorMessage(e)
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface AppOptions {
  backend: Backend
  /** Auto-refresh interval; 0 disables timers (used by tests). */
  refreshMs?: number
  showDetails?: boolean
  version?: string
}

type Mode = "list" | "search"
type ToastKind = "info" | "ok" | "warn" | "error"

interface Chip {
  box: BoxRenderable
  text: TextRenderable
}

interface Row {
  box: BoxRenderable
  text: TextRenderable
}

const DOUBLE_CLICK_MS = 400
const FORCE_WINDOW_MS = 4000
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const DETAILS_WIDTH = 46
const DETAILS_MIN_TOTAL = 100
const COMPACT_HEIGHT = 22

const HELP_LINES: [string, string][] = [
  ["Navigate", "↑/k ↓/j move · PgUp/PgDn page · Home/g End/G · Tab or / search"],
  ["Exit node", "Enter connect or disconnect · d/x disconnect · a use suggested node"],
  ["Search", "type to filter by name, IP, country, city, OS, owner · !word excludes"],
  ["Filter, sort", "f/F filter · 1-4 pick filter · s sort field · S reverse · click column headers"],
  ["Measure", "p ping selected · P ping all visible · right-click a row pings it"],
  ["Options", "l LAN access while connected · i details panel · r/F5 refresh"],
  ["Clipboard", "y or c copy Tailscale IP · middle-click a row copies it"],
  ["Mouse", "click select · double-click connect · wheel scroll · drag scrollbar · click chips"],
  ["General", "? or F1 this help · Esc clear/close · q quit"],
]

export class App {
  readonly done: Promise<void>
  private resolveDone!: () => void

  private readonly r: CliRenderer
  private readonly backend: Backend
  private readonly refreshMs: number
  private readonly version: string

  // ---- state
  private state: TailscaleState | null = null
  private allNodes: ExitNode[] = []
  private nodes: ExitNode[] = []
  private query: Query = { text: "", filter: "all", sort: "status", desc: false }
  private selectedId: string | null = null
  private sel = -1
  private top = 0
  private hover = -1
  private mode: Mode = "list"
  private helpOpen = false
  private busy: string | null = null
  private spin = 0
  private readonly latency = new Map<string, Latency>()
  private suggestedName: string | null = null
  private forceArm: { id: string; until: number } | null = null
  private lastRefresh = 0
  private lastError: string | null = null
  private toast: { text: string; kind: ToastKind } | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private detailsWanted: boolean
  private lastClick = { index: -1, at: 0 }
  private refreshing = false
  private stopped = false
  private pointerStyle: MousePointerStyle = "default"
  private readonly intervals: ReturnType<typeof setInterval>[] = []
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>()
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private cols: Column[] = computeColumns(80)
  private colsWidth = 80
  private rows: Row[] = []
  private helpHeight = 15

  // ---- renderables
  private root!: BoxRenderable
  private header!: BoxRenderable
  private h1!: TextRenderable
  private h2!: TextRenderable
  private toolbar!: BoxRenderable
  private searchBox!: BoxRenderable
  private searchIcon!: TextRenderable
  private search!: InputRenderable
  private showLabel!: TextRenderable
  private sortLabel!: TextRenderable
  private filterChips: { id: FilterKind; chip: Chip }[] = []
  private sortChip!: Chip
  private autoChip!: Chip
  private lanChip!: Chip
  private helpChip!: Chip
  private main!: BoxRenderable
  private listPanel!: BoxRenderable
  private colHeaderBox!: BoxRenderable
  private colHeader!: TextRenderable
  private rowsArea!: BoxRenderable
  private rowsBox!: BoxRenderable
  private emptyBox!: BoxRenderable
  private emptyText!: TextRenderable
  private scrollbar!: ScrollBarRenderable
  private details!: BoxRenderable
  private detailsText!: TextRenderable
  private buttonRow!: BoxRenderable
  private btnConnect!: Chip
  private btnPing!: Chip
  private btnCopy!: Chip
  private footer!: BoxRenderable
  private footerText!: TextRenderable
  private toastBox!: BoxRenderable
  private toastText!: TextRenderable
  private scrim!: BoxRenderable
  private helpBox!: BoxRenderable
  private helpText!: TextRenderable

  constructor(renderer: CliRenderer, opts: AppOptions) {
    this.r = renderer
    this.backend = opts.backend
    this.refreshMs = opts.refreshMs ?? 5000
    this.version = opts.version ?? "dev"
    this.detailsWanted = opts.showDetails ?? true
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve
    })
    this.build()
    this.bind()
    this.layout()
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      this.r.setTerminalTitle("tsexit")
    } catch {
      // not supported by every output
    }
    await this.refresh()
    void this.fetchSuggestion()
    if (this.refreshMs > 0) {
      this.intervals.push(setInterval(() => void this.refresh(), this.refreshMs))
      this.intervals.push(setInterval(() => void this.fetchSuggestion(), Math.max(60_000, this.refreshMs * 6)))
      this.intervals.push(setInterval(() => this.renderHeader(), 1000))
    }
  }

  /** Stop timers and listeners; does not destroy the renderer (the owner does that). */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.intervals) clearInterval(t)
    this.intervals.length = 0
    for (const t of this.timeouts) clearTimeout(t)
    this.timeouts.clear()
    if (this.spinnerTimer) clearInterval(this.spinnerTimer)
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.r.keyInput.off("keypress", this.onKey)
    this.resolveDone()
  }

  quit(): void {
    this.stop()
  }

  // -------------------------------------------------------------------------
  // Building the tree
  // -------------------------------------------------------------------------

  private makeChip(id: string, label: string, onClick: (e: MouseEvent) => void): Chip {
    const box = new BoxRenderable(this.r, {
      id,
      height: 1,
      paddingX: 1,
      flexShrink: 0,
      backgroundColor: theme.chipBg,
      onMouseDown: (e) => {
        if (e.button === 0) onClick(e)
      },
      onMouseOver: () => this.pointer("pointer"),
      onMouseOut: () => this.pointer("default"),
    })
    const text = new TextRenderable(this.r, {
      content: label,
      fg: theme.chipFg,
      height: 1,
      wrapMode: "none",
      selectable: false,
    })
    box.add(text)
    return { box, text }
  }

  private setChip(chip: Chip, label: string, opts: { active?: boolean; bg?: string; fg?: string; bold?: boolean } = {}): void {
    const bg = opts.bg ?? (opts.active ? theme.chipActiveBg : theme.chipBg)
    const fg = opts.fg ?? (opts.active ? theme.chipActiveFg : theme.chipFg)
    chip.box.backgroundColor = bg
    chip.text.content = styled([ch(label, { fg, bold: opts.bold ?? opts.active })])
  }

  private build(): void {
    const r = this.r

    this.root = new BoxRenderable(r, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
    })

    // ---- header
    this.header = new BoxRenderable(r, {
      id: "header",
      height: 2,
      paddingX: 1,
      flexDirection: "column",
      backgroundColor: theme.panel,
    })
    this.h1 = new TextRenderable(r, { id: "h1", content: "", height: 1, wrapMode: "none", fg: theme.text, selectable: false })
    this.h2 = new TextRenderable(r, { id: "h2", content: "", height: 1, wrapMode: "none", fg: theme.textDim, selectable: false })
    this.header.add(this.h1)
    this.header.add(this.h2)

    // ---- toolbar
    this.toolbar = new BoxRenderable(r, {
      id: "toolbar",
      height: 3,
      flexDirection: "row",
      alignItems: "center",
      paddingX: 1,
      gap: 1,
    })
    this.searchBox = new BoxRenderable(r, {
      id: "searchbox",
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 18,
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      flexDirection: "row",
      paddingX: 1,
      onMouseDown: () => this.focusSearch(),
      onMouseOver: () => this.pointer("text"),
      onMouseOut: () => this.pointer("default"),
    })
    this.searchIcon = new TextRenderable(r, { content: "⌕ ", fg: theme.textDim, width: 2, height: 1, selectable: false })
    this.search = new InputRenderable(r, {
      id: "search",
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 8,
      placeholder: "search name, IP, country, city, OS…  (/)",
      placeholderColor: theme.textMuted,
      textColor: theme.text,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      cursorColor: theme.accent,
    })
    this.searchBox.add(this.searchIcon)
    this.searchBox.add(this.search)

    this.showLabel = new TextRenderable(r, { content: "Show", fg: theme.textMuted, height: 1, selectable: false })
    for (const f of FILTERS) {
      const chip = this.makeChip(`filter-${f.id}`, f.label, () => this.setFilter(f.id))
      this.filterChips.push({ id: f.id, chip })
    }
    this.sortLabel = new TextRenderable(r, { content: "Sort", fg: theme.textMuted, height: 1, selectable: false })
    this.sortChip = this.makeChip("sort", "", (e) => (e.modifiers.shift ? this.toggleDesc() : this.nextSort(1)))
    this.autoChip = this.makeChip("auto", "★ Auto", () => void this.connectSuggested())
    this.lanChip = this.makeChip("lan", "LAN", () => void this.toggleLan())
    this.helpChip = this.makeChip("help", "?", () => this.toggleHelp())

    this.toolbar.add(this.searchBox)
    this.toolbar.add(this.showLabel)
    for (const f of this.filterChips) this.toolbar.add(f.chip.box)
    this.toolbar.add(this.sortLabel)
    this.toolbar.add(this.sortChip.box)
    this.toolbar.add(this.autoChip.box)
    this.toolbar.add(this.lanChip.box)
    this.toolbar.add(this.helpChip.box)

    // ---- main: list + details
    this.main = new BoxRenderable(r, { id: "main", flexGrow: 1, flexDirection: "row", paddingX: 1, gap: 1 })

    this.listPanel = new BoxRenderable(r, {
      id: "list",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 30,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderFocus,
      title: " Exit nodes ",
      titleColor: theme.accent,
      flexDirection: "column",
      overflow: "hidden",
    })
    this.colHeaderBox = new BoxRenderable(r, {
      id: "colheader",
      height: 1,
      flexDirection: "row",
      backgroundColor: theme.panel,
      onMouseDown: (e) => this.onHeaderClick(e),
      onMouseOver: () => this.pointer("pointer"),
      onMouseOut: () => this.pointer("default"),
    })
    this.colHeader = new TextRenderable(r, { content: "", height: 1, flexGrow: 1, wrapMode: "none", fg: theme.textDim, selectable: false })
    this.colHeaderBox.add(this.colHeader)

    this.rowsArea = new BoxRenderable(r, {
      id: "rowsarea",
      flexGrow: 1,
      flexDirection: "row",
      onMouseScroll: (e) => {
        if (!e.scroll) return
        if (e.scroll.direction === "up") this.scrollBy(-3)
        else if (e.scroll.direction === "down") this.scrollBy(3)
      },
    })
    this.rowsBox = new BoxRenderable(r, {
      id: "rows",
      flexGrow: 1,
      flexDirection: "column",
      overflow: "hidden",
      onSizeChange: () => this.onRowsResize(),
    })
    this.emptyBox = new BoxRenderable(r, {
      id: "empty",
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingX: 2,
      visible: false,
    })
    this.emptyText = new TextRenderable(r, { content: "", fg: theme.textDim, wrapMode: "word", selectable: false })
    this.emptyBox.add(this.emptyText)
    this.scrollbar = new ScrollBarRenderable(r, {
      id: "scrollbar",
      orientation: "vertical",
      width: 1,
      flexShrink: 0,
      showArrows: false,
      trackOptions: { backgroundColor: theme.panel, foregroundColor: theme.border },
      onChange: (pos) => {
        this.top = Math.round(pos)
        this.renderRows()
      },
    })
    this.rowsArea.add(this.rowsBox)
    this.rowsArea.add(this.emptyBox)
    this.rowsArea.add(this.scrollbar)
    this.listPanel.add(this.colHeaderBox)
    this.listPanel.add(this.rowsArea)

    this.details = new BoxRenderable(r, {
      id: "details",
      width: DETAILS_WIDTH,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title: " Details ",
      titleColor: theme.textDim,
      flexDirection: "column",
      paddingX: 1,
      overflow: "hidden",
    })
    this.detailsText = new TextRenderable(r, { content: "", flexGrow: 1, wrapMode: "none", fg: theme.text })
    this.buttonRow = new BoxRenderable(r, { id: "buttons", height: 1, flexDirection: "row", gap: 1, flexShrink: 0 })
    this.btnConnect = this.makeChip("btn-connect", "Connect", () => this.activateSelected())
    this.btnPing = this.makeChip("btn-ping", "Ping", () => this.pingSelected())
    this.btnCopy = this.makeChip("btn-copy", "Copy IP", () => this.copySelected())
    this.buttonRow.add(this.btnConnect.box)
    this.buttonRow.add(this.btnPing.box)
    this.buttonRow.add(this.btnCopy.box)
    this.details.add(this.detailsText)
    this.details.add(this.buttonRow)

    this.main.add(this.listPanel)
    this.main.add(this.details)

    // ---- footer
    this.footer = new BoxRenderable(r, { id: "footer", height: 1, paddingX: 1, flexShrink: 0 })
    this.footerText = new TextRenderable(r, { content: "", height: 1, wrapMode: "none", fg: theme.textDim, selectable: false })
    this.footer.add(this.footerText)

    // ---- toast (absolute, bottom right)
    this.toastBox = new BoxRenderable(r, {
      id: "toast",
      position: "absolute",
      right: 1,
      bottom: 0,
      zIndex: 50,
      height: 1,
      paddingX: 1,
      visible: false,
      backgroundColor: theme.toastInfoBg,
      onMouseDown: () => this.hideToast(),
    })
    this.toastText = new TextRenderable(r, { content: "", height: 1, wrapMode: "none", fg: theme.text, selectable: false })
    this.toastBox.add(this.toastText)

    // ---- help overlay
    this.scrim = new BoxRenderable(r, {
      id: "scrim",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 99,
      visible: false,
      backgroundColor: theme.scrim,
      onMouseDown: () => this.toggleHelp(false),
    })
    this.helpBox = new BoxRenderable(r, {
      id: "helpbox",
      position: "absolute",
      zIndex: 100,
      visible: false,
      width: 76,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: " Keyboard and mouse ",
      titleColor: theme.accent,
      backgroundColor: theme.panel,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      onMouseDown: (e) => e.stopPropagation(),
    })
    this.helpText = new TextRenderable(r, { content: "", wrapMode: "none", fg: theme.text })
    this.helpBox.add(this.helpText)

    this.root.add(this.header)
    this.root.add(this.toolbar)
    this.root.add(this.main)
    this.root.add(this.footer)
    this.root.add(this.toastBox)
    this.root.add(this.scrim)
    this.root.add(this.helpBox)
    r.root.add(this.root)
  }

  private bind(): void {
    this.r.keyInput.on("keypress", this.onKey)
    this.r.on("resize", () => this.layout())
    this.r.on("focused_renderable", (current) => {
      const searching = current === this.search
      if (searching !== (this.mode === "search")) {
        this.mode = searching ? "search" : "list"
        this.updateFocusVisuals()
        this.renderFooter()
      }
    })
    this.r.once("destroy", () => this.stop())
    this.search.on(InputRenderableEvents.INPUT, () => {
      const v = this.search.value
      if (v === this.query.text) return
      this.query.text = v
      this.requery(true)
      this.render()
    })
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private layout(): void {
    const W = this.r.width
    const H = this.r.height
    const compact = H < COMPACT_HEIGHT
    const headerH = compact ? 1 : 2
    const toolbarH = compact ? 1 : 3

    this.header.height = headerH
    this.h2.visible = !compact
    this.toolbar.height = toolbarH
    this.searchBox.height = toolbarH
    this.searchBox.border = !compact
    this.searchBox.paddingX = compact ? 0 : 1

    const showDetails = this.detailsWanted && W >= DETAILS_MIN_TOTAL
    this.details.visible = showDetails
    // Toolbar chips are dropped from the right as the terminal narrows; every one has a key binding.
    for (const f of this.filterChips) f.chip.box.visible = W >= 60
    this.sortChip.box.visible = W >= 72
    this.helpChip.box.visible = W >= 76
    this.lanChip.box.visible = W >= 86
    this.autoChip.box.visible = W >= 112
    this.showLabel.visible = W >= 124
    this.sortLabel.visible = W >= 124

    // The row pool is sized from the same numbers Yoga will produce: total height minus
    // header, toolbar, footer, list border (2) and column header (1); width minus main
    // padding (2), the details panel with its gap, list border (2) and scrollbar (1).
    const rowsH = Math.max(0, H - headerH - toolbarH - 1 - 3)
    const rowsW = Math.max(20, W - 2 - (showDetails ? DETAILS_WIDTH + 1 : 0) - 3)
    this.syncRows(rowsH, rowsW)

    this.helpBox.width = Math.max(30, Math.min(76, W - 4))
    if (this.helpOpen) this.renderHelp()
    this.centerHelp()
    this.render()
  }

  private centerHelp(): void {
    if (this.stopped) return
    const W = this.r.width
    const H = this.r.height
    const w = Math.max(30, Math.min(76, W - 4))
    const h = this.helpHeight
    this.helpBox.left = Math.max(0, Math.floor((W - w) / 2))
    this.helpBox.top = Math.max(0, Math.floor((H - h) / 2))
  }

  private syncRows(h: number, w: number): void {
    if (w !== this.colsWidth) {
      this.colsWidth = w
      this.cols = computeColumns(w)
    }
    this.ensureRows(h)
    this.ensureVisible()
  }

  /** Safety net: if Yoga disagrees with the arithmetic in layout(), resize the pool afterwards. */
  private onRowsResize(): void {
    // Layout callbacks run inside the render pass; never mutate the tree synchronously here.
    const t = setTimeout(() => {
      this.timeouts.delete(t)
      if (this.stopped) return
      const h = Math.max(0, this.rowsBox.height)
      const w = Math.max(20, this.rowsBox.width)
      if (h === this.rows.length && w === this.colsWidth) return
      this.syncRows(h, w)
      this.renderList()
    }, 0)
    this.timeouts.add(t)
  }

  private ensureRows(n: number): void {
    while (this.rows.length < n) {
      const i = this.rows.length
      const box = new BoxRenderable(this.r, {
        id: `row-${i}`,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        overflow: "hidden",
        backgroundColor: "transparent",
        onMouseDown: (e) => this.onRowMouseDown(i, e),
        onMouseOver: () => this.setHover(i),
        onMouseOut: () => {
          if (this.hover === i) this.setHover(-1)
        },
      })
      const text = new TextRenderable(this.r, { content: "", height: 1, flexGrow: 1, wrapMode: "none", fg: theme.text, selectable: false })
      box.add(text)
      this.rowsBox.add(box)
      this.rows.push({ box, text })
    }
    while (this.rows.length > n) {
      const row = this.rows.pop()!
      this.rowsBox.remove(row.box)
      row.box.destroyRecursively()
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    if (this.stopped) return
    this.renderHeader()
    this.renderToolbar()
    this.renderList()
    this.renderDetails()
    this.renderFooter()
    this.renderToast()
  }

  private currentNode(): ExitNode | undefined {
    const active = this.allNodes.find((n) => n.active)
    if (active) return active
    const id = this.state?.exitNode?.id
    return id ? this.allNodes.find((n) => n.id === id) : undefined
  }

  private suggestedNode(): ExitNode | undefined {
    return findNodeByName(this.allNodes, this.suggestedName)
  }

  private selected(): ExitNode | undefined {
    return this.sel >= 0 ? this.nodes[this.sel] : undefined
  }

  private renderHeader(): void {
    if (this.stopped) return
    const W = Math.max(10, this.r.width - 2)
    const s = this.state
    const dim = (t: string) => ch(t, { fg: theme.textDim })
    const l1: TextChunk[] = []
    const l2: TextChunk[] = []

    if (!s) {
      l1.push(ch("◌ ", { fg: theme.textDim }))
      l1.push(
        this.lastError
          ? ch("Cannot reach Tailscale", { fg: theme.red, bold: true })
          : ch("Loading…", { fg: theme.textDim, bold: true }),
      )
    } else if (s.backendState !== "Running") {
      l1.push(ch("○ ", { fg: theme.yellow }), ch(`Tailscale is ${s.backendState}`, { fg: theme.yellow, bold: true }))
      l1.push(dim(s.backendState === "NeedsLogin" ? " · run: tailscale login" : " · run: tailscale up"))
    } else {
      const cur = this.currentNode()
      if (cur) {
        const offline = !cur.online || (s.exitNode !== null && !s.exitNode.online)
        const c = offline ? theme.yellow : theme.green
        l1.push(ch("◉ ", { fg: c, bold: true }), ch("CONNECTED", { fg: c, bold: true }), dim(" via "), ch(cur.name, { fg: theme.text, bold: true }))
        if (cur.ip) l1.push(dim(` ${cur.ip}`))
        const loc = locationLabel(cur)
        if (loc) l1.push(dim(" · "), ch(loc, { fg: theme.text }))
        l1.push(dim(" · "), dim(pathLabel(cur)))
        l1.push(dim(" · "), dim(`↓ ${humanBytes(cur.rxBytes)} ↑ ${humanBytes(cur.txBytes)}`))
        if (offline) l1.push(ch("  exit node is offline", { fg: theme.yellow, bold: true }))
      } else {
        l1.push(ch("○ ", { fg: theme.textDim }), ch("NO EXIT NODE", { fg: theme.text, bold: true }))
        l1.push(dim(" · internet traffic leaves this device directly"))
        const sug = this.suggestedNode()
        if (sug) l1.push(dim(" · suggested "), ch(`★ ${sug.name}`, { fg: theme.yellow }), dim(" (a)"))
      }
    }
    if (this.busy) l1.push(ch(`  ${SPINNER[this.spin % SPINNER.length]} ${this.busy}`, { fg: theme.accent }))

    l2.push(ch("tsexit", { fg: theme.accent, bold: true }), dim(` v${this.version}`))
    if (this.backend.kind === "demo") l2.push(dim(" · "), ch("DEMO", { fg: theme.purple, bold: true }))
    if (s) {
      if (s.tailnet) l2.push(dim(" · tailnet "), ch(s.tailnet, { fg: theme.text }))
      if (s.self) l2.push(dim(" · device "), ch(s.self.hostName, { fg: theme.text }))
      l2.push(dim(" · LAN access "))
      if (s.allowLan === null) l2.push(dim("unknown"))
      else l2.push(ch(s.allowLan ? "on" : "off", { fg: s.allowLan ? theme.green : theme.textDim }))
      const online = this.allNodes.filter((n) => n.online).length
      l2.push(dim(` · ${this.allNodes.length} exit nodes (${online} online)`))
      if (this.lastRefresh) l2.push(dim(` · updated ${relTime(new Date(this.lastRefresh))}`))
      if (s.health.length > 0) l2.push(dim(" · "), ch(`⚠ ${s.health[0]}`, { fg: theme.yellow }))
    }
    if (this.lastError) l2.push(dim(" · "), ch(`✗ ${this.lastError}`, { fg: theme.red }))

    this.h1.content = styled(trimChunks(l1, W))
    this.h2.content = styled(trimChunks(l2, W))
  }

  private renderToolbar(): void {
    for (const f of this.filterChips) {
      const def = FILTERS.find((d) => d.id === f.id)!
      this.setChip(f.chip, def.label, { active: this.query.filter === f.id })
    }
    const sort = SORTS.find((x) => x.id === this.query.sort)!
    this.setChip(this.sortChip, `${sort.label} ${this.query.desc ? "▾" : "▴"}`, { fg: theme.accent })
    const sug = this.suggestedNode()
    this.setChip(this.autoChip, sug ? `★ Auto: ${truncate(sug.name, 16)}` : "★ Auto", { fg: theme.yellow })
    const lan = this.state?.allowLan
    this.setChip(this.lanChip, lan === null || lan === undefined ? "LAN ?" : lan ? "LAN on" : "LAN off", {
      fg: lan ? theme.green : theme.chipFg,
      bold: lan === true,
    })
    this.setChip(this.helpChip, "?", { fg: theme.accent, bold: true })
  }

  private headerChunks(): TextChunk[] {
    const out: TextChunk[] = []
    this.cols.forEach((c, i) => {
      if (i > 0) out.push(ch(" "))
      const sorted = c.sort !== undefined && c.sort === this.query.sort
      const label = sorted ? `${c.label} ${this.query.desc ? "▾" : "▴"}` : c.label
      out.push(ch(fit(label, c.width, c.align), { fg: sorted ? theme.accent : theme.textDim, bold: sorted, underline: sorted }))
    })
    return out
  }

  private rowChunks(n: ExitNode, selected: boolean): TextChunk[] {
    const out: TextChunk[] = []
    const st = statusLabel(n)
    const isSuggested = n.id === this.suggestedNode()?.id
    const nameFg = st === "active" ? theme.green : st === "online" ? theme.text : st === "expired" ? theme.red : theme.textDim
    this.cols.forEach((c, i) => {
      if (i > 0) out.push(ch(" "))
      switch (c.id) {
        case "mark":
          out.push(ch(selected ? "▸" : " ", { fg: theme.accent, bold: true }))
          out.push(statusDot(st))
          out.push(ch(isSuggested ? "★" : " ", { fg: theme.yellow }))
          break
        case "name":
          out.push(ch(fit(n.name, c.width), { fg: nameFg, bold: st === "active" }))
          break
        case "status":
          out.push(statusChunk(st, c.width))
          break
        case "location": {
          const cc = n.countryCode ?? ""
          const city = n.city ?? n.country ?? ""
          if (!cc && !city) {
            out.push(ch(fit(n.isMullvad ? "" : "tailnet", c.width), { fg: theme.textMuted }))
          } else {
            out.push(ch(fit(cc, 2), { fg: theme.text, bold: true }))
            out.push(ch(" "))
            out.push(ch(fit(city, c.width - 3), { fg: theme.textDim }))
          }
          break
        }
        case "latency":
          out.push(latencyChunk(this.latency.get(n.id), c.width))
          break
        case "os":
          out.push(ch(fit(osLabel(n.os), c.width), { fg: theme.textDim }))
          break
        case "priority":
          out.push(ch(fit(n.priority !== undefined ? String(n.priority) : "—", c.width, "right"), { fg: theme.textMuted }))
          break
      }
    })
    return out
  }

  private renderList(): void {
    if (this.stopped) return
    const total = this.allNodes.length
    const shown = this.nodes.length
    this.listPanel.title = total === shown ? ` Exit nodes · ${total} ` : ` Exit nodes · ${shown} of ${total} `
    this.colHeader.content = styled(this.headerChunks())

    const s = this.state
    let empty: string | null = null
    if (!s) empty = this.lastError ? `Could not read Tailscale status.\n${this.lastError}` : "Loading exit nodes…"
    else if (s.backendState !== "Running") empty = `Tailscale is ${s.backendState}.\nStart it with "tailscale up" and press r to refresh.`
    else if (total === 0) empty = "No exit nodes in this tailnet.\n\nAdvertise one with:\ntailscale set --advertise-exit-node\nthen approve it in the admin console."
    else if (shown === 0) empty = `No exit nodes match "${this.query.text}" with filter ${this.query.filter}.\nEsc clears the search, 1 shows all.`

    this.emptyBox.visible = empty !== null
    this.rowsBox.visible = empty === null
    if (empty !== null) this.emptyText.content = empty
    this.renderRows()
  }

  private renderRows(): void {
    if (this.stopped) return
    const n = this.rows.length
    const maxTop = Math.max(0, this.nodes.length - n)
    if (this.top > maxTop) this.top = maxTop
    if (this.top < 0) this.top = 0
    for (let i = 0; i < n; i++) {
      const idx = this.top + i
      const row = this.rows[i]!
      const node = this.nodes[idx]
      if (!node) {
        row.text.content = ""
        row.box.backgroundColor = "transparent"
        continue
      }
      const selected = idx === this.sel
      row.text.content = styled(this.rowChunks(node, selected))
      row.box.backgroundColor = selected ? theme.selBg : idx === this.hover ? theme.hoverBg : "transparent"
    }
    this.scrollbar.scrollSize = this.nodes.length
    this.scrollbar.viewportSize = n
    this.scrollbar.scrollPosition = this.top
  }

  private detailsChunks(n: ExitNode | undefined, innerW: number): TextChunk[] {
    if (!n) return [ch("Select an exit node to see its details.", { fg: theme.textMuted })]
    const out: TextChunk[] = []
    const valW = Math.max(8, innerW - 11)
    const line = (label: string, ...vals: TextChunk[]) => {
      out.push(ch(fit(label, 11), { fg: theme.textMuted }), ...vals, ch("\n"))
    }
    const st = statusLabel(n)
    out.push(ch(truncate(n.name, innerW), { fg: theme.accent, bold: true }), ch("\n"))
    out.push(ch(truncate(n.dnsName || n.hostName, innerW), { fg: theme.textDim }), ch("\n\n"))
    line("Status", statusDot(st), ch(" "), statusChunk(st, 0), ch(n.online && !n.active ? "  (Enter to use)" : "", { fg: theme.textMuted }))
    line("Address", ch(fit(n.ip || "—", valW), { fg: theme.text }))
    const v6 = n.ips.find((ip) => ip.includes(":"))
    if (v6) line("", ch(fit(v6, valW), { fg: theme.textDim }))
    line("Location", ch(fit(locationLong(n), valW)))
    line("Type", ch(n.isMullvad ? "Mullvad exit node" : "Tailnet device", { fg: n.isMullvad ? theme.purple : theme.cyan }))
    line("OS", ch(osLabel(n.os)))
    if (n.owner) line("Owner", ch(fit(n.owner, valW)))
    if (n.tags.length > 0) line("Tags", ch(fit(n.tags.join(" "), valW), { fg: theme.textDim }))
    if (n.priority !== undefined) line("Priority", ch(String(n.priority)))
    line("Last seen", ch(n.online ? "online now" : relTime(n.lastSeen), { fg: n.online ? theme.green : theme.textDim }))
    if (n.lastHandshake) line("Handshake", ch(relTime(n.lastHandshake)))
    line("Path", ch(fit(pathLabel(n), valW), { fg: theme.textDim }))
    line("Traffic", ch(`↓ ${humanBytes(n.rxBytes)}  ↑ ${humanBytes(n.txBytes)}`))
    const lat = this.latency.get(n.id)
    line("Latency", latencyChunk(lat, 0), ch(lat === undefined ? "  (p to ping)" : "", { fg: theme.textMuted }))
    if (n.id === this.suggestedNode()?.id) line("Suggested", ch("★ Tailscale's pick right now", { fg: theme.yellow }))
    if (n.expired) line("Key", ch("expired, re-authenticate this device", { fg: theme.red }))
    if (this.forceArm?.id === n.id && Date.now() < this.forceArm.until) {
      out.push(ch("\n"), ch("Offline node. Press Enter again to use it anyway.", { fg: theme.yellow }))
    }
    return out
  }

  private renderDetails(): void {
    if (this.stopped || !this.details.visible) return
    const n = this.selected()
    const innerW = DETAILS_WIDTH - 4
    this.detailsText.content = styled(this.detailsChunks(n, innerW))
    if (!n) {
      this.setChip(this.btnConnect, "Connect", { bg: theme.chipBg, fg: theme.textMuted })
      this.setChip(this.btnPing, "Ping", { bg: theme.chipBg, fg: theme.textMuted })
      this.setChip(this.btnCopy, "Copy IP", { bg: theme.chipBg, fg: theme.textMuted })
      return
    }
    if (n.active) this.setChip(this.btnConnect, "Disconnect", { bg: theme.btnDangerBg, fg: theme.btnFg, bold: true })
    else if (!n.online && this.forceArm?.id === n.id) this.setChip(this.btnConnect, "Connect anyway", { bg: theme.btnDangerBg, fg: theme.btnFg, bold: true })
    else this.setChip(this.btnConnect, "Connect", { bg: theme.btnPrimaryBg, fg: theme.btnFg, bold: true })
    this.setChip(this.btnPing, this.latency.get(n.id) === "pending" ? "Pinging…" : "Ping", { bg: theme.btnBg, fg: theme.btnFg })
    this.setChip(this.btnCopy, "Copy IP", { bg: theme.btnBg, fg: theme.btnFg })
  }

  private renderFooter(): void {
    if (this.stopped) return
    const W = Math.max(10, this.r.width - 2)
    const key = (k: string) => ch(k, { fg: theme.accent, bold: true })
    const desc = (d: string) => ch(` ${d}`, { fg: theme.textDim })
    const sep = () => ch("  ")

    let hints: [string, string][]
    if (this.helpOpen) hints = [["Esc", "close help"]]
    else if (this.mode === "search")
      hints = [
        ["⏎", "apply"],
        ["Esc", "clear and back"],
        ["↑↓", "move selection"],
        ["Tab", "back to list"],
        ["!word", "exclude"],
      ]
    else
      hints = [
        ["↑↓", "move"],
        ["⏎", "connect/disconnect"],
        ["d", "disconnect"],
        ["a", "auto"],
        ["p", "ping"],
        ["P", "ping all"],
        ["/", "search"],
        ["f", "filter"],
        ["s", "sort"],
        ["l", "LAN"],
        ["y", "copy IP"],
        ["i", "details"],
        ["r", "refresh"],
      ]
    const tail: [string, string][] = this.helpOpen ? [] : [["?", "help"], ["q", "quit"]]
    const build = (items: [string, string][]): TextChunk[] => {
      const out: TextChunk[] = []
      items.forEach(([k, d], i) => {
        if (i > 0) out.push(sep())
        out.push(key(k), desc(d))
      })
      return out
    }
    const tailChunks = build(tail)
    const tailW = tail.length ? chunksWidth(tailChunks) + 2 : 0
    let mainChunks = build(hints)
    while (hints.length > 1 && chunksWidth(mainChunks) + tailW > W) {
      hints = hints.slice(0, -1)
      mainChunks = build(hints)
    }
    const all = tail.length ? [...mainChunks, sep(), ...tailChunks] : mainChunks
    this.footerText.content = styled(trimChunks(all, W))
  }

  private renderToast(): void {
    if (this.stopped) return
    if (!this.toast) {
      this.toastBox.visible = false
      return
    }
    const bg =
      this.toast.kind === "ok"
        ? theme.toastOkBg
        : this.toast.kind === "warn"
          ? theme.toastWarnBg
          : this.toast.kind === "error"
            ? theme.toastErrorBg
            : theme.toastInfoBg
    const icon = this.toast.kind === "ok" ? "✓ " : this.toast.kind === "warn" ? "⚠ " : this.toast.kind === "error" ? "✗ " : "• "
    this.toastBox.backgroundColor = bg
    this.toastText.content = styled([ch(icon + truncate(this.toast.text, Math.max(10, this.r.width - 8)), { fg: theme.text, bold: true })])
    this.toastBox.visible = true
  }

  private renderHelp(): void {
    const boxW = Math.max(30, Math.min(76, this.r.width - 4))
    const inner = boxW - 6 // border + paddingX on both sides
    const labelW = 14
    const chunks: TextChunk[] = []
    let lines = 0
    for (const [label, text] of HELP_LINES) {
      const wrapped = wrapText(text, Math.max(10, inner - labelW))
      wrapped.forEach((part, j) => {
        if (lines > 0) chunks.push(ch("\n"))
        chunks.push(ch(fit(j === 0 ? label : "", labelW), { fg: theme.accent, bold: true }), ch(part, { fg: theme.text }))
        lines++
      })
    }
    const refresh = this.refreshMs > 0 ? `every ${Math.round(this.refreshMs / 1000)}s` : "manual"
    chunks.push(ch("\n\n"), ch("Backend ", { fg: theme.textMuted }), ch(this.backend.label, { fg: theme.textDim }))
    chunks.push(ch("   Refresh ", { fg: theme.textMuted }), ch(refresh, { fg: theme.textDim }))
    lines += 2
    this.helpText.content = styled(chunks)
    this.helpHeight = Math.min(this.r.height, lines + 4)
    this.helpBox.height = this.helpHeight
  }

  private updateFocusVisuals(): void {
    const searching = this.mode === "search"
    this.searchBox.borderColor = searching ? theme.borderFocus : theme.border
    this.searchIcon.fg = searching ? theme.accent : theme.textDim
    this.listPanel.borderColor = searching ? theme.border : theme.borderFocus
    this.listPanel.titleColor = searching ? theme.textDim : theme.accent
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return
    this.refreshing = true
    try {
      const s = await this.backend.status()
      if (this.stopped) return
      this.state = s
      this.allNodes = s.nodes
      this.lastRefresh = Date.now()
      this.lastError = null
      this.requery(false)
    } catch (e) {
      const msg = errText(e)
      if (msg !== this.lastError) {
        this.lastError = msg
        this.notify(msg, "error", 6000)
      }
    } finally {
      this.refreshing = false
      this.render()
    }
  }

  private scheduleRefresh(ms: number): void {
    const t = setTimeout(() => {
      this.timeouts.delete(t)
      void this.refresh()
    }, ms)
    this.timeouts.add(t)
  }

  private async fetchSuggestion(): Promise<void> {
    try {
      const s = await this.backend.suggest()
      if (this.stopped) return
      if (s !== this.suggestedName) {
        this.suggestedName = s
        this.render()
      }
    } catch {
      // suggestions are optional
    }
  }

  /** Re-run filter + sort; keep the selected node when possible. */
  private requery(resetOnMiss: boolean): void {
    const prevId = this.selectedId
    this.nodes = applyQuery(this.allNodes, this.query, (id) => this.latency.get(id))
    let idx = prevId ? this.nodes.findIndex((n) => n.id === prevId) : -1
    if (idx < 0) {
      if (this.nodes.length === 0) idx = -1
      else if (resetOnMiss || this.sel < 0) idx = 0
      else idx = Math.min(this.sel, this.nodes.length - 1)
    }
    this.sel = idx
    this.selectedId = idx >= 0 ? this.nodes[idx]!.id : null
    if (resetOnMiss && idx === 0) this.top = 0
    this.ensureVisible()
  }

  private ensureVisible(): void {
    const n = this.rows.length
    if (n <= 0 || this.sel < 0) return
    if (this.sel < this.top) this.top = this.sel
    else if (this.sel >= this.top + n) this.top = this.sel - n + 1
    const maxTop = Math.max(0, this.nodes.length - n)
    if (this.top > maxTop) this.top = maxTop
    if (this.top < 0) this.top = 0
  }

  // -------------------------------------------------------------------------
  // Selection and navigation
  // -------------------------------------------------------------------------

  private select(idx: number): void {
    if (this.nodes.length === 0) {
      this.sel = -1
      this.selectedId = null
      return
    }
    this.sel = Math.max(0, Math.min(idx, this.nodes.length - 1))
    this.selectedId = this.nodes[this.sel]!.id
    this.ensureVisible()
    this.render()
  }

  private selectById(id: string): void {
    const idx = this.nodes.findIndex((n) => n.id === id)
    if (idx >= 0) this.select(idx)
  }

  private move(delta: number): void {
    if (this.nodes.length === 0) return
    this.select((this.sel < 0 ? 0 : this.sel) + delta)
  }

  private pageSize(): number {
    return Math.max(1, this.rows.length - 1)
  }

  private scrollBy(delta: number): void {
    const n = this.rows.length
    const maxTop = Math.max(0, this.nodes.length - n)
    this.top = Math.max(0, Math.min(this.top + delta, maxTop))
    this.renderRows()
  }

  private setHover(i: number): void {
    const idx = i >= 0 ? this.top + i : -1
    if (idx === this.hover) return
    this.hover = idx
    this.pointer(idx >= 0 && idx < this.nodes.length ? "pointer" : "default")
    this.renderRows()
  }

  private pointer(style: MousePointerStyle): void {
    if (this.pointerStyle === style) return
    this.pointerStyle = style
    try {
      this.r.setMousePointer(style)
      this.r.requestRender()
    } catch {
      // unsupported terminal
    }
  }

  private focusSearch(): void {
    if (this.helpOpen) return
    this.mode = "search"
    this.search.focus()
    this.updateFocusVisuals()
    this.renderFooter()
  }

  private focusList(): void {
    if (this.search.focused) this.search.blur()
    this.mode = "list"
    this.updateFocusVisuals()
    this.renderFooter()
  }

  private setSearch(text: string): void {
    this.search.value = text
    if (this.query.text !== text) {
      this.query.text = text
      this.requery(true)
      this.render()
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onKey = (key: KeyEvent): void => {
    if (this.stopped) return
    if (this.helpOpen) {
      key.preventDefault()
      key.stopPropagation()
      if (["escape", "return", "q", "f1", "space"].includes(key.name) || key.sequence === "?") this.toggleHelp(false)
      return
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      this.quit()
      return
    }
    if (this.mode === "search") this.onSearchKey(key)
    else this.onListKey(key)
  }

  private onSearchKey(key: KeyEvent): void {
    switch (key.name) {
      case "escape":
        key.preventDefault()
        this.setSearch("")
        this.focusList()
        return
      case "return":
      case "tab":
        key.preventDefault()
        this.focusList()
        return
      case "up":
        key.preventDefault()
        this.move(-1)
        return
      case "down":
        key.preventDefault()
        this.move(1)
        return
      case "pageup":
        key.preventDefault()
        this.move(-this.pageSize())
        return
      case "pagedown":
        key.preventDefault()
        this.move(this.pageSize())
        return
      default:
        return
    }
  }

  private onListKey(key: KeyEvent): void {
    const k = key.name
    const shift = key.shift
    const ctrl = key.ctrl
    if (k === "up" || (k === "k" && !ctrl)) return this.move(-1)
    if (k === "down" || (k === "j" && !ctrl)) return this.move(1)
    if (k === "pageup" || (ctrl && (k === "u" || k === "b"))) return this.move(-this.pageSize())
    if (k === "pagedown" || (ctrl && (k === "d" || k === "f"))) return this.move(this.pageSize())
    if (k === "home" || (k === "g" && !shift)) return this.select(0)
    if (k === "end" || (k === "g" && shift)) return this.select(this.nodes.length - 1)
    if (k === "return") return this.activateSelected()
    if (k === "d" || k === "x" || k === "backspace" || k === "delete") return void this.disconnect()
    if (k === "p" && !shift) return this.pingSelected()
    if (k === "p" && shift) return this.pingAll()
    if (k === "a") return void this.connectSuggested()
    if (k === "l") return void this.toggleLan()
    if (k === "r" || k === "f5") return this.manualRefresh()
    if (k === "s" && !shift) return this.nextSort(1)
    if (k === "s" && shift) return this.toggleDesc()
    if (k === "f" && !shift) return this.nextFilter(1)
    if (k === "f" && shift) return this.nextFilter(-1)
    if (k === "/" || k === "tab" || (ctrl && k === "f")) {
      key.preventDefault()
      return this.focusSearch()
    }
    if (k === "y" || k === "c") return this.copySelected()
    if (k === "i") return this.toggleDetails()
    if (k === "?" || key.sequence === "?" || k === "f1") return this.toggleHelp(true)
    if (k === "q") return this.quit()
    if (k === "escape") {
      if (this.query.text) this.setSearch("")
      else if (this.toast) this.hideToast()
      return
    }
    for (const f of FILTERS) {
      if (k === f.hotkey || key.sequence === f.hotkey) return this.setFilter(f.id)
    }
  }

  private onRowMouseDown(i: number, e: MouseEvent): void {
    const idx = this.top + i
    const node = this.nodes[idx]
    if (!node) return
    if (e.button === 2) {
      this.select(idx)
      this.pingNode(node)
      return
    }
    if (e.button === 1) {
      this.select(idx)
      this.copyIp(node)
      return
    }
    if (e.button !== 0) return
    if (this.mode === "search") this.focusList()
    const now = Date.now()
    const isDouble = this.lastClick.index === idx && now - this.lastClick.at < DOUBLE_CLICK_MS
    this.lastClick = { index: idx, at: isDouble ? 0 : now }
    this.select(idx)
    if (isDouble) this.activateSelected()
  }

  private onHeaderClick(e: MouseEvent): void {
    if (e.button !== 0) return
    const local = e.x - this.colHeaderBox.x
    let x = 0
    for (const c of this.cols) {
      if (local >= x && local < x + c.width) {
        if (!c.sort) return
        if (this.query.sort === c.sort) this.query.desc = !this.query.desc
        else {
          this.query.sort = c.sort
          this.query.desc = false
        }
        this.requery(false)
        this.render()
        return
      }
      x += c.width + COL_GAP
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private notify(text: string, kind: ToastKind = "info", ms = 3500): void {
    this.toast = { text, kind }
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null
      this.toast = null
      this.renderToast()
    }, ms)
    this.renderToast()
  }

  private hideToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = null
    this.toast = null
    this.renderToast()
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      this.spin++
      this.renderHeader()
    }, 100)
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
  }

  private async runAction(label: string, fn: () => Promise<void>, opts: { onOk?: () => void; refresh?: boolean } = {}): Promise<boolean> {
    if (this.busy) {
      this.notify(`Still busy: ${this.busy}`, "warn")
      return false
    }
    this.busy = label
    this.startSpinner()
    this.render()
    let ok = false
    try {
      await fn()
      ok = true
      if (opts.refresh !== false) {
        this.refreshing = false
        await this.refresh()
        this.scheduleRefresh(1500)
        this.scheduleRefresh(4000)
      }
      opts.onOk?.()
    } catch (e) {
      this.notify(errText(e), "error", 8000)
    } finally {
      this.busy = null
      this.stopSpinner()
      this.render()
    }
    return ok
  }

  private activateSelected(): void {
    const n = this.selected()
    if (!n) {
      this.notify("Nothing selected", "info")
      return
    }
    if (n.active) {
      void this.disconnect()
      return
    }
    void this.connect(n)
  }

  private async connect(n: ExitNode): Promise<void> {
    if (n.expired) {
      this.notify(`${n.name} has an expired key and cannot be used`, "warn")
      return
    }
    if (!n.online) {
      const armed = this.forceArm !== null && this.forceArm.id === n.id && Date.now() < this.forceArm.until
      if (!armed) {
        this.forceArm = { id: n.id, until: Date.now() + FORCE_WINDOW_MS }
        this.notify(`${n.name} is offline. Press Enter again within 4s to use it anyway.`, "warn", FORCE_WINDOW_MS)
        this.renderDetails()
        return
      }
    }
    this.forceArm = null
    await this.runAction(`Connecting to ${n.name}`, () => this.backend.setExitNode(n), {
      onOk: () => this.notify(`Internet traffic now exits via ${n.name}`, "ok"),
    })
  }

  private async disconnect(): Promise<void> {
    const cur = this.currentNode()
    if (!cur && !this.state?.exitNode) {
      this.notify("Not using an exit node", "info")
      return
    }
    await this.runAction("Disconnecting", () => this.backend.setExitNode(null), {
      onOk: () => this.notify("Exit node disabled, traffic leaves directly", "ok"),
    })
  }

  private async connectSuggested(): Promise<void> {
    let node = this.suggestedNode()
    if (!node) {
      const ok = await this.runAction(
        "Asking Tailscale for a suggestion",
        async () => {
          this.suggestedName = await this.backend.suggest()
        },
        { refresh: false },
      )
      if (!ok) return
      node = this.suggestedNode()
    }
    if (!node) {
      this.notify("Tailscale has no exit node suggestion right now", "warn")
      return
    }
    this.selectById(node.id)
    if (node.active) {
      this.notify(`Already using the suggested node ${node.name}`, "info")
      return
    }
    await this.connect(node)
  }

  private async toggleLan(): Promise<void> {
    const cur = this.state?.allowLan ?? false
    await this.runAction(cur ? "Disabling LAN access" : "Enabling LAN access", () => this.backend.setAllowLan(!cur), {
      onOk: () => this.notify(cur ? "LAN access disabled" : "LAN access enabled while using an exit node", "ok"),
    })
  }

  private manualRefresh(): void {
    void this.refresh()
    void this.fetchSuggestion()
    this.notify("Refreshed", "info", 1200)
  }

  private pingSelected(): void {
    const n = this.selected()
    if (!n) return
    this.pingNode(n)
  }

  private pingNode(n: ExitNode): void {
    if (this.latency.get(n.id) === "pending") return
    this.latency.set(n.id, "pending")
    this.render()
    this.backend
      .ping(n)
      .then((v) => {
        if (this.stopped) return
        this.latency.set(n.id, v)
        if (this.query.sort === "latency") this.requery(false)
        this.render()
      })
      .catch(() => {
        if (this.stopped) return
        this.latency.set(n.id, null)
        this.render()
      })
  }

  private pingAll(): void {
    const targets = this.nodes.filter((n) => n.online && this.latency.get(n.id) !== "pending")
    if (targets.length === 0) {
      this.notify("No online nodes to ping in the current view", "info")
      return
    }
    this.notify(`Pinging ${targets.length} nodes…`, "info", 2500)
    let i = 0
    const worker = async () => {
      while (i < targets.length && !this.stopped) {
        const n = targets[i++]!
        this.latency.set(n.id, "pending")
        try {
          const v = await this.backend.ping(n)
          this.latency.set(n.id, v)
        } catch {
          this.latency.set(n.id, null)
        }
        if (this.query.sort === "latency") this.requery(false)
        this.render()
      }
    }
    this.render()
    for (let w = 0; w < Math.min(6, targets.length); w++) void worker()
  }

  private copySelected(): void {
    const n = this.selected()
    if (!n) return
    this.copyIp(n)
  }

  private copyIp(n: ExitNode): void {
    const text = n.ip || n.dnsName
    let ok = false
    try {
      ok = this.r.copyToClipboardOSC52(text)
    } catch {
      ok = false
    }
    if (ok) this.notify(`Copied ${text} to the clipboard`, "ok")
    else this.notify(`Clipboard not available in this terminal (${text})`, "warn", 5000)
  }

  private setFilter(id: FilterKind): void {
    if (this.query.filter === id) return
    this.query.filter = id
    this.requery(true)
    this.render()
  }

  private nextFilter(delta: number): void {
    const i = FILTERS.findIndex((f) => f.id === this.query.filter)
    const next = FILTERS[(i + delta + FILTERS.length) % FILTERS.length]!
    this.setFilter(next.id)
  }

  private nextSort(delta: number): void {
    const i = SORTS.findIndex((s) => s.id === this.query.sort)
    this.query.sort = SORTS[(i + delta + SORTS.length) % SORTS.length]!.id
    this.query.desc = false
    this.requery(false)
    this.render()
  }

  private toggleDesc(): void {
    this.query.desc = !this.query.desc
    this.requery(false)
    this.render()
  }

  private toggleDetails(): void {
    this.detailsWanted = !this.detailsWanted
    if (this.detailsWanted && this.r.width < DETAILS_MIN_TOTAL) {
      this.notify(`Details need at least ${DETAILS_MIN_TOTAL} columns (terminal is ${this.r.width})`, "warn")
    }
    this.layout()
  }

  private toggleHelp(open?: boolean): void {
    const next = open ?? !this.helpOpen
    if (next === this.helpOpen) return
    this.helpOpen = next
    if (next) {
      if (this.search.focused) this.focusList()
      this.renderHelp()
    }
    this.scrim.visible = next
    this.helpBox.visible = next
    this.centerHelp()
    this.renderFooter()
  }
}
