/**
 * MCP server over the Chartix REST API: tools, context and request handling.
 *
 * Library only — importing this module starts nothing and binds nothing. The
 * two transports are the entry points: http.ts (Streamable HTTP, for the
 * Quantcept website connector or the terminal's /mcp) and stdio.ts (for a
 * plugin host that spawns the process).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ChartixClient } from "./chartix/client.js";
import { CHARTIX_DEFAULT_BASE_URL } from "./chartix/catalog.js";
import { FileSource } from "./chartix/fileSource.js";
import {
  healthz, logLine, newHealth, readyz, recordFailure, recordSuccess,
  requestId, type HealthState, type SourceMode,
} from "./chartix/health.js";
import { TOOLS, runTool, symbolIndex, type ToolContext } from "./tools/index.js";

export const VERSION = "0.2.0";

/** §10: --source=file|network, also settable by env for the container. */
export function sourceMode(): SourceMode {
  const flag = process.argv.find((a) => a.startsWith("--source="));
  const raw = (flag ? flag.split("=")[1] : env("CHARTIX_SOURCE")) ?? "network";
  return raw === "file" ? "file" : "network";
}

function sourceFile(): string | undefined {
  const flag = process.argv.find((a) => a.startsWith("--file="));
  return (flag ? flag.split("=")[1] : env("CHARTIX_FILE")) ?? undefined;
}

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
}

export function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The shared, process-wide Chartix context.
 *
 * Built once and only once, because the rate limiter lives inside the client
 * and a limiter per request limits nothing. The MCP transport has to be
 * per-request (see main), so these two lifetimes are deliberately different.
 */
export function createContext(health?: HealthState): ToolContext {
  const h = health ?? newHealth(VERSION, sourceMode());
  const file = h.mode === "file" ? new FileSource(sourceFile() ?? "chartix-export.csv") : undefined;
  if (file) {
    // Loading at startup, not lazily: a malformed export should stop the
    // server now, not surface as a tool error on someone's first question.
    const loaded = file.load();
    h.symbolsIndexed = file.symbols().length;
    h.dataAsOf = loaded.as_of;
    process.stderr.write(logLine({
      ts: new Date().toISOString(), level: "info", request_id: "boot",
      source_mode: "file", endpoint: file.path, status: 200,
    }) + "\n");
  }
  const client = new ChartixClient({
    baseUrl: env("CHARTIX_BASE_URL") ?? CHARTIX_DEFAULT_BASE_URL,
    // Read per request, not captured once: a hosted process outlives a Chartix
    // JWT, and restarting to rotate a credential is not operable.
    token: () => env("CHARTIX_TOKEN"),
    rpm: intEnv("CHARTIX_RPM", 60),
    concurrency: intEnv("CHARTIX_CONCURRENCY", 4),
    log: (entry) => {
      // §13's shape. Never the token, never the Authorization header, never a
      // payload body — request id, endpoint, status and latency are enough to
      // debug and carry no secret.
      const ts = new Date().toISOString();
      if (entry.outcome === "ok") recordSuccess(h, ts);
      else if (entry.error) recordFailure(h, ts, entry.error);
      process.stderr.write(logLine({
        ts,
        level: entry.outcome === "ok" ? "info" : entry.outcome === "retry" ? "warn" : "error",
        request_id: entry.request_id,
        endpoint: entry.endpoint,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        latency_ms: entry.latency_ms,
        source_mode: h.mode,
        ...(entry.error !== undefined ? { error_code: entry.error } : {}),
      }) + "\n");
    },
  });

  return {
    client,
    siteUrl: env("CHARTIX_SITE_URL") ?? "https://chartixai.com",
    health: h,
    ...(file ? { file } : {}),
  };
}

let shared: ToolContext | undefined;

/**
 * The one context the server actually serves from.
 *
 * Exported because calling createContext() instead mints a FRESH HealthState,
 * so counters land on an object nothing reads — which is exactly how a probe
 * of this showed 3,000 symbols indexed and /readyz still reporting zero.
 */
export function context(): ToolContext {
  shared ??= createContext();
  return shared;
}

export function buildServer(ctx: ToolContext = context()): Server {
  const server = new Server(
    { name: "chartix-mcp-server", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "jsonSchema7" }) as Record<
        string,
        unknown
      >,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = TOOLS.find((t) => t.name === req.params.name);
    if (!def) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "UNKNOWN_TOOL",
              message: `No tool named ${req.params.name}.`,
            }),
          },
        ],
      };
    }
    const result = await runTool(def, req.params.arguments, ctx);
    const failed =
      typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false;
    return {
      ...(failed ? { isError: true } : {}),
      // Structured JSON, never prose: the caller is a model and a sentence
      // invites it to paraphrase a number.
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}

/**
 * One transport and one MCP Server per request.
 *
 * Stateless Streamable HTTP means no session id, and a transport that has
 * already handled an `initialize` treats the next session-less POST as a
 * second initialization and answers 500 — which is exactly what a reused
 * transport did here: the handshake's own `notifications/initialized` failed
 * while `initialize` succeeded.
 *
 * The Chartix client is NOT rebuilt per request. It owns the rate limiter, and
 * a limiter that is recreated for every caller does not limit anything.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  const server = buildServer(context());
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
  await transport.handleRequest(req, res);
}


/**
 * The single HTTP entry point: health, readiness, then MCP.
 *
 * Health routing used to live inside main()'s createServer, which meant the
 * tests — which drive handleMcp directly — never exercised it, and a live
 * probe of /healthz came back as an MCP protocol error. That is the same shape
 * as the transport bug this file already carries a note about: a test harness
 * that builds its own path tests a path production does not use.
 */
export async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const h = context().health ?? newHealth(VERSION, sourceMode());
  // §13: propagated when the caller sends one, so a Quantcept answer can be
  // traced back to the Chartix calls that produced it.
  const rid = requestId(req.headers["x-request-id"]);
  res.setHeader("x-request-id", rid);

  const path = (req.url ?? "/").split("?")[0];
  if (path === "/healthz") {
    const body = healthz(h);
    res.writeHead(body.status === "ok" ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (path === "/readyz") {
    const { ready, body } = readyz(h);
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  await handleMcp(req, res);
}
