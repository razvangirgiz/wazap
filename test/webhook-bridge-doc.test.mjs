/**
 * The receiver docs/api-and-webhooks.md prints for a service that wants its own
 * Authorization header, taken out of the document and run. A snippet that has
 * stopped working is worse than none, so the doc is the source and this is the
 * check: it is signed with wazap's own signing function, so a change to the
 * signature scheme fails here and not in front of someone copying the script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { webhookSignature } from "../dist/webhook.js";

const doc = readFileSync(fileURLToPath(new URL("../docs/api-and-webhooks.md", import.meta.url)), "utf8");
const block = /```js\n(\/\/ webhook-bridge\.mjs[\s\S]*?)```/.exec(doc);
const SECRET = "test-secret-not-a-real-one";
const TOKEN = "service-token";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** The service the bridge forwards to: records what it is sent and answers with `status`. */
async function service(status) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), method: req.method });
      res.writeHead(status.value).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startBridge(target) {
  assert.ok(block, "docs/api-and-webhooks.md has no webhook-bridge.mjs snippet");
  const dir = mkdtempSync(join(tmpdir(), "wazap-bridge-"));
  const file = join(dir, "webhook-bridge.mjs");
  writeFileSync(file, block[1]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--no-warnings", file], {
    env: { ...process.env, TARGET: target, TARGET_TOKEN: TOKEN, WAZAP_WEBHOOK_SECRET: SECRET, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the bridge exited: ${stderr}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

const event = JSON.stringify({ event: "message_received", text: "salut", message_id: "m1", account_id: "default" });

function post(url, body, headers = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

test("the documented bridge passes a signed event on with the service's own header, byte for byte", async (t) => {
  const status = { value: 200 };
  const target = await service(status);
  const bridge = await startBridge(target.url);
  t.after(async () => {
    bridge.stop();
    await target.close();
  });

  const res = await post(bridge.url, event, { "x-wazap-event": "message_received", "x-wazap-signature": webhookSignature(event, SECRET) });
  assert.equal(res.status, 200);
  assert.equal(target.seen.length, 1);
  assert.equal(target.seen[0].body, event, "the body is the one wazap signed");
  assert.equal(target.seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(target.seen[0].headers["x-wazap-event"], "message_received");
});

test("the documented bridge hands the service's verdict back, so wazap retries a 5xx and treats a 401 as a refusal", async (t) => {
  const status = { value: 401 };
  const target = await service(status);
  const bridge = await startBridge(target.url);
  t.after(async () => {
    bridge.stop();
    await target.close();
  });
  const signed = { "x-wazap-signature": webhookSignature(event, SECRET) };
  assert.equal((await post(bridge.url, event, signed)).status, 401, "a revoked token comes back as a 401");
  status.value = 503;
  assert.equal((await post(bridge.url, event, signed)).status, 503, "an unavailable service comes back as a 503");
});

test("the documented bridge refuses what wazap did not sign, and forwards nothing", async (t) => {
  const status = { value: 200 };
  const target = await service(status);
  const bridge = await startBridge(target.url);
  t.after(async () => {
    bridge.stop();
    await target.close();
  });
  assert.equal((await post(bridge.url, event)).status, 401, "no signature");
  assert.equal((await post(bridge.url, event, { "x-wazap-signature": webhookSignature(event, "another-secret") })).status, 401, "another secret");
  assert.equal((await post(bridge.url, event + " ", { "x-wazap-signature": webhookSignature(event, SECRET) })).status, 401, "a body that was changed");
  assert.equal((await fetch(bridge.url)).status, 405, "and only POST is taken");
  assert.equal(target.seen.length, 0, "the service heard none of it");
});

test("the documented bridge answers 502 when the service cannot be reached, which wazap retries", async (t) => {
  const dead = await freePort();
  const bridge = await startBridge(`http://127.0.0.1:${dead}/hook`);
  t.after(() => bridge.stop());
  const res = await post(bridge.url, event, { "x-wazap-signature": webhookSignature(event, SECRET) });
  assert.equal(res.status, 502);
});
