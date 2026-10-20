# Chartix MCP

An [MCP](https://modelcontextprotocol.io) server over the
[ChartixAI](https://chartixai.com) API: NSE equity bars, chart patterns with
Chartix's own backtested win rates, screener runs, watchlists, alerts and chart
deep links — as nine tools an agent can call.

```
chartix-mcp-server/   the server (npm: chartix-mcp-server)
quantcept-plugin/     the same server packaged as a Quantcept plugin
quantcept/            the attribution skill, and a website-connector template
```

## Install

Any MCP client that spawns a stdio server:

```json
{
  "mcpServers": {
    "chartix": {
      "command": "npx",
      "args": ["-y", "chartix-mcp-server", "stdio"],
      "env": { "CHARTIX_TOKEN": "<your Chartix JWT>" }
    }
  }
}
```

For Quantcept:

```bash
quantcept plugin marketplace add github:singhsrikrishna3-afk/chartix-mcp
quantcept plugin install chartix@chartix
```

That works the day this repo is public — Quantcept lets you add any
marketplace, so it does not wait on the official one. Once the entry in
`MARKETPLACE-ENTRY.json` is merged into
`Fincept-Corporation/quantcept-marketplace`, `chartix@quantcept-marketplace`
works too, from the marketplace Quantcept ships with.

Then set the credential (see below) and restart the terminal. `quantcept
plugin validate` checks a plugin directory and exits non-zero on failure.

## You need a Chartix credential

Chartix issues **no API keys**. The credential is a login JWT from
`POST /api/auth/login`, and it expires.

```bash
export CHARTIX_TOKEN="$(curl -s -X POST https://api.chartixai.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
```

That token carries your **full account authority, writes included** — adding
watchlist entries and creating alerts are among the nine tools. Treat it as a
password, and read "Hosting" in
[chartix-mcp-server/README.md](chartix-mcp-server/README.md) before putting an
instance on a public URL.

## The tools

| Tool | Returns |
| --- | --- |
| `chartix_list_symbols` | the NSE universe Chartix tracks |
| `chartix_get_bars` | OHLCV, daily through intraday |
| `chartix_get_patterns` | detected patterns; **with `symbol`, the backtested win rate** |
| `chartix_patterns_why_empty` | why a pattern query returned nothing |
| `chartix_run_screen` | a screener run, and the parameters that produced it |
| `chartix_list_watchlist` / `chartix_add_to_watchlist` | the watchlist |
| `chartix_create_alert` | a price or indicator alert |
| `chartix_get_chart_url` | a link to the chart, rather than prose about it |

Two things the replies state outright, because an agent gets them wrong
otherwise: the market-wide pattern list carries `confidence`, which is **not** a
win rate (`win_rate_available: false` says so), and a `null` win rate means
fewer than 20 backtested samples — never fill one in with an estimate.

### Without a credential

Pattern data can come from a CSV export instead of the API — no token, no
network:

```
npx chartix-mcp-server stdio --source=file --file=./export.csv
```

Header must be exactly
`symbol,pattern,win_rate,sample_size,date_range,chart_url,as_of`. In this mode
`chartix_get_patterns` answers from the file and every other tool reports that
it needs the network: it degrades loudly, not silently.

## Developing

```bash
cd chartix-mcp-server
npm ci && npm test        # 156 tests, no network, no credential
npm run bundle            # regenerates quantcept-plugin/mcp/chartix-server.mjs
```

Two entry points share one library, and they are separate files on purpose.
`src/server.ts` is library only — importing it starts nothing and binds
nothing. `src/http.ts` serves Streamable HTTP; `src/stdio.ts` speaks over a
pipe. Binding a port used to be a side effect of *importing* the library,
guarded by `import.meta.url === process.argv[1]`, which silently fails in a
bundle — the library and the entry point are the same file there — so the stdio
build listened on `:8420` while holding a credential. `test/server.test.ts`
pins the structure that fixed it.

## License

Apache-2.0.
