/**
 * Error mapping. The point of the typed codes is that an agent can act on
 * them, so the distinctions have to be the real ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChartixError,
  ChartixErrorCode,
  classifyStatus,
  parseRetryAfter,
} from "../dist/chartix/errors.js";

test("401 is an auth failure", () => {
  assert.equal(classifyStatus(401, {}).code, ChartixErrorCode.AuthFailed);
});

test("a 403 carrying a required tier is a paywall, not a bad key", () => {
  // Chartix's tier middleware answers like this. An agent that reads it as
  // AuthFailed tells the user to re-authenticate forever.
  const got = classifyStatus(403, { detail: "eod_pro required for this data" });
  assert.equal(got.code, ChartixErrorCode.TierRequired);
  assert.equal(got.requiredTier, "eod_pro");
});

test("a 403 with an explicit required_tier field is read too", () => {
  const got = classifyStatus(403, { required_tier: "ai_eod_pro" });
  assert.equal(got.requiredTier, "ai_eod_pro");
});

test("a 403 that is just forbidden stays an auth failure", () => {
  assert.equal(
    classifyStatus(403, { detail: "Not permitted" }).code,
    ChartixErrorCode.AuthFailed,
  );
});

test("404, 429 and 5xx each map to their own code", () => {
  assert.equal(classifyStatus(404, {}).code, ChartixErrorCode.NotFound);
  assert.equal(classifyStatus(429, {}).code, ChartixErrorCode.RateLimited);
  assert.equal(classifyStatus(503, {}).code, ChartixErrorCode.Unavailable);
  assert.equal(classifyStatus(500, {}).code, ChartixErrorCode.Unavailable);
});

test("a 422 is a bad request, which must not be retried", () => {
  // FastAPI's validation failures are 422. Retrying one changes nothing.
  assert.equal(classifyStatus(422, {}).code, ChartixErrorCode.BadRequest);
});

test("Retry-After in seconds", () => {
  assert.equal(parseRetryAfter("30", Date.now()), 30);
});

test("Retry-After as an HTTP date", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const later = new Date(now + 45_000).toUTCString();
  assert.equal(parseRetryAfter(later, now), 45);
});

test("a Retry-After in the past is zero, never negative", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const past = new Date(now - 60_000).toUTCString();
  assert.equal(parseRetryAfter(past, now), 0);
});

test("a missing or unparseable Retry-After is undefined, not zero", () => {
  // Zero would mean "retry immediately", which is the opposite of what an
  // unreadable header should cause.
  assert.equal(parseRetryAfter(null, Date.now()), undefined);
  assert.equal(parseRetryAfter("soon please", Date.now()), undefined);
});

test("the error envelope carries no credential and reads as JSON", () => {
  const e = new ChartixError(ChartixErrorCode.TierRequired, "needs EOD Pro", {
    status: 403,
    endpoint: "/api/deals/recent",
    requiredTier: "eod_pro",
  });
  const json = JSON.stringify(e.toJSON());
  assert.match(json, /CHARTIX_TIER_REQUIRED/);
  assert.match(json, /eod_pro/);
  assert.doesNotMatch(json, /Bearer|Authorization/i);
  assert.equal(e.toJSON().ok, false);
});

test("optional fields are absent rather than null", () => {
  // A null endpoint in the envelope reads to a model as "there was no
  // endpoint", which is a different claim from "we did not record one".
  const json = new ChartixError(ChartixErrorCode.Unavailable, "down").toJSON();
  assert.equal("status" in json, false);
  assert.equal("required_tier" in json, false);
});
