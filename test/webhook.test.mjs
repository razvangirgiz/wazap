/**
 * W1 outbound webhook: config validation, the three events and the payload they
 * carry, HMAC of the raw body, and a failed POST that must not take down the
 * WhatsApp path.
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
import { parse } from "dotenv";
import { DisconnectReason, proto } from "baileys";

import { AccountRegistry } from "../dist/accounts.js";
import { webhookCheck } from "../dist/doctor.js";
import { SentIds } from "../dist/sent-ids.js";
import { MESSAGE_TYPES } from "../dist/wa-types.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_KINDS,
  WEBHOOK_TEXT_MAX,
  WebhookSink,
  asWebhookPayload,
  previewText,
  readWebhookSettings,
  requireWebhookUrl,
  webhookConnectionStatus,
  webhookKind,
  webhookSignature,
  webhookSignatureMatches,
} from "../dist/webhook.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, fakeSocket, offlineConfig, openService, waitFor } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const SECRET = "webhook-test-secret";
const WEBHOOK_KEYS = ["WAZAP_WEBHOOK", "WAZAP_WEBHOOK_URL", "WAZAP_WEBHOOK_SECRET", "WAZAP_WEBHOOK_EVENTS"];

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

/** What another linked device, or wazap itself, sends: the same chat, `fromMe`. */
function ownMessage(id, body, { chat = PEER, at = Date.now() } = {}) {
  return {
    key: { remoteJid: chat, fromMe: true, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { conversation: body },
  };
}

function voiceNote(id, seconds, at = Date.now()) {
  return {
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds } },
  };
}

/** The close Baileys reports, carrying the status code the handler reads. */
const closedWith = (statusCode) => ({
  connection: "close",
  lastDisconnect: { error: { message: "Connection Terminated", output: { statusCode } } },
});

/** Point the in-process sink at `url`, and hand back the restore the test owes. */
function saveWebhookEnv(url, events) {
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  for (const key of WEBHOOK_KEYS) delete process.env[key];
  Object.assign(process.env, readyEnv(url, events));
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The transcription environment is read in the constructor, so it is set around
 * that call and put straight back. The openai provider is the one whose
 * readiness is a key, which keeps whisper.cpp and its model out of this file.
 */
function transcribingService(prefix) {
  const keys = ["WAZAP_TRANSCRIBE", "WAZAP_TRANSCRIBE_API_KEY", "WAZAP_TRANSCRIBE_AUTO"];
  const saved = keys.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_API_KEY: "sk-test-key",
    WAZAP_TRANSCRIBE_AUTO: "1",
  });
  try {
    return connectedService(WhatsAppService, { prefix, id: ME, name: "Răzvan", config: { readOnly: false } });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function samplePayload(overrides = {}) {
  return {
    event: "message_received",
    from: PEER,
    chat_id: PEER,
    ts: "2026-09-08T14:00:00+00:00",
    timestamp: "2026-09-08T14:00:00.000Z",
    text: "salut",
    truncated: false,
    kind: "text",
    from_me: false,
    is_self_chat: false,
    message_id: "false_40700000002@s.whatsapp.net_ABC",
    account_id: "default",
    account_name: "default",
    ...overrides,
  };
}

function connectionPayload(overrides = {}) {
  return {
    event: "connection",
    status: "linked",
    timestamp: "2026-09-08T14:00:00.000Z",
    account_id: "default",
    account_name: "default",
    ...overrides,
  };
}

function readyEnv(url, events) {
  const env = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET };
  return events === undefined ? env : { ...env, WAZAP_WEBHOOK_EVENTS: events };
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

test("an account webhook_url and webhook_secret win over the environment", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global"), {
    url: "https://hooks.example/work///",
    secret: "  work-secret  ",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/work",
    secret: "work-secret",
    events: ["message_received"],
  });
});

test("an account webhook_events wins over the environment, in canonical order", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global", "all"), {
    events: "  connection , MESSAGE_RECEIVED , connection  ",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/global",
    secret: SECRET,
    events: ["message_received", "connection"],
  });
});

