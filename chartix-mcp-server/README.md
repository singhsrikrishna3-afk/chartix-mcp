# chartix-mcp-server

An MCP server over the Chartix REST API, so Quantcept (or any MCP client) can
ask Chartix for NSE bars, chart patterns, scans, watchlists and chart links.

## What this is built on

The brief this came from assumed ChartixAI publishes no API and that the
integration would therefore need ChartixAI's permission, or a scraper. Neither
is true here: **this repository is Chartix**, and the API is a FastAPI
application with 82 GET endpoints, JWT bearer auth and a tier middleware. Every
endpoint this server calls was read out of `backend/app/api/` and verified
against production on 15 October 2026, not guessed.

| Fact | Value |
| --- | --- |
| Base URL | `https://api.chartixai.com` |
| Auth | `Authorization: Bearer <JWT>`, HS256, from `POST /api/auth/login` |
| API keys | **None.** The only credential is a login JWT. |
| Rate limits | None published and **none enforced** — there is no limiter in the app |
| Daily bars | 8,397,044 — earliest `1991-01-02`, latest `2026-10-14` |
| Intraday | 2,461 symbols |
| Universe | 3,017 active NSE equities |
| Chart deep link | `https://chartixai.com/dashboard/charts?symbol=RELIANCE` |

### Three claims in the brief that the data does not support

1. **"8.3m daily bars since 1991."** The row count and the 1991 date are both
   real, but 1991-1995 holds about 260 bars a year — one index series, not the
   market. Per-stock coverage starts in 1996. `chartix_get_bars` says so and
   returns `history_floor` with every answer, because an agent asking for
   RELIANCE in 1993 should be told why it got nothing.
2. **"2,404 symbols with intraday."** 2,461 as of today.
3. **"the 15-minute data-delay caveat."** There is no 15-minute delay. EOD bars
   for the session land after the nightly sync (18:30 IST); intraday comes from
   a continuous tiered feeder (30/90/240s by symbol tier); the 15 minutes in
   Chartix is a *scan result cache*, which is a different thing. The skill file
   states the real freshness and every tool returns `as_of`.

## Credentials

Chartix has no API-key mechanism. `CHARTIX_TOKEN` is a login JWT, and it
expires — seven days unless the deployment sets `ACCESS_TOKEN_EXPIRE_MINUTES`.
The client reads the env var per request rather than capturing it at startup, so
a token can be rotated without a restart, but **something still has to rotate
it**. For anything beyond local use, Chartix needs an API-key or
service-account mechanism it does not have today; that is the first item in
`../OPEN-QUESTIONS.md`.

## Hosting

The default bind is `127.0.0.1`, and that is a decision rather than caution.

A Quantcept *website* connector needs a public `https://` MCP URL. This
process holds a Chartix credential — a login JWT carrying that user's full
authority, **including writes** (watchlists, alerts). Anyone who can reach an
exposed instance acts as that user. That alone is the reason for the loopback
default.

Paid data is gated at the API now: `/api/instruments/{symbol}/intraday`
requires `eod_pro` server-side, and a free or `eod_basic` account is refused.
It was not always so — the tier middleware matched path *prefixes*, and the
symbol sits in the middle of that route, so nothing reached it while the web UI
paywalled intraday on the client alone. `chartix_get_bars` still defaults to
daily and makes intraday an explicit argument, which remains the right default
for an agent.

Before setting `HOST=0.0.0.0`: put it behind auth. The credential, not the
data, is what an exposed instance leaks — paid routes are gated at the API.

## Install

### Quantcept terminal, locally (no public URL needed)

```bash
npm ci && npm run build
export CHARTIX_TOKEN="$(curl -s -X POST https://api.chartixai.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
npm start
```

Then point the terminal's `/mcp` at `http://127.0.0.1:8420/`.

Prefer a non-admin account: the JWT carries that user's full authority,
writes included, and this process holds it for its whole lifetime.

(Working inside the Chartix monorepo, `backend/scripts/mint_mcp_token.py`
prints a token and nothing else to stdout, so `$(...)` captures it cleanly.
That script is not part of this package.)

### Quantcept website connector (needs a public https URL)

Deploy the container, then add the fields from `../quantcept/connector.json`
under **Settings → Connectors → Add custom connector**. Streamable HTTP.

Note: Quantcept pauses connectors and custom skills when a 30-day pass ends.
They are not deleted and come back when a new pass is bought.

## Environment

See `.env.example`. Names only; no values are committed.

## Tools

| Tool | Chartix endpoint | Tier needed |
| --- | --- | --- |
| `chartix_list_symbols` | `/api/instruments/` | free |
| `chartix_get_bars` | `/api/instruments/{symbol}/eod` or `/intraday` | free |
| `chartix_get_patterns` | `/api/screener/patterns` | EOD Basic |
| `chartix_patterns_why_empty` | `/api/screener/patterns/why-empty` | EOD Basic |
| `chartix_run_screen` | `/api/scans/other`, `/api/scanners/{id}` | EOD Basic / EOD Pro |
| `chartix_list_watchlist` | `/api/watchlist/` | free |
| `chartix_add_to_watchlist` | `/api/watchlist/` | free |
| `chartix_create_alert` | `/api/alerts/rules` | free (Telegram delivery: EOD Pro) |
| `chartix_get_chart_url` | none — builds a URL | free |

A paywalled endpoint returns `CHARTIX_TIER_REQUIRED` with the tier named, which
is deliberately a different code from `CHARTIX_AUTH_FAILED`: an agent that
cannot tell "your key is wrong" from "this costs more" will tell the user to
re-authenticate forever.

## Tests

```bash
npm test          # builds, then runs the suite. No network, no credential.
```

The live contract test is skipped unless `CHARTIX_LIVE=1` and `CHARTIX_TOKEN`
are both set. It has been run against production: RELIANCE daily bars came back
chronological, OHLC-consistent, with a parseable `as_of`.

## What is deliberately not here

- **No broker orders, no trading, no withdrawal keys.** Research tooling only.
- **No headless-browser fallback.** There is an API; scraping the authenticated
  UI would be worse in every respect.
