// What this device shares: local servers and folders served to the tailnet or, with Funnel, to
// the internet; Taildrive folders; and the Taildrop inbox.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { KeyEvent, TextChunk } from "@opentui/core";
import { openUrl } from "../actions";
import { cliError } from "../backend/cli";
import {
  driveList,
  driveShareName,
  normalizeServeTarget,
  parseFileGet,
  serveAddress,
  serveStatus,
  serveTarget,
  type DriveShare,
  type ReceivedFile,
  type ServeEntry,
} from "../backend/share";
import { fit, humanBytes, relTime, truncate } from "../format";
import { theme } from "../theme";
import {
  DetailsPanel,
  btn,
  ch,
  setChip,
  type Chip,
  type ChipStyle,
  type Lines,
} from "../ui";
import { ListView, prose } from "./list-view";

type AddId = "serve" | "funnel" | "drive";

type Item =
  | { kind: "heading"; label: string }
  | { kind: "serve"; e: ServeEntry }
  | { kind: "add"; id: AddId; label: string }
  | {
      kind: "note";
      id: string;
      label: string;
      value: string;
      explain: string;
      warn?: boolean;
    }
  | { kind: "drive"; share: DriveShare }
  | { kind: "receive" }
  | { kind: "received"; file: ReceivedFile };

const KIND_LABEL: Record<ServeEntry["kind"], string> = {
  proxy: "reverse proxy",
  path: "files",
  text: "static text",
  tcp: "TCP forward",
};