test("an unknown webhook event is invalid rather than silently dropped", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/wazap", "message_received,message_recieved"));
  assert.equal(settings.kind, "invalid");
  assert.match(settings.detail, /message_recieved/);
  assert.match(settings.fix, /WAZAP_WEBHOOK_EVENTS/);
});

test("an account can override only the URL and still use the global secret", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global"), {
    url: "http://127.0.0.1:9/work",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "http://127.0.0.1:9/work",
    secret: SECRET,
    events: ["message_received"],
  });
});

test("asWebhookPayload names the account", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_ABC",
      chat_id: PEER,
      from_me: false,
      timestamp: "2026-09-08T14:00:00+00:00",
      type: "text",
      text: "salut",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "work", name: "Work" },
    isSelfChat: false,
  });
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(payload.event, "message_received");
  assert.equal(payload.text, "salut");
});

test("an audio payload carries the transcription instead of the placeholder", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_V1",
      chat_id: PEER,
      from_me: false,
      timestamp: "2026-09-08T14:00:00+00:00",
      type: "voice",
      text: '[voice message · 0:06] "am uitat umbrela acasă"',
      transcript: "am uitat umbrela acasă",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "default", name: "default" },
    isSelfChat: false,
  });
  assert.equal(payload.text, "am uitat umbrela acasă");
  assert.equal(payload.kind, "audio");
  assert.equal(payload.truncated, false);
});

/**
 * The instant is the sender's to state, and `messageTimestamp` is a protobuf field
 * nobody bounds, so a junk one must cost one field and not the delivery.
 */
test("an unparseable ts falls back to now instead of throwing the event away", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_JUNK",
      chat_id: PEER,
      from_me: false,
      timestamp: "NaN-NaN-NaNTNaN:NaN:NaN+NaN:NaN",
      type: "text",
      text: "salut",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "default", name: "default" },
    isSelfChat: false,
  });
  assert.equal(payload.ts, "NaN-NaN-NaNTNaN:NaN:NaN+NaN:NaN", "what the peer said is still reported");
  assert.match(payload.timestamp, /Z$/);
  assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
  assert.equal(payload.text, "salut");
});

test("webhookKind gives every message type a bucket, and both audio types the same one", () => {
  const kinds = new Set(WEBHOOK_KINDS);
  for (const type of MESSAGE_TYPES) {
    assert.ok(kinds.has(webhookKind(type)), `${type} has no webhook kind`);
  }
  assert.equal(webhookKind("text"), "text");
  assert.equal(webhookKind("image"), "image");
  assert.equal(webhookKind("voice"), "audio", "a recorded note");
  assert.equal(webhookKind("audio"), "audio", "an attached file");
  assert.equal(webhookKind("video"), "other");
  assert.equal(webhookKind("unknown"), "other");
});

test("webhookConnectionStatus maps only what a consumer can act on", () => {
  assert.equal(webhookConnectionStatus("connected"), "linked");
  assert.equal(webhookConnectionStatus("disconnected"), "disconnected");
  assert.equal(webhookConnectionStatus("logged_out"), "expired");
  assert.equal(webhookConnectionStatus("session_corrupt"), "expired");
  assert.equal(webhookConnectionStatus("auth_failure"), "expired");
  for (const transient of ["not_linked", "linking", "connecting"]) {
    assert.equal(webhookConnectionStatus(transient), null, `${transient} is nothing to announce`);
  }
});

test("SentIds remembers an id until its ttl runs out, then forgets it", () => {
  let now = 1_000;
  const ids = new SentIds({ ttlMs: 60_000, now: () => now });
  ids.note("true_40700000002@s.whatsapp.net_OWN");
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), true);
  assert.equal(ids.size, 1);
  now += 59_000;
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), true, "an echo can take a while to come back");
  now += 2_000;
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), false);
  assert.equal(ids.size, 0, "nothing is left for a long-running service to carry");
});

