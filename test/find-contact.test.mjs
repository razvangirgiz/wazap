/**
 * find_contact end to end, over the evaluation world (eval/fixtures/world.json)
 * through the real MCP endpoint: who "mama", "Ana de la contabilitate" or
 * "Mișu" is on one account and across two; what an ambiguous or not-found
 * answer may show (never a message's words, a number only as its last four
 * digits); when a resolved contact carries the draft context; and the
 * style_check a text draft gets back from send_message.
 *
 * These calls go over plain HTTP, so only the server's own check applies: a
 * successful answer missing a field the outputSchema requires, or with one of
 * the wrong type, fails. A field the schema does not name passes here; the SDK
 * client refuses it, and test/output-schema.test.mjs calls through that client.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { controlClient, mcpSession } from "../scripts/eval/client.mjs";
import { childEnv } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORLD = JSON.parse(readFileSync(join(ROOT, "eval", "fixtures", "world.json"), "utf8"));

/** Every sentence the world's messages carry: none may show in an answer that is not resolved. */
const WORLD_TEXTS = WORLD.accounts
  .flatMap((account) => account.messages.flatMap((m) => [m.text, m.media?.caption, m.voice?.transcript]))
  .filter((text) => typeof text === "string" && text.length >= 8);
/** Every number the world knows, in full. */
const WORLD_NUMBERS = WORLD.accounts.flatMap((account) => Object.values(account.contacts).map((contact) => contact.phone));

let server;
let ready;
let control;

before(async () => {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "eval", "server.mjs"), "--quiet"], { cwd: ROOT, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const exited = new Promise((done) => child.once("exit", done));
  ready = await new Promise((done, fail) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("READY ")) done(JSON.parse(line.slice(6)));
    });
    exited.then((code) => fail(new Error(`eval server exited ${code}: ${stderr.join("")}`)));
  });
  server = { child, exited };
  control = controlClient(ready.control_url, ready.control_token);
});

after(async () => {
  await control?.stop().catch(() => server.child.kill("SIGTERM"));
  await server?.exited;
});

/** A fresh world (patched), and a session on it with the write or the read token. */
async function world(patch, token = "write") {
  await control.reset({ patch });
  return { refs: await control.refs(), s: await mcpSession(ready.mcp_url, ready.tokens[token]) };
}

async function find(s, args) {
  const result = await s.call("find_contact", args);
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result.content));
  return result;
}

/** No sentence of any message, and no whole number, in what an unresolved answer shows. */
function assertNothingPrivate(result) {
  const shown = `${JSON.stringify(result.structuredContent)}\n${result.content.map((block) => block.text).join("\n")}`;
  for (const text of WORLD_TEXTS) assert.ok(!shown.includes(text), `message text leaked: ${text}`);
  for (const number of WORLD_NUMBERS) assert.ok(!shown.includes(number), `a whole number leaked: ${number}`);
}

const OLD_ANDREIS = ["Andrei Ene", "Andrei Voicu", "Andrei Toma", "Andrei Lazăr", "Andrei Barbu", "Andrei Neagu"];

const MORE_PEOPLE = {
  accounts: {
    personal: {
      contacts: {
        stefan: { phone: "40790000031", name: "Ștefan Luca" },
        dan_radu: { fields: { nickname: "Puiu" } },
        ...Object.fromEntries(OLD_ANDREIS.map((name, i) => [`andrei_${i}`, { phone: `4079000004${i}`, name }])),
      },
      "+messages": [
        { chat: "stefan", from: "stefan", at: "-3d 10:00", text: "Salut, ne vedem joi la birou?" },
        ...OLD_ANDREIS.map((_, i) => ({ chat: `andrei_${i}`, from: `andrei_${i}`, at: `2024-0${i + 1}-10 10:00`, text: "Mulțumesc pentru ajutor!" })),
      ],
    },
  },
};

test("find_contact is a read tool in every session, with an output schema, and the only way to look people up", async () => {
  const { s } = await world();
  const readOnly = await mcpSession(ready.mcp_url, ready.tokens.read);
  for (const session of [s, readOnly]) {
    const tool = session.tools.find((entry) => entry.name === "find_contact");
    assert.ok(tool, "registered");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool.outputSchema.required.sort(), ["query", "status"]);
    assert.ok(tool.description.length <= 300, `${tool.description.length} characters`);
    assert.ok(!session.tools.some((entry) => ["search_contacts", "get_contact", "sync_contacts"].includes(entry.name)), "the tools it replaced are gone");
  }
  await s.close();
  await readOnly.close();
});

