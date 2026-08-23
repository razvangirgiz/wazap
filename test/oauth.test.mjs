/**
 * The OAuth flow a hosted agent walks: discover, register, send the person to
 * the consent page, trade the code for tokens, call /mcp. The SDK router is
 * exercised for real over loopback; only WhatsApp is a stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpEndpoint } from "../dist/server.js";
import { WazapOAuthProvider } from "../dist/oauth.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { offlineConfig } from "./helpers.mjs";

// The SDK refuses a plain-http issuer unless told this is a test.
process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "1";

const PASSWORD = "correct horse battery";

const stubWa = {
  getStatus: () => ({ status: "connected" }),
};

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

/** One server, one provider, torn down by the caller. */
async function boot(t, { password = PASSWORD } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-"));
  const port = await freePort();
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const oauth = new WazapOAuthProvider({ publicUrl, password, stateFile: join(dataDir, "oauth.json") });
  const config = offlineConfig("wazap-oauth-cfg-", { readOnly: false, transport: "http", dataDir });
  const stop = new AbortController();
  await startHttpEndpoint(
    stubWa,
    config,
    { host: "127.0.0.1", port, credentials: [{ token: "static-read", write: false }], openRead: false, oauth, signal: stop.signal },
    new RateLimiter(0),
  );
  t.after(() => {
    stop.abort();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = publicUrl.href.replace(/\/$/, "");
  const fetchJson = async (path, init) => {
    const res = await fetch(`${base}${path}`, { ...init, redirect: "manual" });
    return { res, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  return { base, dataDir, oauth, fetchJson };
}

/** Register a public client and open the consent page, approving nothing yet. */
async function begin(ctx, { scope } = {}) {
  const redirectUri = "https://agent.example/callback";
  const { body: client } = await ctx.fetchJson("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Poke", token_endpoint_auth_method: "none" }),
  });
  assert.ok(client.client_id, "registration returns a client_id");

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s-123",
    ...(scope ? { scope } : {}),
  });
  const { res: page, body: html } = await ctx.fetchJson(`/authorize?${query}`);
  assert.equal(page.status, 200);
  const request = /name="request" value="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(request, "consent page carries the pending request id");
  return { client, redirectUri, verifier, challenge, html, request };
}

function approve(ctx, request, fields) {
  return ctx.fetchJson("/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ request, ...fields }),
  });
}

/** The whole consent step: what the redirect back to the agent carried. */
async function grant(ctx, { access = "write", password = PASSWORD, scope } = {}) {
  const started = await begin(ctx, { scope });
  const { res: redirect } = await approve(ctx, started.request, { password, access, decision: "allow" });
  return { ...started, redirect };
}

async function exchange(ctx, { client, redirectUri, verifier, code }) {
  return ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
  });
}

async function listTools(ctx, token) {
  const init = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  });
  if (init.status !== 200) return { status: init.status };
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? text;
  const names = JSON.parse(data).result.tools.map((tool) => tool.name);
  return { status: res.status, names };
}

