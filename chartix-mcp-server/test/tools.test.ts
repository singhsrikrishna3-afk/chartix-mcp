/**
 * The tool layer: what a model gets handed, including when Chartix is unhappy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// §11: the client refuses hosts that are not allowlisted. These tests
// talk to a fake one, so they opt it in deliberately — which is also the
// only supported way to point the bridge at a local dev API.
process.env.CHARTIX_EXTRA_HOSTS = "api.example.test";
import { ChartixClient, type Fetcher } from "../dist/chartix/client.js";
import { TOOLS, runTool, type ToolContext } from "../dist/tools/index.js";
import { chartUrl, HISTORY_FLOORS } from "../dist/chartix/catalog.js";
import { FileSource } from "../dist/chartix/fileSource.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function ctxWith(replies: Array<{ status: number; body?: unknown }>): ToolContext {
  let i = 0;
  const fetcher: Fetcher = async () => {
    const r = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    return {
      status: r.status,
      headers: { get: () => null },
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  const clock = { now: () => 1_700_000_000_000, sleep: async () => {} };
  return {
    client: new ChartixClient({
      baseUrl: "https://api.example.test",
      token: () => "tok",
      fetcher,
      clock,
      maxAttempts: 1,
    }),
    siteUrl: "https://chartixai.com",
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `no tool named ${name}`);
  return t;
}

test("every tool has a name, a description and a schema", () => {
  assert.ok(TOOLS.length >= 8);
  for (const t of TOOLS) {
    assert.match(t.name, /^chartix_[a-z_]+$/);
    assert.ok(t.description.length > 80, `${t.name} description is too thin`);
    assert.ok(t.schema);
  }
});

test("tool names are unique", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("bars come back structured, with as_of and an integrity check", async () => {
  const ctx = ctxWith([
    {
      status: 200,
      body: [
        { time: "2026-10-13", open: 100, high: 105, low: 99, close: 104, volume: 10 },
        { time: "2026-10-14", open: 104, high: 106, low: 103, close: 105, volume: 11 },
      ],
    },
  ]);
  const out = (await runTool(tool("chartix_get_bars"), { symbol: "reliance" }, ctx)) as Record<
    string,
    unknown
  >;
  assert.equal(out.ok, true);
  assert.equal(out.symbol, "RELIANCE");
  assert.equal(out.as_of, "2026-10-14");
  assert.equal(out.count, 2);
  assert.deepEqual(out.integrity, { chronological: true, impossible: 0 });
});

test("an empty bar series is NOT_FOUND and names the history floor", async () => {
  // Returning {bars: []} would read as "this stock did not trade".
  const ctx = ctxWith([{ status: 200, body: [] }]);
  const out = (await runTool(
    tool("chartix_get_bars"),
    { symbol: "RELIANCE", start: "1993-01-01" },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(out.ok, false);
  assert.equal(out.error, "CHARTIX_NOT_FOUND");
  assert.match(String(out.message), new RegExp(HISTORY_FLOORS.equityBreadth));
});

test("the bars tool defaults to daily, so intraday is always an explicit ask", () => {
  const parsed = tool("chartix_get_bars").schema.parse({ symbol: "TCS" }) as {
    interval: string;
  };
  assert.equal(parsed.interval, "daily");
});

test("a tier paywall reaches the model as a paywall", async () => {
  const ctx = ctxWith([{ status: 403, body: { detail: "eod_pro required" } }]);
  const out = (await runTool(tool("chartix_get_patterns"), {}, ctx)) as Record<string, unknown>;
  assert.equal(out.ok, false);
  assert.equal(out.error, "CHARTIX_TIER_REQUIRED");
  assert.equal(out.required_tier, "eod_pro");
});

test("Chartix being down returns a typed error, not a throw", async () => {
  const ctx = ctxWith([{ status: 503 }]);
  const out = (await runTool(tool("chartix_get_bars"), { symbol: "TCS" }, ctx)) as Record<
    string,
    unknown
  >;
  assert.equal(out.ok, false);
  assert.equal(out.error, "CHARTIX_UNAVAILABLE");
});

test("bad arguments are a typed BAD_REQUEST naming the field", async () => {
  const ctx = ctxWith([{ status: 200, body: [] }]);
  const out = (await runTool(tool("chartix_get_bars"), { symbol: "" }, ctx)) as Record<
    string,
    unknown
  >;
  assert.equal(out.error, "CHARTIX_BAD_REQUEST");
  assert.match(String(out.message), /symbol/);
});

test("the market-wide list says plainly that it has no win rate", async () => {
  // Verified against production: a row from /api/screener/patterns carries
  // confidence, not win_rate. The first version of this tool advertised
  // "win rate, sample size and fit tier" and returned undefined for all three
  // — which an agent would paper over by quoting `confidence` as a win rate.
  const ctx = ctxWith([
    { status: 200, body: [{ symbol: "TCS", pattern_type: "double_bottom", confidence: 0.49 }] },
  ]);
  const out = (await runTool(tool("chartix_get_patterns"), {}, ctx)) as Record<string, unknown>;
  assert.equal(out.win_rate_available, false);
  assert.match(String(out.attribution), /NOT a win rate/);
  assert.match(String(out.attribution), /with `symbol` set/);
});

test("the per-symbol form reports the win rate verbatim and attributes it", async () => {
  const ctx = ctxWith([
    {
      status: 200,
      body: { symbol: "TCS", count: 1, patterns: [{ pattern_type: "double_bottom", win_rate: 0.4889 }] },
    },
  ]);
  const out = (await runTool(
    tool("chartix_get_patterns"),
    { symbol: "TCS" },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(out.win_rate_available, true);
  assert.match(String(out.attribution), /Chartix's own/);
  const data = out.data as { patterns: Array<Record<string, unknown>> };
  // Verbatim: not rounded, not restated, not recomputed.
  assert.equal(data.patterns[0]!.win_rate, 0.4889);
});

test("a null win rate is carried through rather than filled in", async () => {
  // The join needs >= 20 samples; below that Chartix returns null instead of
  // an optimistic figure, and so must we.
  const ctx = ctxWith([
    { status: 200, body: { symbol: "TCS", count: 1, patterns: [{ pattern_type: "pennant", win_rate: null }] } },
  ]);
  const out = (await runTool(tool("chartix_get_patterns"), { symbol: "TCS" }, ctx)) as Record<string, unknown>;
  const data = out.data as { patterns: Array<Record<string, unknown>> };
  assert.equal(data.patterns[0]!.win_rate, null);
  assert.match(String(out.attribution), /never fill in a null/);
});

test("no tool PROMISES a sample size, because no route exposes one", () => {
  // The API has no sample_size field anywhere, so a description that offers
  // one instructs the agent to invent it.
  //
  // Checked as the promise rather than the phrase: the first version of this
  // forbade "sample size" outright and then failed on the tool's own sentence
  // saying Chartix exposes none — banning the denial along with the claim.
  const PROMISE = [/\bwith\b[^.]*\bsample size\b/i, /\breturns?\b[^.]*\bsample size\b/i];
  for (const t of TOOLS) {
    for (const re of PROMISE) {
      assert.doesNotMatch(t.description, re,
        `${t.name} offers a sample size the API cannot supply`);
    }
  }
});

test("and no tool RETURNS a sample_size key, whatever Chartix sends", async () => {
  // The behavioural half, which no amount of rewording can satisfy falsely.
  const ctx = ctxWith([
    { status: 200, body: [{ symbol: "TCS", pattern_type: "double_bottom", confidence: 0.49 }] },
  ]);
  const out = await runTool(tool("chartix_get_patterns"), {}, ctx);
  assert.equal(JSON.stringify(out).includes("sample_size"), false);
});

test("an empty pattern result points at why-empty instead of advising filters", async () => {
  const ctx = ctxWith([{ status: 200, body: [] }]);
  const out = (await runTool(tool("chartix_get_patterns"), {}, ctx)) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.equal(out.empty_is_meaningful, true);
  assert.match(String(out.next_step), /why_empty/);
});

test("a saved scan without an id is refused before a request is spent", async () => {
  const ctx = ctxWith([{ status: 200, body: {} }]);
  const out = (await runTool(
    tool("chartix_run_screen"),
    { scan_family: "saved" },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(out.error, "CHARTIX_BAD_REQUEST");
});

test("a scan echoes the parameters it used, so the result is reproducible", async () => {
  const ctx = ctxWith([{ status: 200, body: { matches: [{ symbol: "TCS" }] } }]);
  const out = (await runTool(
    tool("chartix_run_screen"),
    { scan_family: "other", scan_type: "breakout", params: { min_volume: 100000 } },
    ctx,
  )) as Record<string, unknown>;
  assert.deepEqual(out.params_used, {
    scan_type: "breakout",
    limit: 100,
    min_volume: 100000,
  });
  assert.equal(out.count, 1);
});

test("scan params can override the defaults, as the real page allows", async () => {
  // week52 passes scan_type inside params; a dict() that collided here broke
  // an earlier probe of this very API.
  const ctx = ctxWith([{ status: 200, body: { matches: [] } }]);
  const out = (await runTool(
    tool("chartix_run_screen"),
    { scan_family: "other", scan_type: "week52", params: { scan_type: "near_high" } },
    ctx,
  )) as Record<string, unknown>;
  assert.equal((out.params_used as Record<string, unknown>).scan_type, "near_high");
});

test("the chart link is a real deep link and costs no request", async () => {
  const ctx = ctxWith([{ status: 500 }]); // would fail if it called the API
  const out = (await runTool(
    tool("chartix_get_chart_url"),
    { symbol: "m&m", timeframe: "W" },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(out.ok, true);
  const url = new URL(String(out.url));
  assert.equal(url.pathname, "/dashboard/charts");
  assert.equal(url.searchParams.get("symbol"), "M&M");
  assert.equal(url.searchParams.get("tf"), "W");
});

test("the chart url encodes an ampersand symbol without breaking the query", () => {
  const u = new URL(chartUrl("M&M"));
  assert.equal(u.searchParams.get("symbol"), "M&M");
  assert.match(u.search, /%26/);
});

test("watchlist writes report what failed instead of skipping it", async () => {
  const ctx = ctxWith([{ status: 200, body: [{ symbol: "RELIANCE" }] }]);
  const out = (await runTool(
    tool("chartix_add_to_watchlist"),
    { symbols: ["RELIANCE", "NOTAREALSYMBOL"] },
    ctx,
  )) as Record<string, unknown>;
  assert.deepEqual(out.added, ["RELIANCE"]);
  const failed = out.failed as Array<Record<string, unknown>>;
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.symbol, "NOTAREALSYMBOL");
});

test("an unexpected throw inside a handler still returns an envelope", async () => {
  const broken = {
    name: "chartix_broken",
    description: "x".repeat(100),
    schema: tool("chartix_get_chart_url").schema,
    handler: async () => {
      throw new TypeError("kaboom");
    },
  };
  const out = (await runTool(broken, { symbol: "TCS" }, ctxWith([]))) as Record<string, unknown>;
  assert.equal(out.ok, false);
  assert.equal(out.error, "CHARTIX_UNAVAILABLE");
  assert.match(String(out.message), /TypeError/);
});

test("no tool description leaks a credential or a host secret", () => {
  for (const t of TOOLS) {
    assert.doesNotMatch(t.description, /Bearer\s+\S+|CHARTIX_TOKEN=/);
  }
});

// --- §10: file mode must answer from the file, never from the network -----
//
// These guard a bug that shipped: FileSource.patterns() existed, was never
// called, and a CSV-backed install got CHARTIX_AUTH_FAILED from the one tool
// whose data it was holding. The fetcher below THROWS, so any test here that
// touches the network fails loudly rather than quietly degrading.

function fileCtx(body: string): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "cxtools-"));
  const p = join(dir, "export.csv");
  writeFileSync(p, body);
  const src = new FileSource(p);
  src.load();
  const fetcher: Fetcher = () => {
    throw new Error("file mode reached for the network");
  };
  return {
    client: new ChartixClient({
      baseUrl: "https://api.example.test",
      token: () => undefined,
      fetcher,
      clock: { now: () => 1_700_000_000_000, sleep: async () => {} },
      maxAttempts: 1,
    }),
    siteUrl: "https://chartixai.com",
    file: src,
  };
}

const CSV_HEAD = "symbol,pattern,win_rate,sample_size,date_range,chart_url,as_of";
const TWO_ROWS =
  `${CSV_HEAD}\n` +
  "TATAMOTORS,triple_top,0.79,41,r,https://chartixai.com/c,2026-10-17\n" +
  "RELIANCE,head_shoulders,0.351,1275,r,https://chartixai.com/c,2026-10-17\n";

test("file mode answers chartix_get_patterns without a credential or a network call", async () => {
  const out = (await runTool(
    tool("chartix_get_patterns"),
    { symbol: "tatamotors" },
    fileCtx(TWO_ROWS),
  )) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.source, "file");
  assert.equal(out.symbol, "TATAMOTORS");
  assert.equal(out.count, 1);
  assert.equal((out.patterns as Array<{ win_rate: number }>)[0]!.win_rate, 0.79);
});

test("file mode without a symbol returns the whole export, not one stock", async () => {
  const out = (await runTool(
    tool("chartix_get_patterns"),
    {},
    fileCtx(TWO_ROWS),
  )) as Record<string, unknown>;
  assert.equal(out.count, 2);
  // No symbol asked for, so none is claimed in the reply.
  assert.ok(!("symbol" in out));
});

test("file mode states its as_of, so a stale export cannot pass as live", async () => {
  const out = (await runTool(
    tool("chartix_get_patterns"),
    {},
    fileCtx(TWO_ROWS),
  )) as Record<string, unknown>;
  assert.equal(out.as_of, "2026-10-17");
  assert.equal(out.win_rate_available, true);
});

test("file mode says there is nothing to query rather than suggesting why-empty", async () => {
  const out = (await runTool(
    tool("chartix_get_patterns"),
    { symbol: "INFY" },
    fileCtx(TWO_ROWS),
  )) as Record<string, unknown>;
  assert.equal(out.count, 0);
  assert.equal(out.empty_is_meaningful, true);
  // why-empty is a network route; pointing a credential-less install at it
  // would hand back an auth error dressed up as an explanation.
  assert.doesNotMatch(String(out.next_step), /chartix_patterns_why_empty/);
  assert.match(String(out.next_step), /export does not cover it/);
});

test("file mode honours limit", async () => {
  const out = (await runTool(
    tool("chartix_get_patterns"),
    { limit: 1 },
    fileCtx(TWO_ROWS),
  )) as Record<string, unknown>;
  assert.equal(out.count, 1);
});