test("on with a URL and a secret is ready, and a trailing slash is stripped", () => {
  const settings = readWebhookSettings({
    WAZAP_WEBHOOK: "yes",
    WAZAP_WEBHOOK_URL: "https://hooks.example/wazap///",
    WAZAP_WEBHOOK_SECRET: `  "${SECRET}"  `,
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/wazap",
    secret: SECRET,
    events: ["message_received"],
  });
});

test("an unknown WAZAP_WEBHOOK value is invalid rather than silently on", () => {
  const settings = readWebhookSettings({ WAZAP_WEBHOOK: "maybe" });
  assert.equal(settings.kind, "invalid");
  assert.match(settings.detail, /maybe/);
});

test("plain http is refused unless it points at this machine", () => {
  assert.throws(
    () => requireWebhookUrl("http://example.com/hook"),
    (err) => {
      assert.match(err.message, /non-https/);
      return true;
    }
  );
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

test("a ready sink POSTs the small payload with a matching signature", async () => {
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

  const sink = new WebhookSink(readyEnv(server.url), { retryDelays: [] });
  await sink.notify(samplePayload());

  assert.equal(received.length, 1);
  const hit = received[0];
  assert.equal(hit.path, "/hook");
  assert.equal(hit.event, "message_received");
  assert.match(hit.type, /application\/json/);
  assert.equal(webhookSignatureMatches(hit.body, SECRET, hit.signature), true);
  assert.deepEqual(JSON.parse(hit.body), samplePayload());
  assert.equal(sink.lastError, null);
  await server.close();
});

test("off delivers zero POSTs, even when a URL is set", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  await new WebhookSink({}, { post }).notify(samplePayload());
  await new WebhookSink(
    { WAZAP_WEBHOOK: "off", WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook", WAZAP_WEBHOOK_SECRET: SECRET },
    { post }
  ).notify(samplePayload());
  assert.equal(calls, 0);
});

test("an unset WAZAP_WEBHOOK_EVENTS delivers message_received and drops the other two", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [] });

  assert.equal(await sink.notify(samplePayload({ event: "message_sent", from_me: true })), false);
  assert.equal(await sink.notify(connectionPayload()), false);
  assert.equal(calls, 0, "a filtered event is not a delivery attempt");

  assert.equal(await sink.notify(samplePayload()), true);
  assert.equal(calls, 1);
});

test("WAZAP_WEBHOOK_EVENTS=all delivers all three", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook", "all"), { post, retryDelays: [] });

  assert.equal(await sink.notify(samplePayload()), true);
  assert.equal(await sink.notify(samplePayload({ event: "message_sent", from_me: true })), true);
  assert.equal(await sink.notify(connectionPayload()), true);
  assert.equal(calls, 3);
});

test("an explicit WAZAP_WEBHOOK_EVENTS list delivers only what it names", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook", "message_received,connection"), {
    post,
    retryDelays: [],
  });

  assert.equal(await sink.notify(samplePayload()), true);
  assert.equal(await sink.notify(connectionPayload()), true);
  assert.equal(await sink.notify(samplePayload({ event: "message_sent", from_me: true })), false);
  assert.equal(calls, 2);
});

test("a long body is posted as a preview that says it was cut", () => {
  assert.equal(WEBHOOK_TEXT_MAX, 2000);
  assert.deepEqual(previewText("short"), { text: "short", truncated: false });
  assert.deepEqual(previewText("x".repeat(2000)), { text: "x".repeat(2000), truncated: false });
  const cut = previewText("x".repeat(2001));
  assert.equal(cut.text.length, 2000);
  assert.equal(cut.text, `${"x".repeat(1999)}…`);
  assert.equal(cut.truncated, true);
});

test("a 5xx is retried, then last_error is set and nothing is thrown", async () => {
  let hits = 0;
  const server = await listen((_req, res) => {
    hits++;
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("no");
  });
  const sink = new WebhookSink(readyEnv(server.url), { retryDelays: [0, 0] });
  await sink.notify(samplePayload({ text: "x" }));
  assert.equal(hits, 3);
  assert.match(sink.lastError ?? "", /HTTP 502/);
  assert.equal(sink.info().enabled, true);
  assert.equal(sink.info().valid, true);
  assert.match(sink.info().last_error ?? "", /HTTP 502/);
  await server.close();
});

