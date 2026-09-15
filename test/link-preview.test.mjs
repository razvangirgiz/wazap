import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import jpeg from "jpeg-js";
import { firstPreviewUrl, previewMetadata, safeLinkPreview } from "../dist/link-preview.js";

const PUBLIC = "93.184.216.34";
const URL = "https://page.example/article";
const html =
  '<head><meta property="og:title" content="A &amp; B"><meta name="description" content="Description"><meta property="og:image" content="/image.jpg"></head>';
const image = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 60).data;

/** No live DNS, servers, HTTP clients or decoder URLs. */
function fixture(routes = {}, resolve = async () => [{ address: PUBLIC, family: 4 }]) {
  const calls = [];
  const request = (url, options, cb) => {
    const route = routes[url.href] ?? {};
    const req = new EventEmitter();
    req.end = () => {
      calls.push(url.href);
      assert.equal(options.headers, undefined, "no Authorization, cookies or Referer");
      options.lookup(url.hostname, {}, (err, address) => {
        assert.equal(err, null);
        assert.equal(address, PUBLIC, "socket lookup is pinned");
      });
      const res = route.hang
        ? new Readable({ read() {} })
        : Readable.from(route.chunks ?? [Buffer.from(route.body ?? "<title>Default title</title>")]);
      res.socket = { remoteAddress: route.remote ?? PUBLIC };
      res.statusCode = route.status ?? 200;
      res.headers = { "content-type": "text/html", ...route.headers };
      const abort = () => {
        const err = Error("synthetic private timeout details");
        res.destroy(err);
        req.emit("error", err);
      };
      options.signal.addEventListener("abort", abort, { once: true });
      res.once("close", () => options.signal.removeEventListener("abort", abort));
      queueMicrotask(() => cb(res));
    };
    return req;
  };
  return { io: { resolve, request, requestTls: request }, calls };
}

const pageAndImage = () =>
  fixture({
    [URL]: { body: html },
    "https://page.example/image.jpg": { body: image, headers: { "content-type": "image/jpeg" } },
  });

test("public metadata and a bounded JPEG produce a self-contained card", async () => {
  const { io, calls } = pageAndImage();
  const result = await safeLinkPreview(`Look: ${URL}`, io);
  assert.equal(result.title, "A & B");
  assert.equal(result.description, "Description");
  assert.equal(result["matched-text"], URL);
  assert.equal(result["canonical-url"], URL);
  const decoded = jpeg.decode(result.jpegThumbnail);
  assert.equal(decoded.width, 2);
  assert.equal(result.originalThumbnailUrl, undefined, "the dependency must not receive an image URL to fetch");
  assert.deepEqual(calls, [URL, "https://page.example/image.jpg"]);
});

test("metadata prefers OG over Twitter over title and ignores active/body content", () => {
  const result = previewMetadata(
    `<!-- <meta property='og:title' content='bad'> --><script>"<meta property='og:title' content='bad'>"</script><style>bad</style><template><meta property='og:title' content='bad'></template><title>Fallback</title><META CONTENT='Twitter' NAME='twitter:title'><meta property=og:title content="Good &#x1f642; &quot;title&quot;"><meta property=og:description content=' x&#10;y '></head><meta property=og:image content='http://127.0.0.1/bad'>`
  );
  assert.deepEqual(result, { title: 'Good 🙂 "title"', description: "x y" });
  assert.equal(previewMetadata("<title>Only title</title>").title, "Only title");
  assert.equal(previewMetadata("<title>İstanbul</title>").title, "İstanbul");
  assert.equal(
    previewMetadata('<script>bad </scriptx><meta property=og:title content="bad"></script><title>Good</title>').title,
    "Good"
  );
  assert.equal(previewMetadata('<meta name="twitter:title" content="Tweet">').title, "Tweet");
  assert.equal(previewMetadata(`<meta property=og:title content="${"x".repeat(1000)}">`).title.length, 200);
  assert.equal(previewMetadata(`<meta property=og:description content="${"x".repeat(1000)}">`).description.length, 500);
  assert.equal(previewMetadata('<meta property="og:title" content="unterminated').title, "");
});

