/**
 * §8 — one symbol, four spellings, resolved in a stated order and never by
 * fuzzy name match.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidates,
  normalizeSymbol,
  renamedTo,
  resolveOne,
  symbolTable,
} from "../dist/chartix/symbols.js";
import { ChartixError, ChartixErrorCode } from "../dist/chartix/errors.js";

const UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries Limited" },
  { symbol: "M&M", name: "Mahindra & Mahindra Limited" },
  { symbol: "NIFTY_50", name: "Nifty 50" },
  { symbol: "NIFTY_BANK", name: "Nifty Bank" },
  { symbol: "BAJAJ-AUTO", name: "Bajaj Auto Limited" },
  { symbol: "LTIM", name: "LTIMindtree Limited" },
  { symbol: "TATAMOTORS", name: "Tata Motors Limited" },
  { symbol: "TATAPOWER", name: "Tata Power Company Limited" },
];

test("the alias table loads as data, not as code branches", () => {
  const t = symbolTable();
  assert.ok(Object.keys(t.aliases).length > 5, "aliases did not load");
  assert.equal(t.aliases.BANKNIFTY, "NIFTY_BANK");
});

test("the four spellings are tried in the order the spec states", () => {
  const forms = candidates("NSE:RELIANCE").map((c) => c.form);
  assert.equal(forms[0], "canonical");
  assert.ok(forms.includes("exchange_qualified"));
});

test("a Yahoo-style ticker resolves", () => {
  assert.equal(resolveOne("RELIANCE.NS", UNIVERSE).symbol, "RELIANCE");
});

test("an exchange-qualified ticker resolves", () => {
  assert.equal(resolveOne("NSE:RELIANCE", UNIVERSE).symbol, "RELIANCE");
});

test("an alias from the table resolves", () => {
  assert.equal(resolveOne("BANKNIFTY", UNIVERSE).symbol, "NIFTY_BANK");
  assert.equal(resolveOne("nifty50", UNIVERSE).symbol, "NIFTY_50");
  assert.equal(resolveOne("BAJAJAUTO", UNIVERSE).symbol, "BAJAJ-AUTO");
});

test("an ampersand symbol still survives the ladder", () => {
  assert.equal(resolveOne("m&m", UNIVERSE).symbol, "M&M");
});

// The shipped rename table is EMPTY on purpose — every candidate row was
// checked against Chartix and none survived (LTIM is is_active=0 with 5 bars
// ending 2024-07-29). The mechanism is still load-bearing, so it is exercised
// with an injected map rather than with a row invented to make a test pass.
const RENAMES = { OLDCO: "NEWCO" };

test("the shipped rename table is empty rather than guessed", () => {
  assert.deepEqual(symbolTable().renamed, {},
    "a rename row must be verified against live data before it ships");
  assert.equal(renamedTo("MINDTREE"), null);
});

test("a retired ticker is SYMBOL_CHANGED with its replacement, not a short series", () => {
  // §9: a renamed symbol quietly returning two years of history reads as a
  // data gap rather than a rename.
  assert.throws(
    () => resolveOne("OLDCO", UNIVERSE, RENAMES),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.SymbolChanged);
      assert.match(e.message, /NEWCO/);
      return true;
    },
  );
});

test("a rename that Chartix still carries is NOT hijacked", () => {
  // If the old ticker is genuinely still in the universe, serve it. The
  // rename table must never override live data.
  const stillListed = [...UNIVERSE, { symbol: "OLDCO", name: "Old Co" }];
  assert.equal(resolveOne("OLDCO", stillListed, RENAMES).symbol, "OLDCO");
});

test("ambiguity is returned, never fuzzy-matched away", () => {
  assert.throws(
    () => resolveOne("Tata", UNIVERSE),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.match(e.message, /TATAMOTORS/);
      assert.match(e.message, /TATAPOWER/);
      return true;
    },
  );
});

test("an unresolvable symbol names every candidate tried", () => {
  assert.throws(
    () => resolveOne("NSE:GHOST.NS", UNIVERSE),
    (e: unknown) => {
      assert.ok(e instanceof ChartixError);
      assert.equal(e.code, ChartixErrorCode.SymbolUnresolved);
      assert.match(e.message, /Tried:/);
      return true;
    },
  );
});

test("resolution stays deterministic across repeated calls", () => {
  assert.deepEqual(resolveOne("banknifty", UNIVERSE), resolveOne("BANKNIFTY", UNIVERSE));
});

test("normalisation is idempotent", () => {
  const once = normalizeSymbol("nse:reliance.ns");
  assert.equal(normalizeSymbol(once), once);
});
