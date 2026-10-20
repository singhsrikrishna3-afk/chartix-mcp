---
name: chartix-quantcept-bridge
description: Use Chartix for NSE price action — bars, chart patterns with Chartix's own backtested win rates, and scans — and combine it with Quantcept's fundamentals without blending the attribution. Covers which source owns which claim, why `confidence` is not a win rate, how to state data freshness truthfully, and when to hand the user a Chartix chart instead of describing one.
---

# Chartix + Quantcept

Chartix supplies price action for NSE equities. Quantcept supplies fundamentals,
valuation and monitoring. This skill is about keeping them apart in the answer
even while using them together.

## Which source owns which claim

| Claim | Owner |
| --- | --- |
| OHLCV bars, delivery volume, bulk/block deals, promoter and FII holdings | Chartix |
| Detected chart patterns, and Chartix's backtested win rate where it has one | **Chartix** |
| Scan and screener results, and the parameters that produced them | Chartix |
| P/E, ROE, margins, revenue growth, valuation | Quantcept |
| Portfolio, benchmark and monitoring | Quantcept |

In a table, label the column with its source. Never present a blended figure.

## Chartix's win rates are Chartix's, and you only get them one way

**Which figure you get depends on how you call the tool.**

- `chartix_get_patterns` **without** `symbol` returns the market-wide list.
  Those rows have **no win rate** — they carry `confidence`. The tool says so
  in `win_rate_available: false`.
- `chartix_get_patterns` **with** `symbol` returns that stock's patterns joined
  to Chartix's backtest, and those rows carry `win_rate`.

`confidence` is **not** a win rate and must never be reported as one. It is
Chartix's quality figure: a backtested shape keeps its measured rate, a merely
geometric fit is discounted, and 0.45 is the floor below which Chartix hides a
pattern. Quoting `confidence` as "a 49% win rate" is the single most likely
mistake here, and it would be a fabricated statistic.

Where `win_rate` is present:

- Quote it **verbatim** and attribute it: "Chartix's backtest puts this at 49%."
- Do **not** recompute, re-round, re-describe or average it.
- Do **not** say "my analysis shows" or "the pattern wins 49% of the time" as
  if it were your own finding, or an established fact about the market.

Where `win_rate` is **null**, say so. Chartix's join requires at least 20
samples and returns null rather than an optimistic number when a shape has too
little history. A null is a real answer — "Chartix has not measured this one" —
and must not be filled in with an estimate.

**Chartix exposes no sample size through its API.** Do not state one, and do
not infer one. If a user asks how many samples a win rate is based on, say that
Chartix does not publish it through this interface.

## An empty pattern result is information

Chartix gates patterns on measured win rate: a backtested shape is judged on
its real figure, a merely geometric fit is discounted and most fall below the
bar. So an empty result usually means "found, and deliberately hidden", not
"nothing there".

When `chartix_get_patterns` returns nothing, call
`chartix_patterns_why_empty` before saying anything to the user. It answers
with one of four reasons:

- `below_gate` — found, but under the quality gate. Say how many and what the
  measured rate was. Do not advise loosening the filter without saying that the
  gate exists because the pattern wins less than half the time.
- `not_detected` — Chartix implements 15 pattern shapes and this is not one of
  them. The filter will **always** be empty. Say so; do not suggest retrying.
- `none_found` — genuinely nothing matched. This is the only case where
  "try a different filter" is sound advice.
- `filtered_elsewhere` — found and above the gate, excluded by a liquidity floor
  or the one-row-per-stock cap. Not the confidence setting.

Telling a user to "adjust the filters" is wrong in three of those four cases.

## Freshness — state it, do not guess it

Every Chartix tool returns `as_of` and `fetched_at`. They are different things:
`fetched_at` is when this bridge got the answer, `as_of` is the newest datum in
it. Quote `as_of`. Where `as_of` is `null`, the endpoint carried no timestamp —
say that rather than substituting `fetched_at`, which would present our clock
as the data's age.

The honest picture:

- **Daily bars** are end-of-day. The session's bar is written after Chartix's
  nightly sync (about 18:30 IST), so during market hours the newest daily bar
  is **yesterday's**.
- **Intraday bars** come from a continuous feeder and are near-live, not
  delayed by a fixed window.
- **Scan results** may be served from a 15-minute cache. That is a cache, not a
  market-data delay — do not describe it as one.

Never present any of it as a live quote, and never answer "what is the price
right now" from a daily bar.

## History floor

Bars exist from 1991-01-02, but only for a single index series. Per-stock
coverage begins in **1996**. A request for equity history before 1996 comes
back short, and that is the floor of the data, not an error and not a gap. Do
not report it as missing data or retry it.

## Let Chartix draw the chart

When the answer would be clearer as a picture, call `chartix_get_chart_url` and
give the user the link. Chartix is the charting product; rendering your own
chart of its data, or describing the shape in prose, is strictly worse. Opening
the link needs a signed-in Chartix account.

## Typical procedure

A request like *"NSE stocks where Chartix shows a high-win-rate pattern and the
fundamentals are cheap"*:

1. `chartix_get_patterns` with the timeframe asked for. If empty, go to
   `chartix_patterns_why_empty` and report that instead — do not substitute a
   different screen and present it as the answer.
2. Take the symbols and get Quantcept's fundamentals for them.
3. Intersect. Build one table, each column labelled with its source, and the
   win rate column labelled as Chartix's backtest. Leave it blank where
   Chartix returned null rather than guessing a figure.
4. Add `chartix_get_chart_url` links for the names that survive.
5. State `as_of` for the Chartix side and the fundamentals' own period for the
   Quantcept side. They are rarely the same date, and saying so is the point.

Batch the symbols into one turn. Quantcept bills per answer, so a per-symbol
loop costs the user real credits for no extra information.

## What this does not do

No orders, no trading, no broker keys. Chartix's paid tiers gate scanners,
patterns and the institutional-footprint data: a `CHARTIX_TIER_REQUIRED` error
means the account needs an upgrade, **not** that the credential is wrong, and
must not be reported as a login problem.
