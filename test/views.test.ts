import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, stopActive } from "./harness";

afterEach(() => stopActive());

const USER = process.env.USER ?? "root";

describe("shell", () => {
  test("opens on Home: this device, the exit node, the devices and the network", async () => {
    const h = await boot();
    await h.waitFor("easy, direct paths");
    const f = h.frame();
    expect(f).toContain("1 Home");
    expect(f).toContain("6 Settings");
    expect(f).toContain("This device");
    expect(f).toContain("my-laptop.tail0000.ts.net");
    expect(f).toContain("you@example.com");
    expect(f).toContain("No exit node");
    expect(f).toContain("★ fi-hel-wg-203");
    // Mullvad relays are exit nodes, not devices.
    expect(f).toContain("Devices · 4 of 6 online");
    expect(f).not.toMatch(/Devices[\s\S]*se-sto-wg/);
    expect(f).toContain("Nearest    hel Helsinki");
  });

  test("digits, brackets and tab clicks switch views", async () => {
    const h = await boot();
    await h.press("2");
    expect(h.frame()).toContain("Exit nodes · 15");
    await h.press("]");
    expect(h.frame()).toContain("Devices · 7");
    await h.press("]");
    await h.waitFor("CONNECTIVITY");
    await h.press("[");
    expect(h.frame()).toContain("Devices · 7");
    const x = h.lines()[0]!.indexOf("Settings");
    await h.setup.mockMouse.click(x, 0);
    await h.waitFor("ACCOUNT");
    await h.press("1");
    expect(h.frame()).toContain("This device");
  });

  test("? shows the active view's keys and the tailnet summary", async () => {
    const h = await boot({ view: "devices" });
    await h.press("?");
    const f = h.frame();
    expect(f).toContain("Keyboard and mouse");
    expect(f).toContain("Enter SSH");
    expect(f).toContain("1-6 or click a tab");
    expect(f).toContain("tsexit vtest");
    expect(f).toContain("tailnet tsexit-fixture.github");
    await h.escape();
    expect(h.frame()).not.toContain("Keyboard and mouse");
  });

  test("letters and digits typed into a search box stay in it", async () => {
    const h = await boot({ view: "devices" });
    await h.press("/");
    await h.type("q3");
    expect(h.frame()).toContain("Devices · 0 of 7");
    expect(h.frame()).toContain("q3");
    await h.escape();
    expect(h.frame()).toContain("Devices · 7");
  });
});

describe("home", () => {
  test("a turns the auto exit node on, d disconnects", async () => {
    const h = await boot();
    await h.press("a");
    await h.waitFor("★ auto, chosen by Tailscale");
    expect(h.frame()).toContain("◉ fi-hel-wg-203");
    await h.press("d");
    await h.waitFor("No exit node");
    expect(h.backend.calls).toEqual([
      "set --exit-node=auto:any",
      "set --exit-node=",
    ]);
  });

  test("A connects to the suggested exit node and l toggles LAN access", async () => {
    const h = await boot();
    await h.press("a", { shift: true });
    await h.waitFor("◉ fi-hel-wg-203");
    expect(h.frame()).toContain("Mode       manual");
    await h.press("l");
    await h.waitFor("LAN access on");
    expect(h.backend.calls).toEqual([
      "set --exit-node=100.64.1.203",
      "set --exit-node-allow-lan-access=true",
    ]);
  });

  test("Enter opens the selected device in the Devices view", async () => {
    const h = await boot();
    await h.select("nas");
    await h.enter();
    expect(h.frame()).toContain("Devices · 7");
    expect(h.selectedLine()).toContain("nas");
    expect(h.frame()).toContain("Tailscale SSH");
  });

  test("a stopped Tailscale offers Turn on, and Enter runs tailscale up", async () => {
    const h = await boot({ fixture: { backendState: "Stopped" } });
    expect(h.frame()).toContain("Status     ○ off");
    expect(h.frame()).toContain("Turn on");
    await h.enter();
    await h.waitFor("◉ connected");
    expect(h.backend.calls).toEqual(["sudo up"]);
  });

  test("o asks twice before turning Tailscale off", async () => {
    const h = await boot();
    await h.press("o");
    expect(h.frame()).toContain("Turn Tailscale off?");
    expect(h.frame()).toContain("Confirm: turn off");
    expect(h.backend.calls).toEqual([]);
    await h.press("o");
    await h.waitFor("Status     ○ off");
    expect(h.backend.calls).toEqual(["sudo down"]);
  });

  test("logged out: Log in starts the flow and shows the login link", async () => {
    const h = await boot({ fixture: { backendState: "NeedsLogin" } });
    expect(h.frame()).toContain("logged out");
    await h.enter();
    await h.waitFor("Open login link");
    expect(h.frame()).toContain("https://login.tailscale.com/a/1a2b3c4d5e6f");
    expect(h.backend.calls).toEqual(["sudo login --timeout=5s"]);
  });

  test("health warnings and a pending update show on the device panel", async () => {
    const h = await boot({
      fixture: {
        health: ["Tailscale can't reach the configured DNS servers."],
        update: "1.104.0",
      },
    });
    const f = h.frame();
    expect(f).toContain("Health     Tailscale can't reach the");
    expect(f).toContain("1.104.0 available");
  });

  test("narrow terminals keep the exit node panel and the devices", async () => {
    const h = await boot({ width: 64, height: 20 });
    const f = h.frame();
    expect(f).not.toContain("This device");
    expect(f).not.toContain("Network");
    expect(f).toContain("Exit node");
    expect(f).toContain("Devices · 4 of 6 online");
  });
});

