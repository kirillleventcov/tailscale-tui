import { parseJson } from "./cli";
import type { Backend } from "./types";

/** `tailscale get --json`: every preference `tailscale set` accepts, keyed by flag name. */
export type Prefs = Record<string, string | boolean>;

export function parsePrefs(raw: unknown): Prefs {
  const out: Prefs = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "boolean" || typeof v === "string") out[k] = v;
    else if (typeof v === "number") out[k] = String(v);
  }
  return out;
}

const NETFILTER = ["off", "nodivert", "on"];
const EXIT_ROUTES = new Set(["0.0.0.0/0", "::/0"]);

/**
 * The same preferences from `tailscale debug prefs`, for Tailscale before 1.100, which has no
 * `tailscale get`. Flags the document does not carry stay absent, and Settings hides them.
 */
export function prefsFromDebug(raw: unknown): Prefs {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: Prefs = {};
  const bool = (flag: string, key: string, invert = false) => {
    if (typeof d[key] === "boolean")
      out[flag] = invert ? !d[key] : (d[key] as boolean);
  };
  bool("accept-routes", "RouteAll");
  bool("accept-dns", "CorpDNS");
  bool("ssh", "RunSSH");
  bool("webclient", "RunWebClient");
  bool("shields-up", "ShieldsUp");
  bool("snat-subnet-routes", "NoSNAT", true);
  bool("stateful-filtering", "NoStatefulFiltering", true);
  bool("report-posture", "PostureChecking");
  bool("exit-node-allow-lan-access", "ExitNodeAllowLANAccess");
  if (typeof d.Hostname === "string") out.hostname = d.Hostname;
  if (typeof d.OperatorUser === "string") out.operator = d.OperatorUser;
  else if ("WantRunning" in d) out.operator = "";
  if (Array.isArray(d.AdvertiseRoutes) || d.AdvertiseRoutes === null) {
    const routes = ((d.AdvertiseRoutes as unknown[] | null) ?? []).filter(
      (r): r is string => typeof r === "string",
    );
    out["advertise-exit-node"] = routes.some((r) => EXIT_ROUTES.has(r));
    out["advertise-routes"] = routes
      .filter((r) => !EXIT_ROUTES.has(r))
      .join(",");
  }
  if (typeof d.NetfilterMode === "number")
    out["netfilter-mode"] =
      NETFILTER[d.NetfilterMode] ?? String(d.NetfilterMode);
  const au = d.AutoUpdate as Record<string, unknown> | undefined;
  if (au && typeof au === "object") {
    if (typeof au.Check === "boolean") out["update-check"] = au.Check;
    out["auto-update"] = au.Apply === true;
  }
  const ac = d.AppConnector as Record<string, unknown> | undefined;
  if (ac && typeof ac.Advertise === "boolean")
    out["advertise-connector"] = ac.Advertise;
  return out;
}

export async function getPrefs(backend: Backend): Promise<Prefs> {
  const res = await backend.cli(["get", "--json"], { timeoutMs: 8000 });
  if (res.code === 0) return parsePrefs(parseJson(res, "tailscale get"));
  const dbg = await backend.cli(["debug", "prefs"], { timeoutMs: 8000 });
  return prefsFromDebug(parseJson(dbg, "tailscale debug prefs"));
}

/** An account profile from `tailscale switch --list --json`. */
export interface Profile {
  id: string;
  nickname: string;
  tailnet: string;
  account: string;
  selected: boolean;
}

export function parseProfiles(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
    )
    .map((p) => ({
      id: String(p.id ?? ""),
      nickname: String(p.nickname ?? ""),
      tailnet: String(p.tailnet ?? ""),
      account: String(p.account ?? ""),
      selected: p.selected === true,
    }))
    .filter((p) => p.id !== "");
}

export async function listProfiles(backend: Backend): Promise<Profile[]> {
  const res = await backend.cli(["switch", "--list", "--json"], {
    privileged: true,
    timeoutMs: 8000,
  });
  return parseProfiles(parseJson(res, "tailscale switch --list"));
}
