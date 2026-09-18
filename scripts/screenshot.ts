#!/usr/bin/env bun
// Renders the demo UI headlessly and prints it as plain text (used for the README preview).
// Usage: bun scripts/screenshot.ts [width] [height]
import { createTestRenderer } from "@opentui/core/testing"
import { App } from "../src/app"
import { DemoBackend } from "../src/backend/demo"

const width = Number(Bun.argv[2] ?? 118)
const height = Number(Bun.argv[3] ?? 30)

const setup = await createTestRenderer({ width, height })
const backend = new DemoBackend({ seed: 7, delayScale: 0 })
const app = new App(setup.renderer, { backend, refreshMs: 0, version: "0.1.0" })
try {
  await app.start()
  const pass = async (n = 3) => {
    for (let i = 0; i < n; i++) await setup.renderOnce()
  }
  await pass()
  // Connect to the first node and ping a few so the frame shows real content.
  setup.mockInput.pressEnter()
  await setup.waitForFrame((f) => f.includes("CONNECTED via"), { maxPasses: 40 })
  setup.mockInput.pressKey("p", { shift: true })
  // Wait until no row still shows the pending marker (the search placeholder has its own ellipsis).
  await setup.waitForFrame((f) => f.split("\n").slice(7).every((l) => !l.includes("…")), { maxPasses: 60 })
  setup.mockInput.pressArrow("down")
  await Bun.sleep(2700) // let the "Pinging…" toast expire
  await pass()
  process.stdout.write(setup.captureCharFrame())
} finally {
  app.stop()
  setup.renderer.destroy()
}
