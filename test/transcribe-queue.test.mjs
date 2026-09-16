/**
 * The durable voice-note queue: kept in the account database so a restart
 * resumes it, retried with backoff on the database's clock, given up on with a
 * reason when another attempt cannot help, emptied of notes deleted or expired
 * meanwhile, and served by one worker for the whole process, account by
 * account in turn — with a note that just arrived started at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { AccountDb } from "../dist/db/index.js";
import { WazapError } from "../dist/errors.js";
import { TranscribeWorker, transcribeWorker } from "../dist/transcribe/worker.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { PEER, T0, openTemp, sid } from "./db-fixtures.mjs";
import { connectedService, storageRows } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";

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
const CONFIGURED = { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "sk-test-key" };

// Database level ---------------------------------------------------------------

function voiceRow(key, ts, extra = {}) {
  return {
    chatJid: PEER,
    keyId: key,
    fromMe: false,
    ts,
    type: "voice",
    text: "[voice message · 0:06]",
    raw: new Uint8Array([0x0a, key.length, ...Buffer.from(key)]),
    ...extra,
  };
}

function queuedDb(keys) {
  const fixture = openTemp();
  keys.forEach((key, i) => {
    fixture.db.messages.upsert(voiceRow(key, T0 + i * 1000));
    assert.equal(fixture.db.transcripts.enqueue(sid(false, PEER, key)), true);
  });
  return fixture;
}

test("a note leaves the queue with its transcript, its tombstone, its purge or its deadline", async () => {
  const { db, clock } = queuedDb(["DONE", "GONE", "KEPT", "EXPIRING"]);
  const state = (key) => db.transcripts.state(sid(false, PEER, key));

  db.messages.setTranscript(sid(false, PEER, "DONE"), "gata");
  assert.equal(state("DONE"), null, "a transcript stored by any path takes the note off");

  db.messages.delete(sid(false, PEER, "GONE"), { at: clock.now });
  assert.equal(storageRows({ path: db.path }, "SELECT count(*) AS n FROM transcribe_queue")[0].n, 2, "the tombstone took its row");

  db.messages.setExpiry(sid(false, PEER, "EXPIRING"), clock.now + 1_000);
  clock.now += 2_000;
  const next = db.transcripts.next();
  assert.equal(next.sid, sid(false, PEER, "KEPT"), "the newest note has expired, so it is skipped, not run");
  assert.equal(storageRows({ path: db.path }, "SELECT count(*) AS n FROM transcribe_queue")[0].n, 1, "and leaves on the way");

  await db.messages.clearChat(PEER, clock.now);
  assert.equal(db.transcripts.next(), null, "a cleared chat's notes are not run");
  assert.equal(db.transcripts.stats().queued, 0);
  db.close();
});

test("a run a crash left under way is waiting again after a restart, its attempt counted, and given up at the third", () => {
  const { db, path, clock } = queuedDb(["V1"]);
  const note = sid(false, PEER, "V1");
  const reopen = (current) => {
    current.close();
    return AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  };

  let current = db;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const item = current.transcripts.next();
    assert.equal(current.transcripts.claim(item.id), attempt);
    current = reopen(current);
    assert.equal(current.transcripts.recover(3), 1);
    assert.deepEqual(current.transcripts.state(note), { state: "queued", attempts: attempt, running: false, error: null });
  }
  current.transcripts.claim(current.transcripts.next().id);
  current = reopen(current);
  current.transcripts.recover(3);
  assert.deepEqual(
    current.transcripts.state(note),
    { state: "failed", attempts: 3, error: "interrupted too often" },
    "a note that takes the process down with it cannot loop"
  );
  current.close();
});

test("a note given up on stays given up, with its reason, and is not queued again", () => {
  const { db } = queuedDb(["V1"]);
  const note = sid(false, PEER, "V1");
  const item = db.transcripts.next();
  db.transcripts.claim(item.id);
  db.transcripts.fail(item.id, "media no longer on WhatsApp (HTTP 404)");

  assert.equal(db.transcripts.enqueue(note), false, "a live re-delivery of the same note does not queue it again");
  assert.equal(db.transcripts.next(), null);
  const stats = db.transcripts.stats();
  assert.equal(stats.queued, 0);
  assert.equal(stats.failed, 1);
  assert.deepEqual(stats.lastError, { reason: "media no longer on WhatsApp (HTTP 404)", at: stats.lastError.at, final: true });
  db.close();
});

// Worker level -----------------------------------------------------------------

function fakeSource(db, name, run, { ready = () => true } = {}) {
  const runs = [];
  return {
    runs,
    source: {
      name,
      db: () => db,
      ready,
      run: async (note) => {
        runs.push(note);
        await run(note);
      },
    },
  };
}

test("a failing note is retried on the database's clock, and gives up after the third attempt", async () => {
  const { db, clock } = queuedDb(["V1"]);
  const worker = new TranscribeWorker({ retryDelaysMs: [10_000, 60_000] });
  const { source, runs } = fakeSource(db, "default", async () => {
    throw new Error("whisper.cpp fell over");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    await worker.idle();
    assert.equal(runs.length, 1);
    assert.equal(db.transcripts.dueIn(), 10_000);

    clock.now += 9_999;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 1, "not before its wait is over");

    clock.now += 1;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 2);
    assert.equal(db.transcripts.dueIn(), 60_000, "and the second wait is longer");

    clock.now += 60_000;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 3);
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "V1")), { state: "failed", attempts: 3, error: "unexpected error" });
    assert.equal(db.transcripts.dueIn(), null);

    clock.now += 3_600_000;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 3, "a note given up on is never run again on its own");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("a failure another attempt cannot fix gives up at once; one that is not the note's fault spends no attempt", async () => {
  const { db } = queuedDb(["EXPIRED", "WAITS"]);
  const worker = new TranscribeWorker();
  const expired = Object.defineProperty(new WazapError("MEDIA_UNAVAILABLE", "Could not download"), "cause", {
    value: { output: { statusCode: 410 } },
  });
  const { source, runs } = fakeSource(db, "default", async (note) => {
    if (note.endsWith("EXPIRED")) throw expired;
    throw new WazapError("NOT_CONNECTED", "The socket closed.");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    await worker.idle();
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "EXPIRED")), {
      state: "failed",
      attempts: 1,
      error: "media no longer on WhatsApp (HTTP 410)",
    });
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "WAITS")), {
      state: "queued",
      attempts: 0,
      running: false,
      error: "not connected",
    });
    assert.equal(runs.length, 2);
    assert.ok(db.transcripts.dueIn() > 0, "and it waits before it is tried again");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("an account that is not connected keeps its notes until it is", async () => {
  const { db } = queuedDb(["V1"]);
  const worker = new TranscribeWorker();
  let connected = false;
  const { source, runs } = fakeSource(db, "default", async () => {}, { ready: () => connected });
  try {
    worker.register(source);
    await worker.idle();
    assert.equal(runs.length, 0);
    assert.equal(db.transcripts.stats().queued, 1);

    connected = true;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 1);
  } finally {
    worker.unregister(source);
    db.close();
  }
});

test("two accounts share one worker: one note at a time, the accounts in turn", async () => {
  const first = queuedDb(["A1", "A2", "A3"]);
  const second = queuedDb(["B1", "B2", "B3"]);
  const worker = new TranscribeWorker();
  const order = [];
  let running = 0;
  let peak = 0;
  const run = (label) => async (note) => {
    running++;
    peak = Math.max(peak, running);
    order.push(`${label}:${note.split("_").pop()}`);
    await sleep(2);
    running--;
  };
  const a = fakeSource(first.db, "work", run("work"));
  const b = fakeSource(second.db, "home", run("home"));
  try {
    worker.register(a.source);
    worker.register(b.source);
    await worker.idle();
    assert.equal(peak, 1, "a second whisper run would fight the first one for the machine");
    assert.equal(order.length, 6);
    for (let i = 1; i < order.length; i++) {
      assert.notEqual(order[i].split(":")[0], order[i - 1].split(":")[0], `a backlog on one account does not starve the other: ${order}`);
    }
    assert.deepEqual(
      order.filter((entry) => entry.startsWith("work")),
      ["work:A3", "work:A2", "work:A1"],
      "the newest note of an account goes first"
    );
  } finally {
    worker.unregister(a.source);
    worker.unregister(b.source);
    first.db.close();
    second.db.close();
  }
});

// Service level ----------------------------------------------------------------

/** Runs `body` with exactly `env` as the transcription environment, then puts the old one back. */
function withEnv(env, body) {
  const saved = TRANSCRIBE_ENV.map((key) => [key, process.env[key]]);
  for (const key of TRANSCRIBE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function serviceWith(env = {}, config = {}) {
  return withEnv(env, () =>
    connectedService(WhatsAppService, {
      prefix: "wazap-transcribe-queue-",
      id: ME,
      name: "Răzvan",
      config: { readOnly: false, persistHistory: true, ...config },
    })
  );
}

/** Both seams: no provider is spawned and no media is fetched; `started` lists the notes in the order their runs began. */
function stub(svc, { text = "am uitat umbrela acasă", delayMs = 1 } = {}) {
  const state = { calls: 0, started: [], running: 0, peak: 0 };
  svc.mediaBuffer = async (_sock, messageId) => {
    state.started.push(messageId.split("_").pop());
    return Buffer.from("not really an ogg file");
  };
  svc.transcriber = async () => {
    state.calls++;
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    await sleep(delayMs);
    state.running--;
    return { text, language: "ro", duration_seconds: 6 };
  };
  return state;
}

const voiceNote = (id, { seconds = 6, at = Date.now(), ptt = true } = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt, seconds } },
});
const sidOf = (id) => `false_${PEER}_${id}`;
const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