test("a short retry then a 2xx clears last_error", async () => {
  let hits = 0;
  const post = async () => {
    hits++;
    return new Response(hits < 3 ? "no" : null, { status: hits < 3 ? 502 : 204 });
  };
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [0, 0] });
  await sink.notify(samplePayload());
  assert.equal(hits, 3);
  assert.equal(sink.lastError, null);
});

test("notify never rejects, even when building the POST throws", async () => {
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { retryDelays: [] });
  const payload = {
    ...samplePayload(),
    get text() {
      throw new Error(`cannot serialize ${SECRET}`);
    },
  };
  await sink.notify(payload);
  assert.match(sink.lastError ?? "", /cannot serialize/);
  assert.ok(!(sink.lastError ?? "").includes(SECRET), "the secret must not appear in last_error");
});

test("an unreachable URL is a soft fail that sets last_error", async () => {
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:1/hook"), { retryDelays: [] });
  await sink.notify(samplePayload({ text: "x" }));
  assert.match(sink.lastError ?? "", /could not reach 127.0.0.1:1/);
  assert.ok(!(sink.lastError ?? "").includes(SECRET), "the secret must not appear in last_error");
});

test("sendTest refuses off and invalid config, and posts the same event when ready", async () => {
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
  const ready = await new WebhookSink(readyEnv(server.url), { retryDelays: [] }).sendTest();
  assert.equal(ready.ok, true);
  assert.equal(received[0].event, "message_received");
  assert.equal(received[0].text, "wazap webhook test");
  assert.equal(received[0].message_id, "test");
  assert.equal(received[0].from, "wazap");
  assert.equal(received[0].account_id, "default");
  assert.equal(received[0].account_name, "default");
  await server.close();
});

test("a sink prefers the account webhook_url and names that account on sendTest", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const workSecret = "work-hook-secret";
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:1/dead"), {
    retryDelays: [],
    account: {
      id: "work",
      name: "Work",
      webhook_url: server.url,
      webhook_secret: workSecret,
    },
  });
  const result = await sink.sendTest();
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  await server.close();
});

test("an account with its own event list is sent to accounts.json, not to the environment", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const sink = new WebhookSink(readyEnv("https://hooks.example/global", "all"), {
    post,
    retryDelays: [],
    account: { id: "work", name: "Work", webhook_events: "message_received" },
  });
  const result = await sink.sendTest("connection");
  assert.equal(result.ok, false);
  assert.match(result.error, /"connection" is not enabled/);
  assert.equal(result.fix, 'set webhook_events for "work" in accounts.json to message_received,connection, or all');
  assert.equal(calls, 0);
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
    { name: "webhook", state: "info", detail: "off" }
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
    assert.equal(received[0].text, "live inbound");
    assert.equal(received[0].chat_id, PEER);
    assert.equal(received[0].from, "40700000002");
    assert.equal(received[0].account_id, "default");
    assert.equal(received[0].account_name, "default");
    assert.ok(received[0].message_id);
    assert.ok(received[0].ts);
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

test("stub and system notices are not posted as message_received", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, readyEnv(server.url));
  const group = "120363000000000003@g.us";
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-stub-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: group, fromMe: false, id: "STUB" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
        },
        {
          key: { remoteJid: group, fromMe: false, id: "ENC" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED,
        },
        {
          key: { remoteJid: PEER, fromMe: false, id: "SYS" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING } },
        },
        textMessage("REAL", "only this one"),
      ],
    });
    await waitFor(() => received.length > 0, 3_000, "the user inbound webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "only this one");
    assert.equal(received[0].event, "message_received");
    const listed = await svc.readMessages(group, 10);
    assert.ok(
      listed.data.some((row) => row.type === "system"),
      "the stub is still stored, just not posted"
    );
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a live notify posts to the account webhook_url and names that account", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, readyEnv("http://127.0.0.1:1/dead"));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-acct-",
    id: ME,
    name: "Work phone",
    account: {
      id: "work",
      name: "Work",
      enabled: true,
      owner: null,
      webhook_url: server.url,
      webhook_secret: "work-live-secret",
    },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "from work")] });
    await waitFor(() => received.length > 0, 3_000, "the per-account webhook POST");
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "from work");
    assert.equal(received[0].account_id, "work");
    assert.equal(received[0].account_name, "Work");
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/**
 * The echo is driven as `notify` on purpose, which is the id backstop and not the
 * path production takes. The test after this one covers the `append` Baileys
 * really emits for a local send.
 */
