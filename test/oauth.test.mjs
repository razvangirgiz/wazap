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
import { WazapOAuthProvider, oauthProblem } from "../dist/oauth.js";
import { offlineConfig } from "./helpers.mjs";

// The SDK refuses a plain-http issuer unless told this is a test.
process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "1";

const PASSWORD = "correct horse battery";

const stubWa = {
  getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }),
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
async function boot(t, { password = PASSWORD, credentials = [{ token: "static-read", write: false }] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-"));
  const port = await freePort();
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const oauth = new WazapOAuthProvider({ publicUrl, password, stateFile: join(dataDir, "oauth.json") });
  const config = offlineConfig("wazap-oauth-cfg-", { readOnly: false, transport: "http", dataDir });
  const stop = new AbortController();
  await startHttpEndpoint(stubWa, config, {
    host: "127.0.0.1",
    port,
    credentials,
    openRead: credentials.length === 0,
    oauth,
    signal: stop.signal,
  });
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
async function begin(ctx, { scope, clientName = "Poke", authMethod = "none" } = {}) {
  const redirectUri = "https://agent.example/callback";
  const { body: client } = await ctx.fetchJson("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: clientName, token_endpoint_auth_method: authMethod }),
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
async function grant(ctx, { access = "write", password = PASSWORD, ...rest } = {}) {
  const started = await begin(ctx, rest);
  const { res: redirect } = await approve(ctx, started.request, { password, access, decision: "allow" });
  return { ...started, redirect };
}

async function exchange(ctx, { client, redirectUri, verifier, code }) {
  return ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      redirect_uri: redirectUri,
    }),
  });
}

/** Register, consent and exchange in one go. */
async function signIn(ctx, options) {
  const g = await grant(ctx, options);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: tokens } = await exchange(ctx, { ...g, code });
  return { ...g, tokens };
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
  assert.ok(!names.includes("confirm_send"));
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
  assert.ok(names.includes("confirm_send"));

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
  assert.ok(!names.includes("confirm_send"));
});

test("the consent page defaults to read even when the client requests write", async (t) => {
  const ctx = await boot(t);
  const asksWrite = await grant(ctx, { scope: "read write" });
  assert.match(asksWrite.html, /value="read" checked/);
  assert.doesNotMatch(asksWrite.html, /value="write" checked/);
  const asksNothing = await grant(ctx);
  assert.match(asksNothing.html, /value="read" checked/);
});

test("a wrong password stays on the page twice, the third throws the page away, five lock the caller out", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { password: "nope" });
  assert.equal(g.redirect.status, 401);

  const again = (request) => approve(ctx, request, { password: "nope", access: "read", decision: "allow" });
  assert.equal((await again(g.request)).res.status, 401);
  const third = await again(g.request);
  assert.equal(third.res.status, 401);
  assert.match(third.body, /three times/);
  // The page is gone: the right password on it goes nowhere.
  assert.equal((await approve(ctx, g.request, { password: PASSWORD, access: "read", decision: "allow" })).res.status, 400);

  const fresh = await begin(ctx);
  assert.equal((await again(fresh.request)).res.status, 401);
  assert.equal((await again(fresh.request)).res.status, 401);
  assert.equal((await again((await begin(ctx)).request)).res.status, 429);
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

test("with no static token and OAuth on, nobody gets in without signing in", async (t) => {
  const ctx = await boot(t, { credentials: [] });
  const { res } = await ctx.fetchJson("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.equal((await listTools(ctx, "anything")).status, 401);

  const { tokens } = await signIn(ctx, { access: "write" });
  const { names } = await listTools(ctx, tokens.access_token);
  assert.ok(names.includes("send_message"), "a write grant is not downgraded by the missing read token");
  assert.ok(names.includes("confirm_send"));
});

test("revoking the refresh token ends the access tokens it minted", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  const { res } = await ctx.fetchJson("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token: tokens.refresh_token, client_id: client.client_id }),
  });
  assert.equal(res.status, 200);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
  assert.equal(ctx.oauth.grants().length, 0);
});