test("the queue survives a restart: a note that arrived while the account could not run it is transcribed after", async () => {
  const before = serviceWith(CONFIGURED);
  before.svc.status = "disconnected";
  const idle = stub(before.svc);
  deliver(before.sock, [voiceNote("V1")]);
  await before.svc.transcribeIdle();
  assert.equal(idle.calls, 0);
  assert.equal(before.svc.db.transcripts.stats().queued, 1);
  await before.svc.stop();

  const after = serviceWith(CONFIGURED, { dataDir: before.svc.config.dataDir });
  const provider = stub(after.svc);
  await after.svc.transcribeIdle();
  assert.equal(provider.calls, 1, "the restart found the note where it was");
  assert.equal(after.svc.db.messages.get(sidOf("V1")).transcript, "am uitat umbrela acasă");
  assert.equal(after.svc.db.transcripts.stats().queued, 0);
  await after.svc.stop();
});

test("an auto transcript is stored with who made it, and search finds its words", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  stub(svc);
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);
  await svc.transcribeIdle();

  const stored = svc.db.messages.get(sidOf("V1"));
  assert.equal(stored.transcript, "am uitat umbrela acasă");
  assert.equal(stored.transcriptInfo.provider, "openai");
  assert.equal(stored.transcriptInfo.language, "ro");
  assert.equal(stored.transcriptInfo.duration_seconds, 6);
  const hits = (await svc.searchMessages("umbrela", undefined, 10)).data;
  assert.deepEqual(hits.map((view) => view.message_id), [sidOf("V1")]);
  assert.equal(svc.db.transcripts.state(sidOf("V1")), null, "and the note left the queue");
  await svc.stop();
});

