import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";
import type { AccountBinding, AccountSource } from "./account-hub.js";
import { WAZAP_VERSION, paths, writesHints, type Config } from "./config.js";
import { APPROVE_PATH, OAUTH_SCOPES, WazapOAuthProvider } from "./oauth.js";
import { loadSkills, registerSkillPrompts, skillInstructions } from "./skills.js";
import { anyAccountAllowsWrites, registerTools } from "./tools.js";
import { log, logError } from "./logger.js";
import type { ConnectionStatus } from "./wa-types.js";

const UNHEALTHY_AFTER_MS = 2 * 60 * 1000;
/** A session nobody has touched in an hour is abandoned, not kept. */
const MCP_SESSION_TTL_MS = 60 * 60 * 1000;
/** A client that never closes can still pile up sessions; past this, the idlest goes. */
const MCP_SESSION_MAX = 64;
const MCP_SESSION_SWEEP_MS = 5 * 60 * 1000;

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
function buildMcpServer(hub: AccountSource, config: Config, allowWrite: boolean): McpServer {
  const skills = loadSkills();
  const server = new McpServer({ name: "wazap", version: WAZAP_VERSION }, { instructions: skillInstructions(skills) });
  registerTools(server, hub, {
    allowWrite: allowWrite && !config.readOnly && anyAccountAllowsWrites(hub),
  });
  registerSkillPrompts(server, skills);
  return server;
}

type AuthedRequest = Request & { mcpWrite?: boolean; oauthClient?: string };

/**
 * Who is calling, for the request log: the User-Agent a client names itself by,
 * cut short and stripped of quotes and control characters so it cannot forge a
 * field, and the client an OAuth token was issued to. Never a credential.
 */
function callerTag(req: AuthedRequest): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is stripped
  const agent = (req.headers["user-agent"] ?? "").replace(/["\x00-\x1f\x7f]/g, "").slice(0, 60);
  let tag = agent === "" ? "" : ` client="${agent}"`;
  if (req.oauthClient !== undefined) tag += ` oauth_client=${req.oauthClient}`;
  return tag;
}

export async function runStdio(hub: AccountSource, config: Config): Promise<void> {
  const server = buildMcpServer(hub, config, true);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");
}

export interface AccountHealth {
  account_id: string;
  status: ConnectionStatus;
  since: string;
}

export interface HealthBody {
  ok: boolean;
  status: ConnectionStatus;
  since: string;
  default: AccountHealth;
  accounts: AccountHealth[];
}

function rowOf(row: AccountBinding): AccountHealth {
  const s = row.wa.getStatus();
  return { account_id: row.id, status: s.status, since: s.status_since };
}

function isFresh(since: string): boolean {
  return Date.now() - Date.parse(since) <= UNHEALTHY_AFTER_MS;
}

/** Liveness for /healthz: default account on top, every live account listed. */
export function healthBody(hub: AccountSource): HealthBody {
  const accounts = hub.bindings().map(rowOf);
  const primary = rowOf(hub.defaultBinding());
  const ok = accounts.some((row) => row.status === "connected" || isFresh(row.since));
  return { ok, status: primary.status, since: primary.since, default: primary, accounts };
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
  /** Test seams for the session bounds below; production takes the constants. */
  sessionTtlMs?: number;
  sessionMax?: number;
  sessionSweepMs?: number;
}

const TAKEN_PROBE_MS = 500;

/**
 * Node sets SO_REUSEADDR on every listen. On Darwin that (and an IPv4/IPv6
 * split between two listen()s) lets a second bind on a taken host:port
 * succeed, so the listening callback fires and we never see EADDRINUSE.
 * Something already accepting there is taken, even if bind would share.
 */
function takenListenPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, signal: AbortSignal.timeout(TAKEN_PROBE_MS) });
    socket.unref();
    let settled = false;
    const done = (taken: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(taken);
    };
    socket.once("connect", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      done(err.name === "AbortError" || err.code === "ABORT_ERR");
    });
  });
}

/**
 * Probe a fixed port, then exclusive listen. exclusive stops cluster handle
 * sharing; it does not clear Darwin SO_REUSEADDR. The probe is that check.
 * Port 0 has nothing to probe.
 */
