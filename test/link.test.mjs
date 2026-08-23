/**
 * `WhatsAppService.link`: the state machine behind the `link_account` tool.
 * A pairing is a status, not a flag, so these pin what `get_status` reports at
 * every step and that only one pairing is ever in flight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { socketFactory } from "../dist/pairing.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { fakeSocket, offlineConfig, stubSockets, waitFor } from "./helpers.mjs";

const LOGGED_OUT = 401;
const USER = { id: "15550100:12@s.whatsapp.net", name: "Test Account" };

/**
 * An unlinked service whose `start` is counted rather than run: the real one
 * would open a socket to WhatsApp, which is the thing under test's next step.
 */
async function unlinkedService() {
  const svc = new WhatsAppService(offlineConfig("wazap-link-"));
  await svc.start();
  assert.equal(svc.getStatus().status, "not_linked");
  const starts = [];
  svc.start = async () => {
    starts.push(Date.now());
    svc.setStatus("connected");
  };
  return { svc, starts };
}

/**
 * Take the service to a live pairing code and hand back the socket driving it.
 * `stop` closes whatever is still open: a pairing left in flight would hold the
 * event loop until its own deadline.
 */
async function linking(svc) {
  const sock = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const stub = stubSockets(socketFactory, [sock]);
  const started = svc.link("+15550100");
  await waitFor(() => stub.opened.length > 0, 5_000, "the pairing socket to open");
  sock.ev.emit("connection.update", { qr: "a-qr" });
  return {
    info: await started,
    sock,
    stop: () => {
      sock.end();
      stub.restore();
    },
  };
}

test("a link goes not_linked → linking → connected, and only shows the code while linking", async () => {
  const { svc, starts } = await unlinkedService();
  const { info, sock, stop } = await linking(svc);
  try {
    assert.equal(info.code, "ABCD-1234");
    assert.equal(info.phone_masked, "+15 5xx xxx");
    assert.ok(Date.parse(info.expires_at) > Date.now());

    const during = svc.getStatus();
    assert.equal(during.status, "linking");
    assert.deepEqual(during.pairing, info);
    assert.match(during.hint, /Enter the code on the phone/);

    sock.ev.emit("connection.update", { connection: "open" });
    await waitFor(() => svc.getStatus().status === "connected", 5_000, "the link to settle");
    const after = svc.getStatus();
    assert.equal(after.pairing, undefined, "a spent code must not linger in the status");
    assert.equal(after.account.number, "15550100");
    assert.equal(starts.length, 1, "the history sync has to land in this process's store");
  } finally {
    stop();
  }
});

test("a refused link goes back to not_linked and says why", async () => {
  const { svc } = await unlinkedService();
  const { sock, stop } = await linking(svc);
  try {
    sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: LOGGED_OUT } } } });
    await waitFor(() => svc.getStatus().status === "not_linked", 5_000, "the link to be given up");
    const after = svc.getStatus();
    assert.equal(after.pairing, undefined);
    assert.match(after.last_error, /WhatsApp rejected the link/);
  } finally {
    stop();
  }
});

test("a second link while one is in flight hands back the same code", async () => {
  const { svc } = await unlinkedService();
  const { info, stop } = await linking(svc);
  try {
    assert.deepEqual(await svc.link("+15550999"), info, "a second socket on one session is the 440 failure");
  } finally {
    stop();
  }
});

test("linking a linked account is refused, not started", async () => {
  const { svc } = await unlinkedService();
  svc.setStatus("connected");
  await assert.rejects(svc.link("+15550100"), (err) => {
    assert.equal(err.code, "ALREADY_LINKED");
    return true;
  });
});

test("a number that is not international is refused before any socket opens", async () => {
  const { svc } = await unlinkedService();
  const stub = stubSockets(socketFactory, []);
  try {
    await assert.rejects(svc.link("nonsense"), (err) => {
      assert.equal(err.code, "INVALID_PHONE");
      return true;
    });
    assert.equal(stub.opened.length, 0);
    assert.equal(svc.getStatus().status, "not_linked");
  } finally {
    stub.restore();
  }
});

test("relinking a dead session clears the credentials it is replacing", async () => {
  const { svc } = await unlinkedService();
  const authDir = svc.paths.authDir;
  mkdirSync(authDir, { recursive: true });
  const stale = join(authDir, "creds.json");
  writeFileSync(stale, "{}");
  svc.setStatus("logged_out");

  const { stop } = await linking(svc);
  try {
    assert.equal(existsSync(stale), false, "the expired credentials must not survive the relink");
  } finally {
    stop();
  }
});