test("a voice note deleted while it waits is never transcribed", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  const at = Date.now() - 60_000;
  const doomed = voiceNote("DOOMED", { at });
  deliver(sock, [doomed, voiceNote("KEPT", { at: at + 1000 })]);
  sock.ev.emit("messages.delete", { keys: [doomed.key] });
  assert.equal(svc.db.transcripts.stats().queued, 1, "the delete took the note off the queue");

  svc.status = "connected";
  svc.transcribeWorker.kick();
  await svc.transcribeIdle();
  assert.deepEqual(provider.started, ["KEPT"]);
  await svc.stop();
});

test("audio files, long notes and notes of unknown length are never queued", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  stub(svc);
  const at = Date.now() - 60_000;
  deliver(sock, [
    voiceNote("FILE", { at, ptt: false }),
    voiceNote("LONG", { seconds: 601, at: at + 1000 }),
    { ...voiceNote("NOLENGTH", { at: at + 2000 }), message: { audioMessage: { mimetype: "audio/ogg", ptt: true } } },
    { ...voiceNote("MINE", { at: at + 3000 }), key: { remoteJid: PEER, fromMe: true, id: "MINE" } },
    voiceNote("SHORT", { seconds: 600, at: at + 4000 }),
  ]);
  assert.deepEqual(
    storageRows(svc, "SELECT m.key_id FROM transcribe_queue q JOIN messages m ON m.id = q.message_id").map((row) => row.key_id),
    ["SHORT"]
  );
  await svc.stop();
});

