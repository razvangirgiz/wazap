/**
 * Signed links to originals (src/media-links.ts): minted by get_media for a
 * remote session on a server with a public URL, never for a local one or
 * without that URL; served by GET /media/:token as an attachment, and a 404
 * alike for a forged, expired or tampered link, another account's, or a
 * message gone since.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { MediaLinks, MEDIA_LINK_KEY_FILE, attachmentDisposition, linkSecret, mediaLinksFor, sidTag } from "../dist/media-links.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, connectedService, schemaCheckedTools } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ANA = "40700000002@s.whatsapp.net";
const PUBLIC = "https://wazap.example";

async function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-links-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const config = { ...svc.config, publicUrl: PUBLIC };
  const links = mediaLinksFor(config);
  const remote = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false, mediaLinks: links });
  const pdf = pdfOf([["Factura 12"]]);
  svc.mediaBuffer = async () => pdf;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "F1" }, message: { documentMessage: { mimetype: "application/pdf", fileName: "factură \"mai\".pdf", fileLength: pdf.length } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const sid = `false_${ANA}_F1`;
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(asToolSource(svc), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [{ token: "synthetic-reader", write: false }],
  });
  const local = (url) => url.replace(PUBLIC, `http://127.0.0.1:${port}`);
  return { svc, sock, sid, pdf, links, config, remote, local };
}

test("a link is a signed claim: it verifies until it expires, and any change to it fails", () => {
  let now = 1_800_000_000_000;
  const links = new MediaLinks(Buffer.alloc(32, 1), PUBLIC, () => now);
  const { url, expires_at } = links.mint({ account: "personal", row: 42, tag: sidTag("false_x_1") });
  assert.equal(expires_at, new Date(now + 30 * 60 * 1000).toISOString());
  const token = url.slice(`${PUBLIC}/media/`.length);
  assert.deepEqual(links.verify(token), { account: "personal", row: 42, tag: sidTag("false_x_1"), expires: now + 30 * 60 * 1000 });
  assert.ok(!url.includes("false_x_1") && !url.includes("whatsapp.net"), "no message id or number in the URL");

  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "personal", r: 43, t: sidTag("false_x_1"), e: 9_999_999_999 })).toString("base64url");
  assert.equal(links.verify(`${forged}.${signature}`), null, "another payload under the same signature");
  assert.equal(links.verify(`${payload}.${signature.slice(0, -2)}AA`), null, "a changed signature");
  assert.equal(new MediaLinks(Buffer.alloc(32, 2), PUBLIC, () => now).verify(token), null, "another install's secret");
  for (const junk of ["", ".", "a.b.c", "x".repeat(600), `${payload}.`]) assert.equal(links.verify(junk), null, JSON.stringify(junk.slice(0, 20)));
  now += 30 * 60 * 1000;
  assert.equal(links.verify(token), null, "expired");
});

test("the install's secret is made once, kept owner-only, and reused", (t) => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-secret-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const first = linkSecret(svc.config.dataDir);
  const file = join(svc.config.dataDir, MEDIA_LINK_KEY_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(first.length, 32);
  assert.deepEqual(linkSecret(svc.config.dataDir), first);
  assert.deepEqual(readFileSync(file), first);
});

test("a short or empty key left by a crash is replaced, and the HTTP endpoint starts either way", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, MEDIA_LINK_KEY_FILE);
  writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
  const secret = linkSecret(dir);
  assert.equal(secret.length, 32);
  assert.deepEqual(readFileSync(file), secret);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [MEDIA_LINK_KEY_FILE], "no temporary file is left");
  writeFileSync(file, Buffer.alloc(7, 1));
  assert.ok(mediaLinksFor({ dataDir: dir, publicUrl: PUBLIC }) instanceof MediaLinks);
  assert.equal(readFileSync(file).length, 32);

  // A data dir the secret cannot be written to: no links, and no throw that would stop the listener.
  if (process.getuid?.() === 0) return;
  const locked = mkdtempSync(join(tmpdir(), "wazap-locked-"));
  chmodSync(locked, 0o500);
  t.after(() => {
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true, force: true });
  });
  assert.throws(() => linkSecret(locked), /could not be written/);
  assert.equal(mediaLinksFor({ dataDir: locked, publicUrl: PUBLIC }), null);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-nokey-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const port = await startHttpEndpoint(asToolSource(svc), { ...svc.config, dataDir: locked, publicUrl: PUBLIC }, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [{ token: "synthetic-reader", write: false }],
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

test("the download is named for any client, and nothing in the name escapes its header", () => {
  assert.equal(attachmentDisposition('factură "mai"/../x.pdf', "application/pdf"), `attachment; filename="factur_ _mai_..x.pdf"; filename*=UTF-8''factur%C4%83%20%22mai%22..x.pdf`);
  assert.equal(attachmentDisposition(null, "image/jpeg"), `attachment; filename="whatsapp-media.jpeg"; filename*=UTF-8''whatsapp-media.jpeg`);
  // A long name with an emoji where the cut falls, and a lone surrogate: still a header, never a URIError.
  const long = attachmentDisposition(`${"a".repeat(199)}\u{1F600}.pdf`, "application/pdf");
  assert.match(long, /filename\*=UTF-8''a{199}%F0%9F%98%80$/);
  assert.match(attachmentDisposition("x\ud800y.pdf", "application/pdf"), /filename\*=UTF-8''xy\.pdf$/);
  assert.doesNotMatch(attachmentDisposition("a\r\nSet-Cookie: x", "text/plain"), /[\r\n]/);
});

test("get_media gives a remote session a link that serves the original as a safe attachment", async (t) => {
  const { sid, pdf, remote, local } = await setup(t);
  const result = await remote.call("get_media", { message_id: sid });
  const { link } = result.structuredContent;
  assert.ok(link.url.startsWith(`${PUBLIC}/media/`));
  assert.ok(Date.parse(link.expires_at) - Date.now() > 29 * 60 * 1000);
  assert.match(result.content[0].text, /The original file, to open \(valid 30 minutes\): https:\/\/wazap\.example\/media\//);

  const response = await fetch(local(link.url));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="factur_ _mai_.pdf"; filename\*=UTF-8''/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
});

test("a tampered, expired, other-account or stale link is a 404, like a deleted message's", async (t) => {
  const { svc, sock, sid, links, config, local } = await setup(t);
  const ref = svc.mediaLinkRef(sid);
  const good = links.mint({ account: "default", ...ref }).url;
  const status = async (url) => (await fetch(local(url))).status;
  assert.equal(await status(good), 200);
  assert.equal(await status(`${good.slice(0, -3)}xyz`), 404, "tampered");
  assert.equal(await status(links.mint({ account: "other", ...ref }).url), 404, "an account this server does not have");
  assert.equal(await status(links.mint({ account: "default", row: ref.row, tag: sidTag("false_x_other") }).url), 404, "a row that is not that message");
  const past = new MediaLinks(linkSecret(config.dataDir), PUBLIC, () => Date.now() - 31 * 60 * 1000).mint({ account: "default", ...ref }).url;
  assert.equal(await status(past), 404, "expired");
  const notFound = await fetch(local(`${PUBLIC}/media/nonsense`));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("cache-control"), "private, no-store");

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "R1" }, message: { protocolMessage: { type: 0, key: { remoteJid: ANA, fromMe: false, id: "F1" } } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  assert.equal(await status(good), 404, "deleted since the link was made");
});

test("no link for a local session, nor for a remote one on a server without a public URL", async (t) => {
  const { svc, sid } = await setup(t);
  const local = schemaCheckedTools(svc, { allowWrite: false, mediaLinks: mediaLinksFor({ ...svc.config, publicUrl: PUBLIC }) });
  assert.equal((await local.call("get_media", { message_id: sid })).structuredContent.link, undefined);
  const remote = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false });
  const answer = await remote.call("get_media", { message_id: sid });
  assert.equal(answer.structuredContent.link, undefined);
  assert.doesNotMatch(answer.content[0].text, /https?:\/\//);
});

test("the token never reaches the HTTP log", async (t) => {
  const { sid, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  const token = link.url.split("/media/")[1];
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    chunks.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  try {
    await (await fetch(local(link.url))).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = original;
  }
  const logged = chunks.join("");
  assert.match(logged, /HTTP GET \/media rpc=- noauth/);
  assert.ok(!logged.includes(token.slice(0, 20)), "no part of the token is logged");
});
