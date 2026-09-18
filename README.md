# tsexit

A single-screen terminal UI for Tailscale exit nodes. See every exit node in your tailnet (including Mullvad nodes), connect, disconnect, switch, search, filter, sort, ping, and toggle LAN access. Everything works with the keyboard alone and with the mouse alone.

Built with [OpenTUI](https://opentui.com) on [Bun](https://bun.sh).

```text
 ◉ CONNECTED via hel-vps 100.64.10.70 · direct 120.118.61.141:41641 · ↓ 3.4 MB ↑ 19 MB
 tsexit v0.1.0 · DEMO · tailnet kirill.github · device my-laptop · LAN access off · 57 exit nodes (50 online) · upda…
 ╭────────────────────────────────────╮
 │ ⌕ search name, IP, country, city,  │  All   Online   Tailnet   Mullvad   Status ▴   ★ Auto: hel-vps   LAN off   ?
 ╰────────────────────────────────────╯
 ╭─ Exit nodes · 57 ─────────────────────────────────────────────────╮ ╭─ Details ──────────────────────────────────╮
 │    Node             Status ▴ Location            Latency OS       │ │ home-server                                │
 │ ◉★ hel-vps          ACTIVE   tailnet              6.0 ms Linux   ▀│ │ home-server.tail4a2b.ts.net                │
 │▸●  home-server      online   tailnet               15 ms Linux    │ │                                            │
 │ ●  office-gw        online   tailnet               11 ms Linux    │ │ Status     ● online  (Enter to use)        │
 │ ●  us-east-vps      online   tailnet              148 ms Linux    │ │ Address    100.64.11.77                    │
 │ ●  at-vie-wg-001    online   AT Vienna             49 ms Linux    │ │            fd7a:115c:a1e0::c               │
 │ ●  au-mel-wg-001    online   AU Melbourne         335 ms Linux    │ │ Location   unknown                         │
 │ ●  au-syd-wg-001    online   AU Sydney            400 ms Linux    │ │ Type       Tailnet device                  │
 │ ●  be-bru-wg-001    online   BE Brussels           45 ms Linux    │ │ OS         Linux                           │
 │ ●  br-sao-wg-001    online   BR São Paulo         292 ms Linux    │ │ Owner      kirill@github                   │
 │ ●  ca-tor-wg-001    online   CA Toronto           147 ms Linux    │ │ Last seen  online now                      │
 │ ●  ca-van-wg-001    online   CA Vancouver         230 ms Linux    │ │ Handshake  1m ago                          │
 │ ●  ch-zrh-wg-001    online   CH Zürich             40 ms Linux    │ │ Path       direct 99.93.74.136:41641       │
 │ ●  cz-prg-wg-001    online   CZ Prague             45 ms Linux    │ │ Traffic    ↓ 12 MB  ↑ 3.0 MB               │
 │ ●  de-ber-wg-001    online   DE Berlin             34 ms Linux    │ │ Latency    15 ms                           │
 │ ●  de-ber-wg-002    online   DE Berlin             35 ms Linux    │ │                                            │
 │ ●  de-fra-wg-001    online   DE Frankfurt          33 ms Linux    │ │                                            │
 │ ●  de-fra-wg-002    online   DE Frankfurt          35 ms Linux    │ │                                            │
 │ ●  dk-cph-wg-001    online   DK Copenhagen         27 ms Linux    │ │                                            │
 │ ●  ee-tll-wg-001    online   EE Tallinn            12 ms Linux    │ │                                            │
 │ ●  es-mad-wg-001    online   ES Madrid             76 ms Linux    │ │                                            │
 │ ●  gb-lon-wg-001    online   GB London             52 ms Linux    │ │  Connect   Ping   Copy IP                  │
 ╰───────────────────────────────────────────────────────────────────╯ ╰────────────────────────────────────────────╯
 ↑↓ move  ⏎ connect/disconnect  d disconnect  a auto  p ping  P ping all  / search  f filter  s sort  ? help  q quit
```

## Features

- One screen: connection status, search and filters, the node list, a details panel, key hints.
- Connect, disconnect and switch exit nodes with Enter, a double-click, or the Connect button.
- Search across name, IP, country, city, OS, owner and tags. Space-separated terms must all match; `!term` excludes.
- Filters: All, Online, Tailnet (your own devices), Mullvad. Sort by status, name, location, latency, priority or OS; click a column header to sort by it.
- Latency: ping one node (`p`), every visible node (`P`), or right-click a row. Results feed the latency sort.
- Tailscale's suggested exit node is starred; `a` (or the Auto chip) connects to it.
- LAN access toggle, traffic counters, connection path (direct or DERP relay), last seen, key expiry, owner, tags.
- Auto-refresh (5 s by default), busy spinner, toasts for results and errors with actionable hints.
- Responsive layout: the details panel hides below 100 columns, chrome shrinks below 22 rows, every mouse control has a key.
- Demo mode with realistic generated data so you can try it without Tailscale.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- The `tailscale` CLI, connected to a tailnet with at least one approved exit node.
- Linux is the primary target. macOS works with the CLI from the App Store or standalone app (`/Applications/Tailscale.app/Contents/MacOS/Tailscale` is found automatically). Windows is untested.

## Run

```sh
bun install
bun start            # real Tailscale
bun run demo         # generated data, no Tailscale needed
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

Reading status needs no privileges, but `tailscale set` (connect, disconnect, LAN access) needs root or an operator user on Linux. Do this once:

```sh
sudo tailscale set --operator=$USER
```

Alternatively start with `--sudo`, which runs `sudo -n tailscale set ...` and therefore needs passwordless sudo.

## Options

```text
--demo             Run with generated demo data (no Tailscale needed)
--sudo             Prefix "tailscale set" with "sudo -n"
--bin <path>       Path to the tailscale CLI (default: $TAILSCALE_BIN, PATH, known locations)
--refresh <sec>    Auto-refresh interval in seconds (default 5, 0 disables)
--no-details       Start with the details panel hidden (toggle with i)
-h, --help         Show help
-v, --version      Print the version
```

## Keyboard

| Keys | Action |
| --- | --- |
| `↑` `↓` `j` `k` | Move selection |
| `PgUp` `PgDn` `Ctrl-U` `Ctrl-D` | Page |
| `Home` `End` `g` `G` | First / last node |
| `Enter` | Connect to the selected node, or disconnect if it is active |
| `d` `x` `Backspace` | Disconnect (stop using an exit node) |
| `a` | Connect to Tailscale's suggested exit node |
| `p` / `P` | Ping selected node / ping all visible online nodes |
| `/` `Tab` `Ctrl-F` | Focus the search box |
| `Enter` / `Esc` (in search) | Apply and go back / clear and go back |
| `f` / `F` | Next / previous filter |
| `1` `2` `3` `4` | All / Online / Tailnet / Mullvad |
| `s` / `S` | Next sort field / reverse direction |
| `l` | Toggle LAN access while using an exit node |
| `y` `c` | Copy the node's Tailscale IP (OSC 52 clipboard) |
| `i` | Show or hide the details panel |
| `r` `F5` | Refresh now |
| `?` `F1` | Help overlay |
| `Esc` | Clear search, dismiss toast, close help |
| `q` `Ctrl-C` | Quit |

Connecting to an offline node asks for a second `Enter` within 4 seconds.

## Mouse

| Gesture | Action |
| --- | --- |
| Click a row | Select |
| Double-click a row | Connect (or disconnect if active) |
| Right-click a row | Ping it |
| Middle-click a row | Copy its IP |
| Wheel over the list | Scroll |
| Drag the scrollbar | Scroll |
| Click a column header | Sort by that column; click again to reverse |
| Click the search box | Type to filter |
| Click `All` `Online` `Tailnet` `Mullvad` | Filter |
| Click the sort chip | Next sort field (Shift-click reverses) |
| Click `★ Auto` | Connect to the suggested node |
| Click `LAN on/off` | Toggle LAN access |
| Click `?` | Help |
| `Connect` `Ping` `Copy IP` buttons | Act on the selected node |

Mouse support needs a terminal that reports mouse events, which is nearly all of them (xterm-compatible, kitty, WezTerm, Alacritty, iTerm2, Windows Terminal, tmux with `set -g mouse on`).

## How it works

The app only drives the official CLI, so it behaves exactly like the commands you would type:

| Purpose | Command |
| --- | --- |
| Node list, current exit node, self, tailnet | `tailscale status --json` |
| LAN access preference | `tailscale debug prefs` |
| Suggested node | `tailscale exit-node suggest` |
| Connect / disconnect | `tailscale set --exit-node=<ip>` / `tailscale set --exit-node=` |
| LAN access | `tailscale set --exit-node-allow-lan-access=<bool>` |
| Latency | `tailscale ping -c 1 --timeout 3s <ip>` |

Only peers that advertise an approved exit node are listed. Mullvad nodes are recognised by their `tag:mullvad-exit-node` tag and shown with country and city from the status output.

## Development

```sh
bun test              # unit tests plus headless UI tests driven through OpenTUI's test renderer
bun run typecheck
bun run screenshot    # prints the demo UI as text
bun run dev           # demo mode with file watching
```

Layout of the code:

- `src/main.ts` argument parsing, backend selection, renderer lifecycle
- `src/app.ts` the UI: layout, rendering, keyboard and mouse handling, actions
- `src/model.ts` node model, search, filters, sorting
- `src/backend/tailscale.ts` CLI runner and `tailscale status --json` parsing
- `src/backend/demo.ts` deterministic generated data
- `src/format.ts`, `src/theme.ts` text helpers and colours

## License

MIT
