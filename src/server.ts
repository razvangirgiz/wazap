import { AccountManager, type AccountAccess } from "./account-manager.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { rateLimit } from "express-rate-limit";
import { WAZAP_VERSION, paths, type Config } from "./config.js";
import { APPROVE_PATH, OAUTH_SCOPES, WazapOAuthProvider } from "./oauth.js";
import {
  loadSkills,
  registerSkillPrompts,
  skillInstructions,
} from "./skills.js";
import { accessContext, type AccessContext } from "./access.js";
import { registerTools } from "./tools.js";
import { log, logError } from "./logger.js";
import type { WhatsAppApi } from "./wa-types.js";

const UNHEALTHY_AFTER_MS = 2 * 60 * 1000;

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
function buildMcpServer(
  wa: WhatsAppApi | AccountManager,
  config: Config,
  allowWrite: boolean,
  context?: AccessContext,
): McpServer {
  const skills = loadSkills();
  const server = new McpServer(
    { name: "wazap", version: WAZAP_VERSION },
    { instructions: skillInstructions(skills) },
  );
  registerTools(server, wa, {
    allowWrite: allowWrite && !config.readOnly,
    context,
  });
  registerSkillPrompts(server, skills);
  return server;
}

type AuthedRequest = Request & {
  mcpWrite?: boolean;
  principal?: string;
  accountAccess?: AccountAccess;
};

export async function runStdio(
  wa: WhatsAppApi | AccountManager,
  config: Config,
): Promise<void> {
  const server = buildMcpServer(wa, config, true);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");
}

/** One bearer token and what it unlocks. */
export interface Credential {
  token: string;
  write: boolean;
  accountIds?: string[];
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
  local?: boolean;
  sessionIdleMs?: number;
}

/** Serve /mcp and /healthz on one address. Resolves with the bound port, so port 0 works. */
// Both the private bridge and public listener share the process-wide budget.
const sessionCounts = new Map<string, number>();
function reserveSession(principal: string): (() => void) | null {
  const count = sessionCounts.get(principal) ?? 0;
  if (
    count >= 8 ||
    [...sessionCounts.values()].reduce((a, b) => a + b, 0) >= 128
  )
    return null;
  sessionCounts.set(principal, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (sessionCounts.get(principal) ?? 1) - 1;
    if (remaining) sessionCounts.set(principal, remaining);
    else sessionCounts.delete(principal);
  };
}

