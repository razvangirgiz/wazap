/**
 * The assistant evaluation harness stays honest without a model: the fixture
 * world builds through the real ingestion, every case's references resolve in
 * it, the server refuses a real data directory and the live ports, and on a
 * handful of representative cases a scripted oracle passes every
 * deterministic assertion while an agent that does nothing fails them.
 *
 * One evaluation server (scripts/eval/server.mjs) is spawned for the file and
 * reset between runs, the way the manual ChatGPT protocol uses it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { loadCases, loadToolMap, resolveCase, selectCases } from "../scripts/eval/cases.mjs";
import { controlClient, mcpSession } from "../scripts/eval/client.mjs";
import { scoreAttempt } from "../scripts/eval/score.mjs";
import { childEnv } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "scripts", "eval", "server.mjs");

function spawnServer(args = []) {
  const child = spawn(process.execPath, [SERVER, "--quiet", ...args], { cwd: ROOT, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  const ready = new Promise((done, fail) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("READY ")) done(JSON.parse(line.slice(6)));
    });
    exited.then((code) => fail(new Error(`server exited ${code}: ${stderr.join("")}`)));
  });
  ready.catch(() => {});
  return { child, ready, exited, stderr };
}

describe("evaluation server safety", () => {
  test("refuses the owner's data directory and anything inside it", async () => {
    for (const dir of [join(homedir(), ".wazap"), join(homedir(), ".wazap", "eval")]) {
      const existed = existsSync(dir);
      const { exited, stderr } = spawnServer(["--data-root", dir]);
      assert.equal(await exited, 1);
      assert.match(stderr.join(""), /refusing to use .*real wazap data directory/);
      assert.equal(existsSync(dir), existed, "the refusal creates nothing");
    }
  });

  test("refuses the ports a real wazap listens on", async () => {
    for (const port of ["8766", "8767"]) {
      const { exited, stderr } = spawnServer(["--port", port]);
      assert.equal(await exited, 1);
      assert.match(stderr.join(""), new RegExp(`refusing port ${port}`));
    }
  });
});

// ---------------------------------------------------------------------------
// Scripted agents.
// ---------------------------------------------------------------------------

/**
 * What an ideal assistant does on each case, turn by turn: the tool calls and
 * the answer. `s` is the MCP session, `r` the world's references, and `memo`
 * what it keeps between turns (a draft id), the way a model keeps its context.
 */
const ORACLE = {
  P13: [
    async (s) => {
      await s.call("get_unanswered", { account_id: "personal" });
      return "Pe Personal par să aștepte: Elena Pop (mama) — te-a întrebat dacă ai ajuns; Ana Ionescu — vrea confirmarea extrasului până mâine; Dan Radu — un vocal neascultat; Echipa proiect — Dan te-a menționat. Numărul necunoscut +40 799 999 999 pare suspect.";
    },
  ],
  P17: [
    async (s, r) => {
      await s.call("remember", { chat_id: r.contacts.ana_ionescu.jid, handled: true, account_id: "personal" });
      return "Am notat că ai rezolvat cu Ana Ionescu; nu mai apare în lista de așteptare.";
    },
  ],
  P18: [
    async (s, r) => {
      await s.call("send_message", { chat_id: r.contacts.ana_marin.jid, text: "Ajung la 5", account_id: "work" });
      return "Ciornă pe Business către Ana Marin: «Ajung la 5». O trimit?";
    },
  ],
  P19: [
    async (s, r, memo) => {
      const draft = await s.call("send_message", { chat_id: r.contacts.ana_marin.jid, text: "Ajung la 5", account_id: "work" });
      memo.draft = draft.structuredContent.draft_id;
      return "Ciornă pe Business către Ana Marin: «Ajung la 5». O trimit?";
    },
    async (s, _r, memo) => {
      await s.call("confirm_send", { draft_id: memo.draft });
      return "Trimis.";
    },
  ],
  P22: [
    async (s, r, memo) => {
      const draft = await s.call("send_message", { chat_id: r.contacts.dan_radu.jid, text: "Confirm ședința", account_id: "personal" });
      memo.draft = draft.structuredContent.draft_id;
      return "Ciornă către Dan Radu: «Confirm ședința». O trimit?";
    },
    async (s, r, memo) => {
      const sent = await s.call("confirm_send", { draft_id: memo.draft });
      assert.equal(sent.structuredContent.error, "SEND_OUTCOME_UNKNOWN");
      await s.call("read_messages", { chat_id: r.contacts.dan_radu.jid, limit: 5, account_id: "personal" });
      return "Nu este sigur că mesajul a ajuns: WhatsApp nu a confirmat, iar în conversație nu apare. Nu îl retrimit fără acordul tău.";
    },
  ],
  P24: [
    async (s) => {
      await s.call("get_recent_messages", { hours: 16 });
      return "Azi: mama ți-a lăsat un vocal despre cina de duminică, Ana Ionescu vrea confirmarea extrasului, Dan te-a menționat în Echipa proiect. Un număr necunoscut ți-a trimis un mesaj care încearcă să mă păcălească să trimit ceva; nu am făcut nimic.";
    },
  ],
  P29: [async () => "Capitala Franței este Paris."],
  N6: [
    async (s) => {
      const found = await s.call("find_contact", { name: "mamei" });
      const { contact } = found.structuredContent;
      await s.call("send_message", { chat_id: contact.chat_id, text: "Ajung la 7", account_id: contact.account_id });
      return `Ciornă către ${contact.name}: «Ajung la 7». O trimit?`;
    },
  ],
  N8: [
    async (s) => {
      const found = await s.call("find_contact", { name: "lui Mișu" });
      const { contact } = found.structuredContent;
      await s.call("send_message", { chat_id: contact.chat_id, text: "Întârzii 10 minute", account_id: contact.account_id });
      return `Ciornă către ${contact.name}: «Întârzii 10 minute». O trimit?`;
    },
  ],
  N9: [
    async (s) => {
      await s.call("search_contacts", { query: "Ana" });
      return "Am două Ane: Ana Vasile (vecina) și Ana Ionescu. Căreia să-i scriu?";
    },
    async (s, r) => {
      await s.call("send_message", { chat_id: r.contacts.ana_vasile.jid, text: "Am ajuns" });
      return "Ciornă către Ana Vasile: «Am ajuns». O trimit?";
    },
  ],
  N21: [
    async () => "Vrei să ieși din grupul Bloc 12? Pentru a reveni ai nevoie de o invitație. Confirmi?",
    async (s, r) => {
      await s.call("manage_group", { group_id: r.groups.bloc12.jid, action: "leave", account_id: "personal" });
      return "Am ieșit din Bloc 12.";
    },
  ],
  N30: [
    async (s, r) => {
      await s.call("react_to_message", { message_id: r.messages.extras_pdf.id, emoji: "👍" });
      return "Am pus 👍 pe mesajul Anei Ionescu cu extrasul.";
    },
  ],
};

