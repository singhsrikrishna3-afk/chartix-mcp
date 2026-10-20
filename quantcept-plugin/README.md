# Chartix plugin for Quantcept

NSE price action from [ChartixAI](https://chartixai.com) inside Quantcept: nine
MCP tools over the Chartix REST API, plus a skill about keeping Chartix's
claims and Quantcept's claims apart in the same answer.

```
quantcept-plugin.json                      the manifest (one stdio MCP server)
mcp/chartix-server.mjs                     the server, bundled — see "Building"
skills/chartix-quantcept-bridge/SKILL.md   attribution discipline
```

## Install

Add the marketplace, then the plugin:

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

## You must set CHARTIX_TOKEN yourself

The manifest declares no `env` block, because none of Quantcept's own example
plugins do and the key is not in their schema. The server therefore reads
`CHARTIX_TOKEN` from the environment it is **spawned in** — which is
Quantcept's own process. Export it before you start Quantcept:

```bash
export CHARTIX_TOKEN="$(curl -s -X POST https://api.chartixai.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
```

Chartix issues no API keys — the credential is a JWT from `POST /api/auth/login`,
and it expires. Without it every tool returns a typed `CHARTIX_AUTH_FAILED`
envelope naming this variable, rather than failing obscurely.

Optional: `CHARTIX_BASE_URL` (default `https://api.chartixai.com`),
`CHARTIX_RPM` (60), `CHARTIX_CONCURRENCY` (4).

### Trying it without a credential

Pattern data can come from a CSV export instead of the API, which needs no
token and makes no network call:

```
"args": ["${PLUGIN_ROOT}/mcp/chartix-server.mjs", "--source=file", "--file=/path/to/export.csv"]
```

Header must be exactly
`symbol,pattern,win_rate,sample_size,date_range,chart_url,as_of`.
In this mode `chartix_get_patterns` answers from the file and every other tool
reports that it needs the network — it degrades loudly, not silently.

## The tools

| Tool | What it returns |
| --- | --- |
| `chartix_list_symbols` | the NSE universe Chartix tracks |
| `chartix_get_bars` | OHLCV, daily through intraday |
| `chartix_get_patterns` | detected patterns; **with `symbol`, Chartix's backtested win rate** |
| `chartix_patterns_why_empty` | why a pattern query returned nothing |
| `chartix_run_screen` | a screener run and the parameters that produced it |
| `chartix_list_watchlist` / `chartix_add_to_watchlist` | the user's watchlist |
| `chartix_create_alert` | a price or indicator alert |
| `chartix_get_chart_url` | a link to the chart, rather than prose about it |

Two things the tool replies state outright, because an agent gets them wrong
otherwise: the market-wide pattern list carries `confidence`, which is **not** a
win rate (`win_rate_available: false` says so), and a `null` win rate means
fewer than 20 backtested samples — never fill one in with an estimate.

## Node, or bun

`command` is `node`, and the bundle is built `--target=node20`. Quantcept's own
`mcp-echo` example uses `bun`; the bundle is plain ESM and runs under either,
so on a bun-only host change the one `"command"` field.

## Building

`mcp/chartix-server.mjs` is generated — do not edit it. It is a single file with
no `node_modules`, so the plugin installs from a git checkout with nothing to
`npm install`.

```bash
cd ../chartix-mcp-server
npm ci && npm test && npm run bundle
```

The source of truth is `integrations/chartix-mcp-server`. Two entry points share
one library: `src/http.ts` (Streamable HTTP, for a website connector) and
`src/stdio.ts` (this plugin). They are separate files on purpose — binding a
port used to be a side effect of importing the library, guarded by an
`import.meta.url === process.argv[1]` check that silently fails in a bundle,
and the stdio build listened on `:8420` while holding a Chartix credential.
`test/server.test.ts` pins the structure that fixed it.
