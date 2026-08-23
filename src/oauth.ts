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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface StoredToken {
  clientId: string;
  scopes: string[];
  issuedAt: number;
  /** Access tokens expire; a refresh token lives until revoked. */
  expiresAt?: number;
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
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Failed passwords per caller. Five misses lock that caller out for fifteen
 * minutes; the SDK's own limiter caps the authorize endpoint at a hundred hits
 * in the same window, so a password cannot be brute-forced from one address
 * and a pool of addresses still gets nowhere fast.
 */
class Lockout {
  private readonly misses = new Map<string, { count: number; until: number }>();

  constructor(private readonly now: () => number) {}

  locked(key: string): boolean {
    const entry = this.misses.get(key);
    if (!entry) return false;
    if (entry.until && entry.until > this.now()) return true;
    if (entry.until) this.misses.delete(key);
    return false;
  }

  miss(key: string): void {
    const entry = this.misses.get(key) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= LOCKOUT_AFTER) {
      entry.until = this.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    this.misses.set(key, entry);
  }

  clear(key: string): void {
    this.misses.delete(key);
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

  private sweep(): void {
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
    if (dirty) this.persist();
  }

  // --- authorization -------------------------------------------------------

  /** The SDK has validated client and redirect_uri; park the request and show the page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const id = randomBytes(24).toString("hex");
    this.pending.set(id, { client, params, createdAt: this.now() });
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
      log(`oauth: wrong password from ${caller}`);
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
    const accessToken = randomBytes(32).toString("hex");
    this.state.access[sha256(accessToken)] = { clientId, scopes, issuedAt: now, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    let refreshToken = existingRefresh;
    if (!refreshToken) {
      refreshToken = randomBytes(32).toString("hex");
      this.state.refresh[sha256(refreshToken)] = { clientId, scopes, issuedAt: now };
    }
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

  /** Look the token up as either kind; the caller may not say which. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    let dirty = false;
    for (const bucket of [this.state.access, this.state.refresh]) {
      const entry = bucket[hash];
      if (entry && entry.clientId === client.client_id) {
        delete bucket[hash];
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  /** Every grant, for `wazap status` and the like. */
  grants(): Grant[] {
    return grantsOf(this.state);
  }

  // --- pages ---------------------------------------------------------------

  private consentPage(id: string, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
    const name = escapeHtml(client.client_name ?? new URL(params.redirectUri).hostname);
    const wantsWrite = normalizeScopes(params.scopes).includes("write");
    return page(
      `Connect ${name}`,
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
