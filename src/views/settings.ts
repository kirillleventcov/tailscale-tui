// This device's settings: the account, Tailscale on or off, and every preference `tailscale set`
// takes, grouped by what it is for. Enter or space toggles a switch or edits a value; the details
// panel says what the selected setting does and the command it runs.
import type { KeyEvent, TextChunk } from "@opentui/core";
import { openUrl, startLogin, tailscaleDown, tailscaleUp } from "../actions";
import { cliError } from "../backend/cli";
import {
  getPrefs,
  listProfiles,
  type Prefs,
  type Profile,
} from "../backend/prefs";
import { fit, truncate } from "../format";
import { NAME } from "../meta";
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

export interface SettingDef {
  flag: string;
  label: string;
  group: string;
  kind: "bool" | "text" | "choice";
  choices?: string[];
  about: string;
  placeholder?: string;
  /** A warning when changing to `next` needs a second press. */
  risk?: (next: string | boolean) => string | null;
  /** Extra arguments once the change is confirmed. */
  extra?: (next: string | boolean) => string[];
  validate?: (v: string) => string | null;
  linuxOnly?: boolean;
}

const CIDR = /^[0-9a-f:.]+\/\d{1,3}$/i;

export const SETTINGS: SettingDef[] = [
  {
    flag: "exit-node-allow-lan-access",
    label: "LAN access via exit node",
    group: "Connection",
    kind: "bool",
    about:
      "While an exit node is in use, keep reaching devices on the local network: printers, a NAS, the router.",
  },
  {
    flag: "accept-routes",
    label: "Accept routes",
    group: "Routing",
    kind: "bool",
    about:
      "Use the subnet routes other devices advertise, to reach the networks behind them, like a home LAN behind a subnet router.",
  },
  {
    flag: "advertise-exit-node",
    label: "Offer exit node",
    group: "Routing",
    kind: "bool",
    about:
      "Offer this device as an exit node for the tailnet. An admin approves it in the admin console before anyone can use it.",
  },
  {
    flag: "advertise-routes",
    label: "Advertise routes",
    group: "Routing",
    kind: "text",
    placeholder: "192.168.1.0/24,10.0.0.0/8",
    about:
      "Share local subnets with the tailnet, comma-separated. An admin approves them in the admin console.",
    validate: (v) =>
      v === "" || v.split(",").every((r) => CIDR.test(r.trim()))
        ? null
        : "Use CIDR ranges separated by commas, like 192.168.1.0/24",
  },
  {
    flag: "snat-subnet-routes",
    label: "SNAT subnet routes",
    group: "Routing",
    kind: "bool",
    about:
      "Traffic to advertised subnets leaves with this device's address. Turn it off only when those subnets route Tailscale addresses back here.",
  },
  {
    flag: "stateful-filtering",
    label: "Stateful filtering",
    group: "Routing",
    kind: "bool",
    about:
      "Drop forwarded packets that do not belong to a connection opened from the tailnet side. Applies to subnet routers and exit nodes.",
  },
  {
    flag: "advertise-connector",
    label: "App connector",
    group: "Routing",
    kind: "bool",
    about:
      "Act as an app connector: route traffic for the domains the tailnet policy assigns to this device.",
  },
  {
    flag: "accept-dns",
    label: "Accept DNS",
    group: "DNS",
    kind: "bool",
    about:
      "Use the tailnet's DNS settings: MagicDNS names, split DNS and the global nameservers from the admin console.",
  },
  {
    flag: "shields-up",
    label: "Shields up",
    group: "Security",
    kind: "bool",
    about:
      "Block every incoming connection from the tailnet. Outgoing connections keep working.",
    risk: (next) =>
      next === true
        ? "Shields up blocks every incoming connection, SSH included. Press again to confirm."
        : null,
  },
  {
    flag: "ssh",
    label: "Tailscale SSH server",
    group: "Security",
    kind: "bool",
    about:
      "Run the Tailscale SSH server so tailnet members can SSH in as the tailnet policy allows, without keys.",
    risk: (next) =>
      next === false
        ? "Turning off Tailscale SSH ends every SSH session into this device. Press again to confirm."
        : null,
    extra: (next) => (next === false ? ["--accept-risk=lose-ssh"] : []),
  },
  {
    flag: "webclient",
    label: "Web interface",
    group: "Security",
    kind: "bool",
    about:
      "Serve this device's web management page to the tailnet on port 5252.",
  },
  {
    flag: "report-posture",
    label: "Report posture",
    group: "Security",
    kind: "bool",
    about:
      "Let the admin console collect device posture, like the OS version and serial number, for policy checks.",
  },
  {
    flag: "hostname",
    label: "Hostname",
    group: "This device",
    kind: "text",
    placeholder: "empty uses the OS hostname",
    about:
      "The name this device has in the tailnet. Leave it empty to use the operating system's hostname.",
    validate: (v) =>
      v === "" || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(v)
        ? null
        : "Letters, digits and hyphens; no leading or trailing hyphen",
  },
  {
    flag: "operator",
    label: "Operator",
    group: "This device",
    kind: "text",
    placeholder: "a local user name",
    about:
      "A local user allowed to change Tailscale without sudo. Setting it to yourself once makes every change here work without root.",
    linuxOnly: true,
  },
  {
    flag: "nickname",
    label: "Account nickname",
    group: "This device",
    kind: "text",
    placeholder: "work, home…",
    about: "A short name for this account, shown when switching accounts.",
  },
  {
    flag: "auto-update",
    label: "Auto-update",
    group: "Updates",
    kind: "bool",
    about: "Install new Tailscale versions automatically.",
  },
  {
    flag: "update-check",
    label: "Update check",
    group: "Updates",
    kind: "bool",
    about: "Check for new versions; the dashboard shows when one is available.",
  },
  {
    flag: "netfilter-mode",
    label: "Netfilter mode",
    group: "Advanced",
    kind: "choice",
    choices: ["on", "nodivert", "off"],
    about:
      "How Tailscale manages the Linux firewall: on (default), nodivert (adds its rules without diverting traffic), or off (you manage it).",
    risk: (next) =>
      next === "off"
        ? "Tailscale stops managing the firewall. Press again to confirm."
        : null,
    linuxOnly: true,
  },
  {
    flag: "relay-server-port",
    label: "Peer relay port",
    group: "Advanced",
    kind: "text",
    placeholder: "UDP port, 0 picks one, empty turns it off",
    about:
      "Act as a peer relay for other devices on this UDP port. Empty turns the relay off.",
    validate: (v) =>
      v === "" || /^\d{1,5}$/.test(v) ? null : "A port number, or empty",
  },
  {
    flag: "relay-server-static-endpoints",
    label: "Peer relay endpoints",
    group: "Advanced",
    kind: "text",
    placeholder: "203.0.113.1:40000,[2001:db8::1]:40000",
    about:
      "Public ip:port endpoints to advertise for the peer relay, comma-separated.",
  },
];

