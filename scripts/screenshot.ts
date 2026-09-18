#!/usr/bin/env bun
// Renders the UI headlessly against your real tailnet and prints it as plain text (used for the README preview).
// Usage: bun scripts/screenshot.ts [width] [height] [--ping]
import { createTestRenderer } from "@opentui/core/testing"
import pkg from "../package.json" with { type: "json" }
import { App } from "../src/app"
import { TailscaleBackend, findTailscaleBinary } from "../src/backend/tailscale"

const args = Bun.argv.slice(2)
const ping = args.includes("--ping")
const nums = args.filter((a) => !a.startsWith("--")).map(Number)
const width = nums[0] ?? 118
const height = nums[1] ?? 30

const bin = findTailscaleBinary()
if (!bin) {
  console.error("tailscale CLI not found")
  process.exit(1)
}

const setup = await createTestRenderer({ width, height })
const app = new App(setup.renderer, { backend: new TailscaleBackend({ bin }), refreshMs: 0, version: pkg.version })
const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await setup.renderOnce()
}
const waitFor = async (pred: (f: string) => boolean, maxPasses: number) => {
  try {
    await setup.waitForFrame(pred, { maxPasses })
  } catch {
    // keep going with whatever is on screen
  }
}
try {
  await app.start()
  await settle()
  // `tailscale exit-node suggest` answers asynchronously; wait for the star.
  await waitFor((f) => f.includes("★ "), 60)
  if (ping) {
    setup.mockInput.pressKey("p", { shift: true })
    // Wait until no row still shows the pending marker (the search placeholder has its own ellipsis).
    await waitFor((f) => f.split("\n").slice(7, height - 2).every((l) => !l.includes(" … ")), 600)
    await Bun.sleep(4500) // let the result toast expire
  }
  await settle()
  process.stdout.write(setup.captureCharFrame())
} finally {
  app.stop()
  setup.renderer.destroy()
}
