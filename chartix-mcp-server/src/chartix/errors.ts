/**
 * Typed failures. A tool never returns prose on error and never invents a
 * number when Chartix is unhappy — the caller is a language model, and a
 * plausible-looking fabricated bar is worse than a refusal it can read.
 */

export const ChartixErrorCode = {
  Unavailable: "CHARTIX_UNAVAILABLE",
  AuthFailed: "CHARTIX_AUTH_FAILED",
  RateLimited: "CHARTIX_RATE_LIMITED",
  NotFound: "CHARTIX_NOT_FOUND",
  /**
   * Distinct from AuthFailed on purpose. The credential is valid; the account
   * simply is not on a tier that includes this data. Chartix's middleware
   * answers 403 with an upgrade message, and an agent that cannot tell "your
   * key is wrong" from "this costs more" will tell the user to re-authenticate
   * forever.
   */
  TierRequired: "CHARTIX_TIER_REQUIRED",
  BadRequest: "CHARTIX_BAD_REQUEST",
  /**
   * §8: a symbol we could not resolve through any spelling. Distinct from
   * NotFound, which means Chartix looked and has nothing — this means we
   * never got as far as asking, and the candidates we tried are in the
   * message so the caller can see why.
   */
  SymbolUnresolved: "CHARTIX_SYMBOL_UNRESOLVED",
  /**
   * §9: the instrument exists under a different NSE ticker now. Returned
   * instead of a short series, because a renamed symbol that quietly yields
   * two years of history reads as a data gap rather than a rename.
   */
  SymbolChanged: "CHARTIX_SYMBOL_CHANGED",
  /** §10: a file import older than the one already stored. */
  StaleImport: "STALE_IMPORT",
} as const;

export type ChartixErrorCode =
  (typeof ChartixErrorCode)[keyof typeof ChartixErrorCode];

export interface ChartixErrorShape {
  readonly ok: false;
  readonly error: ChartixErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly endpoint?: string;
  readonly retry_after_s?: number;
  readonly required_tier?: string;
}

export class ChartixError extends Error {
  readonly code: ChartixErrorCode;
  readonly status?: number;
  readonly endpoint?: string;
  readonly retryAfterS?: number;
  readonly requiredTier?: string;

  constructor(
    code: ChartixErrorCode,
    message: string,
    extra: {
      status?: number;
      endpoint?: string;
      retryAfterS?: number;
      requiredTier?: string;
    } = {},
  ) {
    super(message);
    this.name = "ChartixError";
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.endpoint !== undefined) this.endpoint = extra.endpoint;
    if (extra.retryAfterS !== undefined) this.retryAfterS = extra.retryAfterS;
    if (extra.requiredTier !== undefined) this.requiredTier = extra.requiredTier;
  }

  toJSON(): ChartixErrorShape {
    const out: Record<string, unknown> = {
      ok: false,
      error: this.code,
      message: this.message,
    };
    if (this.status !== undefined) out.status = this.status;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.retryAfterS !== undefined) out.retry_after_s = this.retryAfterS;
    if (this.requiredTier !== undefined) out.required_tier = this.requiredTier;
    return out as unknown as ChartixErrorShape;
  }
}

/** Seconds to wait, from a Retry-After that may be a delay or an HTTP date. */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  // A date in the past means "now"; never return a negative wait.
  return Math.max(0, Math.round((when - nowMs) / 1000));
}

/**
 * HTTP status to a typed code.
 *
 * 403 is the interesting one: Chartix's tier middleware and a genuinely
 * forbidden request both use it, so the body decides. The middleware's payload
 * carries the required tier.
 */
export function classifyStatus(
  status: number,
  body: unknown,
): { code: ChartixErrorCode; requiredTier?: string } {
  if (status === 401) return { code: ChartixErrorCode.AuthFailed };
  if (status === 403) {
    const tier = requiredTierFrom(body);
    return tier === undefined
      ? { code: ChartixErrorCode.AuthFailed }
      : { code: ChartixErrorCode.TierRequired, requiredTier: tier };
  }
  if (status === 404) return { code: ChartixErrorCode.NotFound };
  if (status === 429) return { code: ChartixErrorCode.RateLimited };
  if (status >= 500) return { code: ChartixErrorCode.Unavailable };
  if (status >= 400) return { code: ChartixErrorCode.BadRequest };
  return { code: ChartixErrorCode.Unavailable };
}

function requiredTierFrom(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const bag = body as Record<string, unknown>;
  const direct = bag.required_tier ?? bag.requiredTier;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const detail = bag.detail;
  if (typeof detail === "object" && detail !== null) {
    const inner = (detail as Record<string, unknown>).required_tier;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  if (typeof detail === "string") {
    const m = /\b(free|eod_basic|eod_pro|ai_eod_pro)\b/.exec(detail);
    if (m?.[1]) return m[1];
  }
  return undefined;
}