test("WAZAP_TRANSCRIBE_AUTO=0 and no provider queue nothing, and a queue kept while off waits without running", async () => {
  const manual = serviceWith({ ...CONFIGURED, WAZAP_TRANSCRIBE_AUTO: "0" });
  const manualCalls = stub(manual.svc);
  deliver(manual.sock, [voiceNote("M1")]);
  await manual.svc.transcribeIdle();
  assert.equal(manual.svc.db.transcripts.state(sidOf("M1")), null);
  assert.equal(manualCalls.calls, 0);
  await manual.svc.stop();

  const queued = serviceWith(CONFIGURED);
  queued.svc.status = "disconnected";
  deliver(queued.sock, [voiceNote("Q1")]);
  await queued.svc.stop();

  const off = serviceWith({}, { dataDir: queued.svc.config.dataDir });
  const offCalls = stub(off.svc);
  deliver(off.sock, [voiceNote("O1")]);
  await off.svc.transcribeIdle();
  assert.equal(offCalls.calls, 0, "switched off, nothing runs");
  assert.equal(off.svc.db.transcripts.state(sidOf("O1")), null, "and nothing new is queued");
  assert.equal(off.svc.db.transcripts.state(sidOf("Q1")).state, "queued", "but the queue is kept for when it is switched on");
  await off.svc.stop();
});

test("a note queued under one provider is transcribed by the provider configured after a restart", async () => {
  const local = serviceWith({ WAZAP_TRANSCRIBE: "local" });
  local.svc.status = "disconnected";
  deliver(local.sock, [voiceNote("V1")]);
  assert.equal(local.svc.db.transcripts.state(sidOf("V1")).state, "queued");
  await local.svc.stop();

  const api = serviceWith(CONFIGURED, { dataDir: local.svc.config.dataDir });
  stub(api.svc);
  await api.svc.transcribeIdle();
  assert.equal(api.svc.db.messages.get(sidOf("V1")).transcriptInfo.provider, "openai");
  await api.svc.stop();
});

test("a voice note that just arrived starts at once, ahead of a history backlog", async (t) => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  const now = Date.now();
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [1, 2, 3, 4].map((n) => voiceNote(`H${n}`, { at: now - n * 3_600_000 })),
    isLatest: true,
  });
  await svc.historyIdle();
  assert.equal(svc.db.transcripts.stats().queued, 4);
  await sleep(5);

  svc.status = "connected";
  const deliveredAt = performance.now();
  let startedAt = null;
  let storedAt = null;
  const seam = svc.mediaBuffer;
  svc.mediaBuffer = async (...args) => {
    startedAt ??= performance.now();
    return seam(...args);
  };
  deliver(sock, [voiceNote("LIVE")]);
  const waited = svc.transcribeWorker.settled(svc.transcribeSource, sidOf("LIVE")).then(() => {
    storedAt = performance.now();
  });
  await waited;
  await svc.transcribeIdle();

  assert.equal(provider.started[0], "LIVE", "the note someone just sent is not held behind yesterday's");
  assert.deepEqual(provider.started.slice(1), ["H1", "H2", "H3", "H4"], "and the backlog follows, newest first");
  assert.equal(provider.calls, 5);
  const toStart = startedAt - deliveredAt;
  const toTranscript = storedAt - deliveredAt;
  t.diagnostic(`time to start: ${toStart.toFixed(1)} ms; time to transcript with a stub provider: ${toTranscript.toFixed(1)} ms`);
  assert.ok(toStart < 250, `the run started ${toStart} ms after the note arrived`);
  assert.ok(toTranscript < 1_000, `the transcript was stored ${toTranscript} ms after the note arrived`);
  await svc.stop();
});

test("the shared worker is the one every service uses", () => {
  const { svc } = serviceWith(CONFIGURED);
  assert.equal(svc.transcribeWorker, transcribeWorker);
  return svc.stop();
});
