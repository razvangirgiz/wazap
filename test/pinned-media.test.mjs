/**
 * Media from a URL is fetched when it is drafted and kept until it is sent:
 * the preview names the real file (its name, type by its bytes, size), the
 * send sends exactly those bytes without fetching again, a draft for later may
 * take a URL, and the kept file goes after the send, at the draft's expiry and
 * on a cancel. The fetch still passes the public-address guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { WhatsAppService } from "../dist/whatsapp.js";
import { PinnedStore } from "../dist/pinned-media.js";
import { safeFilename, sniffMime } from "../dist/outgoing-media.js";
import { dispositionFilename } from "../dist/safe-media.js";
import { connectedService, schemaCheckedTools, storageRows, textError } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const OWNER = "session_a";
const MINUTE = 60_000;
const RECORD = Object.freeze({ id: "default", name: "default", enabled: true, owner: null });

/** A web server on the public internet, as the fetch sees it: answers each URL with `routes[path]`. */
function web(routes) {
  const fetched = [];
  const request = (url, _options, cb) => {
    const path = new URL(String(url)).pathname;
    fetched.push(path);
    const route = routes[path] ?? { status: 404, body: Buffer.alloc(0) };
    const res = Readable.from(route.body.length === 0 ? [] : [route.body]);
    res.statusCode = route.status ?? 200;
    res.headers = { ...(route.type ? { "content-type": route.type } : {}), ...(route.headers ?? {}), "content-length": String(route.body.length) };
    res.socket = { remoteAddress: "93.184.216.34" };
    queueMicrotask(() => cb(res));
    return {
      on() {
        return this;
      },
      end() {},
    };
  };
  return { network: { request, requestTls: request, resolve: async () => [{ address: "93.184.216.34", family: 4 }] }, fetched };
}

