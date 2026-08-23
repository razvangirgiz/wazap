import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { WAZAP_VERSION, paths, type Config } from "./config.js";
import { APPROVE_PATH, OAUTH_SCOPES, WazapOAuthProvider } from "./oauth.js";
import { RateLimiter } from "./ratelimit.js";
import { loadSkills, registerSkillPrompts, skillInstructions } from "./skills.js";
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

/**
 * The one place a session is built, so the workflows reach stdio and HTTP alike:
 * a client that never installed the skill files still gets them here.
 */
function buildMcpServer(wa: WhatsAppApi, config: Config, allowWrite: boolean, limiter: RateLimiter): McpServer {
  const skills = loadSkills();
  const server = new McpServer({ name: "wazap", version: WAZAP_VERSION }, { instructions: skillInstructions(skills) });
  registerTools(server, wa, { allowWrite: allowWrite && !config.readOnly, limiter });
  registerSkillPrompts(server, skills);
  return server;
}

type AuthedRequest = Request & { mcpWrite?: boolean };

export async function runStdio(wa: WhatsAppApi, config: Config, limiter: RateLimiter): Promise<void> {
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
  /** No read token configured, so an unauthenticated request gets the read tools. Never with OAuth on. */
  openRead: boolean;
  /** Hosted agents sign in here instead of carrying a token. */
  oauth?: WazapOAuthProvider;
  /** Aborting it closes the listener and every session on it. */
  signal?: AbortSignal;
}

/** Serve /mcp and /healthz on one address. Resolves with the bound port, so port 0 works. */
export async function startHttpEndpoint(
  wa: WhatsAppApi,
  config: Config,
  endpoint: Endpoint,
  limiter: RateLimiter,
): Promise<number> {
  const app = express();
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const rpc = (req.body && typeof req.body === "object" ? (req.body as { method?: string }).method : undefined) ?? "-";
    const hasAuth = req.headers.authorization ? "auth" : "noauth";
    res.on("finish", () => {
      log(`HTTP ${req.method} ${req.originalUrl} rpc=${rpc} ${hasAuth} accept="${req.headers.accept ?? ""}" -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        log(`HTTP ${req.method} ${req.originalUrl} rpc=${rpc} -> client closed before response (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  if (endpoint.openRead && !endpoint.oauth) {
    log(
      "WARNING: no WAZAP_READ_TOKEN set, the /mcp endpoint is UNAUTHENTICATED. " +
        "Set WAZAP_READ_TOKEN before exposing this server beyond localhost.",
    );
  }

  const oauth = endpoint.oauth;
  // A server that advertises sign-in must not also answer strangers.
  const openRead = endpoint.openRead && !oauth;
  if (oauth) {
    // Reached through a TLS proxy: on this machine, or the Docker bridge when
    // the container binds 0.0.0.0. The proxy's idea of the caller is the one
    // the password lockout and the SDK's limiters should count.
    app.set("trust proxy", "loopback, linklocal, uniquelocal");
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: oauth.issuerUrl,
        resourceServerUrl: oauth.resourceUrl,
        resourceName: "wazap",
        scopesSupported: [...OAUTH_SCOPES],
        serviceDocumentationUrl: new URL("https://github.com/razvangirgiz/wazap#self-host"),
        // A confidential client's secret would otherwise expire after thirty
        // days and its refresh token with it, which is a monthly password.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }),
    );
    app.post(
      APPROVE_PATH,
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
      express.urlencoded({ extended: false }),
      oauth.approve,
    );
    log(`OAuth on: agents sign in at ${oauth.issuerUrl.href}`);
  }
  const resourceMetadataUrl = oauth ? getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl) : null;

  // The first credential the bearer token matches decides the session's tools,
  // so a leaked read token can never message anyone. An OAuth token carries
  // the scope the person picked on the consent page.
  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.headers.authorization;
    const credential = endpoint.credentials.find((entry) => isAuthorized(auth, entry.token));
    if (credential) {
      (req as AuthedRequest).mcpWrite = credential.write;
      next();
      return;
    }
    if (oauth && auth?.startsWith("Bearer ")) {
      try {
        const info = await oauth.verifyAccessToken(auth.slice("Bearer ".length).trim());
        (req as AuthedRequest).mcpWrite = info.scopes.includes("write");
        next();
        return;
      } catch {
        // Falls through to the 401 below, which tells the client how to sign in.
      }
    }
    if (openRead) {
      (req as AuthedRequest).mcpWrite = false;
      next();
      return;
    }
    if (resourceMetadataUrl) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
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

  const authed = (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, next).catch(next);
  };
  app.post("/mcp", authed, handleMcp);
  app.get("/mcp", authed, handleMcp);
  app.delete("/mcp", authed, handleMcp);

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
    endpoint.signal?.addEventListener("abort", () => {
      for (const transport of transports.values()) void transport.close();
      server.closeAllConnections();
      server.close();
    });
  });
}

/** The endpoint the user asked for: WAZAP_HOST/WAZAP_PORT and the two configured tokens. */
export async function runHttp(
  wa: WhatsAppApi,
  config: Config,
  limiter: RateLimiter,
  extra?: Credential,
): Promise<number> {
  const credentials: Credential[] = [];
  if (config.readToken) credentials.push({ token: config.readToken, write: false });
  if (config.writeToken) credentials.push({ token: config.writeToken, write: true });
  if (extra) credentials.push(extra);

  const oauth =
    config.publicUrl && config.oauthPassword
      ? new WazapOAuthProvider({
          publicUrl: new URL(config.publicUrl),
          password: config.oauthPassword,
          stateFile: paths(config.dataDir).oauthFile,
        })
      : undefined;

  const port = await startHttpEndpoint(
    wa,
    config,
    { host: config.httpHost, port: config.httpPort, credentials, openRead: !config.readToken, oauth },
    limiter,
  );
  log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${port}/mcp`);
  return port;
}

/** A private endpoint on an ephemeral loopback port, reachable only with the token. */
export async function startLoopbackEndpoint(
  wa: WhatsAppApi,
  config: Config,
  token: string,
  limiter: RateLimiter,
): Promise<number> {
  const port = await startHttpEndpoint(
    wa,
    config,
    { host: "127.0.0.1", port: 0, credentials: [{ token, write: true }], openRead: false },
    limiter,
  );
  log(`sharing this session on 127.0.0.1:${port}`);
  return port;
}
