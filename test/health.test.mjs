/**
 * What WhatsApp says about the account itself (src/service/health.ts): a close
 * that is a ban, a temporary ban, a session taken over or a client too old
 * stops the reconnect loop and every write with ACCOUNT_RESTRICTED; a
 * reachout timelock refuses a first message to someone never written to,
 * before it leaves, while existing chats go on; a send WhatsApp refuses with
 * 463 is kept and makes wazap ask about the timelock. get_status says all of
 * it under `health`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountHealth, classifyClose } from "../dist/service/health.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, fakeSocket } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const STRANGER = "40700000099@s.whatsapp.net";

/** The Boom error Baileys closes with. */
function closed(statusCode, data) {
  return { message: "Connection Failure", output: { statusCode }, ...(data === undefined ? {} : { data }) };
}

function serviceOn(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-health-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-health-",
    id: ME,
    name: "Ana",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
  });
  t.after(() => connected.svc.stop());
  connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  connected.sock.relayMessage = async (_jid, _message, options) => options.messageId;
  return connected;
}

function close(sock, error) {
  sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error } });
}

async function refusalOf(work) {
  try {
    await work();
  } catch (err) {
    return err.code;
  }
  return "no refusal";
}

test("a close is read the way WhatsApp's own clients read it", () => {
  const now = 1_000_000;
  assert.deepEqual(classifyClose(closed(401), now), { kind: "logged_out" });
  assert.deepEqual(classifyClose(closed(402, { code: "101", expire: "3600" }), now), {
    kind: "temporarily_banned",
    until: now + 3_600_000,
    reason: "101",
    code: 402,
  });
  assert.deepEqual(
    classifyClose(closed(403, { reason: "403", logout_message_header: "You have been logged out for using an unofficial app." }), now),
    { kind: "banned", detail: "You have been logged out for using an unofficial app.", code: 403 }
  );
  assert.deepEqual(classifyClose(closed(406), now), { kind: "banned", detail: null, code: 406 });
  assert.deepEqual(classifyClose(closed(440, { tag: "conflict", attrs: { type: "replaced" } }), now), {
    kind: "session_replaced",
    detail: null,
    code: 440,
  });
  assert.equal(classifyClose(closed(405), now).kind, "client_outdated");
  assert.equal(classifyClose(closed(409), now).kind, "client_outdated");
  for (const code of [408, 411, 428, 500, 503, 515]) assert.equal(classifyClose(closed(code), now).kind, "transient", `${code}`);
  assert.equal(classifyClose(undefined, now).kind, "transient");
});

test("a ban stops the reconnect loop and every write with ACCOUNT_RESTRICTED, in WhatsApp's words", async (t) => {
  const { svc, sock } = serviceOn(t);
  let gaveUp = false;
  svc.onGiveUp = () => (gaveUp = true);
  close(sock, closed(403, { logout_message_header: "You have been logged out for using an unofficial app." }));

  const status = svc.getStatus();
  assert.equal(status.status, "auth_failure");
  assert.equal(status.health.state, "banned");
  assert.equal(status.health.detail, "You have been logged out for using an unofficial app.");
  assert.match(status.hint, /banned or locked/);
  assert.equal(svc.reconnectTimer, null, "no reconnect is scheduled");
  assert.equal(gaveUp, false, "a restart cannot lift a ban, so the process is not asked to exit");
  assert.equal(await refusalOf(() => svc.sendMessage(PEER, "salut")), "ACCOUNT_RESTRICTED");
  assert.equal(await refusalOf(() => svc.listChats("all", 10)), "ACCOUNT_RESTRICTED", "reads say why too, not only NOT_CONNECTED");
});

