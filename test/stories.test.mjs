/**
 * Stories (status updates) arrive on `status@broadcast` with the author as
 * the participant. They are shown in one place, kept apart from the chats,
 * and let go after a day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const STATUS = "status@broadcast";

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-stories-", id: ME, name: "Răzvan" });
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, svc, { allowWrite: false });
  const call = (name, args = {}) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const story = (author, content, { at = Date.now(), pushName } = {}) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: STATUS, fromMe: false, id: `S${++seq}`, participant: author },
          message: typeof content === "string" ? { extendedTextMessage: { text: content } } : content,
          messageTimestamp: Math.floor(at / 1000),
          ...(pushName ? { pushName } : {}),
        },
      ],
    });
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  return { svc, sock, call, story };
}

test("stories are listed by author, newest first, and show nowhere else", async () => {
  const { call, story } = setup();
  const hour = 3_600_000;
  story(ANA, "la mare 🌊", { at: Date.now() - 3 * hour });
  story(DAN, { imageMessage: { mimetype: "image/jpeg", caption: "apus" } }, { at: Date.now() - hour, pushName: "Dan" });
  story(ANA, "a doua", { at: Date.now() - 25 * hour });

  const result = await call("get_stories", {});
  assert.deepEqual(
    result.structuredContent.stories.map((s) => [s.sender.name, s.text]),
    [["Dan", "[image] apus"], ["Ana", "la mare 🌊"]],
    "the day-old one is gone, the rest newest first",
  );
  assert.match(result.content[0].text, /## Dan — `40700000003@s.whatsapp.net`/);
  assert.match(result.content[0].text, /- 3h ago · la mare 🌊/);

  const recent = await call("get_recent_messages", { hours: 24 });
  assert.equal(recent.structuredContent.conversation_count, 0, "not a conversation");
  const chats = await call("list_chats", {});
  assert.equal(chats.structuredContent.count, 0, "not a chat");
  const wait = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(wait.structuredContent.timed_out, true, "not something a wait wakes for");

  const narrow = await call("get_stories", { hours: 2 });
  assert.deepEqual(narrow.structuredContent.stories.map((s) => s.sender.name), ["Dan"]);
});

test("a story's photo gets a preview and its message id works with the media tools", async () => {
  const { svc, call, story } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
  story(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: jpeg } });
  const result = await call("get_stories", { include_previews: true });
  assert.equal(result.structuredContent.preview_count, 1);
  assert.equal(result.content[1].type, "image");
  const id = result.structuredContent.stories[0].message_id;
  const one = await call("get_message", { message_id: id });
  assert.equal(one.structuredContent.sender.name, "Ana");
  assert.equal(svc.store.chatOf.get(id), STATUS);
});

test("stories survive a restart through the snapshot, and the user's own are not kept", async () => {
  const { svc, story, sock } = setup();
  story(ANA, "ieri");
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: STATUS, fromMe: true, id: "MINE" }, message: { conversation: "a mea" }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const snapshot = svc.store.serialize();
  assert.deepEqual(snapshot.stories, [`false_${STATUS}_S1`]);
  assert.ok(snapshot.messages[`false_${STATUS}_S1`], "the message travels with it");

  const { svc: again } = connectedService(WhatsAppService, { prefix: "wazap-stories-", id: ME, name: "Răzvan" });
  again.store.hydrate(JSON.parse(JSON.stringify(snapshot)));
  const back = (await again.getStories(24)).data;
  assert.deepEqual(back.map((s) => s.text), ["ieri"]);
});