test("mama is Elena through what the user filed, never the group Mama Anei or Mamaia Resort; mamei reads through", async () => {
  const { s, refs } = await world();
  for (const name of ["mama", "mamei", "Mama"]) {
    const { structuredContent: found } = await find(s, { name, account_id: "personal" });
    assert.equal(found.status, "resolved", name);
    assert.equal(found.contact.chat_id, refs.contacts.elena.jid);
    assert.deepEqual([found.contact.name, found.contact.name_source, found.contact.account_id], ["Elena Pop", "contact", "personal"]);
    assert.deepEqual(found.contact.matched, { source: "note", value: "mama", class: "exact" });
    assert.equal(found.query.relationship, "mother");
  }
  const { structuredContent: decoy } = await find(s, { name: "Mama Anei", account_id: "personal" });
  assert.equal(decoy.status, "resolved", "asked by its own name, the group is found");
  assert.equal(decoy.contact.kind, "group");

  const tata = await find(s, { name: "tatălui", account_id: "personal" });
  assert.equal(tata.structuredContent.status, "not_found");
  assert.deepEqual(tata.structuredContent.closest, [], "who he is is the user's to say");
  assert.match(tata.structuredContent.fix, /Ask the user who it is/);
  assert.match(tata.structuredContent.fix, /remember\(\{chat_id, fields: \{relatie: "tata"\}\}\)/);
  assertNothingPrivate(tata);
  await s.close();
});

test("Ana de la contabilitate resolves through the tag; plain Ana is two people told apart without their messages or numbers", async () => {
  const { s, refs } = await world();
  const accounting = await find(s, { name: "Anei", qualifier: "de la contabilitate", account_id: "personal" });
  assert.equal(accounting.structuredContent.status, "resolved");
  assert.equal(accounting.structuredContent.contact.chat_id, refs.contacts.ana_ionescu.jid);

  const ana = await find(s, { name: "Ana", account_id: "personal" });
  const body = ana.structuredContent;
  assert.equal(body.status, "ambiguous");
  assert.equal(body.contact, undefined);
  assert.equal(body.context, undefined, "no context for a guess");
  assert.deepEqual(body.candidates.map((c) => c.name).sort(), ["Ana Ionescu", "Ana Vasile"]);
  const vasile = body.candidates.find((c) => c.name === "Ana Vasile");
  assert.equal(vasile.number_tail, "3333");
  assert.equal(vasile.chat_id, undefined, "a candidate cannot be sent to");
  assert.equal(vasile.account_id, undefined, "one account asked, no label");
  assert.equal(vasile.note, "vecina");
  assert.deepEqual(vasile.groups_in_common, { count: 1, names: ["Bloc 12"] });
  assert.equal(vasile.last_exchanged.direction, "received");
  assert.match(vasile.last_exchanged.ago, /ago$/);
  assert.equal(typeof vasile.messages_90d, "number");
  assert.equal(body.candidates.find((c) => c.name === "Ana Ionescu").tags[0], "contabilitate");
  assert.match(body.fix, /Ask the user which one/);
  assert.match(ana.content[0].text, /number …3333/);
  assertNothingPrivate(ana);

  // The user says "the one ending in 3333".
  const picked = await find(s, { name: "Ana", qualifier: "…3333", account_id: "personal" });
  assert.equal(picked.structuredContent.status, "resolved");
  assert.equal(picked.structuredContent.contact.chat_id, refs.contacts.ana_vasile.jid);
  const wrong = await find(s, { name: "Ana", qualifier: "9999", account_id: "personal" });
  assert.equal(wrong.structuredContent.status, "not_found");
  assert.equal(wrong.structuredContent.closest.length, 2);
  assertNothingPrivate(wrong);
  await s.close();
});