test("a session another client took over, and a client WhatsApp no longer takes, stop the loop too", async (t) => {
  for (const [error, state] of [
    [closed(440, { tag: "conflict", attrs: { type: "replaced" } }), "session_replaced"],
    [closed(405), "client_outdated"],
  ]) {
    const { svc, sock } = serviceOn(t);
    close(sock, error);
    assert.equal(svc.getStatus().health.state, state);
    assert.equal(svc.reconnectTimer, null);
    assert.equal(await refusalOf(() => svc.sendMessage(PEER, "salut")), "ACCOUNT_RESTRICTED");
  }
});

test("a temporary ban says until when, and gets one try at the link a minute after it ends", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { svc, sock } = serviceOn(t);
  let starts = 0;
  svc.start = async () => {
    starts++;
  };
  close(sock, closed(402, { code: "102", expire: "3600" }));

  const health = svc.getStatus().health;
  assert.equal(health.state, "temporarily_banned");
  assert.equal(health.reason, "102");
  assert.equal(Date.parse(health.until), 1_000_000 + 3_600_000);
  t.mock.timers.tick(3_600_000 + 59_999);
  assert.equal(starts, 0);
  t.mock.timers.tick(1);
  assert.equal(starts, 1, "one try, when the ban has ended");
});

test("a reachout timelock refuses a first message to a stranger before it leaves, and existing chats go on", async (t) => {
  const { svc, sock } = serviceOn(t);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: PEER, fromMe: false, id: "IN1" }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Bună" } }],
  });
  const ends = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
  sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: true, timeEnforcementEnds: ends, enforcementType: "DEFAULT" } });

  const health = svc.getStatus().health;
  assert.equal(health.state, "reachout_restricted");
  assert.equal(Date.parse(health.until), ends.getTime());
  assert.equal(await refusalOf(() => svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })), "ACCOUNT_RESTRICTED");
  assert.equal(await refusalOf(() => svc.sendMessage(STRANGER, "Bună ziua")), "ACCOUNT_RESTRICTED");
  const draft = await svc.draft({ kind: "text", chatId: PEER, text: "Da, avem." });
  assert.ok(draft.draft_id, "a chat that already has messages is still open");

  sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: false } });
  assert.equal(svc.getStatus().health.state, "ok");
  assert.ok((await svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })).draft_id, "lifted, the stranger can be written to");
});

test("a timelock whose end has passed is over, whoever asks first", () => {
  let now = 0;
  const health = new AccountHealth(() => now);
  health.noteReachout({ isActive: true, timeEnforcementEnds: 1000 });
  assert.equal(health.blocksNewChats(), true);
  now = 1000;
  assert.equal(health.info().state, "ok");
  assert.equal(health.blocksNewChats(), false);
});

test("the timelock is asked for at every open, and after a first message is refused with 463", async (t) => {
  const { svc, sock } = serviceOn(t);
  let asked = 0;
  sock.fetchAccountReachoutTimelock = async () => {
    asked++;
    return { isActive: true, enforcementType: "DEFAULT" };
  };
  sock.ev.emit("connection.update", { connection: "open" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  assert.equal(svc.getStatus().health.state, "reachout_restricted");

  sock.ev.emit("messages.update", [
    { key: { remoteJid: STRANGER, fromMe: true, id: "OUT1" }, update: { status: 0, messageStubParameters: ["463", "Your account has been restricted"] } },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 2);
  const health = svc.getStatus().health;
  assert.equal(health.last_send_error.code, "463");
  assert.ok(Date.parse(health.last_send_error.at) > 0);
});

test("an open after a ban clears it; a Baileys without the timelock call costs nothing", (t) => {
  const { svc, sock } = serviceOn(t);
  close(sock, closed(406));
  assert.equal(svc.getStatus().health.state, "banned");
  // The next socket that comes up: the account is let in again.
  const next = fakeSocket({ user: { id: ME } });
  svc.sockClient = next;
  svc.wireEvents(next, ++svc.generation);
  next.ev.emit("connection.update", { connection: "open" });
  assert.equal(svc.getStatus().health.state, "ok");
});
