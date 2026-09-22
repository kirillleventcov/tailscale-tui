import { describe, expect, test } from "bun:test";
import {
  fit,
  fmtLatency,
  humanBytes,
  parseTime,
  relTime,
  truncate,
} from "../src/format";
import {
  applyQuery,
  findNodeByName,
  matchesTokens,
  tokenize,
  type ExitNode,
  type Query,
} from "../src/model";

function node(over: Partial<ExitNode> & { id: string }): ExitNode {
  return {
    key: `nodekey:${over.id}`,
    name: over.id,
    hostName: over.id,
    dnsName: `${over.id}.tailnet.ts.net`,
    ip: "100.64.0.1",
    ips: ["100.64.0.1"],
    os: "linux",
    online: true,
    active: false,
    exitNodeOption: true,
    expired: false,
    isMullvad: false,
    tags: [],
    rxBytes: 0,
    txBytes: 0,
    inSession: false,
    ssh: false,
    taildrop: false,
    shared: false,
    routes: [],
    ...over,
  };
}

const nodes: ExitNode[] = [
  node({ id: "hel", city: "Helsinki", country: "Finland", countryCode: "FI" }),
  node({
    id: "fra",
    city: "Frankfurt",
    country: "Germany",
    countryCode: "DE",
    isMullvad: true,
    tags: ["tag:mullvad-exit-node"],
    priority: 100,
  }),
  node({
    id: "ber",
    city: "Berlin",
    country: "Germany",
    countryCode: "DE",
    isMullvad: true,
    online: false,
    priority: 90,
  }),
  node({
    id: "nyc",
    city: "New York",
    country: "United States",
    countryCode: "US",
    active: true,
    os: "windows",
  }),
];

const base: Query = { text: "", filter: "all", sort: "status", desc: false };
const noLatency = () => undefined;

describe("format", () => {
  test("truncate keeps display width", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(truncate("日本語テキスト", 5)).toBe("日本…");
  });
  test("fit pads and aligns", () => {
    expect(fit("ab", 5)).toBe("ab   ");
    expect(fit("ab", 5, "right")).toBe("   ab");
    expect(fit("abcdefgh", 5)).toBe("abcd…");
  });
  test("humanBytes", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
  test("relTime", () => {
    const now = Date.now();
    expect(relTime(new Date(now - 1000), now)).toBe("just now");
    expect(relTime(new Date(now - 90_000), now)).toBe("1m ago");
    expect(relTime(undefined)).toBe("never");
  });
  test("fmtLatency", () => {
    expect(fmtLatency(undefined)).toBe("—");
    expect(fmtLatency(null)).toBe("timeout");
    expect(fmtLatency("pending")).toBe("…");
    expect(fmtLatency(4.26)).toBe("4.3 ms");
    expect(fmtLatency(123.4)).toBe("123 ms");
  });
  test("parseTime treats Go zero time as unset", () => {
    expect(parseTime("0001-01-01T00:00:00Z")).toBeUndefined();
    expect(parseTime("2026-01-02T03:04:05Z")?.toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect(parseTime(42)).toBeUndefined();
  });
});

describe("query", () => {
  test("status sort puts the active node first, tailnet before Mullvad, offline last", () => {
    const out = applyQuery(nodes, base, noLatency).map((n) => n.id);
    expect(out).toEqual(["nyc", "hel", "fra", "ber"]);
  });
  test("filters", () => {
    expect(
      applyQuery(nodes, { ...base, filter: "mullvad" }, noLatency)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["ber", "fra"]);
    expect(
      applyQuery(nodes, { ...base, filter: "tailnet" }, noLatency)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["hel", "nyc"]);
    expect(
      applyQuery(nodes, { ...base, filter: "online" }, noLatency).map(
        (n) => n.id,
      ),
    ).not.toContain("ber");
  });
  test("search matches name, city, country code, os; ! excludes", () => {
    expect(
      applyQuery(nodes, { ...base, text: "german" }, noLatency)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["ber", "fra"]);
    expect(
      applyQuery(nodes, { ...base, text: "de !berlin" }, noLatency).map(
        (n) => n.id,
      ),
    ).toEqual(["fra"]);
    expect(
      applyQuery(nodes, { ...base, text: "windows" }, noLatency).map(
        (n) => n.id,
      ),
    ).toEqual(["nyc"]);
    expect(matchesTokens(nodes[0]!, tokenize("  FI   hel "))).toBe(true);
  });
  test("location sort groups by country then city, desc reverses", () => {
    const asc = applyQuery(nodes, { ...base, sort: "location" }, noLatency).map(
      (n) => n.id,
    );
    expect(asc).toEqual(["ber", "fra", "hel", "nyc"]);
    const desc = applyQuery(
      nodes,
      { ...base, sort: "location", desc: true },
      noLatency,
    ).map((n) => n.id);
    expect(desc).toEqual(["nyc", "hel", "fra", "ber"]);
  });
  test("latency sort: measured first ascending, then pending, unmeasured, timeouts", () => {
    const lat = (id: string) =>
      ({ hel: 8, fra: 30, ber: null, nyc: "pending" as const })[id];
    const out = applyQuery(nodes, { ...base, sort: "latency" }, lat).map(
      (n) => n.id,
    );
    expect(out).toEqual(["hel", "fra", "nyc", "ber"]);
  });
  test("priority sort is descending by priority", () => {
    const out = applyQuery(
      nodes,
      { ...base, sort: "priority", filter: "mullvad" },
      noLatency,
    ).map((n) => n.id);
    expect(out).toEqual(["fra", "ber"]);
  });
  test("findNodeByName resolves suggestions with or without trailing dot", () => {
    expect(findNodeByName(nodes, "fra.tailnet.ts.net.")?.id).toBe("fra");
    expect(findNodeByName(nodes, "HEL")?.id).toBe("hel");
    expect(findNodeByName(nodes, null)).toBeUndefined();
  });
});
