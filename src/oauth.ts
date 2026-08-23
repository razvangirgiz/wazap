/**
 * OAuth 2.1 for hosted agents. claude.ai, ChatGPT and Poke's OAuth mode will
 * not take a static bearer token; they discover an authorization server, register
 * themselves (RFC 7591), send the person to a login page and trade a code for
 * tokens. The SDK's router does discovery, registration, PKCE and the token
 * endpoint. This file is the part it cannot know: a login page guarded by one
 * password, which scope the person granted, and where the tokens live.
 *
 * There is one user. The password in WAZAP_OAUTH_PASSWORD is the whole identity
 * layer, so every grant is a deliberate act on the consent page, and the page
 * asks read or write the way `wazap login` does.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { WAZAP_VERSION } from "./config.js";
import { log } from "./logger.js";

export const OAUTH_SCOPES = ["read", "write"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** The consent form posts here; mounted by server.ts next to the SDK router. */
export const APPROVE_PATH = "/oauth/approve";

const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** A refresh token nobody has used in this long is a forgotten one. */
const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** A client that registered and never finished consent. */
const CLIENT_ORPHAN_MS = 60 * 60 * 1000;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Wrong passwords from everywhere, together, before the page closes for a while. */
const GLOBAL_LOCKOUT_AFTER = 20;
/** Wrong passwords one consent page takes before it is thrown away. */
const PENDING_MISSES = 3;

const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

/**
 * OAuth needs both halves and an issuer the SDK and a browser will accept:
 * https (or loopback, for tests), no path, since every endpoint is mounted at
 * the root of whatever host this is.
 */
export function oauthProblem(config: { publicUrl: string | null; oauthPassword: string | null }): string | null {
  if (!config.publicUrl && !config.oauthPassword) return null;
  if (!config.publicUrl) return "WAZAP_OAUTH_PASSWORD is set but WAZAP_PUBLIC_URL is not. Set both, or neither.";
  if (!config.oauthPassword) return "WAZAP_PUBLIC_URL is set but WAZAP_OAUTH_PASSWORD is not. Set both, or neither.";
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    return `WAZAP_PUBLIC_URL is not a URL: ${config.publicUrl}`;
  }
  if (url.search || url.hash) return "WAZAP_PUBLIC_URL must not carry a query or a fragment.";
  if (url.pathname !== "/") {
    return "WAZAP_PUBLIC_URL must be a bare origin: the OAuth endpoints live at its root, not under a path.";
  }
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
    return "WAZAP_PUBLIC_URL must be https, since agents will send a password to it.";
  }
  if (config.oauthPassword.length < 8) return "WAZAP_OAUTH_PASSWORD is shorter than 8 characters.";
  return null;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  issuedAt: number;
  /** Access tokens expire; a refresh token lives until revoked or forgotten. */
  expiresAt?: number;
  /** Access only: the hash of the refresh token that minted it, so revoking one ends the other. */
  refresh?: string;
  /** Refresh only: the last time it minted an access token. */
  lastUsedAt?: number;
}

interface OAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by the SHA-256 of the token, so the file leaks nothing usable. */
  access: Record<string, StoredToken>;
  refresh: Record<string, StoredToken>;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
  misses: number;
}

interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
}

export interface OAuthOptions {
  /** Where clients reach this server from the outside; the issuer and the resource. */
  publicUrl: URL;
  password: string;
  /** oauth.json goes here. */
  stateFile: string;
  now?: () => number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Keep the scopes we know; a client asking for nothing gets read. */
function normalizeScopes(requested: string[] | undefined): OAuthScope[] {
  const known = (requested ?? []).filter((s): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s));
  return known.length > 0 ? Array.from(new Set(known)) : ["read"];
}

function emptyState(): OAuthState {
  return { clients: {}, access: {}, refresh: {} };
}

function loadState(file: string): OAuthState {
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OAuthState>;
    return {
      clients: parsed.clients ?? {},
      access: parsed.access ?? {},
      refresh: parsed.refresh ?? {},
    };
  } catch (err) {
    log(`oauth.json unreadable (${err instanceof Error ? err.message : String(err)}), starting with no grants`);
    return emptyState();
  }
}