test("only the first explicit URL is attempted, with ordinary surrounding punctuation removed", async () => {
  assert.equal(firstPreviewUrl(`See (${URL}).`), URL);
  assert.equal(firstPreviewUrl("https://page.example/a_(b)"), "https://page.example/a_(b)");
  for (const text of ["plain text", "www.page.example", "file:///private", `https://page.example/${"x".repeat(2048)}`])
    assert.equal(firstPreviewUrl(text), null);
  const { io, calls } = fixture();
  await safeLinkPreview(`${URL} https://other.example/second`, io);
  assert.deepEqual(calls, [URL]);
});

for (const target of [
  "http://127.0.0.1/",
  "http://0x7f000001/",
  "http://169.254.169.254/",
  "http://[::1]/",
  "https://user:secret@page.example/",
]) {
  test(`unsafe page is never requested: ${target}`, async () => {
    const { io, calls } = fixture();
    assert.equal(await safeLinkPreview(target, io), null);
    assert.equal(calls.length, 0);
  });
}

for (const answers of [
  [{ address: "10.0.0.1", family: 4 }],
  [
    { address: PUBLIC, family: 4 },
    { address: "::1", family: 6 },
  ],
]) {
  test(`page DNS rejects all-private or mixed answers (${answers.length})`, async () => {
    const { io, calls } = fixture({}, async () => answers);
    assert.equal(await safeLinkPreview(URL, io), null);
    assert.equal(calls.length, 0);
  });
}

test("a private connected peer is rejected even after a public DNS result", async () => {
  const { io } = fixture({ [URL]: { remote: "127.0.0.1" } });
  assert.equal(await safeLinkPreview(URL, io), null);
});

for (const location of [
  "https://127.0.0.1/",
  "http://page.example/downgrade",
  "file:///private",
  "https://user:secret@page.example/",
]) {
  test(`page redirect is validated before requesting ${location}`, async () => {
    const { io, calls } = fixture({ [URL]: { status: 302, headers: { location } } });
    assert.equal(await safeLinkPreview(URL, io), null);
    assert.deepEqual(calls, [URL]);
  });
}

test("public redirects work and relative images use the final URL, not base or og:url", async () => {
  const target = "https://cdn.example/final/index";
  const { io, calls } = fixture({
    [URL]: { status: 302, headers: { location: target } },
    [target]: {
      body: '<base href="http://127.0.0.1/"><meta property=og:url content="http://127.0.0.1/"><title>Final</title><meta property=og:image content="../image.jpg">',
    },
    "https://cdn.example/image.jpg": { body: image, headers: { "content-type": "image/jpeg" } },
  });
  const result = await safeLinkPreview(URL, io);
  assert.equal(result["canonical-url"], target);
  assert.equal(result["matched-text"], URL);
  assert.ok(result.jpegThumbnail);
  assert.deepEqual(calls, [URL, target, "https://cdn.example/image.jpg"]);
});

test("redirect loops stop after three hops", async () => {
  const { io, calls } = fixture({ [URL]: { status: 302, headers: { location: URL } } });
  assert.equal(await safeLinkPreview(URL, io), null);
  assert.equal(calls.length, 4);
});

for (const target of [
  "https://127.0.0.1/private",
  "http://page.example/downgrade",
  "data:image/jpeg;base64,abc",
  "file:///private",
  "https://user:secret@page.example/",
]) {
  test(`unsafe thumbnail leaves a text card, without requesting ${target}`, async () => {
    const { io, calls } = fixture({
      [URL]: { body: `<title>Safe</title><meta property=og:image content="${target}">` },
    });
    const result = await safeLinkPreview(URL, io);
    assert.equal(result.title, "Safe");
    assert.equal(result.jpegThumbnail, undefined);
    assert.deepEqual(calls, [URL]);
  });
}

