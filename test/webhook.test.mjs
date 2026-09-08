/**
 * W1 outbound webhook: config validation, HMAC of the raw body, and a failed
 * POST that must not take down the WhatsApp path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { webhookCheck } from "../dist/doctor.js";
import {
  WebhookSink,
  readWebhookSettings,
  requireWebhookUrl,
  webhookSignature,
  webhookSignatureMatches,
} from "../dist/webhook.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, waitFor } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const SECRET = "webhook-test-secret";
const WEBHOOK_KEYS = ["WAZAP_WEBHOOK", "WAZAP_WEBHOOK_URL", "WAZAP_WEBHOOK_SECRET"];

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-webhook-"), { mode: 0o700 });
}

function childEnv(extra = {}) {
  const env = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_TRANSCRIBE: "off" };
  for (const key of WEBHOOK_KEYS) delete env[key];
  return { ...env, ...extra };
}

function status(dir, args = [], env = {}) {
  return run(process.execPath, [binary, "status", "--data-dir", dir, ...args], { env: childEnv(env) });
}

function wazap(dir, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args, "--data-dir", dir], { env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function textMessage(id, body, at = Date.now()) {
  return {
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { conversation: body },
  };
}

test("webhook is off unless WAZAP_WEBHOOK is an on-value", () => {
  assert.equal(readWebhookSettings({}).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "off" }).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "0" }).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "on" }).kind, "invalid");
});

test("on without a URL or secret is invalid, and names what is missing", () => {
  const both = readWebhookSettings({ WAZAP_WEBHOOK: "on" });
  assert.equal(both.kind, "invalid");
  assert.match(both.detail, /URL or a secret/);
  assert.match(both.fix, /wazap config webhook on/);

  const noUrl = readWebhookSettings({ WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_SECRET: SECRET });
  assert.equal(noUrl.kind, "invalid");
  assert.match(noUrl.detail, /without a URL/);

  const noSecret = readWebhookSettings({ WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "https://hooks.example/wazap" });
  assert.equal(noSecret.kind, "invalid");
  assert.match(noSecret.detail, /without a secret/);
});

test("on with a URL and a secret is ready, and a trailing slash is stripped", () => {
  const settings = readWebhookSettings({
    WAZAP_WEBHOOK: "yes",
    WAZAP_WEBHOOK_URL: "https://hooks.example/wazap///",
    WAZAP_WEBHOOK_SECRET: `  "${SECRET}"  `,
  });
  assert.deepEqual(settings, { kind: "ready", url: "https://hooks.example/wazap", secret: SECRET });
});

test("an unknown WAZAP_WEBHOOK value is invalid rather than silently on", () => {
  const settings = readWebhookSettings({ WAZAP_WEBHOOK: "maybe" });
  assert.equal(settings.kind, "invalid");
  assert.match(settings.detail, /maybe/);
});

test("plain http is refused unless it points at this machine", () => {
  assert.throws(() => requireWebhookUrl("http://example.com/hook"), (err) => {
    assert.match(err.message, /non-https/);
    return true;
  });
  assert.equal(requireWebhookUrl("http://127.0.0.1:9/hook"), "http://127.0.0.1:9/hook");
  assert.equal(requireWebhookUrl("https://hooks.example/wazap"), "https://hooks.example/wazap");
});

test("the signature is HMAC-SHA256 of the exact raw body", () => {
  const body = '{"event":"message_received"}';
  const header = webhookSignature(body, SECRET);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(webhookSignatureMatches(body, SECRET, header), true);
  assert.equal(webhookSignatureMatches(body, "other", header), false);
  assert.equal(webhookSignatureMatches(`${body} `, SECRET, header), false);
});

test("a ready sink POSTs message_received with a matching signature", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    const body = await readBody(req);
    received.push({
      path: req.url,
      event: req.headers["x-wazap-event"],
      signature: req.headers["x-wazap-signature"],
      type: req.headers["content-type"],
      body,
    });
    res.writeHead(204);
    res.end();
  });

  const sink = new WebhookSink({
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  await sink.notify({
    message_id: "false_40700000002@s.whatsapp.net_ABC",
    chat_id: PEER,
    from_me: false,
    type: "text",
    text: "salut",
    timestamp: "2026-09-08T14:00:00+00:00",
    sender: { id: PEER, name: "Ana" },
  });

  assert.equal(received.length, 1);
  const hit = received[0];
  assert.equal(hit.path, "/hook");
  assert.equal(hit.event, "message_received");
  assert.match(hit.type, /application\/json/);
  assert.equal(webhookSignatureMatches(hit.body, SECRET, hit.signature), true);
  const payload = JSON.parse(hit.body);
  assert.equal(payload.event, "message_received");
  assert.equal(payload.test, undefined);
  assert.equal(payload.message.text, "salut");
  assert.equal(payload.message.chat_id, PEER);
  assert.equal(sink.lastError, null);
  await server.close();
});

test("a 5xx is a soft fail that sets last_error and does not throw", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("no");
  });
  const sink = new WebhookSink({
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  await sink.notify({
    message_id: "m1",
    chat_id: PEER,
    from_me: false,
    type: "text",
    text: "x",
    timestamp: "now",
    sender: { id: PEER, name: "Ana" },
  });
  assert.match(sink.lastError ?? "", /HTTP 502/);
  assert.equal(sink.info().enabled, true);
  assert.equal(sink.info().valid, true);
  assert.match(sink.info().last_error ?? "", /HTTP 502/);
  await server.close();
});

test("an unreachable URL is a soft fail that sets last_error", async () => {
  const sink = new WebhookSink({
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: "http://127.0.0.1:1/hook",
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  await sink.notify({
    message_id: "m1",
    chat_id: PEER,
    from_me: false,
    type: "text",
    text: "x",
    timestamp: "now",
    sender: { id: PEER, name: "Ana" },
  });
  assert.match(sink.lastError ?? "", /could not reach 127.0.0.1:1/);
});

test("sendTest refuses off and invalid config, and posts test:true when ready", async () => {
  const off = await new WebhookSink({}).sendTest();
  assert.equal(off.ok, false);
  assert.match(off.error, /off/i);

  const invalid = await new WebhookSink({ WAZAP_WEBHOOK: "on" }).sendTest();
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /URL or a secret/);

  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(200);
    res.end();
  });
  const ready = await new WebhookSink({
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
  }).sendTest();
  assert.equal(ready.ok, true);
  assert.equal(received[0].event, "message_received");
  assert.equal(received[0].test, true);
  assert.equal(received[0].message.text, "wazap webhook test");
  await server.close();
});

test("doctor marks on-without-url invalid, and off as an info check", () => {
  const off = webhookCheck({});
  assert.equal(off.name, "webhook");
  assert.equal(off.state, "info");
  assert.equal(off.detail, "off");

  const bad = webhookCheck({ WAZAP_WEBHOOK: "on" });
  assert.equal(bad.state, "fail");
  assert.match(bad.detail, /URL or a secret/);
  assert.match(bad.fix, /wazap config webhook on/);
});

test("status and status --json show an on-without-secret webhook as a failing check", async () => {
  const dir = dataDir();
  const env = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "https://hooks.example/wazap" };
  const human = await status(dir, [], env);
  assert.match(human.stderr, /✗ webhook: on without a secret/);
  assert.match(human.stderr, /wazap config webhook on/);

  const { stdout } = await status(dir, ["--json"], env);
  const report = JSON.parse(stdout);
  const check = report.checks.find((row) => row.name === "webhook");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /without a secret/);
  assert.ok(!stdout.includes("webhook-test-secret") && !JSON.stringify(report).includes(SECRET));
});

test("status --json carries webhook: off when it is unset", async () => {
  const { stdout } = await status(dataDir(), ["--json"]);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    report.checks.find((row) => row.name === "webhook"),
    { name: "webhook", state: "info", detail: "off" },
  );
});

test("a live notify POSTs the inbound message, and an append does not", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-live-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", { type: "append", messages: [textMessage("OLD", "history")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("NEW", "live inbound")] });
    await waitFor(() => received.length > 0, 3_000, "the live webhook POST");
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].message.text, "live inbound");
    assert.equal(received[0].test, undefined);
    const listed = await svc.readMessages(PEER, 10);
    assert.equal(listed.data.length, 2, "history ingest still stored the append");
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a down webhook does not break ingest or get_status", async () => {
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: "http://127.0.0.1:1/hook",
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-soft-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "still here")] });
    const listed = await svc.readMessages(PEER, 10);
    assert.equal(listed.data[0].text, "still here");
    await waitFor(() => svc.getStatus().webhook.last_error, 3_000, "webhook last_error");
    const status = svc.getStatus();
    assert.equal(status.webhook.enabled, true);
    assert.equal(status.webhook.valid, true);
    assert.match(status.webhook.last_error ?? "", /could not reach/);
    assert.equal(status.status, "connected");
  } finally {
    await svc.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("config webhook on writes url and secret, and prints neither the secret nor most of it", async () => {
  const dir = dataDir();
  const { code, stdout, stderr } = await wazap(dir, ["config", "webhook", "on"], {
    input: `http://127.0.0.1:9/hook\n${SECRET}\n`,
  });
  assert.equal(code, 0, stderr);
  const envFile = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envFile, /^WAZAP_WEBHOOK=on$/m);
  assert.match(envFile, /^WAZAP_WEBHOOK_URL=http:\/\/127\.0\.0\.1:9\/hook$/m);
  assert.match(envFile, new RegExp(`^WAZAP_WEBHOOK_SECRET=${SECRET}$`, "m"));
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), "the secret must not be printed");
  assert.match(stderr, /webhook: on/);
});

test("config webhook test delivers, and refuses when the webhook is off", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const ready = await wazap(dir, ["config", "webhook", "test"], {
    env: { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: server.url, WAZAP_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stderr, /test delivered/);
  assert.equal(received.length, 1);
  assert.equal(webhookSignatureMatches(received[0].body, SECRET, received[0].signature), true);
  assert.equal(JSON.parse(received[0].body).test, true);

  const off = await wazap(dir, ["config", "webhook", "test"]);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /Webhook is off/);
  await server.close();
});

test("config rejects a webhook secret on the command line", async () => {
  const { code, stderr } = await wazap(dataDir(), ["config", "webhook", "on", SECRET]);
  assert.equal(code, 1);
  assert.match(stderr, /never a command-line argument/);
  assert.ok(!stderr.includes(SECRET) || stderr.includes("never a command-line argument"));
});
