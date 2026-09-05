/**
 * Transcription where it meets WhatsApp: what a voice note reads as, the cache
 * that keeps a recording from reaching a provider twice, what survives a
 * restart, and the queue that runs behind ingestion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { WhatsAppService } from "../dist/whatsapp.js";
import { clockLabel } from "../dist/messages.js";
import { registerTools } from "../dist/tools.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";

const TRANSCRIBE_ENV = [
  "WAZAP_TRANSCRIBE",
  "WAZAP_TRANSCRIBE_API_KEY",
  "WAZAP_TRANSCRIBE_AUTO",
  "WAZAP_TRANSCRIBE_LANGUAGE",
  "WAZAP_TRANSCRIBE_MODEL",
  "WAZAP_TRANSCRIBE_URL",
  "WAZAP_WHISPER_BIN",
  "WAZAP_WHISPER_MODEL",
  "OPENAI_API_KEY",
];

/**
 * The service reads the transcription environment once, in its constructor, so
 * the variables are set around that call and put back straight after. The openai
 * provider is the one whose readiness is a key and nothing else, which keeps
 * whisper.cpp and its 574 MB model out of these tests.
 */
function serviceWith(env = {}, config = {}) {
  const saved = TRANSCRIBE_ENV.map((key) => [key, process.env[key]]);
  for (const key of TRANSCRIBE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    // Writes on: read-only refuses the API provider, which is what the
    // read-only test below asserts and what every other test here must not hit.
    return connectedService(WhatsAppService, {
      prefix: "wazap-transcribe-",
      id: ME,
      name: "Răzvan",
      config: { readOnly: false, ...(config ?? {}) },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CONFIGURED = { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "sk-test-key" };
const MANUAL = { ...CONFIGURED, WAZAP_TRANSCRIBE_AUTO: "0" };

/** A provider that spawns nothing and records how many runs overlapped. */
function mockProvider({ text = "salut", delayMs = 1 } = {}) {
  const state = { calls: 0, running: 0, peak: 0, languages: [] };
  const transcribe = async (_settings, _file, opts) => {
    state.calls++;
    state.languages.push(opts.language);
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    await sleep(delayMs);
    state.running--;
    return { text, language: "ro", duration_seconds: 6 };
  };
  return { state, transcribe };
}

/** Both seams at once: no provider is spawned and no media is fetched. */
function stub(svc, provider) {
  svc.transcriber = provider.transcribe;
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  return provider;
}

/** Stand-in for McpServer: records what got registered and lets us call it. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

const voiceNote = (id, { seconds, at = Date.now(), ptt = true } = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt, ...(seconds === undefined ? {} : { seconds }) },
  },
});

const textMessage = (id, body, at = Date.now()) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: { conversation: body },
});

const sidOf = (id) => `false_${PEER}_${id}`;
const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

test("a duration reads as a clock, whatever its size", () => {
  assert.equal(clockLabel(6), "0:06");
  assert.equal(clockLabel(42), "0:42");
  assert.equal(clockLabel(185), "3:05");
  assert.equal(clockLabel(3723), "1:02:03");
});

test("a voice note reads as its length, and as its words once it has them", async () => {
  const { svc, sock } = serviceWith();
  const at = Date.now() - 60_000;
  deliver(sock, [voiceNote("V1", { seconds: 42, at }), voiceNote("V2", { at: at + 1000 })]);

  const before = (await svc.readMessages(PEER, 10)).data;
  assert.equal(before[0].text, "[voice message · 0:42]");
  assert.equal(before[0].transcript, undefined);
  assert.equal(before[1].text, "[voice message]", "a note WhatsApp said nothing about keeps the bare placeholder");

  svc.store.transcripts.set(sidOf("V1"), { text: "salut", language: "ro", provider: "local", at: Date.now() });
  await svc.appendHistory([svc.store.messages.get(sidOf("V1"))]);
  const after = (await svc.readMessages(PEER, 10)).data;
  assert.equal(after[0].text, '[voice message · 0:42] "salut"');
  assert.equal(after[0].transcript, "salut", "the bare words too, so an agent need not unwrap the placeholder");
  await svc.stop();
});

test("a message is transcribed once, and the second call says as much", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const first = await svc.transcribeAudio(sidOf("V1"));
  assert.deepEqual(first, { text: "salut", language: "ro", duration_seconds: 6, provider: "openai", cached: false });

  const second = await svc.transcribeAudio(sidOf("V1"));
  assert.equal(second.cached, true);
  assert.equal(second.text, "salut");
  assert.equal(provider.state.calls, 1, "one recording must never be sent to a provider twice");
  await svc.stop();
});

test("the tool's language argument reaches the provider", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  await svc.transcribeAudio(sidOf("V1"), "ro");
  assert.deepEqual(provider.state.languages, ["ro"]);
  await svc.stop();
});

test("two callers wanting the same recording share one upload", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider({ delayMs: 5 }));
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const [first, second] = await Promise.all([svc.transcribeAudio(sidOf("V1")), svc.transcribeAudio(sidOf("V1"))]);
  assert.equal(provider.state.calls, 1, "the cache is written only after a provider has run, so the second caller has to join the first");
  assert.equal(first.text, "salut");
  assert.equal(second.text, "salut");
  await svc.stop();
});

test("a transcript survives the cache snapshot and a SQLite archive restart", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const raw = svc.store.messages.get(sidOf("V1"));
  svc.config.persistHistory = true;
  await svc.appendHistory([raw]);
  await svc.transcribeAudio(sidOf("V1"));

  const snapshot = new WhatsAppService(svc.config);
  snapshot.store.hydrate(svc.store.serialize());
  assert.equal(snapshot.store.transcripts.get(sidOf("V1"))?.text, "salut");

  // Three lines for one message: none, "salut", then a correction. Only the last
  // may survive, which a rule of "any line carrying a transcript wins" would fail.
  svc.store.transcripts.set(sidOf("V1"), { text: "a doua încercare", provider: "openai", at: Date.now() });
  await svc.appendHistory([raw]);

  await svc.stop();
  const reloaded = new WhatsAppService(svc.config);
  reloaded.account = svc.account;
  await reloaded.loadPersisted();
  assert.equal(reloaded.store.transcripts.get(sidOf("V1"))?.text, "a doua încercare", "the newest record for a sid wins");
  await reloaded.stop();
});

test("an older snapshot, written before transcripts existed, still loads", () => {
  const { svc } = serviceWith();
  svc.store.hydrate({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} });
  assert.equal(svc.store.transcripts.size, 0);
});

test("auto mode takes the voice notes, one at a time, and leaves the rest", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider({ delayMs: 5 }));
  const at = Date.now() - 600_000;
  deliver(sock, [
    voiceNote("V1", { seconds: 6, at }),
    voiceNote("V2", { seconds: 12, at: at + 1000 }),
    voiceNote("V3", { seconds: 18, at: at + 2000 }),
    voiceNote("A1", { seconds: 30, at: at + 3000, ptt: false }),
    voiceNote("LONG", { seconds: 601, at: at + 4000 }),
    voiceNote("NOLENGTH", { at: at + 5000 }),
  ]);

  assert.equal(svc.store.transcripts.size, 0, "ingestion returned before a single provider had finished");

  await svc.transcribeIdle();
  assert.equal(provider.state.peak, 1, "a second whisper run would fight the first one for the machine");
  assert.deepEqual(
    [...svc.store.transcripts.keys()].sort(),
    ["V1", "V2", "V3"].map(sidOf).sort(),
    "an audio file is something the sender attached, and a recording that is long or of unknown length is a bill nobody asked for",
  );
  assert.equal(provider.state.calls, 3);
  await svc.stop();
});

test("a provider that fails on one note does not stop the queue", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = mockProvider();
  stub(svc, provider);
  const run = provider.transcribe;
  svc.transcriber = async (settings, file, opts) => {
    if (provider.state.calls === 0) {
      provider.state.calls++;
      throw new Error("whisper.cpp fell over");
    }
    return run(settings, file, opts);
  };

  const at = Date.now() - 600_000;
  deliver(sock, [voiceNote("V1", { seconds: 6, at }), voiceNote("V2", { seconds: 6, at: at + 1000 })]);
  await svc.transcribeIdle();

  assert.deepEqual([...svc.store.transcripts.keys()], [sidOf("V2")], "the second note still gets its turn");
  await svc.stop();
});

test("a transcript landing during shutdown does not hold the process open", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  stub(svc, mockProvider({ delayMs: 20 }));
  svc.config.persistHistory = true;
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  await svc.stop();
  await svc.transcribeIdle();
  assert.equal(svc.storeSaveTimer, null, "a stopped service must not arm a fresh save timer");
});

test("search_messages finds a word that exists only in a transcript", async () => {
  const { svc, sock } = serviceWith();
  const at = Date.now() - 60_000;
  deliver(sock, [voiceNote("V1", { seconds: 6, at }), textMessage("T1", "nimic aici", at + 1000)]);
  svc.store.transcripts.set(sidOf("V1"), { text: "am uitat umbrela acasă", provider: "local", at: Date.now() });

  await svc.appendHistory([svc.store.messages.get(sidOf("V1"))]);
  const spoken = (await svc.searchMessages("umbrela", undefined, 10)).data;
  assert.deepEqual(
    spoken.map((view) => view.message_id),
    [sidOf("V1")],
  );

  const written = (await svc.searchMessages("nimic", undefined, 10)).data;
  assert.deepEqual(
    written.map((view) => view.message_id),
    [sidOf("T1")],
    "every other message still matches on exactly what it matched on before",
  );
  await svc.stop();
});

test("transcribe_audio names the reason it cannot answer", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  stub(svc, mockProvider());
  deliver(sock, [textMessage("T1", "salut")]);

  await assert.rejects(() => svc.transcribeAudio(sidOf("NOPE")), { code: "MESSAGE_NOT_FOUND" });
  await assert.rejects(() => svc.transcribeAudio(sidOf("T1")), { code: "MEDIA_UNAVAILABLE" });
  await svc.stop();

  const off = serviceWith();
  stub(off.svc, mockProvider());
  deliver(off.sock, [voiceNote("V1", { seconds: 6 })]);
  await assert.rejects(() => off.svc.transcribeAudio(sidOf("V1")), (err) => {
    assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE");
    assert.match(err.fix, /wazap config transcribe/, "the fix has to name the command that turns it on");
    return true;
  });
  await off.svc.stop();
});

test("a provider name wazap does not know leaves the server up and says why", async () => {
  const { svc, sock } = serviceWith({ WAZAP_TRANSCRIBE: "wishful-thinking" });
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  assert.equal((await svc.readMessages(PEER, 10)).data.length, 1, "every other tool keeps working");
  await assert.rejects(() => svc.transcribeAudio(sidOf("V1")), (err) => {
    assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE");
    assert.match(err.message, /wishful-thinking/);
    return true;
  });
  await svc.stop();
});

test("no tool output carries the API key, whatever the tool", async () => {
  const key = "sk-test-key-abcd1234";
  const { svc, sock } = serviceWith({ ...MANUAL, WAZAP_TRANSCRIBE_API_KEY: key });
  stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const server = fakeServer();
  registerTools(server, svc, { allowWrite: true });
  const said = [JSON.stringify(await svc.transcribeAudio(sidOf("V1")))];
  for (const name of ["get_status", "read_messages", "search_messages"]) {
    said.push(JSON.stringify(await server.tools.get(name).handler({ chat_id: PEER, query: "salut", limit:20 })));
  }

  assert.ok(said.every((text) => !text.includes(key)), "the key belongs in .env and nowhere else");
  assert.ok(said.some((text) => text.includes("salut")), "and the transcript did come back, so this is not passing vacuously");
  await svc.stop();
});

test("transcribe_audio spends a bucket of its own, ten a minute", async () => {
  const server = fakeServer();
  const wa = {
    transcribeAudio: async () => ({ text: "salut", language: "ro", duration_seconds: 6, provider: "local", cached: true }),
  };
  registerTools(server, wa, { allowWrite: true });
  const transcribe = server.tools.get("transcribe_audio").handler;

  const first = await transcribe({ message_id: sidOf("V1") });
  assert.equal(first.content[0].text, 'Transcribed 0:06 (ro, local, cached): "salut"');
  for (let call = 2; call <= 10; call++) {
    assert.equal((await transcribe({ message_id: sidOf("V1") })).isError, undefined, `call ${call}`);
  }

  const limited = await transcribe({ message_id: sidOf("V1") });
  assert.equal(limited.structuredContent.error, "RATE_LIMITED");
  assert.equal(limited.structuredContent.message, "Transcribe rate limit reached (10/minute).");

  // An HTTP client that re-initializes gets a fresh McpServer; the bucket is the
  // process's and must not arrive fresh with it.
  const rejoined = fakeServer();
  registerTools(rejoined, wa, { allowWrite: true });
  const again = await rejoined.tools.get("transcribe_audio").handler({ message_id: sidOf("V1") });
  assert.equal(again.structuredContent.error, "RATE_LIMITED", "a new session must not come with ten more");
});

test("a history sync is not an arrival, so its backlog is never billed", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider());

  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [voiceNote("H1", { seconds: 8 }), voiceNote("H2", { seconds: 9 })],
    isLatest: true,
  });
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 0, "a relink would otherwise transcribe every voice note in the window");

  deliver(sock, [voiceNote("L1", { seconds: 8 })]);
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 1, "one that actually arrived is still transcribed");
  await svc.stop();
});

test("a voice note the user recorded is not transcribed behind their back", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider());

  deliver(sock, [{ ...voiceNote("M1", { seconds: 8 }), key: { remoteJid: PEER, fromMe: true, id: "M1" } }]);
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 0, "they know what they said");
  await svc.stop();
});

test("read-only refuses the API provider and nothing else", async () => {
  const { svc, sock } = serviceWith(MANUAL, { readOnly: true });
  stub(svc, mockProvider());
  deliver(sock, [voiceNote("R1", { seconds: 6 })]);

  await assert.rejects(() => svc.transcribeAudio(sidOf("R1")), (err) => {
    assert.equal(err.code, "READ_ONLY", "uploading the user's audio and spending their money is not a read");
    assert.match(err.fix, /transcribe local/);
    return true;
  });
  await svc.stop();

  const local = serviceWith({ WAZAP_TRANSCRIBE: "local" }, { readOnly: true });
  stub(local.svc, mockProvider());
  deliver(local.sock, [voiceNote("R2", { seconds: 6 })]);
  await assert.rejects(() => local.svc.transcribeAudio(sidOf("R2")), (err) => {
    assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE", "whisper.cpp sends nothing anywhere, so read-only has no say");
    return true;
  });
  await local.svc.stop();
});