test("thumbnail DNS and its redirects get the same validation as the page", async () => {
  const imageUrl = "https://image.example/photo";
  const routes = {
    [URL]: { body: `<title>Safe</title><meta property=og:image content="${imageUrl}">` },
    [imageUrl]: { status: 302, headers: { location: "http://169.254.169.254/private" } },
  };
  const first = fixture(routes);
  assert.equal((await safeLinkPreview(URL, first.io)).jpegThumbnail, undefined);
  assert.deepEqual(first.calls, [URL, imageUrl]);
  const second = fixture(routes, async (host) => [
    { address: host === "image.example" ? "10.0.0.1" : PUBLIC, family: 4 },
  ]);
  assert.equal((await safeLinkPreview(URL, second.io)).jpegThumbnail, undefined);
  assert.deepEqual(second.calls, [URL]);
});

for (const route of [
  { status: 500 },
  { status: 302 },
  { headers: { "content-type": "application/pdf" } },
  { body: "no metadata" },
  { body: "<title>Private page secret</title>", headers: { "content-length": String(1024 * 1024) } },
  { chunks: [Buffer.from("<title>Private page secret</title>"), Buffer.alloc(256 * 1024)] },
]) {
  test(`page failure has a null, silent fallback (${JSON.stringify(route.headers ?? route.status ?? "body")})`, async (t) => {
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    const { io } = fixture({ [URL]: route });
    assert.equal(await safeLinkPreview(URL, io), null);
    assert.deepEqual(logs, []);
  });
}

for (const route of [
  { status: 404 },
  { body: "not a jpeg", headers: { "content-type": "image/jpeg" } },
  { body: "<svg/>", headers: { "content-type": "image/svg+xml" } },
  { body: image, headers: { "content-type": "image/jpeg", "content-length": String(3 * 1024 * 1024) } },
  { chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.from("x")], headers: { "content-type": "image/jpeg" } },
]) {
  test("unavailable, oversized or unsupported thumbnails leave a bounded text card", async () => {
    const { io } = fixture({ [URL]: { body: html }, "https://page.example/image.jpg": route });
    const result = await safeLinkPreview(URL, io);
    assert.equal(result.title, "A & B");
    assert.equal(result.jpegThumbnail, undefined);
  });
}

test("JPEG pixel bombs are rejected before allocating the claimed bitmap", async () => {
  const bomb = Buffer.from(image);
  const sof = bomb.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof >= 0);
  bomb.writeUInt16BE(5000, sof + 5);
  bomb.writeUInt16BE(5000, sof + 7);
  const { io } = fixture({
    [URL]: { body: html },
    "https://page.example/image.jpg": { body: bomb, headers: { "content-type": "image/jpeg" } },
  });
  const result = await safeLinkPreview(URL, io);
  assert.equal(result.title, "A & B");
  assert.equal(result.jpegThumbnail, undefined);
});

test("the page and image share one network deadline", async (t) => {
  const { io, calls } = pageAndImage();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const request = io.requestTls;
  io.requestTls = (url, options, callback) =>
    request(url, options, (response) => {
      now = 4001;
      callback(response);
    });
  const result = await safeLinkPreview(URL, io);
  assert.equal(result.title, "A & B");
  assert.equal(result.jpegThumbnail, undefined);
  assert.deepEqual(calls, [URL], "the image must not receive a fresh four-second budget");
});

test("DNS stalls, HTTP stalls and transport errors fall back without leaking error text", async () => {
  const dns = fixture({}, () => new Promise(() => {}));
  assert.equal(await safeLinkPreview(URL, { ...dns.io, timeoutMs: 10 }), null);
  const http = fixture({ [URL]: { hang: true } });
  assert.equal(await safeLinkPreview(URL, { ...http.io, timeoutMs: 10 }), null);
  const failure = fixture({}, async () => {
    throw Error("private signed URL and credential");
  });
  assert.equal(await safeLinkPreview(URL, failure.io), null);
});

test("concurrency overflow skips the preview and releases slots after failures", async () => {
  const { io } = fixture({}, () => new Promise(() => {}));
  const waiting = Array.from({ length: 4 }, () => safeLinkPreview(URL, { ...io, timeoutMs: 20 }));
  assert.equal(await safeLinkPreview(URL, io), null);
  assert.deepEqual(await Promise.all(waiting), [null, null, null, null]);
  const ready = fixture();
  assert.equal((await safeLinkPreview(URL, ready.io)).title, "Default title");
});
