/**
 * The MCP surface itself: a tools/list handshake over Streamable HTTP, and the
 * round-trip the brief asks for (NSE symbol in -> deep link + as_of out).
 *
 * The live contract test at the bottom is skipped unless CHARTIX_LIVE=1 and a
 * token is present, so `npm test` never depends on the network or on a
 * credential.
 */
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { handleHttp } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function startServer(): Promise<{ url: URL; close: () => Promise<void> }> {
  // Deliberately the same entry point production uses, and for the same
  // reason twice over: an earlier helper built its own transport and hid a
  // 500 on the handshake, and a later one bypassed the health routes so a
  // live /healthz probe came back as an MCP protocol error.
  const http: HttpServer = createServer((req, res) => {
    void handleHttp(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return {
    url: new URL(`http://127.0.0.1:${addr.port}/`),
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url) as never);
  return client;
}

test("tools/list completes a handshake over Streamable HTTP", async () => {
  const s = await startServer();
  try {
    const client = await connect(s.url);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 8, `only ${tools.length} tools advertised`);
    const names = tools.map((t) => t.name);
    for (const required of [
      "chartix_get_bars",
      "chartix_list_symbols",
      "chartix_run_screen",
      "chartix_get_patterns",
      "chartix_add_to_watchlist",
      "chartix_list_watchlist",
      "chartix_create_alert",
      "chartix_get_chart_url",
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }
    await client.close();
  } finally {
    await s.close();
  }
});

test("every advertised tool carries a usable JSON Schema", async () => {
  const s = await startServer();
  try {
    const client = await connect(s.url);
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.equal((t.inputSchema as { type?: string }).type, "object");
    }
    await client.close();
  } finally {
    await s.close();
  }
});

test("round trip: an NSE symbol in, a chart deep link out, no credential needed", async () => {
  // The brief's acceptance criterion. chartix_get_chart_url makes no API call,
  // so this proves the transport and the tool plumbing without a token.
  const s = await startServer();
  try {
    const client = await connect(s.url);
    const res = await client.callTool({
      name: "chartix_get_chart_url",
      arguments: { symbol: "RELIANCE" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    assert.equal(payload.ok, true);
    const url = new URL(String(payload.url));
    assert.equal(url.searchParams.get("symbol"), "RELIANCE");
    await client.close();
  } finally {
    await s.close();
  }
});

test("a tool that needs Chartix fails typed, and the server stays up", async () => {
  const s = await startServer();
  const saved = process.env.CHARTIX_TOKEN;
  delete process.env.CHARTIX_TOKEN;
  try {
    const client = await connect(s.url);
    const res = await client.callTool({
      name: "chartix_get_bars",
      arguments: { symbol: "RELIANCE" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "CHARTIX_AUTH_FAILED");
    assert.equal(res.isError, true);

    // Still serving afterwards — a failed tool must not take the process down.
    const again = await client.listTools();
    assert.ok(again.tools.length >= 8);
    await client.close();
  } finally {
    if (saved !== undefined) process.env.CHARTIX_TOKEN = saved;
    await s.close();
  }
});

test("an unknown tool is an error envelope, not a crash", async () => {
  const s = await startServer();
  try {
    const client = await connect(s.url);
    const res = await client.callTool({ name: "chartix_nope", arguments: {} });
    assert.equal(res.isError, true);
    await client.close();
  } finally {
    await s.close();
  }
});

// ── live contract test ────────────────────────────────────────────────────
//
// Hits the real Chartix API. Skipped by default and never run in CI, because
// it needs a credential and a reachable host.
const live = process.env.CHARTIX_LIVE === "1" && Boolean(process.env.CHARTIX_TOKEN);

test("live: RELIANCE daily bars are chronological and OHLC-consistent", { skip: !live }, async () => {
  const s = await startServer();
  try {
    const client = await connect(s.url);
    const res = await client.callTool({
      name: "chartix_get_bars",
      arguments: { symbol: "RELIANCE", interval: "daily", limit: 50 },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
    assert.ok(Number(payload.count) > 0);
    assert.equal((payload.integrity as { chronological: boolean }).chronological, true);
    assert.equal((payload.integrity as { impossible: number }).impossible, 0);
    assert.ok(!Number.isNaN(Date.parse(String(payload.as_of))));
    await client.close();
  } finally {
    await s.close();
  }
});

// §13 — the health surfaces, through the same entry point production uses.

test("healthz answers JSON and echoes an inbound request id", async () => {
  const s = await startServer();
  try {
    const r = await fetch(new URL("/healthz", s.url), {
      headers: { "x-request-id": "trace-abc12345" },
    });
    assert.equal(r.headers.get("x-request-id"), "trace-abc12345");
    const body = (await r.json()) as Record<string, unknown>;
    for (const k of ["status", "version", "chartix_reachable", "last_success_at",
                     "symbols_indexed", "source_mode",
                     "chart_symbols_served_total", "chart_stale_responses_total"]) {
      assert.ok(k in body, `healthz is missing ${k}`);
    }
  } finally {
    await s.close();
  }
});

test("readyz refuses traffic until the symbol index is loaded", async () => {
  // A resolve against an empty index answers SYMBOL_UNRESOLVED for symbols
  // that exist, which is worse than refusing to serve.
  const { clearSymbolIndex, symbolIndex } = await import("../dist/tools/index.js");
  const { context } = await import("../dist/server.js");
  clearSymbolIndex();
  const ctx = context();
  if (ctx.health) ctx.health.symbolsIndexed = 0;

  const s = await startServer();
  try {
    assert.equal((await fetch(new URL("/readyz", s.url))).status, 503);
    // Populate the index the way the server does at boot — against the shared
    // context, because createContext() would mint a fresh HealthState and the
    // counter would land on an object nothing reads.
    if (ctx.health) ctx.health.symbolsIndexed = 3000;
    const after = await fetch(new URL("/readyz", s.url));
    assert.equal(after.status, 200);
    assert.equal(((await after.json()) as { ready: boolean }).ready, true);
    void symbolIndex;
  } finally {
    await s.close();
  }
});

test("an unparseable request id is replaced rather than echoed", async () => {
  const s = await startServer();
  try {
    const r = await fetch(new URL("/healthz", s.url), {
      headers: { "x-request-id": "short" },
    });
    assert.notEqual(r.headers.get("x-request-id"), "short");
    assert.ok((r.headers.get("x-request-id") ?? "").length > 8);
  } finally {
    await s.close();
  }
});

// --- the library must not bind a socket -----------------------------------
//
// server.ts used to end with `if (import.meta.url === process.argv[1]) main()`,
// and that guard is unverifiable from inside the module: in a bundle the
// library and the entry point ARE the same file, so the stdio build — which
// only ever imports buildServer() — listened on :8420 as well, holding a
// Chartix credential on a port nobody asked for. The fix was structural: the
// listener moved to http.ts. These tests pin the structure, because the
// failure mode is silent and only visible from outside the process.

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../src";

/**
 * Source with comments removed.
 *
 * Needed because these tests search for code, and the modules they search
 * carry docstrings that quote the very constructs being banned — the first
 * cut of this test failed on its own explanation of the bug.
 */
function codeOnly(file: string): string {
  return readFileSync(`${SRC}/${file}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("server.ts contains no listener — importing it must bind nothing", () => {
  const src = codeOnly("server.ts");
  assert.doesNotMatch(src, /\.listen\(/, "a listener belongs in http.ts, not the library");
  assert.doesNotMatch(src, /createServer\(/, "node:http's createServer belongs in http.ts");
});

test("no module decides at runtime whether it is the entry point", () => {
  for (const f of ["server.ts", "stdio.ts", "http.ts"]) {
    assert.doesNotMatch(
      codeOnly(f),
      /process\.argv\[1\]/,
      `${f}: an argv[1] entry-point guard is wrong in a bundle — give the ` +
        `transport its own file instead`,
    );
  }
});

test("the stdio entry writes nothing to stdout — stdout is the protocol", () => {
  assert.doesNotMatch(codeOnly("stdio.ts"), /process\.stdout\.write|console\.(log|info|debug)/);
});

test("the advertised server version is the one constant, not a second copy", () => {
  const src = readFileSync(`${SRC}/server.ts`, "utf8");
  assert.match(src, /name: "chartix-mcp-server", version: VERSION/);
  const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8")) as { version: string };
  const declared = /export const VERSION = "([^"]+)"/.exec(src)?.[1];
  assert.equal(declared, pkg.version, "VERSION and package.json drifted apart");
});

// --- the plugin's shipped copies must match their sources ----------------
//
// The Quantcept plugin at integrations/quantcept-plugin/ carries a COPY of the
// bridge skill, because its two install routes need the file in two places:
// the website connector takes pasted text, the plugin takes a file on disk.
// Two identical files with no link between them drift, and the drift is
// invisible — the plugin would quietly teach older attribution rules. `npm run
// bundle` regenerates the copy; this test is what notices if it was not run.

const REPO = dirname(fileURLToPath(import.meta.url)) + "/../..";

test("the plugin's SKILL.md is byte-identical to the canonical one", () => {
  const canonical = `${REPO}/quantcept/chartix-quantcept-bridge/SKILL.md`;
  const shipped = `${REPO}/quantcept-plugin/skills/chartix-quantcept-bridge/SKILL.md`;
  if (!existsSync(shipped)) return; // the plugin is optional in a bare checkout
  assert.equal(
    readFileSync(shipped, "utf8"),
    readFileSync(canonical, "utf8"),
    "run `npm run bundle` — the plugin's skill copy has drifted from the source",
  );
});

test("the plugin manifest points at a file the bundle actually produces", () => {
  const manifestPath = `${REPO}/quantcept-plugin/quantcept-plugin.json`;
  if (!existsSync(manifestPath)) return;
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: string;
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };
  const srv = m.mcpServers.chartix;
  assert.ok(srv, "the manifest must declare an mcpServers.chartix entry");
  assert.equal(srv.type, "stdio", "a Quantcept plugin server speaks stdio, not HTTP");
  const arg = srv.args.find((a) => a.includes("${PLUGIN_ROOT}"));
  assert.ok(arg, "the entry path must be relative to ${PLUGIN_ROOT}");
  const rel = arg.replace("${PLUGIN_ROOT}/", "");
  assert.ok(
    existsSync(`${REPO}/quantcept-plugin/${rel}`),
    `the manifest names ${rel}, which does not exist — run \`npm run bundle\``,
  );
  const pkg = JSON.parse(readFileSync(`${REPO}/chartix-mcp-server/package.json`, "utf8")) as {
    version: string;
  };
  assert.equal(m.version, pkg.version, "the plugin and the server versions drifted apart");
});
