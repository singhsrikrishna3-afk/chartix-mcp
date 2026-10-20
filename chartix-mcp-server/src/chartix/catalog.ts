/**
 * What Chartix actually serves, taken from the running application rather than
 * from documentation — there is none.
 *
 * Verified 15 October 2026 against the FastAPI app (app/main.py,
 * app/api/*.py) and the production database:
 *
 *   base URL        https://api.chartixai.com
 *   auth            Authorization: Bearer <JWT>, HS256, from
 *                   POST /api/auth/login (OAuth2 password form). No API-key
 *                   mechanism exists.
 *   routes          82 GET endpoints under /api
 *   rate limits     none published, none enforced
 *   daily bars      8,397,044, earliest 1991-01-02, latest 2026-10-14
 *   intraday        2,461 symbols
 *   universe        3,017 active EQ instruments
 *
 * The tier column is Chartix's own TIER_PROTECTED_ROUTES map. It is reproduced
 * here so a tool can say "this needs EOD Pro" before spending a request, and
 * so the mismatch noted on `intraday` below is written down somewhere.
 */

export const CHARTIX_DEFAULT_BASE_URL = "https://api.chartixai.com";

/** Verified against the running app: Query(50, le=3000). Exceeding it is a 422. */
export const MAX_INSTRUMENT_LIMIT = 3000;

/** Chartix's tier ladder, lowest first. */
export const TIER_ORDER = ["free", "eod_basic", "eod_pro", "ai_eod_pro"] as const;
export type Tier = (typeof TIER_ORDER)[number];

export interface EndpointFact {
  readonly path: string;
  /** Minimum tier enforced by Chartix's middleware, or "free" if ungated. */
  readonly tier: Tier;
  readonly note?: string;
}

export const ENDPOINTS = {
  login: { path: "/api/auth/login", tier: "free" },
  me: { path: "/api/auth/me", tier: "free" },
  health: { path: "/api/health", tier: "free" },

  instruments: {
    path: "/api/instruments/",
    tier: "free",
    note:
      "limit is capped at 3000 (Query(50, le=3000)); anything higher is a " +
      "422, not a clamp. The active EQ universe is slightly larger than that " +
      "cap, so a single full-universe fetch can miss the tail — resolve the " +
      "remainder with search= rather than assuming one page is everything.",
  },
  eod: { path: "/api/instruments/{symbol}/eod", tier: "free" },
  intraday: {
    path: "/api/instruments/{symbol}/intraday",
    tier: "eod_pro",
    note:
      "Gated server-side at eod_pro since 381f224 (verified: a free or " +
      "eod_basic account is refused). It had been ungated, because the tier " +
      "middleware matched path PREFIXES and the symbol sits in the middle of " +
      "this route, so no prefix reached it while the web UI paywalled it on " +
      "the client only. TIER_PROTECTED_PATTERNS now matches segment-wise. " +
      "chartix_get_bars still defaults to daily and makes intraday an " +
      "explicit argument, which remains the right default for an agent.",
  },
  holidays: { path: "/api/instruments/holidays", tier: "free" },

  patterns: {
    path: "/api/screener/patterns",
    tier: "eod_basic",
    note:
      "This LIST route returns no win rate. Verified against production on " +
      "15 Oct 2026, a row carries: confidence, detection_time, id, image_url, " +
      "key_points, pattern_type, sector, status, stop_loss, symbol, " +
      "target_price, timeframe. `confidence` is the gated quality figure — " +
      "a backtested shape keeps its measured rate, a merely geometric fit is " +
      "discounted x0.55 — which is why 0.45 is the default floor.\n" +
      "Only /patterns/for-symbol joins pattern_backtest_stats, and its " +
      "win_rate is nullable: the join is gated on >=20 samples, so a shape " +
      "with too little history comes back null rather than optimistic.\n" +
      "sample_size is NOT exposed by any route. An agent must not be told to " +
      "report one.",
  },
  patternsForSymbol: {
    path: "/api/screener/patterns/for-symbol/{symbol}",
    tier: "eod_basic",
    note:
      "The only route that carries win_rate. Nullable — see the note above. " +
      "Row keys: completion_time, confidence, detection_time, id, " +
      "pattern_type, pivots, status, stop_loss, target_price, win_rate.",
  },
  patternsWhyEmpty: {
    path: "/api/screener/patterns/why-empty",
    tier: "eod_basic",
    note:
      "Explains an empty pattern result: below_gate, not_detected, none_found " +
      "or filtered_elsewhere. Call it instead of telling a user to adjust " +
      "filters, which is wrong for three of those four cases.",
  },
  scansOther: { path: "/api/scans/other", tier: "eod_basic" },
  scanners: {
    path: "/api/scanners/",
    tier: "eod_pro",
    note: "The no-code custom scanner. Saved scans live here.",
  },

  watchlist: { path: "/api/watchlist/", tier: "free" },
  alertRules: { path: "/api/alerts/rules", tier: "free" },
  telegramStatus: { path: "/api/alerts/telegram/status", tier: "free" },
  telegramLink: { path: "/api/alerts/telegram/link", tier: "eod_pro" },
} as const satisfies Record<string, EndpointFact>;

export function rank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/** Does `held` reach `needed`? */
export function tierSatisfies(held: string | undefined, needed: Tier): boolean {
  if (held === undefined) return false;
  const canonical = TIER_ALIASES[held] ?? held;
  const i = TIER_ORDER.indexOf(canonical as Tier);
  if (i < 0) return false;
  return i >= rank(needed);
}

/** Legacy tier names still present in Chartix's own database. */
export const TIER_ALIASES: Readonly<Record<string, string>> = {
  intraday: "eod_pro",
  intraday_pro: "ai_eod_pro",
  eod_basic_weekly: "eod_basic",
  eod_pro_weekly: "eod_pro",
  ai_eod_pro_weekly: "ai_eod_pro",
};

/**
 * How far back a symbol's history really goes.
 *
 * The marketing line is "8.3m bars since 1991" and the row count is real, but
 * 1991-1995 holds about 260 bars a year — one index, not the market. Per-stock
 * breadth starts in 1996 (16,035 bars that year), and Chartix's own notes
 * record that 1996/2002 are Yahoo's floors rather than listing dates.
 *
 * An agent asking for RELIANCE in 1993 must be told that, not handed silence.
 */
export const HISTORY_FLOORS = {
  anyInstrument: "1991-01-02",
  equityBreadth: "1996-01-01",
  note:
    "Bars exist from 1991-01-02 but only for a single index series; " +
    "per-stock coverage begins in 1996. A request for equity history before " +
    "1996 is expected to come back short, and that is the data's floor, not " +
    "an error.",
} as const;

/** The chart a human should open. Verified: the page reads ?symbol=. */
export function chartUrl(
  symbol: string,
  opts: { timeframe?: string; site?: string } = {},
): string {
  const site = opts.site ?? "https://chartixai.com";
  const url = new URL("/dashboard/charts", site);
  url.searchParams.set("symbol", symbol.toUpperCase());
  if (opts.timeframe) url.searchParams.set("tf", opts.timeframe);
  return url.toString();
}
