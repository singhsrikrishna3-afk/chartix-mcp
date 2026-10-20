/**
 * Telling "down" apart from "no data" (§13).
 *
 * The distinction is the whole point. A tool that returns nothing because
 * Chartix is unreachable and a tool that returns nothing because the filter
 * genuinely matched nothing look identical to the caller, and this project has
 * already been bitten by exactly that twice: an empty Pattern Screener that
 * said "try adjusting filters" when the shapes had no detector, and a delivery
 * dataset that reported "ok" for weeks while two of every three sessions were
 * missing.
 */
export type SourceMode = "network" | "file";

export interface HealthState {
  readonly version: string;
  mode: SourceMode;
  chartixReachable: boolean | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  symbolsIndexed: number;
  dataAsOf: string | null;
  staleResponses: number;
  symbolsServed: number;
}

export function newHealth(version: string, mode: SourceMode): HealthState {
  return {
    version,
    mode,
    // null, not false: "we have not asked yet" is a third state, and starting
    // at false makes a freshly booted server look broken on its first scrape.
    chartixReachable: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    symbolsIndexed: 0,
    dataAsOf: null,
    staleResponses: 0,
    symbolsServed: 0,
  };
}

export function recordSuccess(h: HealthState, at: string, asOf?: string | null): void {
  h.chartixReachable = true;
  h.lastSuccessAt = at;
  if (asOf) h.dataAsOf = asOf;
}

export function recordFailure(h: HealthState, at: string, code: string): void {
  // A tier paywall or an unknown symbol is Chartix answering correctly, so it
  // must not mark the dependency unreachable — otherwise a free account
  // browsing paid data turns the health endpoint red.
  const reachable = code !== "CHARTIX_UNAVAILABLE";
  h.chartixReachable = reachable ? true : false;
  h.lastErrorAt = at;
  h.lastErrorCode = code;
}

export function healthz(h: HealthState): Record<string, unknown> {
  return {
    status: h.chartixReachable === false ? "degraded" : "ok",
    version: h.version,
    source_mode: h.mode,
    chartix_reachable: h.chartixReachable,
    last_success_at: h.lastSuccessAt,
    last_error_at: h.lastErrorAt,
    last_error_code: h.lastErrorCode,
    symbols_indexed: h.symbolsIndexed,
    data_as_of: h.dataAsOf,
    chart_symbols_served_total: h.symbolsServed,
    chart_stale_responses_total: h.staleResponses,
  };
}

/**
 * Ready means the symbol index is loaded (§13) — until then a resolve would
 * answer CHARTIX_SYMBOL_UNRESOLVED for symbols that exist, which is worse than
 * refusing traffic.
 */
export function readyz(h: HealthState): { ready: boolean; body: Record<string, unknown> } {
  const ready = h.symbolsIndexed > 0;
  return {
    ready,
    body: {
      ready,
      reason: ready ? null : "symbol index not loaded yet",
      symbols_indexed: h.symbolsIndexed,
      source_mode: h.mode,
    },
  };
}

/** §13's log line. The key is never here; nor is a payload body. */
export interface StructuredLog {
  ts: string;
  level: "info" | "warn" | "error";
  request_id: string;
  tool?: string;
  symbol?: string;
  endpoint?: string;
  status?: number;
  latency_ms?: number;
  source_mode: SourceMode;
  error_code?: string;
  scrubbed_fields?: number;
}

export function logLine(entry: StructuredLog): string {
  return JSON.stringify(entry);
}

/** An inbound x-request-id is propagated; otherwise one is minted. */
export function requestId(incoming: string | string[] | undefined): string {
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  if (typeof raw === "string") {
    // Bounded and sanitised: this value is echoed back and written to logs,
    // so an unbounded header is a log-injection vector.
    const clean = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
    if (clean.length >= 8) return clean;
  }
  return `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
