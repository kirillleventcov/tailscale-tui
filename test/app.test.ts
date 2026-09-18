import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { App } from "../src/app"
import { DemoBackend } from "../src/backend/demo"

interface Harness {
  setup: TestRendererSetup
  app: App
  frame: () => string
  lines: () => string[]
  /** Text of the node list only (excludes header, toolbar and details). */
  list: () => string
  selectedName: () => string
  settle: () => Promise<void>
  escape: () => Promise<void>
  stop: () => void
}

let active: Harness | null = null

/** Row index 0 is the first node row: header(2) + toolbar(3) + panel border(1) + column header(1). */
const ROW_Y = 7

async function boot(width = 120, height = 32): Promise<Harness> {
  const setup = await createTestRenderer({ width, height })
  const backend = new DemoBackend({ seed: 7, delayScale: 0 })
  const app = new App(setup.renderer, { backend, refreshMs: 0, version: "test" })
  await app.start()
  const settle = async () => {
    for (let i = 0; i < 3; i++) await setup.renderOnce()
  }
  await settle()
  const compact = height < 22
  const firstRow = compact ? 3 : ROW_Y
  const lines = () => setup.captureCharFrame().split("\n")
  const h: Harness = {
    setup,
    app,
    frame: () => setup.captureCharFrame(),
    lines,
    list: () =>
      lines()
        .slice(firstRow, height - 2)
        .map((l) => l.split("│ │")[0] ?? l)
        .join("\n"),
    selectedName: () => {
      const line = lines().find((l) => l.includes("▸")) ?? ""
      return line.trim().split(/\s+/)[1] ?? ""
    },
    settle,
    // A lone ESC byte is held briefly by the input parser before it is emitted as a key.
    escape: async () => {
      setup.mockInput.pressEscape()
      await Bun.sleep(80)
      await settle()
    },
    stop: () => {
      app.stop()
      setup.renderer.destroy()
    },
  }
  active = h
  return h
}

afterEach(() => {
  active?.stop()
  active = null
})

