// Shared building blocks for every view: styled text, chips, the search box, the virtualized list
// panel and the details panel. They are the exit-node screen's parts, lifted out so each view looks
// and behaves the same.
import {
  BoxRenderable,
  InputRenderable,
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
} from "@opentui/core";
import { fit, truncate, width } from "./format";
import { theme } from "./theme";

// ---------------------------------------------------------------------------
// Styled text
// ---------------------------------------------------------------------------

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const colorCache = new Map<string, RGBA>();

export function color(hex: string): RGBA {
  let c = colorCache.get(hex);
  if (!c) {
    c = parseColor(hex);
    colorCache.set(hex, c);
  }
  return c;
}

export function ch(text: string, style: Style = {}): TextChunk {
  let attributes = 0;
  if (style.bold) attributes |= TextAttributes.BOLD;
  if (style.dim) attributes |= TextAttributes.DIM;
  if (style.italic) attributes |= TextAttributes.ITALIC;
  if (style.underline) attributes |= TextAttributes.UNDERLINE;
  return {
    __isChunk: true,
    text,
    fg: style.fg ? color(style.fg) : undefined,
    bg: style.bg ? color(style.bg) : undefined,
    attributes,
  };
}

export function styled(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks);
}

export function chunksWidth(chunks: TextChunk[]): number {
  let w = 0;
  for (const c of chunks) w += width(c.text);
  return w;
}

/** Trim a single-line chunk list so it never exceeds `max` cells. */
export function trimChunks(chunks: TextChunk[], max: number): TextChunk[] {
  const out: TextChunk[] = [];
  let w = 0;
  for (const c of chunks) {
    const cw = width(c.text);
    if (w + cw <= max) {
      out.push(c);
      w += cw;
      continue;
    }
    const room = max - w;
    if (room > 0) out.push({ ...c, text: truncate(c.text, room) });
    break;
  }
  return out;
}

/** Label column width of every key/value block in a details panel. */
export const LABEL_W = 11;

/** Key/value lines in the house style: a muted, fixed-width label followed by value chunks. */
export class Lines {
  private rows: { chunks: TextChunk[]; drop: number }[] = [];
  private nextDrop = 0;

  constructor(readonly width: number) {}

  /** Width left for a value after the label column. */
  get valueW(): number {
    return Math.max(8, this.width - LABEL_W);
  }

  /** Every line, newline-separated. */
  get out(): TextChunk[] {
    return this.rows.flatMap((r) => [...r.chunks, ch("\n")]);
  }

  /** Lines that fit in `room` rows: optional lines go first, the highest `drop` before lower ones. */
  fit(room: number): TextChunk[] {
    const rows = [...this.rows];
    while (rows.length > room) {
      let worst = -1;
      rows.forEach((r, i) => {
        if (r.drop > 0 && (worst < 0 || r.drop >= rows[worst]!.drop)) worst = i;
      });
      if (worst < 0) break;
      rows.splice(worst, 1);
    }
    return rows.flatMap((r) => [...r.chunks, ch("\n")]);
  }

  /** Mark the next line optional for `fit`; lines with a higher `drop` are dropped first. */
  optional(drop = 1): this {
    this.nextDrop = drop;
    return this;
  }

  private push(chunks: TextChunk[]): this {
    this.rows.push({ chunks, drop: this.nextDrop });
    this.nextDrop = 0;
    return this;
  }

  /** A labelled line; the value is trimmed to the panel so nothing is clipped mid-glyph. */
  kv(label: string, ...vals: TextChunk[]): this {
    return this.push([
      ch(fit(label, LABEL_W), { fg: theme.textMuted }),
      ...trimChunks(vals, this.valueW),
    ]);
  }

  /** A value that is truncated to the value column. */
  kvText(label: string, text: string, style: Style = {}): this {
    return this.kv(label, ch(truncate(text, this.valueW), style));
  }

  line(...chunks: TextChunk[]): this {
    return this.push(trimChunks(chunks, this.width));
  }

  /** Title line in accent, as the details panels start. */
  title(text: string, style: Style = { fg: theme.accent, bold: true }): this {
    return this.line(ch(truncate(text, this.width), style));
  }

  blank(): this {
    return this.push([]);
  }

