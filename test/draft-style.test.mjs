/**
 * The draft side of F2-3 over the account database: send_message's style
 * check (a draft against how the user writes in that chat, never what wazap
 * sent), the draft context find_contact attaches (the recent exchange and the
 * style, style only for #private), and reading one message's own style.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MESSAGE_FLAGS, messageStyle } from "../dist/db/index.js";
import { LENGTH_OUTLIER_MIN_CHARS, STYLE_CHECK_MIN_OWN, draftContextFor, styleCheckFor, styleCheckLines } from "../dist/draft-style.js";
import { renderDraft } from "../dist/drafts.js";
import { PRIVATE_TAG, hasPrivateTag, isPrivateChat, isPrivateSender } from "../dist/private-contacts.js";
import { GROUP, PEER, T0, openTemp, textMessage } from "./db-fixtures.mjs";

const DAY = 86_400_000;
const ANA = "40700000005@s.whatsapp.net";
const NOTAR = "40700000006@s.whatsapp.net";
const JOHN = "40700000007@s.whatsapp.net";
const MISU = "40700000008@s.whatsapp.net";
const DAN = "40700000009@s.whatsapp.net";

function account() {
  const opened = openTemp();
  opened.clock.now = T0 + 200 * DAY;
  let key = 0;
  const now = opened.clock.now;
  const write = (chat, texts, { fromMe = true, daysAgo = 1, extra = {} } = {}) =>
    texts.map((text, i) =>
      opened.db.messages.upsert(textMessage(chat, `S${++key}`, now - daysAgo * DAY + key * 1000 + i, text, { fromMe, ...extra }))
    );
  const check = (chat, text) => styleCheckFor(opened.db, chat, text);
  return { ...opened, write, check };
}

test("one message's style: language by function words, diacritics past a few letters, the form of address", () => {
  assert.deepEqual(messageStyle("Bună ziua, vă trimit documentele mâine dimineață.", { oneToOne: true }), {
    language: "ro",
    diacritics: true,
    address: null,
    chars: 49,
  });
  assert.equal(messageStyle("Sunteți disponibil mâine?", { oneToOne: true }).address, "dumneavoastra");
  assert.equal(messageStyle("Sunteți disponibil mâine?").address, null, "a plural verb is formal only one-to-one");
  assert.equal(messageStyle("poti sa vii si tu mai devreme").address, "tu");
  assert.equal(messageStyle("poti sa vii si tu mai devreme").diacritics, false);
  assert.equal(messageStyle("da, și eu").diacritics, true, "a diacritic is a diacritic, however short the message");
  assert.deepEqual(messageStyle("See you at the office tomorrow"), { language: "en", diacritics: null, address: null, chars: 30 });
  assert.equal(messageStyle("👍").language, "other");
});

test("no false style warnings: no evidence of diacritics, words that need none, a third person, a couple, a quote", () => {
  const { db, write, check } = account();
  // Short replies only: nothing says how the user writes diacritics.
  write(ANA, ["ok", "da", "vin", "bine", "pa"]);
  assert.equal(db.messages.styleFor(ANA).diacritics, "unknown");
  const long = check(ANA, "Adresa e Str. Lalelelor 5, bl. A2, sc. 1, ap. 14, interfon 14. Te aștept la 7, nu întârzia");
  assert.deepEqual(long.warnings, ["length_outlier"]);
  assert.match(styleCheckLines(long).join("\n"), /Shorten only if nothing the user asked for is lost/);

  write(JOHN, ["ce faci, esti acasa?", "hai ca te sun", "poti sa vii maine?", "iti zic diseara ce facem", "tu ai vorbit cu el?"]);
  assert.deepEqual(check(JOHN, "Am vorbit cu doamna de la banca, zice ca e ok").warnings, [], "doamna is someone else, not the reader");
  assert.deepEqual(check(JOHN, "Ati ajuns acasa cu bine amandoi?").warnings, [], "two people addressed, not one formally");
  assert.deepEqual(check(JOHN, "Mi-a zis: please send the invoice to the office by Friday, thanks").warnings, [], "a quote is not the draft's language");
  assert.deepEqual(check(JOHN, "Ti-a scris „please send the invoice to the office today” si atat").warnings, []);
  assert.deepEqual(check(JOHN, "Sunteti acasa? Va astept").warnings, ["address_mismatch"], "a plural verb to one person still is formal");

  write(NOTAR, ["Mulțumesc, ajung în zece minute la tine", "Mâine nu pot, poate joi după-amiază", "Știu, îți zic când plec de acasă", "Bine, ne vedem acolo la șapte și jumătate", "Da, am primit actele, mulțumesc frumos"]);
  assert.equal(db.messages.styleFor(NOTAR).diacritics, "most");
  assert.deepEqual(check(NOTAR, "Ok, ne vedem la birou la ora zece").warnings, [], "no word here needs a diacritic");
  assert.deepEqual(check(NOTAR, "Ok, ne vedem maine la birou la ora zece").warnings, ["diacritics_mismatch"], "mâine does");
});

test("Romanian written without diacritics, and a draft with them: diacritics_mismatch", () => {
  const { write, check } = account();
  write(ANA, ["hai ca vin si eu la 5", "da, te sun cand ajung", "ok, vorbim maine la birou", "nu stiu daca pot azi, iti zic", "mersi, ne vedem acolo"]);
  const result = check(ANA, "Bună, ajung în zece minute și te sun când plec.");
  assert.deepEqual(result.warnings, ["diacritics_mismatch"]);
  assert.deepEqual(result.basis, {
    own_messages: 5,
    days: 90,
    language: "ro",
    diacritics: "none",
    address: "tu",
    length_chars: result.basis.length_chars,
  });
  assert.deepEqual(result.draft, { language: "ro", diacritics: true, address: "tu", chars: 47 });
  assert.deepEqual(check(ANA, "Buna, ajung in zece minute si te sun cand plec.").warnings, [], "the same words the way the user writes them");
});

test("a formal contact and an informal draft: address_mismatch; with diacritics where the user uses them, nothing else", () => {
  const { write, check } = account();
  write(NOTAR, [
    "Bună ziua, vă trimit actele mâine dimineață.",
    "Mulțumesc, aveți dreptate.",
    "Sigur, puteți să mă sunați după ora 5.",
    "Vă mulțumesc frumos pentru răspuns.",
    "Dumneavoastră când sunteți disponibilă?",
  ]);
  const result = check(NOTAR, "Salut, poți să-mi trimiți programarea până mâine?");
  assert.deepEqual(result.warnings, ["address_mismatch"]);
  assert.equal(result.basis.address, "dumneavoastra");
  assert.equal(result.draft.address, "tu");
  assert.deepEqual(check(NOTAR, "Bună ziua, îmi puteți trimite programarea până mâine?").warnings, []);
  assert.deepEqual(check(NOTAR, "Buna ziua, imi puteti trimite programarea pana maine?").warnings, ["diacritics_mismatch"]);
});

test("an English contact and a Romanian draft: language_mismatch, and nothing about Romanian style", () => {
  const { write, check } = account();
  write(JOHN, ["Yes, sure! Talk then.", "Thanks, I will send it tomorrow.", "Are we still on for Friday?", "Great, see you at the office.", "I can do the call at 3pm."]);
  const result = check(JOHN, "Bună, ne vedem mâine la birou și îți trimit contractul.");
  assert.deepEqual(result.warnings, ["language_mismatch"]);
  assert.deepEqual([result.basis.language, result.draft.language], ["en", "ro"]);
  assert.deepEqual(check(JOHN, "See you at the office tomorrow, I will bring the contract.").warnings, []);
});

test("a draft three times longer than the user's longest usual message here: length_outlier, above a floor", () => {
  const { write, check } = account();
  write(MISU, ["ok", "da", "vin", "sigur", "mersi", "pa", "hai"]);
  const long = "Salut, ma gandeam ca poate sambata dupa meci mergem toti la o bere, dar trebuie sa vedem cine conduce si unde parcam, ca la stadion e mereu aglomerat.";
  assert.deepEqual(check(MISU, long).warnings, ["length_outlier"]);
  assert.ok(long.length > LENGTH_OUTLIER_MIN_CHARS);
  assert.deepEqual(check(MISU, "da, ajung si eu pe la 5 la stadion").warnings, [], "longer than usual, still under the floor");
});

test("no style check without five of the user's own messages in that direct chat, what wazap sent not counting", () => {
  const { db, write, check } = account();
  write(DAN, ["ok", "da", "vin", "sigur"]);
  assert.equal(check(DAN, "Bună ziua, vă trimit documentele."), null, "four is too few");
  write(DAN, ["Bună ziua! Vă mulțumesc.", "Cu stimă."], { extra: { flags: MESSAGE_FLAGS.viaWazap } });
  assert.equal(check(DAN, "Bună ziua, vă trimit documentele."), null, "what wazap sent is not the user writing");
  write(DAN, ["mersi"]);
  assert.equal(check(DAN, "Bună ziua, vă trimit documentele.").basis.own_messages, STYLE_CHECK_MIN_OWN);

  write(PEER, ["ok"]);
  assert.equal(check(PEER, "Bună ziua"), null, "the account's style is no evidence about one person");
  write(GROUP, ["hai ca vin", "da", "ok", "sigur", "mersi", "pa"]);
  assert.equal(check(GROUP, "Bună ziua tuturor, vă mulțumesc."), null, "groups are not checked");
  assert.equal(check("40799999999@s.whatsapp.net", "salut"), null, "a chat the account does not know");
  assert.equal(db.messages.styleFor(DAN).basis.own_messages, 5);
});

test("the preview says what does not match and leaves the choice to the user's words", () => {
  const { write, check } = account();
  write(NOTAR, ["Bună ziua, vă trimit actele.", "Mulțumesc, aveți dreptate.", "Sigur, puteți să mă sunați.", "Vă mulțumesc frumos.", "Când sunteți disponibilă?"]);
  const style_check = check(NOTAR, "Salut, poti sa-mi trimiti actele pana maine?");
  assert.deepEqual(style_check.warnings, ["diacritics_mismatch", "address_mismatch"]);
  const lines = styleCheckLines(style_check);
  assert.match(lines[0], /last 5 messages in this chat/);
  assert.match(lines[1], /diacritics_mismatch: the draft has no diacritics/);
  assert.match(lines[2], /address_mismatch: the draft says tu; the user says dumneavoastră here/);
  assert.match(lines.at(-1), /Unless the user dictated these exact words/);
  const view = {
    status: "draft",
    draft_id: "d_1",
    to: { chat_id: NOTAR, name: "Notar" },
    preview: 'To: Notar\n"Salut"',
    expires_at: "",
    kind: "text",
    style_check,
  };
  assert.match(renderDraft(view), /Style check[\s\S]*address_mismatch[\s\S]*call confirm_send/);
  assert.doesNotMatch(renderDraft({ ...view, style_check: { ...style_check, warnings: [] } }), /Style check/);
  assert.deepEqual(styleCheckLines(undefined), []);
});

// ---------------------------------------------------------------- draft context

test("the draft context: style and the last eight messages both ways, cut to 200 characters; style only when private", () => {
  const { db, write } = account();
  write(ANA, ["hai ca vin si eu la 5", "da, te sun cand ajung", "ok, vorbim maine", "nu stiu daca pot azi", "mersi, ne vedem"], { daysAgo: 3 });
  write(ANA, ["Ai ajuns?", "x".repeat(300)], { fromMe: false, daysAgo: 2 });
  write(ANA, ["da, acum"], { daysAgo: 1 });
  const context = draftContextFor(db, ANA, { recent: true, senderName: () => "Ana" });
  assert.equal(context.style.basis.scope, "chat");
  assert.equal(context.recent.length, 8);
  assert.deepEqual(context.recent.at(-1), { at: context.recent.at(-1).at, from_me: true, text: "da, acum" });
  assert.equal([...context.recent.at(-2).text].length, 200);
  assert.match(context.recent[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(context.private, undefined);

  const quiet = draftContextFor(db, ANA, { recent: false, senderName: () => "Ana" });
  assert.deepEqual(Object.keys(quiet).sort(), ["private", "style"]);
  assert.equal(JSON.stringify(quiet).includes("Ai ajuns"), false, "no message text for a private contact");

  assert.equal(draftContextFor(db, "40799999999@s.whatsapp.net", { recent: true, senderName: () => "?" }), null, "no chat, no context");
});

test("in a group the draft context names who wrote each message", () => {
  const { db, write } = account();
  write(GROUP, ["Bun venit!"], { fromMe: false, extra: { senderJid: PEER } });
  write(GROUP, ["Mersi!"]);
  const context = draftContextFor(db, GROUP, { recent: true, senderName: (jid) => (jid === PEER ? "Dan" : jid) });
  assert.deepEqual(
    context.recent.map((line) => [line.from_me, line.sender, line.text]),
    [
      [false, "Dan", "Bun venit!"],
      [true, undefined, "Mersi!"],
    ]
  );
});

test("in a group the draft context leaves out what a #private member said, voice notes included", async () => {
  const { db, write, clock } = account();
  const LUCA = "40700000010@s.whatsapp.net";
  db.identity.upsertContact({ jid: LUCA, name: "Luca", listed: true });
  db.identity.updateFields(LUCA, { addTags: ["private"] });
  write(GROUP, ["Bun venit!"], { fromMe: false, extra: { senderJid: PEER } });
  write(GROUP, ["SECRET: nu pot joi, am analize"], { fromMe: false, extra: { senderJid: LUCA } });
  const voice = write(GROUP, ["[voice message]"], { fromMe: false, extra: { senderJid: LUCA, type: "voice" } });
  db.messages.setTranscript(voice[0].sid, "SECRET: avocatul zice sa ne intelegem", { language: "ro" });
  write(GROUP, ["ok, vedem"]);
  clock.now += 1000;
  const context = draftContextFor(db, GROUP, { recent: true, senderName: (jid) => (jid === PEER ? "Dan" : "Luca") });
  assert.deepEqual(
    context.recent.map((line) => [line.from_me, line.sender, line.text]),
    [
      [false, "Dan", "Bun venit!"],
      [true, undefined, "ok, vedem"],
    ]
  );
  assert.equal(JSON.stringify(context).includes("SECRET"), false);
});

test("#private is a stored tag on the person, never on a group", () => {
  const { db, write } = account();
  write(ANA, ["hei"]);
  assert.equal(PRIVATE_TAG, "private");
  assert.equal(hasPrivateTag(["client", "private"]), true);
  assert.equal(hasPrivateTag(undefined), false);
  assert.equal(isPrivateChat(db, ANA), false);
  db.identity.updateFields(ANA, { addTags: ["private"] });
  assert.equal(isPrivateChat(db, ANA), true);
  assert.equal(isPrivateChat(db, GROUP), false);
  assert.equal(isPrivateSender(db, ANA), true, "the same person writing in a group");
  assert.equal(isPrivateSender(db, PEER), false);
  assert.equal(isPrivateSender(db, null), false, "the user's own messages carry no sender");
});
