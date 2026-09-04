/**
 * The three tools that turn a catch-up into attention: waiting for what
 * arrives, seeing what was sent, and knowing who is still waiting.
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
const GROUP = "120363000000000001@g.us";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-attention-", id: ME, name: "Răzvan" });
  const server = fakeServer();
  registerTools(server, svc, { allowWrite: false });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  // Through the schema, so defaults apply the way they do over MCP.
  const call = (name, args = {}) => {
    const { meta, handler } = server.tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: typeof content === "string" ? { conversation: content } : content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return id;
  };
  return { svc, sock, call, arrive };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("wait_for_messages returns the message that lands while it waits, and nothing of the user's own", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 5 });
  await sleep(30);
  arrive(ANA, "mâine la 10?", { fromMe: true });
  arrive(ANA, "ești liber mâine la 10?");
  const result = await waiting;
  assert.equal(result.structuredContent.timed_out, false);
  assert.deepEqual(
    result.structuredContent.messages.map((m) => [m.sender.name, m.text]),
    [["Ana", "ești liber mâine la 10?"]],
  );
  assert.match(result.content[0].text, /1 new message/);
  assert.match(result.content[0].text, /cursor: `/);
});

test("a burst that follows the first message comes back in the same answer", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 5 });
  await sleep(20);
  arrive(ANA, "salut");
  await sleep(200);
  arrive(ANA, "ai o secundă?");
  const result = await waiting;
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.text),
    ["salut", "ai o secundă?"],
  );
});

test("the cursor replays what landed between two calls, and a timeout comes back empty", async () => {
  const { call, arrive } = setup();
  const first = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(first.structuredContent.timed_out, true);
  assert.deepEqual(first.structuredContent.messages, []);
  assert.match(first.content[0].text, /Nothing arrived/);

  arrive(DAN, "poți să mă suni?");
  const started = Date.now();
  const second = await call("wait_for_messages", { timeout_seconds: 30, cursor: first.structuredContent.cursor });
  assert.ok(Date.now() - started < 3_000, "did not block: the message was already there");
  assert.deepEqual(
    second.structuredContent.messages.map((m) => m.text),
    ["poți să mă suni?"],
  );

  const third = await call("wait_for_messages", { timeout_seconds: 1, cursor: second.structuredContent.cursor });
  assert.deepEqual(third.structuredContent.messages, [], "nothing is replayed twice");
});

test("a cursor from another run of wazap starts the wait from now and says so", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "before");
  const result = await call("wait_for_messages", { timeout_seconds: 1, cursor: "deadbeef:1" });
  assert.equal(result.structuredContent.cursor_reset, true);
  assert.deepEqual(result.structuredContent.messages, []);
  assert.match(result.content[0].text, /another run/);
});

test("addressed_to_me wakes for a direct message, a mention and a reply, not for group chatter", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 3, addressed_to_me: true });
  await sleep(20);
  arrive(GROUP, "cineva vine la 12?", { participant: DAN });
  await sleep(100);
  arrive(GROUP, { extendedTextMessage: { text: "@Răzvan poți?", contextInfo: { mentionedJid: [ME] } } }, { participant: DAN });
  const result = await waiting;
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.text),
    ["@Răzvan poți?"],
    "only the mention",
  );

  const chatOnly = call("wait_for_messages", { timeout_seconds: 3, chat_id: ANA, cursor: result.structuredContent.cursor });
  await sleep(20);
  arrive(DAN, "ignored, wrong chat");
  arrive(ANA, "și eu");
  assert.deepEqual((await chatOnly).structuredContent.messages.map((m) => m.text), ["și eu"]);
});

test("include_previews attaches the preview WhatsApp shipped with a photo and labels its line", async () => {
  const { call, arrive } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  arrive(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: jpeg, caption: "chitanța" } });
  arrive(ANA, "gata");

  const plain = await call("get_recent_messages", { hours: 1 });
  assert.equal(plain.content.length, 1, "no image block unless asked");

  const withPreviews = await call("get_recent_messages", { hours: 1, include_previews: true });
  assert.equal(withPreviews.structuredContent.preview_count, 1);
  assert.equal(withPreviews.content.length, 2);
  assert.deepEqual(withPreviews.content[1], { type: "image", data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" });
  assert.match(withPreviews.content[0].text, /1 preview attached/);
  assert.match(withPreviews.content[0].text, /\[image\] chitanța \(preview 1\)/);

  const read = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(read.content.length, 2);
  assert.match(read.content[0].text, /\[preview 1, image\]/);
});

test("a photo that shipped no preview is downloaded once, shrunk here, and remembered", async () => {
  const { svc, call, arrive } = setup();
  const { encode } = await import("jpeg-js");
  const width = 640;
  const height = 480;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([200, 30, 30, 255], i * 4);
  const photo = encode({ data, width, height }, 90).data;
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return photo;
  };
  arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: photo.length, caption: "poza" } });
  arrive(DAN, { imageMessage: { mimetype: "image/jpeg", url: "https://x/expired" } });
  svc.mediaBuffer = async (_sock, sid) => {
    downloads++;
    if (sid.includes(DAN)) throw new Error("410 gone");
    return photo;
  };

  const first = await call("get_recent_messages", { hours: 1, include_previews: true });
  assert.equal(downloads, 2, "each photo fetched once");
  assert.equal(first.structuredContent.preview_count, 1, "the expired one goes without");
  assert.match(first.content[0].text, /1 preview attached.*1 photo without a preview/);
  const block = first.content[1];
  assert.equal(block.type, "image");
  const { decode } = await import("jpeg-js");
  const small = decode(Buffer.from(block.data, "base64"));
  assert.deepEqual([small.width, small.height], [320, 240], "shrunk to the preview edge");
  assert.ok(block.data.length < 20_000, `a preview stays small: ${block.data.length} b64 chars`);

  const again = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(downloads, 2, "the second time it comes from the cache");
  assert.equal(again.structuredContent.preview_count, 1);
  assert.equal(svc.store.serialize().previews[`false_${ANA}_M1`].base64, block.data, "and survives a restart");
});

test("get_unanswered lists the people whose ask is still open, oldest first, and nobody else", async () => {
  const { call, arrive } = setup();
  const hour = 3_600_000;
  arrive(ANA, "poți să-mi trimiți contractul?", { at: Date.now() - 50 * hour });
  arrive(DAN, "mersi", { at: Date.now() - 3 * hour });
  arrive(DAN, "ok", { at: Date.now() - 2 * hour });
  const ELA = "40700000004@s.whatsapp.net";
  arrive(ELA, "când ajungi?", { at: Date.now() - 5 * hour });
  arrive(ELA, "la 6", { fromMe: true, at: Date.now() - 4 * hour });
  const VLAD = "40700000005@s.whatsapp.net";
  arrive(VLAD, "ai o clipă", { at: Date.now() - 4 * hour });
  arrive(VLAD, "?", { at: Date.now() - 4 * hour + 1000 });
  arrive(GROUP, "cine vine la 12?", { participant: DAN, at: Date.now() - hour });
  arrive(GROUP, { extendedTextMessage: { text: "@Răzvan tu?", contextInfo: { mentionedJid: [ME] } } }, { participant: DAN, at: Date.now() - hour });
  const LINK = "40700000006@s.whatsapp.net";
  arrive(LINK, "https://youtu.be/abc?si=xyz", { at: Date.now() - hour });
  const OLD = "40700000007@s.whatsapp.net";
  arrive(OLD, "mai ești interesat?", { at: Date.now() - 20 * 24 * hour });

  const all = await call("get_unanswered", {});
  assert.deepEqual(
    all.structuredContent.chats.map((c) => [c.name, c.type, c.ask.text, c.messages_since_you]),
    [
      ["Ana", "individual", "poți să-mi trimiți contractul?", 1],
      ["40700000005", "individual", "?", 2],
      ["120363000000000001@g.us", "group", "@Răzvan tu?", 2],
    ],
  );
  assert.match(all.content[0].text, /Waiting on you \(3\)/);
  assert.match(all.content[0].text, /> poți să-mi trimiți contractul\?/);

  const old = await call("get_unanswered", { min_age_hours: 48 });
  assert.deepEqual(old.structuredContent.chats.map((c) => c.name), ["Ana"], "a link's query string is not a question, and a 20-day-old ask is abandoned");

  const everything = await call("get_unanswered", { min_age_hours: 48, max_age_hours: 8760 });
  assert.deepEqual(everything.structuredContent.chats.map((c) => c.name), ["40700000007", "Ana"]);
});

test("a voice note nobody has heard is an ask; a transcribed one is judged on its words", async () => {
  const { svc, call, arrive } = setup();
  const voice = { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 12 } };
  const id = arrive(ANA, voice);
  let result = await call("get_unanswered", {});
  assert.deepEqual(result.structuredContent.chats.map((c) => c.ask.type), ["voice"]);

  svc.store.transcripts.set(`false_${ANA}_${id}`, { text: "gata, am rezolvat, mersi", provider: "local" });
  result = await call("get_unanswered", {});
  assert.deepEqual(result.structuredContent.chats, [], "the words say nothing was asked");
});

test("a reaction lands on the message it answers, never as a line of its own, and a withdrawal takes it off", async () => {
  const { svc, call, arrive } = setup();
  const target = arrive(ANA, "am ajuns");
  const react = (text, { fromMe = false } = {}) =>
    arrive(ANA, { reactionMessage: { key: { remoteJid: ANA, fromMe: false, id: target }, text } }, { fromMe });
  react("❤️");
  react("👍", { fromMe: true });

  let read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(read.structuredContent.messages.map((m) => m.text), ["am ajuns"], "no [reaction] line");
  assert.deepEqual(
    read.structuredContent.messages[0].reactions.map((r) => [r.emoji, r.sender]),
    [["❤️", ANA], ["👍", ME]],
  );
  assert.match(read.content[0].text, /\[❤️👍\]/);

  react("");
  read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(read.structuredContent.messages[0].reactions.map((r) => r.emoji), ["👍"], "Ana took hers back");

  const recent = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(recent.structuredContent.timed_out, true, "a reaction wakes no wait");
  assert.equal(svc.store.serialize().reactions[`false_${ANA}_${target}`][ME], "👍", "and it is written to disk");
});