test("an unauthenticated call is told where to sign in", async (t) => {
  const ctx = await boot(t);
  const { res } = await ctx.fetchJson("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${ctx.base}/.well-known/oauth-protected-resource/mcp"`);

  const { body: resource } = await ctx.fetchJson("/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.resource, `${ctx.base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${ctx.base}/`]);

  const { body: as } = await ctx.fetchJson("/.well-known/oauth-authorization-server");
  assert.equal(as.registration_endpoint, `${ctx.base}/register`);
  assert.deepEqual(as.scopes_supported, ["read", "write"]);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("the static token still works with OAuth on", async (t) => {
  const ctx = await boot(t);
  const { status, names } = await listTools(ctx, "static-read");
  assert.equal(status, 200);
  assert.ok(names.includes("get_status"));
  assert.ok(!names.includes("send_message"));
});

test("a write grant walks discovery, consent, code and token, then sees the write tools", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { access: "write" });
  assert.equal(g.redirect.status, 302);
  const location = new URL(g.redirect.headers.get("location"));
  assert.equal(location.origin + location.pathname, g.redirectUri);
  assert.equal(location.searchParams.get("state"), "s-123");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const { res, body: tokens } = await exchange(ctx, { ...g, code });
  assert.equal(res.status, 200, JSON.stringify(tokens));
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, "read write");
  assert.ok(tokens.refresh_token);

  const { status, names } = await listTools(ctx, tokens.access_token);
  assert.equal(status, 200);
  assert.ok(names.includes("send_message"));

  // A code is one use.
  const replay = await exchange(ctx, { ...g, code });
  assert.equal(replay.res.status, 400);

  // The file holds hashes, never the tokens.
  const onDisk = readFileSync(join(ctx.dataDir, "oauth.json"), "utf8");
  assert.ok(!onDisk.includes(tokens.access_token));
  assert.ok(!onDisk.includes(tokens.refresh_token));
});

test("a read grant never sees a write tool, whatever the client asked for", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { access: "read", scope: "read write" });
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: tokens } = await exchange(ctx, { ...g, code });
  assert.equal(tokens.scope, "read");
  const { names } = await listTools(ctx, tokens.access_token);
  assert.ok(names.includes("get_status"));
  assert.ok(!names.includes("send_message"));
});

test("the consent page preselects what the client asked for", async (t) => {
  const ctx = await boot(t);
  const asksWrite = await grant(ctx, { scope: "read write" });
  assert.match(asksWrite.html, /value="write" checked/);
  const asksNothing = await grant(ctx);
  assert.match(asksNothing.html, /value="read" checked/);
});

test("a wrong password stays on the page, and five of them lock the caller out", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { password: "nope" });
  assert.equal(g.redirect.status, 401);

  const again = () => approve(ctx, g.request, { password: "nope", access: "read", decision: "allow" });
  for (let i = 0; i < 4; i++) assert.equal((await again()).res.status, 401);
  assert.equal((await again()).res.status, 429);
});

test("cancel sends the agent back with access_denied and no code", async (t) => {
  const ctx = await boot(t);
  const started = await begin(ctx);
  const { res } = await approve(ctx, started.request, { decision: "deny" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "s-123");
  assert.equal(location.searchParams.get("code"), null);

  // The request is spent: approving it afterwards with the right password goes nowhere.
  const { res: late } = await approve(ctx, started.request, { password: PASSWORD, access: "read", decision: "allow" });
  assert.equal(late.status, 400);
});

test("a refresh keeps the grant, a revoke ends it, and a restart remembers both", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: first } = await exchange(ctx, { ...g, code });

  const { res, body: second } = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: g.client.client_id }),
  });
  assert.equal(res.status, 200, JSON.stringify(second));
  assert.notEqual(second.access_token, first.access_token);
  assert.equal(second.scope, "read write");

  // Another process reading the same file sees the grant.
  const reloaded = new WazapOAuthProvider({ publicUrl: new URL(ctx.base), password: PASSWORD, stateFile: join(ctx.dataDir, "oauth.json") });
  const info = await reloaded.verifyAccessToken(second.access_token);
  assert.deepEqual(info.scopes, ["read", "write"]);
  assert.equal(reloaded.grants().length, 1);
  assert.equal(reloaded.grants()[0].client, "Poke");

  const { res: revoked } = await ctx.fetchJson("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token: second.access_token, client_id: g.client.client_id }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await listTools(ctx, second.access_token)).status, 401);
  assert.ok(existsSync(join(ctx.dataDir, "oauth.json")));
});

test("an expired access token is refused and swept", async (t) => {
  let now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-exp-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const provider = new WazapOAuthProvider({
    publicUrl: new URL("https://wazap.example"),
    password: PASSWORD,
    stateFile: join(dataDir, "oauth.json"),
    now: () => now,
  });
  const client = await provider.clientsStore.registerClient({ redirect_uris: ["https://a.example/cb"], client_name: "x" });
  // Reach into the flow the way /oauth/approve does, without HTTP.
  const tokens = provider["issue"](client.client_id, ["read"]);
  assert.deepEqual((await provider.verifyAccessToken(tokens.access_token)).scopes, ["read"]);
  now += 25 * 60 * 60 * 1000;
  await assert.rejects(() => provider.verifyAccessToken(tokens.access_token), /expired/);
  provider["sweep"]();
  const onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(onDisk.access, {});
  assert.equal(Object.keys(onDisk.refresh).length, 1);
});
