#!/usr/bin/env bun
// Renders the UI headlessly against your real tailnet and prints it as plain text (used for the README preview).
// Usage: bun scripts/screenshot.ts [width] [height] [--ping]
import { createTestRenderer } from "@opentui/core/testing";
import pkg from "../package.json" with { type: "json" };
import { App } from "../src/app";
import {
  TailscaleBackend,
  findTailscaleBinary,
} from "../src/backend/tailscale";

const args = Bun.argv.slice(2);
const ping = args.includes("--ping");
const nums = args.filter((a) => !a.startsWith("--")).map(Number);
const width = nums[0] ?? 118;
const height = nums[1] ?? 30;

const bin = findTailscaleBinary();
if (!bin) {
  console.error("tailscale CLI not found");
  process.exit(1);
}

const setup = await createTestRenderer({ width, height });
const app = new App(setup.renderer, {
  backend: new TailscaleBackend({ bin }),
  refreshMs: 0,
  version: pkg.version,
});
const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await setup.renderOnce();
};
const waitFor = async (pred: (f: string) => boolean, maxPasses: number) => {
  try {
    await setup.waitForFrame(pred, { maxPasses });
  } catch {
    // keep going with whatever is on screen
  }
};
try {
  await app.start();
  await settle();
  // `tailscale exit-node suggest` answers asynchronously; wait for the star.
  await waitFor((f) => f.includes("★ "), 60);
  if (ping) {
    setup.mockInput.pressKey("p", { shift: true });
    // Wait (in real time) for the summary toast, then let it expire.
    const finished = (f: string) => /Pinged \d+ nodes|of \d+ replied/.test(f);
    for (let i = 0; i < 600 && !finished(setup.captureCharFrame()); i++) {
      await Bun.sleep(500);
      await settle(1);
    }
    await Bun.sleep(6500);
  }
  await settle();
  process.stdout.write(setup.captureCharFrame());
} finally {
  app.stop();
  setup.renderer.destroy();
}
