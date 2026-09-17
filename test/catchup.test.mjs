/**
 * catch_up (F2-2): what the user missed, in one call, within a token budget.
 * Driven through the registered tool against services fed by socket events,
 * the way an MCP session reaches it: the mark per client, the per-chat window,
 * every section's rules, several accounts, the budget and the cursor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { proto } from "baileys";
import { z } from "zod";

import { callText } from "../dist/messages.js";
import { readCallText } from "../dist/catchup-scan.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const ELA = "40700000004@s.whatsapp.net";
const BOT = "40700000009@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MUTED = "120363000000000002@g.us";
const LEFT = "120363000000000003@g.us";
const CHANNEL = "120363000000000004@newsletter";
const STATUS = "status@broadcast";
const HOUR = 3_600_000;
const CALL = proto.Message.CallLogMessage.CallOutcome;

function toolsOf(source, opts = {}) {
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(source), {
    allowWrite: false,
    ...opts,
  });
  // Through the schema, so defaults apply the way they do over MCP.
  const call = (name, args = {}) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  return { tools, call };
}

function account(options = {}) {
  const { id = ME, name = "Răzvan", account: record } = options;
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-catchup-", id, name, ...(record ? { account: record } : {}) });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
    { id: ELA, name: "Ela" },
    { id: BOT, name: "Hermi" },
  ]);
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at = Date.now(), key } = {}) => {
    const id = key ?? `M${++seq}`;
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
    return `${fromMe}_${chat}_${id}`;
  };
  const mention = (text) => ({ extendedTextMessage: { text, contextInfo: { mentionedJid: [id] } } });
  const phoneRead = (chat, sid) => {
    const key = sid.split("_").pop();
    sock.ev.emit("messages.update", [{ key: { remoteJid: chat, fromMe: false, id: key }, update: { status: proto.WebMessageInfo.Status.READ } }]);
  };
  const callLog = (chat, outcome, { fromMe = false, at, seconds, participant } = {}) =>
    arrive(chat, { callLogMesssage: { callOutcome: outcome, isVideo: false, ...(seconds ? { durationSecs: seconds } : {}) } }, { fromMe, at, participant });
  return { svc, sock, arrive, mention, phoneRead, callLog };
}

const text = (result) => result.content[0].text;
const chatsOf = (result, section) => result.structuredContent[section].map((entry) => entry.chat);

test("a call's stored words read back as the call they render: every direction, outcome and length", () => {
  for (const kind of ["voice", "video"]) {
    for (const direction of ["incoming", "outgoing"]) {
      for (const outcome of ["answered", "missed", "rejected", "unanswered"]) {
        for (const duration_seconds of [undefined, 42, 360, 3900]) {
          const info = { kind, direction, outcome, ...(outcome === "answered" && duration_seconds ? { duration_seconds } : {}) };
          const reading = readCallText(callText(info));
          assert.ok(reading, callText(info));
          assert.equal(reading.outgoing, direction === "outgoing", callText(info));
          assert.equal(reading.video, kind === "video", callText(info));
          const expected = direction === "outgoing" && outcome === "missed" ? "unanswered" : outcome;
          assert.equal(reading.outcome, direction === "incoming" && outcome === "unanswered" ? "unanswered" : expected, callText(info));
          if (info.duration_seconds) assert.ok(Math.abs(reading.seconds - info.duration_seconds) < 60, callText(info));
        }
      }
    }
  }
  assert.equal(readCallText("[group call]").outcome, "offered");
  assert.equal(readCallText("[voice message · 0:42]"), null);
});

test("catch_up is a read tool with an output schema, registered in read sessions, and its answer fits the schema", async () => {
  const { svc, arrive } = account();
  const { tools, call } = toolsOf(svc);
  const meta = tools.get("catch_up").meta;
  assert.equal(meta.annotations.readOnlyHint, true);
  assert.equal(meta.annotations.idempotentHint, false, "it moves the client's mark");
  assert.ok(meta.outputSchema);
  arrive(ANA, "ai ajuns?", { at: Date.now() - HOUR });
  const result = await call("catch_up");
  assert.doesNotThrow(() => z.object(meta.outputSchema).parse(result.structuredContent));
  assert.equal(result.structuredContent.account_id, "default");
  assert.equal(result.structuredContent.window.basis, "first_run");
  assert.equal(result.structuredContent.window.hours, 24);
});

test("the mark is per client: one client's catch-up moves its own mark and leaves another's where it was", async () => {
  const { svc, arrive } = account();
  const claude = toolsOf(svc, { client: "oauth:claude" });
  const chatgpt = toolsOf(svc, { client: "oauth:chatgpt" });
  arrive(DAN, "salut, am ajuns acasă", { at: Date.now() - 2 * HOUR });

  const first = await claude.call("catch_up");
  assert.deepEqual(chatsOf(first, "direct"), [DAN]);
  assert.equal(first.structuredContent.accounts[0].mark.moved, true);
  assert.match(text(first), /next catch-up starts after/);

  const again = await claude.call("catch_up");
  assert.deepEqual(chatsOf(again, "direct"), [], "nothing new for this client");
  assert.equal(again.structuredContent.window.basis, "last");
  assert.equal(again.structuredContent.accounts[0].mark.why, "nothing_new");
  assert.match(text(again), /Nothing new/);

  const other = await chatgpt.call("catch_up");
  assert.deepEqual(chatsOf(other, "direct"), [DAN], "the other client has not seen it");
  assert.equal(other.structuredContent.window.basis, "first_run");

  arrive(ANA, "bună, ce faci", { at: Date.now() - 1000 });
  const next = await claude.call("catch_up");
  assert.deepEqual(chatsOf(next, "direct"), [ANA], "only what arrived after the mark");
  assert.ok(svc.db.catchup.get("oauth:claude").throughId > svc.db.catchup.get("oauth:chatgpt").throughId);
});

test("stdio sessions catch up as `local`", async () => {
  const { svc, arrive } = account();
  arrive(DAN, "salut", { at: Date.now() - HOUR });
  await toolsOf(svc).call("catch_up");
  assert.ok(svc.db.catchup.get("local"));
});

test('since: "previous" repeats the last complete catch-up, hours and an ISO since never move the mark', async () => {
  const { svc, arrive } = account();
  const { call } = toolsOf(svc);
  arrive(DAN, "prima", { at: Date.now() - 3 * HOUR });
  await call("catch_up");
  const mark = svc.db.catchup.get("local");
  arrive(ANA, "a doua", { at: Date.now() - 1000 });

  const previous = await call("catch_up", { since: "previous" });
  assert.equal(previous.structuredContent.window.basis, "previous");
  assert.deepEqual(chatsOf(previous, "direct"), [DAN], "the window it covered, not what came after");
  assert.equal(previous.structuredContent.accounts[0].mark.why, "previous");
  assert.deepEqual(svc.db.catchup.get("local"), mark);

  const hours = await call("catch_up", { hours: 48 });
  assert.deepEqual(chatsOf(hours, "direct").sort(), [ANA, DAN].sort());
  assert.equal(hours.structuredContent.accounts[0].mark.why, "explicit_window");
  const since = await call("catch_up", { since: new Date(Date.now() - 2 * HOUR).toISOString() });
  assert.deepEqual(chatsOf(since, "direct"), [ANA]);
  assert.deepEqual(svc.db.catchup.get("local"), mark, "neither moved it");

  const bad = await call("catch_up", { since: "ieri" });
  assert.equal(bad.structuredContent.error, "INVALID_ID");
});

test("two catch-ups of one client racing each other move the mark once: the one that finishes second does not", async () => {
  const { svc, arrive } = account();
  const { call } = toolsOf(svc);
  arrive(DAN, "salut", { at: Date.now() - HOUR });
  const scan = svc.catchUpScan.bind(svc);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let calls = 0;
  svc.catchUpScan = async (request) => {
    const result = await scan(request);
    if (calls++ === 0) await held;
    return result;
  };
  const slow = call("catch_up");
  await new Promise((resolve) => setImmediate(resolve));
  arrive(ANA, "și eu", { at: Date.now() - 1000 });
  const fast = await call("catch_up");
  assert.equal(fast.structuredContent.accounts[0].mark.moved, true);
  const moved = svc.db.catchup.get("local");
  release();
  const late = await slow;
  assert.equal(late.structuredContent.accounts[0].mark.moved, false);
  assert.equal(late.structuredContent.accounts[0].mark.why, "moved_by_another_call");
  assert.deepEqual(svc.db.catchup.get("local"), moved, "the later mark stands");
});

test("a chat's window starts after the user's own reply and after what the phone already read", async () => {
  const { svc, arrive, phoneRead } = account();
  const { call } = toolsOf(svc);
  arrive(ANA, "unu", { at: Date.now() - 5 * HOUR });
  arrive(ANA, "răspuns", { fromMe: true, at: Date.now() - 4 * HOUR });
  arrive(ANA, "doi", { at: Date.now() - 3 * HOUR });
  const read = arrive(DAN, "citit pe telefon", { at: Date.now() - 3 * HOUR });
  arrive(DAN, "necitit", { at: Date.now() - 2 * HOUR });
  arrive(ELA, "tot citit", { at: Date.now() - 2 * HOUR });
  const elaRead = arrive(ELA, "și asta", { at: Date.now() - 2 * HOUR + 1000 });
  phoneRead(DAN, read);
  phoneRead(ELA, elaRead);

  const result = await call("catch_up", { hours: 24 });
  const direct = Object.fromEntries(result.structuredContent.direct.map((entry) => [entry.chat, entry]));
  assert.equal(direct[ANA].n, 1, "only what came after the user's reply");
  assert.equal(direct[ANA].q, "doi");
  assert.equal(direct[DAN].n, 1, "only what the phone had not read");
  assert.equal(direct[DAN].q, "necitit");
  assert.equal(direct[ELA], undefined, "a chat read to the end on the phone is not missed");
});

test("waiting: people before groups, amounts and dates rise, a voice note is quoted by its transcript, an unheard one is named in the footer", async () => {
  const { svc, arrive, mention } = account();
  const { call } = toolsOf(svc);
  arrive(GROUP, mention("@Răzvan vii mâine?"), { participant: DAN, at: Date.now() - 30 * HOUR });
  arrive(ANA, "ce mai faci, ieși în oraș?", { at: Date.now() - 20 * HOUR });
  arrive(DAN, "îmi dai înapoi 200 lei până vineri?", { at: Date.now() - 2 * HOUR });
  arrive(DAN, "și nu uita de cina de duminică, vine și tanti Lia.", { at: Date.now() - 2 * HOUR + 1000 });
  const voice = { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 42 } };
  const heard = arrive(ELA, voice, { at: Date.now() - 10 * HOUR });
  svc.db.messages.setTranscript(heard, "Vii duminică la cina de la 7? Vine și tanti Lia");
  const unheard = arrive(BOT, voice, { at: Date.now() - 5 * HOUR });
  arrive(ME, "notă", { fromMe: true, at: Date.now() - HOUR });

  const result = await call("catch_up", { hours: 48 });
  const waiting = result.structuredContent.waiting;
  assert.deepEqual(
    waiting.map((entry) => entry.chat),
    [ELA, DAN, ANA, BOT, GROUP],
    "people first; a sum or a day before the rest; then the oldest wait"
  );
  assert.equal(waiting[0].q, "Vii duminică la cina de la 7? Vine și tanti Lia");
  assert.equal(waiting[0].voice, "0:42");
  assert.equal(waiting[0].transcribed, true);
  assert.equal(waiting[1].sig, "amount,date,question");
  assert.equal(waiting[1].q, "îmi dai înapoi 200 lei până vineri?");
  assert.equal(waiting[1].then, "și nu uita de cina de duminică, vine și tanti Lia.", "what followed the ask rides with it");
  assert.match(text(result), /— "îmi dai înapoi 200 lei până vineri\?" · then "și nu uita de cina de duminică, vine și tanti Lia\." ·/);
  assert.equal(waiting[3].q, undefined, "an unheard voice note has nothing to quote");
  assert.equal(waiting[4].from, "Dan");
  assert.deepEqual(result.structuredContent.footer.voice_untranscribed, [unheard]);
  assert.match(text(result), /Voice notes not transcribed \(1\)/);
  assert.deepEqual(chatsOf(result, "direct"), [], "a chat waiting on the user is not listed again among people");
  assert.equal(result.structuredContent.addressed.length, 0, "the group's ask is waiting, not a second entry");
});

test("waiting holds an ask across catch-ups until it is answered, handled or two weeks old, and flags what is new", async () => {
  const { svc, arrive } = account();
  const { call } = toolsOf(svc);
  arrive(ANA, "poți să-mi trimiți contractul?", { at: Date.now() - 3 * 24 * HOUR });
  arrive(DAN, "mai ești interesat?", { at: Date.now() - 20 * 24 * HOUR });
  const first = await call("catch_up");
  assert.deepEqual(chatsOf(first, "waiting"), [ANA], "three days old, outside the 24 h window, still waiting; twenty days is abandoned");
  assert.equal(first.structuredContent.waiting[0].new, undefined);
  arrive(ELA, "când ajungi?", { at: Date.now() - 1000 });
  const second = await call("catch_up");
  assert.deepEqual(chatsOf(second, "waiting"), [ANA, ELA]);
  assert.equal(second.structuredContent.waiting[1].new, true);

  await call("mark_handled", { chat_id: ANA });
  arrive(ELA, "la 6", { fromMe: true, at: Date.now() });
  const third = await call("catch_up");
  assert.deepEqual(chatsOf(third, "waiting"), []);
});

test("an answered call after an ask says it may have been dealt with; missed calls group by person with what followed", async () => {
  const { svc, arrive, callLog } = account();
  const { call } = toolsOf(svc);
  arrive(ANA, "mă suni când poți?", { at: Date.now() - 5 * HOUR });
  callLog(ANA, CALL.CONNECTED, { seconds: 360, at: Date.now() - 4 * HOUR });
  callLog(DAN, CALL.MISSED, { at: Date.now() - 6 * HOUR });
  callLog(DAN, CALL.MISSED, { at: Date.now() - 5 * HOUR });
  callLog(ELA, CALL.MISSED, { at: Date.now() - 3 * HOUR });
  callLog(ELA, CALL.CONNECTED, { fromMe: true, at: Date.now() - 2 * HOUR });
  callLog(BOT, CALL.MISSED, { at: Date.now() - 3 * HOUR });
  arrive(BOT, "ok", { fromMe: true, at: Date.now() - 2 * HOUR });

  const result = await call("catch_up", { hours: 24 });
  const ana = result.structuredContent.waiting.find((entry) => entry.chat === ANA);
  assert.equal(ana.call_after.outgoing, undefined, "she called, and the call was answered");
  assert.equal(ana.call_after.seconds, 360);
  assert.match(text(result), /then they called \d\d:\d\d \(6 min\)/);
  assert.deepEqual(
    result.structuredContent.missed_calls.map((entry) => [entry.name, entry.n, entry.called_back ?? false, entry.wrote_after ?? false]),
    [
      ["Dan", 2, false, false],
      ["Ela", 1, true, false],
      ["Hermi", 1, false, true],
    ]
  );
  assert.deepEqual(chatsOf(result, "direct"), [], "a call is not a message among people");
});


test("addressed reaches into a muted group; muted groups fold into one row; left groups and channels are only counted", async () => {
  const { svc, sock, arrive, mention } = account();
  const { call } = toolsOf(svc);
  sock.ev.emit("chats.upsert", [
    { id: GROUP, name: "Echipa proiect" },
    { id: MUTED, name: "Bloc 12", muteEndTime: Date.now() + 30 * 24 * HOUR },
    { id: LEFT, name: "Fotbal joi", readOnly: true },
  ]);
  const mine = arrive(GROUP, "am trimis oferta", { fromMe: true, at: Date.now() - 6 * HOUR });
  const reply = {
    extendedTextMessage: {
      text: "super, mersi",
      contextInfo: { stanzaId: mine.split("_").pop(), participant: ME, quotedMessage: { conversation: "am trimis oferta" } },
    },
  };
  arrive(GROUP, reply, { participant: DAN, at: Date.now() - 5 * HOUR });
  arrive(GROUP, "și eu am văzut", { participant: ELA, at: Date.now() - 4 * HOUR });
  for (let i = 0; i < 5; i++) arrive(MUTED, `vecinii discută ${i}`, { participant: i % 2 ? ANA : DAN, at: Date.now() - (5 - i) * HOUR });
  arrive(MUTED, mention("@Răzvan ai cheia de la subsol, o lași la administrator"), { participant: ANA, at: Date.now() - 30 * 60_000 });
  arrive(
    MUTED,
    { pollCreationMessageV3: { name: "Aprobăm oferta de acoperiș?", options: [{ optionName: "Da" }, { optionName: "Nu" }], selectableOptionsCount: 1 } },
    { participant: DAN, at: Date.now() - 2 * HOUR }
  );
  const voted = arrive(
    GROUP,
    { pollCreationMessageV3: { name: "Pizza sau paste?", options: [{ optionName: "Pizza" }, { optionName: "Paste" }], selectableOptionsCount: 1 } },
    { participant: DAN, at: Date.now() - 2 * HOUR }
  );
  svc.db.messages.vote(voted, ME, JSON.stringify(["Pizza"]), Date.now() - HOUR);
  arrive(LEFT, "cine mai vine?", { participant: DAN, at: Date.now() - HOUR });
  arrive(CHANNEL, "Știrile zilei", { at: Date.now() - HOUR });
  arrive(CHANNEL, "Vremea", { at: Date.now() - HOUR + 1000 });

  const result = await call("catch_up", { hours: 24 });
  const addressed = result.structuredContent.addressed;
  assert.deepEqual(
    addressed.map((entry) => [entry.name, entry.kind, entry.from]),
    [
      ["Bloc 12", "mention", "Ana"],
      ["Echipa proiect", "reply", "Dan"],
      ["Bloc 12", "poll", "Dan"],
    ],
    "mentions and replies first, newest first, then the polls nobody answered for the user"
  );
  assert.equal(addressed[0].q, "@Răzvan ai cheia de la subsol, o lași la administrator");
  assert.equal(addressed[2].title, "Aprobăm oferta de acoperiș?");
  const groups = result.structuredContent.groups;
  assert.deepEqual(groups[0].name, "Echipa proiect");
  assert.deepEqual(groups[0].top.sort(), ["Dan", "Ela"]);
  assert.deepEqual(groups.at(-1), { muted_or_archived: true, groups: 1, n: 7, names: ["Bloc 12"] });
  assert.match(text(result), /- Muted or archived: 1 group, 7 new \(Bloc 12\)/);
  assert.deepEqual(result.structuredContent.footer.skipped, {
    left_groups: { chats: 1, messages: 1 },
    newsletters: { chats: 1, messages: 2 },
  });
  assert.match(text(result), /Left out: 1 group you left \(1 msgs\) · 1 channel \(2 msgs\)/);
  assert.ok(!JSON.stringify(result.structuredContent).includes("Știrile"), "a channel's words never show");
});

test("people: saved contacts first, by how much they wrote; business and unknown numbers last; one quote each with media counts", async () => {
  const { svc, sock, arrive } = account();
  const { call } = toolsOf(svc);
  const SHOP = "40700000010@s.whatsapp.net";
  const STRANGER = "40700000011@s.whatsapp.net";
  sock.ev.emit("contacts.upsert", [{ id: SHOP, verifiedName: "Curier Rapid", notify: "Curier Rapid" }]);
  arrive(SHOP, "Coletul dvs. cu AWB 889213 a fost livrat", { at: Date.now() - 3 * HOUR });
  arrive(SHOP, "Mulțumim!", { at: Date.now() - 3 * HOUR + 1000 });
  arrive(SHOP, "Evaluați livrarea", { at: Date.now() - 3 * HOUR + 2000 });
  arrive(STRANGER, "salut, sunt vecinul de la 4", { at: Date.now() - 2 * HOUR });
  arrive(ANA, "gata", { at: Date.now() - 2 * HOUR });
  arrive(DAN, { imageMessage: { mimetype: "image/jpeg", caption: "uite ce am găsit" } }, { at: Date.now() - 2 * HOUR });
  arrive(DAN, { imageMessage: { mimetype: "image/jpeg" } }, { at: Date.now() - 2 * HOUR + 1000 });
  arrive(DAN, { stickerMessage: { mimetype: "image/webp" } }, { at: Date.now() - 2 * HOUR + 2000 });

  const result = await call("catch_up", { hours: 24 });
  const direct = result.structuredContent.direct;
  assert.deepEqual(
    direct.map((entry) => entry.chat),
    [DAN, ANA, SHOP, STRANGER]
  );
  assert.deepEqual(direct[0].media, { image: 2, sticker: 1 });
  assert.equal(direct[0].q, "[image] uite ce am găsit", "the newest message worth quoting, not a bare sticker");
  assert.equal(direct[0].more_in_chat, 2);
  assert.equal(direct[2].business, true);
  assert.equal(direct[3].unknown, true);
  assert.match(text(result), /- Dan · 3 new · \d\d:\d\d · 2 photos, 1 sticker — "\[image\] uite ce am găsit" \(\+2 more\) · 40700000003@s\.whatsapp\.net/);
});

test("group names come from cached metadata: at most twelve groups fetched, and a fetch that hangs costs a second, not the answer", async () => {
  const { svc, sock, arrive } = account();
  const { call } = toolsOf(svc);
  const lid = "777888999000111@lid";
  const fetched = [];
  sock.groupMetadata = async (id) => {
    fetched.push(id);
    if (id.startsWith("120363000000009")) return new Promise(() => {});
    return { id, subject: "Meniul zilei", participants: [{ id: lid, phoneNumber: "40700000040@s.whatsapp.net", name: "Rodica" }] };
  };
  for (let g = 0; g < 15; g++) {
    const jid = `12036300000000${g < 10 ? `9${g}` : `8${g}`}@g.us`;
    arrive(jid, `mesaj ${g} de la cineva din grup`, { participant: lid, at: Date.now() - HOUR + g * 1000 });
  }
  const started = Date.now();
  const first = await call("catch_up", { hours: 24 });
  const took = Date.now() - started;
  assert.ok(took >= 900 && took < 2_500, `seven fetches hang: the answer waits about a second (${took} ms)`);
  assert.equal(new Set(fetched).size, 12, "a dozen groups at most");
  assert.equal(first.structuredContent.groups.length, 15);
  assert.ok(first.structuredContent.groups.every((group) => group.top.includes("Rodica")), "a sender the address book lacks has the name a group gave them");
  const answered = fetched.filter((id) => !id.startsWith("120363000000009"));
  fetched.length = 0;
  await call("catch_up", { hours: 24 });
  assert.ok(answered.every((id) => !fetched.includes(id)), "a group fetched once is not fetched again");
});

test("a chat tagged #no-catchup is left out of every section and counted", async () => {
  const { svc, arrive } = account();
  const { call } = toolsOf(svc);
  arrive(BOT, "Raport: 3 sarcini gata. Continui?", { at: Date.now() - 2 * HOUR });
  arrive(BOT, "Am terminat", { at: Date.now() - HOUR });
  arrive(ANA, "bună", { at: Date.now() - HOUR });
  const tagged = await call("update_contact_details", { contact_id: BOT, add_tags: ["#no-catchup"] });
  assert.deepEqual(tagged.structuredContent.tags, ["no-catchup"]);

  const result = await call("catch_up", { hours: 24 });
  assert.ok(!JSON.stringify(result.structuredContent.waiting).includes(BOT));
  assert.deepEqual(chatsOf(result, "direct"), [ANA]);
  assert.deepEqual(result.structuredContent.footer.skipped, { no_catchup: { chats: 1, messages: 2 } });
  assert.match(text(result), /1 chat tagged #no-catchup \(2 msgs\)/);
});

test("stories: how many, and up to five authors, the most recent first", async () => {
  const { svc, arrive } = account();
  const { call } = toolsOf(svc);
  arrive(STATUS, { extendedTextMessage: { text: "la mare" } }, { participant: ANA, at: Date.now() - 3 * HOUR });
  arrive(STATUS, { extendedTextMessage: { text: "apus" } }, { participant: DAN, at: Date.now() - 2 * HOUR });
  arrive(STATUS, { extendedTextMessage: { text: "iar" } }, { participant: ANA, at: Date.now() - HOUR });
  const result = await call("catch_up", { hours: 24 });
  assert.deepEqual(result.structuredContent.stories, [{ n: 3, authors: ["Ana", "Dan"] }]);
  assert.match(text(result), /## Stories\n- 3 stories from Ana, Dan/);
  assert.deepEqual(chatsOf(result, "direct"), [], "a story is not a message from a person");
});

function hubOf(...accounts) {
  const bindings = accounts.map(({ id, svc }) => ({ id, wa: svc }));
  const records = accounts.map(({ id, name }) => ({ id, name, enabled: true, owner: null }));
  return {
    binding: (id) => bindings.find((binding) => binding.id === id),
    defaultBinding: () => bindings[0],
    bindings: () => bindings,
    findByChat: (jid) => bindings.filter((binding) => binding.wa.hasChat(jid)),
    findByMessage: (id) => bindings.filter((binding) => binding.wa.hasMessage(id)),
    findByDraft: () => [],
    record: (id) => records.find((record) => record.id === id),
    records: () => records,
    recordOnDisk: (id) => records.find((record) => record.id === id),
    reload: () => {},
    noteOwner: () => {},
  };
}

function twoAccounts() {
  const personal = account({ account: { id: "personal", name: "Personal", enabled: true, owner: null } });
  const work = account({ id: "40700000099@s.whatsapp.net", name: "Andrei", account: { id: "work", name: "Business", enabled: true, owner: null } });
  const hub = hubOf({ id: "personal", name: "Personal", svc: personal.svc }, { id: "work", name: "Business", svc: work.svc });
  return { personal, work, hub };
}

test("with several accounts and no account_id, one catch-up covers every account, each section labelled by account", async () => {
  const { personal, work, hub } = twoAccounts();
  const { tools, call } = toolsOf(hub);
  personal.arrive(ANA, "vii la cină?", { at: Date.now() - 2 * HOUR });
  personal.arrive(DAN, "am ajuns", { at: Date.now() - HOUR });
  work.arrive(ANA, "Factura 118 a intrat, mulțumesc", { at: Date.now() - 3 * HOUR });
  work.arrive(ELA, "când ajunge Andrei la birou?", { at: Date.now() - HOUR });

  const result = await call("catch_up");
  const structured = result.structuredContent;
  assert.equal(structured.account_id, null, "it answered for both");
  assert.deepEqual(
    structured.accounts.map((entry) => [entry.account_id, entry.name, entry.mark.moved]),
    [
      ["personal", "Personal", true],
      ["work", "Business", true],
    ]
  );
  assert.deepEqual(
    structured.waiting.map((entry) => [entry.acct, entry.name]),
    [
      ["personal", "Ana"],
      ["work", "Ela"],
    ]
  );
  assert.deepEqual(
    structured.direct.map((entry) => [entry.acct, entry.name]),
    [
      ["personal", "Dan"],
      ["work", "Ana"],
    ]
  );
  const rendered = text(result);
  assert.match(rendered, /# WhatsApp catch-up · 2 accounts\n- Personal \(personal\): .*\n- Business \(work\): /);
  assert.match(rendered, /## Waiting on you · Personal \(1\)\n- Ana[^\n]*\n## Waiting on you · Business \(1\)\n- Ela/);
  assert.doesNotThrow(() => z.object(tools.get("catch_up").meta.outputSchema).parse(structured));
  assert.ok(personal.svc.db.catchup.get("local") && work.svc.db.catchup.get("local"), "each account keeps its own mark");

  const one = await call("catch_up", { account_id: "work", hours: 24 });
  assert.equal(one.structuredContent.account_id, "work");
  assert.deepEqual(one.structuredContent.accounts.map((entry) => entry.account_id), ["work"]);
  assert.ok(!text(one).includes("Personal"));
});

test("a disconnected account is reported as such, not as nothing new, and its mark stays", async () => {
  const { personal, work, hub } = twoAccounts();
  const { call } = toolsOf(hub);
  work.arrive(ANA, "Factura 118", { at: Date.now() - 3 * HOUR });
  personal.svc.status = "disconnected";
  personal.svc.statusSince = Date.now() - 5 * HOUR;
  const result = await call("catch_up");
  const [first, second] = result.structuredContent.accounts;
  assert.equal(first.status, "disconnected");
  assert.equal(first.mark.why, "not_connected");
  assert.match(first.status_since, /^\d{4}-/);
  assert.equal(second.mark.moved, true);
  assert.match(text(result), /- Personal \(personal\): .* · disconnected since \S+: what arrived after that is not here yet/);
  assert.equal(personal.svc.db.catchup.get("local"), null);
});

function busyAccount({ people = 14, at = Date.now() - 5 * HOUR } = {}) {
  const fixture = account();
  const { arrive, mention, sock } = fixture;
  const long = (who, i) => `${who} scrie mesajul ${i}: ${"vreau să știu dacă putem muta ședința de joi, fiindcă am o programare la doctor și nu ajung la timp ".repeat(3)}`;
  arrive(ANA, `Îmi confirmi extrasul pe august până mâine? ${"Am nevoie de el pentru contabilitate, te rog. ".repeat(6)}`, { at });
  sock.ev.emit("chats.upsert", [{ id: GROUP, name: "Echipa proiect" }]);
  arrive(GROUP, mention(`@Răzvan ${long("Dan", 0)}`), { participant: DAN, at: at + 1000 });
  arrive(GROUP, "am văzut, ok", { participant: DAN, at: at + 2000 });
  const jids = [];
  for (let i = 0; i < people; i++) {
    const jid = `4071000${String(i).padStart(4, "0")}@s.whatsapp.net`;
    jids.push(jid);
    sock.ev.emit("contacts.upsert", [{ id: jid, name: `Persoana ${i}` }]);
    arrive(jid, long(`Persoana ${i}`, i).replace("?", "."), { at: at + 10_000 + i * 1000 });
  }
  for (let g = 0; g < 3; g++) {
    const jid = `12036300000001${g}@g.us`;
    sock.ev.emit("chats.upsert", [{ id: jid, name: `Grupul ${g}` }]);
    for (let i = 0; i < 3; i++) arrive(jid, long(`membru ${i}`, i).replace("?", "."), { participant: i % 2 ? ANA : ELA, at: at + 60_000 + g * 10_000 + i * 1000 });
  }
  return { ...fixture, jids };
}

test("the budget: the skeleton first, then quotes by priority, the lowest shrinking to 80 characters and then going", async () => {
  const { svc } = busyAccount({ people: 14 });
  const { call } = toolsOf(svc);
  const roomy = await call("catch_up", { hours: 24, budget_tokens: 8000 });
  assert.equal(roomy.structuredContent.more, null);
  assert.equal(roomy.structuredContent.waiting[0].q.length, 240, "a waiting ask quotes up to 240 characters");
  assert.equal(roomy.structuredContent.addressed[0].q.length, 200, "a mention quotes up to 200");
  assert.ok(roomy.structuredContent.direct.every((entry) => entry.q.length === 160));
  assert.ok(roomy.structuredContent.groups.every((entry) => entry.hot === undefined || entry.hot.length === 120));

  const tight = await call("catch_up", { hours: 24, budget_tokens: 1000 });
  assert.equal(tight.structuredContent.more, null, "the skeleton fits");
  assert.ok(tight.structuredContent.approx_tokens <= 1000, `${tight.structuredContent.approx_tokens} tokens`);
  // Every entry that quotes with room to spare, in priority order, and the length its quote kept.
  const quoted = (result) =>
    [
      ...result.structuredContent.waiting.map((entry) => [entry.chat, entry.q]),
      ...result.structuredContent.addressed.map((entry) => [entry.chat, entry.q]),
      ...result.structuredContent.direct.map((entry) => [entry.chat, entry.q]),
      ...result.structuredContent.groups.map((entry) => [entry.chat, entry.hot]),
    ].filter(([, quote]) => quote !== undefined);
  const kept = new Map(quoted(tight));
  const levels = quoted(roomy).map(([chat]) => kept.get(chat)?.length ?? 0);
  assert.equal(levels[0], 240, "the highest priority keeps its whole quote");
  assert.ok(levels.some((length) => length <= 80), `something had to give: ${levels}`);
  const firstShort = levels.findIndex((length) => length <= 80);
  assert.ok(levels.slice(firstShort).every((length) => length <= 80), `quotes shrink from the lowest priority up: ${levels}`);
  const firstGone = levels.indexOf(0);
  if (firstGone !== -1) assert.ok(levels.slice(firstGone).every((length) => length === 0), `and go from the lowest priority up: ${levels}`);
  assert.ok(levels.slice(0, firstShort).every((length, i) => length === quoted(roomy)[i][1].length), "what did not shrink kept its full length");
});

test("a digest longer than the budget pages with a cursor that sees the same window whatever arrives in between, and the mark moves only after the last page", async () => {
  const { svc, arrive, jids } = busyAccount({ people: 30 });
  const { call } = toolsOf(svc);
  const whole = await call("catch_up", { since: "last", budget_tokens: 8000, include: ["waiting", "direct", "groups"] });
  assert.equal(whole.structuredContent.more, null);
  assert.equal(whole.structuredContent.accounts[0].mark.why, "partial_include");
  const expected = {
    waiting: chatsOf(whole, "waiting"),
    direct: chatsOf(whole, "direct"),
    groups: chatsOf(whole, "groups"),
  };

  const seen = { waiting: [], direct: [], groups: [] };
  let page = await call("catch_up", { budget_tokens: 500 });
  const pages = [page];
  assert.ok(page.structuredContent.more, "it does not fit in 500 tokens");
  assert.match(text(page), /More: \d+ entries left \(.*\)\. Call catch_up with cursor: "/);
  assert.equal(page.structuredContent.accounts[0].mark.why, "more_pages");
  assert.equal(page.structuredContent.footer, null);
  // Messages arrive between pages: a new person, one of the listed, a reply of the user's own.
  arrive("40799999999@s.whatsapp.net", "mesaj nou între pagini", { at: Date.now() });
  arrive(jids[20], "încă unul", { at: Date.now() });
  arrive(jids[25], "răspunsul meu", { fromMe: true, at: Date.now() });
  arrive(ANA, "am rezolvat", { fromMe: true, at: Date.now() });
  while (page.structuredContent.more) {
    assert.equal(svc.db.catchup.get("local"), null, "no page but the last moves the mark");
    page = await call("catch_up", { cursor: page.structuredContent.more.cursor, budget_tokens: 500 });
    pages.push(page);
    assert.ok(pages.length < 20, "pages end");
  }
  for (const each of pages) for (const section of Object.keys(seen)) seen[section].push(...chatsOf(each, section));
  assert.deepEqual(seen, expected, "the pages together are the digest the first page started, nothing added, nothing lost");
  assert.ok(pages.length >= 2);
  assert.equal(page.structuredContent.accounts[0].mark.moved, true, "the last page moves it");
  assert.ok(page.structuredContent.footer);

  const next = await call("catch_up", { budget_tokens: 8000 });
  assert.deepEqual(chatsOf(next, "direct").sort(), ["40799999999@s.whatsapp.net", jids[20]].sort(), "what arrived meanwhile is the next catch-up");
});

test("a cursor is refused when another client, or no catch_up, made it", async () => {
  const { svc } = busyAccount({ people: 30 });
  const mine = toolsOf(svc, { client: "oauth:claude" });
  const theirs = toolsOf(svc, { client: "token:write" });
  const page = await mine.call("catch_up", { budget_tokens: 500, hours: 24 });
  const stolen = await theirs.call("catch_up", { cursor: page.structuredContent.more.cursor });
  assert.equal(stolen.structuredContent.error, "INVALID_ID");
  assert.match(stolen.structuredContent.message, /another client/);
  const garbage = await mine.call("catch_up", { cursor: "bm90IGEgY3Vyc29y" });
  assert.equal(garbage.structuredContent.error, "INVALID_ID");
});

test("the structured answer carries the same entries as the text, in at most 1.3 times its size", async () => {
  const { svc, arrive, mention, callLog, sock } = busyAccount({ people: 6 });
  const { call } = toolsOf(svc);
  sock.ev.emit("chats.upsert", [{ id: MUTED, name: "Bloc 12", muteEndTime: Date.now() + 30 * 24 * HOUR }]);
  arrive(MUTED, mention("@Răzvan cheia?"), { participant: ELA, at: Date.now() - HOUR });
  callLog(DAN, CALL.MISSED, { at: Date.now() - 2 * HOUR });
  arrive(STATUS, { extendedTextMessage: { text: "la mare" } }, { participant: ANA, at: Date.now() - HOUR });
  for (const budget of [800, 2500, 8000]) {
    const result = await call("catch_up", { hours: 24, budget_tokens: budget });
    const size = JSON.stringify(result.structuredContent).length;
    assert.ok(size <= 1.3 * text(result).length, `budget ${budget}: ${size} structured vs ${text(result).length} text`);
    const lines = text(result).split("\n").filter((line) => line.startsWith("- "));
    const entries = ["waiting", "addressed", "missed_calls", "direct", "groups", "stories"].reduce((n, key) => n + result.structuredContent[key].length, 0);
    assert.equal(lines.length, entries, "one line per entry");
  }
});

test("HTTP sessions catch up under the credential's name, never the token", async (t) => {
  const { startHttpEndpoint } = await import("../dist/server.js");
  const { mcpSession } = await import("../scripts/eval/client.mjs");
  const { offlineConfig, stubAccountSource } = await import("./helpers.mjs");
  const clients = [];
  const scan = (request) => ({
    accountId: "default",
    accountName: "default",
    connection: { status: "connected", since: null, sync: "done", mentionsIndexing: false },
    window: { sinceId: 1, untilId: 2 ** 40, basis: "first_run", advance: true, expected: null, at: request.at },
    waiting: [],
    addressed: [],
    calls: [],
    direct: [],
    groups: [],
    mutedGroups: null,
    stories: null,
    voiceUntranscribed: [],
    voiceUntranscribedCount: 0,
    skipped: { noCatchup: { chats: 0, messages: 0 }, leftGroups: { chats: 0, messages: 0 }, newsletters: { chats: 0, messages: 0 }, broadcasts: { chats: 0, messages: 0 } },
  });
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), account_id: "default", read_only: true }),
    catchUpScan: async (request) => (clients.push(request.client), scan(request)),
    catchUpQuotes: async () => [],
    catchUpAdvance: async (client) => (clients.push(`advance ${client}`), { advanced: true }),
  };
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(stubAccountSource(wa), offlineConfig("wazap-catchup-http-"), {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: "reader-secret", write: false },
      { token: "daemon-secret", write: true, localFiles: true, label: "local" },
    ],
  });
  for (const token of ["reader-secret", "daemon-secret"]) {
    const session = await mcpSession(`http://127.0.0.1:${port}/mcp`, token);
    assert.ok(session.tools.some((tool) => tool.name === "catch_up" && tool.outputSchema), "listed with its output schema");
    const result = await session.call("catch_up", {});
    assert.equal(result.isError, undefined, JSON.stringify(result));
    await session.close();
  }
  assert.deepEqual(clients, ["token:read", "advance token:read", "local", "advance local"]);
  assert.ok(!clients.some((client) => client.includes("secret")));
});