/** ~/Downloads when it exists, the home directory otherwise. */
function defaultInbox(): string {
  const dl = join(homedir(), "Downloads");
  return existsSync(dl) ? dl : homedir();
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function expand(path: string): string {
  return path.startsWith("~") ? homedir() + path.slice(1) : path;
}

export class SharingView extends ListView<Item> {
  readonly id = "sharing" as const;
  readonly title = "Sharing";
  readonly short = "Share";

  private serves: ServeEntry[] | null = null;
  private serveError: string | null = null;
  private drives: DriveShare[] | null = null;
  private driveError: string | null = null;
  private received: ReceivedFile[] = [];
  private inbox = defaultInbox();
  private buttons: Chip[] = [];

  protected listTitle(): string {
    return "Sharing";
  }

  protected helpLines(): [string, string][] {
    return [
      [
        "Served",
        "Enter or o open · y or c copy the URL · f public on/off (Funnel) · x stop sharing",
      ],
      [
        "Add",
        "Enter on a + row: share a port, URL or folder on the tailnet or the internet",
      ],
      [
        "Taildrive",
        "Enter copies the share's path · e rename · x stop sharing",
      ],
      [
        "Taildrop",
        "Enter on Receive moves waiting files into the folder · u picks another folder",
      ],
    ];
  }

  protected override buildDetails(d: DetailsPanel): void {
    for (let i = 0; i < 4; i++)
      this.buttons.push(
        d.addButton(
          this.chip(`btn-${i}`, "", () =>
            this.withSelected((it) => this.button(it, i)),
          ),
        ),
      );
  }

  override onShow(select?: string): void {
    super.onShow(select);
    this.reload();
  }

  reload(): void {
    void this.loadServe();
    void this.loadDrive();
  }

  private async loadServe(): Promise<void> {
    try {
      this.serves = await serveStatus(
        this.ctx.backend,
        this.ctx.state?.self?.dnsName ?? "",
      );
      this.serveError = null;
    } catch (e) {
      this.serveError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private async loadDrive(): Promise<void> {
    try {
      this.drives = await driveList(this.ctx.backend);
      this.driveError = null;
    } catch (e) {
      this.drives = null;
      this.driveError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private withSelected(fn: (it: Item) => void): void {
    const it = this.selected();
    if (it) fn(it);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  protected allItems(): Item[] {
    const items: Item[] = [
      { kind: "heading", label: "Served from this device" },
    ];
    if (this.serveError)
      items.push({
        kind: "note",
        id: "serve-error",
        label: "Serve",
        value: "could not read",
        explain: this.serveError,
        warn: true,
      });
    else if (this.serves === null)
      items.push({
        kind: "note",
        id: "serve-loading",
        label: "Serve",
        value: "reading…",
        explain: "Reading tailscale serve status.",
      });
    else if (this.serves.length === 0)
      items.push({
        kind: "note",
        id: "serve-none",
        label: "Nothing is served",
        value: "",
        explain:
          "Serve puts a local web server, folder or TCP port on this device's tailnet name, with HTTPS certificates handled for you. Funnel does the same on the public internet.",
      });
    for (const e of this.serves ?? []) items.push({ kind: "serve", e });
    items.push({ kind: "add", id: "serve", label: "Share on the tailnet" });
    items.push({ kind: "add", id: "funnel", label: "Share on the internet" });

    items.push({ kind: "heading", label: "Taildrive" });
    if (this.driveError)
      items.push({
        kind: "note",
        id: "drive-off",
        label: "Not available",
        value: /not enabled/i.test(this.driveError)
          ? "needs the drive:share attribute"
          : "could not read",
        explain: /not enabled/i.test(this.driveError)
          ? 'Taildrive shares folders with the tailnet over WebDAV. An admin enables it by giving this device the "drive:share" node attribute in the tailnet policy file.'
          : this.driveError,
        warn: !/not enabled/i.test(this.driveError),
      });
    else if (this.drives === null)
      items.push({
        kind: "note",
        id: "drive-loading",
        label: "Taildrive",
        value: "reading…",
        explain: "Reading tailscale drive list.",
      });
    else {
      for (const share of this.drives) items.push({ kind: "drive", share });
      items.push({ kind: "add", id: "drive", label: "Share a folder" });
    }

    items.push({ kind: "heading", label: "Taildrop" });
    items.push({ kind: "receive" });
    for (const file of this.received) items.push({ kind: "received", file });
    return items;
  }

  protected key(it: Item): string {
    switch (it.kind) {
      case "heading":
        return `h:${it.label}`;
      case "serve":
        return `s:${it.e.id}:${it.e.foreground}`;
      case "add":
        return `a:${it.id}`;
      case "note":
        return `n:${it.id}`;
      case "drive":
        return `d:${it.share.name}`;
      case "receive":
        return "r";
      case "received":
        return `f:${it.file.path}`;
    }
  }

  protected override selectable(it: Item): boolean {
    return it.kind !== "heading";
  }

  protected override emptyText(): string | null {
    return null;
  }

  protected override renderTitle(): void {
    const n = (this.serves?.length ?? 0) + (this.drives?.length ?? 0);
    const pub = this.serves?.filter((e) => e.funnel).length ?? 0;
    const count =
      n === 0
        ? "nothing shared"
        : `${n} shared${pub ? ` · ${pub} public` : ""}`;
    this.list.setTitle(` Sharing · ${count} ${this.ctx.busyTitle()}`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  protected row(it: Item, selected: boolean, w: number): TextChunk[] {
    const mark = ch(selected ? "▸" : " ", { fg: theme.accent, bold: true });
    switch (it.kind) {
      case "heading":
        return [
          ch(" "),
          ch(it.label.toUpperCase(), { fg: theme.textDim, bold: true }),
        ];
      case "serve": {
        const e = it.e;
        const scope = e.funnel ? "public" : "tailnet";
        const scopeW = 8;
        const urlW = Math.min(
          44,
          Math.max(16, Math.floor((w - 3 - scopeW - 4) / 2) + 4),
        );
        const targetW = Math.max(8, w - 3 - urlW - 3 - scopeW - 1);
        return [
          mark,
          ch("●", { fg: e.funnel ? theme.orange : theme.cyan }),
          ch(" "),
          ch(fit(e.url.replace(/^https:\/\//, ""), urlW), { fg: theme.text }),
          ch(" → ", { fg: theme.textMuted }),
          ch(fit(tilde(e.target), targetW), { fg: theme.textDim }),
          ch(" "),
          ch(fit(scope, scopeW, "right"), {
            fg: e.funnel ? theme.orange : theme.cyan,
            bold: e.funnel,
          }),
        ];
      }
      case "add":
        return [
          mark,
          ch("+", { fg: theme.accent, bold: true }),
          ch(" "),
          ch(`${it.label}…`, { fg: theme.accent }),
        ];
      case "note":
        return [
          mark,
          it.warn
            ? ch("⚠", { fg: theme.yellow, bold: true })
            : ch("○", { fg: theme.textMuted }),
          ch(" "),
          ch(fit(it.label, 20), { fg: it.warn ? theme.yellow : theme.textDim }),
          ch(" "),
          ch(truncate(it.value, Math.max(8, w - 24)), { fg: theme.textMuted }),
        ];
      case "drive":
        return [
          mark,
          ch("●", { fg: theme.cyan }),
          ch(" "),
          ch(fit(it.share.name, 20), { fg: theme.text }),
          ch(" "),
          ch(truncate(tilde(it.share.path), Math.max(8, w - 24)), {
            fg: theme.textDim,
          }),
        ];
      case "receive":
        return [
          mark,
          ch("↓", { fg: theme.accent, bold: true }),
          ch(" "),
          ch(fit("Receive files", 20), { fg: theme.accent }),
          ch(" "),
          ch(truncate(`into ${tilde(this.inbox)}`, Math.max(8, w - 24)), {
            fg: theme.textDim,
          }),
        ];
      case "received":
        return [
          mark,
          ch("✓", { fg: theme.green }),
          ch(" "),
          ch(fit(it.file.name, 20), { fg: theme.text }),
          ch(" "),
          ch(
            truncate(
              `${humanBytes(it.file.bytes)} · ${relTime(new Date(it.file.at))}`,
              Math.max(8, w - 24),
            ),
            { fg: theme.textMuted },
          ),
        ];
    }
  }

  protected describe(it: Item | undefined, L: Lines): void {
    if (!it || it.kind === "heading") {
      L.line(ch("Select an item to see its details.", { fg: theme.textMuted }));
      return;
    }
    switch (it.kind) {
      case "serve": {
        const e = it.e;
        L.title(e.url.replace(/^https:\/\//, ""));
        L.line(
          e.funnel
            ? ch("● public on the internet (Funnel)", {
                fg: theme.orange,
                bold: true,
              })
            : ch("● tailnet only", { fg: theme.cyan }),
        );
        L.blank();
        L.kvText("Target", tilde(e.target));
        L.kvText("Kind", KIND_LABEL[e.kind], { fg: theme.textDim });
        L.kvText(
          "Listener",
          `${e.proto.toUpperCase()} port ${e.port}${e.mount ? `, path ${e.mount}` : ""}`,
          { fg: theme.textDim },
        );
        if (e.foreground)
          L.kv(
            "Started",
            ch("by a tailscale serve in a terminal", { fg: theme.yellow }),
          );
        L.blank();
        prose(
          L,
          e.funnel
            ? "Anyone on the internet who has the URL can reach it. f makes it tailnet only again."
            : "Devices in your tailnet reach it at this URL, with a valid HTTPS certificate. f makes it public with Funnel.",
        );
        return;
      }
      case "add":
        if (it.id === "drive") {
          L.title("Share a folder");
          L.blank();
          prose(
            L,
            "Share a folder with your tailnet over Taildrive. Other devices mount it over WebDAV at http://100.100.100.100:8080.",
            theme.text,
          );
          return;
        }
        L.title(
          it.id === "funnel" ? "Share on the internet" : "Share on the tailnet",
        );
        L.blank();
        prose(
          L,
          it.id === "funnel"
            ? "Publish a local port, URL or folder at this device's name on the public internet with Funnel. The tailnet policy must allow Funnel for this device."
            : "Publish a local port, URL or folder at this device's name, for your tailnet only, with HTTPS handled for you.",
          theme.text,
        );
        L.blank();
        L.kv("Examples", ch("3000", { fg: theme.textDim }));
        L.kv("", ch("localhost:8080", { fg: theme.textDim }));
        L.kv("", ch("~/public", { fg: theme.textDim }));
        return;
      case "note":
        L.title(it.label, {
          fg: it.warn ? theme.yellow : theme.text,
          bold: true,
        });
        if (it.value)
          L.line(ch(truncate(it.value, L.width), { fg: theme.textDim }));
        L.blank();
        prose(L, it.explain, theme.text);
        return;
      case "drive": {
        const sh = it.share;
        const s = this.ctx.state;
        L.title(sh.name);
        L.line(ch("Taildrive folder", { fg: theme.textDim }));
        L.blank();
        L.kvText("Folder", tilde(sh.path));
        if (sh.as) L.kvText("Access as", sh.as, { fg: theme.textDim });
        if (s?.tailnet && s.self)
          L.kvText("WebDAV", `/${s.tailnet}/${s.self.name}/${sh.name}`, {
            fg: theme.textDim,
          });
        L.blank();
        prose(
          L,
          "Other devices with drive:access mount it from http://100.100.100.100:8080.",
        );
        return;
      }
      case "receive":
        L.title("Receive files");
        L.blank();
        L.kvText("Folder", tilde(this.inbox));
        L.blank();
        prose(
          L,
          "Files sent to this device with Taildrop wait in its inbox until they are received. Enter moves them into the folder; same-named files get a number.",
          theme.text,
        );
        return;
      case "received":
        L.title(it.file.name);
        L.line(
          ch(`received ${relTime(new Date(it.file.at))}`, {
            fg: theme.textDim,
          }),
        );
        L.blank();
        L.kvText("Saved as", tilde(it.file.path));
        L.kvText("Size", humanBytes(it.file.bytes));
        return;
    }
  }

  private buttonDefs(it: Item | undefined): [string, ChipStyle][] {
    if (!it) return [];
    const armed = this.ctx.armed();
    switch (it.kind) {
      case "serve": {
        const e = it.e;
        const stop: [string, ChipStyle] = [
          armed === `stop:${e.id}` ? "Confirm stop" : "Stop",
          btn.danger,
        ];
        const scope: [string, ChipStyle] = e.funnel
          ? ["Tailnet only", btn.normal]
          : [
              armed === `public:${e.id}` ? "Confirm public" : "Make public",
              btn.normal,
            ];
        return e.kind === "tcp"
          ? [["Copy URL", btn.normal], stop]
          : [["Open", btn.primary], ["Copy URL", btn.normal], scope, stop];
      }
      case "add":
        return [[it.id === "drive" ? "Share a folder" : "Share…", btn.primary]];
      case "drive":
        return [
          ["Copy path", btn.normal],
          ["Rename", btn.normal],
          [
            armed === `unshare:${it.share.name}`
              ? "Confirm stop"
              : "Stop sharing",
            btn.danger,
          ],
        ];
      case "receive":
        return [
          ["Receive", btn.primary],
          ["Other folder", btn.normal],
        ];
      case "received":
        return [["Copy path", btn.normal]];
      default:
        return [];
    }
  }

  protected renderButtons(it: Item | undefined): void {
    const defs = this.buttonDefs(it);
    this.buttons.forEach((chip, i) => {
      const d = defs[i];
      chip.box.visible = d !== undefined;
      if (d) setChip(chip, d[0], d[1]);
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private button(it: Item, i: number): void {
    const label = this.buttonDefs(it)[i]?.[0] ?? "";
    if (it.kind === "serve") {
      if (label === "Open") this.open(it.e);
      else if (label === "Copy URL") this.ctx.copy(it.e.url);
      else if (label.includes("public") || label === "Tailnet only")
        void this.toggleFunnel(it.e);
      else void this.stop(it.e);
    } else if (it.kind === "drive") {
      if (i === 0) this.ctx.copy(it.share.path);
      else if (i === 1) this.renameDrive(it.share);
      else void this.unshare(it.share);
    } else if (it.kind === "receive" && i === 1) this.pickInbox();
    else this.activate(it);
  }

  protected override onListKey(key: KeyEvent): boolean {
    const it = this.selected();
    const k = key.name;
    if (!it) return false;
    if (it.kind === "serve") {
      if (k === "o") this.open(it.e);
      else if (k === "y" || k === "c") this.ctx.copy(it.e.url);
      else if (k === "f") void this.toggleFunnel(it.e);
      else if (k === "x" || k === "delete" || k === "backspace")
        void this.stop(it.e);
      else return false;
      return true;
    }
    if (it.kind === "drive") {
      if (k === "y" || k === "c") this.ctx.copy(it.share.path);
      else if (k === "e") this.renameDrive(it.share);
      else if (k === "x" || k === "delete" || k === "backspace")
        void this.unshare(it.share);
      else return false;
      return true;
    }
    if (it.kind === "receive" && k === "u") {
      this.pickInbox();
      return true;
    }
    if (it.kind === "received" && (k === "y" || k === "c")) {
      this.ctx.copy(it.file.path);
      return true;
    }
    return false;
  }

  protected activate(it: Item): void {
    switch (it.kind) {
      case "serve":
        if (it.e.kind === "tcp") this.ctx.copy(it.e.url);
        else this.open(it.e);
        return;
      case "add":
        if (it.id === "drive") this.shareFolder();
        else this.addServe(it.id === "funnel");
        return;
      case "drive":
        this.ctx.copy(it.share.path);
        return;
      case "receive":
        void this.receive();
        return;
      case "received":
        this.ctx.copy(it.file.path);
        return;
    }
  }

  private open(e: ServeEntry): void {
    openUrl(this.ctx, e.url);
  }

  private async run(
    label: string,
    args: string[],
    what: string,
    ok: string,
  ): Promise<void> {
    await this.ctx.runAction(
      label,
      async () => {
        const res = await this.ctx.backend.cli(args, {
          privileged: true,
          timeoutMs: 30_000,
        });
        if (res.code !== 0) throw cliError(res, what);
      },
      { refresh: false, onOk: () => this.ctx.notify(ok, "ok") },
    );
    await this.loadServe();
  }

  private addServe(publicly: boolean): void {
    this.ctx.prompt({
      title: publicly
        ? "Share on the internet (Funnel)"
        : "Share on the tailnet",
      label: "Local port, URL or folder",
      placeholder: "3000   localhost:8080   ~/public",
      confirm: publicly ? "Make public" : "Share",
      completePaths: true,
      hint: publicly
        ? "Anyone with the URL can reach it. Served on HTTPS port 443."
        : "Served at this device's name on HTTPS port 443, for your tailnet only.",
      onSubmit: (input) => {
        const target = normalizeServeTarget(input);
        if (!target)
          return "Enter a port (3000), a local URL (localhost:8080) or a folder path";
        const arg = target.startsWith("~") ? expand(target) : target;
        if (arg.startsWith("/") && !existsSync(arg))
          return "No such folder or file";
        void this.run(
          publicly ? "Publishing with Funnel" : "Sharing on the tailnet",
          [publicly ? "funnel" : "serve", "--bg", arg],
          publicly ? "tailscale funnel" : "tailscale serve",
          publicly
            ? `${tilde(arg)} is public`
            : `${tilde(arg)} is shared on the tailnet`,
        );
      },
    });
  }

  private async toggleFunnel(e: ServeEntry): Promise<void> {
    if (e.kind === "tcp" || e.foreground) {
      this.ctx.notify(
        e.foreground
          ? "Started from a terminal; change it there"
          : "Funnel applies to web shares here",
        "info",
      );
      return;
    }
    if (
      !e.funnel &&
      !this.ctx.confirm(
        `public:${e.id}`,
        `Make ${e.url} reachable from the internet? Press again to confirm.`,
      )
    ) {
      this.render();
      return;
    }
    await this.run(
      e.funnel ? "Making it tailnet only" : "Publishing with Funnel",
      [
        e.funnel ? "serve" : "funnel",
        "--bg",
        ...serveAddress(e),
        serveTarget(e),
      ],
      e.funnel ? "tailscale serve" : "tailscale funnel",
      e.funnel ? `${e.url} is tailnet only` : `${e.url} is public`,
    );
  }

  private async stop(e: ServeEntry): Promise<void> {
    if (e.foreground) {
      this.ctx.notify(
        "Started by tailscale serve in a terminal; stop it there",
        "info",
      );
      return;
    }
    if (
      !this.ctx.confirm(
        `stop:${e.id}`,
        `Stop sharing ${e.url}? Press again to confirm.`,
      )
    ) {
      this.render();
      return;
    }
    await this.run(
      "Stopping",
      ["serve", ...serveAddress(e), "off"],
      "tailscale serve",
      `Stopped sharing ${e.url}`,
    );
  }

  private shareFolder(): void {
    this.ctx.prompt({
      title: "Share a folder with Taildrive",
      label: "Folder",
      placeholder: "~/Documents",
      value: "~/",
      confirm: "Share",
      completePaths: true,
      hint: "The share is named after the folder; e renames it later.",
      onSubmit: (input) => {
        const path = expand(input.replace(/\/+$/, ""));
        if (!path || !existsSync(path)) return "No such folder";
        const name = driveShareName(basename(path)) || "share";
        void this.driveRun(
          `Sharing ${name}`,
          ["drive", "share", name, path],
          `${tilde(path)} is shared as ${name}`,
        );
      },
    });
  }

  private renameDrive(sh: DriveShare): void {
    this.ctx.prompt({
      title: `Rename ${sh.name}`,
      label: "New name",
      value: sh.name,
      confirm: "Rename",
      hint: "Lowercase letters, underscores, parentheses and spaces.",
      onSubmit: (input) => {
        const name = driveShareName(input);
        if (!name)
          return "Use lowercase letters, underscores, parentheses or spaces";
        if (name === sh.name) return;
        void this.driveRun(
          `Renaming ${sh.name}`,
          ["drive", "rename", sh.name, name],
          `Renamed ${sh.name} to ${name}`,
        );
      },
    });
  }

  private async unshare(sh: DriveShare): Promise<void> {
    if (
      !this.ctx.confirm(
        `unshare:${sh.name}`,
        `Stop sharing ${sh.name}? Press again to confirm.`,
      )
    ) {
      this.render();
      return;
    }
    await this.driveRun(
      `Unsharing ${sh.name}`,
      ["drive", "unshare", sh.name],
      `Stopped sharing ${sh.name}`,
    );
  }

  private async driveRun(
    label: string,
    args: string[],
    ok: string,
  ): Promise<void> {
    await this.ctx.runAction(
      label,
      async () => {
        const res = await this.ctx.backend.cli(args, {
          privileged: true,
          timeoutMs: 15_000,
        });
        if (res.code !== 0) throw cliError(res, "Taildrive");
      },
      { refresh: false, onOk: () => this.ctx.notify(ok, "ok") },
    );
    await this.loadDrive();
  }

  private pickInbox(): void {
    this.ctx.prompt({
      title: "Receive files into",
      label: "Folder",
      value: `${tilde(this.inbox)}/`,
      confirm: "Use folder",
      completePaths: true,
      onSubmit: (input) => {
        const dir = expand(input.replace(/\/+$/, "")) || "/";
        if (!existsSync(dir)) return "No such folder";
        this.inbox = dir;
        this.render();
      },
    });
  }

  private async receive(): Promise<void> {
    let got: ReceivedFile[] = [];
    await this.ctx.runAction(
      "Receiving files",
      async () => {
        const res = await this.ctx.backend.cli(
          ["file", "get", "--verbose", "--conflict=rename", this.inbox],
          { privileged: true, timeoutMs: 10 * 60_000 },
        );
        if (res.code !== 0) throw cliError(res, "tailscale file get");
        got = parseFileGet(`${res.stdout}\n${res.stderr}`);
      },
      {
        refresh: false,
        onOk: () => {
          if (got.length === 0) this.ctx.notify("No files are waiting", "info");
          else
            this.ctx.notify(
              `Received ${got.length} file${got.length === 1 ? "" : "s"} into ${tilde(this.inbox)}`,
              "ok",
            );
        },
      },
    );
    this.received = [...got, ...this.received].slice(0, 50);
    this.render();
  }
}
