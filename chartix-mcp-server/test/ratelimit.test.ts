/**
 * The limiter, against a fake clock. Chartix enforces no limits, so this
 * exists to protect a one-OCPU box from an agent that decides to fetch the
 * Nifty 500 in a single turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RateLimiter,
  backoffMs,
  isRetryable,
  type Clock,
} from "../dist/chartix/ratelimit.js";

function fakeClock(): Clock & { advance(ms: number): void; t: number } {
  const state = {
    t: 1_000_000,
    now() {
      return state.t;
    },
    async sleep(ms: number) {
      state.t += ms;
    },
    advance(ms: number) {
      state.t += ms;
    },
  };
  return state as Clock & { advance(ms: number): void; t: number };
}

test("a cold limiter does not make the first caller wait", async () => {
  const clock = fakeClock();
  const l = new RateLimiter({ rpm: 60, concurrency: 4, clock });
  const before = clock.t;
  await l.run(async () => "ok");
  assert.equal(clock.t, before);
});

test("the bucket empties and then paces", async () => {
  const clock = fakeClock();
  const l = new RateLimiter({ rpm: 60, concurrency: 10, clock });
  for (let i = 0; i < 60; i += 1) await l.run(async () => i);
  const afterBurst = clock.t;
  assert.equal(afterBurst, 1_000_000, "the first 60 are free");
  await l.run(async () => "one more");
  assert.ok(clock.t > afterBurst, "the 61st had to wait");
  assert.ok(clock.t - afterBurst <= 1_100, "waited about one second, not a minute");
});

test("tokens refill over time", async () => {
  const clock = fakeClock();
  const l = new RateLimiter({ rpm: 60, concurrency: 4, clock });
  for (let i = 0; i < 60; i += 1) await l.run(async () => i);
  assert.equal(l.snapshot().tokens, 0);
  clock.advance(30_000);
  assert.equal(l.snapshot().tokens, 30);
});

test("the bucket never exceeds its capacity", async () => {
  const clock = fakeClock();
  const l = new RateLimiter({ rpm: 60, concurrency: 4, clock });
  clock.advance(10 * 60_000);
  assert.equal(l.snapshot().tokens, 60);
});

test("concurrency is capped and every slot is released", async () => {
  const clock = fakeClock();
  const l = new RateLimiter({ rpm: 10_000, concurrency: 2, clock });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      l.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setImmediate(r));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(l.snapshot().active, 0, "a leaked slot deadlocks the server");
});

test("a throwing call still releases its slot", async () => {
  const l = new RateLimiter({ rpm: 10_000, concurrency: 1, clock: fakeClock() });
  await assert.rejects(l.run(async () => {
    throw new Error("boom");
  }));
  await l.run(async () => "still works");
  assert.equal(l.snapshot().active, 0);
});

test("nonsense configuration is refused at construction", () => {
  assert.throws(() => new RateLimiter({ rpm: 0, concurrency: 1 }));
  assert.throws(() => new RateLimiter({ rpm: 60, concurrency: 0 }));
  assert.throws(() => new RateLimiter({ rpm: 60, concurrency: 1.5 }));
});

test("backoff grows and is capped", () => {
  const one = () => 1;
  assert.equal(backoffMs(1, 400, 8_000, one), 400);
  assert.equal(backoffMs(2, 400, 8_000, one), 800);
  assert.equal(backoffMs(6, 400, 8_000, one), 8_000);
  assert.equal(backoffMs(20, 400, 8_000, one), 8_000);
});

test("jitter spreads a simultaneous batch instead of synchronising it", () => {
  // Without jitter, twenty symbol requests that 429 together retry together
  // and 429 together again.
  const lo = backoffMs(3, 400, 8_000, () => 0);
  const hi = backoffMs(3, 400, 8_000, () => 1);
  assert.ok(lo < hi);
  assert.equal(lo, 800);
  assert.equal(hi, 1600);
});

test("only 429 and 5xx are retried", () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(401), false);
  assert.equal(isRetryable(403), false);
  assert.equal(isRetryable(404), false);
  assert.equal(isRetryable(422), false);
  assert.equal(isRetryable(undefined), true, "a network failure is worth a retry");
});