  /** A muted section heading inside a panel. */
  heading(text: string): this {
    return this.line(ch(text, { fg: theme.textDim, bold: true }));
  }
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

const pointerState = new WeakMap<CliRenderer, MousePointerStyle>();

/** Set the mouse cursor shape; cheap and safe to call often. */
export function pointer(r: CliRenderer, style: MousePointerStyle): void {
  if (pointerState.get(r) === style) return;
  pointerState.set(r, style);
  try {
    r.setMousePointer(style);
    r.requestRender();
  } catch {
    // unsupported terminal
  }
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export interface Chip {
  box: BoxRenderable;
  text: TextRenderable;
}

export function makeChip(
  r: CliRenderer,
  id: string,
  label: string,
  onClick: (e: MouseEvent) => void,
): Chip {
  const box = new BoxRenderable(r, {
    id,
    height: 1,
    paddingX: 1,
    flexShrink: 0,
    backgroundColor: theme.chipBg,
    onMouseDown: (e) => {
      if (e.button === 0) onClick(e);
    },
    onMouseOver: () => pointer(r, "pointer"),
    onMouseOut: () => pointer(r, "default"),
  });
  const text = new TextRenderable(r, {
    id: `${id}-text`,
    content: label,
    fg: theme.chipFg,
    height: 1,
    wrapMode: "none",
    selectable: false,
  });
  box.add(text);
  return { box, text };
}

export interface ChipStyle {
  active?: boolean;
  bg?: string;
  fg?: string;
  bold?: boolean;
}

export function setChip(chip: Chip, label: string, opts: ChipStyle = {}): void {
  const bg = opts.bg ?? (opts.active ? theme.chipActiveBg : theme.chipBg);
  const fg = opts.fg ?? (opts.active ? theme.chipActiveFg : theme.chipFg);
  chip.box.backgroundColor = bg;
  chip.text.content = styled([
    ch(label, { fg, bold: opts.bold ?? opts.active }),
  ]);
}

/** Button looks used in details panels. */
export const btn = {
  primary: { bg: theme.btnPrimaryBg, fg: theme.btnFg, bold: true },
  danger: { bg: theme.btnDangerBg, fg: theme.btnFg, bold: true },
  normal: { bg: theme.btnBg, fg: theme.btnFg },
  off: { bg: theme.chipBg, fg: theme.textMuted },
} satisfies Record<string, ChipStyle>;

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

/** The rounded search field of every toolbar; borderless and one row high in compact layouts. */
export class SearchBox {
  readonly box: BoxRenderable;
  readonly input: InputRenderable;
  private readonly icon: TextRenderable;
  private compact = false;
  private focused = false;

  constructor(
    r: CliRenderer,
    id: string,
    placeholder: string,
    onClick: () => void,
  ) {
    this.box = new BoxRenderable(r, {
      id: `${id}-searchbox`,
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
      onMouseDown: () => onClick(),
      onMouseOver: () => pointer(r, "text"),
      onMouseOut: () => pointer(r, "default"),
    });
    this.icon = new TextRenderable(r, {
      id: `${id}-searchicon`,
      content: "⌕ ",
      fg: theme.textDim,
      width: 2,
      height: 1,
      selectable: false,
    });
    this.input = new InputRenderable(r, {
      id: `${id}-search`,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 8,
      placeholder,
      placeholderColor: theme.textMuted,
      textColor: theme.text,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      cursorColor: theme.accent,
    });
    this.box.add(this.icon);
    this.box.add(this.input);
  }

  setCompact(compact: boolean): void {
    this.compact = compact;
    this.box.height = compact ? 1 : 3;
    this.box.paddingX = compact ? 0 : 1;
    this.box.border = !compact;
    if (!compact)
      this.box.borderColor = this.focused ? theme.borderFocus : theme.border;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    // Setting a border color turns the border back on, so a borderless (compact) box keeps none.
    if (!this.compact)
      this.box.borderColor = focused ? theme.borderFocus : theme.border;
    this.icon.fg = focused ? theme.accent : theme.textDim;
  }
}

// ---------------------------------------------------------------------------
// List panel
// ---------------------------------------------------------------------------

export interface ListColumn {
  id: string;
  label: string;
  width: number;
  align: "left" | "right";
  /** Sort key; clicking the header sorts by it. */
  sort?: string;
}

export const COL_GAP = 1;

/** Header chunks for `cols`, marking the sorted column in accent with an arrow. */
export function headerChunks(
  cols: readonly ListColumn[],
  sort: string | null,
  desc: boolean,
): TextChunk[] {
  const out: TextChunk[] = [];
  cols.forEach((c, i) => {
    if (i > 0) out.push(ch(" ".repeat(COL_GAP)));
    const sorted = c.sort !== undefined && c.sort === sort;
    const label = sorted ? `${c.label} ${desc ? "▾" : "▴"}` : c.label;
    out.push(
      ch(fit(label, c.width, c.align), {
        fg: sorted ? theme.accent : theme.textDim,
        bold: sorted,
        underline: sorted,
      }),
    );
  });
  return out;
}

/** The column under local header position `x`, if any. */
export function columnAt(
  cols: readonly ListColumn[],
  x: number,
): ListColumn | undefined {
  let at = 0;
  for (const c of cols) {
    if (x >= at && x < at + c.width) return c;
    at += c.width + COL_GAP;
  }
  return undefined;
}

export interface ListPanelOptions<T> {
  id: string;
  title: string;
  /** Stable identity used to keep the selection across refreshes. */
  key: (item: T) => string;
  row: (item: T, selected: boolean, width: number) => TextChunk[];
  /** Section headings and separators are skipped by the selection. */
  selectable?: (item: T) => boolean;
  /** Show a one-line column header above the rows. */
  header?: boolean;
  onHeaderClick?: (x: number, e: MouseEvent) => void;
  onSelect?: () => void;
  onActivate?: (item: T) => void;
  onRightClick?: (item: T) => void;
  onMiddleClick?: (item: T) => void;
  /** A row was clicked with the left button (the view may move focus back to the list). */
  onRowClick?: () => void;
  /** The row width changed after layout (columns may need recomputing). */
  onResize?: (width: number) => void;
}

const DOUBLE_CLICK_MS = 400;

interface Row {
  box: BoxRenderable;
  text: TextRenderable;
}

/**
 * A bordered, virtualized list: a pool of one-row boxes sized to the viewport, a scrollbar, an
 * optional clickable column header, hover and selection highlights, wheel scrolling,
 * double-click activation, and right/middle click hooks.
 */
export class ListPanel<T> {
  readonly panel: BoxRenderable;
  readonly headerBox: BoxRenderable;
  private readonly headerText: TextRenderable;
  private readonly rowsBox: BoxRenderable;
  private readonly emptyBox: BoxRenderable;
  private readonly emptyText: TextRenderable;
  private readonly scrollbar: ScrollBarRenderable;

  items: T[] = [];
  sel = -1;
  top = 0;
  private selectedKey: string | null = null;
  private hover = -1;
  private rows: Row[] = [];
  private rowW = 40;
  private lastClick = { index: -1, at: 0 };
  private empty: string | null = null;
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly r: CliRenderer,
    private readonly opts: ListPanelOptions<T>,
  ) {
    const id = opts.id;
    this.panel = new BoxRenderable(r, {
      id: `${id}-list`,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 30,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderFocus,
      title: ` ${opts.title} `,
      titleColor: theme.accent,
      flexDirection: "column",
      overflow: "hidden",
    });
    this.headerBox = new BoxRenderable(r, {
      id: `${id}-colheader`,
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      backgroundColor: theme.panel,
      visible: opts.header !== false,
      onMouseDown: (e) => {
        if (e.button === 0) opts.onHeaderClick?.(e.x - this.headerBox.x, e);
      },
      onMouseOver: () => pointer(r, opts.onHeaderClick ? "pointer" : "default"),
      onMouseOut: () => pointer(r, "default"),
    });
    this.headerText = new TextRenderable(r, {
      id: `${id}-colheader-text`,
      content: "",
      height: 1,
      flexGrow: 1,
      wrapMode: "none",
      fg: theme.textDim,
      selectable: false,
    });
    this.headerBox.add(this.headerText);

    const area = new BoxRenderable(r, {
      id: `${id}-rowsarea`,
      flexGrow: 1,
      flexDirection: "row",
      onMouseScroll: (e) => {
        if (!e.scroll) return;
        if (e.scroll.direction === "up") this.scrollBy(-3);
        else if (e.scroll.direction === "down") this.scrollBy(3);
      },
    });
    this.rowsBox = new BoxRenderable(r, {
      id: `${id}-rows`,
      flexGrow: 1,
      flexDirection: "column",
      overflow: "hidden",
      onSizeChange: () => this.onRowsResize(),
    });
    this.emptyBox = new BoxRenderable(r, {
      id: `${id}-empty`,
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingX: 2,
      visible: false,
    });
    this.emptyText = new TextRenderable(r, {
      id: `${id}-empty-text`,
      content: "",
      fg: theme.textDim,
      wrapMode: "word",
      selectable: false,
    });
    this.emptyBox.add(this.emptyText);
    this.scrollbar = new ScrollBarRenderable(r, {
      id: `${id}-scrollbar`,
      orientation: "vertical",
      width: 1,
      flexShrink: 0,
      showArrows: false,
      trackOptions: {
        backgroundColor: theme.panel,
        foregroundColor: theme.border,
      },
      onChange: (pos) => {
        this.top = Math.round(pos);
        this.renderRows();
      },
    });
    area.add(this.rowsBox);
    area.add(this.emptyBox);
    area.add(this.scrollbar);
    this.panel.add(this.headerBox);
    this.panel.add(area);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  get width(): number {
    return this.rowW;
  }

  get height(): number {
    return this.rows.length;
  }

  setTitle(title: string): void {
    this.panel.title = title;
  }

  setHeader(chunks: TextChunk[]): void {
    this.headerText.content = styled(chunks);
  }

  setHeaderVisible(visible: boolean): void {
    this.headerBox.visible = visible;
  }

  /** Border and title in accent while the list has the keyboard. */
  setFocused(focused: boolean): void {
    this.panel.borderColor = focused ? theme.borderFocus : theme.border;
    this.panel.titleColor = focused ? theme.accent : theme.textDim;
  }

  /** Centered message instead of rows (loading, empty and error states); null shows the rows. */
  setEmpty(text: string | null): void {
    this.empty = text;
    this.emptyBox.visible = text !== null;
    this.rowsBox.visible = text === null;
    if (text !== null) this.emptyText.content = text;
  }

  /** Size the row pool from the layout arithmetic of the owning view. */
  sync(rows: number, rowWidth: number): void {
    this.rowW = Math.max(20, rowWidth);
    this.ensureRows(Math.max(0, rows));
    this.ensureVisible();
  }

  /** Safety net: if Yoga disagrees with the view's arithmetic, resize the pool afterwards. */
  private onRowsResize(): void {
    // Layout callbacks run inside the render pass; never mutate the tree synchronously here.
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.disposed) return;
      const h = Math.max(0, this.rowsBox.height);
      const w = Math.max(20, this.rowsBox.width);
      if (h === this.rows.length && w === this.rowW) return;
      if (w !== this.rowW) {
        this.rowW = w;
        this.opts.onResize?.(w);
      }
      this.ensureRows(h);
      this.ensureVisible();
      this.renderRows();
    }, 0);
    this.timers.add(t);
  }

  private ensureRows(n: number): void {
    while (this.rows.length < n) {
      const i = this.rows.length;
      const box = new BoxRenderable(this.r, {
        id: `${this.opts.id}-row-${i}`,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        overflow: "hidden",
        backgroundColor: "transparent",
        onMouseDown: (e) => this.onRowMouseDown(i, e),
        onMouseOver: () => this.setHover(i),
        onMouseOut: () => {
          if (this.hover === this.top + i) this.setHover(-1);
        },
      });
      const text = new TextRenderable(this.r, {
        id: `${this.opts.id}-row-${i}-text`,
        content: "",
        height: 1,
        flexGrow: 1,
        wrapMode: "none",
        fg: theme.text,
        selectable: false,
      });
      box.add(text);
      this.rowsBox.add(box);
      this.rows.push({ box, text });
    }
    while (this.rows.length > n) {
      const row = this.rows.pop()!;
      this.rowsBox.remove(row.box);
      row.box.destroyRecursively();
    }
  }

  // ---- items and selection

  private canSelect(item: T | undefined): boolean {
    return item !== undefined && (this.opts.selectable?.(item) ?? true);
  }

  /** Replace the items, keeping the selected item when it is still there. */
  setItems(items: T[], resetOnMiss = false): void {
    const prevKey = this.selectedKey;
    this.items = items;
    let idx = prevKey
      ? items.findIndex((it) => this.opts.key(it) === prevKey)
      : -1;
    if (idx < 0 || !this.canSelect(items[idx])) {
      if (items.length === 0) idx = -1;
      else if (resetOnMiss || this.sel < 0) idx = this.nearestSelectable(0, 1);
      else
        idx = this.nearestSelectable(Math.min(this.sel, items.length - 1), -1);
    }
    this.sel = idx;
    this.selectedKey = idx >= 0 ? this.opts.key(items[idx]!) : null;
    if (resetOnMiss && idx >= 0 && idx === this.nearestSelectable(0, 1))
      this.top = 0;
    this.ensureVisible();
  }

  private nearestSelectable(from: number, dir: 1 | -1): number {
    const n = this.items.length;
    if (n === 0) return -1;
    const start = Math.max(0, Math.min(from, n - 1));
    for (let i = start; i >= 0 && i < n; i += dir)
      if (this.canSelect(this.items[i])) return i;
    for (let i = start; i >= 0 && i < n; i -= dir)
      if (this.canSelect(this.items[i])) return i;
    return -1;
  }

  selected(): T | undefined {
    return this.sel >= 0 ? this.items[this.sel] : undefined;
  }

  select(idx: number, dir: 1 | -1 = 1): void {
    if (this.items.length === 0) {
      this.sel = -1;
      this.selectedKey = null;
      return;
    }
    const i = this.nearestSelectable(idx, dir);
    this.sel = i;
    this.selectedKey = i >= 0 ? this.opts.key(this.items[i]!) : null;
    this.ensureVisible();
    this.opts.onSelect?.();
  }

  selectKey(key: string): boolean {
    const idx = this.items.findIndex((it) => this.opts.key(it) === key);
    if (idx < 0) return false;
    this.select(idx);
    return true;
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    const from = this.sel < 0 ? 0 : this.sel;
    let target = Math.max(0, Math.min(from + delta, this.items.length - 1));
    const dir: 1 | -1 = delta < 0 ? -1 : 1;
    // Step over headings in the direction of travel; stay put if nothing selectable lies that way.
    while (
      target >= 0 &&
      target < this.items.length &&
      !this.canSelect(this.items[target])
    )
      target += dir;
    if (target < 0 || target >= this.items.length) return;
    this.select(target, dir);
  }

  pageSize(): number {
    return Math.max(1, this.rows.length - 1);
  }

  scrollBy(delta: number): void {
    const maxTop = Math.max(0, this.items.length - this.rows.length);
    this.top = Math.max(0, Math.min(this.top + delta, maxTop));
    this.renderRows();
  }

  ensureVisible(): void {
    const n = this.rows.length;
    if (n <= 0 || this.sel < 0) return;
    if (this.sel < this.top) this.top = this.sel;
    else if (this.sel >= this.top + n) this.top = this.sel - n + 1;
    // Keep a heading directly above the first selectable row in view.
    if (
      this.sel === this.top &&
      this.sel > 0 &&
      !this.canSelect(this.items[this.sel - 1]) &&
      n > 1
    )
      this.top = this.sel - 1;
    const maxTop = Math.max(0, this.items.length - n);
    if (this.top > maxTop) this.top = maxTop;
    if (this.top < 0) this.top = 0;
  }

  /** Movement keys shared by every list; returns true when the key moved the selection. */
  navKey(key: KeyEvent): boolean {
    const k = key.name;
    const ctrl = key.ctrl;
    const shift = key.shift;
    if (k === "up" || (k === "k" && !ctrl)) this.move(-1);
    else if (k === "down" || (k === "j" && !ctrl)) this.move(1);
    else if (k === "pageup" || (ctrl && (k === "u" || k === "b")))
      this.move(-this.pageSize());
    else if (k === "pagedown" || (ctrl && (k === "d" || k === "f")))
      this.move(this.pageSize());
    else if (k === "home" || (k === "g" && !shift)) this.select(0, 1);
    else if (k === "end" || (k === "g" && shift))
      this.select(this.items.length - 1, -1);
    else return false;
    return true;
  }

  // ---- mouse

  private setHover(i: number): void {
    const idx = i >= 0 ? this.top + i : -1;
    if (idx === this.hover) return;
    this.hover = idx;
    const item = this.items[idx];
    pointer(this.r, idx >= 0 && this.canSelect(item) ? "pointer" : "default");
    this.renderRows();
  }

  private onRowMouseDown(i: number, e: MouseEvent): void {
    const idx = this.top + i;
    const item = this.items[idx];
    if (!item || !this.canSelect(item) || this.empty !== null) return;
    if (e.button === 2) {
      this.select(idx);
      this.opts.onRightClick?.(item);
      return;
    }
    if (e.button === 1) {
      this.select(idx);
      this.opts.onMiddleClick?.(item);
      return;
    }
    if (e.button !== 0) return;
    this.opts.onRowClick?.();
    const now = Date.now();
    const isDouble =
      this.lastClick.index === idx && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { index: idx, at: isDouble ? 0 : now };
    this.select(idx);
    if (isDouble) this.opts.onActivate?.(item);
  }

  // ---- rendering

  renderRows(): void {
    if (this.disposed) return;
    const n = this.rows.length;
    const maxTop = Math.max(0, this.items.length - n);
    if (this.top > maxTop) this.top = maxTop;
    if (this.top < 0) this.top = 0;
    for (let i = 0; i < n; i++) {
      const idx = this.top + i;
      const row = this.rows[i]!;
      const item = this.items[idx];
      if (item === undefined) {
        row.text.content = "";
        row.box.backgroundColor = "transparent";
        continue;
      }
      const selected = idx === this.sel;
      row.text.content = styled(
        trimChunks(this.opts.row(item, selected, this.rowW), this.rowW),
      );
      row.box.backgroundColor = selected
        ? theme.selBg
        : idx === this.hover && this.canSelect(item)
          ? theme.hoverBg
          : "transparent";
    }
    this.scrollbar.scrollSize = this.items.length;
    this.scrollbar.viewportSize = n;
    this.scrollbar.scrollPosition = this.top;
  }
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

