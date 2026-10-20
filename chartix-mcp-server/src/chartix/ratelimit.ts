/**
 * A token bucket plus a concurrency gate.
 *
 * Chartix publishes no rate limits and enforces none — there is no limiter
 * middleware in the FastAPI app. So this is not here to satisfy a documented
 * quota; it is here because the API runs on a single-OCPU box with two uvicorn
 * workers, several of its endpoints walk a 3,000-instrument universe in pandas,
 * and an agent that decides to fetch bars for the whole Nifty 500 in one turn
 * would be a self-inflicted outage. The limits protect Chartix from us.
 *
 * The clock is injectable because the alternative is a test suite that sleeps.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface LimiterOptions {
  /** Requests per minute. */
  readonly rpm: number;
  /** Simultaneous in-flight requests. */
  readonly concurrency: number;
  readonly clock?: Clock;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly concurrency: number;
  private readonly clock: Clock;

  private tokens: number;
  private lastRefill: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: LimiterOptions) {
    if (!Number.isFinite(opts.rpm) || opts.rpm <= 0) {
      throw new Error("rpm must be a positive number");
    }
    if (!Number.isInteger(opts.concurrency) || opts.concurrency <= 0) {
      throw new Error("concurrency must be a positive integer");
    }
    this.capacity = opts.rpm;
    this.refillPerMs = opts.rpm / 60_000;
    this.concurrency = opts.concurrency;
    this.clock = opts.clock ?? systemClock;
    // Start full: a cold process should not make the first caller wait.
    this.tokens = opts.rpm;
    this.lastRefill = this.clock.now();
  }

  /** For assertions and for the diagnostic tool. */
  snapshot(): { tokens: number; active: number; queued: number } {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      active: this.active,
      queued: this.queue.length,
    };
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
  }

  private async takeToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      // Round up: sleeping the exact fractional wait can wake a hair early and
      // spin. One extra millisecond costs nothing and makes the loop terminate.
      await this.clock.sleep(Math.ceil(deficit / this.refillPerMs) + 1);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Run fn under both gates. Always releases, including on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.takeToken();
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}

/**
 * Backoff for attempt n (1-based), with full jitter.
 *
 * Jitter is not decoration: without it, a batch of symbol requests that all hit
 * a 429 together retries in lockstep and 429s together again.
 */
export function backoffMs(
  attempt: number,
  baseMs = 400,
  capMs = 8_000,
  random: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + 0.5 * random()));
}

/** Only 429 and 5xx are worth retrying; a 400 will be a 400 next time too. */
export function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  return status === 429 || status >= 500;
}
