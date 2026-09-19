import { afterEach, describe, expect, test } from "bun:test";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { App, computeColumns } from "../src/app";
import { FixtureBackend, type FixtureOptions } from "./fixture";

interface Harness {
  setup: TestRendererSetup;
  app: App;
  backend: FixtureBackend;
  /** y of the first node row: toolbar + panel border + column header. */
  firstRow: number;
  frame: () => string;
  lines: () => string[];
  /** Text of the node list only (excludes toolbar and details). */
  list: () => string;
  selectedName: () => string;
  settle: () => Promise<void>;
  escape: () => Promise<void>;
  stop: () => void;
}

let active: Harness | null = null;

/** Full layout: toolbar(3) + panel border(1) + column header(1). */
const ROW_Y = 5;
/** Every exit-node capable peer in the fixture (the non-exit "phone" peer is filtered out). */
const TOTAL = 15;
const ONLINE = 12;

/** Matches the list row of `name` while it is the active exit node. */
const activeRow = (name: string) => (f: string) =>
  new RegExp(`${name}\\s+ACTIVE`).test(f);

async function boot(
  width = 120,
  height = 32,
  opts: FixtureOptions = {},
): Promise<Harness> {
  const setup = await createTestRenderer({ width, height });
  const backend = new FixtureBackend(opts);
  const app = new App(setup.renderer, {
    backend,
    refreshMs: 0,
    version: "test",
  });
  await app.start();
  const settle = async () => {
    for (let i = 0; i < 3; i++) await setup.renderOnce();
  };
  await settle();
  const compact = height < 22;
  const firstRow = compact ? 3 : ROW_Y;
  const lines = () => setup.captureCharFrame().split("\n");
  const h: Harness = {
    setup,
    app,
    backend,
    firstRow,
    frame: () => setup.captureCharFrame(),
    lines,
    list: () =>
      lines()
        .slice(firstRow, height - 1)
        .map((l) => l.split("│ │")[0] ?? l)
        .join("\n"),
    selectedName: () => {
      const line = lines().find((l) => l.includes("▸")) ?? "";
      return line.trim().split(/\s+/)[1] ?? "";
    },
    settle,
    // A lone ESC byte is held briefly by the input parser before it is emitted as a key.
    escape: async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(80);
      await settle();
    },
    stop: () => {
      app.stop();
      setup.renderer.destroy();
    },
  };
  active = h;
  return h;
}

afterEach(() => {
  active?.stop();
  active = null;
});