test("Mișu through the diminutive, Puiu through a nickname detail, Stefan without diacritics, and many old Andreis are a question", async () => {
  const { s, refs } = await world(MORE_PEOPLE);
  const misu = await find(s, { name: "lui Mișu", account_id: "personal" });
  assert.equal(misu.structuredContent.contact.chat_id, refs.contacts.mihai.jid);
  assert.equal(misu.structuredContent.contact.matched.class, "diminutive");

  const puiu = (await find(s, { name: "Puiu", account_id: "personal" })).structuredContent;
  assert.equal(puiu.contact.chat_id, refs.contacts.dan_radu.jid);
  assert.deepEqual(puiu.contact.matched, { source: "nickname", value: "nickname: Puiu", class: "exact" });

  for (const name of ["Stefan", "ŞTEFAN", "ștefan luca"]) {
    const found = (await find(s, { name, account_id: "personal" })).structuredContent;
    assert.equal(found.contact?.chat_id, refs.contacts.stefan.jid, name);
  }

  const andrei = await find(s, { name: "Andrei", account_id: "personal" });
  assert.equal(andrei.structuredContent.status, "ambiguous");
  assert.equal(andrei.structuredContent.candidates.length, 5);
  assert.ok(andrei.structuredContent.candidates.every((c) => /^Andrei /.test(c.name) && c.messages_90d === 0));
  assertNothingPrivate(andrei);
  assert.equal((await find(s, { name: "Andrei", limit: 2, account_id: "personal" })).structuredContent.candidates.length, 2);
  await s.close();
});

test("across both accounts: candidates carry their account, one account's only match resolves, the same name on both is a question", async () => {
  const { s, refs } = await world();
  const ana = await find(s, { name: "Ana" });
  assert.equal(ana.structuredContent.status, "ambiguous");
  assert.deepEqual(ana.structuredContent.accounts_searched, ["personal", "work"]);
  assert.deepEqual(
    ana.structuredContent.candidates.map((c) => `${c.account_id}:${c.name}`).sort(),
    ["personal:Ana Ionescu", "personal:Ana Vasile", "work:Ana Ionescu", "work:Ana Marin"]
  );
  assertNothingPrivate(ana);

  const marin = (await find(s, { name: "Ana Marin" })).structuredContent;
  assert.equal(marin.status, "resolved");
  assert.deepEqual([marin.contact.chat_id, marin.contact.account_id, marin.account_id], [refs.contacts.ana_marin.jid, "work", "work"]);

  const mama = (await find(s, { name: "mamei" })).structuredContent;
  assert.deepEqual([mama.status, mama.contact.account_id], ["resolved", "personal"]);

  const accounting = await find(s, { name: "Anei", qualifier: "contabilitate" });
  assert.equal(accounting.structuredContent.status, "ambiguous", "each account resolves its own Ana Ionescu");
  assert.deepEqual(accounting.structuredContent.candidates.map((c) => c.account_id).sort(), ["personal", "work"]);
  assert.match(accounting.structuredContent.fix, /pass account_id/);
  assertNothingPrivate(accounting);

  await control.hooks([{ hook: "status", account: "work", status: "disconnected" }]);
  const offline = (await find(s, { name: "Ana Marin" })).structuredContent;
  assert.deepEqual([offline.status, offline.contact.account_id], ["resolved", "work"], "a disconnected account is searched in what it stores");
  await s.close();
});