type ActionId = "operator" | "power" | "login" | "logout" | "update";

type Item =
  | { kind: "heading"; label: string }
  | { kind: "profile"; profile: Profile }
  | { kind: "action"; id: ActionId; label: string }
  | { kind: "setting"; def: SettingDef };

const LABEL_COL = 26;

function onOff(v: boolean | undefined): TextChunk {
  if (v === undefined) return ch("…", { fg: theme.textMuted });
  return v
    ? ch("● on", { fg: theme.green })
    : ch("○ off", { fg: theme.textMuted });
}

export class SettingsView extends ListView<Item> {
  readonly id = "settings" as const;
  readonly title = "Settings";
  readonly short = "Set";

  private prefs: Prefs | null = null;
  private prefsError: string | null = null;
  private profiles: Profile[] | null = null;
  private profilesError: string | null = null;
  private btnMain!: Chip;
  private btnSecond!: Chip;

  protected listTitle(): string {
    return "Settings";
  }

  protected helpLines(): [string, string][] {
    return [
      [
        "Settings",
        "Enter or space toggles a switch, edits a value or runs the action",
      ],
      ["Account", "Enter on another account switches to it · x removes it"],
      ["Mouse", "click select · double-click or the button acts"],
    ];
  }

  protected override searchPlaceholder(): string {
    return "search settings…  (/)";
  }