function saveState(file: string, state: OAuthState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // The mode argument only applies on creation; the chmod covers a leftover temp file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Failed passwords, per caller and in total. Five misses lock that caller out
 * for fifteen minutes; twenty misses from anywhere lock the page for everyone,
 * so rotating addresses buys an attacker nothing. A consent page itself takes
 * three wrong passwords and is then gone, which makes every further guess cost
 * a fresh /authorize, an endpoint the SDK rate-limits.
 */
class Lockout {
  private readonly misses = new Map<string, { count: number; at: number; until: number }>();
  private global = { count: 0, at: 0, until: 0 };

  constructor(private readonly now: () => number) {}

  locked(key: string): boolean {
    const now = this.now();
    if (this.global.until > now) return true;
    const entry = this.misses.get(key);
    return entry !== undefined && entry.until > now;
  }

  miss(key: string): void {
    const now = this.now();
    const entry = this.misses.get(key) ?? { count: 0, at: now, until: 0 };
    entry.count += 1;
    entry.at = now;
    if (entry.count >= LOCKOUT_AFTER) {
      entry.until = now + LOCKOUT_MS;
      entry.count = 0;
    }
    this.misses.set(key, entry);

    if (now - this.global.at > LOCKOUT_MS) this.global = { count: 0, at: now, until: 0 };
    this.global.count += 1;
    if (this.global.count >= GLOBAL_LOCKOUT_AFTER) {
      this.global = { count: 0, at: now, until: now + LOCKOUT_MS };
      log("oauth: too many wrong passwords from everywhere, consent closed for fifteen minutes");
    }
  }

  clear(key: string): void {
    this.misses.delete(key);
  }

  /** Forget callers whose misses are older than the window. */
  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.misses) {
      if (entry.until <= now && now - entry.at > LOCKOUT_MS) this.misses.delete(key);
    }
  }
}

export interface Grant {
  client: string;
  scopes: string[];
  issuedAt: number;
}

function grantsOf(state: OAuthState): Grant[] {
  return Object.values(state.refresh).map((entry) => ({
    client: state.clients[entry.clientId]?.client_name ?? entry.clientId,
    scopes: entry.scopes,
    issuedAt: entry.issuedAt,
  }));
}

/** The grants on disk, read by a process that is not the server. */
export function readGrants(stateFile: string): Grant[] {
  return grantsOf(loadState(stateFile));
}

