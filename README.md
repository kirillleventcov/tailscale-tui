# tsexit

A single-screen terminal UI for Tailscale exit nodes. See every exit node in your tailnet (including Mullvad nodes), connect, disconnect, switch, let Tailscale pick automatically, search, filter, sort, measure latency, and toggle LAN access. Everything works with the keyboard alone and with the mouse alone.

Built with [OpenTUI](https://opentui.com) on [Bun](https://bun.sh). It only drives the official `tailscale` CLI, so it does exactly what the commands you would type do.

```text
 ╭────────────────────────────────╮
 │ ⌕ search name, IP, country, ci │  All   Online   Tailnet   Mullvad   Status ▴   ★ Auto on   LAN on   Ping all   ?
 ╰────────────────────────────────╯
 ╭─ Exit nodes · 533 ────────────────────────────────────────────────╮ ╭─ Details ──────────────────────────────────╮
 │    Node                Status ▴ Location            Latency  Prio │ │ fi-hel-wg-203                              │
 │▸◉★ fi-hel-wg-203       ACTIVE   FI Helsinki          1.8 ms   500▀│ │ fi-hel-wg-203.mullvad.ts.net               │
 │ ●  al-tia-wg-001       online   AL Tirana             53 ms   100 │ │                                            │
 │ ●  al-tia-wg-002       online   AL Tirana             55 ms   100 │ │ Status     ◉ ACTIVE                        │
 │ ●  al-tia-wg-003       online   AL Tirana             53 ms   100 │ │ Address    100.74.4.51                     │
 │ ●  al-tia-wg-004       online   AL Tirana           timeout   100 │ │            fd7a:115c:a1e0::2801:4c4        │
 │ ●  ar-bue-wg-001       online   AR Buenos Aires      249 ms   100 │ │ Location   Helsinki, Finland (FI)          │
 │ ●  ar-bue-wg-002       online   AR Buenos Aires      260 ms   100 │ │ Type       Mullvad exit node               │
 │ ●  at-vie-wg-001       online   AT Vienna             48 ms   100 │ │ Mode       auto, chosen by Tailscale       │
 │ ●  at-vie-wg-002       online   AT Vienna             46 ms   100 │ │ Owner      tagged-devices                  │
 │ ●  at-vie-wg-003       online   AT Vienna             48 ms   100 │ │ Tags       tag:mullvad-exit-node           │
 │ ●  at-vie-wg-101       online   AT Vienna             41 ms   100 │ │ Priority   500                             │
 │ ●  at-vie-wg-102       online   AT Vienna             41 ms   100 │ │ Last seen  online now                      │
 │ ●  au-adl-wg-301       online   AU Adelaide          435 ms   100 │ │ Handshake  1m ago                          │
 │ ●  au-adl-wg-302       online   AU Adelaide          433 ms   100 │ │ Path       direct 185.65.133.165:51820     │
 │ ●  au-adl-wg-303       online   AU Adelaide          396 ms   100 │ │ Traffic    ↓ 519 MB  ↑ 21 MB               │
 │ ●  au-bne-wg-301       online   AU Brisbane          394 ms   100 │ │ Latency    1.8 ms                          │
 │ ●  au-bne-wg-302       online   AU Brisbane          391 ms   100 │ │            icmp 185.65.133.165             │
 │ ●  au-bne-wg-303       online   AU Brisbane          320 ms   100 │ │ Suggested  ★ Tailscale's pick now (A)      │
 │ ●  au-mel-wg-401       online   AU Melbourne         318 ms   100 │ │                                            │
 │ ●  au-mel-wg-403       online   AU Melbourne         323 ms   100 │ │                                            │
 │ ●  au-per-wg-301       online   AU Perth             371 ms   100 │ │  Disconnect   Ping   Copy IP               │
 ╰───────────────────────────────────────────────────────────────────╯ ╰────────────────────────────────────────────╯
```

## Features

- One screen: search and filters, the node list, a details panel. No status bars; every key and mouse gesture is listed under `?`, and the tailnet summary lives there too.
- Connect, disconnect and switch exit nodes with Enter, a double-click, or the Connect button.
- Auto exit node: `a` turns Tailscale's automatic selection on (`--exit-node=auto:any`); Tailscale then picks the best node and follows it. Picking a node yourself turns it off again, as it does on the CLI.
- Search across name, IP, country, city, OS, owner and tags. Space-separated terms must all match; `!term` excludes.
- Filters: All, Online, Tailnet (your own devices), Mullvad. Sort by status, name, location, latency, priority or OS; click a column header to sort by it.
- Latency: ping one node (`p`), every visible node (`P` or the Ping all chip), or right-click a row. Your own devices are measured with `tailscale ping`; Mullvad nodes with ICMP to the relay's public address (see below). Results feed the latency sort.
- Tailscale's suggested exit node is starred; `A` (or the details line) connects to it once.
- LAN access toggle, traffic counters, connection path (direct, peer relay or DERP), last seen, key expiry, owner, tags.
- Auto-refresh (5 s by default), a busy spinner in the list title, toasts for results, errors and Tailscale health warnings with actionable hints.
- Responsive layout: the details panel hides below 100 columns, chrome shrinks below 22 rows, the OS column disappears when no node reports one (Mullvad-only tailnets), every mouse control has a key.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- The `tailscale` CLI, connected to a tailnet with at least one approved exit node (or the Mullvad add-on).
- For Mullvad latency: the system `ping` command and access to `api.mullvad.net` (see [Latency](#latency)).
- Linux is the primary target. macOS works with the CLI from the App Store or standalone app (`/Applications/Tailscale.app/Contents/MacOS/Tailscale` is found automatically). Windows is untested.

## Run

```sh
bun install
bun start
```

Install the `tsexit` command globally:

```sh
bun link             # then run: tsexit
```

Build a single self-contained binary:

```sh
bun run build        # dist/tsexit
```

### Permissions

Reading status needs no privileges, but `tailscale set` (connect, disconnect, auto mode, LAN access) needs root or an operator user on Linux. Do this once:

```sh
sudo tailscale set --operator=$USER
```

Alternatively start with `--sudo`, which runs `sudo -n tailscale set ...` and therefore needs passwordless sudo.

## Options

```text
--sudo              Prefix "tailscale set" with "sudo -n"
--bin <path>        Path to the tailscale CLI (default: $TAILSCALE_BIN, PATH, known locations)
--refresh <sec>     Auto-refresh interval in seconds (default 5, 0 disables)
--no-details        Start with the details panel hidden (toggle with i)
--no-mullvad-ping   Never contact api.mullvad.net; Mullvad nodes then have no latency
-h, --help          Show help
-v, --version       Print the version
```

## Keyboard

| Keys                            | Action                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `↑` `↓` `j` `k`                 | Move selection                                                               |
| `PgUp` `PgDn` `Ctrl-U` `Ctrl-D` | Page                                                                         |
| `Home` `End` `g` `G`            | First / last node                                                            |
| `Enter`                         | Connect to the selected node, or disconnect if it is active                  |
| `d` `x` `Backspace`             | Disconnect (stop using an exit node; also turns auto mode off)               |
| `a`                             | Auto exit node on / off. Turning it off keeps the node Tailscale chose       |
| `A`                             | Connect to Tailscale's suggested exit node once                              |
| `p` / `P`                       | Ping selected node / ping all visible online nodes                           |
| `/` `Tab` `Ctrl-F`              | Focus the search box                                                         |
| `Enter` / `Esc` (in search)     | Apply and go back / clear and go back                                        |
| `f` / `F`                       | Next / previous filter                                                       |
| `1` `2` `3` `4`                 | All / Online / Tailnet / Mullvad                                             |
| `s` / `S`                       | Next sort field / reverse direction                                          |
| `l`                             | Toggle LAN access while using an exit node                                   |
| `y` `c`                         | Copy the node's Tailscale IP (OSC 52 clipboard)                              |
| `i`                             | Show or hide the details panel                                               |
| `r` `F5`                        | Refresh now                                                                  |
| `?` `F1`                        | Help overlay: every key, mouse gesture, version, backend, tailnet and device |
| `Esc`                           | Clear search, dismiss toast, close help                                      |
| `q` `Ctrl-C`                    | Quit                                                                         |

Connecting to an offline node asks for a second `Enter` within 4 seconds. Nodes with an expired key cannot be selected.

## Mouse

| Gesture                                  | Action                                       |
| ---------------------------------------- | -------------------------------------------- |
| Click a row                              | Select                                       |
| Double-click a row                       | Connect (or disconnect if active)            |
| Right-click a row                        | Ping it                                      |
| Middle-click a row                       | Copy its IP                                  |
| Wheel over the list                      | Scroll                                       |
| Drag the scrollbar                       | Scroll                                       |
| Click a column header                    | Sort by that column; click again to reverse  |
| Click the search box                     | Type to filter                               |
| Click `All` `Online` `Tailnet` `Mullvad` | Filter                                       |
| Click the sort chip                      | Next sort field (Shift-click reverses)       |
| Click `★ Auto on/off`                    | Toggle Tailscale's automatic exit node       |
| Click `LAN on/off`                       | Toggle LAN access                            |
| Click `Ping all`                         | Ping every visible online node (same as `P`) |
| Click `?`                                | Help overlay                                 |
| `Connect` `Ping` `Copy IP` buttons       | Act on the selected node                     |

Mouse support needs a terminal that reports mouse events, which is nearly all of them (xterm-compatible, kitty, WezTerm, Alacritty, iTerm2, Windows Terminal, tmux with `set -g mouse on`).

## How it works

| Purpose                                             | Command                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Node list, current exit node, self, tailnet, health | `tailscale status --json`                                       |
| LAN access and auto exit node preferences           | `tailscale debug prefs`                                         |
| Suggested node                                      | `tailscale exit-node suggest`                                   |
| Connect / disconnect                                | `tailscale set --exit-node=<ip>` / `tailscale set --exit-node=` |
| Auto exit node                                      | `tailscale set --exit-node=auto:any`                            |
| LAN access                                          | `tailscale set --exit-node-allow-lan-access=<bool>`             |
| Latency, own devices                                | `tailscale ping -c 1 --timeout 3s <ip>`                         |
| Latency, Mullvad nodes                              | `ping -c 1 <relay public IP>`                                   |

Only peers that advertise an approved exit node are listed. Mullvad nodes are recognised by their `tag:mullvad-exit-node` tag and shown with the country and city from the status output.

### Latency

Mullvad exit nodes do not answer `tailscale ping` in any mode (disco, TSMP or ICMP through the tunnel), so tsexit resolves the node's host name (for example `fi-hel-wg-203`) through Mullvad's public relay list at `https://api.mullvad.net/www/relays/wireguard/` and sends one ICMP echo to the relay's public address with the system `ping`. The list is fetched once per session, on the first Mullvad ping. The measurement is the round trip from your device to the relay along your current route, so while an exit node is active the echo travels through it. Pass `--no-mullvad-ping` to keep the tool from contacting Mullvad; Mullvad nodes then show no latency.

Your own devices are measured with `tailscale ping`, which reports the path taken (direct endpoint, peer relay or DERP region). The details panel shows which method produced the number.

## Development

```sh
bun test              # unit tests plus headless UI tests driven through OpenTUI's test renderer
bun run typecheck
bun run screenshot    # renders the UI against your real tailnet and prints it as text; add --ping to fill the latency column
bun run dev           # restart on file changes
```

The UI tests run against an in-memory backend in `test/fixture.ts` whose node data is a `tailscale status --json` document in the exact shape the CLI emits, fed through the real parser.

Layout of the code:

- `src/main.ts` argument parsing, preflight, renderer lifecycle
- `src/app.ts` the UI: layout, rendering, keyboard and mouse handling, actions
- `src/model.ts` node model, search, filters, sorting
- `src/backend/tailscale.ts` CLI runner and `tailscale status --json` parsing
- `src/backend/mullvad.ts` Mullvad relay list lookup for latency
- `src/backend/icmp.ts` system `ping` invocation and parsing
- `src/backend/exec.ts` process runner with timeouts
- `src/format.ts`, `src/theme.ts` text helpers and colours

## License

MIT
