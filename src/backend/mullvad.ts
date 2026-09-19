import { BackendError } from "./types";

/** Mullvad's public relay list; the hostnames match the Mullvad peers Tailscale lists (fi-hel-wg-203 and so on). */
export const MULLVAD_RELAYS_URL =
  "https://api.mullvad.net/www/relays/wireguard/";

const RETRY_AFTER_MS = 60_000;

/** hostname -> public IPv4 of the relay. */
export function parseRelayList(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(json)) return out;
  for (const r of json) {
    if (typeof r !== "object" || r === null) continue;
    const { hostname, ipv4_addr_in: ip } = r as Record<string, unknown>;
    if (
      typeof hostname === "string" &&
      hostname &&
      typeof ip === "string" &&
      ip
    )
      out.set(hostname.toLowerCase(), ip);
  }
  return out;
}

/**
 * Resolves Mullvad exit node host names to the public address of the relay.
 * Mullvad nodes do not answer Tailscale pings (disco, TSMP or ICMP through the tunnel),
 * but their relays answer ICMP on the public address, which gives a usable latency.
 * The list is fetched once per session, on first use.
 */
export class MullvadRelays {
  private cache: Map<string, string> | null = null;
  private inflight: Promise<Map<string, string>> | null = null;
  private lastError: { at: number; error: BackendError } | null = null;

  constructor(
    private readonly url = MULLVAD_RELAYS_URL,
    private readonly timeoutMs = 15_000,
  ) {}

  async lookup(hostname: string): Promise<string> {
    const map = await this.load();
    const ip = map.get(hostname.toLowerCase());
    if (!ip)
      throw new BackendError(`${hostname} is not in Mullvad's relay list`);
    return ip;
  }

  private load(): Promise<Map<string, string>> {
    if (this.cache) return Promise.resolve(this.cache);
    if (this.inflight) return this.inflight;
    if (this.lastError && Date.now() - this.lastError.at < RETRY_AFTER_MS)
      return Promise.reject(this.lastError.error);
    this.inflight = this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<Map<string, string>> {
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const map = parseRelayList(await res.json());
      if (map.size === 0) throw new Error("empty relay list");
      this.cache = map;
      this.lastError = null;
      return map;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const error = new BackendError(
        `Mullvad relay list unavailable: ${msg}`,
        "Latency for Mullvad nodes needs api.mullvad.net; it is retried on the next ping",
      );
      this.lastError = { at: Date.now(), error };
      throw error;
    }
  }
}