export const DETAILS_WIDTH = 46;
/** Inner text width of the details panel: border and padding on both sides. */
export const DETAILS_INNER = DETAILS_WIDTH - 4;

/** The fixed-width panel on the right: key/value text above a row of action chips. */
export class DetailsPanel {
  readonly box: BoxRenderable;
  readonly text: TextRenderable;
  readonly buttons: BoxRenderable;

  constructor(r: CliRenderer, id: string, title = "Details") {
    this.box = new BoxRenderable(r, {
      id: `${id}-details`,
      width: DETAILS_WIDTH,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title: ` ${title} `,
      titleColor: theme.textDim,
      flexDirection: "column",
      paddingX: 1,
      overflow: "hidden",
    });
    this.text = new TextRenderable(r, {
      id: `${id}-details-text`,
      content: "",
      flexGrow: 1,
      wrapMode: "none",
      fg: theme.text,
    });
    this.buttons = new BoxRenderable(r, {
      id: `${id}-buttons`,
      height: 1,
      flexDirection: "row",
      gap: 1,
      flexShrink: 0,
    });
    this.box.add(this.text);
    this.box.add(this.buttons);
  }

  get visible(): boolean {
    return this.box.visible;
  }

  set visible(v: boolean) {
    this.box.visible = v;
  }

  set(chunks: TextChunk[]): void {
    this.text.content = styled(chunks);
  }

  addButton(chip: Chip): Chip {
    this.buttons.add(chip.box);
    return chip;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function makeLabel(
  r: CliRenderer,
  id: string,
  text: string,
): TextRenderable {
  return new TextRenderable(r, {
    id,
    content: text,
    fg: theme.textMuted,
    height: 1,
    selectable: false,
  });
}

/** A bordered panel with a title, as used for the dashboard's sections. */
export function makePanel(
  r: CliRenderer,
  id: string,
  title: string,
  opts: { width?: number; flexGrow?: number; height?: number } = {},
): BoxRenderable {
  return new BoxRenderable(r, {
    id,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    title: ` ${title} `,
    titleColor: theme.textDim,
    width: opts.width,
    height: opts.height,
    flexGrow: opts.flexGrow,
    flexShrink: 1,
    flexDirection: "column",
    paddingX: 1,
    overflow: "hidden",
  });
}
