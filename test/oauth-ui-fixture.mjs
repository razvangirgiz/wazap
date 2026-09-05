import { Accounts } from "../dist/accounts.js";
import { AccountManager } from "../dist/account-manager.js";
// Manual browser fixture. This never connects to WhatsApp. Password: synthetic-test-password.
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startHttpEndpoint } from "../dist/server.js";
import { WazapOAuthProvider } from "../dist/oauth.js";
import { offlineConfig } from "./helpers.mjs";
process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "1";
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const url = new URL(`http://127.0.0.1:${port}`);
const config = offlineConfig("wazap-ui-", { readOnly: false });
const multi = process.argv.includes("--multi");
const registry = new Accounts(config.dataDir);
if (multi) { registry.add("Personal"); registry.add("Business"); }
const manager = multi ? new AccountManager(config, () => ({ start: async () => {}, stop: async () => {}, getStatus: () => ({ status: "not_linked", status_since: new Date().toISOString(), read_only: true }) })) : null;
if (manager) await manager.start();
const oauth = new WazapOAuthProvider({
  publicUrl: url,
  password: "synthetic-test-password",
  stateFile: join(config.dataDir, "oauth.json"),
  accounts: multi ? () => registry.list().map(a => ({ id: a.id, name: a.name })) : undefined,
});
const stop = new AbortController();
process.on("SIGTERM", () => {
  stop.abort();
  process.exit(0);
});
await startHttpEndpoint(
  manager ?? { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) },
  config,
  { host: "127.0.0.1", port, credentials: [], openRead: false, oauth, signal: stop.signal },
);
const callback = createHttpServer(async (req, res) => {
  const query = new URL(req.url, "http://localhost").searchParams;
  let granted = "";
  if (multi && query.has("code")) {
    try {
      const tokens = await oauth.exchangeAuthorizationCode(client, query.get("code"));
      const info = await oauth.verifyAccessToken(tokens.access_token);
      granted = `<p>Conturi autorizate: ${registry.list().filter(a => info.extra.accountIds.includes(a.id)).map(a => a.name).join(", ")}. Acces: ${info.scopes.join(", ")}.</p>`;
    } catch { query.set("error", "verification_failed"); }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<!doctype html><html><body style="font:20px system-ui;padding:48px"><h1>' +
      (query.has("error") ? "Acces refuzat" : "Conectare reușită") +
      "</h1>" + granted + "<p>Client fictiv. Niciun cont WhatsApp real nu a fost accesat.</p></body></html>",
  );
});
await new Promise((r) => callback.listen(0, "127.0.0.1", r));
const redirect = `http://127.0.0.1:${callback.address().port}/callback`;
const client = await oauth.clientsStore.registerClient({
  redirect_uris: [redirect],
  client_name: "Wazap review fixture",
  token_endpoint_auth_method: "none",
});
const query = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirect,
  response_type: "code",
  code_challenge: createHash("sha256")
    .update("synthetic-verifier-for-test-only-1234567890123456789")
    .digest("base64url"),
  code_challenge_method: "S256",
  state: "fixture",
  scope: "read",
});
console.log(`${url.origin}/authorize?${query}`);