test("a message typed on the phone posts message_sent, and the noted id keeps wazap's own echo quiet", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-sent-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: "OWN" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: content.text },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 0, 3_000, "the inbound webhook POST");

    const sent = await svc.sendMessage(PEER, "răspuns");
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OWN", "răspuns")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("PHONE", "răspuns")] });
    await waitFor(() => received.length > 1, 3_000, "the message_sent webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(sent.message_id, `true_${PEER}_OWN`);
    assert.equal(received.length, 2, "the echo of wazap's own send must not come back as an event");
    assert.equal(received[1].event, "message_sent");
    assert.equal(received[1].from_me, true);
    assert.equal(received[1].text, "răspuns", "the same text as wazap sent, so only the id can tell them apart");
    assert.equal(received[1].message_id, `true_${PEER}_PHONE`);
    assert.equal(received[1].is_self_chat, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * What Baileys does with this socket's own send: it re-emits it as an `append`,
 * which the notify gate drops. That gate, not the noted id, is what keeps wazap
 * from answering itself in production.
 */
test("wazap's own send is quiet as the append Baileys emits for it", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-append-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: "OWN" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: content.text },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "append", messages: [ownMessage("NEVER_NOTED", "răspuns")] });
    const sent = await svc.sendMessage(PEER, "răspuns");
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OWN", "răspuns")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 0, 3_000, "the inbound webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(sent.message_id, `true_${PEER}_OWN`);
    assert.equal(received.length, 1, "an append is not an event, whether its id was noted or not");
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].text, "salut");
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("the self chat is marked is_self_chat, and timestamp is ts in UTC", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-self-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [ownMessage("SELF", "notă pentru mine", { chat: ME })],
    });
    await waitFor(() => received.length > 0, 3_000, "the self-chat webhook POST");
    const self = received[0];
    assert.equal(self.event, "message_sent");
    assert.equal(self.from_me, true);
    assert.equal(self.is_self_chat, true);
    assert.equal(self.chat_id, ME);
    assert.equal(self.kind, "text");
    assert.equal(self.truncated, false);
    assert.match(self.timestamp, /Z$/);
    assert.equal(
      Date.parse(self.timestamp),
      Date.parse(self.ts),
      "the same instant as ts, not a second look at the clock"
    );

    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 1, 3_000, "the inbound webhook POST");
    assert.equal(received[1].event, "message_received");
    assert.equal(received[1].from_me, false);
    assert.equal(received[1].is_self_chat, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("an image posts kind image, and a sticker falls through to other", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-kind-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: PEER, fromMe: false, id: "IMG" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
      ],
    });
    await waitFor(() => received.length > 0, 3_000, "the image webhook POST");
    assert.equal(received[0].kind, "image");

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: PEER, fromMe: false, id: "STK" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { stickerMessage: { mimetype: "image/webp" } },
        },
      ],
    });
    await waitFor(() => received.length > 1, 3_000, "the sticker webhook POST");
    assert.equal(received[1].kind, "other");
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a voice note waits for its transcript, and posts the words as the text", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-");
  svc.transcriber = async () => ({ text: "am uitat umbrela acasă", language: "ro", duration_seconds: 6 });
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("V1", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the voice note webhook POST");
    assert.equal(received[0].text, "am uitat umbrela acasă", "the wait is the only reason the words are here");
    assert.equal(received[0].kind, "audio");
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].truncated, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * The queue is single file, so note two is still running when note one is done.
 * Note one must not pay for it: the wait is per message, and the second
 * transcript is released by hand rather than by a sleep.
 */