test("a resolved contact carries the recent exchange and the user's style in a write session, and nothing more anywhere else", async () => {
  let { s } = await world();
  const full = (await find(s, { name: "mama", account_id: "personal" })).structuredContent;
  assert.equal(full.context.style.language, "ro");
  assert.ok(full.context.style.basis.own_messages > 0);
  const last = full.context.recent.at(-1);
  assert.deepEqual([last.from_me, last.text, last.transcribed], [false, "Nu uita de cina de duminică la 7, vine și tanti Lia.", true]);
  assert.ok(full.context.recent.some((line) => line.from_me && line.text === "Da mamă, am ajuns 😊"));
  assert.equal(full.context.recent.length, 4);

  assert.equal((await find(s, { name: "mama", account_id: "personal", include_context: false })).structuredContent.context, undefined);
  await s.close();

  const readOnly = await mcpSession(ready.mcp_url, ready.tokens.read);
  const read = await find(readOnly, { name: "mama", account_id: "personal" });
  assert.equal(read.structuredContent.status, "resolved");
  assert.equal(read.structuredContent.context, undefined, "a session that cannot send gets no draft context");
  assert.ok(!read.content[0].text.includes("cina de duminică"));
  await readOnly.close();

  let refs;
  ({ s, refs } = await world({ accounts: { personal: { contacts: { elena: { tags: ["private"] } } } } }));
  const quiet = await find(s, { name: "mama", account_id: "personal" });
  assert.equal(quiet.structuredContent.contact.chat_id, refs.contacts.elena.jid);
  assert.deepEqual(Object.keys(quiet.structuredContent.context).sort(), ["private", "style"]);
  assert.ok(!JSON.stringify(quiet.structuredContent).includes("cina de duminică"), "#private: style only");
  assert.match(quiet.content[0].text, /#private/);
  await s.close();

  ({ s } = await world({ accounts: { personal: { draft_context: false } } }));
  const off = (await find(s, { name: "mama", account_id: "personal" })).structuredContent;
  assert.equal(off.status, "resolved");
  assert.equal(off.context, undefined, "the account turned the draft context off");
  const work = (await find(s, { name: "Ana Marin", account_id: "work" })).structuredContent;
  assert.ok(work.context.recent.length > 0, "the other account keeps its own");
  await s.close();
});

test("a draft context on one account reads #private filed on another: a person's chat gives style only, a group leaves their words out", async () => {
  const { s, refs } = await world({
    accounts: {
      // The same Ana Marin, saved on the personal account too and tagged there.
      personal: { contacts: { ana_marin_personal: { phone: "40721000001", name: "Ana Marin", tags: ["private"] } } },
      work: {
        groups: { ofertare: { id: "120363000000000088", subject: "Ofertare Print", participants: [{ who: "me" }, { who: "ana_marin" }, { who: "furnizor" }] } },
        "+messages": [
          { chat: "ofertare", from: "ana_marin", at: "azi 11:00", text: "Bugetul nostru real e doar 900 de lei, nu le spuneți" },
          { chat: "ofertare", from: "furnizor", at: "azi 11:05", text: "Putem face 1000 de flyere până joi" },
        ],
      },
    },
  });
  const person = await find(s, { name: "Ana Marin", account_id: "work" });
  assert.deepEqual([person.structuredContent.status, person.structuredContent.contact.chat_id], ["resolved", refs.contacts.ana_marin.jid]);
  assert.deepEqual(Object.keys(person.structuredContent.context).sort(), ["private", "style"], "tagged on personal, style only on work");
  assert.ok(!JSON.stringify(person.structuredContent).includes("Ne vedem azi la birou"));

  const group = await find(s, { name: "Ofertare Print", account_id: "work" });
  assert.equal(group.structuredContent.status, "resolved");
  const recent = group.structuredContent.context.recent.map((line) => line.text);
  assert.ok(recent.includes("Putem face 1000 de flyere până joi"), "the others' words stay");
  assert.ok(!JSON.stringify(group.structuredContent).includes("Bugetul nostru real"), "hers do not");
  await s.close();
});

test("send_message: a draft with diacritics to someone the user writes to without them gets style_check; too little of the user's own writing gets none", async () => {
  const own = ["da, vin si eu la meci", "hai ca te sun cand ajung", "ok, iti zic diseara", "nu stiu daca pot sambata", "mersi frate, vorbim"];
  const { s, refs } = await world({
    accounts: { personal: { "+messages": own.map((text, i) => ({ chat: "mihai", from: "me", at: `-1d 1${i}:00`, text })) } },
  });
  const draft = await s.call("send_message", { chat_id: refs.contacts.mihai.jid, text: "Ajung în zece minute, te sun când plec de acasă.", account_id: "personal" });
  assert.notEqual(draft.isError, true, JSON.stringify(draft.structuredContent));
  const check = draft.structuredContent.style_check;
  assert.deepEqual(check.warnings, ["diacritics_mismatch"]);
  assert.equal(check.basis.diacritics, "none");
  assert.equal(check.basis.own_messages, 6);
  assert.match(draft.content[0].text, /Style check[\s\S]*diacritics_mismatch/);
  assert.ok(draft.structuredContent.draft_id, "still a draft: the check never blocks");

  const plain = await s.call("send_message", { chat_id: refs.contacts.ana_ionescu.jid, text: "Salut, poți să-mi trimiți extrasul?", account_id: "personal" });
  assert.equal(plain.structuredContent.style_check, undefined, "one message of the user's own is too little to judge");
  assert.doesNotMatch(plain.content[0].text, /Style check/);
  await s.close();
});