describe("tsexit UI", () => {
  test("renders status header, columns and nodes", async () => {
    const h = await boot()
    const f = h.frame()
    expect(f).toContain("NO EXIT NODE")
    expect(f).toContain("DEMO")
    expect(f).toContain("Exit nodes · 57")
    expect(f).toContain("Node")
    expect(f).toContain("Location")
    expect(f).toContain("Details")
    expect(f).toContain("suggested ★ hel-vps")
    // Own tailnet nodes rank above Mullvad nodes with the same status.
    expect(h.selectedName()).toBe("hel-vps")
    expect(h.list()).toContain("★ hel-vps")
    expect(h.lines()[ROW_Y + 1]!).toContain("home-server")
  })

  test("keyboard navigation moves the selection, End/Home jump", async () => {
    const h = await boot()
    h.setup.mockInput.pressArrow("down")
    h.setup.mockInput.pressKey("j")
    await h.settle()
    expect(h.lines()[ROW_Y + 2]!).toContain("▸")
    h.setup.mockInput.pressKey("g", { shift: true })
    await h.settle()
    expect(h.selectedName()).toBe("old-thinkpad")
    expect(h.lines().find((l) => l.includes("▸"))).toContain("expired")
    h.setup.mockInput.pressKey("g")
    await h.settle()
    expect(h.lines()[ROW_Y]!).toContain("▸")
    expect(h.selectedName()).toBe("hel-vps")
  })

  test("search filters, ! excludes, Esc clears and returns to the list", async () => {
    const h = await boot()
    h.setup.mockInput.pressKey("/")
    await h.setup.mockInput.typeText("frankfurt")
    await h.settle()
    expect(h.list()).toContain("de-fra-wg-001")
    expect(h.list()).not.toContain("hel-vps")
    expect(h.frame()).toContain("Exit nodes · 2 of 57")
    expect(h.frame()).toContain("Esc clear and back")

    await h.setup.mockInput.typeText(" !002")
    await h.settle()
    expect(h.list()).toContain("de-fra-wg-001")
    expect(h.list()).not.toContain("de-fra-wg-002")

    await h.escape()
    expect(h.list()).toContain("hel-vps")
    expect(h.frame()).toContain("Exit nodes · 57")
    expect(h.frame()).toContain("connect/disconnect")
  })

  test("Enter connects, d disconnects", async () => {
    const h = await boot()
    const name = h.selectedName()
    h.setup.mockInput.pressEnter()
    await h.setup.waitForFrame((f) => f.includes(`CONNECTED via ${name}`), { maxPasses: 40 })
    expect(h.list()).toContain("ACTIVE")
    expect(h.frame()).toContain("Disconnect")
    h.setup.mockInput.pressKey("d")
    await h.setup.waitForFrame((f) => f.includes("NO EXIT NODE"), { maxPasses: 40 })
    expect(h.list()).not.toContain("ACTIVE")
  })

  test("offline nodes need a second Enter", async () => {
    const h = await boot()
    h.setup.mockInput.pressKey("/")
    await h.setup.mockInput.typeText("offline")
    h.setup.mockInput.pressEnter()
    await h.settle()
    const name = h.selectedName()
    expect(name.length).toBeGreaterThan(0)
    h.setup.mockInput.pressEnter()
    await h.settle()
    expect(h.frame()).toContain(`${name} is offline`)
    expect(h.frame()).not.toContain("CONNECTED via")
    h.setup.mockInput.pressEnter()
    await h.setup.waitForFrame((f) => f.includes(`CONNECTED via ${name}`), { maxPasses: 40 })
    expect(h.frame()).toContain("exit node is offline")
  })

  test("mouse click selects a row, double-click connects, wheel scrolls", async () => {
    const h = await boot()
    await h.setup.mockMouse.click(10, ROW_Y + 3)
    await h.settle()
    expect(h.lines()[ROW_Y + 3]!).toContain("▸")
    const name = h.selectedName()
    await h.setup.mockMouse.doubleClick(10, ROW_Y + 3)
    await h.setup.waitForFrame((f) => f.includes(`CONNECTED via ${name}`), { maxPasses: 40 })

    const before = h.lines()[ROW_Y]!
    await h.setup.mockMouse.scroll(10, ROW_Y + 5, "down")
    await h.settle()
    expect(h.lines()[ROW_Y]!).not.toBe(before)
  })

  test("filter hotkeys and chip clicks", async () => {
    const h = await boot()
    h.setup.mockInput.pressKey("4")
    await h.settle()
    expect(h.list()).not.toContain("hel-vps")
    expect(h.list()).toContain("-wg-")
    h.setup.mockInput.pressKey("3")
    await h.settle()
    expect(h.list()).toContain("hel-vps")
    expect(h.list()).not.toContain("-wg-")

    // Click the "All" chip on the toolbar row (y=3).
    const toolbarLine = h.lines()[3]!
    const x = toolbarLine.indexOf("All")
    expect(x).toBeGreaterThan(0)
    await h.setup.mockMouse.click(x, 3)
    await h.settle()
    expect(h.list()).toContain("-wg-")
    expect(h.frame()).toContain("Exit nodes · 57")
  })

  test("sort key cycles fields and header click sorts by column", async () => {
    const h = await boot()
    h.setup.mockInput.pressKey("s")
    await h.settle()
    expect(h.lines()[ROW_Y - 1]!).toContain("Node ▴")
    expect(h.selectedName()).toBe("hel-vps")
    const header = h.lines()[ROW_Y - 1]!
    const x = header.indexOf("Location")
    await h.setup.mockMouse.click(x + 1, ROW_Y - 1)
    await h.settle()
    expect(h.lines()[ROW_Y - 1]!).toContain("Location ▴")
    // The selection (hel-vps, no location, sorts last) stays selected and visible.
    expect(h.selectedName()).toBe("hel-vps")
    h.setup.mockInput.pressKey("g")
    await h.settle()
    expect(h.lines()[ROW_Y]!).toContain("ae-dxb")
    await h.setup.mockMouse.click(x + 1, ROW_Y - 1)
    await h.settle()
    expect(h.lines()[ROW_Y - 1]!).toContain("Location ▾")
    h.setup.mockInput.pressKey("g")
    await h.settle()
    expect(h.lines()[ROW_Y]!).not.toContain("ae-dxb")
  })

  test("ping fills the latency column and the details panel", async () => {
    const h = await boot()
    const name = h.selectedName()
    h.setup.mockInput.pressKey("p")
    await h.setup.waitForFrame((f) => new RegExp(`${name}.*\\d+(\\.\\d+)? ms`).test(f), { maxPasses: 40 })
    expect(h.frame()).toMatch(/Latency\s+\d+(\.\d+)? ms/)
  })

  test("LAN toggle and help overlay", async () => {
    const h = await boot()
    expect(h.frame()).toContain("LAN access off")
    h.setup.mockInput.pressKey("l")
    await h.setup.waitForFrame((f) => f.includes("LAN access on"), { maxPasses: 40 })

    h.setup.mockInput.pressKey("?")
    await h.settle()
    expect(h.frame()).toContain("Keyboard and mouse")
    expect(h.frame()).toContain("Esc close help")
    await h.escape()
    expect(h.frame()).not.toContain("Keyboard and mouse")
  })

  test("narrow and short terminals fall back to compact layouts", async () => {
    const h = await boot(72, 18)
    const f = h.frame()
    expect(f).not.toContain("Details")
    expect(f).toContain("NO EXIT NODE")
    expect(h.selectedName()).toBe("hel-vps")
    // header 1 + toolbar 1 + border 1 + column header 1 -> first row at y=4
    expect(h.lines()[4]!).toContain("▸")
  })

  test("toggling the details panel widens the list", async () => {
    const h = await boot()
    const before = h.lines()[ROW_Y]!.indexOf("│ │")
    expect(before).toBeGreaterThan(0)
    h.setup.mockInput.pressKey("i")
    await h.settle()
    expect(h.frame()).not.toContain("Details")
    expect(h.lines()[ROW_Y]!).not.toContain("│ │")
    h.setup.mockInput.pressKey("i")
    await h.settle()
    expect(h.frame()).toContain("Details")
  })
})
