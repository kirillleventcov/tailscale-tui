// State-changing flows shared by several views. Each one goes through ctx.runAction, so the
// spinner, the error toast and the status refresh behave the same everywhere.
import { cliError } from "./backend/cli";
import type { ExitNode } from "./model";
import type { ViewContext } from "./view";

async function set(
  ctx: ViewContext,
  args: string[],
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const res = await ctx.backend.cli(args, { privileged: true, timeoutMs });
  if (res.code !== 0) throw cliError(res, what);
}

export function currentExitNode(ctx: ViewContext): ExitNode | undefined {
  const s = ctx.state;
  if (!s) return undefined;
  return (
    s.nodes.find((n) => n.active) ??
    (s.exitNode ? s.nodes.find((n) => n.id === s.exitNode!.id) : undefined)
  );
}

// ---------------------------------------------------------------------------
// Exit node
// ---------------------------------------------------------------------------

export async function connectExitNode(
  ctx: ViewContext,
  n: ExitNode,
): Promise<void> {
  const wasAuto = ctx.state?.autoExitNode === true;
  await ctx.runAction(
    `Connecting to ${n.name}`,
    () => ctx.backend.setExitNode(n),
    {
      onOk: () =>
        ctx.notify(
          `Internet traffic now exits via ${n.name}${wasAuto ? " (auto exit node off)" : ""}`,
          "ok",
        ),
    },
  );
}

export async function disconnectExitNode(ctx: ViewContext): Promise<void> {
  const s = ctx.state;
  const auto = s?.autoExitNode === true;
  if (!currentExitNode(ctx) && !s?.exitNode && !auto) {
    ctx.notify("Not using an exit node", "info");
    return;
  }
  await ctx.runAction("Disconnecting", () => ctx.backend.setExitNode(null), {
    onOk: () =>
      ctx.notify(
        `Exit node disabled, traffic leaves directly${auto ? " (auto exit node off)" : ""}`,
        "ok",
      ),
  });
}

/** Turn Tailscale's automatic exit node selection on, or off while keeping the current node. */
export async function toggleAutoExitNode(ctx: ViewContext): Promise<void> {
  if (ctx.state?.autoExitNode) {
    const cur = currentExitNode(ctx);
    if (cur) {
      await ctx.runAction(
        `Keeping ${cur.name}`,
        () => ctx.backend.setExitNode(cur),
        {
          onOk: () =>
            ctx.notify(`Auto exit node off, staying on ${cur.name}`, "ok"),
        },
      );
    } else {
      await ctx.runAction(
        "Turning auto exit node off",
        () => ctx.backend.setExitNode(null),
        {
          onOk: () => ctx.notify("Auto exit node off", "ok"),
        },
      );
    }
    return;
  }
  await ctx.runAction(
    "Enabling auto exit node",
    () => ctx.backend.setAutoExitNode(),
    {
      onOk: () =>
        ctx.notify("Tailscale now picks and follows the best exit node", "ok"),
    },
  );
}

export async function toggleLanAccess(ctx: ViewContext): Promise<void> {
  const cur = ctx.state?.allowLan ?? false;
  await ctx.runAction(
    cur ? "Disabling LAN access" : "Enabling LAN access",
    () => ctx.backend.setAllowLan(!cur),
    {
      onOk: () =>
        ctx.notify(
          cur
            ? "LAN access disabled"
            : "LAN access enabled while using an exit node",
          "ok",
        ),
    },
  );
}

// ---------------------------------------------------------------------------
// Tailscale itself
// ---------------------------------------------------------------------------

/** `tailscale up` with no flags: back to Running with the settings it had. */
export async function tailscaleUp(ctx: ViewContext): Promise<void> {
  await ctx.runAction(
    "Starting Tailscale",
    () => set(ctx, ["up"], "tailscale up", 30_000),
    {
      onOk: () => ctx.notify("Tailscale is on", "ok"),
    },
  );
}

/** `tailscale down`, after a second press: every tailnet connection drops. */
export async function tailscaleDown(ctx: ViewContext): Promise<void> {
  if (
    !ctx.confirm(
      "down",
      "Turn Tailscale off? Every tailnet connection drops. Press again to confirm.",
    )
  )
    return;
  await ctx.runAction(
    "Stopping Tailscale",
    () => set(ctx, ["down"], "tailscale down"),
    {
      onOk: () => ctx.notify("Tailscale is off", "ok"),
    },
  );
}

/**
 * Start a login. `tailscale login` blocks until the browser flow finishes, so it runs with a short
 * timeout: tailscaled keeps the flow open and reports the URL in `status --json` as AuthURL.
 */
export async function startLogin(
  ctx: ViewContext,
  extra: string[] = [],
): Promise<void> {
  await ctx.runAction(
    "Starting login",
    async () => {
      const res = await ctx.backend.cli(["login", "--timeout=5s", ...extra], {
        privileged: true,
        timeoutMs: 20_000,
      });
      const out = `${res.stdout}\n${res.stderr}`;
      // A timeout while waiting for the browser is the expected outcome.
      if (
        res.code !== 0 &&
        !/https:\/\/\S+/.test(out) &&
        !/timeout|timed out|context deadline/i.test(out)
      )
        throw cliError(res, "tailscale login");
    },
    {
      onOk: () => {
        if (ctx.state?.backendState === "Running")
          ctx.notify("Logged in", "ok");
        else
          ctx.notify("Open the login link to finish signing in", "info", 6000);
      },
    },
  );
}

/** Open a URL in the desktop browser; the link is copied as well since terminals may be remote. */
export function openUrl(ctx: ViewContext, url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    const p = Bun.spawn([cmd, url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    p.unref();
    ctx.copy(url, "the link");
  } catch {
    ctx.copy(url, "the link");
  }
}
