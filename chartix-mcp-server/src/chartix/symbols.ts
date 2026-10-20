/**
 * Resolving what a user typed to a symbol Chartix will accept.
 *
 * Deterministic on purpose: an unknown symbol must come back as
 * CHARTIX_NOT_FOUND, never as an empty success, because an empty success reads
 * to an agent as "this stock has no patterns" rather than "I made that up".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChartixError, ChartixErrorCode } from "./errors.js";

/**
 * The alias table, loaded as DATA (§8).
 *
 * config/symbols.json, not a chain of if-statements: a new spelling is a row
 * someone adds without reading this file, and the rules that ARE derivable —
 * NSE: prefixes, .NS suffixes — stay as rules rather than three thousand rows.
 */
interface SymbolTable {
  aliases: Record<string, string>;
  renamed: Record<string, string>;
}

let TABLE: SymbolTable | undefined;

export function symbolTable(): SymbolTable {
  if (TABLE) return TABLE;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/chartix/ -> ../../config, src/chartix/ -> ../../config
  const candidates = [
    join(here, "..", "..", "config", "symbols.json"),
    join(here, "..", "..", "..", "config", "symbols.json"),
  ];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.aliases ?? {})) {
        if (typeof v === "string") aliases[k.toUpperCase()] = v.toUpperCase();
      }
      const renamed: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.renamed ?? {})) {
        if (k !== "_comment" && typeof v === "string") {
          renamed[k.toUpperCase()] = v.toUpperCase();
        }
      }
      TABLE = { aliases, renamed };
      return TABLE;
    } catch {
      continue;
    }
  }
  // An absent table is not fatal: the derivable rules still work, and refusing
  // to start over a missing data file would be worse than resolving less.
  TABLE = { aliases: {}, renamed: {} };
  return TABLE;
}

export interface InstrumentRow {
  readonly symbol: string;
  readonly name?: string | null;
  readonly sector?: string | null;
  readonly segment?: string | null;
}

/** Chartix stores NSE symbols uppercase, with & and - appearing literally. */
export function normalizeSymbol(input: string): string {
  const s = input.trim().toUpperCase();
  // Strip the suffixes people paste from other terminals. Chartix is NSE-only,
  // so ".NS" and "NSE:" are noise rather than information.
  return s.replace(/^NSE:/, "").replace(/\.(NS|BO)$/, "");
}

export interface Candidate {
  readonly form: "canonical" | "exchange_qualified" | "yahoo" | "alias";
  readonly value: string;
}

/**
 * The spellings to try, in §8's order: exact canonical, exchange-qualified,
 * Yahoo-style, then the alias table. Each step is derivable or looked up —
 * none of it is a fuzzy name match, which §8 forbids and which is how a
 * research answer ends up about the wrong instrument.
 */
export function candidates(input: string): Candidate[] {
  const raw = input.trim().toUpperCase();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (form: Candidate["form"], value: string) => {
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push({ form, value });
    }
  };
  push("canonical", raw);
  if (raw.startsWith("NSE:")) push("exchange_qualified", raw.slice(4));
  if (/\.(NS|BO)$/.test(raw)) push("yahoo", raw.replace(/\.(NS|BO)$/, ""));
  const table = symbolTable();
  for (const { value } of [...out]) {
    const aliased = table.aliases[value];
    if (aliased) push("alias", aliased);
  }
  const direct = table.aliases[raw];
  if (direct) push("alias", direct);
  return out;
}

/** §9: has this ticker been retired in favour of another? */
export function renamedTo(symbol: string): string | null {
  return symbolTable().renamed[normalizeSymbol(symbol)] ?? null;
}

export function isPlausibleSymbol(input: string): boolean {
  // Eight live NSE symbols contain "&" (M&M, J&KBANK, ARE&M...), and some
  // contain "-". Rejecting those would quietly lose a NIFTY 50 constituent.
  return /^[A-Z0-9&.\-]{1,24}$/.test(normalizeSymbol(input));
}

export interface ResolveResult {
  readonly symbol: string;
  readonly name: string | null;
  readonly exact: boolean;
  readonly considered: number;
}

