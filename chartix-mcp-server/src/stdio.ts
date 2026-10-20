#!/usr/bin/env node
/**
 * The stdio entry point, for running inside a Quantcept plugin.
 *
 * Quantcept's plugin manifest declares an MCP server as
 * `{"type": "stdio", "command": ..., "args": [...]}` — the host spawns the
 * process and speaks newline-delimited JSON-RPC over the pipe. That is a
 * different transport from the Streamable HTTP server in server.ts, which is
 * what a website connector needs, so both exist rather than one being
 * converted into the other.
 *
 * Everything below the transport is shared: the same nine tools, the same
 * single typed client, the same rate limiter, the same §11 scrubbing. Only
 * the pipe differs.
 *
 * NOTHING MAY BE WRITTEN TO STDOUT except protocol frames. A stray
 * console.log corrupts the stream and the host sees a parse error rather than
 * a tool, so the logger writes to stderr — which is already how the client is
 * configured, and is pinned by a test.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, createContext } from "./server.js";

async function main(): Promise<void> {
  // One context, one client, one limiter for the life of the process. A stdio
  // server is a single conversation, so there is no per-request transport
  // dance of the kind Streamable HTTP needs.
  const server: Server = buildServer(createContext());
  const transport = new StdioServerTransport();
  await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
  process.stderr.write(
    `chartix-mcp stdio ready (credential=${process.env.CHARTIX_TOKEN ? "present" : "MISSING"})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
