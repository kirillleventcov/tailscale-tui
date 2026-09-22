// The exit-node screen's layout as a base class: a toolbar with a search box and chips, a list on
// the left, a details panel on the right. Devices, Network, Sharing and Settings extend it, so
// search, focus, movement, the details toggle and the empty states behave identically everywhere.
import {
  BoxRenderable,
  InputRenderableEvents,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { wrapText } from "../format";
import { tokenize } from "../model";
import { theme } from "../theme";
import {
  DETAILS_INNER,
  DETAILS_WIDTH,
  DetailsPanel,
  Lines,
  ListPanel,
  SearchBox,
  ch,
  makeChip,
  type Chip,
} from "../ui";
import type { View, ViewContext, ViewId } from "../view";

const DETAILS_MIN_TOTAL = 100;
const COMPACT_HEIGHT = 21;

export abstract class ListView<T> implements View {
  abstract readonly id: ViewId;
  abstract readonly title: string;
  abstract readonly short: string;

  protected ctx!: ViewContext;
  protected r!: CliRenderer;
  protected list!: ListPanel<T>;
  protected details!: DetailsPanel;
  protected toolbar!: BoxRenderable;
  protected search: SearchBox | null = null;
  protected mode: "list" | "search" = "list";
  protected queryText = "";
  protected width = 120;
  protected height = 33;
  private detailsWanted = true;
  private total = 0;

  // ---- what a view provides

  /** Title of the list panel, without the count. */
  protected abstract listTitle(): string;
  /** Every item before the search is applied. */
  protected abstract allItems(): T[];
  protected abstract key(item: T): string;
  protected abstract row(
    item: T,
    selected: boolean,
    width: number,
  ): TextChunk[];
  /** Lines of the details panel for the selected item. */
  protected abstract describe(item: T | undefined, L: Lines): void;
  /** Recolor the details panel's chips for the selected item. */
  protected abstract renderButtons(item: T | undefined): void;
  /** Enter and double-click. */
  protected abstract activate(item: T): void;
  /** Search placeholder; null means the view has no search box. */
  protected searchPlaceholder(): string | null {
    return null;
  }
  /** Text the search matches against. */
  protected haystack(_item: T): string {
    return "";
  }
  /** Column header chunks; null hides the header row. */
  protected header(_width: number): TextChunk[] | null {
    return null;
  }
  protected onHeaderClick(_x: number): void {}
  /** Items that are section headings and cannot be selected. */
  protected selectable(_item: T): boolean {
    return true;
  }
  /** Count shown as "shown of total" in the title; defaults to every selectable item. */
  protected totalCount(all: T[]): number {
    return all.filter((t) => this.selectable(t)).length;
  }
  /** Message shown instead of the rows; null shows them. */
  protected emptyText(shown: number, total: number): string | null {
    const s = this.ctx.state;
    if (!s)
      return this.ctx.error
        ? `Could not read Tailscale status.\n${this.ctx.error}`
        : "Loading…";
    if (total > 0 && shown === 0)
      return `Nothing matches "${this.queryText}".\nEsc clears the search.`;
    return null;
  }
  /** Chips after the search box. */
  protected buildToolbar(_toolbar: BoxRenderable): void {}
  /** Show or hide toolbar chips for the width; every chip needs a key. */
  protected layoutToolbar(_width: number): void {}
  protected renderToolbar(): void {}
  /** View-specific keys in list mode; return true when handled. */
  protected onListKey(_key: KeyEvent): boolean {
    return false;
  }
  protected onRightClick(_item: T): void {}
  protected onMiddleClick(_item: T): void {}
  /** Extra help lines after the common ones. */
  protected abstract helpLines(): [string, string][];

  help(): [string, string][] {
    const nav: [string, string] = [
      "Navigate",
      `↑/k ↓/j move · PgUp/PgDn page · Home/g End/G${this.search ? " · Tab or / search" : ""}`,
    ];
    const lines: [string, string][] = [nav, ...this.helpLines()];
    if (this.search)
      lines.push([
        "In search",
        "type to filter · !word excludes · Enter apply and back · Esc clear and back",
      ]);
    lines.push(["Panel", "i shows or hides the details panel"]);
    return lines;
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  build(ctx: ViewContext, parent: BoxRenderable): void {
    this.ctx = ctx;
    this.r = ctx.r;
    const r = ctx.r;
    const id = this.id;
    this.toolbar = new BoxRenderable(r, {
      id: `${id}-toolbar`,
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      paddingX: 1,
      gap: 1,
    });
    const placeholder = this.searchPlaceholder();
    if (placeholder !== null) {
      this.search = new SearchBox(r, id, placeholder, () => this.focusSearch());
      this.toolbar.add(this.search.box);
      this.search.input.on(InputRenderableEvents.INPUT, () => {
        const v = this.search!.input.value;
        if (v === this.queryText) return;
        this.queryText = v;
        this.requery(true);
        this.render();
      });
      r.on("focused_renderable", (current) => {
        const searching = current === this.search!.input;
        if (searching !== (this.mode === "search")) {
          this.mode = searching ? "search" : "list";
          this.updateFocus();
        }
      });
    }
    this.buildToolbar(this.toolbar);

    const main = new BoxRenderable(r, {
      id: `${id}-main`,
      flexGrow: 1,
      flexDirection: "row",
      paddingX: 1,
      gap: 1,
    });
    this.list = new ListPanel<T>(r, {
      id,
      title: this.listTitle(),
      key: (t) => this.key(t),
      row: (t, selected, w) => this.row(t, selected, w),
      selectable: (t) => this.selectable(t),
      onHeaderClick: (x) => this.onHeaderClick(x),
      onSelect: () => this.render(),
      onActivate: (t) => this.activate(t),
      onRightClick: (t) => this.onRightClick(t),
      onMiddleClick: (t) => this.onMiddleClick(t),
      onRowClick: () => {
        if (this.mode === "search") this.focusList();
      },
    });
    this.details = new DetailsPanel(r, id);
    this.buildDetails(this.details);
    main.add(this.list.panel);
    main.add(this.details.box);
    parent.add(this.toolbar);
    parent.add(main);
  }

  /** Add the details panel's chips. */
  protected buildDetails(_details: DetailsPanel): void {}

  protected chip(id: string, label: string, onClick: () => void): Chip {
    return makeChip(this.r, `${this.id}-${id}`, label, onClick);
  }

  dispose(): void {
    this.list.dispose();
  }

  onShow(select?: string): void {
    this.requery(false);
    if (select && !this.list.selectKey(select) && this.queryText) {
      this.setSearch("");
      this.list.selectKey(select);
    }
    this.updateFocus();
  }

  onHide(): void {
    if (this.search?.input.focused) this.search.input.blur();
    this.mode = "list";
  }

  typing(): boolean {
    return this.mode === "search";
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  layout(W: number, H: number): void {
    this.width = W;
    this.height = H;
    const compact = H < COMPACT_HEIGHT;
    const hasToolbar = this.toolbarVisible();
    const toolbarH = !hasToolbar ? 0 : compact ? 1 : 3;
    this.toolbar.visible = hasToolbar;
    this.toolbar.height = Math.max(1, toolbarH);
    this.search?.setCompact(compact);
    this.layoutToolbar(W);
    const showDetails = this.detailsWanted && W >= DETAILS_MIN_TOTAL;
    this.details.visible = showDetails;
    const headerH = this.header(80) === null ? 0 : 1;
    this.list.setHeaderVisible(headerH === 1);
    // Same arithmetic as the exit-node screen: toolbar, list border (2), column header;
    // main padding (2), details panel and gap, list border (2), scrollbar (1).
    const rowsH = Math.max(0, H - toolbarH - 2 - headerH);
    const rowsW = Math.max(
      20,
      W - 2 - (showDetails ? DETAILS_WIDTH + 1 : 0) - 3,
    );
    this.list.sync(rowsH, rowsW);
  }

  /** Views without search or chips drop the toolbar row entirely. */
  protected toolbarVisible(): boolean {
    return this.search !== null || this.toolbar.getChildrenCount() > 0;
  }

  // -------------------------------------------------------------------------
  // Data and rendering
  // -------------------------------------------------------------------------

  protected requery(resetOnMiss: boolean): void {
    const all = this.allItems();
    const tokens = tokenize(this.queryText);
    let items = all;
    if (tokens.length > 0) {
      items = all.filter((t) => {
        if (!this.selectable(t)) return true;
        const hay = this.haystack(t).toLowerCase();
        return tokens.every((tok) =>
          tok.startsWith("!") ? !hay.includes(tok.slice(1)) : hay.includes(tok),
        );
      });
      // Drop headings left without items below them.
      items = items.filter((t, i) => {
        if (this.selectable(t)) return true;
        const next = items[i + 1];
        return next !== undefined && this.selectable(next);
      });
    }
    this.total = this.totalCount(all);
    this.list.setItems(items, resetOnMiss);
  }

  selected(): T | undefined {
    return this.list.selected();
  }

  render(): void {
    this.requery(false);
    this.renderToolbar();
    this.renderTitle();
    const header = this.header(this.list.width);
    if (header) this.list.setHeader(header);
    const shown = this.list.items.filter((t) => this.selectable(t)).length;
    this.list.setEmpty(this.emptyText(shown, this.total));
    this.list.renderRows();
    this.renderDetails();
  }

  renderBusy(): void {
    this.renderTitle();
  }

  protected renderTitle(): void {
    const shown = this.list.items.filter((t) => this.selectable(t)).length;
    const count =
      shown === this.total ? `${this.total}` : `${shown} of ${this.total}`;
    this.list.setTitle(
      ` ${this.listTitle()} · ${count} ${this.ctx.busyTitle()}`,
    );
  }

  protected renderDetails(): void {
    if (!this.details.visible) return;
    const item = this.selected();
    const L = new Lines(DETAILS_INNER);
    this.describe(item, L);
    this.details.set(L.out);
    this.renderButtons(item);
  }

  protected updateFocus(): void {
    const searching = this.mode === "search";
    this.search?.setFocused(searching);
    this.list.setFocused(!searching);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  protected focusSearch(): void {
    if (!this.search) return;
    this.mode = "search";
    this.search.input.focus();
    this.updateFocus();
  }

  protected focusList(): void {
    if (this.search?.input.focused) this.search.input.blur();
    this.mode = "list";
    this.updateFocus();
  }

  protected setSearch(text: string): void {
    if (!this.search) return;
    this.search.input.value = text;
    if (this.queryText !== text) {
      this.queryText = text;
      this.requery(true);
      this.render();
    }
  }

  onKey(key: KeyEvent): boolean {
    if (this.mode === "search") return this.onSearchKey(key);
    const k = key.name;
    if (this.list.navKey(key)) {
      this.render();
      return true;
    }
    if (this.onListKey(key)) return true;
    if (k === "return") {
      const item = this.selected();
      if (item) this.activate(item);
      return true;
    }
    if (this.search && (k === "/" || k === "tab" || (key.ctrl && k === "f"))) {
      key.preventDefault();
      this.focusSearch();
      return true;
    }
    if (k === "i") {
      this.detailsWanted = !this.detailsWanted;
      if (this.detailsWanted && this.width < DETAILS_MIN_TOTAL)
        this.ctx.notify(
          `Details need at least ${DETAILS_MIN_TOTAL} columns (terminal is ${this.width})`,
          "warn",
        );
      this.layout(this.width, this.height);
      this.render();
      return true;
    }
    if (k === "escape" && this.queryText) {
      this.setSearch("");
      return true;
    }
    return false;
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
}

/** A muted paragraph wrapped to the details panel, for the few places that need a sentence. */
export function prose(
  L: Lines,
  text: string,
  fg: string = theme.textDim,
): void {
  for (const part of wrapText(text, L.width)) L.line(ch(part, { fg }));
}