export class WazapOAuthProvider implements OAuthServerProvider {
  private readonly state: OAuthState;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly lockout: Lockout;
  private readonly now: () => number;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly options: OAuthOptions) {
    this.now = options.now ?? Date.now;
    this.state = loadState(options.stateFile);
    this.lockout = new Lockout(this.now);
    this.clientsStore = {
      getClient: (clientId) => this.state.clients[clientId],
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomBytes(16).toString("hex"),
          client_id_issued_at: Math.floor(this.now() / 1000),
        };
        this.state.clients[full.client_id] = full;
        this.persist();
        log(`oauth: registered client "${full.client_name ?? full.client_id}"`);
        return full;
      },
    };
  }

  /** The authorization server and the protected resource are one process. */
  get issuerUrl(): URL {
    return this.options.publicUrl;
  }

  get resourceUrl(): URL {
    return new URL("/mcp", this.options.publicUrl);
  }

  private persist(): void {
    saveState(this.options.stateFile, this.state);
  }

  /** Deleting oauth.json is the documented way to sign everyone out; honour it while running. */
  private sync(): void {
    const populated =
      Object.keys(this.state.clients).length + Object.keys(this.state.access).length + Object.keys(this.state.refresh).length > 0;
    if (populated && !existsSync(this.options.stateFile)) {
      log("oauth: oauth.json is gone, every grant is revoked");
      this.state.clients = {};
      this.state.access = {};
      this.state.refresh = {};
      this.codes.clear();
    }
  }

  private sweep(): void {
    this.sync();
    this.lockout.prune();
    const now = this.now();
    for (const [id, entry] of this.pending) if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    for (const [code, entry] of this.codes) if (now - entry.createdAt > CODE_TTL_MS) this.codes.delete(code);

    let dirty = false;
    for (const [hash, entry] of Object.entries(this.state.access)) {
      if (entry.expiresAt !== undefined && entry.expiresAt < now) {
        delete this.state.access[hash];
        dirty = true;
      }
    }
    for (const [hash, entry] of Object.entries(this.state.refresh)) {
      if (now - (entry.lastUsedAt ?? entry.issuedAt) > REFRESH_IDLE_MS) {
        delete this.state.refresh[hash];
        dirty = true;
      }
    }
    // A client with no grant and nothing in flight is a registration nobody finished.
    const holding = new Set<string>();
    for (const entry of Object.values(this.state.refresh)) holding.add(entry.clientId);
    for (const entry of Object.values(this.state.access)) holding.add(entry.clientId);
    for (const entry of this.pending.values()) holding.add(entry.client.client_id);
    for (const entry of this.codes.values()) holding.add(entry.clientId);
    for (const [id, client] of Object.entries(this.state.clients)) {
      const issuedAt = (client.client_id_issued_at ?? 0) * 1000;
      if (!holding.has(id) && now - issuedAt > CLIENT_ORPHAN_MS) {
        delete this.state.clients[id];
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  // --- authorization -------------------------------------------------------

  /** The SDK has validated client and redirect_uri; park the request and show the page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const id = randomBytes(24).toString("hex");
    this.pending.set(id, { client, params, createdAt: this.now(), misses: 0 });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).type("html").send(this.consentPage(id, client, params));
  }

  /** Express handler for the consent form. Mount with urlencoded parsing. */
  approve = (req: Request, res: Response): void => {
    this.sweep();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.request === "string" ? body.request : "";
    const entry = this.pending.get(id);
    if (!entry) {
      res.status(400).type("html").send(this.messagePage("This sign-in link has expired. Go back to the agent and connect again."));
      return;
    }

    const { client, params } = entry;
    const fail = (error: string, description: string): void => {
      this.pending.delete(id);
      const url = new URL(params.redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (params.state) url.searchParams.set("state", params.state);
      res.redirect(url.href);
    };

    if (body.decision !== "allow") {
      fail("access_denied", "The user declined.");
      return;
    }

    const caller = req.ip ?? "unknown";
    if (this.lockout.locked(caller)) {
      res.status(429).type("html").send(this.messagePage("Too many wrong passwords. Try again in fifteen minutes."));
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!sameSecret(password, this.options.password)) {
      this.lockout.miss(caller);
      entry.misses += 1;
      log(`oauth: wrong password from ${caller}`);
      if (entry.misses >= PENDING_MISSES) {
        this.pending.delete(id);
        res.status(401).type("html").send(this.messagePage("Wrong password, three times. Go back to the agent and connect again."));
        return;
      }
      res.status(401).type("html").send(this.consentPage(id, client, params, "Wrong password."));
      return;
    }
    this.lockout.clear(caller);
    this.pending.delete(id);

    const scopes: string[] = body.access === "write" ? ["read", "write"] : ["read"];
    const code = randomBytes(32).toString("hex");
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes,
      createdAt: this.now(),
    });
    log(`oauth: granted ${scopes.join("+")} to "${client.client_name ?? client.client_id}"`);

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    res.redirect(url.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    this.sweep();
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    // One use: a replayed code must fail even inside its ten minutes.
    this.codes.delete(code);
    return this.issue(client.client_id, entry.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    this.sweep();
    const entry = this.state.refresh[sha256(refreshToken)];
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Unknown refresh token");
    // A refresh may narrow the grant, never widen it.
    const granted = scopes && scopes.length > 0 ? scopes.filter((s) => entry.scopes.includes(s)) : entry.scopes;
    if (granted.length === 0) throw new InvalidScopeError("Requested scopes exceed the grant");
    return this.issue(client.client_id, granted, refreshToken);
  }

  private issue(clientId: string, scopes: string[], existingRefresh?: string): OAuthTokens {
    const now = this.now();
    let refreshToken = existingRefresh;
    if (!refreshToken) {
      refreshToken = randomBytes(32).toString("hex");
      this.state.refresh[sha256(refreshToken)] = { clientId, scopes, issuedAt: now, lastUsedAt: now };
    } else {
      const refresh = this.state.refresh[sha256(refreshToken)];
      if (refresh) refresh.lastUsedAt = now;
    }
    const accessToken = randomBytes(32).toString("hex");
    this.state.access[sha256(accessToken)] = {
      clientId,
      scopes,
      issuedAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      refresh: sha256(refreshToken),
    };
    this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.sync();
    const entry = this.state.access[sha256(token)];
    if (!entry) throw new InvalidTokenError("Unknown access token");
    if (entry.expiresAt !== undefined && entry.expiresAt < this.now()) throw new InvalidTokenError("Access token expired");
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt === undefined ? undefined : Math.floor(entry.expiresAt / 1000),
      resource: this.resourceUrl,
    };
  }

  /**
   * Look the token up as either kind; the caller may not say which. Revoking a
   * refresh token also ends every access token it minted, so "disconnect" in
   * an agent's settings means disconnected now, not in up to a day.
   */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.sync();
    const hash = sha256(request.token);
    let dirty = false;
    const access = this.state.access[hash];
    if (access && access.clientId === client.client_id) {
      delete this.state.access[hash];
      dirty = true;
    }
    const refresh = this.state.refresh[hash];
    if (refresh && refresh.clientId === client.client_id) {
      delete this.state.refresh[hash];
      for (const [accessHash, entry] of Object.entries(this.state.access)) {
        if (entry.refresh === hash) delete this.state.access[accessHash];
      }
      dirty = true;
    }
    if (dirty) this.persist();
  }

  /** Every grant, for `wazap status` and the like. */
  grants(): Grant[] {
    this.sync();
    return grantsOf(this.state);
  }

  // --- pages ---------------------------------------------------------------

  private consentPage(id: string, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
    const rawName = client.client_name ?? new URL(params.redirectUri).hostname;
    const name = escapeHtml(rawName);
    const wantsWrite = normalizeScopes(params.scopes).includes("write");
    return page(
      `Connect ${rawName}`,
      `
<h1>Connect <strong>${name}</strong> to WhatsApp?</h1>
<p>This agent wants to use the WhatsApp account behind this wazap.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${APPROVE_PATH}">
  <input type="hidden" name="request" value="${id}">
  <fieldset>
    <legend>What may it do?</legend>
    <label><input type="radio" name="access" value="read"${wantsWrite ? "" : " checked"}> Read chats and contacts</label>
    <label><input type="radio" name="access" value="write"${wantsWrite ? " checked" : ""}> Read, and send messages as you</label>
  </fieldset>
  <label class="field">wazap password
    <input type="password" name="password" autocomplete="current-password" autofocus required>
  </label>
  <div class="actions">
    <button type="submit" name="decision" value="allow">Connect</button>
    <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Cancel</button>
  </div>
</form>`,
    );
  }

  private messagePage(text: string): string {
    return page("wazap", `<h1>wazap</h1><p>${escapeHtml(text)}</p>`);
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · wazap</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { width: min(28rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  fieldset { border: 0; padding: 0; margin: 0 0 1rem; }
  legend { font-weight: 600; margin-bottom: .25rem; }
  label { display: block; margin: .25rem 0; }
  .field { font-weight: 600; margin-bottom: 1rem; }
  .field input { display: block; width: 100%; box-sizing: border-box; margin-top: .25rem; padding: .5rem .6rem; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 8px; background: Field; color: FieldText; }
  .actions { display: flex; gap: .5rem; }
  button { font: inherit; padding: .55rem 1rem; border-radius: 8px; border: 1px solid #25d366; background: #25d366; color: #062b14; cursor: pointer; }
  button.secondary { background: transparent; border-color: color-mix(in srgb, CanvasText 30%, transparent); color: inherit; }
  .error { color: #c62828; font-weight: 600; }
  footer { margin-top: 1.5rem; font-size: .8rem; opacity: .6; }
</style>
</head>
<body>
<main>
${body}
<footer>wazap ${escapeHtml(WAZAP_VERSION)}</footer>
</main>
</body>
</html>`;
}
