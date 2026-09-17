/**
 * How fresh the history an answer came from is. get_status says it on the
 * `history` line and in the `freshness` block; search and recall attach the
 * same block to results, and a scoped call adds how far that chat's local
 * history reaches. Connected but quiet for a day reads as stale — the phone
 * is probably offline — and a sync still running warns the results are
 * partial.
 */
import { test } from "node:test";
import assert from "node:assert/strict";


import { WhatsAppService } from "../dist/whatsapp.js";
import {
  freshnessNote,
  historyFreshness,
  historyLine,
  readFreshness,
  STALE_AFTER_MS,
} from "../dist/freshness.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const hour = 3_600_000;

const iso = (ms) => new Date(ms).toISOString();
const status = (over = {}) => ({
  status: "connected",
  sync: "done",
  last_message_received_at: null,
  ...over,
});

test("historyFreshness maps the status fields; stale needs connected plus a quiet day", () => {
  const now = Date.now();
  const fresh = historyFreshness(status({ last_message_received_at: iso(now - 2 * hour) }), now);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.last_message_age_ms, 2 * hour);

  const stale = historyFreshness(status({ last_message_received_at: iso(now - 25 * hour) }), now);
  assert.equal(stale.stale, true);

  // Disconnected and quiet is not "stale" — the link itself already says so.
  const offline = historyFreshness(
    status({ status: "disconnected", last_message_received_at: iso(now - 25 * hour) }),
    now
  );
  assert.equal(offline.stale, false);

  const empty = historyFreshness(status({ sync: "in_progress" }), now);
  assert.equal(empty.sync, "in_progress");
  assert.equal(empty.last_message_received_at, null);
  assert.equal(empty.last_message_age_ms, null);
  assert.equal(empty.stale, false);
});

test("historyLine renders sync, last inbound with its age, and the stale flag", () => {
  const now = Date.now();
  const fresh = historyFreshness(status({ last_message_received_at: iso(now - 4 * hour) }), now);
  assert.match(historyLine(fresh, now), /^sync done · last inbound \S+ \(4h ago\)$/);

  const stale = historyFreshness(status({ last_message_received_at: iso(now - 30 * hour) }), now);
  assert.match(historyLine(stale, now), /last inbound \S+ \(1d ago\) · stale$/);

  const empty = historyFreshness(status({ status: "connecting", sync: "in_progress" }), now);
  assert.equal(historyLine(empty, now), "sync in_progress · nothing inbound yet");
});

test("freshnessNote warns once: syncing means partial, stale means suspect, fresh stays quiet", () => {
  const now = Date.now();
  const syncing = historyFreshness(
    status({ sync: "in_progress", last_message_received_at: iso(now - hour) }),
    now
  );
  assert.match(freshnessNote(syncing, now), /still running.*may be missing/);

  const stale = historyFreshness(status({ last_message_received_at: iso(now - 26 * hour) }), now);
  assert.match(freshnessNote(stale, now), /may be stale: nothing received for 1d; the phone may be offline/);

  const fresh = historyFreshness(status({ last_message_received_at: iso(now - 2 * hour) }), now);
  assert.equal(freshnessNote(fresh, now), null);
  assert.equal(freshnessNote(null), null);
});

test("readFreshness never throws: no getStatus or a failing one still answers null", async () => {
  assert.equal(await readFreshness({}, undefined), null);
  assert.equal(
    await readFreshness(
      {
        getStatus() {
          throw new Error("status down");
        },
      },
      undefined
    ),
    null
  );
});

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-fresh-", id: ME, name: "Răzvan" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const arrive = (chat, body, at = Date.now()) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe: false, id: `M${++seq}` },
          message: { conversation: body },
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
  return { svc, call, arrive };
}

test("get_status carries the history line and the freshness block", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "salut");

  const result = await call("get_status", {});
  assert.match(result.content[0].text, /^- \*\*history\*\*: sync done · last inbound \S+ \(just now\)$/m);
  const fresh = result.structuredContent.freshness;
  assert.equal(fresh.sync, "done");
  assert.equal(fresh.stale, false);
  assert.match(fresh.last_message_received_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(fresh.last_message_age_ms < 60_000);
});

test("a day of quiet while connected renders stale in text and structure", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "mesaj vechi de ieri", Date.now() - 25 * hour);

  const result = await call("get_status", {});
  assert.match(result.content[0].text, /- \*\*history\*\*: sync done · last inbound \S+ \(1d ago\) · stale/);
  assert.match(result.content[0].text, /phone may be offline/);
  assert.equal(result.structuredContent.freshness.stale, true);
  assert.ok(result.structuredContent.freshness.last_message_age_ms > STALE_AFTER_MS);
});

test("a scoped search adds how far that chat's local history reaches", async () => {
  const { call, arrive } = setup();
  const old = Date.now() - 3 * hour;
  arrive(ANA, "cuvântul comun la ana", old);
  arrive(DAN, "cuvântul comun la dan");

  const scoped = await call("search", { match: "words", query: "cuvântul", chat_id: ANA });
  const chat = scoped.structuredContent.freshness.chat;
  assert.equal(chat.chat_id, ANA);
  assert.ok(Math.abs(Date.parse(chat.newest_local_at) - old) < 2_000, "the chat block dates the newest local hit");
  assert.ok(chat.newest_local_age_ms >= 3 * hour - 2_000);

  const unscoped = await call("search", { match: "words", query: "cuvântul" });
  assert.equal(unscoped.structuredContent.freshness.chat, undefined, "no scope, no per-chat block");
  assert.equal(unscoped.structuredContent.freshness.stale, false);

  const empty = await call("search", { match: "words", query: "cuvântul", chat_id: "40700000099@s.whatsapp.net" });
  assert.equal(empty.structuredContent.freshness.chat.newest_local_at, null, "a chat wazap never saw reports null");
});
