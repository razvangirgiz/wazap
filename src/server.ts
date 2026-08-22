import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { WAZAP_VERSION, type Config } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import { registerTools } from "./tools.js";
import { log, logError } from "./logger.js";
import type { WhatsAppApi } from "./wa-types.js";

function isAuthorized(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function buildMcpServer(wa: WhatsAppApi, config: Config, allowWrite: boolean, limiter: RateLimiter): McpServer {
  const server = new McpServer({ name: "wazap", version: WAZAP_VERSION });
  registerTools(server, wa, { allowWrite: allowWrite && !config.readOnly, limiter });
  return server;
}

type AuthedRequest = Request & { mcpWrite?: boolean };

export async function runStdio(wa: WhatsAppApi, config: Config): Promise<void> {
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const server = buildMcpServer(wa, config, true, limiter);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");
}

/** One bearer token and what it unlocks. */
export interface Credential {
  token: string;
  write: boolean;
}

/** A Streamable HTTP listener: where it binds and who may talk to it. */
export interface Endpoint {
  host: string;
  port: number;
  credentials: Credential[];
  /** No read token configured, so an unauthenticated request gets the read tools. */
  openRead: boolean;
}

/** Serve /mcp and /healthz on one address. Resolves with the bound port, so port 0 works. */
export async function startHttpEndpoint(wa: WhatsAppApi, config: Config, endpoint: Endpoint): Promise<number> {
  // One bucket for the endpoint. A per-session bucket would let an HTTP client
  // bypass the write limit by reconnecting.
  const limiter = new RateLimiter(config.rateLimitPerMinute);

  const app = express();
  app.use(express.json());

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

  if (endpoint.openRead) {
    log(
      "WARNING: no WAZAP_READ_TOKEN set, the /mcp endpoint is UNAUTHENTICATED. " +
        "Set WAZAP_READ_TOKEN before exposing this server beyond localhost.",
    );
  }

  // The first credential the bearer token matches decides the session's tools,
  // so a leaked read token can never message anyone.
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization;
    const credential = endpoint.credentials.find((entry) => isAuthorized(auth, entry.token));
    if (credential || endpoint.openRead) {
      (req as AuthedRequest).mcpWrite = credential?.write === true;
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
        const server = buildMcpServer(wa, config, (req as AuthedRequest).mcpWrite === true, limiter);
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

  // Unauthenticated, so it carries liveness only; the account and data dir
  // stay behind the token in get_status.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, status: wa.getStatus().status });
  });

  return await new Promise<number>((resolve) => {
    const server = app.listen(endpoint.port, endpoint.host, () => {
      const bound = server.address();
      resolve(typeof bound === "object" && bound !== null ? bound.port : endpoint.port);
    });
  });
}

/** The endpoint the user asked for: WAZAP_HOST/WAZAP_PORT and the two configured tokens. */
export async function runHttp(wa: WhatsAppApi, config: Config, extra?: Credential): Promise<number> {
  const credentials: Credential[] = [];
  if (config.readToken) credentials.push({ token: config.readToken, write: false });
  if (config.writeToken) credentials.push({ token: config.writeToken, write: true });
  if (extra) credentials.push(extra);

  const port = await startHttpEndpoint(wa, config, {
    host: config.httpHost,
    port: config.httpPort,
    credentials,
    openRead: !config.readToken,
  });
  log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${port}/mcp`);
  return port;
}

/** A private endpoint on an ephemeral loopback port, reachable only with the token. */
export async function startLoopbackEndpoint(wa: WhatsAppApi, config: Config, token: string): Promise<number> {
  const port = await startHttpEndpoint(wa, config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token, write: true }],
    openRead: false,
  });
  log(`sharing this session on 127.0.0.1:${port}`);
  return port;
}
