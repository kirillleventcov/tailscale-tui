# tsexit — guide for changes

tsexit is a Bun + `@opentui/core` (OpenTUI) terminal UI that drives the official `tailscale` CLI.
It started as a single-screen exit-node switcher; it is now six views that share that screen's
layout and manners. Keep it that way: every screen should look like it was always part of it.

## Read these first

1. `src/view.ts` — the `View` and `ViewContext` contract (authoritative).
2. `src/views/exit-nodes.ts` — the original screen and the reference for layout, keys and mouse.
3. `src/views/list-view.ts` — the toolbar + list + details layout as a base class. New list
   screens extend it instead of building their own.
4. `src/ui.ts` — chips (`makeChip`, `setChip`, `btn`), `SearchBox`, `ListPanel`, `DetailsPanel`,
   and `Lines` for key/value text (with `optional()`/`fit()` for panels that must shrink).
5. `src/app.ts` — the shell: tab strip, refresh loop, toasts, `?` overlay, prompts, the shared
   pinger and netcheck cache, two-press confirmation, interactive commands (SSH).
6. `src/actions.ts` — state-changing flows used by more than one view.
7. `src/backend/` — `cli.ts` (`cliError`, `parseJson`) and one parser module per command family.

## Organise by task, not by command

The views are Home, Exit nodes, Devices, Network, Sharing, Settings. A CLI subcommand is not a
reason for a screen: put a feature where the user already is (sending a file is an action on a
device; the version and updates are settings; a bug report belongs to network diagnostics).
Scripting and admin commands (`nc`, `web`, `cert`, `lock`, `syspolicy`, `configure`, `systray`,
`completion`, `wait`, `metrics`, `appc-routes`, `service`, `licenses`) stay on the CLI. Adding a
seventh view needs a strong reason; adding a row, a button or a key to an existing one rarely does.

## Design rules

- Layout: toolbar (rounded search box + chips), a bordered list on the left with the count and the
  busy spinner in its title, a 46-column details panel on the right that starts with the name in
  accent, a dim second line, then `Lines.kv` rows with an 11-column muted label, and chips at the
  bottom. No status bars and no breadcrumbs; the `?` overlay carries the key legend and the
  tailnet summary, toasts carry results.
- Only `theme.*` colors. Glyphs: `◉` active/green bold, `●` online, `○` offline or off (muted),
  `✗` expired or error (red), `★` suggestion (yellow), `✓`/`⚠` findings, `▸` selection in accent.
- The primary action of the selection is the green chip (`btn.primary`) and `Enter`; destructive
  ones are `btn.danger`. Every mouse control has a key and every key action is listed by the
  view's `help()`.
- Risky actions (turning Tailscale off, logging out, making something public, removing, updating)
  go through `ctx.confirm(key, warning)`: the first press arms and warns, the second within four
  seconds runs. Never prompt on stdin; there is none. Pass `--accept-risk=...` only after that.
- Text input goes through `ctx.prompt()` (one field, validation by returning an error string,
  `Tab` path completion). Commands that need the terminal (ssh, sudo) go through
  `ctx.runInteractive()`, which suspends the UI.
- Prose is for the details panel only: one or two sentences on what the selection means and what
  to do, wrapped with `prose()`. Do not print command lines everywhere; show the command where it
  teaches something (a setting's "Runs" line).
- Loading, empty and error states for every list. Responsive from 60x15 to 300x60: details hide
  below 100 columns, toolbars go one row high below 22 rows, chips and columns drop from the right
  (drop a column entirely when it carries no information, like OS for Mullvad-only tailnets).

## Running the CLI

`ctx.backend.cli(args, { privileged, timeoutMs })` runs `tailscale <args…>`; `privileged` adds
`sudo -n` under `--sudo` and must be set for every state-changing command. Map failures through
`cliError(res, what)` (it recognises access denied, a stopped daemon and more, and adds hints),
parse JSON with `parseJson`. Prefer `--json` output; parse text only where no JSON exists. State
changes go through `ctx.runAction(label, fn, opts)` so the spinner, error toast and status refresh
behave the same everywhere. Remember that the installed Tailscale may be older than the one you
develop against: degrade (hide what is missing) instead of failing.

## Testing

- `bun run typecheck` and `bun test` must pass.
- UI tests boot the whole app with `test/harness.ts` against `FixtureBackend` in
  `test/fixture.ts`, which answers every command in the exact shape the real CLI prints and
  changes state the way tailscaled would. Extend the fixture rather than stubbing views; never add
  a demo mode or fake data to the shipped app.
- Parser tests live in `test/parsers.test.ts`; take their inputs from real CLI output.
- Check layouts at several sizes with `bun run screenshot <view> <width> <height>` against a real
  tailnet (`--redact` before sharing the output).
- Do not run `git commit` unless asked.
