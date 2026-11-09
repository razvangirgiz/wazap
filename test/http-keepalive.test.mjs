/**
 * The listener's socket timeouts against what a tunnel in front of it does:
 * cloudflared keeps pooled origin connections idle for 90 s, so wazap must
 * hold an idle keep-alive socket longer than that, and headersTimeout must not
 * cut a socket for idling between requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_MS, HTTP_REQUEST_TIMEOUT_MS, startHttpEndpoint } from "../dist/server.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };

test("idle keep-alive sockets outlive cloudflared's 90 s origin pool, and the request bounds stay ordered", () => {
  assert.ok(HTTP_KEEP_ALIVE_MS > 90_000, "Node must not close a socket the tunnel still holds in its pool");
  // Node refuses headersTimeout > requestTimeout; both bound receipt only, never a streamed response.
  assert.ok(HTTP_HEADERS_TIMEOUT_MS <= HTTP_REQUEST_TIMEOUT_MS);
});

test("a keep-alive socket idle past Node's 5 s default and past headersTimeout serves its next request", { timeout: 20_000 }, async (t) => {
  const config = offlineConfig("wazap-keepalive-");
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "reader", write: false }],
    signal: stop.signal,
  });
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => {
    received += chunk;
  });
  socket.on("close", () => {
    closed = true;
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  const ask = () => socket.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  const answers = () => (received.match(/HTTP\/1\.1 200/g) ?? []).length;
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  ask();
  await until(() => answers() === 1);
  assert.equal(answers(), 1);
  // Node 22 closes an idle socket at keepAliveTimeout + 1 s; the old default was 5 s.
  await new Promise((resolve) => setTimeout(resolve, 6_500));
  assert.equal(closed, false, "the idle socket was closed under the tunnel");
  ask();
  await until(() => answers() === 2);
  assert.equal(answers(), 2);
});