describe("devices", () => {
  test("lists this device first and every tailnet device, no Mullvad relays", async () => {
    const h = await boot({ view: "devices" });
    const f = h.frame();
    expect(h.selectedLine()).toContain("my-laptop");
    expect(h.selectedLine()).toContain("this device");
    for (const name of [
      "home-server",
      "nas",
      "office-gw",
      "phone",
      "pixel-8",
      "old-thinkpad",
    ])
      expect(f).toContain(name);
    expect(f).not.toContain("fi-hel-wg");
    // A personal tailnet: every device has the same owner, so no Owner column.
    expect(f).not.toMatch(/Latency Owner/);
  });

  test("Enter opens Tailscale SSH on a device that runs it, plain ssh elsewhere", async () => {
    const h = await boot({ view: "devices" });
    await h.select("nas");
    expect(h.frame()).toContain("Routes     192.168.1.0/24");
    await h.enter();
    expect(h.spawned).toEqual([["tailscale", "ssh", `${USER}@nas`]]);
    await h.select("office-gw");
    await h.enter();
    expect(h.spawned[1]).toEqual(["ssh", `${USER}@office-gw.tail0000.ts.net`]);
  });

  test("u asks for another SSH user", async () => {
    const h = await boot({ view: "devices" });
    await h.select("nas");
    await h.press("u");
    expect(h.frame()).toContain("SSH to nas");
    for (let i = 0; i < 12; i++) h.setup.mockInput.pressBackspace();
    await h.type("admin");
    await h.enter();
    expect(h.spawned).toEqual([["tailscale", "ssh", "admin@nas"]]);
    expect(h.frame()).toContain("Tailscale SSH as admin");
  });

  test("phones are pinged, not SSHed into", async () => {
    const h = await boot({ view: "devices" });
    await h.select("phone");
    expect(h.frame()).not.toContain("Tailscale SSH");
    await h.enter();
    await h.waitFor(/phone.*timeout/);
    expect(h.spawned).toEqual([]);
  });

  test("t sends a file with Taildrop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsexit-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello");
    const h = await boot({ view: "devices" });
    await h.select("nas");
    await h.press("t");
    expect(h.frame()).toContain("Send a file to nas");
    for (let i = 0; i < 4; i++) h.setup.mockInput.pressBackspace();
    await h.type(file);
    await h.enter();
    await h.waitFor("Sent notes.txt to nas");
    expect(h.backend.calls).toEqual([`file cp ${file} 100.64.0.25:`]);
  });

  test("a missing file keeps the prompt open with an error", async () => {
    const h = await boot({ view: "devices" });
    await h.select("nas");
    await h.press("t");
    await h.type("/no/such/file");
    await h.enter();
    expect(h.frame()).toContain("No such file");
    expect(h.backend.calls).toEqual([]);
    await h.escape();
    expect(h.frame()).not.toContain("Send a file to nas");
  });

  test("filters, sort and e to use a tailnet exit node", async () => {
    const h = await boot({ view: "devices" });
    await h.press("f");
    expect(h.frame()).toContain("Devices · 5 of 7");
    expect(h.frame()).not.toContain("pixel-8");
    await h.press("f", { shift: true });
    expect(h.frame()).toContain("Devices · 7");
    await h.press("s");
    expect(h.frame()).toContain("Device ▴");
    await h.select("home-server");
    await h.press("e");
    await h.waitFor(/home-server.*exit node/);
    expect(h.backend.calls).toEqual(["set --exit-node=100.64.0.20"]);
  });

  test("p pings the selection and shows how", async () => {
    const h = await boot({ view: "devices" });
    await h.select("nas");
    await h.press("p");
    await h.waitFor(/nas.*3\.0 ms/);
    expect(h.frame()).toContain("via 192.168.1.10:41641");
  });
});

