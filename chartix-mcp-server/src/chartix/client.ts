/**
 * The only place in this server that speaks HTTP to Chartix.
 *
 * Every tool goes through here, so retries, rate limiting, error mapping,
 * freshness stamping and credential handling exist once and are testable once.
 */
import {
  ChartixError,
  ChartixErrorCode,
  classifyStatus,
  parseRetryAfter,
} from "./errors.js";
import {
  RateLimiter,
  backoffMs,
  isRetryable,
  systemClock,
  type Clock,
} from "./ratelimit.js";
import { CHARTIX_DEFAULT_BASE_URL } from "./catalog.js";
import { isAllowedHost, scrubPayload } from "./trust.js";

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ClientOptions {
  readonly baseUrl?: string;
  /**
   * Resolved lazily so a long-lived process can be handed a fresh credential
   * without a restart. Chartix issues login JWTs, not API keys, and they
   * expire — see README "Credentials".
   */
  readonly token: () => string | undefined;
  readonly rpm?: number;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  readonly fetcher?: Fetcher;
  readonly random?: () => number;
  readonly log?: (entry: LogEntry) => void;
}

export interface LogEntry {
  readonly request_id: string;
  readonly endpoint: string;
  readonly status?: number;
  readonly latency_ms: number;
  readonly attempt: number;
  readonly outcome: "ok" | "retry" | "error";
  readonly error?: ChartixErrorCode;
  /** §11: free-text fields altered, and of those, refused outright. */
  readonly scrubbed?: number;
  readonly refused?: number;
}

export interface Fresh<T> {
  readonly ok: true;
  /** When THIS server received the answer. Not when Chartix computed it. */
  readonly fetched_at: string;
  /**
   * The newest datum in the payload, when the payload says. Null when the
   * endpoint carries no timestamp — stated as null rather than guessed, so a
   * caller never presents our clock as the data's age.
   */
  readonly as_of: string | null;
  readonly source: "chartixai";
  readonly endpoint: string;
  readonly data: T;
}