export async function startHttpEndpoint(
  wa: WhatsAppApi | AccountManager,
  config: Config,
  endpoint: Endpoint,
): Promise<number> {
  const app = express();
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const rpc =
      (req.body && typeof req.body === "object"
        ? (req.body as { method?: string }).method
        : undefined) ?? "-";
    const hasAuth = req.headers.authorization ? "auth" : "noauth";
    res.on("finish", () => {
      log(
        `HTTP ${req.method} ${req.path} rpc=${rpc} ${hasAuth} accept="${req.headers.accept ?? ""}" -> ${res.statusCode} (${Date.now() - start}ms)`,
      );
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        log(
          `HTTP ${req.method} ${req.path} rpc=${rpc} -> client closed before response (${Date.now() - start}ms)`,
        );
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
        serviceDocumentationUrl: new URL(
          "https://github.com/razvangirgiz/wazap#self-host",
        ),
        // A confidential client's secret would otherwise expire after thirty
        // days and its refresh token with it, which is a monthly password.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }),
    );
    app.post(
      APPROVE_PATH,
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 30,
        standardHeaders: true,
        legacyHeaders: false,
      }),
      express.urlencoded({ extended: false }),
      oauth.approve,
    );
    log(`OAuth on: agents sign in at ${oauth.issuerUrl.href}`);
  }
  const resourceMetadataUrl = oauth
    ? getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl)
    : null;

  // The first credential the bearer token matches decides the session's tools,
  // so a leaked read token can never message anyone. An OAuth token carries
  // the scope the person picked on the consent page.
  const requireAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const auth = req.headers.authorization;
    const credential = endpoint.credentials.find((entry) =>
      isAuthorized(auth, entry.token),
    );
    if (credential) {
      (req as AuthedRequest).mcpWrite =
        credential.write &&
        !(endpoint.local && req.headers["x-wazap-read-only"] === "1");
      if (wa instanceof AccountManager) {
        const header = endpoint.local
          ? req.headers["x-wazap-accounts"]
          : undefined;
        const requested =
          typeof header === "string"
            ? header.split(",").filter(Boolean)
            : undefined;
        const ids =
          requested && credential.accountIds
            ? requested.filter((id) => credential.accountIds!.includes(id))
            : (requested ?? credential.accountIds);
        (req as AuthedRequest).accountAccess = wa.access(ids);
      }
      (req as AuthedRequest).principal =
        "static:" + createHash("sha256").update(credential.token).digest("hex");
      next();
      return;
    }
    if (oauth && auth?.startsWith("Bearer ")) {
      try {
        const info = await oauth.verifyAccessToken(
          auth.slice("Bearer ".length).trim(),
        );
        if (wa instanceof AccountManager) {
          const ids = info.extra?.accountIds;
          if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
            throw new Error("Account consent is required.");
          (req as AuthedRequest).accountAccess = wa.access(ids);
        }
        (req as AuthedRequest).mcpWrite = info.scopes.includes("write");
        (req as AuthedRequest).principal =
          `oauth:${info.clientId}:${info.extra?.grantId ?? ""}`;
        next();
        return;
      } catch {
        // Falls through to the 401 below, which tells the client how to sign in.
      }
    }
    if (openRead && !auth) {
      (req as AuthedRequest).mcpWrite = false;
      (req as AuthedRequest).principal = "anonymous";
      if (wa instanceof AccountManager)
        (req as AuthedRequest).accountAccess = wa.access();
      next();
      return;
    }
    if (resourceMetadataUrl) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      );
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized: missing or invalid bearer token",
      },
      id: null,
    });
  };

  // Session-based Streamable HTTP (the SDK's canonical pattern). It serves the
  // GET SSE stream and DELETE that full MCP clients open; a stateless server
  // 404s the GET and makes such clients hang until they time out.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const sessions = new Map<
    string,
    {
      principal: string;
      write: boolean;
      accountAccess?: AccountAccess;
      last: number;
      active: number;
      completedRequest: boolean;
    }
  >();
  const idleMs = endpoint.sessionIdleMs ?? 30 * 60_000;
  const sweep = (): void => {
    for (const [sid, session] of sessions) {
      if (!session.active && Date.now() - session.last >= idleMs) {
        sessions.delete(sid);
        void transports.get(sid)?.close();
        transports.delete(sid);
      }
    }
  };
  const reaper = setInterval(sweep, Math.min(idleMs, 60_000));
  reaper.unref();

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    let releaseReservation: (() => void) | null = null;
    let initialized = false;
    try {
      sweep();
      const principal = (req as AuthedRequest).principal!;
      const write =
        (req as AuthedRequest).mcpWrite === true && !config.readOnly;
      const accountAccess = (req as AuthedRequest).accountAccess;
      const sessionId = req.headers["mcp-session-id"];
      const session =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (
        session &&
        (session.principal !== principal ||
          session.write !== write ||
          JSON.stringify(session.accountAccess) !==
            JSON.stringify(accountAccess))
      ) {
        res
          .status(403)
          .json({
            error:
              "Session belongs to another identity or permission set. Initialize again.",
          });
        return;
      }
      let transport =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      if (
        !transport &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        releaseReservation = reserveSession(principal);
        if (!releaseReservation) {
          // Some hosted clients create a session per call without sending DELETE.
          // Reclaim only this caller's completed, inactive sessions; never an
          // in-flight call or an initialization that has not been used yet.
          const oldest = [...sessions.entries()]
            .filter(([, item]) => item.principal === principal && item.active === 0 && item.completedRequest)
            .sort((a, b) => a[1].last - b[1].last)[0];
          if (oldest) {
            const [sid] = oldest;
            const previous = transports.get(sid);
            sessions.delete(sid);
            transports.delete(sid);
            await previous?.close();
            releaseReservation = reserveSession(principal);
          }
        }
        if (!releaseReservation) {
          res
            .status(429)
            .json({
              error: "Too many sessions. Close an existing session first.",
            });
          return;
        }
        const releaseSlot = releaseReservation;
        const newTransport: StreamableHTTPServerTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              initialized = true;
              transports.set(sid, newTransport);
              sessions.set(sid, {
                principal,
                write,
                accountAccess,
                last: Date.now(),
                active: 0,
                completedRequest: false,
              });
            },
          });
        newTransport.onclose = () => {
          releaseSlot();
          const sid = newTransport.sessionId;
          if (sid) {
            transports.delete(sid);
            sessions.delete(sid);
          }
        };
        // The session's tools are fixed at init by the token it authenticated with.
        const server = buildMcpServer(wa, config, write, {
          principal,
          accountAccess,
          allowWrite: write,
          local: endpoint.local === true,
        });
        await server.connect(newTransport);
        transport = newTransport;
      }

      if (!transport) {
        res.status(typeof sessionId === "string" ? 404 : 400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "No valid session ID; initialize again",
          },
          id: null,
        });
        return;
      }

      const tracked = transport.sessionId
        ? sessions.get(transport.sessionId)
        : undefined;
      const activeCall = req.method === "POST";
      if (tracked) {
        if (activeCall) tracked.active++;
        tracked.last = Date.now();
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (tracked) {
          if (activeCall) {
            tracked.active--;
            if (res.writableFinished && req.body?.id !== undefined && req.body?.method !== "initialize")
              tracked.completedRequest = true;
          }
          tracked.last = Date.now();
        }
      };
      res.once("finish", release);
      res.once("close", release);
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        if (res.writableEnded) release();
      }
    } catch (err) {
      logError("http request", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      if (!initialized) releaseReservation?.();
    }
  };

  const authed = (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, next).catch(next);
  };
  app.post("/mcp", authed, handleMcp);
  app.get("/mcp", authed, handleMcp);
  app.delete("/mcp", authed, handleMcp);

  // Unauthenticated, so it carries liveness only; the account and data dir
  // stay behind the token in get_status. A socket that has been anything but
  // connected for two minutes is a real outage, and a 503 is what a tunnel or a
  // monitor can act on; a reconnect in progress is not.
  app.get("/healthz", (_req, res) => {
    if (wa instanceof AccountManager) {
      const health = wa.health();
      res.status(health.ok ? 200 : 503).json(health);
      return;
    }
    const { status, status_since, archive } = wa.getStatus();
    const stalled = Date.now() - Date.parse(status_since) > UNHEALTHY_AFTER_MS;
    const ok =
      (status === "connected" || !stalled) && archive?.state !== "error";
    res.status(ok ? 200 : 503).json({ ok, status, since: status_since });
  });

  return await new Promise<number>((resolve, reject) => {
    const server = app.listen(endpoint.port, endpoint.host, () => {
      const bound = server.address();
      resolve(
        typeof bound === "object" && bound !== null
          ? bound.port
          : endpoint.port,
      );
    });
    server.on("error", reject);
    endpoint.signal?.addEventListener("abort", () => {
      clearInterval(reaper);
      for (const transport of transports.values()) void transport.close();
      server.closeAllConnections();
      server.close();
    });
  });
}