test("deleting oauth.json signs everyone out of a running server", async (t) => {
  const ctx = await boot(t);
  const { tokens } = await signIn(ctx);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  rmSync(join(ctx.dataDir, "oauth.json"));
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
  assert.equal(ctx.oauth.grants().length, 0);
  // The next write must not resurrect the old grants.
  const second = await signIn(ctx);
  assert.equal(ctx.oauth.grants().length, 1);
  assert.equal((await listTools(ctx, second.tokens.access_token)).status, 200);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
});

test("a confidential client keeps its secret for good", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx, { authMethod: "client_secret_post" });
  assert.ok(client.client_secret);
  assert.equal(client.client_secret_expires_at, 0);
  assert.equal(tokens.scope, "read write");
});

test("a client name with markup is shown, not run, and escaped once", async (t) => {
  const ctx = await boot(t);
  const { html } = await begin(ctx, { clientName: "Poke & <Co>" });
  assert.match(html, /<title>Connect Poke &amp; &lt;Co&gt; · wazap<\/title>/);
  assert.match(html, /<strong>Poke &amp; &lt;Co&gt;<\/strong>/);
  assert.ok(!html.includes("<Co>"));
});

test("a forgotten refresh token and an orphaned registration are swept", async (t) => {
  let now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-sweep-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const provider = new WazapOAuthProvider({
    publicUrl: new URL("https://wazap.example"),
    password: PASSWORD,
    stateFile: join(dataDir, "oauth.json"),
    now: () => now,
  });
  const used = await provider.clientsStore.registerClient({ redirect_uris: ["https://a.example/cb"], client_name: "used" });
  await provider.clientsStore.registerClient({ redirect_uris: ["https://b.example/cb"], client_name: "orphan" });
  provider["issue"](used.client_id, ["read"]);
  assert.equal(provider.grants().length, 1);

  now += 2 * 60 * 60 * 1000;
  provider["sweep"]();
  let onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(Object.values(onDisk.clients).map((c) => c.client_name), ["used"]);
  assert.equal(Object.keys(onDisk.refresh).length, 1);

  now += 91 * 24 * 60 * 60 * 1000;
  provider["sweep"]();
  onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(onDisk.refresh, {});
  assert.deepEqual(onDisk.clients, {});
});

test("oauthProblem names what is missing or wrong", () => {
  assert.equal(oauthProblem({ publicUrl: null, oauthPassword: null }), null);
  assert.match(oauthProblem({ publicUrl: null, oauthPassword: "x".repeat(12) }), /WAZAP_PUBLIC_URL is not/);
  assert.match(oauthProblem({ publicUrl: "https://h.example", oauthPassword: null }), /WAZAP_OAUTH_PASSWORD is not/);
  assert.match(oauthProblem({ publicUrl: "http://h.example", oauthPassword: "x".repeat(12) }), /https/);
  assert.match(oauthProblem({ publicUrl: "https://h.example/wazap", oauthPassword: "x".repeat(12) }), /bare origin/);
  assert.match(oauthProblem({ publicUrl: "https://h.example", oauthPassword: "short" }), /shorter/);
  assert.equal(oauthProblem({ publicUrl: "https://h.example", oauthPassword: "x".repeat(12) }), null);
  assert.equal(oauthProblem({ publicUrl: "http://127.0.0.1:8766", oauthPassword: "x".repeat(12) }), null);
});

test('OAuth refresh preserves session identity but another grant cannot borrow it',async t=>{
 const ctx=await boot(t);const a=await signIn(ctx,{access:'write'});const b=await signIn(ctx,{access:'write'});
 const request=async(token,method,sid)=>fetch(`${ctx.base}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream',...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'security',version:'1'}}:{}})});
 const init=await request(a.tokens.access_token,'initialize');const sid=init.headers.get('mcp-session-id');await init.text();
 const wrong=await request(b.tokens.access_token,'tools/list',sid);assert.equal(wrong.status,403);await wrong.text();
 const refreshed=await ctx.oauth.exchangeRefreshToken(a.client,a.tokens.refresh_token);
 const ok=await request(refreshed.access_token,'tools/list',sid);assert.equal(ok.status,200);await ok.text();
 await ctx.oauth.revokeToken(a.client,{token:a.tokens.refresh_token});const revoked=await request(refreshed.access_token,'tools/list',sid);assert.equal(revoked.status,401);await revoked.text();
});
