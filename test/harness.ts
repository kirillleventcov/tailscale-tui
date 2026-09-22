// Boots the whole app against the fixture backend in OpenTUI's test renderer.
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { App } from "../src/app";
import type { ViewId } from "../src/view";
import { FixtureBackend, type FixtureOptions } from "./fixture";

export interface Harness {
  setup: TestRendererSetup;
  app: App;
  backend: FixtureBackend;
  /** argv of every interactive command (ssh, sudo) the app started. */
  spawned: string[][];
  frame(): string;
  lines(): string[];
  /** The line holding the selection marker. */
  selectedLine(): string;
  settle(): Promise<void>;
  press(
    name: string,
    mods?: { shift?: boolean; ctrl?: boolean },
  ): Promise<void>;
  type(text: string): Promise<void>;
  enter(): Promise<void>;
  escape(): Promise<void>;
  /** Wait until the frame contains `text` (or matches the predicate). */
  waitFor(
    text: string | RegExp | ((f: string) => boolean),
    maxPasses?: number,
  ): Promise<void>;
  /** Jump to the first row, then press ↓ until the selected line contains `text`. */
  select(text: string): Promise<void>;
  stop(): void;
}

let active: Harness | null = null;

export function stopActive(): void {
  active?.stop();
  active = null;
}

export async function boot(
  opts: {
    view?: ViewId;
    width?: number;
    height?: number;
    fixture?: FixtureOptions;
    spawnCode?: number;
  } = {},
): Promise<Harness> {
  const setup = await createTestRenderer({
    width: opts.width ?? 120,
    height: opts.height ?? 34,
  });
  const backend = new FixtureBackend(opts.fixture);
  const spawned: string[][] = [];
  const app = new App(setup.renderer, {
    backend,
    refreshMs: 0,
    version: "test",
    view: opts.view ?? "home",
    spawn: async (argv) => {
      spawned.push(argv);
      return opts.spawnCode ?? 0;
    },
  });
  await app.start();
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(1);
      await setup.renderOnce();
    }
  };
  await settle();
  const lines = () => setup.captureCharFrame().split("\n");
  const h: Harness = {
    setup,
    app,
    backend,
    spawned,
    frame: () => setup.captureCharFrame(),
    lines,
    selectedLine: () => lines().find((l) => l.includes("▸")) ?? "",
    settle,
    press: async (name, mods) => {
      setup.mockInput.pressKey(name, mods);
      await settle();
    },
    type: async (text) => {
      await setup.mockInput.typeText(text);
      await settle();
    },
    enter: async () => {
      setup.mockInput.pressEnter();
      await settle();
    },
    // A lone ESC byte is held briefly by the input parser before it is emitted as a key.
    escape: async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(80);
      await settle();
    },
    waitFor: async (want, maxPasses = 60) => {
      const pred =
        typeof want === "string"
          ? (f: string) => f.includes(want)
          : want instanceof RegExp
            ? (f: string) => want.test(f)
            : want;
      for (let i = 0; i < maxPasses; i++) {
        await settle();
        if (pred(setup.captureCharFrame())) return;
        await Bun.sleep(5);
      }
      throw new Error(
        `timed out waiting for ${String(want)}\n${setup.captureCharFrame()}`,
      );
    },
    select: async (text) => {
      setup.mockInput.pressKey("HOME");
      await settle();
      for (let i = 0; i < 60; i++) {
        if (h.selectedLine().includes(text)) return;
        setup.mockInput.pressArrow("down");
        await settle();
      }
      throw new Error(`no row with ${text}\n${setup.captureCharFrame()}`);
    },
    stop: () => {
      app.stop();
      setup.renderer.destroy();
    },
  };
  active = h;
  return h;
}