test("a voice note waits for its own transcript, not for the notes behind it", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-per-note-");
  let releaseSecond = () => {};
  const second = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  svc.transcriber = async () => {
    calls += 1;
    if (calls > 1) await second;
    return { text: calls === 1 ? "prima notă" : "a doua notă", language: "ro", duration_seconds: 6 };
  };
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("V1", 6), voiceNote("V2", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the first voice note webhook POST");
    assert.equal(received.length, 1, "the second note is still being transcribed");
    assert.equal(received[0].text, "prima notă");

    releaseSecond();
    await waitFor(() => received.length > 1, 5_000, "the second voice note webhook POST");
    assert.equal(received[1].text, "a doua notă");
  } finally {
    releaseSecond();
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a transcription that fails still posts the event, carrying the placeholder", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-fail-");
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  svc.transcriber = async () => {
    throw new Error("whisper exploded");
  };
  const realError = console.error;
  console.error = () => {};
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("VF", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the failed voice note webhook POST");
    assert.equal(received[0].text, "[voice message · 0:06]");
    assert.equal(received[0].kind, "audio");
    assert.equal(received[0].event, "message_received");
  } finally {
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("connection changes post linked, disconnected and expired, once per mapped status", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({ header: req.headers["x-wazap-event"], body: JSON.parse(await readBody(req)) });
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "connection");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-"));
  const sock = fakeSocket();
  svc.start = async () => {};
  svc.wireEvents(sock, ++svc.generation);
  try {
    sock.ev.emit("connection.update", { connection: "open" });
    await waitFor(() => received.length > 0, 3_000, "the linked webhook POST");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.connectionClosed));
    await waitFor(() => received.length > 1, 3_000, "the disconnected webhook POST");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.loggedOut));
    await waitFor(() => received.length > 2, 3_000, "the expired webhook POST");
    svc.setStatus("session_corrupt");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      received.map((hit) => hit.body.status),
      ["linked", "disconnected", "expired"]
    );
    assert.equal(received.length, 3, "session_corrupt is expired too, and a consumer hears that once");
    for (const hit of received) {
      assert.equal(hit.header, "connection");
      assert.equal(hit.body.event, "connection");
      assert.equal(hit.body.account_id, "default");
      assert.equal(hit.body.account_name, "default");
      assert.match(hit.body.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * `expired` has no later transition to recover with, because re-linking needs a
 * human. So a status the consumer never received must not count as announced: the
 * next change that means the same thing says it again.
 */
test("a connection event the consumer never received is announced by the next change", async () => {
  const received = [];
  let attempts = 0;
  let accepting = false;
  const server = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    attempts += 1;
    if (!accepting) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    received.push(body);
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "connection");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-fail-"));
  try {
    svc.setStatus("logged_out");
    await waitFor(() => attempts >= 3, 5_000, "the expired POST and its two retries");
    assert.equal(received.length, 0, "nothing was delivered");

    accepting = true;
    svc.setStatus("session_corrupt");
    svc.setStatus("connected");
    await waitFor(() => received.length > 1, 5_000, "the re-announced expired POST and the linked one");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      received.map((hit) => hit.status),
      ["expired", "linked"],
      "expired is said again, and one chain keeps the pair in the order the link moved in"
    );
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * A filtered event is not a delivery, so it must leave the "only on change"
 * guard where it was. Both statuses here map to `expired`: the second one can
 * only arrive if the filtered first never counted as announced.
 */
test("a filtered connection change does not count as announced", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "message_received");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-filtered-"));
  try {
    svc.setStatus("logged_out");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 0, "connection is not an enabled event");

    process.env.WAZAP_WEBHOOK_EVENTS = "all";
    svc.setStatus("session_corrupt");
    await waitFor(() => received.length > 0, 5_000, "the expired webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      received.map((hit) => hit.status),
      ["expired"]
    );
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
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
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  assert.equal(code, 0, stderr);
  const envFile = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envFile, /^WAZAP_WEBHOOK=on$/m);
  assert.match(envFile, /^WAZAP_WEBHOOK_URL=http:\/\/127\.0\.0\.1:9\/hook$/m);
  assert.match(envFile, new RegExp(`^WAZAP_WEBHOOK_SECRET=${SECRET}$`, "m"));
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), "the secret must not be printed");
  assert.match(stderr, /webhook: on/);

  const shown = await wazap(dir, ["config"]);
  assert.ok(!shown.stderr.includes(SECRET), "config must not print the secret");
  assert.match(shown.stderr, /secret: set/);
});