  protected override haystack(it: Item): string {
    if (it.kind === "setting")
      return `${it.def.label} ${it.def.flag} ${it.def.group} ${it.def.about}`;
    if (it.kind === "profile")
      return `${it.profile.account} ${it.profile.tailnet} ${it.profile.nickname} account`;
    if (it.kind === "action") return `${it.label} ${it.id} account`;
    return it.label;
  }

  protected override buildDetails(d: DetailsPanel): void {
    this.btnMain = d.addButton(
      this.chip("main", "", () => this.withSelected((it) => this.activate(it))),
    );
    this.btnSecond = d.addButton(
      this.chip("second", "", () =>
        this.withSelected((it) => this.secondary(it)),
      ),
    );
  }

  override onShow(select?: string): void {
    super.onShow(select);
    this.reload();
  }

  reload(): void {
    void this.loadPrefs();
    void this.loadProfiles();
  }

  private async loadPrefs(): Promise<void> {
    try {
      this.prefs = await getPrefs(this.ctx.backend);
      this.prefsError = null;
    } catch (e) {
      this.prefsError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private async loadProfiles(): Promise<void> {
    try {
      this.profiles = await listProfiles(this.ctx.backend);
      this.profilesError = null;
    } catch (e) {
      this.profiles = null;
      this.profilesError = e instanceof Error ? e.message : String(e);
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

  /** Linux needs root or the operator for every change; say so once, at the top. */
  private needsOperator(): boolean {
    if (process.platform !== "linux" || !this.prefs) return false;
    if (process.getuid?.() === 0 || this.ctx.backend.label.includes("sudo"))
      return false;
    const me = process.env.USER ?? "";
    return this.prefs.operator !== me;
  }

  protected allItems(): Item[] {
    const s = this.ctx.state;
    const items: Item[] = [];
    if (this.needsOperator()) {
      items.push({ kind: "heading", label: "Permissions" });
      items.push({
        kind: "action",
        id: "operator",
        label: "Make me the operator",
      });
    }
    items.push({ kind: "heading", label: "Account" });
    const profiles =
      this.profiles ??
      (s?.user
        ? [
            {
              id: "current",
              nickname: "",
              tailnet: s.tailnet ?? "",
              account: s.user.login,
              selected: true,
            },
          ]
        : []);
    for (const p of [...profiles].sort(
      (a, b) => Number(b.selected) - Number(a.selected),
    ))
      items.push({ kind: "profile", profile: p });
    items.push({ kind: "action", id: "login", label: "Add an account" });
    if (s && s.backendState !== "NeedsLogin")
      items.push({ kind: "action", id: "logout", label: "Log out" });

    let group = "";
    const heading = (g: string) => {
      if (g !== group) {
        group = g;
        items.push({ kind: "heading", label: g });
      }
    };
    heading("Connection");
    items.push({ kind: "action", id: "power", label: "Tailscale" });
    for (const def of SETTINGS) {
      if (def.linuxOnly && process.platform !== "linux") continue;
      // Older Tailscale versions lack some flags; show only what this one has.
      if (this.prefs && !(def.flag in this.prefs)) continue;
      if (def.group === "Updates" && group !== "Updates") {
        heading("Updates");
        items.push({ kind: "action", id: "update", label: "Version" });
      }
      heading(def.group);
      items.push({ kind: "setting", def });
    }
    return items;
  }

  protected key(it: Item): string {
    switch (it.kind) {
      case "heading":
        return `h:${it.label}`;
      case "profile":
        // The current account keeps its key when the real profile list replaces the placeholder.
        return it.profile.selected ? "p:current" : `p:${it.profile.id}`;
      case "action":
        return `a:${it.id}`;
      case "setting":
        return `s:${it.def.flag}`;
    }
  }

  protected override selectable(it: Item): boolean {
    return it.kind !== "heading";
  }

  protected override emptyText(shown: number, total: number): string | null {
    if (total > 0 && shown === 0)
      return `No setting matches "${this.queryText}".\nEsc clears the search.`;
    return null;
  }

  private value(def: SettingDef): string | boolean | undefined {
    return this.prefs?.[def.flag];
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
    const s = this.ctx.state;
    const valW = Math.max(8, w - 3 - LABEL_COL - 1);
    const line = (
      glyph: TextChunk,
      label: string,
      labelFg: string,
      ...value: TextChunk[]
    ) => [
      mark,
      glyph,
      ch(" "),
      ch(fit(label, LABEL_COL), { fg: labelFg }),
      ch(" "),
      ...value,
    ];
    if (it.kind === "profile") {
      const p = it.profile;
      return line(
        p.selected
          ? ch("◉", { fg: theme.green, bold: true })
          : ch("●", { fg: theme.textDim }),
        p.nickname ? `${p.account} (${p.nickname})` : p.account,
        p.selected ? theme.text : theme.textDim,
        ch(
          truncate(
            [
              p.selected ? "current" : "",
              p.tailnet && p.tailnet !== p.account ? p.tailnet : "",
            ]
              .filter(Boolean)
              .join(" · "),
            valW,
          ),
          { fg: p.selected ? theme.green : theme.textMuted },
        ),
      );
    }
    if (it.kind === "action") {
      switch (it.id) {
        case "operator":
          return line(
            ch("⚠", { fg: theme.yellow, bold: true }),
            it.label,
            theme.yellow,
            ch("changes need root until then", { fg: theme.textDim }),
          );
        case "login":
          return line(
            ch("+", { fg: theme.accent, bold: true }),
            it.label,
            theme.text,
            ch(s?.authUrl ? "waiting for the browser" : "", {
              fg: theme.accent,
            }),
          );
        case "logout":
          return line(
            ch("✗", { fg: theme.red }),
            it.label,
            theme.text,
            ch("", {}),
          );
        case "power": {
          const on = s?.backendState === "Running";
          return line(
            ch(" "),
            it.label,
            theme.text,
            s ? onOff(on) : ch("…", { fg: theme.textMuted }),
            ch(s && !on ? `  ${s.backendState}` : "", { fg: theme.textMuted }),
          );
        }
        case "update": {
          const ver = s?.version.split("-")[0] ?? "…";
          return line(
            ch(" "),
            it.label,
            theme.text,
            ch(ver),
            s?.update
              ? ch(`  ${s.update} available`, { fg: theme.yellow, bold: true })
              : ch("  up to date", { fg: theme.textMuted }),
          );
        }
      }
    }
    const def = it.def;
    const v = this.value(def);
    let value: TextChunk[];
    if (def.kind === "bool")
      value = [onOff(typeof v === "boolean" ? v : undefined)];
    else if (v === undefined)
      value = [ch(this.prefsError ? "?" : "…", { fg: theme.textMuted })];
    else
      value = [
        ch(
          truncate(String(v) || "—", Math.max(4, valW - def.flag.length - 4)),
          { fg: String(v) ? theme.text : theme.textMuted },
        ),
      ];
    const used =
      3 + LABEL_COL + 1 + value.reduce((n, c) => n + c.text.length, 0);
    const flag = `--${def.flag}`;
    if (w - used > flag.length + 4)
      value.push(
        ch(" ".repeat(w - used - flag.length - 1)),
        ch(flag, { fg: theme.textMuted }),
      );
    return line(ch(" "), def.label, theme.text, ...value);
  }

  protected describe(it: Item | undefined, L: Lines): void {
    if (!it || it.kind === "heading") {
      L.line(
        ch("Select a setting to see what it does.", { fg: theme.textMuted }),
      );
      return;
    }
    if (it.kind === "profile") {
      const p = it.profile;
      L.title(p.account);
      L.line(ch(truncate(p.tailnet, L.width), { fg: theme.textDim }));
      L.blank();
      L.kv(
        "Status",
        p.selected
          ? ch("◉ current account", { fg: theme.green, bold: true })
          : ch("● logged in, not in use", { fg: theme.textDim }),
      );
      if (p.nickname) L.kvText("Nickname", p.nickname);
      if (p.id !== "current")
        L.kvText("Profile ID", p.id, { fg: theme.textDim });
      L.blank();
      if (!this.profiles && this.profilesError) {
        prose(
          L,
          "Other accounts on this device are listed once tailscale switch --list works:",
          theme.textDim,
        );
        prose(L, this.profilesError, theme.yellow);
      } else if (!p.selected)
        prose(
          L,
          "Enter switches this device to the account. Its devices and settings replace the current ones.",
        );
      else
        prose(
          L,
          "Add an account to switch between tailnets without logging out.",
        );
      return;
    }
    if (it.kind === "action") {
      this.describeAction(it.id, L);
      return;
    }
    const def = it.def;
    const v = this.value(def);
    L.title(def.label);
    L.line(ch(`--${def.flag}`, { fg: theme.textDim }));
    L.blank();
    if (def.kind === "bool")
      L.kv("Now", onOff(typeof v === "boolean" ? v : undefined));
    else
      L.kv(
        "Now",
        ch(v === undefined ? "…" : truncate(String(v) || "not set", L.valueW), {
          fg: v ? theme.text : theme.textMuted,
        }),
      );
    L.blank();
    prose(L, def.about, theme.text);
    const next = this.nextValue(def);
    if (next !== null && def.kind !== "text") {
      L.blank();
      L.kv(
        "Runs",
        ch(truncate(`tailscale set --${def.flag}=${next}`, L.valueW), {
          fg: theme.textMuted,
        }),
      );
    }
    if (this.prefsError && !this.prefs) {
      L.blank();
      prose(L, this.prefsError, theme.red);
    }
  }

  private describeAction(id: ActionId, L: Lines): void {
    const s = this.ctx.state;
    const me = process.env.USER ?? "you";
    switch (id) {
      case "operator":
        L.title("Make me the operator", { fg: theme.yellow, bold: true });
        L.blank();
        prose(
          L,
          `On Linux, changing Tailscale needs root or the operator user. Enter runs sudo tailscale set --operator=${me} in this terminal, once; sudo asks for your password.`,
          theme.text,
        );
        L.blank();
        prose(
          L,
          `The alternative is starting ${NAME} with --sudo, which needs passwordless sudo.`,
        );
        return;
      case "login":
        L.title("Add an account");
        L.blank();
        if (s?.authUrl) {
          prose(L, "Finish signing in with this link:", theme.text);
          L.line(
            ch(truncate(s.authUrl, L.width), {
              fg: theme.accent,
              underline: true,
            }),
          );
          L.blank();
          prose(L, "Enter opens it in the browser; the link is copied too.");
        } else
          prose(
            L,
            "Log in to another Tailscale account on this device. Switching between accounts does not log you out of either.",
            theme.text,
          );
        return;
      case "logout":
        L.title("Log out", { fg: theme.red, bold: true });
        L.blank();
        prose(
          L,
          "Disconnects and expires this device's key. Coming back needs a login in the browser. To only disconnect, turn Tailscale off instead.",
          theme.text,
        );
        return;
      case "power": {
        const on = s?.backendState === "Running";
        L.title("Tailscale");
        L.blank();
        L.kv(
          "Now",
          s ? onOff(on) : ch("…"),
          ch(s && !on ? `  ${s.backendState}` : "", { fg: theme.textMuted }),
        );
        L.blank();
        prose(
          L,
          on
            ? "Turning Tailscale off drops every tailnet connection and stops using the exit node. You stay logged in."
            : "Turning Tailscale on reconnects with the settings it had.",
          theme.text,
        );
        L.blank();
        L.kv(
          "Runs",
          ch(on ? "tailscale down" : "tailscale up", { fg: theme.textMuted }),
        );
        return;
      }
      case "update":
        L.title("Version");
        L.blank();
        L.kvText("Installed", s?.version.split("-")[0] ?? "…");
        if (s?.update)
          L.kv("Available", ch(s.update, { fg: theme.yellow, bold: true }));
        else
          L.kv(
            "Available",
            ch("nothing newer reported", { fg: theme.textMuted }),
          );
        L.blank();
        prose(
          L,
          s?.update
            ? "Enter installs the new version with tailscale update. Package-managed installs may need the package manager instead."
            : "Tailscale reports new versions when Update check is on.",
          theme.text,
        );
        return;
    }
  }

  protected renderButtons(it: Item | undefined): void {
    const s = this.ctx.state;
    const armed = this.ctx.armed();
    const show = (
      main: [string, ChipStyle] | null,
      second: [string, ChipStyle] | null = null,
    ) => {
      this.btnMain.box.visible = main !== null;
      this.btnSecond.box.visible = second !== null;
      if (main) setChip(this.btnMain, main[0], main[1]);
      if (second) setChip(this.btnSecond, second[0], second[1]);
    };
    if (!it || it.kind === "heading") return show(null);
    if (it.kind === "profile") {
      if (it.profile.selected) return show(null);
      return show(
        ["Switch", btn.primary],
        [
          armed === `remove:${it.profile.id}` ? "Confirm remove" : "Remove",
          btn.danger,
        ],
      );
    }
    if (it.kind === "action") {
      switch (it.id) {
        case "operator":
          return show(["Set operator", btn.primary]);
        case "login":
          return s?.authUrl
            ? show(["Open link", btn.primary], ["Copy link", btn.normal])
            : show(["Log in", btn.primary]);
        case "logout":
          return show([
            armed === "logout" ? "Confirm log out" : "Log out",
            btn.danger,
          ]);
        case "power": {
          const on = s?.backendState === "Running";
          return show(
            on
              ? [
                  armed === "down" ? "Confirm: turn off" : "Turn off",
                  btn.danger,
                ]
              : ["Turn on", btn.primary],
          );
        }
        case "update":
          return s?.update
            ? show([
                armed === "update" ? "Confirm update" : `Update to ${s.update}`,
                btn.primary,
              ])
            : show(null);
      }
    }
    const def = it.def;
    const v = this.value(def);
    if (def.kind === "bool") {
      const next = !(v === true);
      const risky = def.risk?.(next);
      return show([
        armed === `set:${def.flag}` && risky
          ? "Confirm"
          : next
            ? "Turn on"
            : "Turn off",
        next ? btn.primary : btn.normal,
      ]);
    }
    if (def.kind === "choice")
      return show([`Switch to ${this.nextValue(def)}`, btn.normal]);
    return show(["Edit", btn.normal], v ? ["Clear", btn.normal] : null);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  protected override onListKey(key: KeyEvent): boolean {
    const it = this.selected();
    if (key.name === "space") {
      if (it) this.activate(it);
      return true;
    }
    if (key.name === "x" && it?.kind === "profile") {
      this.secondary(it);
      return true;
    }
    return false;
  }

  private nextValue(def: SettingDef): string | boolean | null {
    const v = this.value(def);
    if (v === undefined) return null;
    if (def.kind === "bool") return !(v === true);
    if (def.kind === "choice") {
      const cs = def.choices ?? [];
      return cs[(cs.indexOf(String(v)) + 1) % cs.length] ?? null;
    }
    return String(v);
  }

  protected activate(it: Item): void {
    const s = this.ctx.state;
    if (it.kind === "heading") return;
    if (it.kind === "profile") {
      if (!it.profile.selected) void this.switchTo(it.profile);
      return;
    }
    if (it.kind === "action") {
      switch (it.id) {
        case "operator":
          void this.becomeOperator();
          return;
        case "login":
          if (s?.authUrl) openUrl(this.ctx, s.authUrl);
          else void startLogin(this.ctx).then(() => this.reload());
          return;
        case "logout":
          void this.logout();
          return;
        case "power":
          if (s?.backendState === "Running") void tailscaleDown(this.ctx);
          else void tailscaleUp(this.ctx);
          return;
        case "update":
          void this.update();
          return;
      }
    }
    const def = it.def;
    if (def.kind === "text") return this.edit(def);
    const next = this.nextValue(def);
    if (next === null) {
      this.ctx.notify("Settings are still loading", "info");
      return;
    }
    void this.apply(def, next);
  }

  private secondary(it: Item): void {
    const s = this.ctx.state;
    if (it.kind === "profile" && !it.profile.selected)
      void this.removeProfile(it.profile);
    else if (it.kind === "action" && it.id === "login" && s?.authUrl)
      this.ctx.copy(s.authUrl, "the login link");
    else if (it.kind === "setting" && it.def.kind === "text")
      void this.apply(it.def, "");
  }

  private edit(def: SettingDef): void {
    const v = this.value(def);
    this.ctx.prompt({
      title: def.label,
      label: def.about,
      value: typeof v === "string" ? v : "",
      placeholder: def.placeholder,
      hint: `Runs tailscale set --${def.flag}=<value>`,
      confirm: "Save",
      onSubmit: (value) => {
        const err = def.validate?.(value);
        if (err) return err;
        if (value === v) return;
        void this.apply(def, value);
      },
    });
  }

  private async apply(def: SettingDef, next: string | boolean): Promise<void> {
    const warning = def.risk?.(next);
    if (warning && !this.ctx.confirm(`set:${def.flag}`, warning)) {
      this.render();
      return;
    }
    const args = ["set", `--${def.flag}=${next}`, ...(def.extra?.(next) ?? [])];
    const shown =
      typeof next === "boolean" ? (next ? "on" : "off") : next || "cleared";
    await this.ctx.runAction(
      `Setting ${def.label}`,
      async () => {
        const res = await this.ctx.backend.cli(args, {
          privileged: true,
          timeoutMs: 20_000,
        });
        if (res.code !== 0) throw cliError(res, def.label);
      },
      { onOk: () => this.ctx.notify(`${def.label}: ${shown}`, "ok") },
    );
    await this.loadPrefs();
  }

  private async switchTo(p: Profile): Promise<void> {
    await this.ctx.runAction(
      `Switching to ${p.account}`,
      async () => {
        const res = await this.ctx.backend.cli(["switch", p.id], {
          privileged: true,
          timeoutMs: 30_000,
        });
        if (res.code !== 0) throw cliError(res, "tailscale switch");
      },
      { onOk: () => this.ctx.notify(`Now using ${p.account}`, "ok") },
    );
    this.reload();
  }

  private async removeProfile(p: Profile): Promise<void> {
    if (
      !this.ctx.confirm(
        `remove:${p.id}`,
        `Remove ${p.account} from this device? Press again to confirm.`,
      )
    ) {
      this.render();
      return;
    }
    await this.ctx.runAction(
      `Removing ${p.account}`,
      async () => {
        const res = await this.ctx.backend.cli(["switch", "remove", p.id], {
          privileged: true,
        });
        if (res.code !== 0) throw cliError(res, "tailscale switch remove");
      },
      {
        onOk: () =>
          this.ctx.notify(`Removed ${p.account} from this device`, "ok"),
      },
    );
    this.reload();
  }

  private async logout(): Promise<void> {
    if (
      !this.ctx.confirm(
        "logout",
        "Log out? This device's key expires and logging in again needs the browser. Press again to confirm.",
      )
    ) {
      this.render();
      return;
    }
    await this.ctx.runAction(
      "Logging out",
      async () => {
        const res = await this.ctx.backend.cli(["logout"], {
          privileged: true,
          timeoutMs: 30_000,
        });
        if (res.code !== 0) throw cliError(res, "tailscale logout");
      },
      { onOk: () => this.ctx.notify("Logged out", "ok") },
    );
    this.reload();
  }

  private async update(): Promise<void> {
    const s = this.ctx.state;
    if (!s?.update) {
      this.ctx.notify("No newer version reported", "info");
      return;
    }
    if (
      !this.ctx.confirm(
        "update",
        `Update Tailscale to ${s.update}? Connections drop while it restarts. Press again to confirm.`,
      )
    ) {
      this.render();
      return;
    }
    await this.ctx.runAction(
      `Updating to ${s.update}`,
      async () => {
        const res = await this.ctx.backend.cli(["update", "--yes"], {
          privileged: true,
          timeoutMs: 10 * 60_000,
        });
        if (res.code !== 0) throw cliError(res, "tailscale update");
      },
      { onOk: () => this.ctx.notify(`Tailscale updated to ${s.update}`, "ok") },
    );
  }

  /** sudo needs a terminal for the password, so this leaves the UI for a moment. */
  private async becomeOperator(): Promise<void> {
    const me = process.env.USER;
    if (!me) {
      this.ctx.notify(
        "USER is not set; run: sudo tailscale set --operator=<your user>",
        "warn",
        8000,
      );
      return;
    }
    const argv = [
      "sudo",
      ...this.ctx.backend.command(["set", `--operator=${me}`]),
    ];
    const code = await this.ctx.runInteractive(
      argv,
      `sudo tailscale set --operator=${me}`,
    );
    if (code === 0)
      this.ctx.notify(
        `${me} is now the operator; changes work without sudo`,
        "ok",
      );
    this.reload();
  }
}