/**
 * Pick one row for a query, or refuse.
 *
 * Exact symbol match wins outright. Otherwise a single name match is accepted
 * and anything ambiguous is refused with the candidates listed, because
 * silently choosing between TATAMOTORS and TATAMTRDVR is how a research answer
 * ends up about the wrong instrument.
 */
export function resolveOne(
  query: string,
  rows: readonly InstrumentRow[],
  renames: Readonly<Record<string, string>> = symbolTable().renamed,
): ResolveResult {
  const want = normalizeSymbol(query);
  if (!isPlausibleSymbol(want)) {
    throw new ChartixError(
      ChartixErrorCode.BadRequest,
      `"${query}" is not a usable NSE symbol or search term.`,
    );
  }

  // §9: a retired ticker is its own answer, checked before the lookup so a
  // renamed symbol never comes back as a short series.
  const nowCalled = renames[want] ?? null;
  if (nowCalled && !rows.some((r) => normalizeSymbol(r.symbol) === want)) {
    throw new ChartixError(
      ChartixErrorCode.SymbolChanged,
      `${want} is no longer the NSE symbol for this instrument; it is now ` +
        `${nowCalled}. Re-request with ${nowCalled} rather than treating the ` +
        `short history as a gap.`,
    );
  }

  // §8's ladder: canonical, exchange-qualified, Yahoo-style, alias table.
  const tried: string[] = [];
  for (const cand of candidates(query)) {
    tried.push(cand.value);
    const hit = rows.find((r) => normalizeSymbol(r.symbol) === cand.value);
    if (hit) {
      return {
        symbol: normalizeSymbol(hit.symbol),
        name: hit.name ?? null,
        exact: cand.form === "canonical",
        considered: rows.length,
      };
    }
  }

  const byName = rows.filter((r) =>
    (r.name ?? "").toUpperCase().includes(want),
  );
  if (byName.length === 1 && byName[0]) {
    return {
      symbol: normalizeSymbol(byName[0].symbol),
      name: byName[0].name ?? null,
      exact: false,
      considered: rows.length,
    };
  }
  if (byName.length > 1) {
    const candidates = byName.slice(0, 8).map((r) => r.symbol).join(", ");
    throw new ChartixError(
      ChartixErrorCode.NotFound,
      `"${query}" matches ${byName.length} instruments (${candidates}${
        byName.length > 8 ? ", ..." : ""
      }). Ask for one exactly.`,
    );
  }

  // §8: fail with the candidates tried, not a bare "not found" — the list is
  // what tells a caller whether the spelling or the instrument is the problem.
  throw new ChartixError(
    ChartixErrorCode.SymbolUnresolved,
    `Could not resolve "${query}" to an NSE symbol Chartix knows. Tried: ` +
      `${tried.join(", ")}. Name matching is deliberately not attempted — ` +
      `ask for an exact ticker.`,
  );
}

/** Newest timestamp in a bar series, for the as_of stamp. */
export function newestTime(
  rows: ReadonlyArray<Record<string, unknown>>,
): string | null {
  let best: string | null = null;
  for (const row of rows) {
    const t = row.time ?? row.date ?? row.t;
    if (typeof t !== "string") continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

/**
 * Are the bars in ascending time order, and is each one internally possible?
 *
 * Chartix had 29,681 bars where the high was below the open or the low above
 * the close, and repaired them. Checking here is cheap and means this server
 * reports a bad bar rather than passing it to a model that will reason over it.
 */
export function validateBars(
  rows: ReadonlyArray<Record<string, unknown>>,
): { chronological: boolean; impossible: number } {
  let chronological = true;
  let impossible = 0;
  let prev: string | null = null;
  for (const row of rows) {
    const t = typeof row.time === "string" ? row.time : null;
    if (t !== null && prev !== null && t < prev) chronological = false;
    if (t !== null) prev = t;
    const o = num(row.open), h = num(row.high), l = num(row.low), c = num(row.close);
    if (o === null || h === null || l === null || c === null) continue;
    if (!(l <= Math.min(o, c) && h >= Math.max(o, c) && l <= h)) impossible += 1;
  }
  return { chronological, impossible };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