test("config webhook on keeps a secret that contains #, and webhook test signs with it", async () => {
  const secret = "p@ss#word with spaces";
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
  const enabled = await wazap(dir, ["config", "webhook", "on"], {
    input: `${secret}\n`,
    env: { WAZAP_WEBHOOK_URL: server.url },
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.ok(!enabled.stdout.includes(secret) && !enabled.stderr.includes(secret), "the secret must not be printed");
  const envFile = readFileSync(join(dir, ".env"), "utf8");
  assert.equal(parse(envFile).WAZAP_WEBHOOK_SECRET, secret);
  assert.match(envFile, /WAZAP_WEBHOOK_SECRET='/);

  const probed = await wazap(dir, ["webhook", "test"]);
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  assert.equal(webhookSignatureMatches(received[0].body, secret, received[0].signature), true);
  assert.equal(webhookSignatureMatches(received[0].body, secret.split("#")[0], received[0].signature), false);
  await server.close();
});

test("wazap webhook test delivers, and refuses when the webhook is off", async () => {
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
  const ready = await wazap(dir, ["webhook", "test"], {
    env: readyEnv(server.url),
  });
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stderr, /test delivered/);
  assert.equal(received.length, 1);
  assert.equal(webhookSignatureMatches(received[0].body, SECRET, received[0].signature), true);
  assert.equal(JSON.parse(received[0].body).event, "message_received");
  assert.equal(JSON.parse(received[0].body).text, "wazap webhook test");
  assert.equal(JSON.parse(received[0].body).account_id, "default");
  assert.equal(JSON.parse(received[0].body).account_name, "default");
  assert.ok(!ready.stderr.includes(SECRET) && !ready.stdout.includes(SECRET));

  const off = await wazap(dir, ["webhook", "test"]);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /Webhook is off/);
  await server.close();
});

test("wazap webhook test --event posts that event, and refuses an unknown one", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      event: req.headers["x-wazap-event"],
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const asSent = await wazap(dir, ["webhook", "test", "--event", "message_sent"], { env: readyEnv(server.url, "all") });
  assert.equal(asSent.code, 0, asSent.stderr);
  const asConnection = await wazap(dir, ["webhook", "test", "--event", "connection"], {
    env: readyEnv(server.url, "all"),
  });
  assert.equal(asConnection.code, 0, asConnection.stderr);

  assert.deepEqual(
    received.map((hit) => hit.event),
    ["message_sent", "connection"]
  );
  const sent = JSON.parse(received[0].body);
  assert.equal(sent.event, "message_sent");
  assert.equal(sent.from_me, true);
  assert.equal(sent.text, "wazap webhook test");
  assert.equal(webhookSignatureMatches(received[0].body, SECRET, received[0].signature), true);
  const connection = JSON.parse(received[1].body);
  assert.equal(connection.event, "connection");
  assert.equal(connection.status, "linked");
  assert.match(connection.timestamp, /Z$/);
  assert.equal(webhookSignatureMatches(received[1].body, SECRET, received[1].signature), true);

  const unknown = await wazap(dir, ["webhook", "test", "--event", "frobnicate"], { env: readyEnv(server.url, "all") });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown webhook event "frobnicate"/);
  assert.ok(unknown.stderr.includes(WEBHOOK_EVENTS.join(", ")), unknown.stderr);
  assert.equal(received.length, 2, "a refused event must not POST");
  await server.close();
});