let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `cx-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class ChartixClient {
  private readonly baseUrl: string;
  private readonly token: () => string | undefined;
  private readonly limiter: RateLimiter;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly fetcher: Fetcher;
  private readonly random: () => number;
  private readonly log: (entry: LogEntry) => void;

  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? CHARTIX_DEFAULT_BASE_URL).replace(/\/+$/, "");
    // §11: only allowlisted hosts, checked once at construction rather than
    // per request. CHARTIX_EXTRA_HOSTS exists for a local dev API and is an
    // explicit opt-in, not a wildcard.
    const extra = (process.env.CHARTIX_EXTRA_HOSTS ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    if (!isAllowedHost(this.baseUrl, [...extra, "127.0.0.1", "localhost"])) {
      throw new Error(
        `Refusing to talk to ${this.baseUrl}: not an allowlisted Chartix host. ` +
        `Set CHARTIX_EXTRA_HOSTS to permit another one deliberately.`,
      );
    }
    this.token = opts.token;
    this.clock = opts.clock ?? systemClock;
    this.limiter = new RateLimiter({
      rpm: opts.rpm ?? 60,
      concurrency: opts.concurrency ?? 4,
      clock: this.clock,
    });
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? (() => {});
  }

  /** GET a JSON endpoint, wrapped with freshness. */
  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    asOfFrom?: (data: T) => string | null,
  ): Promise<Fresh<T>> {
    const data = await this.request<T>("GET", path, query);
    return {
      ok: true,
      fetched_at: new Date(this.clock.now()).toISOString(),
      as_of: asOfFrom ? asOfFrom(data) : null,
      source: "chartixai",
      endpoint: path,
      data,
    };
  }

  async post<T>(
    path: string,
    body: unknown,
    asOfFrom?: (data: T) => string | null,
  ): Promise<Fresh<T>> {
    const data = await this.request<T>("POST", path, {}, body);
    return {
      ok: true,
      fetched_at: new Date(this.clock.now()).toISOString(),
      as_of: asOfFrom ? asOfFrom(data) : null,
      source: "chartixai",
      endpoint: path,
      data,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const token = this.token();
    if (!token) {
      throw new ChartixError(
        ChartixErrorCode.AuthFailed,
        "No Chartix credential available. Set CHARTIX_TOKEN to a JWT from " +
          "POST /api/auth/login. Chartix issues no API keys.",
        { endpoint: path },
      );
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const requestId = nextRequestId();
    let lastError: ChartixError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = this.clock.now();
      let status: number | undefined;
      try {
        const res = await this.limiter.run(() => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          const headers: Record<string, string> = {
            // The credential never appears in a log line, an error message or
            // a thrown object — only here.
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": "chartix-mcp-server/0.1",
          };
          const init: Parameters<Fetcher>[1] = {
            method,
            headers,
            signal: controller.signal,
          };
          if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(body);
          }
          return this.fetcher(url.toString(), init).finally(() =>
            clearTimeout(timer),
          );
        });
        status = res.status;
        const raw = await res.text();
        const parsed = raw.length > 0 ? safeJson(raw) : undefined;

        if (res.status >= 200 && res.status < 300) {
          // §11: everything Chartix returns is data, never instruction. Free
          // text is scrubbed HERE, once, before any tool or model sees it —
          // doing it per-tool means the next tool forgets.
          const { report } = scrubPayload(parsed);
          this.log({
            request_id: requestId,
            endpoint: path,
            status,
            latency_ms: this.clock.now() - started,
            attempt,
            outcome: "ok",
            ...(report.altered > 0 ? { scrubbed: report.altered } : {}),
            ...(report.refused > 0 ? { refused: report.refused } : {}),
          });
          return parsed as T;
        }

        const { code, requiredTier } = classifyStatus(res.status, parsed);
        const retryAfterS = parseRetryAfter(
          res.headers.get("retry-after"),
          this.clock.now(),
        );
        lastError = new ChartixError(code, describe(code, res.status, parsed), {
          status: res.status,
          endpoint: path,
          ...(retryAfterS !== undefined ? { retryAfterS } : {}),
          ...(requiredTier !== undefined ? { requiredTier } : {}),
        });
      } catch (err) {
        if (err instanceof ChartixError) throw err;
        lastError = new ChartixError(
          ChartixErrorCode.Unavailable,
          `Chartix did not answer: ${(err as Error).name}`,
          { endpoint: path },
        );
      }

      const retryable = isRetryable(status);
      const more = attempt < this.maxAttempts;
      this.log({
        request_id: requestId,
        endpoint: path,
        ...(status !== undefined ? { status } : {}),
        latency_ms: this.clock.now() - started,
        attempt,
        outcome: retryable && more ? "retry" : "error",
        ...(lastError ? { error: lastError.code } : {}),
      });
      if (!retryable || !more) break;

      // Honour Retry-After when the server gave one; it knows better than our
      // exponential guess.
      const wait =
        lastError?.retryAfterS !== undefined
          ? lastError.retryAfterS * 1000
          : backoffMs(attempt, 400, 8_000, this.random);
      await this.clock.sleep(wait);
    }

    throw (
      lastError ??
      new ChartixError(ChartixErrorCode.Unavailable, "Request failed", {
        endpoint: path,
      })
    );
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Chartix answers JSON everywhere; HTML here means a proxy or an error
    // page, so keep a short excerpt for the log and no more.
    return { detail: raw.slice(0, 200) };
  }
}

/**
 * FastAPI's validation errors arrive as a LIST of objects, so String() on them
 * yields "[object Object]" — which is what an agent would be told the problem
 * was. Rendered field-by-field instead.
 */
function renderDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d !== "object" || d === null) return String(d);
        const bag = d as Record<string, unknown>;
        const loc = Array.isArray(bag.loc)
          ? bag.loc.filter((x) => x !== "query" && x !== "body").join(".")
          : "";
        const msg = String(bag.msg ?? "invalid");
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    const bag = detail as Record<string, unknown>;
    return String(bag.msg ?? bag.message ?? JSON.stringify(bag).slice(0, 160));
  }
  return "";
}

function describe(
  code: ChartixErrorCode,
  status: number,
  body: unknown,
): string {
  const detail =
    typeof body === "object" && body !== null
      ? renderDetail((body as Record<string, unknown>).detail)
      : "";
  switch (code) {
    case ChartixErrorCode.AuthFailed:
      return `Chartix rejected the credential (HTTP ${status}). The token may have expired; Chartix JWTs are short-lived.`;
    case ChartixErrorCode.TierRequired:
      return `This data is behind a paid Chartix tier (HTTP ${status})${detail ? `: ${detail}` : ""}.`;
    case ChartixErrorCode.RateLimited:
      return `Chartix asked us to slow down (HTTP ${status}).`;
    case ChartixErrorCode.NotFound:
      return `Chartix has no such resource (HTTP ${status}).`;
    case ChartixErrorCode.BadRequest:
      return `Chartix refused the request (HTTP ${status})${detail ? `: ${detail}` : ""}.`;
    case ChartixErrorCode.SymbolUnresolved:
    case ChartixErrorCode.SymbolChanged:
    case ChartixErrorCode.StaleImport:
      // Raised by us, never mapped from a status. If one arrives here the
      // mapping has drifted, and a wrong-but-plausible sentence would hide it.
      return `${code} (HTTP ${status})${detail ? `: ${detail}` : ""}.`;
    default:
      return `Chartix is unavailable (HTTP ${status}).`;
  }
}

const defaultFetcher: Fetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<Fetcher>;
