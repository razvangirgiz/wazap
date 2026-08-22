#!/usr/bin/env node
/**
 * WhatsApp MCP server.
 *
 * Exposes WhatsApp chats, messages, contacts, media and groups as MCP tools,
 * backed by a Baileys WebSocket session (no browser).
 *
 * Two transports (set via the TRANSPORT env var):
 *   - "stdio" (default): a client (Claude Desktop / Claude Code) launches the
 *     process. Also works standalone in a terminal for the QR login.
 *   - "http": a Streamable HTTP server at http://HOST:PORT/mcp, protected by
 *     bearer tokens (a read token and an optional write token).
 *
 * All human-readable output goes to stderr; in stdio mode stdout is reserved
 * for MCP traffic.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { loadConfig, type Config } from "./config.js";
import { WhatsAppService } from "./whatsapp.js";
import { registerTools } from "./tools.js";
import { log, logError } from "./logger.js";

/** Constant-time check of the "Authorization: Bearer <token>" header. */
function isAuthorized(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Build a fresh MCP server instance with the WhatsApp tools registered.
 *  allowWrite gates the mutating tools (send/media/react/forward/delete/manage):
 *  only sessions authenticated with the write token get them. */
function buildMcpServer(wa: WhatsAppService, allowWrite = true): McpServer {
  const server = new McpServer({ name: "whatsapp-baileys-mcp", version: "1.0.0" });
  registerTools(server, wa, allowWrite);
  return server;
}

/** Express request augmented by requireAuth with the caller's write role. */
type AuthedRequest = Request & { mcpWrite?: boolean };

/** stdio transport, for Claude Desktop / Claude Code, or standalone use. */
async function runStdio(wa: WhatsAppService): Promise<void> {
  const server = buildMcpServer(wa);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");
}

/** Streamable HTTP transport with per-session servers. */
async function runHttp(wa: WhatsAppService, config: Config): Promise<void> {
  const app = express();
  app.use(express.json());

  // Request logging: what an MCP client sends, how we responded, how long it took.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const rpc = (req.body && typeof req.body === "object" ? (req.body as { method?: string }).method : undefined) ?? "-";
    const hasAuth = req.headers.authorization ? "auth" : "noauth";
    res.on("finish", () => {
      log(`HTTP ${req.method} ${req.url} rpc=${rpc} ${hasAuth} accept="${req.headers.accept ?? ""}" -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        log(`HTTP ${req.method} ${req.url} rpc=${rpc} -> client closed before response (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  if (!config.authToken) {
    log(
      "WARNING: no MCP_AUTH_TOKEN set, the /mcp endpoint is UNAUTHENTICATED. " +
        "Set MCP_AUTH_TOKEN before exposing this server beyond localhost.",
    );
  }

  // Two tokens: the read token (MCP_AUTH_TOKEN) and the write token
  // (MCP_WRITE_TOKEN). A write-token request also unlocks the mutating tools,
  // so a leaked read token can never message anyone.
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization;
    const writeOk = config.writeToken ? isAuthorized(auth, config.writeToken) : false;
    const readOk = !config.authToken || isAuthorized(auth, config.authToken);
    if (readOk || writeOk) {
      (req as AuthedRequest).mcpWrite = writeOk;
      next();
      return;
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
  };

  // Session-based Streamable HTTP (the SDK's canonical pattern). It serves the
  // GET SSE stream and DELETE that full MCP clients open; a stateless server
  // 404s the GET and makes such clients hang until they time out.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, newTransport);
          },
        });
        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid) transports.delete(sid);
        };
        // The session's tools are fixed at init by the token it authenticated with.
        const server = buildMcpServer(wa, (req as AuthedRequest).mcpWrite === true);
        await server.connect(newTransport);
        transport = newTransport;
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID (send initialize first)" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logError("http request", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", requireAuth, handleMcp);
  app.get("/mcp", requireAuth, handleMcp);
  app.delete("/mcp", requireAuth, handleMcp);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, whatsapp: wa.getStatus() });
  });

  await new Promise<void>((resolve) => {
    app.listen(config.httpPort, config.httpHost, () => {
      log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${config.httpPort}/mcp`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const wa = new WhatsAppService(config, {
    readOnly: config.readOnly,
    syncFullHistory: config.syncFullHistory,
    journalDir: config.journalDir ?? undefined,
    storeCacheFile: config.storeCacheFile ?? undefined,
    historyStoreDir: config.historyStoreDir ?? undefined,
  });

  // Start WhatsApp in the background so MCP startup never waits on the QR scan.
  // Tools return an actionable "not ready" error until the session is live.
  wa.start().catch((err) => logError("whatsapp start", err));

  // Clean shutdown so the WhatsApp socket closes gracefully and the saved
  // session stays valid.
  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    await wa.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (config.transport === "http") {
    await runHttp(wa, config);
  } else {
    await runStdio(wa);
  }
}

main().catch((err) => {
  logError("fatal", err);
  process.exit(1);
});