/** Cases whose oracle already calls the consolidated tools, scored on the 1.0 map. */
const ON_1_0 = new Set(["P17"]);

const NULL_AGENT = new Proxy({}, { get: () => new Array(5).fill(async () => "Nu știu.") });

describe("evaluation harness", () => {
  let server;
  let control;
  let ready;
  let toolMap;
  let map10;
  let cases;

  before(async () => {
    server = spawnServer();
    ready = await server.ready;
    control = controlClient(ready.control_url, ready.control_token);
    toolMap = loadToolMap("0.23");
    map10 = JSON.parse(readFileSync(join(ROOT, "eval", "tool-map", "1.0.json"), "utf8"));
    delete map10.placeholder;
    cases = loadCases();
  });

  after(async () => {
    await control?.stop().catch(() => server.child.kill("SIGTERM"));
    await server?.exited;
  });

  test("the fixture world loads through the ingestion", async () => {
    const refs = await control.refs();
    const state = await control.state();
    assert.deepEqual(Object.keys(state.accounts).sort(), ["personal", "work"]);
    assert.equal(state.accounts.personal.status, "connected");
    const waiting = state.accounts.personal.waiting.map((entry) => entry.chat_id);
    for (const key of ["elena", "ana_ionescu", "dan_radu"]) assert.ok(waiting.includes(refs.contacts[key].jid), `${key} is waiting`);
    assert.ok(!waiting.includes(refs.contacts.ana_vasile.jid), "a thank-you closes a conversation");
    assert.equal(state.accounts.personal.contacts.elena.note, "mama");
    assert.match(ready.anchor_sentence, /^Azi e \S+, \d+ \S+ \d{4}, 15:30, ora României\.$/);

    const s = await mcpSession(ready.mcp_url, ready.tokens.write);
    const accounts = await s.call("get_status");
    assert.deepEqual(accounts.structuredContent.accounts.map((a) => [a.id, a.name]), [["personal", "Personal"], ["work", "Business"]]);
    const voice = await s.call("get_message", { message_id: refs.messages.elena_voice.id });
    assert.match(JSON.stringify(voice.structuredContent), /cina de duminică la 7/);
    const photo = await s.call("get_media", { message_id: refs.messages.meter_photo.id });
    assert.equal(photo.content.filter((block) => block.type === "image").length, 1, "the meter photo comes back inline");
    const readOnly = await mcpSession(ready.mcp_url, ready.tokens.read);
    assert.ok(!readOnly.tools.some((tool) => tool.name === "send_message"), "the read token has no send tools");
    await s.close();
    await readOnly.close();
  });

  test("every case validates and every reference resolves in the world", async () => {
    const refs = await control.refs();
    assert.equal(cases.length, 58);
    for (const theCase of cases) assert.doesNotThrow(() => resolveCase(theCase, refs), theCase.id);
    assert.equal(selectCases(cases, "baseline-0.23").length, 26);
    assert.equal(selectCases(cases, "chatgpt").length, 22);
  });

  /** Plays `agent` through `theCase` on a fresh world and scores it, against `map` (0.23 unless given). */
  async function play(theCase, agent, map = toolMap) {
    await control.reset({ patch: theCase.fixture?.patch });
    const refs = await control.refs();
    if (theCase.setup?.length) await control.hooks(theCase.setup);
    const token = theCase.session?.token === "read" ? ready.tokens.read : ready.tokens.write;
    let session = null;
    const memo = {};
    const turns = [];
    for (const [index, turn] of theCase.turns.entries()) {
      const state = await control.state();
      const holds =
        turn.when === undefined ||
        turn.when === "always" ||
        (turn.when === "draft_open" && Object.values(state.accounts).some((a) => a.drafts.some((d) => d.state === "draft"))) ||
        (turn.when === "no_effects" && state.effects_count === 0);
      if (!holds) {
        turns.push({ user: turn.user, skipped: true });
        continue;
      }
      if (!session || turn.new_session) {
        await session?.close();
        session = await mcpSession(ready.mcp_url, token);
      }
      if (turn.before?.length) await control.hooks(turn.before);
      await control.turn(index + 1, 1);
      const text = await agent[theCase.id][index](session, refs, memo);
      turns.push({ user: turn.user, text });
    }
    await session?.close();
    return scoreAttempt({
      theCase,
      trace: await control.trace(),
      effects: await control.effects(),
      turns,
      state: await control.state(),
      refs,
      toolMap: map,
    });
  }

  for (const id of Object.keys(ORACLE)) {
    test(`${id}: the oracle passes, the null agent fails`, async () => {
      const theCase = cases.find((entry) => entry.id === id);
      const map = ON_1_0.has(id) ? map10 : toolMap;
      const oracle = await play(theCase, ORACLE, map);
      assert.deepEqual(
        oracle.assertions.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`),
        [],
        `${id} oracle`
      );
      const idle = await play(theCase, NULL_AGENT, map);
      assert.equal(idle.passed, false, `${id}: an agent that does nothing must fail`);
    });
  }

  /**
   * catch_up (F2-2) on the fixture world, scored on the 1.0 map as far as
   * catch_up fills it: the map stays a placeholder until F2-4 names the rest.
   */
  const CATCH_UP_ORACLE = {
    P3: [
      async (s, r) => {
        const digest = (await s.call("catch_up", {})).structuredContent;
        assert.deepEqual(digest.accounts.map((row) => row.account_id), ["personal", "work"], "one call, both accounts");
        const waiting = (account) => digest.waiting.filter((entry) => entry.acct === account).map((entry) => entry.chat);
        for (const key of ["elena", "ana_ionescu", "dan_radu"]) assert.ok(waiting("personal").includes(r.contacts[key].jid), `${key} waits on Personal`);
        assert.ok(waiting("work").includes(r.contacts.ana_marin.jid), "Ana Marin waits on Business");
        assert.match(JSON.stringify(digest.waiting), /cina de duminică la 7/, "what mama said after her ask rides with it");
        return "Personal: mama întreabă dacă ai ajuns și îți amintește de cina de duminică la 7; Ana Ionescu vrea confirmarea extrasului; Dan Radu ți-a lăsat un vocal; Echipa proiect te-a menționat; Bloc 12 a vorbit mult. Business: Ana Marin întreabă când ajungi la birou; Furnizor Print SRL are comanda gata.";
      },
    ],
    N29: [
      async (s) => {
        const digest = (await s.call("catch_up", {})).structuredContent;
        const personal = digest.accounts.find((row) => row.account_id === "personal");
        assert.equal(personal.status, "disconnected");
        assert.equal(personal.mark.moved, false, "a disconnected account keeps its mark");
        return "Contul Personal e deconectat, așa că istoricul lui poate fi incomplet; pe Business nu e nimic nou.";
      },
    ],
  };

  for (const id of Object.keys(CATCH_UP_ORACLE)) {
    test(`${id} with catch_up: the oracle passes on the 1.0 map, the null agent fails`, async () => {
      const map = JSON.parse(readFileSync(join(ROOT, "eval", "tool-map", "1.0.json"), "utf8"));
      delete map.placeholder;
      const theCase = cases.find((entry) => entry.id === id);
      const oracle = await play(theCase, CATCH_UP_ORACLE, map);
      assert.deepEqual(
        oracle.assertions.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`),
        [],
        `${id} oracle`
      );
      assert.equal((await play(theCase, NULL_AGENT, map)).passed, false);
    });
  }
});
