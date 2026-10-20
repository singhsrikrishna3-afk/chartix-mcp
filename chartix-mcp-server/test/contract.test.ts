/**
 * §9 (the data contract), §10 (the file bridge) and §13 (observability).
 *
 * Two of §9's points could not be answered as specified, and saying so in the
 * payload is itself part of the contract:
 *
 *   adjustment  the spec offers "split" | "none". Chartix's close comes from
 *               Yahoo auto_adjust=True, so it is split AND dividend adjusted,
 *               with the raw exchange close carried separately as close_raw.
 *   ingested_at the spec wants "when ChartixAI says the data landed". Chartix
 *               says no such thing on any route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EOD_BASIS, INTRADAY_BASIS, checkInvariants, freshness,
  lastExpectedSession, missingSessions,
} from "../dist/chartix/contract.js";
import { FileSource, parseCsv } from "../dist/chartix/fileSource.js";
import {
  healthz, newHealth, readyz, recordFailure, recordSuccess, requestId,
} from "../dist/chartix/health.js";
import { ChartixError, ChartixErrorCode } from "../dist/chartix/errors.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- §9 price basis -------------------------------------------------------

test("the adjustment is stated as what it is, not forced into the spec's enum", () => {
  assert.equal(EOD_BASIS.adjustment, "split_and_dividend");
  assert.equal(EOD_BASIS.unadjusted_field, "close_raw");
  assert.match(EOD_BASIS.note, /close_raw/);
});

test("intraday adjustment is reported unknown rather than assumed", () => {
  assert.equal(INTRADAY_BASIS.adjustment, "unknown");
  assert.equal(INTRADAY_BASIS.unadjusted_field, null);
});

// --- §9 freshness ---------------------------------------------------------

const NO_HOLIDAYS = new Set<string>();

test("ingested_at is null with a reason, never our own fetch time", () => {
  const f = freshness("2026-10-15", "2026-10-16T09:00:00Z", new Date("2026-10-16T09:00:00Z"), NO_HOLIDAYS);
  assert.equal(f.ingested_at, null);
  assert.match(f.ingested_at_note, /no ingest timestamp/i);
  assert.notEqual(f.fetched_at, f.ingested_at);
});

test("during market hours yesterday's bar is NOT stale", () => {
  // The sync runs in the evening, so a query at noon legitimately sees
  // yesterday. Calling that stale would cry wolf every trading day.
  const now = new Date("2026-10-16T06:30:00Z"); // 12:00 IST, Friday
  const f = freshness("2026-10-15", now.toISOString(), now, NO_HOLIDAYS);
  assert.equal(f.stale, false);
});

test("a genuinely old bar is stale and says why", () => {
  const now = new Date("2026-10-16T16:00:00Z"); // 21:30 IST, after the sync
  const f = freshness("2026-10-09", now.toISOString(), now, NO_HOLIDAYS);
  assert.equal(f.stale, true);
  assert.match(f.stale_reason!, /2026-10-09/);
});

test("the expected session skips weekends", () => {
  // Sunday 21:30 IST -> the last session was Friday.
  const sunday = new Date("2026-10-18T16:00:00Z");
  assert.equal(lastExpectedSession(sunday, NO_HOLIDAYS), "2026-10-16");
});

test("the expected session skips an exchange holiday", () => {
  const holidays = new Set(["2026-10-16"]);
  const friday = new Date("2026-10-16T16:00:00Z");
  assert.equal(lastExpectedSession(friday, holidays), "2026-10-15");
});

// --- §9 gaps and invariants ----------------------------------------------

test("a weekday with no bar and no holiday is a missing session", () => {
  const have = ["2026-10-12", "2026-10-13", "2026-10-15"];
  assert.deepEqual(missingSessions(have, NO_HOLIDAYS), ["2026-10-14"]);
});

test("a holiday is not a missing session", () => {
  const have = ["2026-10-12", "2026-10-13", "2026-10-15"];
  assert.deepEqual(missingSessions(have, new Set(["2026-10-14"])), []);
});

test("gaps are strictly interior — the history floor is not a hole", () => {
  // Per-stock coverage starts in 1996; reporting everything before the first
  // bar would make every old request look broken.
  assert.deepEqual(missingSessions(["2026-10-15"], NO_HOLIDAYS), []);
  assert.deepEqual(missingSessions([], NO_HOLIDAYS), []);
});

test("OHLC invariants are reported, not thrown", () => {
  const rows = [
    { time: "2026-10-14", open: 100, high: 105, low: 99, close: 104, volume: 10 },
    { time: "2026-10-15", open: 104, high: 99, low: 103, close: 105, volume: 11 },
  ];
  const inv = checkInvariants(rows);
  assert.equal(inv.impossible_bars, 1);
  assert.equal(inv.chronological, true);
});

test("duplicate sessions are named, not merely counted", () => {
  const inv = checkInvariants([{ time: "2026-10-15" }, { time: "2026-10-15" }]);
  assert.deepEqual(inv.duplicate_sessions, ["2026-10-15"]);
});

test("a negative volume and a non-positive price are each counted", () => {
  const inv = checkInvariants([
    { time: "2026-10-15", open: 0, high: 1, low: 0, close: 1, volume: -5 },
  ]);
  assert.equal(inv.negative_volume, 1);
  assert.equal(inv.non_positive, 1);
});

// --- §10 the file bridge --------------------------------------------------

const HEADER = "symbol,pattern,win_rate,sample_size,date_range,chart_url,as_of";

function tmpCsv(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cxcsv-"));
  const p = join(dir, "export.csv");
  writeFileSync(p, body);
  return p;
}

test("a well-formed export parses", () => {
  const { rows, problems, as_of } = parseCsv(
    `${HEADER}\nRELIANCE,double_bottom,0.49,1200,2020..2026,https://chartixai.com/x,2026-10-15\n`,
  );
  assert.equal(rows.length, 1);
  assert.equal(as_of, "2026-10-15");
  assert.equal(problems.filter((p) => p.level === "error").length, 0);
});

test("the header must be exact", () => {
  const { problems } = parseCsv("symbol,pattern\nRELIANCE,x\n");
  assert.equal(problems[0]!.level, "error");
  assert.match(problems[0]!.message, /header must be exactly/);
});

test("a row with no as_of is rejected — a number with no date is not a claim", () => {
  const { rows, problems } = parseCsv(`${HEADER}\nRELIANCE,double_bottom,0.49,10,r,u,\n`);
  assert.equal(rows.length, 0);
  assert.match(problems[0]!.message, /as_of/);
});

test("a percentage mistaken for a rate is caught", () => {
  // 49 instead of 0.49 would otherwise become a 4,900% win rate.
  const { problems } = parseCsv(`${HEADER}\nRELIANCE,db,49,10,r,u,2026-10-15\n`);
  assert.match(problems[0]!.message, /outside 0\.\.1/);
});

test("a missing sample_size is a NOTE, because Chartix cannot supply one", () => {
  const { rows, problems } = parseCsv(`${HEADER}\nRELIANCE,db,0.49,,r,u,2026-10-15\n`);
  assert.equal(rows.length, 1, "the row is still usable");
  assert.equal(problems[0]!.level, "note");
  assert.match(problems[0]!.message, /no sample size/i);
});

test("an older re-import is refused rather than overwriting newer data", () => {
  const src = new FileSource(tmpCsv(`${HEADER}\nA,db,0.5,1,r,u,2026-10-15\n`));
  src.load();
  const older = new FileSource(tmpCsv(`${HEADER}\nA,db,0.5,1,r,u,2026-10-01\n`));
  assert.throws(
    () => older.load("2026-10-15"),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.StaleImport);
      return true;
    },
  );
});

test("a newer re-import is accepted", () => {
  const src = new FileSource(tmpCsv(`${HEADER}\nA,db,0.5,1,r,u,2026-10-20\n`));
  assert.doesNotThrow(() => src.load("2026-10-15"));
});

test("a malformed file fails at load, not on someone's first question", () => {
  const src = new FileSource(tmpCsv("nope\n"));
  assert.throws(() => src.load(), (e: unknown) => {
    assert.ok(e instanceof ChartixError);
    assert.equal(e.code, ChartixErrorCode.BadRequest);
    return true;
  });
});

test("the file source serves the same shape the network does", () => {
  const src = new FileSource(tmpCsv(
    `${HEADER}\nA,db,0.5,1,r,u,2026-10-15\nB,hs,0.3,2,r,u,2026-10-15\n`));
  src.load();
  assert.deepEqual(src.symbols(), ["A", "B"]);
  assert.equal(src.patterns("A").length, 1);
  assert.equal(src.status().as_of, "2026-10-15");
});

// --- §13 observability ----------------------------------------------------

test("a fresh server is 'not asked yet', not 'broken'", () => {
  const h = newHealth("0.2.0", "network");
  assert.equal(h.chartixReachable, null);
  assert.equal(healthz(h).status, "ok");
});

test("readiness fails until the symbol index loads", () => {
  const h = newHealth("0.2.0", "network");
  assert.equal(readyz(h).ready, false);
  h.symbolsIndexed = 3017;
  assert.equal(readyz(h).ready, true);
});

test("a paywall does not mark the dependency unreachable", () => {
  // Otherwise a free account browsing paid data turns the health check red.
  const h = newHealth("0.2.0", "network");
  recordFailure(h, "2026-10-16T00:00:00Z", "CHARTIX_TIER_REQUIRED");
  assert.equal(h.chartixReachable, true);
  assert.equal(healthz(h).status, "ok");
});

test("an unreachable Chartix does mark it degraded", () => {
  const h = newHealth("0.2.0", "network");
  recordFailure(h, "2026-10-16T00:00:00Z", "CHARTIX_UNAVAILABLE");
  assert.equal(healthz(h).status, "degraded");
  assert.equal(healthz(h).last_error_code, "CHARTIX_UNAVAILABLE");
});

test("a success after a failure clears the degraded state", () => {
  const h = newHealth("0.2.0", "network");
  recordFailure(h, "2026-10-16T00:00:00Z", "CHARTIX_UNAVAILABLE");
  recordSuccess(h, "2026-10-16T00:01:00Z", "2026-10-15");
  assert.equal(healthz(h).status, "ok");
  assert.equal(healthz(h).data_as_of, "2026-10-15");
});

test("healthz carries the fields the spec names", () => {
  const body = healthz(newHealth("0.2.0", "file"));
  for (const k of ["status", "version", "chartix_reachable", "last_success_at",
                   "symbols_indexed", "source_mode",
                   "chart_symbols_served_total", "chart_stale_responses_total"]) {
    assert.ok(k in body, `healthz is missing ${k}`);
  }
});

test("an inbound request id is propagated", () => {
  assert.equal(requestId("abc12345-trace"), "abc12345-trace");
});

test("a hostile request id cannot inject into the log", () => {
  // It is echoed back and written into JSON logs, so an unbounded header is a
  // log-injection vector.
  const out = requestId('aaaaaaaa"}\n{"level":"error","msg":"fake');
  assert.doesNotMatch(out, /[{}"\n]/);
  assert.ok(out.length <= 64);
});

test("a missing or too-short request id is replaced, not trusted", () => {
  assert.notEqual(requestId(undefined).length, 0);
  assert.notEqual(requestId("x"), "x");
});
