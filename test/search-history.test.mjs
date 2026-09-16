/**
 * search_messages and the whole local history. A chat's history file — the
 * synced backfill an older wazap wrote, imported into the account database at
 * boot — answers the same keyword live messages do, old and new side by side,
 * across chats. There is no per-chat window any more: every message the
 * database holds is searched.
 *
 * Every answer declares the window it searched: the coverage block counts the
 * held messages in scope and dates the window's bounds, so a miss never reads
 * as an empty history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proto } from "baileys";
import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { accountPaths } from "../dist/config.js";
import { asToolSource, connectedService, storedIds } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const day = 86_400_000;

const raw = (chat, id, body, tsS, key = {}) => ({
  key: { remoteJid: chat, fromMe: false, id, ...key },
  messageTimestamp: tsS,
  message: { conversation: body },
});

const encodeRaw = (msg) => Buffer.from(proto.WebMessageInfo.encode(msg).finish()).toString("base64");
/** One history line the store loader accepts — the shape appendHistory writes. */
const historyLine = (msg, sid) => `${JSON.stringify({ sid, ts: msg.messageTimestamp, raw: encodeRaw(msg) })}\n`;

function seedHistory(dataDir, jid, lines) {
  const historyDir = join(accountPaths(dataDir, "default").root, "history");
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${jid}.jsonl`), lines.join(""));
}

function setup(dataDir) {
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-search-hist-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true, dataDir },
  });
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(connected.svc), {
    allowWrite: false,
  });
  const call = (name, args = {}) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  const live = (chat, id, body, key = {}) =>
    connected.sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [raw(chat, id, body, Math.floor(Date.now() / 1000), key)],
    });
  return { ...connected, call, live };
}

test("search_messages reaches the synced backfill and the live ring alike, across chats", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-search-hist-"));
  const oldS = Math.floor((Date.now() - 200 * day) / 1000);
  seedHistory(dataDir, ANA, [
    historyLine(raw(ANA, "H1", "cheltuială cu chiria de acum șase luni", oldS), `false_${ANA}_H1`),
    historyLine(raw(ANA, "H2", "cheltuială cu medicul", oldS + 60), `false_${ANA}_H2`),
  ]);
  seedHistory(dataDir, GROUP, [
    historyLine(
      raw(GROUP, "H3", "cheltuială de grup veche", oldS + 120, { participant: DAN }),
      `false_${GROUP}_H3`
    ),
  ]);

  const { svc, call, live } = setup(dataDir);
  try {
    await svc.bootStorage();
    live(ANA, "L1", "cheltuială de azi");
    live(DAN, "L2", "cheltuială la dan");

    const all = await call("search_messages", { query: "cheltuială", limit: 50 });
    assert.deepEqual(
      all.structuredContent.messages.map((m) => m.message_id).sort(),
      [`false_${ANA}_H1`, `false_${ANA}_H2`, `false_${GROUP}_H3`, `false_${ANA}_L1`, `false_${DAN}_L2`].sort(),
      "backfilled lines months old and live arrivals answer the same query"
    );
    const texts = new Set(all.structuredContent.messages.map((m) => m.text));
    assert.ok(texts.has("cheltuială cu chiria de acum șase luni"), "the oldest line is searched, not just held");

    // The answer declares its window: every held message, over their real span.
    assert.deepEqual(
      {
        searched: all.structuredContent.coverage.searched,
        chats: all.structuredContent.coverage.chats,
        per_chat_cap: all.structuredContent.coverage.per_chat_cap,
      },
      { searched: 5, chats: 3, per_chat_cap: null }
    );
    assert.equal(Date.parse(all.structuredContent.coverage.oldest_at), oldS * 1000);
    assert.match(all.content[0].text, /Searched 5 held messages across 3 chats, \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/);
    assert.match(all.content[0].text, /every message this device synced is kept/);

    const scoped = await call("search_messages", { query: "cheltuială", chat_id: ANA });
    assert.deepEqual(
      scoped.structuredContent.messages.map((m) => m.message_id).sort(),
      [`false_${ANA}_H1`, `false_${ANA}_H2`, `false_${ANA}_L1`].sort()
    );
    assert.equal(scoped.structuredContent.coverage.searched, 3, "a scoped search counts that chat's window alone");
    assert.equal(scoped.structuredContent.coverage.chats, 1);
    assert.match(scoped.content[0].text, /Searched 3 held messages of this chat/);

    // The group hit is attributable too — its sender is the participant, not the chat.
    const groupHit = all.structuredContent.messages.find((m) => m.message_id === `false_${GROUP}_H3`);
    assert.equal(groupHit.sender.id, DAN);
    assert.equal(groupHit.sender.phone, "40700000003");
  } finally {
    await svc.stop();
  }
});

test("a backfill deeper than the old 1000 cap answers keyword search", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-search-hist-"));
  const baseS = Math.floor((Date.now() - 300 * day) / 1000);
  const lines = [];
  for (let i = 0; i < 1_500; i++) {
    const body = i === 0 ? "vechime în capul listei" : i === 400 ? "mijlocul unic al istoriei" : `mesaj curent ${i}`;
    lines.push(historyLine(raw(ANA, `B${i}`, body, baseS + i), `false_${ANA}_B${i}`));
  }
  seedHistory(dataDir, ANA, lines);

  const { svc, call } = setup(dataDir);
  try {
    await svc.bootStorage();
    assert.equal(storedIds(svc, ANA).length, 1_000, "a page holds a thousand");
    assert.equal(svc.db.search.coverage({ chat: ANA }).messages, 1_500, "the whole file is in the database");

    // Both markers sat beyond the old cap — positions 0 and 400 of a 1500-line
    // file were dropped from memory before the bump, and the query missed them.
    const oldest = await call("search_messages", { query: "vechime" });
    assert.equal(oldest.structuredContent.count, 1);
    assert.equal(oldest.structuredContent.messages[0].message_id, `false_${ANA}_B0`);

    const middle = await call("search_messages", { query: "mijlocul unic", chat_id: ANA });
    assert.equal(middle.structuredContent.count, 1);
    assert.equal(middle.structuredContent.messages[0].message_id, `false_${ANA}_B400`);
  } finally {
    await svc.stop();
  }
});

test("there is no per-chat window: a chat past the old 2000 cap answers keyword search from its oldest message", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-search-hist-"));
  const baseS = Math.floor((Date.now() - 300 * day) / 1000);
  const lines = [];
  for (let i = 0; i < 2_100; i++) {
    const body = i === 0 ? "vechime unică" : `mesaj curent ${i}`;
    lines.push(historyLine(raw(ANA, `B${i}`, body, baseS + i), `false_${ANA}_B${i}`));
  }
  seedHistory(dataDir, ANA, lines);

  const { svc, call } = setup(dataDir);
  try {
    await svc.bootStorage();
    assert.equal(svc.hasMessage(`false_${ANA}_B0`), true, "the oldest is kept");

    const oldest = await call("search_messages", { query: "vechime" });
    assert.equal(oldest.structuredContent.count, 1, "the oldest message answers too");
    assert.equal(oldest.structuredContent.messages[0].message_id, `false_${ANA}_B0`);

    // The answer declares what it searched: all 2,100, bounds dated.
    const cov = oldest.structuredContent.coverage;
    assert.equal(cov.searched, 2_100);
    assert.equal(cov.per_chat_cap, null);
    assert.equal(Date.parse(cov.oldest_at), baseS * 1000, "the window starts at the first line");
    assert.match(oldest.content[0].text, /Searched 2,100 held messages/);

    const current = await call("search_messages", { query: "mesaj curent", limit: 50 });
    assert.equal(current.structuredContent.count, 50);
    const indexes = current.structuredContent.messages.map((m) => Number(m.message_id.split("_").at(-1).slice(1)));
    assert.deepEqual(indexes, Array.from({ length: 50 }, (_, i) => 2_099 - i), "newest first");

    // Time filters narrow the declared window, not just the hits.
    const narrowed = await call("search_messages", {
      query: "mesaj curent",
      chat_id: ANA,
      since: new Date((baseS + 2_000) * 1000).toISOString(),
    });
    assert.equal(narrowed.structuredContent.coverage.searched, 100, "since cuts the searched window too");
  } finally {
    await svc.stop();
  }
});
