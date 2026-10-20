#!/usr/bin/env node
/**
 * HTTP entry point: Streamable HTTP transport on a TCP port.
 *
 * This lives in its own module, separate from server.ts, for one load-bearing
 * reason: binding a port must never be a side effect of IMPORTING the server
 * library. It used to be, guarded by an `import.meta.url === process.argv[1]`
 * check — which silently fails in a bundle, where the library and the entry
 * point are the same file, so the stdio build listened on :8420 as well. The
 * guard looked right and was unverifiable from the source. Now there is no
 * guard: whoever wants a socket runs this file.
 *
 * Default bind is 127.0.0.1 on purpose: this process holds a Chartix login
 * JWT carrying that user's full authority, writes included, so anyone who can
 * reach an exposed instance acts as that user. (Paid data itself is gated at
 * the API — intraday requires eod_pro server-side — but the credential is the
 * real exposure.) Read the README's "Hosting" section before changing HOST.
 */
import { createServer } from "node:http";
import { CHARTIX_DEFAULT_BASE_URL } from "./chartix/catalog.js";
import { VERSION, context, env, handleHttp, intEnv, sourceMode } from "./server.js";
import { logLine, newHealth } from "./chartix/health.js";
import { symbolIndex } from "./tools/index.js";

async function main(): Promise<void> {
  const port = intEnv("PORT", 8420);
  const host = env("HOST") ?? "127.0.0.1";

  // Two narrow casts, and only here.
  //
  // This project compiles with exactOptionalPropertyTypes, which is stricter
  // than `strict` and which caught several real optional-property mistakes in
  // the client. The MCP SDK's own types are not written for it: it declares
  // `sessionIdGenerator: () => string` while documenting `undefined` as the
  // way to ask for stateless mode, and its Transport interface declares
  // `onclose` non-optional. Relaxing the flag for the whole project to satisfy
  // a dependency would give up the checking everywhere; casting at the
  // boundary gives it up exactly where the dependency is wrong.
  // The shared context always carries one; the optionality on ToolContext is
  // for tests that construct a context by hand.
  const h = context().health ?? newHealth(VERSION, sourceMode());
  const http = createServer((req, res) => void handleHttp(req, res));

  // §13: prime the symbol index so /readyz can become ready. Fire and forget —
  // a server that refuses to start because Chartix was briefly unreachable is
  // worse than one that reports itself not-ready until it is.
  if (h.mode === "network") {
    void symbolIndex(context())
      .then((rows) => process.stderr.write(logLine({
        ts: new Date().toISOString(), level: "info", request_id: "boot",
        source_mode: h.mode, endpoint: "/api/instruments/", status: 200,
        symbol: `${rows.length} indexed`,
      }) + "\n"))
      .catch((e: unknown) => process.stderr.write(logLine({
        ts: new Date().toISOString(), level: "warn", request_id: "boot",
        source_mode: h.mode, endpoint: "/api/instruments/",
        error_code: (e as { code?: string }).code ?? "CHARTIX_UNAVAILABLE",
      }) + "\n"));
  }

  http.listen(port, host, () => {
    process.stderr.write(
      `chartix-mcp-server ${VERSION} listening on http://${host}:${port} ` +
        `(source=${h.mode}, ` +
        `chartix=${env("CHARTIX_BASE_URL") ?? CHARTIX_DEFAULT_BASE_URL}, ` +
        `credential=${env("CHARTIX_TOKEN") ? "present" : "MISSING"})\n`,
    );
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
