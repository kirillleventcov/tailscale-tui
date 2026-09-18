#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import pkg from "../package.json" with { type: "json" }
import { App } from "./app"
import { DemoBackend } from "./backend/demo"
import { TailscaleBackend, findTailscaleBinary } from "./backend/tailscale"
import { BackendError, type Backend } from "./backend/types"
import { theme } from "./theme"

interface Cli {
  demo: boolean
  sudo: boolean
  refresh: number
  details: boolean
  bin?: string
  help: boolean
  version: boolean
}

function usage(): string {
  return `tsexit ${pkg.version} - Tailscale exit node switcher for the terminal

Usage: tsexit [options]

Options:
  --demo             Run with generated demo data (no Tailscale needed)
  --sudo             Prefix "tailscale set" with "sudo -n" (passwordless sudo required)
  --bin <path>       Path to the tailscale CLI (default: $TAILSCALE_BIN, PATH, known locations)
  --refresh <sec>    Auto-refresh interval in seconds (default 5, 0 disables)
  --no-details       Start with the details panel hidden (toggle with i)
  -h, --help         Show this help
  -v, --version      Print the version

Keys: arrows/jk move, Enter connect/disconnect, d disconnect, a suggested node,
      p ping, / search, f filter, s sort, l LAN access, r refresh, ? help, q quit.
Mouse: click to select, double-click to connect, wheel to scroll, click chips.

On Linux, "tailscale set" needs root or an operator user. Run once:
  sudo tailscale set --operator=$USER
`
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { demo: false, sudo: false, refresh: 5, details: true, help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const eq = raw.indexOf("=")
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[++i]
      if (next === undefined) {
        console.error(`${flag} needs a value`)
        process.exit(2)
      }
      return next
    }
    switch (flag) {
      case "--demo":
        cli.demo = true
        break
      case "--sudo":
        cli.sudo = true
        break
      case "--bin":
        cli.bin = value()
        break
      case "--refresh": {
        const n = Number(value())
        if (!Number.isFinite(n) || n < 0) {
          console.error("--refresh must be a non-negative number of seconds")
          process.exit(2)
        }
        cli.refresh = n
        break
      }
      case "--no-details":
        cli.details = false
        break
      case "-h":
      case "--help":
        cli.help = true
        break
      case "-v":
      case "--version":
        cli.version = true
        break
      default:
        console.error(`Unknown option: ${raw}\n`)
        console.error(usage())
        process.exit(2)
    }
  }
  return cli
}

async function main(): Promise<void> {
  const cli = parseArgs(Bun.argv.slice(2))
  if (cli.help) {
    console.log(usage())
    return
  }
  if (cli.version) {
    console.log(pkg.version)
    return
  }

  let backend: Backend
  if (cli.demo) {
    backend = new DemoBackend()
  } else {
    const bin = cli.bin ?? findTailscaleBinary()
    if (!bin) {
      console.error("tailscale CLI not found. Install Tailscale, set TAILSCALE_BIN, pass --bin <path>, or try --demo.")
      process.exit(1)
    }
    backend = new TailscaleBackend({ bin, sudo: cli.sudo })
    // Preflight outside the alternate screen so a broken setup prints a readable error.
    try {
      await backend.status()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`Cannot read Tailscale status: ${msg}`)
      if (e instanceof BackendError && e.hint) console.error(e.hint)
      process.exit(1)
    }
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("tsexit needs an interactive terminal.")
    process.exit(1)
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    backgroundColor: theme.bg,
    useMouse: true,
    enableMouseMovement: true,
  })

  let app: App | undefined
  try {
    app = new App(renderer, {
      backend,
      refreshMs: cli.refresh * 1000,
      showDetails: cli.details,
      version: pkg.version,
    })
    await app.start()
    await app.done
  } catch (e) {
    app?.stop()
    renderer.destroy()
    console.error(e)
    process.exit(1)
  }
  app.stop()
  renderer.destroy()
  process.exit(0)
}

await main()
