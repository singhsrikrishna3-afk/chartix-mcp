/**
 * The data contract every payload carries (§9).
 *
 * The section's premise is right: an undefined point here is a silently wrong
 * number downstream. Two of its own points could not be answered as written,
 * and saying so is part of the contract rather than a footnote.
 */
import { ChartixError, ChartixErrorCode } from "./errors.js";

/**
 * Price basis.
 *
 * §9 offers `adjustment: "split" | "none"`. Chartix is neither. Its EOD close
 * comes from Yahoo with auto_adjust=True, so it is marked down for every later
 * dividend AND split — right for returns and charts, wrong for anything
 * differenced against a raw series. (Chartix learned that the expensive way:
 * `fut - adjusted_spot` invented a premium equal to all subsequent dividends,
 * and TECHM showed +3.2% a day before expiry, which arbitrage makes
 * impossible.)
 *
 * The unadjusted exchange close is carried separately as `close_raw` on EOD
 * rows. So the honest answer is a third value, and forcing it into a two-value
 * enum would produce exactly the silent wrong number §9 exists to prevent.
 */
export type Adjustment = "split_and_dividend" | "none" | "unknown";

export interface PriceBasis {
  readonly adjustment: Adjustment;
  readonly adjusted_field: string;
  readonly unadjusted_field: string | null;
  readonly note: string;
}

export const EOD_BASIS: PriceBasis = {
  adjustment: "split_and_dividend",
  adjusted_field: "close",
  unadjusted_field: "close_raw",
  note:
    "`close` is split- AND dividend-adjusted (Yahoo auto_adjust=True), so it " +
    "is restated downward by every later corporate action. `close_raw` is the " +
    "exchange's unadjusted close from the NSE bhavcopy, present on most EOD " +
    "rows. Use close for returns and charts; use close_raw for anything " +
    "differenced against another raw series.",
};

export const INTRADAY_BASIS: PriceBasis = {
  adjustment: "unknown",
  adjusted_field: "close",
  unadjusted_field: null,
  note:
    "Intraday bars come from a live feed rather than the adjusted EOD table, " +
    "and Chartix does not state their adjustment. Reported as unknown rather " +
    "than assumed — do not difference intraday closes against EOD closes.",
};

/** IST. Chartix is NSE-only and every date it returns is a trading session. */
export const TIMEZONE = "Asia/Kolkata (UTC+05:30)";

/**
 * Freshness (§9).
 *
 * `ingested_at` is specified by §9 as "when ChartixAI says the data landed".
 * Chartix says no such thing — no endpoint returns an ingest timestamp — so it
 * is reported as null with a reason rather than filled in with our own fetch
 * time, which would present our clock as the data's provenance.
 */
export interface Freshness {
  readonly as_of: string | null;
  readonly ingested_at: null;
  readonly ingested_at_note: string;
  readonly fetched_at: string;
  readonly stale: boolean;
  readonly stale_reason: string | null;
}

const INGEST_NOTE =
  "Chartix exposes no ingest timestamp on any route, so this is null rather " +
  "than our fetch time. Bars for a session are written by the nightly sync " +
  "at about 18:40 IST; chart patterns are detected at 20:05 IST.";

/** Weekend check in IST, which is the only calendar Chartix trades on. */
function istParts(d: Date): { iso: string; day: number } {
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return { iso: ist.toISOString().slice(0, 10), day: ist.getUTCDay() };
}

/**
 * The most recent session that should have data by now.
 *
 * Deliberately conservative: today only counts after the nightly sync has run,
 * so a query during market hours expects yesterday's bar and does not call a
 * perfectly healthy feed stale.
 */
export function lastExpectedSession(
  now: Date,
  holidays: ReadonlySet<string>,
  syncHourIst = 19,
): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const cursor = new Date(ist);
  if (ist.getUTCHours() < syncHourIst) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < 20; i += 1) {
    const iso = cursor.toISOString().slice(0, 10);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(iso)) return iso;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
}

export function freshness(
  asOf: string | null,
  fetchedAt: string,
  now: Date,
  holidays: ReadonlySet<string>,
): Freshness {
  const expected = lastExpectedSession(now, holidays);
  const stale = asOf !== null && asOf < expected;
  return {
    as_of: asOf,
    ingested_at: null,
    ingested_at_note: INGEST_NOTE,
    fetched_at: fetchedAt,
    stale,
    stale_reason: stale
      ? `newest bar is ${asOf}, but ${expected} has closed and been synced`
      : null,
  };
}

/**
 * Sessions inside the range that have no bar and are not holidays (§9).
 *
 * Strictly interior — a gap before the series begins is the data's floor, not
 * a hole, and reporting it would make every pre-1996 equity request look
 * broken. (Per-stock coverage starts in 1996; the 1991 bars are one index.)
 */
export function missingSessions(
  dates: readonly string[],
  holidays: ReadonlySet<string>,
): string[] {
  if (dates.length < 2) return [];
  const have = new Set(dates);
  const sorted = [...dates].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const out: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (iso >= last) break;
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (holidays.has(iso)) continue;
    if (!have.has(iso)) out.push(iso);
  }
  return out;
}

/** OHLC invariants (§9), reported rather than thrown — a bad bar is a finding. */
export interface Invariants {
  readonly chronological: boolean;
  readonly duplicate_sessions: string[];
  readonly impossible_bars: number;
  readonly non_positive: number;
  readonly negative_volume: number;
}

export function checkInvariants(
  rows: ReadonlyArray<Record<string, unknown>>,
): Invariants {
  let chronological = true;
  let impossible = 0;
  let nonPositive = 0;
  let negVolume = 0;
  const seen = new Set<string>();
  const dupes = new Set<string>();
  let prev: string | null = null;

  for (const row of rows) {
    const t = typeof row.time === "string" ? row.time.slice(0, 10) : null;
    if (t !== null) {
      if (prev !== null && t < prev) chronological = false;
      if (seen.has(t)) dupes.add(t);
      seen.add(t);
      prev = t;
    }
    const o = num(row.open), h = num(row.high), l = num(row.low), c = num(row.close);
    const v = num(row.volume);
    if (v !== null && v < 0) negVolume += 1;
    if (o === null || h === null || l === null || c === null) continue;
    if ([o, h, l, c].some((x) => x <= 0)) nonPositive += 1;
    if (!(l <= Math.min(o, c) && h >= Math.max(o, c) && l <= h)) impossible += 1;
  }
  return {
    chronological,
    duplicate_sessions: [...dupes].sort(),
    impossible_bars: impossible,
    non_positive: nonPositive,
    negative_volume: negVolume,
  };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** §9: a renamed or delisted symbol is its own error, not a short series. */
export function symbolChanged(from: string, to: string): ChartixError {
  return new ChartixError(
    ChartixErrorCode.SymbolChanged,
    `${from} is no longer the NSE symbol for this instrument; it is now ${to}. ` +
      `Re-request with ${to} rather than treating the short history as a gap.`,
  );
}
