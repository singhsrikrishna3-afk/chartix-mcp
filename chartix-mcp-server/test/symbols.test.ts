/**
 * Symbol resolution. An unknown symbol must refuse, never succeed emptily:
 * an empty success reads to an agent as "this stock has no patterns".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlausibleSymbol,
  newestTime,
  normalizeSymbol,
  resolveOne,
  validateBars,
} from "../dist/chartix/symbols.js";
import { ChartixError, ChartixErrorCode } from "../dist/chartix/errors.js";

const UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries Limited" },
  { symbol: "M&M", name: "Mahindra & Mahindra Limited" },
  { symbol: "TATAMOTORS", name: "Tata Motors Limited" },
  { symbol: "TATAPOWER", name: "Tata Power Company Limited" },
  { symbol: "TCS", name: "Tata Consultancy Services Limited" },
];

test("case and whitespace do not matter", () => {
  assert.equal(normalizeSymbol("  reliance "), "RELIANCE");
});

test("suffixes pasted from other terminals are stripped", () => {
  assert.equal(normalizeSymbol("RELIANCE.NS"), "RELIANCE");
  assert.equal(normalizeSymbol("NSE:TCS"), "TCS");
});

test("the ampersand symbols that actually trade are accepted", () => {
  // Eight live NSE symbols contain "&", and M&M is in the NIFTY 50.
  for (const s of ["M&M", "J&KBANK", "ARE&M", "GVT&D", "S&SPOWER"]) {
    assert.ok(isPlausibleSymbol(s), s);
  }
});

test("an exact symbol match wins outright", () => {
  const got = resolveOne("m&m", UNIVERSE);
  assert.equal(got.symbol, "M&M");
  assert.equal(got.exact, true);
});

test("a unique name match resolves", () => {
  const got = resolveOne("Consultancy", UNIVERSE);
  assert.equal(got.symbol, "TCS");
  assert.equal(got.exact, false);
});

test("an ambiguous name is refused with the candidates, not guessed", () => {
  // Choosing between TATAMOTORS and TATAPOWER silently is how a research
  // answer ends up about the wrong instrument.
  assert.throws(
    () => resolveOne("Tata", UNIVERSE),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.NotFound);
      assert.match(e.message, /TATAMOTORS/);
      assert.match(e.message, /TATAPOWER/);
      return true;
    },
  );
});

test("an unknown symbol is SYMBOL_UNRESOLVED and lists what was tried", () => {
  // Never an empty success, and — §8 — the candidates are in the message, so
  // a caller can tell a bad spelling from an instrument Chartix lacks.
  assert.throws(
    () => resolveOne("NOTREAL", UNIVERSE),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.SymbolUnresolved);
      assert.match(e.message, /Tried: NOTREAL/);
      return true;
    },
  );
});

test("junk input is a bad request rather than a lookup", () => {
  assert.throws(
    () => resolveOne("'; DROP TABLE instruments;--", UNIVERSE),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.BadRequest);
      return true;
    },
  );
});

test("resolution is deterministic across repeated calls", () => {
  const a = resolveOne("tcs", UNIVERSE);
  const b = resolveOne("TCS", UNIVERSE);
  assert.deepEqual(a, b);
});

test("newestTime picks the latest, whatever the order", () => {
  assert.equal(
    newestTime([{ time: "2026-10-01" }, { time: "2026-10-14" }, { time: "2026-10-07" }]),
    "2026-10-14",
  );
});

test("newestTime is null when there is no timestamp to report", () => {
  assert.equal(newestTime([{ close: 1 }]), null);
  assert.equal(newestTime([]), null);
});

test("bars out of order are reported", () => {
  const got = validateBars([{ time: "2026-10-14" }, { time: "2026-10-01" }]);
  assert.equal(got.chronological, false);
});

test("an impossible bar is counted", () => {
  // Chartix had 29,681 bars where the high sat below the open. Passing one to
  // a model that will reason over it is worse than reporting it.
  const got = validateBars([
    { time: "2026-10-14", open: 100, high: 99, low: 98, close: 98.5 },
  ]);
  assert.equal(got.impossible, 1);
});

test("a normal bar passes both checks", () => {
  const got = validateBars([
    { time: "2026-10-13", open: 100, high: 105, low: 99, close: 104 },
    { time: "2026-10-14", open: 104, high: 106, low: 103, close: 105 },
  ]);
  assert.deepEqual(got, { chronological: true, impossible: 0 });
});

test("bars with string numbers are still checked", () => {
  // The API serialises NUMERIC columns as strings in places.
  const got = validateBars([
    { time: "2026-10-14", open: "100", high: "99", low: "98", close: "98.5" },
  ]);
  assert.equal(got.impossible, 1);
});
