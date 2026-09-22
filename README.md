# tsexit

Tailscale in your terminal, exit nodes first. It opens on a dashboard of this device, the exit node in use, your devices and the network; the exit-node switcher it started as is one key away, and the rest of what you do with Tailscale from a terminal sits in four more views: devices, network diagnostics, sharing and settings. Everything works with the keyboard alone and with the mouse alone.

Built with [OpenTUI](https://opentui.com) on [Bun](https://bun.sh). It only drives the official `tailscale` CLI, so it does exactly what the commands you would type do.

```text
  1 Home   2 Exit nodes   3 Devices   4 Network   5 Sharing   6 Settings                                           ?
 ╭─ This device ──────────────────────────────────────────╮ ╭─ Exit node ───────────────────────────────────────────╮
 │ k-pc                                                   │ │ ◉ fi-hel-wg-201                                       │
 │ k-pc.tail0000.ts.net                                   │ │ Helsinki, Finland (FI) · Mullvad                      │
 │ Status     ◉ connected                                 │ │                                                       │
 │ Account    you@example.com                             │ │ Mode       ★ auto, chosen by Tailscale                │
 │ Address    100.98.134.86                               │ │ Path       direct 203.0.113.7:51820                   │
 │            fd7a:115c:a1e0::692c:8657                   │ │ Traffic    ↓ 7.8 GB  ↑ 219 MB                         │
 │ Version    1.102.4 · Linux                             │ │ Latency    2.1 ms  icmp 203.0.113.7                   │
 │ Key expiry in 6 months                                 │ │ LAN access on                                         │
 │                                                        │ │                                                       │
 │  Turn off   Copy IP                                    │ │  Change   Disconnect   ★ Auto on   LAN on             │
 ╰────────────────────────────────────────────────────────╯ ╰───────────────────────────────────────────────────────╯
 ╭─ Devices · 4 of 6 online ─────────────────────────────────────────╮ ╭─ Network ──────────────────────────────────╮
 │▸● k-macbook-pro              100.115.95.88   macOS    idle        │ │ UDP        ✓ works                         │
 │ ● rasp2                      100.86.88.52    Linux    idle        │ │ NAT        easy, direct paths              │
 │ ● raspberrypi                100.89.133.58   Linux    direct      │ │ IPv4       203.0.113.7:35801               │
 │ ● tailscale-aperture         100.65.156.23   Linux    direct      │ │ IPv6       [2001:db8::1]                   │
 │ ○ iphone-15-pro              100.106.248.3   iOS      6h ago      │ │ Nearest    hel Helsinki · 8 ms             │
 │ ○ bjorn                      100.90.57.86    Linux    18d ago     │ │ Port map   none                            │
 │                                                                   │ │ MagicDNS   off · tail0000.ts.net           │
 │                                                                   │ │ Checked    just now  (r)                   │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 │                                                                   │ │                                            │
 ╰───────────────────────────────────────────────────────────────────╯ ╰────────────────────────────────────────────╯
```

## Views

Six views, one layout: a list on the left, the details of the selection on the right, actions as buttons with a key each. `1`-`6` or a click on the tab switches views; `?` lists every key of the view you are in.

1. **Home.** This device (state, account, addresses, version, key expiry, health warnings), the exit node in use (mode, path, traffic, latency, LAN access), your devices and a network summary. Turn Tailscale on or off, log in, switch or drop the exit node, open a device.
2. **Exit nodes.** Every exit node in the tailnet, Mullvad included: connect, disconnect, switch, let Tailscale pick automatically, search, filter, sort, measure latency, toggle LAN access.
3. **Devices.** Your tailnet's devices (Mullvad relays stay in Exit nodes): who is online and how you reach them (direct, peer relay, DERP), SSH into one, send it a file with Taildrop, ping it, copy its address, use it as an exit node.
4. **Network.** A checklist from `tailscale netcheck` and `tailscale dns status`: UDP, NAT type, public addresses, port mapping, MagicDNS, nameservers, split DNS, health warnings and every DERP relay by latency. The details panel says what a finding means and what to do about it. Copy the report or create a bug report ID.
5. **Sharing.** What this device shares: local ports, URLs and folders served to the tailnet or, with Funnel, to the internet; Taildrive folders; and the Taildrop inbox. Share, make public, stop, receive files.
6. **Settings.** Accounts (switch, add, log out), Tailscale on or off, and every preference `tailscale set` takes, grouped by purpose, each with a sentence on what it does. Enter toggles a switch or edits a value. On Linux it offers to make you the operator, so changes stop needing sudo.

```text
  1 Home   2 Exit nodes   3 Devices   4 Network   5 Sharing   6 Settings                                           ?
 ╭────────────────────────────────────╮
 │ ⌕ search name, IP, country, city,  │  All   Online   Tailnet   Mullvad   Status ▴   ★ Auto on   LAN on   Ping all
 ╰────────────────────────────────────╯
 ╭─ Exit nodes · 532 ────────────────────────────────────────────────╮ ╭─ Details ──────────────────────────────────╮
 │    Node                Status ▴ Location            Latency  Prio │ │ fi-hel-wg-201                              │
 │▸◉★ fi-hel-wg-201       ACTIVE   FI Helsinki          2.8 ms   500▀│ │ fi-hel-wg-201.mullvad.ts.net               │
 │ ●  al-tia-wg-001       online   AL Tirana             53 ms   100 │ │                                            │
 │ ●  al-tia-wg-002       online   AL Tirana             55 ms   100 │ │ Status     ◉ ACTIVE                        │
 │ ●  al-tia-wg-003       online   AL Tirana             54 ms   100 │ │ Address    100.90.175.25                   │
 │ ●  al-tia-wg-004       online   AL Tirana             55 ms   100 │ │            fd7a:115c:a1e0::d501:afda       │
 │ ●  ar-bue-wg-001       online   AR Buenos Aires      247 ms   100 │ │ Location   Helsinki, Finland (FI)          │
 │ ●  ar-bue-wg-002       online   AR Buenos Aires      256 ms   100 │ │ Type       Mullvad exit node               │
 │ ●  at-vie-wg-001       online   AT Vienna             49 ms   100 │ │ Mode       auto, chosen by Tailscale       │
 │ ●  at-vie-wg-002       online   AT Vienna             51 ms   100 │ │ Owner      tagged-devices                  │
 │ ●  at-vie-wg-003       online   AT Vienna             49 ms   100 │ │ Tags       tag:mullvad-exit-node           │
 │ ●  at-vie-wg-101       online   AT Vienna             41 ms   100 │ │ Priority   500                             │
 │ ●  at-vie-wg-102       online   AT Vienna             41 ms   100 │ │ Last seen  online now                      │
 │ ●  au-adl-wg-301       online   AU Adelaide          376 ms   100 │ │ Handshake  19s ago                         │
 │ ●  au-adl-wg-302       online   AU Adelaide          374 ms   100 │ │ Path       direct 185.65.133.5:51820       │
 │ ●  au-adl-wg-303       online   AU Adelaide          371 ms   100 │ │ Traffic    ↓ 7.7 GB  ↑ 207 MB              │
 │ ●  au-bne-wg-301       online   AU Brisbane          337 ms   100 │ │ Latency    2.8 ms                          │
 │ ●  au-bne-wg-302       online   AU Brisbane          334 ms   100 │ │            icmp 185.65.133.5               │
 │ ●  au-bne-wg-303       online   AU Brisbane          337 ms   100 │ │ Suggested  ★ Tailscale's pick now (A)      │
 │ ●  au-mel-wg-401       online   AU Melbourne         335 ms   100 │ │                                            │
 │ ●  au-mel-wg-403       online   AU Melbourne         334 ms   100 │ │                                            │
 │ ●  au-per-wg-301       online   AU Perth             403 ms   100 │ │                                            │
 │ ●  au-per-wg-302       online   AU Perth             400 ms   100 │ │                                            │
 │ ●  au-syd-wg-001       online   AU Sydney            398 ms   100 │ │  Disconnect   Ping   Copy IP               │
 ╰───────────────────────────────────────────────────────────────────╯ ╰────────────────────────────────────────────╯
```

## Features

- A dashboard that answers "am I connected, through what, and is the network healthy" at a glance, and acts on it.
- Exit nodes: `Enter` connects or disconnects, `a` turns on Tailscale's automatic exit node (`--exit-node=auto:any`), `A` uses the suggested node once, `l` toggles LAN access, `p`/`P` measure latency. Mullvad nodes are measured with ICMP to their relay (see [Latency](#latency)).
- SSH into a device with `Enter`: Tailscale SSH when the device runs it, plain `ssh` over the tailnet otherwise. The UI steps aside for the session and comes back when it ends.
- Taildrop with path completion (`Tab`), Serve and Funnel in two keystrokes, Taildrive shares, a Taildrop inbox you can empty into any folder.
- Search across names, IPs, OS, owners and tags in every list; `!word` excludes.
- Risky actions (turning Tailscale off, logging out, making a share public, shields up, turning off the SSH server, updating) ask for a second press within four seconds. Nothing prompts on stdin.
- Auto-refresh (5 s by default), a busy spinner in the list title, toasts for results, errors with actionable hints, and Tailscale health warnings.
- Responsive: details panels hide below 100 columns, toolbars shrink below 22 rows, columns and chips drop out as the terminal narrows, and every mouse control has a key.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- The `tailscale` CLI, connected to a tailnet. Developed against 1.102; older versions work, and Settings shows only the preferences the installed version has.
- For Mullvad latency: the system `ping` command and access to `api.mullvad.net` (see [Latency](#latency)).
- Linux is the primary target. macOS works with the CLI from the App Store or standalone app (`/Applications/Tailscale.app/Contents/MacOS/Tailscale` is found automatically). Windows is untested.

## Run

```sh
bun install
bun start            # or: bun start exit    to open on the exit nodes
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

Reading status needs no privileges, but changing anything (`tailscale set`, `up`, `down`, `switch`, `serve`, `file get`...) needs root or an operator user on Linux. Do this once, or press `Enter` on "Make me the operator" in Settings, which runs it for you:

```sh
sudo tailscale set --operator=$USER
```

Alternatively start with `--sudo`, which prefixes state-changing commands with `sudo -n` and therefore needs passwordless sudo.

## Options

```text
tsexit [view] [options]

Views: home (default), exit, devices, network, sharing, settings

--sudo              Prefix state-changing commands with "sudo -n"
--bin <path>        Path to the tailscale CLI (default: $TAILSCALE_BIN, PATH, known locations)
--refresh <sec>     Auto-refresh interval in seconds (default 5, 0 disables)
--no-details        Start with the exit-node details panel hidden (toggle with i)
--no-mullvad-ping   Never contact api.mullvad.net; Mullvad nodes then have no latency
-h, --help          Show help
-v, --version       Print the version
```

## Keyboard

Everywhere:

| Keys                            | Action                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| `1`-`6`, `[` `]`                | Home, Exit nodes, Devices, Network, Sharing, Settings; previous / next |
| `↑` `↓` `j` `k`                 | Move the selection                                                     |
| `PgUp` `PgDn` `Ctrl-U` `Ctrl-D` | Page                                                                   |
| `Home` `End` `g` `G`            | First / last row                                                       |
| `Enter`                         | The selection's main action (the green button)                         |
| `/` `Tab` `Ctrl-F`              | Search; `Enter` applies, `Esc` clears                                  |
| `i`                             | Show or hide the details panel                                         |
| `r` `F5`                        | Refresh; measures the network again on Home and Network                |
| `?` `F1`                        | Every key and mouse gesture of the view, version, tailnet and device   |
| `Esc`                           | Clear search, dismiss toast, close an overlay or prompt                |
| `q` `Ctrl-C`                    | Quit                                                                   |

Per view:

| View       | Keys                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home       | `Enter` open the device · `e` choose exit node · `d` disconnect · `a` auto · `A` suggested · `l` LAN · `p`/`P` ping · `y` copy its IP · `Y` copy this device's IP · `o` Tailscale on/off |
| Exit nodes | `Enter` connect/disconnect · `d` `x` disconnect · `a` auto · `A` suggested · `p`/`P` ping · `f`/`F` filter · `s`/`S` sort · `l` LAN · `y` `c` copy IP                                    |
| Devices    | `Enter` SSH (ping for phones) · `u` SSH as another user · `t` send a file · `e` use as exit node · `p`/`P` ping · `y` copy IP · `Y` copy DNS name · `f`/`F` filter · `s`/`S` sort        |
| Network    | `r` measure again · `y` copy the report · `b` bug report                                                                                                                                 |
| Sharing    | `Enter` open or run · `y` copy URL · `f` public on/off (Funnel) · `x` stop sharing · `e` rename a Taildrive share · `u` Taildrop folder                                                  |
| Settings   | `Enter` or `Space` toggle, edit or run · `x` remove an account                                                                                                                           |

In a prompt: `Enter` confirms, `Esc` cancels, `Tab` completes a path. Connecting to an offline exit node asks for a second `Enter`; nodes with an expired key cannot be used.

## Mouse

| Gesture                  | Action                                      |
| ------------------------ | ------------------------------------------- |
| Click a tab              | Switch view                                 |
| Click a row              | Select                                      |
| Double-click a row       | Main action (connect, SSH, open, toggle...) |
| Right-click a row        | Ping it (exit nodes and devices)            |
| Middle-click a row       | Copy its IP                                 |
| Wheel, drag scrollbar    | Scroll                                      |
| Click a column header    | Sort by that column; click again to reverse |
| Click a chip or button   | What its label says; every one has a key    |
| Click outside an overlay | Close it                                    |

Mouse support needs a terminal that reports mouse events, which is nearly all of them (xterm-compatible, kitty, WezTerm, Alacritty, iTerm2, Windows Terminal, tmux with `set -g mouse on`).

## How it works

| Purpose                                           | Command                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Devices, exit nodes, this device, account, health | `tailscale status --json` (every refresh)                                                   |
| LAN access and auto exit node                     | `tailscale debug prefs`                                                                     |
| Suggested exit node                               | `tailscale exit-node suggest`                                                               |
| Connect, disconnect, auto, LAN access             | `tailscale set --exit-node=...`, `--exit-node-allow-lan-access=...`                         |
| Tailscale on and off                              | `tailscale up`, `tailscale down`                                                            |
| Log in, accounts, log out                         | `tailscale login`, `tailscale switch`, `tailscale logout`                                   |
| Settings                                          | `tailscale get --json`, `tailscale set --<flag>=<value>`                                    |
| Update                                            | `tailscale update --yes`                                                                    |
| SSH                                               | `tailscale ssh user@device` or `ssh user@device`                                            |
| Send and receive files                            | `tailscale file cp`, `tailscale file get`                                                   |
| Network checks                                    | `tailscale netcheck`, `tailscale dns status --json`                                         |
| Bug report                                        | `tailscale bugreport`                                                                       |
| Serve and Funnel                                  | `tailscale serve status --json`, `tailscale serve --bg`, `tailscale funnel --bg`, `... off` |
| Taildrive                                         | `tailscale drive list`, `share`, `rename`, `unshare`                                        |
| Latency, your devices                             | `tailscale ping -c 1 --timeout 3s <ip>`                                                     |
| Latency, Mullvad nodes                            | `ping -c 1 <relay public IP>`                                                               |

Commands that are about scripting or administration stay on the CLI, where they belong: `tailscale nc`, `web`, `cert`, `lock`, `syspolicy`, `configure`, `systray`, `completion`, `wait`, `metrics`, `appc-routes`, `service` and `licenses`.

### Latency

Mullvad exit nodes do not answer `tailscale ping` in any mode (disco, TSMP or ICMP through the tunnel), so tsexit resolves the node's host name (for example `fi-hel-wg-203`) through Mullvad's public relay list at `https://api.mullvad.net/www/relays/wireguard/` and sends one ICMP echo to the relay's public address with the system `ping`. The list is fetched once per session, on the first Mullvad ping. The measurement is the round trip from your device to the relay along your current route, so while an exit node is active the echo travels through it. Pass `--no-mullvad-ping` to keep the tool from contacting Mullvad; Mullvad nodes then show no latency.

Your own devices are measured with `tailscale ping`, which reports the path taken (direct endpoint, peer relay or DERP region). The details panel shows which method produced the number.

## Development

```sh
bun test              # unit tests plus headless UI tests driven through OpenTUI's test renderer
bun run typecheck
bun run screenshot    # renders a view against your real tailnet as text: [view] [width] [height] [--ping] [--redact]
bun run dev           # restart on file changes
```

The UI tests run against an in-memory backend in `test/fixture.ts` that answers every command in the exact shape the CLI prints, fed through the real parsers.

Layout of the code:

- `src/main.ts` argument parsing, preflight, renderer lifecycle
- `src/app.ts` the shell: tabs, views, refresh loop, toasts, help overlay, prompts, shared pinger and netcheck
- `src/view.ts` the contract between the shell and the views
- `src/views/` one file per view; `list-view.ts` is the list-and-details layout the list views share
- `src/ui.ts` shared widgets: chips, search box, list panel, details panel, key/value lines
- `src/actions.ts` state-changing flows used by more than one view
- `src/model.ts` peers, exit nodes and devices: search, filters, sorting
- `src/backend/` the CLI runner and one parser module per command family
- `src/format.ts`, `src/theme.ts` text helpers and colours

## License

MIT