test("wazap webhook test --event refuses an event the filter drops, and posts it once it is enabled", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({ event: req.headers["x-wazap-event"], body: await readBody(req) });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const filtered = await wazap(dir, ["webhook", "test", "--event", "message_sent"], { env: readyEnv(server.url) });
  assert.equal(filtered.code, 1);
  assert.match(filtered.stderr, /Webhook event "message_sent" is not enabled/);
  assert.ok(
    filtered.stderr.includes("set WAZAP_WEBHOOK_EVENTS=message_received,message_sent, or all"),
    filtered.stderr
  );
  assert.equal(received.length, 0, "a filtered event must not POST");

  const enabled = await wazap(dir, ["webhook", "test", "--event", "message_sent"], {
    env: readyEnv(server.url, "all"),
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, "message_sent");
  assert.equal(JSON.parse(received[0].body).event, "message_sent");
  await server.close();
});

test("wazap webhook test --account posts to that account's override", async () => {
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
  const workSecret = "work-cli-secret";
  AccountRegistry.load(dir).add("work", "Work");
  AccountRegistry.load(dir).setWebhook("work", { url: server.url, secret: workSecret });
  const probed = await wazap(dir, ["webhook", "test", "--account", "work"], {
    env: readyEnv("http://127.0.0.1:1/dead"),
  });
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  assert.ok(!probed.stderr.includes(workSecret) && !probed.stdout.includes(workSecret));
  await server.close();
});

test("wazap webhook test --account refuses an unknown id", async () => {
  const { code, stderr } = await wazap(dataDir(), ["webhook", "test", "--account", "ghost"], {
    env: readyEnv("http://127.0.0.1:9/hook"),
  });
  assert.equal(code, 1);
  assert.match(stderr, /No account "ghost"/);
});

test("config webhook on --account stores url and secret in accounts.json, then test posts to it", async () => {
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
  await wazap(dir, ["account", "add", "work"]);
  const workSecret = "work-config-secret";
  const enabled = await wazap(dir, ["config", "webhook", "on", "--account", "work"], {
    input: `${workSecret}\n`,
    env: { WAZAP_WEBHOOK_URL: server.url },
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match(enabled.stderr, /webhook: on for work/);
  assert.ok(!enabled.stdout.includes(workSecret) && !enabled.stderr.includes(workSecret));

  const file = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"));
  const work = file.accounts.find((account) => account.id === "work");
  assert.equal(work.webhook_url, server.url);
  assert.equal(work.webhook_secret, workSecret);
  const envFile = parse(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(envFile.WAZAP_WEBHOOK, "on", "the switch stays global");
  assert.equal(envFile.WAZAP_WEBHOOK_URL, undefined, "the URL belongs to the account, not .env");
  assert.equal(envFile.WAZAP_WEBHOOK_SECRET, undefined);

  const probed = await wazap(dir, ["webhook", "test", "--account", "work"]);
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  await server.close();
});

test("config webhook off --account drops the override; the account follows the global again", async () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  registry.setWebhook("work", { url: "https://hooks.example/work", secret: "gone" });
  const { code, stderr } = await wazap(dir, ["config", "webhook", "off", "--account", "work"]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /override removed for work/);
  const work = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).accounts.find(
    (account) => account.id === "work"
  );
  assert.equal(work.webhook_url, undefined);
  assert.equal(work.webhook_secret, undefined);
});

test("config webhook on --account refuses an unknown id before asking for a secret", async () => {
  const dir = dataDir();
  const { code, stderr } = await wazap(dir, ["config", "webhook", "on", "--account", "ghost"], {
    input: "secret\n",
    env: { WAZAP_WEBHOOK_URL: "https://hooks.example/x" },
  });
  assert.equal(code, 1);
  assert.match(stderr, /No account "ghost"/);
});

test("config rejects a webhook secret on the command line", async () => {
  const { code, stderr } = await wazap(dataDir(), ["config", "webhook", "on", SECRET]);
  assert.equal(code, 1);
  assert.match(stderr, /never a command-line argument/);
  assert.ok(!stderr.includes(SECRET) || stderr.includes("never a command-line argument"));
});
