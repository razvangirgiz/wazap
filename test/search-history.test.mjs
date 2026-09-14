/**
 * search_messages and the whole local history. A chat's history file — the
 * synced backfill, reloaded from disk at boot — answers the same keyword the
 * live ring does, old and new side by side, across chats. The one boundary is
 * the store's own: the newest 1000 messages per chat stay in memory; anything
 * older is still on disk for the recall index, not for keyword search.
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
import { asToolSource, connectedService } from "./helpers.mjs";

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
    await svc.loadPersisted();
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

    const scoped = await call("search_messages", { query: "cheltuială", chat_id: ANA });
    assert.deepEqual(
      scoped.structuredContent.messages.map((m) => m.message_id).sort(),
      [`false_${ANA}_H1`, `false_${ANA}_H2`, `false_${ANA}_L1`].sort()
    );

    // The group hit is attributable too — its sender is the participant, not the chat.
    const groupHit = all.structuredContent.messages.find((m) => m.message_id === `false_${GROUP}_H3`);
    assert.equal(groupHit.sender.id, DAN);
    assert.equal(groupHit.sender.phone, "40700000003");
  } finally {
    await svc.stop();
  }
});

test("the in-memory cap is the boundary: a chat keeps its newest 1000 searchable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-search-hist-"));
  const baseS = Math.floor((Date.now() - 300 * day) / 1000);
  const lines = [];
  for (let i = 0; i < 1_100; i++) {
    const body = i === 0 ? "vechime unică" : `mesaj curent ${i}`;
    lines.push(historyLine(raw(ANA, `B${i}`, body, baseS + i), `false_${ANA}_B${i}`));
  }
  seedHistory(dataDir, ANA, lines);

  const { svc, call } = setup(dataDir);
  try {
    await svc.loadPersisted();
    assert.equal(svc.store.byChat.get(ANA).length, 1_000, "the ring keeps the newest slice of the file");
    assert.equal(svc.store.messages.has(`false_${ANA}_B0`), false, "the oldest were let go");

    const oldest = await call("search_messages", { query: "vechime" });
    assert.equal(oldest.structuredContent.count, 0, "past the cap — the recall index's reach, not keyword's");

    const current = await call("search_messages", { query: "mesaj curent", limit: 50 });
    assert.equal(current.structuredContent.count, 50);
    const indexes = current.structuredContent.messages.map((m) => Number(m.message_id.split("_").at(-1).slice(1)));
    assert.ok(Math.min(...indexes) >= 100, "only the retained window answers");
  } finally {
    await svc.stop();
  }
});