describe("network", () => {
  test("lists connectivity, DNS, health and the relays", async () => {
    const h = await boot({ view: "network" });
    await h.waitFor("RELAYS (DERP)");
    const f = h.frame();
    expect(f).toMatch(/✓ UDP\s+works/);
    expect(f).toMatch(/✓ Port mapping\s+UPnP/);
    expect(f).toMatch(/○ IPv6\s+none/);
    expect(f).toMatch(/✓ MagicDNS\s+on · tail0000\.ts\.net/);
    expect(f).toMatch(/Split DNS\s+1 domain/);
    expect(f).toMatch(/● hel\s+Helsinki\s+17 ms/);
    expect(f).toContain("home");
  });

  test("the details panel explains the selected finding", async () => {
    const h = await boot({ view: "network" });
    await h.waitFor("RELAYS (DERP)");
    await h.select("NAT");
    expect(h.frame()).toContain("easy NAT");
    await h.select("Split DNS");
    expect(h.frame()).toContain("corp.example.com → 10.0.0.53");
    await h.select("sfo");
    expect(h.frame()).toContain("DERP relay region");
    expect(h.frame()).toContain("5 of 5");
  });

  test("b creates a bug report and copies its ID", async () => {
    const h = await boot({ view: "network" });
    await h.press("b");
    await h.waitFor("BUG-1b7641a1");
    expect(h.backend.calls).toEqual(["bugreport"]);
    expect(h.frame()).toContain("Copy bug ID");
  });
});

describe("settings", () => {
  test("reads every preference with one tailscale get --json", async () => {
    const h = await boot({ view: "settings" });
    await h.waitFor("you@work.example (work)");
    expect(h.backend.reads.filter((r) => r.startsWith("get"))).toEqual([
      "get --json",
    ]);
    expect(h.frame()).toMatch(/Accept routes\s+○ off/);
    expect(h.frame()).toMatch(/Accept DNS\s+● on/);
  });

  test("Enter toggles a switch with tailscale set", async () => {
    const h = await boot({ view: "settings" });
    await h.select("Accept routes");
    await h.enter();
    await h.waitFor(/Accept routes\s+● on/);
    expect(h.backend.calls).toEqual(["sudo set --accept-routes=true"]);
  });

  test("risky switches ask twice; turning SSH off accepts the lose-ssh risk", async () => {
    const h = await boot({ view: "settings" });
    await h.select("Shields up");
    await h.enter();
    expect(h.frame()).toContain("Press again to confirm");
    expect(h.backend.calls).toEqual([]);
    await h.enter();
    await h.waitFor(/Shields up\s+● on/);
    h.backend.prefs.ssh = true;
    await h.press("r");
    await h.select("Tailscale SSH server");
    await h.waitFor(/Tailscale SSH server\s+● on/);
    await h.press(" ");
    await h.press(" ");
    await h.waitFor(/Tailscale SSH server\s+○ off/);
    expect(h.backend.calls).toEqual([
      "sudo set --shields-up=true",
      "sudo set --ssh=false --accept-risk=lose-ssh",
    ]);
  });

  test("text settings open a prompt that validates", async () => {
    const h = await boot({ view: "settings" });
    await h.select("Hostname");
    await h.enter();
    expect(h.frame()).toContain("Leave it empty to use");
    await h.type("bad_name!");
    await h.enter();
    expect(h.frame()).toContain("Letters, digits and hyphens");
    for (let i = 0; i < 9; i++) h.setup.mockInput.pressBackspace();
    await h.type("studio");
    await h.enter();
    await h.waitFor(/Hostname\s+studio/);
    expect(h.backend.calls).toEqual(["sudo set --hostname=studio"]);
  });

  test("accounts: Enter switches, x removes after a second press", async () => {
    const h = await boot({ view: "settings" });
    await h.waitFor("you@work.example (work)");
    await h.select("you@work.example");
    await h.enter();
    await h.waitFor(/◉ you@work\.example/);
    await h.select("you@example.com");
    await h.press("x");
    expect(h.frame()).toContain("Press again to confirm");
    await h.press("x");
    await h.waitFor((f) => !/[◉●] you@example\.com/.test(f));
    expect(h.frame()).toContain("Removed you@example.com from this device");
    expect(h.backend.calls).toEqual([
      "sudo switch c3d4",
      "sudo switch remove a1b2",
    ]);
  });

  test("offers to make this user the operator, through sudo in the terminal", async () => {
    const h = await boot({ view: "settings", fixture: {} });
    h.backend.prefs.operator = "";
    await h.press("r");
    if (!process.env.USER || process.platform !== "linux") return;
    await h.waitFor("Make me the operator");
    await h.select("Make me the operator");
    await h.enter();
    expect(h.spawned).toEqual([
      ["sudo", "tailscale", "set", `--operator=${USER}`],
    ]);
  });

  test("access denied errors carry the operator hint", async () => {
    const h = await boot({ view: "settings", fixture: { denied: true } });
    await h.select("Accept routes");
    await h.enter();
    await h.waitFor("sudo tailscale set --operator=$USER");
    expect(h.frame()).toMatch(/Accept routes\s+○ off/);
  });

  test("Version offers the update Tailscale reports, after a second press", async () => {
    const h = await boot({ view: "settings", fixture: { update: "1.104.0" } });
    await h.select("Version");
    expect(h.frame()).toContain("1.104.0 available");
    await h.enter();
    await h.enter();
    await h.waitFor("Tailscale updated to 1.104.0");
    expect(h.backend.calls).toEqual(["sudo update --yes"]);
  });
});