describe("tsexit UI", () => {
  test("renders columns and nodes parsed from tailscale status", async () => {
    const h = await boot();
    const f = h.frame();
    expect(f).not.toContain("ACTIVE");
    expect(f).toContain(`Exit nodes · ${TOTAL}`);
    expect(f).toContain("Node");
    expect(f).toContain("Location");
    expect(f).toContain("Details");
    expect(f).toContain("★ Auto off");
    // Own tailnet nodes rank above Mullvad nodes with the same status; the non-exit "phone" peer is absent.
    expect(h.selectedName()).toBe("home-server");
    expect(h.lines()[ROW_Y + 1]!).toContain("office-gw");
    expect(h.list()).toContain("★ fi-hel-wg-203");
    expect(h.list()).toContain("US Los Angeles, CA");
    expect(h.list()).not.toContain("phone");
    // Details for the selected tailnet node: owner and key expiry come from the status document.
    expect(f).toContain("you@example.com");
    expect(f).toContain("Key expiry 2027-03-01");
  });

  test("keyboard navigation moves the selection, End/Home jump", async () => {
    const h = await boot();
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressKey("j");
    await h.settle();
    expect(h.lines()[ROW_Y + 2]!).toContain("▸");
    h.setup.mockInput.pressKey("g", { shift: true });
    await h.settle();
    expect(h.selectedName()).toBe("old-thinkpad");
    expect(h.lines().find((l) => l.includes("▸"))).toContain("expired");
    expect(h.frame()).toContain("expired, re-authenticate it");
    h.setup.mockInput.pressKey("g");
    await h.settle();
    expect(h.lines()[ROW_Y]!).toContain("▸");
    expect(h.selectedName()).toBe("home-server");
  });

  test("search filters, ! excludes, Esc clears and returns to the list", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("/");
    await h.setup.mockInput.typeText("frankfurt");
    await h.settle();
    expect(h.list()).toContain("de-fra-wg-001");
    expect(h.list()).not.toContain("home-server");
    expect(h.frame()).toContain(`Exit nodes · 2 of ${TOTAL}`);

    await h.setup.mockInput.typeText(" !002");
    await h.settle();
    expect(h.list()).toContain("de-fra-wg-001");
    expect(h.list()).not.toContain("de-fra-wg-002");

    await h.escape();
    expect(h.list()).toContain("home-server");
    expect(h.frame()).toContain(`Exit nodes · ${TOTAL}`);
  });

  test("Enter connects, d disconnects, and the CLI calls match", async () => {
    const h = await boot();
    expect(h.selectedName()).toBe("home-server");
    h.setup.mockInput.pressEnter();
    await h.setup.waitForFrame(activeRow("home-server"), { maxPasses: 40 });
    expect(h.frame()).toContain("◉ ACTIVE");
    expect(h.frame()).toContain("Disconnect");
    expect(h.frame()).toContain("direct 192.168.0.20:41641");
    expect(h.frame()).toContain("↓ 98 MB  ↑ 2.6 MB");
    h.setup.mockInput.pressKey("d");
    await h.setup.waitForFrame((f) => !f.includes("ACTIVE"), { maxPasses: 40 });
    expect(h.frame()).toContain("Connect");
    expect(h.backend.calls).toEqual([
      "set --exit-node=100.64.0.20",
      "set --exit-node=",
    ]);
  });

  test("offline nodes need a second Enter", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("/");
    await h.setup.mockInput.typeText("pixel");
    h.setup.mockInput.pressEnter();
    await h.settle();
    expect(h.selectedName()).toBe("pixel-8");
    h.setup.mockInput.pressEnter();
    await h.settle();
    expect(h.frame()).toContain("pixel-8 is offline");
    expect(h.frame()).not.toContain("ACTIVE");
    h.setup.mockInput.pressEnter();
    await h.setup.waitForFrame(activeRow("pixel-8"), { maxPasses: 40 });
    expect(h.frame()).toContain("exit node is offline");
  });

  test("expired nodes cannot be used", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("g", { shift: true });
    h.setup.mockInput.pressEnter();
    await h.settle();
    expect(h.frame()).toContain("old-thinkpad has an expired key");
    expect(h.backend.calls).toEqual([]);
  });

  test("mouse click selects a row, double-click connects, wheel scrolls", async () => {
    // A short terminal so the 15 nodes overflow the list and scrolling has an effect.
    const h = await boot(120, 18);
    const y = h.firstRow;
    await h.setup.mockMouse.click(10, y + 3);
    await h.settle();
    expect(h.lines()[y + 3]!).toContain("▸");
    const name = h.selectedName();
    await h.setup.mockMouse.doubleClick(10, y + 3);
    await h.setup.waitForFrame(activeRow(name), { maxPasses: 40 });

    const before = h.lines()[y]!;
    await h.setup.mockMouse.scroll(10, y + 5, "down");
    await h.settle();
    expect(h.lines()[y]!).not.toBe(before);
  });

  test("filter hotkeys and chip clicks", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("4");
    await h.settle();
    expect(h.list()).not.toContain("home-server");
    expect(h.list()).toContain("-wg-");
    h.setup.mockInput.pressKey("3");
    await h.settle();
    expect(h.list()).toContain("home-server");
    expect(h.list()).not.toContain("-wg-");

    // Click the "All" chip on the toolbar row (y=1).
    const toolbarLine = h.lines()[1]!;
    const x = toolbarLine.indexOf("All");
    expect(x).toBeGreaterThan(0);
    await h.setup.mockMouse.click(x, 1);
    await h.settle();
    expect(h.list()).toContain("-wg-");
    expect(h.frame()).toContain(`Exit nodes · ${TOTAL}`);
  });

  test("sort key cycles fields and header click sorts by column", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("s");
    await h.settle();
    expect(h.lines()[ROW_Y - 1]!).toContain("Node ▴");
    expect(h.selectedName()).toBe("home-server");
    const header = h.lines()[ROW_Y - 1]!;
    const x = header.indexOf("Location");
    await h.setup.mockMouse.click(x + 1, ROW_Y - 1);
    await h.settle();
    expect(h.lines()[ROW_Y - 1]!).toContain("Location ▴");
    // The selection (home-server, no location, sorts last) stays selected and visible.
    expect(h.selectedName()).toBe("home-server");
    h.setup.mockInput.pressKey("g");
    await h.settle();
    expect(h.lines()[ROW_Y]!).toContain("au-syd");
    await h.setup.mockMouse.click(x + 1, ROW_Y - 1);
    await h.settle();
    expect(h.lines()[ROW_Y - 1]!).toContain("Location ▾");
    h.setup.mockInput.pressKey("g");
    await h.settle();
    expect(h.lines()[ROW_Y]!).not.toContain("au-syd");
  });

  test("ping fills the latency column and shows how it was measured", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("p");
    await h.setup.waitForFrame((f) => /home-server.*\b12 ms/.test(f), {
      maxPasses: 40,
    });
    expect(h.frame()).toMatch(
      /Latency\s+12 ms\s+│[\s\S]*│\s+via 192\.168\.0\.20:41641/,
    );

    // Mullvad nodes are measured with ICMP to the relay's public address.
    h.setup.mockInput.pressKey("/");
    await h.setup.mockInput.typeText("fi-hel");
    h.setup.mockInput.pressEnter();
    h.setup.mockInput.pressKey("p");
    await h.setup.waitForFrame((f) => /fi-hel-wg-203.*6\.2 ms/.test(f), {
      maxPasses: 40,
    });
    expect(h.frame()).toMatch(
      /Latency\s+6\.2 ms\s+│[\s\S]*│\s+icmp 203\.0\.113\.203/,
    );
  });

  test("P pings every visible online node and reports the result", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("p", { shift: true });
    await h.setup.waitForFrame(
      (f) => f.includes(`Pinged ${ONLINE} nodes, ${ONLINE} replied`),
      { maxPasses: 80 },
    );
    expect(h.frame()).toContain("Ping all");
    expect(h.frame()).not.toContain("Pinging…");
    const list = h.list();
    expect(list).toMatch(/au-syd-wg-001.*297 ms/);
    expect(list).toMatch(/office-gw.*9\.0 ms/);
    // Offline nodes are skipped, not marked as timeouts.
    expect(list).not.toContain("timeout");
  });

  test("the Ping all chip pings the visible nodes with the mouse", async () => {
    const h = await boot(120, 32, { delayMs: 60 });
    const x = h.lines()[1]!.indexOf("Ping all");
    expect(x).toBeGreaterThan(0);
    await h.setup.mockMouse.click(x + 1, 1);
    await h.setup.waitForFrame((f) => f.includes("Pinging…"), {
      maxPasses: 40,
    });
    const done = `Pinged ${ONLINE} nodes, ${ONLINE} replied`;
    for (let i = 0; i < 50 && !h.frame().includes(done); i++) {
      await Bun.sleep(50);
      await h.settle();
    }
    expect(h.frame()).toContain(done);
    expect(h.list()).toMatch(/fi-hel-wg-203.*6\.2 ms/);
  });

  test("a toggles Tailscale's auto exit node; picking a node manually turns it off", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("a");
    await h.setup.waitForFrame(activeRow("fi-hel-wg-203"), { maxPasses: 40 });
    expect(h.frame()).toContain("★ Auto on");
    expect(h.frame()).toContain(
      "Tailscale now picks and follows the best exit node",
    );
    expect(h.backend.calls).toEqual(["set --exit-node=auto:any"]);

    // Enter on another node pins it and leaves auto mode.
    h.setup.mockInput.pressKey("/");
    await h.setup.mockInput.typeText("home-server");
    h.setup.mockInput.pressEnter();
    await h.settle();
    expect(h.selectedName()).toBe("home-server");
    h.setup.mockInput.pressEnter();
    await h.setup.waitForFrame(activeRow("home-server"), { maxPasses: 40 });
    await h.escape();
    expect(h.frame()).toContain("(auto exit node off)");
    expect(h.frame()).toContain("★ Auto off");
    expect(h.backend.calls.at(-1)).toBe("set --exit-node=100.64.0.20");

    // Back to auto, then a again keeps the chosen node but stops following.
    h.setup.mockInput.pressKey("a");
    await h.setup.waitForFrame((f) => f.includes("★ Auto on"), {
      maxPasses: 40,
    });
    h.setup.mockInput.pressKey("a");
    await h.setup.waitForFrame(
      (f) => f.includes("Auto exit node off, staying on fi-hel-wg-203"),
      { maxPasses: 40 },
    );
    expect(h.backend.calls.at(-1)).toBe("set --exit-node=100.64.1.203");
    expect(activeRow("fi-hel-wg-203")(h.frame())).toBe(true);
    expect(h.frame()).toContain("★ Auto off");
  });

  test("A connects to the suggested node once", async () => {
    const h = await boot();
    h.setup.mockInput.pressKey("a", { shift: true });
    await h.setup.waitForFrame(activeRow("fi-hel-wg-203"), { maxPasses: 40 });
    expect(h.frame()).toContain("★ Auto off");
    expect(h.backend.calls).toEqual(["set --exit-node=100.64.1.203"]);
    expect(h.selectedName()).toBe("fi-hel-wg-203");
  });

  test("starts in auto mode when Tailscale already has it on", async () => {
    const h = await boot(120, 32, {
      autoExitNode: true,
      exitNodeId: "nFIHEL203CNTRL",
    });
    expect(activeRow("fi-hel-wg-203")(h.frame())).toBe(true);
    expect(h.frame()).toContain("★ Auto on");
    expect(h.selectedName()).toBe("fi-hel-wg-203");
    expect(h.frame()).toContain("auto, chosen by Tailscale");
  });

  test("LAN toggle and help overlay", async () => {
    const h = await boot();
    expect(h.frame()).toContain("LAN off");
    h.setup.mockInput.pressKey("l");
    await h.setup.waitForFrame((f) => f.includes("LAN on"), { maxPasses: 40 });
    expect(h.backend.calls).toEqual(["set --exit-node-allow-lan-access=true"]);

    // The key legend and the tailnet summary live in the overlay, not in a status bar.
    expect(h.frame()).not.toContain("tailnet tsexit-fixture.github");
    h.setup.mockInput.pressKey("?");
    await h.settle();
    const f = h.frame();
    expect(f).toContain("Keyboard and mouse");
    expect(f).toContain("Enter connect or disconnect");
    expect(f).toContain("tsexit vtest");
    expect(f).toContain("tailnet tsexit-fixture.github");
    expect(f).toContain("device my-laptop");
    expect(f).toContain(
      `LAN access on · ${TOTAL} exit nodes (${ONLINE} online)`,
    );
    await h.escape();
    expect(h.frame()).not.toContain("Keyboard and mouse");
  });

  test("narrow and short terminals fall back to compact layouts", async () => {
    const h = await boot(72, 18);
    const f = h.frame();
    expect(f).not.toContain("Details");
    expect(f).not.toContain("ACTIVE");
    expect(h.selectedName()).toBe("home-server");
    // toolbar 1 + border 1 + column header 1 -> first row at y=3
    expect(h.lines()[3]!).toContain("▸");
  });

  test("toggling the details panel widens the list", async () => {
    const h = await boot();
    const before = h.lines()[ROW_Y]!.indexOf("│ │");
    expect(before).toBeGreaterThan(0);
    h.setup.mockInput.pressKey("i");
    await h.settle();
    expect(h.frame()).not.toContain("Details");
    expect(h.lines()[ROW_Y]!).not.toContain("│ │");
    h.setup.mockInput.pressKey("i");
    await h.settle();
    expect(h.frame()).toContain("Details");
  });

  test("the OS column is dropped when the tailnet only has Mullvad exit nodes", async () => {
    const h = await boot(120, 32, { mullvadOnly: true });
    const header = h.lines()[ROW_Y - 1]!;
    expect(header).toContain("Prio");
    expect(header).not.toMatch(/\bOS\b/);
    expect(h.frame()).toContain("Exit nodes · 11");
    expect(h.selectedName()).toBe("au-syd-wg-001");
  });
});

describe("computeColumns", () => {
  test("drops optional columns from the right as the width shrinks", () => {
    expect(computeColumns(120).map((c) => c.id)).toEqual([
      "mark",
      "name",
      "status",
      "location",
      "latency",
      "os",
      "priority",
    ]);
    expect(computeColumns(120, false).map((c) => c.id)).toEqual([
      "mark",
      "name",
      "status",
      "location",
      "latency",
      "priority",
    ]);
    expect(computeColumns(40).map((c) => c.id)).toEqual([
      "mark",
      "name",
      "status",
    ]);
    const cols = computeColumns(60);
    const used = cols.reduce((w, c) => w + c.width, 0) + cols.length - 1;
    expect(used).toBe(60);
  });
});