/** The endpoint the user asked for: WAZAP_HOST/WAZAP_PORT and the two configured tokens. */
export async function runHttp(
  wa: WhatsAppApi | AccountManager,
  config: Config,
): Promise<number> {
  const credentials: Credential[] = [];
  if (config.readToken)
    credentials.push({
      token: config.readToken,
      write: false,
      accountIds: config.readAccountIds,
    });
  if (config.writeToken)
    credentials.push({
      token: config.writeToken,
      write: true,
      accountIds: config.writeAccountIds,
    });
  // Bridge credentials are accepted only by the private listener.

  const oauth =
    config.publicUrl && config.oauthPassword
      ? new WazapOAuthProvider({
          publicUrl: new URL(config.publicUrl),
          password: config.oauthPassword,
          stateFile: paths(config.dataDir).oauthFile,
          accounts:
            wa instanceof AccountManager
              ? () =>
                  wa.accounts
                    .list()
                    .filter((a) => wa.access().ids.includes(a.id))
                    .map((a) => ({ id: a.id, name: a.name }))
              : undefined,
        })
      : undefined;

  const port = await startHttpEndpoint(wa, config, {
    host: config.httpHost,
    port: config.httpPort,
    credentials,
    openRead: !config.readToken,
    oauth,
  });
  log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${port}/mcp`);
  return port;
}

/** A private endpoint on an ephemeral loopback port, reachable only with the token. */
export async function startLoopbackEndpoint(
  wa: WhatsAppApi | AccountManager,
  config: Config,
  token: string,
): Promise<number> {
  const port = await startHttpEndpoint(wa, config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token, write: true }],
    local: true,
    openRead: false,
  });
  log(`sharing this session on 127.0.0.1:${port}`);
  return port;
}