describe("sharing", () => {
  test("shows nothing served, Taildrive off and the Taildrop inbox", async () => {
    const h = await boot({ view: "sharing" });
    const f = h.frame();
    expect(f).toContain("Sharing · nothing shared");
    expect(f).toContain("Nothing is served");
    expect(f).toContain("needs the drive:share attribute");
    expect(f).toContain("Receive files");
  });

  test("shares a port on the tailnet, makes it public, then stops it", async () => {
    const h = await boot({ view: "sharing" });
    await h.select("Share on the tailnet");
    await h.enter();
    expect(h.frame()).toContain("Local port, URL or folder");
    await h.type("nonsense");
    await h.enter();
    expect(h.frame()).toContain("Enter a port (3000)");
    for (let i = 0; i < 8; i++) h.setup.mockInput.pressBackspace();
    await h.type("3000");
    await h.enter();
    await h.waitFor(
      /my-laptop\.tail0000\.ts\.net\/\s+→ http:\/\/127\.0\.0\.1:3000\s+tailnet/,
    );
    await h.select("my-laptop.tail0000.ts.net");
    await h.press("f");
    expect(h.frame()).toContain("reachable from the internet?");
    await h.press("f");
    await h.waitFor(/3000\s+public/);
    expect(h.frame()).toContain("Sharing · 1 shared · 1 public");
    await h.press("x");
    await h.press("x");
    await h.waitFor("Nothing is served");
    expect(h.backend.calls).toEqual([
      "sudo serve --bg 3000",
      "sudo funnel --bg --https=443 http://127.0.0.1:3000",
      "sudo serve --https=443 off",
    ]);
  });

  test("Receive moves waiting files into the folder", async () => {
    const h = await boot({
      view: "sharing",
      fixture: { inbox: [{ name: "report.pdf", bytes: 2048 }] },
    });
    await h.select("Receive files");
    await h.enter();
    await h.waitFor(/✓ report\.pdf\s+2\.0 KB/);
    expect(h.backend.calls[0]).toMatch(
      /^sudo file get --verbose --conflict=rename \//,
    );
    await h.enter();
    await h.waitFor("No files are waiting");
  });

  test("Taildrive: share a folder, rename it, stop sharing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "Photos-"));
    const h = await boot({ view: "sharing", fixture: { drive: true } });
    await h.select("Share a folder");
    await h.enter();
    for (let i = 0; i < 2; i++) h.setup.mockInput.pressBackspace();
    await h.type(dir);
    await h.enter();
    const name = dir
      .split("/")
      .pop()!
      .toLowerCase()
      .replace(/[^a-z_() ]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_ ]+|[_ ]+$/g, "");
    await h.waitFor(`● ${name}`);
    await h.select(name);
    await h.press("e");
    for (let i = 0; i < 30; i++) h.setup.mockInput.pressBackspace();
    await h.type("photos");
    await h.enter();
    await h.waitFor("● photos");
    await h.select("photos");
    await h.press("x");
    await h.press("x");
    await h.waitFor((f) => !f.includes("● photos"));
    expect(h.backend.calls).toEqual([
      `sudo drive share ${name} ${dir}`,
      `sudo drive rename ${name} photos`,
      "sudo drive unshare photos",
    ]);
  });
});
