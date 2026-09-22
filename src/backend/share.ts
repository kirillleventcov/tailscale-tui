// Serve, Funnel, Taildrive and Taildrop: what this device shares, parsed from the CLI.
import { cliError, parseJson } from "./cli";
import type { Backend } from "./types";

// ---------------------------------------------------------------------------
// Serve and Funnel: `tailscale serve status --json` prints an ipn.ServeConfig
// ---------------------------------------------------------------------------

export interface ServeEntry {
  /** "443/" for a web handler, "tcp/5432" for a TCP forwarder. */
  id: string;
  proto: "https" | "http" | "tcp" | "tls-tcp";
  port: string;
  /** Mount path of a web handler, "" for TCP. */
  mount: string;
  kind: "proxy" | "path" | "text" | "tcp";
  /** Proxy URL, file system path, static text or TCP destination. */
  target: string;
  url: string;
  /** Reachable from the internet through Funnel. */
  funnel: boolean;
  /** Started by a `tailscale serve` still running in a terminal; it ends with that command. */
  foreground: boolean;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Obj)
    : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function splitHostPort(hp: string): { host: string; port: string } {
  const i = hp.lastIndexOf(":");
  return i < 0
    ? { host: hp, port: "443" }
    : { host: hp.slice(0, i), port: hp.slice(i + 1) };
}

function webUrl(
  proto: string,
  host: string,
  port: string,
  mount: string,
): string {
  const std =
    (proto === "https" && port === "443") ||
    (proto === "http" && port === "80");
  return `${proto}://${host}${std ? "" : `:${port}`}${mount}`;
}

function collect(
  sc: Obj,
  host: string,
  foreground: boolean,
  out: ServeEntry[],
): void {
  const tcp = obj(sc.TCP) ?? {};
  const web = obj(sc.Web) ?? {};
  const funnel = obj(sc.AllowFunnel) ?? {};
  for (const [hp, w] of Object.entries(web)) {
    const { host: h, port } = splitHostPort(hp);
    const proto = obj(tcp[port])?.HTTP === true ? "http" : "https";
    const handlers = obj(obj(w)?.Handlers) ?? {};
    for (const mount of Object.keys(handlers).sort()) {
      const hd = obj(handlers[mount]) ?? {};
      const proxy = str(hd.Proxy);
      const path = str(hd.Path);
      const text = str(hd.Text);
      out.push({
        id: `${port}${mount}`,
        proto,
        port,
        mount,
        kind: proxy ? "proxy" : path ? "path" : "text",
        target: proxy || path || text,
        url: webUrl(proto, h || host, port, mount),
        funnel: funnel[hp] === true,
        foreground,
      });
    }
  }
  for (const [port, t] of Object.entries(tcp)) {
    const fwd = str(obj(t)?.TCPForward);
    if (!fwd) continue;
    const tls = str(obj(t)?.TerminateTLS) !== "";
    out.push({
      id: `tcp/${port}`,
      proto: tls ? "tls-tcp" : "tcp",
      port,
      mount: "",
      kind: "tcp",
      target: fwd,
      url: `tcp://${host}:${port}`,
      funnel: funnel[`${host}:${port}`] === true,
      foreground,
    });
  }
}

/** Every served endpoint; `host` is this device's MagicDNS name, used for TCP URLs. */
export function parseServeStatus(raw: unknown, host: string): ServeEntry[] {
  const sc = obj(raw) ?? {};
  const out: ServeEntry[] = [];
  collect(sc, host, false, out);
  for (const fg of Object.values(obj(sc.Foreground) ?? {})) {
    const o = obj(fg);
    if (o) collect(o, host, true, out);
  }
  return out.sort(
    (a, b) => Number(a.port) - Number(b.port) || a.mount.localeCompare(b.mount),
  );
}

export async function serveStatus(
  backend: Backend,
  host: string,
): Promise<ServeEntry[]> {
  const res = await backend.cli(["serve", "status", "--json"], {
    timeoutMs: 8000,
  });
  // "No serve config" prints nothing or {} depending on the version.
  if (res.code === 0 && res.stdout.trim() === "") return [];
  return parseServeStatus(parseJson(res, "tailscale serve status"), host);
}

/** Arguments that address an entry's port and path, for `serve ... off` and re-serving. */
export function serveAddress(e: ServeEntry): string[] {
  if (e.kind === "tcp")
    return [
      e.proto === "tls-tcp"
        ? `--tls-terminated-tcp=${e.port}`
        : `--tcp=${e.port}`,
    ];
  const args = [`--${e.proto}=${e.port}`];
  if (e.mount && e.mount !== "/") args.push(`--set-path=${e.mount}`);
  return args;
}

/** The target argument that recreates an entry. */
export function serveTarget(e: ServeEntry): string {
  if (e.kind === "text") return `text:${e.target}`;
  if (e.kind === "tcp") return `tcp://${e.target}`;
  return e.target;
}

/** A port, host:port, URL or absolute path as typed into the share prompt; null when unusable. */
export function normalizeServeTarget(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^\d{1,5}$/.test(v)) return v;
  if (/^(https?|https\+insecure|tcp|tls-terminated-tcp|unix):/.test(v))
    return v;
  if (/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(\/.*)?$/.test(v)) return v;
  if (v.startsWith("/") || v.startsWith("~")) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Taildrive: `tailscale drive list` prints a name/path/as table
// ---------------------------------------------------------------------------

export interface DriveShare {
  name: string;
  path: string;
  as: string;
}

export function parseDriveList(text: string): DriveShare[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const out: DriveShare[] = [];
  for (const line of lines) {
    if (/^name\s+path\b/.test(line) || /^-+\s+-+/.test(line)) continue;
    const cols = line.split(/\s{4,}/);
    if (cols.length < 2) continue;
    out.push({
      name: cols[0]!.trim(),
      path: cols[1]!.trim(),
      as: (cols[2] ?? "").trim(),
    });
  }
  return out;
}

export async function driveList(backend: Backend): Promise<DriveShare[]> {
  const res = await backend.cli(["drive", "list"], { timeoutMs: 8000 });
  if (res.code !== 0) throw cliError(res, "Taildrive");
  return parseDriveList(res.stdout);
}

/** Share names are lowercase letters, underscores, parentheses and spaces. */
export function driveShareName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z_() ]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ ]+|[_ ]+$/g, "");
}

// ---------------------------------------------------------------------------
// Taildrop: `tailscale file get --verbose` reports each file it moves
// ---------------------------------------------------------------------------

export interface ReceivedFile {
  name: string;
  path: string;
  bytes: number;
  at: number;
}

/** "wrote report.pdf as /home/k/Downloads/report.pdf (12345 bytes)" */
export function parseFileGet(output: string, at = Date.now()): ReceivedFile[] {
  const out: ReceivedFile[] = [];
  for (const m of output.matchAll(/^wrote (.+) as (.+) \((\d+) bytes\)$/gm))
    out.push({ name: m[1]!, path: m[2]!, bytes: Number(m[3]), at });
  return out;
}
