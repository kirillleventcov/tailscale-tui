#!/usr/bin/env bun
// Renders a view headlessly against your real tailnet and prints it as plain text (used for the
// README previews). Nothing is changed: only read-only commands run. --redact swaps the account,
// the tailnet name and public addresses for documentation values of the same width.
// Usage: bun scripts/screenshot.ts [view] [width] [height] [--ping] [--redact]
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "../src/app";
import {
  TailscaleBackend,
  findTailscaleBinary,
} from "../src/backend/tailscale";
import { VERSION } from "../src/meta";
import type { TailscaleState } from "../src/model";
import type { ViewId } from "../src/view";

/** Replace each secret with a stand-in padded or cut to the same width, so columns stay aligned. */
function redactFrame(frame: string, s: TailscaleState | null): string {
  if (!s) return frame;
  const pairs: [string, string][] = [];
  if (s.user) pairs.push([s.user.login, "you@example.com"]);
  if (s.tailnet && s.tailnet !== s.user?.login)
    pairs.push([s.tailnet, "example.com"]);
  if (s.magicDnsSuffix) pairs.push([s.magicDnsSuffix, "tail0000.ts.net"]);
  let out = frame;
  for (const [secret, stand] of pairs.sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const fitted =
      stand.length >= secret.length
        ? stand.slice(0, secret.length)
        : stand.padEnd(secret.length);
    out = out.split(secret).join(fitted);
  }
  // Public endpoints: IPv4 outside the tailnet's 100.64.0.0/10, and global IPv6.
  const same = (text: string, len: number) => text.padEnd(len).slice(0, len);
  out = out.replace(
    /\b(?!100\.)(?!192\.168\.)(?!10\.)\d{1,3}(?:\.\d{1,3}){3}(:\d+)?/g,
    (all, port: string | undefined) =>
      same(`203.0.113.7${port ?? ""}`, all.length),
  );
  out = out.replace(
    /\[?\b2[0-9a-f]{3}:[0-9a-f:]+…?\]?(:\d+)?/gi,
    (all, port: string | undefined) =>
      same(`[2001:db8::1]${port ?? ""}`, all.length),
  );
  return out;
}

const VIEWS: ViewId[] = [
  "home",
  "exit",
  "devices",
  "network",
  "sharing",
  "settings",
];
const args = Bun.argv.slice(2);
const ping = args.includes("--ping");
const redact = args.includes("--redact");
const view = (args.find((a) => (VIEWS as string[]).includes(a)) ??
  "home") as ViewId;
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const width = nums[0] ?? 118;
const height = nums[1] ?? 32;

const bin = findTailscaleBinary();
if (!bin) {
  console.error("tailscale CLI not found");
  process.exit(1);
}

const setup = await createTestRenderer({ width, height });
const app = new App(setup.renderer, {
  backend: new TailscaleBackend({ bin }),
  refreshMs: 0,
  version: VERSION,
  view,
  spawn: async () => 0,
});
const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await setup.renderOnce();
};
/** Render until `pred` holds, in real time, or give up quietly after `ms`. */
const waitFor = async (pred: (f: string) => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred(setup.captureCharFrame())) {
    await Bun.sleep(100);
    await settle(1);
  }
};
try {
  await app.start();
  await settle();
  // Suggestions, netcheck and the other views' data arrive asynchronously.
  if (view === "home" || view === "network")
    await waitFor((f) => !f.includes("measuring"), 30_000);
  if (view === "exit") await waitFor((f) => f.includes("★ "), 6000);
  await waitFor(() => false, 1500);
  if (ping) {
    setup.mockInput.pressKey("p", { shift: true });
    await waitFor((f) => /Pinged \d+ nodes|of \d+ replied/.test(f), 300_000);
    // Let the summary toast expire.
    await waitFor(() => false, 6500);
  }
  await settle();
  const frame = setup.captureCharFrame();
  const state = (app as unknown as { state: TailscaleState | null }).state;
  process.stdout.write(redact ? redactFrame(frame, state) : frame);
} finally {
  app.stop();
  setup.renderer.destroy();
}
