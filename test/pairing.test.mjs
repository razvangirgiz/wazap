/**
 * `startPairing` against a fake socket: the code comes back on its own, the
 * link runs on behind it, and every way the socket can die is a rejection
 * rather than a hang. No network and no real credentials are involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { socketFactory, startPairing } from "../dist/pairing.js";
import { fakeSocket, stubSockets, waitFor } from "./helpers.mjs";

/** Baileys' own codes: the phone removed the device, and the restart after a pairing. */
const LOGGED_OUT = 401;
const RESTART_REQUIRED = 515;

const USER = { id: "15550100:12@s.whatsapp.net", name: "Test Account" };

function authDir() {
  return join(mkdtempSync(join(tmpdir(), "wazap-pairing-")), "auth");
}

/**
 * Start a pairing and wait until it is holding its first fake socket. `stop`
 * closes whatever is still open: a pairing left in flight would hold the event
 * loop until its own deadline.
 */
async function pairing(sockets, deadlineMs = 5_000) {
  const stub = stubSockets(socketFactory, sockets);
  const started = startPairing(authDir(), "15550100", deadlineMs);
  await waitFor(() => stub.opened.length > 0, 5_000, "the pairing socket to open");
  return {
    started,
    opened: stub.opened,
    stop: () => {
      for (const sock of sockets) sock.end();
      stub.restore();
    },
  };
}

test("the pairing code comes back as soon as WhatsApp issues it", async () => {
  const sock = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const { started, stop } = await pairing([sock]);
  try {
    sock.ev.emit("connection.update", { qr: "a-qr" });
    const p = await started;
    assert.equal(p.code, "ABCD1234");
    assert.ok(p.expiresAt > Date.now());
  } finally {
    stop();
  }
});

test("`done` resolves with the account once the socket opens, and ends that socket", async () => {
  const sock = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const { started, stop } = await pairing([sock]);
  try {
    sock.ev.emit("connection.update", { qr: "a-qr" });
    const p = await started;
    sock.ev.emit("connection.update", { connection: "open" });
    const account = await p.done;
    assert.deepEqual(account, { id: "15550100@s.whatsapp.net", name: "Test Account", number: "15550100" });
    assert.equal(sock.ended, true, "the real socket cannot open while this one is still up");
  } finally {
    stop();
  }
});

test("a rejected code is SESSION_EXPIRED, not a hang", async () => {
  const sock = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const { started, stop } = await pairing([sock]);
  try {
    sock.ev.emit("connection.update", { qr: "a-qr" });
    const p = await started;
    sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: LOGGED_OUT } } } });
    await assert.rejects(p.done, (err) => {
      assert.equal(err.code, "SESSION_EXPIRED");
      return true;
    });
  } finally {
    stop();
  }
});

test("a deadline with no code times out and ends the socket, so no second one can stack on it", async () => {
  const sock = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const { started, stop } = await pairing([sock], 60);
  try {
    await assert.rejects(started, (err) => {
      assert.equal(err.code, "TIMEOUT");
      return true;
    });
    assert.equal(sock.ended, true);
  } finally {
    stop();
  }
});

test("the restart WhatsApp demands after pairing is followed, and the link still lands", async () => {
  const first = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const second = fakeSocket({ pairingCode: "ABCD1234", user: USER });
  const { started, opened, stop } = await pairing([first, second]);
  try {
    first.ev.emit("connection.update", { qr: "a-qr" });
    const p = await started;
    first.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: RESTART_REQUIRED } } },
    });
    await waitFor(() => opened.length === 2, 5_000, "the socket to be opened again");
    second.ev.emit("connection.update", { connection: "open" });
    assert.equal((await p.done).number, "15550100");
  } finally {
    stop();
  }
});
