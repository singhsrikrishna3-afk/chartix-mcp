/**
 * The tool surface Quantcept sees.
 *
 * Descriptions are operating instructions, not marketing: the model reads them
 * to decide what to call and what it is allowed to say afterwards. Where
 * Chartix's own figures are passed through (pattern win rates), the description
 * says so, because the agent must attribute them rather than adopt them.
 */
import { z } from "zod";
import type { ChartixClient } from "../chartix/client.js";
import type { FileSource } from "../chartix/fileSource.js";
import type { HealthState } from "../chartix/health.js";
import { ChartixError, ChartixErrorCode } from "../chartix/errors.js";
import {
  ENDPOINTS,
  HISTORY_FLOORS,
  MAX_INSTRUMENT_LIMIT,
  chartUrl,
} from "../chartix/catalog.js";
import {
  newestTime,
  normalizeSymbol,
  resolveOne,
  validateBars,
  type InstrumentRow,
} from "../chartix/symbols.js";

export interface ToolContext {
  readonly client: ChartixClient;
  readonly siteUrl: string;
  /** §13 counters. Optional so tests can build a context without one. */
  readonly health?: HealthState;
  /** §10: present only in --source=file mode. */
  readonly file?: FileSource;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

const SymbolArg = z
  .string()
  .min(1)
  .describe("An NSE symbol such as RELIANCE, or M&M. Case-insensitive.");

/** Turn any throw into the typed error envelope a model can act on. */
export async function runTool(
  def: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  try {
    const parsed = def.schema.parse(args ?? {});
    return await def.handler(parsed, ctx);
  } catch (err) {
    if (err instanceof ChartixError) return err.toJSON();
    if (err instanceof z.ZodError) {
      return new ChartixError(
        ChartixErrorCode.BadRequest,
        `Invalid arguments: ${err.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      ).toJSON();
    }
    // Never let an unexpected throw become prose or take the server down.
    return new ChartixError(
      ChartixErrorCode.Unavailable,
      `${def.name} failed unexpectedly: ${(err as Error).name}`,
    ).toJSON();
  }
}

async function listInstruments(
  ctx: ToolContext,
  search: string | undefined,
  limit: number,
): Promise<InstrumentRow[]> {
  const res = await ctx.client.get<InstrumentRow[]>(ENDPOINTS.instruments.path, {
    ...(search !== undefined ? { search } : {}),
    limit,
  });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * The symbol index (§13): loaded once, reused, and the thing /readyz waits on.
 *
 * Cached for the process because the universe changes when a stock lists, not
 * between two questions in a chat — and because the watchlist tool was
 * re-fetching 3,000 rows on every call to resolve a handful of symbols.
 */
let INDEX: { rows: InstrumentRow[]; at: number } | undefined;
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

export async function symbolIndex(ctx: ToolContext): Promise<InstrumentRow[]> {
  if (ctx.file) {
    // §10: in file mode the index is whatever the export contains.
    return ctx.file.symbols().map((symbol) => ({ symbol }));
  }
  const now = Date.now();
  if (INDEX && now - INDEX.at < INDEX_TTL_MS) return INDEX.rows;
  const rows = await listInstruments(ctx, undefined, MAX_INSTRUMENT_LIMIT);
  INDEX = { rows, at: now };
  if (ctx.health) ctx.health.symbolsIndexed = rows.length;
  return rows;
}

/** For tests, and for a deliberate refresh. */
export function clearSymbolIndex(): void {
  INDEX = undefined;
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: "chartix_list_symbols",
    description:
      "Resolve a name or ticker to the exact NSE symbol Chartix uses. Call " +
      "this before any other Chartix tool when the user gave a company name " +
      "rather than a ticker. Returns candidates; an ambiguous query is " +
      "refused with the candidates listed rather than guessed at. Chartix " +
      "covers NSE equities only — 3,017 active instruments as of 15 Oct 2026.",
    schema: z.object({
      query: z.string().min(1).describe("Ticker or part of a company name."),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    handler: async (args, ctx) => {
      const { query, limit } = args as { query: string; limit: number };
      const rows = await listInstruments(ctx, query, limit);
      return {
        ok: true,
        source: "chartixai",
        query,
        count: rows.length,
        matches: rows.map((r) => ({
          symbol: normalizeSymbol(r.symbol),
          name: r.name ?? null,
          sector: r.sector ?? null,
        })),
      };
    },
  },

  {
    name: "chartix_get_bars",
    description:
      "OHLCV bars for one NSE symbol from Chartix. Daily by default.\n\n" +
      "History: bars exist from 1991-01-02, but only for a single index " +
      "series; per-stock coverage begins in 1996. A request for equity " +
      "history before 1996 will come back short — that is the data's floor, " +
      "not an error, and must not be reported as missing data.\n\n" +
      "Set interval='intraday' only when the question genuinely needs " +
      "intraday bars; it is a different and much larger dataset (2,461 " +
      "symbols) and Chartix treats intraday as paid-tier data in its own UI.\n\n" +
      "Returns an as_of timestamp. Never present these bars as live prices.",
    schema: z.object({
      symbol: SymbolArg,
      interval: z.enum(["daily", "intraday"]).default("daily"),
      start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive ISO date. Omit for Chartix's default window."),
      limit: z.number().int().min(1).max(10_000).optional(),
    }),
    handler: async (args, ctx) => {
      const a = args as {
        symbol: string;
        interval: "daily" | "intraday";
        start?: string;
        limit?: number;
      };
      const sym = normalizeSymbol(a.symbol);
      const path =
        a.interval === "intraday"
          ? ENDPOINTS.intraday.path.replace("{symbol}", encodeURIComponent(sym))
          : ENDPOINTS.eod.path.replace("{symbol}", encodeURIComponent(sym));

      const res = await ctx.client.get<Array<Record<string, unknown>>>(
        path,
        { ...(a.start !== undefined ? { start: a.start } : {}) },
        (rows) => (Array.isArray(rows) ? newestTime(rows) : null),
      );
      const rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) {
        throw new ChartixError(
          ChartixErrorCode.NotFound,
          `Chartix returned no ${a.interval} bars for ${sym}. Check the symbol ` +
            `with chartix_list_symbols; if the start date is before ` +
            `${HISTORY_FLOORS.equityBreadth}, that is the history floor.`,
          { endpoint: path },
        );
      }
      const trimmed = a.limit ? rows.slice(-a.limit) : rows;
      const checks = validateBars(trimmed);
      return {
        ok: true,
        source: "chartixai",
        symbol: sym,
        interval: a.interval,
        count: trimmed.length,
        as_of: res.as_of,
        fetched_at: res.fetched_at,
        history_floor: HISTORY_FLOORS.equityBreadth,
        integrity: checks,
        bars: trimmed,
      };
    },
  },

  {
    name: "chartix_get_patterns",
    description:
      "Chart patterns Chartix has detected.\n\n" +
      "WHICH FIGURE YOU GET DEPENDS ON HOW YOU CALL IT. Without `symbol` you " +
      "get the market-wide list, and those rows carry `confidence` but NO " +
      "win rate. With `symbol` you get that stock's patterns joined to " +
      "Chartix's backtest, and those rows carry `win_rate` — which is " +
      "nullable, because the join needs at least 20 samples and returns null " +
      "rather than an optimistic guess when a shape has too little history.\n\n" +
      "`confidence` is not a win rate and must not be called one. It is " +
      "Chartix's quality figure: a backtested shape keeps its measured rate, " +
      "a merely geometric fit is discounted, and 0.45 is the floor below " +
      "which Chartix hides a pattern.\n\n" +
      "Attribution: where win_rate is present it is CHARTIX'S measurement. " +
      "Quote it as Chartix's and never recompute, round or restate it as your " +
      "own analysis. Chartix exposes no sample size through its API, so do " +
      "not report one.\n\n" +
      "An empty result is meaningful and has four different causes. When this " +
      "returns nothing, call chartix_patterns_why_empty before telling the " +
      "user to change their filters — for three of the four causes that " +
      "advice is wrong. Chartix implements 15 pattern shapes; a name outside " +
      "that list has no detector and will never return anything.",
    schema: z.object({
      symbol: SymbolArg.optional(),
      pattern_type: z
        .string()
        .optional()
        .describe(
          "One of Chartix's 15 implemented shapes, e.g. double_bottom, " +
            "head_shoulders, asc_triangle, falling_wedge.",
        ),
      status: z.enum(["forming", "confirmed", "any"]).default("forming"),
      timeframe: z.enum(["D", "W", "M"]).default("D"),
      min_confidence: z.number().min(0).max(1).default(0.45),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (args, ctx) => {
      const a = args as {
        symbol?: string;
        pattern_type?: string;
        status: string;
        timeframe: string;
        min_confidence: number;
        limit: number;
      };
      // §10: file mode is the whole answer, not a fallback. FileSource.patterns()
      // holds exactly the columns this tool reports, so in file mode we must not
      // reach for the network at all — a CSV-backed install has no credential and
      // used to get CHARTIX_AUTH_FAILED from the one tool whose data it had.
      if (ctx.file) {
        const sym = a.symbol !== undefined ? normalizeSymbol(a.symbol) : undefined;
        const rows = ctx.file.patterns(sym).slice(0, a.limit);
        const status = ctx.file.status();
        return {
          ok: true,
          source: "file",
          source_path: status.path,
          // The export carries measured win rates per row, so unlike the
          // market-wide network call this IS a win rate — but only for the
          // rows the export happens to contain.
          win_rate_available: true,
          attribution:
            "win_rate comes from the supplied CSV export, not a live Chartix " +
            "query. Attribute it to Chartix as of " +
            `${status.as_of ?? "an unstated date"}; never fill in a null.`,
          ...(sym !== undefined ? { symbol: sym } : {}),
          count: rows.length,
          empty_is_meaningful: rows.length === 0,
          next_step:
            rows.length === 0
              ? "The CSV export has no rows for this symbol. File mode cannot " +
                "query Chartix, so there is nothing further to try here — say the " +
                "export does not cover it rather than naming another tool."
              : null,
          as_of: status.as_of,
          fetched_at: status.loaded_at,
          patterns: rows,
        };
      }
      if (a.symbol) {
        const sym = normalizeSymbol(a.symbol);
        const path = ENDPOINTS.patternsForSymbol.path.replace(
          "{symbol}",
          encodeURIComponent(sym),
        );
        const res = await ctx.client.get<Record<string, unknown>>(path, {
          timeframe: a.timeframe,
          limit: a.limit,
        });
        return {
          ok: true,
          source: "chartixai",
          win_rate_available: true,
          attribution:
            "win_rate is Chartix's own backtested measurement and may be " +
            "null where the shape has fewer than 20 samples. Attribute it to " +
            "Chartix; never fill in a null with an estimate.",
          symbol: sym,
          as_of: res.as_of,
          fetched_at: res.fetched_at,
          data: res.data,
        };
      }
      const res = await ctx.client.get<unknown>(ENDPOINTS.patterns.path, {
        ...(a.pattern_type !== undefined ? { pattern_type: a.pattern_type } : {}),
        status: a.status,
        timeframe: a.timeframe,
        min_confidence: a.min_confidence,
        limit: a.limit,
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      return {
        ok: true,
        source: "chartixai",
        // Stated rather than left to be discovered: the market-wide list
        // genuinely has no win rate, and an agent told to report one will
        // otherwise reach for `confidence` and call it a win rate.
        win_rate_available: false,
        attribution:
          "These rows carry `confidence`, which is Chartix's quality figure " +
          "and NOT a win rate. For Chartix's backtested win rate, call this " +
          "tool again with `symbol` set.",
        count: rows.length,
        empty_is_meaningful: rows.length === 0,
        next_step:
          rows.length === 0
            ? "Call chartix_patterns_why_empty with the same arguments."
            : null,
        as_of: res.as_of,
        fetched_at: res.fetched_at,
        patterns: rows,
      };
    },
  },

  {
    name: "chartix_patterns_why_empty",
    description:
      "Why a pattern query returned nothing. Chartix answers with one of " +
      "four reasons: below_gate (found, but under the measured-win-rate " +
      "quality gate), not_detected (no detector for that shape — it will " +
      "always be empty), none_found (nothing matched), or filtered_elsewhere " +
      "(found and above the gate, excluded by liquidity or the one-per-stock " +
      "cap). Only none_found is a reason to suggest changing filters.",
    schema: z.object({
      pattern_type: z.string().optional(),
      status: z.enum(["forming", "confirmed", "any"]).default("forming"),
      timeframe: z.enum(["D", "W", "M"]).default("D"),
      min_confidence: z.number().min(0).max(1).default(0.45),
    }),
    handler: async (args, ctx) => {
      const a = args as Record<string, string | number | undefined>;
      const res = await ctx.client.get<Record<string, unknown>>(
        ENDPOINTS.patternsWhyEmpty.path,
        a,
      );
      return { ok: true, source: "chartixai", ...res.data, fetched_at: res.fetched_at };
    },
  },

  {
    name: "chartix_run_screen",
    description:
      "Run one of Chartix's scans. scan_family='other' covers the built-in " +
      "scans (breakout, vcp, week52, volume, gaps, divergence, ...); " +
      "scan_family='saved' runs a saved custom scanner by id. Returns the " +
      "matches and the parameters used, so the result can be reproduced. " +
      "Saved scanners need Chartix EOD Pro; the built-in scans need EOD Basic.",
    schema: z.object({
      scan_family: z.enum(["other", "saved"]).default("other"),
      scan_type: z
        .string()
        .optional()
        .describe("For scan_family='other', e.g. breakout, vcp, week52."),
      scanner_id: z.union([z.string(), z.number()]).optional(),
      params: z.record(z.unknown()).default({}),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: async (args, ctx) => {
      const a = args as {
        scan_family: "other" | "saved";
        scan_type?: string;
        scanner_id?: string | number;
        params: Record<string, unknown>;
        limit: number;
      };
      if (a.scan_family === "saved") {
        if (a.scanner_id === undefined) {
          throw new ChartixError(
            ChartixErrorCode.BadRequest,
            "scan_family='saved' needs scanner_id.",
          );
        }
        const res = await ctx.client.get<unknown>(
          `${ENDPOINTS.scanners.path}${encodeURIComponent(String(a.scanner_id))}`,
          { limit: a.limit },
        );
        return {
          ok: true as const,
          source: "chartixai" as const,
          scanner_id: a.scanner_id,
          as_of: res.as_of,
          fetched_at: res.fetched_at,
          data: res.data,
        };
      }
      if (a.scan_type === undefined) {
        throw new ChartixError(
          ChartixErrorCode.BadRequest,
          "scan_family='other' needs scan_type.",
        );
      }
      // The real page lets params override scan_type, so build the body in the
      // same order — spreading params last is what the UI does.
      const res = await ctx.client.post<unknown>(ENDPOINTS.scansOther.path, {
        scan_type: a.scan_type,
        limit: a.limit,
        ...a.params,
      });
      const rows =
        typeof res.data === "object" && res.data !== null
          ? ((res.data as Record<string, unknown>).matches ?? [])
          : [];
      return {
        ok: true,
        source: "chartixai",
        scan_type: a.scan_type,
        params_used: { scan_type: a.scan_type, limit: a.limit, ...a.params },
        count: Array.isArray(rows) ? rows.length : 0,
        fetched_at: res.fetched_at,
        data: res.data,
      };
    },
  },

  {
    name: "chartix_list_watchlist",
    description:
      "The symbols on the Chartix watchlist for the authenticated account. " +
      "Read this before adding anything, so a symbol the user already follows " +
      "is not added again, and use it to seed a screen when the user says " +
      '"my watchlist" without naming symbols. Read-only and cheap.',
    schema: z.object({}),
    handler: async (_args, ctx) => {
      const res = await ctx.client.get<unknown>(ENDPOINTS.watchlist.path);
      const rows = Array.isArray(res.data) ? res.data : [];
      return {
        ok: true,
        source: "chartixai",
        count: rows.length,
        fetched_at: res.fetched_at,
        items: rows,
      };
    },
  },

  {
    name: "chartix_add_to_watchlist",
    description:
      "Add symbols to the Chartix watchlist. This CHANGES the user's Chartix " +
      "account, so only call it when the user asked for it in those terms. " +
      "Resolve each symbol with chartix_list_symbols first; an unresolvable " +
      "symbol is reported rather than skipped silently.",
    schema: z.object({
      symbols: z.array(SymbolArg).min(1).max(50),
    }),
    handler: async (args, ctx) => {
      const { symbols } = args as { symbols: string[] };
      // 3000, not 5000: the endpoint is Query(50, le=3000) and anything above
      // that is a 422 rather than a clamp — this asked for 5000 and would have
      // failed on every call. The universe is slightly larger than the cap, so
      // anything missing from this page is resolved with a targeted search
      // below rather than reported as unknown.
      const known = await symbolIndex(ctx);
      const added: string[] = [];
      const failed: Array<{ symbol: string; error: string }> = [];
      for (const raw of symbols) {
        let sym: string;
        try {
          sym = resolveOne(raw, known).symbol;
        } catch (firstErr) {
          // Not on the first page. Ask Chartix directly before giving up —
          // a symbol past the 3000 cap is not a symbol that does not exist.
          try {
            const narrowed = await listInstruments(ctx, normalizeSymbol(raw), 50);
            sym = resolveOne(raw, narrowed).symbol;
          } catch (err) {
            failed.push({
              symbol: raw,
              error:
                err instanceof ChartixError
                  ? err.code
                  : firstErr instanceof ChartixError
                    ? firstErr.code
                    : "CHARTIX_SYMBOL_UNRESOLVED",
            });
            continue;
          }
        }
        try {
          await ctx.client.post<unknown>(ENDPOINTS.watchlist.path, { symbol: sym });
          added.push(sym);
        } catch (err) {
          failed.push({
            symbol: sym,
            error: err instanceof ChartixError ? err.code : "CHARTIX_UNAVAILABLE",
          });
        }
      }
      return { ok: true, source: "chartixai", added, failed };
    },
  },

  {
    name: "chartix_create_alert",
    description:
      "Create a Chartix price alert. This CHANGES the user's account. " +
      "Chartix can deliver alerts over Telegram, but Telegram linking is " +
      "behind EOD Pro; without it the alert still appears in the Chartix app.",
    schema: z.object({
      symbol: SymbolArg,
      alert_type: z.enum(["price_above", "price_below"]),
      target_price: z.number().positive(),
    }),
    handler: async (args, ctx) => {
      const a = args as {
        symbol: string;
        alert_type: string;
        target_price: number;
      };
      const sym = normalizeSymbol(a.symbol);
      const res = await ctx.client.post<unknown>(ENDPOINTS.alertRules.path, {
        symbol: sym,
        alert_type: a.alert_type,
        target_price: a.target_price,
      });
      return {
        ok: true,
        source: "chartixai",
        symbol: sym,
        created: res.data,
        fetched_at: res.fetched_at,
      };
    },
  },

  {
    name: "chartix_get_chart_url",
    description:
      "A deep link to the Chartix chart for a symbol. Use this whenever the " +
      "answer would benefit from a picture: return the link and let Chartix " +
      "draw it, rather than describing the chart in words or rendering your " +
      "own. Does not call the API and costs nothing.",
    schema: z.object({
      symbol: SymbolArg,
      timeframe: z.enum(["D", "W", "M"]).optional(),
    }),
    handler: async (args, ctx) => {
      const a = args as { symbol: string; timeframe?: string };
      const sym = normalizeSymbol(a.symbol);
      return {
        ok: true,
        source: "chartixai",
        symbol: sym,
        url: chartUrl(sym, {
          ...(a.timeframe !== undefined ? { timeframe: a.timeframe } : {}),
          site: ctx.siteUrl,
        }),
        note: "Opening it requires a signed-in Chartix account.",
      };
    },
  },
];