async function listenHttp(server: Server, host: string, port: number): Promise<number> {
  if (port !== 0 && (await takenListenPort(host, port))) {
    const err: NodeJS.ErrnoException = new Error(`listen EADDRINUSE: address already in use ${host}:${port}`);
    err.code = "EADDRINUSE";
    throw err;
  }
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(new Error(`listen on ${host}:${port} returned no AddressInfo`));
        return;
      }
      resolve(bound.port);
    });
  });
}

/** Serve /mcp and /healthz on one address. Resolves with the bound port, so port 0 works. */
export async function startHttpEndpoint(hub: AccountSource, config: Config, endpoint: Endpoint): Promise<number> {
  // express is only needed once a listener is actually bound; a stdio server
  // with sharing off and a bridge onto a running daemon never reach here.
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const rpc =
      (req.body && typeof req.body === "object" ? (req.body as { method?: string }).method : undefined) ?? "-";
    const hasAuth = req.headers.authorization ? "auth" : "noauth";
    res.on("finish", () => {
      log(
        `HTTP ${req.method} ${req.originalUrl} rpc=${rpc} ${hasAuth} accept="${req.headers.accept ?? ""}" -> ${res.statusCode} (${Date.now() - start}ms)${callerTag(req)}`
      );
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        log(
          `HTTP ${req.method} ${req.originalUrl} rpc=${rpc} -> client closed before response (${Date.now() - start}ms)`
        );
      }
    });
    next();
  });

  if (endpoint.openRead && !endpoint.oauth) {
    log(
      "WARNING: no WAZAP_READ_TOKEN set, the /mcp endpoint is UNAUTHENTICATED. " +
        "Set WAZAP_READ_TOKEN before exposing this server beyond localhost."
    );
  }

  const oauth = endpoint.oauth;
  // A server that advertises sign-in must not also answer strangers.
  const openRead = endpoint.openRead && !oauth;
  let resourceMetadataUrl: string | null = null;
  if (oauth) {
    // The OAuth stack (the SDK's auth router and its own limiter) is the one
    // part of this endpoint only a public server pays for, so it loads here.
    const [{ mcpAuthRouter, getOAuthProtectedResourceMetadataUrl }, { rateLimit }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/auth/router.js"),
      import("express-rate-limit"),
    ]);
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
      })
    );
    app.post(
      APPROVE_PATH,
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
      express.urlencoded({ extended: false }),
      oauth.approve
    );
    log(`OAuth on: agents sign in at ${oauth.issuerUrl.href}`);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl);
  }

  // The first credential the bearer token matches decides the session's tools,
  // so a leaked read token can never message anyone. An OAuth token carries
  // the scope the person picked on the consent page.
  const bearerAccess = async (auth: string | undefined): Promise<{ write: boolean; oauthClient?: string } | null> => {
    const credential = endpoint.credentials.find((entry) => isAuthorized(auth, entry.token));
    if (credential) return { write: credential.write };
    if (oauth && auth?.startsWith("Bearer ")) {
      try {
        const info = await oauth.verifyAccessToken(auth.slice("Bearer ".length).trim());
        return { write: info.scopes.includes("write"), oauthClient: info.clientId };
      } catch {
        // An unknown or expired token opens nothing.
      }
    }
    return null;
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const access = await bearerAccess(req.headers.authorization);
    if (access) {
      (req as AuthedRequest).mcpWrite = access.write;
      (req as AuthedRequest).oauthClient = access.oauthClient;
      next();
      return;
    }
    if (openRead) {
      (req as AuthedRequest).mcpWrite = false;
      next();
      return;
    }
    // RFC 6750: a token that came and was refused is invalid_token, so the client
    // knows to refresh or sign in again; a request that sent none gets no error.
    const challenge: string[] = [];
    if (req.headers.authorization) {
      challenge.push('error="invalid_token"', 'error_description="The bearer token is unknown or has expired"');
    }
    if (resourceMetadataUrl) challenge.push(`resource_metadata="${resourceMetadataUrl}"`);
    if (challenge.length > 0) res.setHeader("WWW-Authenticate", `Bearer ${challenge.join(", ")}`);
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
  const lastSeen = new Map<string, number>();
  const sessionTtlMs = endpoint.sessionTtlMs ?? MCP_SESSION_TTL_MS;
  const sessionMax = endpoint.sessionMax ?? MCP_SESSION_MAX;

  // The map forgets the session before its transport starts closing, so a
  // request that lands mid-close is told the session is gone, by us.
  const dropSession = (sid: string): void => {
    lastSeen.delete(sid);
    const transport = transports.get(sid);
    transports.delete(sid);
    if (transport !== undefined) {
      void transport.close().catch((err: unknown) => logError("session close", err));
    }
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [sid, at] of lastSeen) if (at < cutoff) dropSession(sid);
  }, endpoint.sessionSweepMs ?? MCP_SESSION_SWEEP_MS);
  sweep.unref();

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (transport && typeof sessionId === "string") lastSeen.set(sessionId, Date.now());

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        // Session state is only needed when a client actually posts initialize;
        // loading it here keeps it off the bind path that daemon.json waits on.
        const { StreamableHTTPServerTransport } = await import(
          "@modelcontextprotocol/sdk/server/streamableHttp.js"
        );
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, newTransport);
            lastSeen.set(sid, Date.now());
            // Over the cap, the idlest session dies — a live client hit by that
            // gets a 404 and re-initializes; an abandoned one is what we wanted gone.
            if (transports.size > sessionMax) {
              let oldest: string | undefined;
              let oldestAt = Infinity;
              for (const [other, at] of lastSeen) {
                if (at < oldestAt) {
                  oldest = other;
                  oldestAt = at;
                }
              }
              if (oldest !== undefined && oldest !== sid) dropSession(oldest);
            }
          },
        });
        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid) {
            transports.delete(sid);
            lastSeen.delete(sid);
          }
        };
        // The session's tools are fixed at init by the token it authenticated with.
        const server = buildMcpServer(hub, config, (req as AuthedRequest).mcpWrite === true);
        await server.connect(newTransport);
        transport = newTransport;
      }

      if (!transport) {
        // An id we do not hold (expired, evicted, or lost to a restart) is a 404,
        // which the spec tells a client to answer with a fresh initialize. No id
        // at all means initialize never happened, and that stays a 400.
        if (typeof sessionId === "string" && sessionId !== "") {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
          return;
        }
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

  // Open to anyone, so a stranger gets liveness only: `ok`, and the default
  // socket's `status` / `since`. Which accounts exist is behind a token, read or
  // write, and names, phone and data dir stay behind it in get_status. A socket
  // that has been anything but connected for two minutes is a real outage, and
  // a 503 is what a tunnel or a monitor can act on; a reconnect in progress is
  // not. One dead account does not 503 the process while another is still up.
  app.get("/healthz", (req: Request, res: Response, next: NextFunction) => {
    const body = healthBody(hub);
    bearerAccess(req.headers.authorization)
      .then((access) => {
        const { ok, status, since } = body;
        res.status(ok ? 200 : 503).json(access === null ? { ok, status, since } : body);
      })
      .catch(next);
  });

  const server = createServer(app);
  const onAbort = (): void => {
    clearInterval(sweep);
    for (const transport of transports.values())
      void transport.close().catch((err: unknown) => logError("session close", err));
    lastSeen.clear();
    server.closeAllConnections();
    server.close();
  };
  const signal = endpoint.signal;
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) {
    onAbort();
    throw signal.reason instanceof Error ? signal.reason : new Error("The listen was aborted");
  }
  try {
    return await listenHttp(server, endpoint.host, endpoint.port);
  } catch (err) {
    signal?.removeEventListener("abort", onAbort);
    server.close();
    throw err;
  }
}

/** The endpoint the user asked for: WAZAP_HOST/WAZAP_PORT and the two configured tokens. */
export async function runHttp(hub: AccountSource, config: Config, extra?: Credential): Promise<number> {
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

  const port = await startHttpEndpoint(hub, config, {
    host: config.httpHost,
    port: config.httpPort,
    credentials,
    openRead: !config.readToken,
    oauth,
  });
  log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${port}/mcp`);
  for (const line of writesHints(config)) log(line);
  return port;
}

/** A private endpoint on an ephemeral loopback port, reachable only with the token. */
export async function startLoopbackEndpoint(hub: AccountSource, config: Config, token: string): Promise<number> {
  const port = await startHttpEndpoint(hub, config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token, write: true }],
    openRead: false,
  });
  log(`sharing this session on 127.0.0.1:${port}`);
  return port;
}
