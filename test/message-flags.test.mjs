/**
 * The flags a message is stored with (schema v5): an incoming message that
 * mentions the account — by number or by lid, live, appended or synced — is
 * mentions_me; the account's own message sent through wazap is via_wazap,
 * after a restart too, and one sent from the phone is not. What was stored
 * before the flags existed gets them from the backfill at boot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proto } from "baileys";

import { MESSAGE_FLAGS } from "../dist/db/index.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { bootedService, connectedService, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ME_LID = "900000000000001@lid";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const { mentionsMe: MENTIONS, viaWazap: VIA } = MESSAGE_FLAGS;
const T0 = Math.floor(Date.now() / 1000) - 3600;

function dataDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-flags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serviceOn(t, dataDir, { boot = false } = {}) {
  const options = {
    prefix: "wazap-flags-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
  };
  const make = boot ? bootedService(WhatsAppService, options) : Promise.resolve(connectedService(WhatsAppService, options));
  return make.then((connected) => {
    t.after(() => connected.svc.stop());
    connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
    connected.sent = [];
    connected.sock.relayMessage = async (jid, message, options) => {
      connected.sent.push({ jid, message, options });
      return options.messageId;
    };
    return connected;
  });
}

let seq = 0;
function mention(chat, mentioned, { fromMe = false, participant = DAN } = {}) {
  return {
    key: { remoteJid: chat, fromMe, id: `F${++seq}`, ...(fromMe ? {} : { participant }) },
    message: { extendedTextMessage: { text: "@cineva vii?", contextInfo: { mentionedJid: mentioned } } },
    messageTimestamp: T0 + seq,
  };
}

const flagsOf = (svc, raw, chat = raw.key.remoteJid) => svc.db.messages.get(`${Boolean(raw.key.fromMe)}_${chat}_${raw.key.id}`).flags;

test("a group message that mentions the account is mentions_me, by number or by lid, live, appended or synced", async (t) => {
  const { svc, sock } = await serviceOn(t, dataDirFor(t));
  const live = mention(GROUP, [ME]);
  const other = mention(GROUP, [ANA]);
  const none = { key: { remoteJid: GROUP, fromMe: false, id: "PLAIN", participant: DAN }, message: { conversation: "salut" }, messageTimestamp: T0 };
  const mine = mention(GROUP, [ME], { fromMe: true });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [live, other, none, mine] });
  assert.equal(flagsOf(svc, live), MENTIONS);
  assert.equal(flagsOf(svc, other), 0);
  assert.equal(flagsOf(svc, none), 0);
  assert.equal(flagsOf(svc, mine), 0, "the account mentioning itself is not being addressed");

  const byLid = mention(GROUP, [ME_LID]);
  sock.ev.emit("messages.upsert", { type: "notify", messages: [byLid] });
  assert.equal(flagsOf(svc, byLid), 0, "a lid nobody paired yet is not the account");
  sock.ev.emit("lid-mapping.update", { lid: ME_LID, pn: ME });
  const byLidLater = mention(GROUP, [ME_LID]);
  sock.ev.emit("messages.upsert", { type: "append", messages: [byLidLater] });
  assert.equal(flagsOf(svc, byLidLater), MENTIONS);

  const direct = mention(ANA, [`${ME.split("@")[0]}:7@s.whatsapp.net`], { participant: undefined });
  const synced = mention(GROUP, [ME]);
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [direct, synced], isLatest: true, progress: 100 });
  await svc.historyIdle();
  assert.equal(flagsOf(svc, direct), MENTIONS, "a device-suffixed spelling of the number, in a direct chat, from a history sync");
  assert.equal(flagsOf(svc, synced), MENTIONS);
});

test("the account's own message sent through wazap is via_wazap, its echo after a restart too, and one sent from the phone is not", async (t) => {
  const dataDir = dataDirFor(t);
  const first = await serviceOn(t, dataDir);
  const sent = await first.svc.draft({ kind: "text", chatId: ANA, text: "Ajung la 6." }, "s");
  const receipt = await first.svc.confirm(sent.draft_id, "s");
  assert.equal(first.svc.db.messages.get(receipt.message_id).flags, VIA, "stored by the send itself");

  const phone = { key: { remoteJid: ANA, fromMe: true, id: "FROM-PHONE" }, message: { conversation: "scris pe telefon" }, messageTimestamp: T0 };
  first.sock.ev.emit("messages.upsert", { type: "notify", messages: [phone] });
  assert.equal(flagsOf(first.svc, phone), 0);

  // A send whose outcome is unknown when the process goes away.
  const unsure = await first.svc.draft({ kind: "text", chatId: ANA, text: "Poate." }, "s");
  const keys = [];
  first.sock.relayMessage = (_jid, _message, options) => {
    keys.push(options.messageId);
    return new Promise(() => {});
  };
  void first.svc.confirm(unsure.draft_id, "s").catch(() => {});
  await waitFor(() => keys.length === 1, 3_000, "the send handed to the socket");
  first.svc.accountDb.close();

  const second = await serviceOn(t, dataDir);
  const echo = { key: { remoteJid: ANA, fromMe: true, id: keys[0] }, message: { conversation: "Poate." }, messageTimestamp: T0 + 5 };
  second.sock.ev.emit("messages.upsert", { type: "notify", messages: [echo] });
  assert.equal(flagsOf(second.svc, echo), VIA, "the echo after the restart is wazap's send");
  assert.equal((await second.svc.confirm(unsure.draft_id, "s")).message_id, `true_${ANA}_${keys[0]}`);
  assert.equal(second.svc.db.messages.get(receipt.message_id).flags, VIA);
});

test("what was stored before the flags existed gets its mentions from the backfill at boot, the last 14 days", async (t) => {
  const dataDir = dataDirFor(t);
  const first = await serviceOn(t, dataDir);
  const now = Date.now();
  const store = (id, ts, mentioned) => {
    const raw = {
      key: { remoteJid: GROUP, fromMe: false, id, participant: DAN },
      message: { extendedTextMessage: { text: "@x", contextInfo: { mentionedJid: mentioned } } },
      messageTimestamp: Math.floor(ts / 1000),
    };
    // As an earlier build stored it: the protobuf, no flags.
    first.svc.db.messages.upsert({
      chatJid: GROUP,
      keyId: id,
      fromMe: false,
      senderJid: DAN,
      ts: Math.floor(ts / 1000) * 1000,
      type: "text",
      text: "@x",
      raw: proto.WebMessageInfo.encode(raw).finish(),
    });
    return `false_${GROUP}_${id}`;
  };
  const recent = store("RECENT", now - 3_600_000, [ME]);
  const notMe = store("NOT-ME", now - 3_000_000, [ANA]);
  const old = store("OLD", now - 20 * 86_400_000, [ME]);
  first.svc.db.messages.requestFlagsBackfill();
  await first.svc.stop();

  const second = await serviceOn(t, dataDir, { boot: true });
  await waitFor(() => !second.svc.db.messages.flagsBackfillPending(), 5_000, "the backfill to finish");
  assert.equal(second.svc.db.messages.get(recent).flags, MENTIONS);
  assert.equal(second.svc.db.messages.get(notMe).flags, 0);
  assert.equal(second.svc.db.messages.get(old).flags, 0, "older than the window catch_up reads");
});