function setup(t, routes, { config = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-pinned-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-pinned-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
  t.after(() => svc.stop());
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  const uploaded = [];
  sock.waUploadToServer = async (file) => {
    uploaded.push(file);
    return { mediaUrl: "https://mmg.whatsapp.net/synthetic", directPath: "/synthetic" };
  };
  const sent = [];
  sock.relayMessage = async (jid, message, options) => {
    sent.push({ jid, message });
    return options.messageId;
  };
  const server = web(routes);
  svc.mediaNetwork = server.network;
  const outgoing = join(dataDir, "accounts", "default", "outgoing");
  const files = () => (existsSync(outgoing) ? readdirSync(outgoing).filter((name) => /^[0-9a-f]{64}$/.test(name)) : []);
  return { svc, sock, sent, uploaded, server, outgoing, files, dataDir };
}

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

test("a URL is fetched when drafted: the preview names the real file, and the yes sends exactly those bytes", async (t) => {
  const pdf = pdfOf([["Factura 12"]]);
  const routes = { "/download": { body: pdf, type: "application/octet-stream", headers: { "content-disposition": `attachment; filename*=UTF-8''factur%C4%83%2012.pdf` } } };
  const { svc, server, files, outgoing, uploaded, sent: sent_ } = setup(t, routes);
  const { call } = schemaCheckedTools(svc);

  const draft = await call("send_message", { chat_id: PEER, text: "Factura", url: "https://example.com/download" });
  const view = draft.structuredContent;
  assert.equal(view.status, "draft", draft.content[0].text);
  assert.deepEqual(view.media, { filename: "factură 12.pdf", mime: "application/pdf", size: pdf.length });
  assert.match(view.preview, /\[document\] factură 12\.pdf \(application\/pdf, \d+ KB\)\n"Factura"/);
  assert.deepEqual(server.fetched, ["/download"]);
  assert.deepEqual(files(), [sha(pdf)]);
  assert.equal(statSync(join(outgoing, sha(pdf))).mode & 0o777, 0o600);
  assert.equal(statSync(outgoing).mode & 0o777, 0o700);

  // What the URL serves by the yes is not what goes: the pinned bytes are.
  routes["/download"] = { body: Buffer.from("something else entirely"), type: "application/pdf" };
  const sent = await call("confirm_send", { draft_id: view.draft_id });
  assert.equal(sent.isError, undefined, sent.content[0].text);
  assert.deepEqual(server.fetched, ["/download"], "not fetched again at the send");
  assert.equal(uploaded.length, 1);
  const document = sent_.at(-1).message.documentMessage;
  assert.equal(Buffer.from(document.fileSha256).toString("hex"), sha(pdf), "the bytes that left are the ones drafted");
  assert.equal(document.fileName, "factură 12.pdf");
  assert.equal(document.mimetype, "application/pdf");
  await svc.sends.collectPinned();
  assert.deepEqual(files(), [], "sent: its file goes");
});

test("the type comes from the bytes, a name without an extension gets one, and a caption on audio is refused before anything is kept", async (t) => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200)]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(100)]);
  const { svc, files } = setup(t, {
    "/voice": { body: ogg, type: "text/plain" },
    "/photo": { body: jpeg, type: "application/octet-stream" },
  });
  const { call } = schemaCheckedTools(svc);
  const refused = textError(await call("send_message", { chat_id: PEER, text: "ascultă", url: "https://example.com/voice" }));
  assert.equal(refused.error, "INVALID_ID");
  assert.match(refused.message, /audio\/ogg, which WhatsApp shows with no caption/);
  assert.deepEqual(files(), []);
  const photo = (await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/photo" })).structuredContent;
  assert.deepEqual(photo.media, { filename: "photo.jpg", mime: "image/jpeg", size: jpeg.length });
  assert.match(photo.preview, /\[image\] photo\.jpg \(image\/jpeg, 1 KB\)/);

  assert.equal(sniffMime(pdfOf([["x"]]), "text/html", "x"), "application/pdf");
  assert.equal(sniffMime(Buffer.from("PK\x03\x04rest"), null, "raport.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(sniffMime(Buffer.from("a,b\n1,2\n"), "text/csv; charset=utf-8", "x"), "text/csv");
  assert.equal(safeFilename("../../etc/passwd", "text/plain"), "passwd.txt");
  assert.equal(safeFilename("a\u0000b\nc.pdf", "application/pdf"), "abc.pdf");
  assert.equal(dispositionFilename(`attachment; filename="raport final.pdf"`), "raport final.pdf");
  assert.equal(dispositionFilename(undefined), null);
});

test("a fetch that fails, or one the address guard refuses, drafts nothing and keeps nothing", async (t) => {
  const { svc, files, dataDir } = setup(t, {});
  const { call } = schemaCheckedTools(svc);
  assert.equal(textError(await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/missing" })).error, "URL_FETCH_FAILED");
  svc.mediaNetwork = {};
  assert.equal(textError(await call("send_message", { chat_id: PEER, text: "", url: "http://169.254.169.254/latest/meta-data/" })).error, "MEDIA_ACCESS_DENIED");
  assert.deepEqual(files(), []);
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends")[0].n, 0);
  assert.ok(dataDir);
});

test("a URL may go later: scheduled, its pinned bytes go at their time, and a cancel or a lapse takes the file away", async (t) => {
  const pdf = pdfOf([["Contract"]]);
  const { svc, sent, files, server } = setup(t, { "/c.pdf": { body: pdf, type: "application/pdf" }, "/d.pdf": { body: pdfOf([["Altul"]]), type: "application/pdf" } });
  const clock = { now: Date.now() };
  svc.schedule.now = () => clock.now;
  svc.enableSchedule(() => ({ ...RECORD }));
  const at = Date.now() + 5 * MINUTE;
  const media = (url) => ({ kind: "media", chatId: PEER, source: { url }, asDocument: true, asVoice: false, asGif: false });

  const later = await svc.draft(media("https://example.com/c.pdf"), OWNER, { at, zone: "UTC" });
  assert.match(later.preview, /Scheduled: .*\n\[document\] c\.pdf \(application\/pdf/);
  const scheduled = await svc.confirmSchedule(later.draft_id, OWNER);
  const cancelled = await svc.confirmSchedule((await svc.draft(media("https://example.com/d.pdf"), OWNER, { at, zone: "UTC" })).draft_id, OWNER);
  assert.equal(files().length, 2);
  await svc.cancelScheduled(cancelled.schedule_id);
  await svc.sends.collectPinned();
  assert.deepEqual(files(), [sha(pdf)], "the cancelled one's file went");

  server.fetched.length = 0;
  clock.now = at + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1);
  assert.deepEqual(server.fetched, [], "the URL is not fetched at the send");
  assert.equal(storageRows(svc, "SELECT state FROM scheduled WHERE id = ?", scheduled.schedule_id)[0].state, "sent");
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);

  // A draft nobody confirms: once it lapses, its file goes too.
  await svc.draft(media("https://example.com/c.pdf"), OWNER);
  assert.equal(files().length, 1);
  const writer = new DatabaseSync(svc.databasePath);
  writer.prepare("UPDATE sends SET expires_at = ? WHERE state = 'draft'").run(Date.now() - 1);
  writer.close();
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);
});

test("a pinned file that changed or went is never sent in its place", async (t) => {
  const pdf = pdfOf([["Original"]]);
  const { svc, sent, outgoing } = setup(t, { "/a.pdf": { body: pdf, type: "application/pdf" } });
  const { call } = schemaCheckedTools(svc);
  const draft = (await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/a.pdf" })).structuredContent;
  writeFileSync(join(outgoing, sha(pdf)), "tampered");
  const refused = textError(await call("confirm_send", { draft_id: draft.draft_id }));
  assert.equal(refused.error, "FILE_NOT_FOUND");
  assert.match(refused.message, /no longer on the machine running wazap; nothing was sent/);
  assert.equal(sent.length, 0);
});

test("the pinned files of an account are bounded: past the cap a new draft is refused, and a crash's half-written file is swept", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pinned-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PinnedStore(dir, { maxTotalBytes: 1000, now: () => Date.now() });
  const first = await store.pin(Buffer.alloc(600, 1), "application/pdf", "a.pdf");
  store.release(first.sha256);
  await assert.rejects(store.pin(Buffer.alloc(600, 2), "application/pdf", "b.pdf"), { code: "FILE_TOO_LARGE", message: /already hold/ });
  const again = await store.pin(Buffer.alloc(600, 1), "application/pdf", "a again.pdf");
  assert.equal(again.sha256, first.sha256, "the same bytes share one file and count once");
  store.release(again.sha256);
  writeFileSync(join(dir, `${"0".repeat(64)}.1.${Date.now() - 3_600_000}.part`), "half");
  await store.sweep(() => new Set([first.sha256]));
  assert.deepEqual(readdirSync(dir), [first.sha256]);
  await store.sweep(() => null);
  assert.deepEqual(readdirSync(dir), [first.sha256], "nothing to judge by: nothing removed");
  await store.sweep(() => new Set());
  assert.deepEqual(readdirSync(dir), []);
  const full = new PinnedStore(dir, { diskSpace: async () => ({ free: 10, total: 1_000_000 }) });
  await assert.rejects(full.pin(Buffer.alloc(100), "text/plain", "x.txt"), { code: "FILE_TOO_LARGE", message: /nearly full/ });
});
