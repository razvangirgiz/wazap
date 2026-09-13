import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { loadMedia } from "../dist/outgoing-media.js";
import { publicAddress, publicMedia } from "../dist/safe-media.js";

const PRIVATE_V4 = [
  "0.0.0.0",
  "10.0.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.1",
  "192.0.2.1",
  "192.168.1.1",
  "100.64.0.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
];

const PRIVATE_V6 = ["::1", "fe80::1", "fd00::1", "2001:db8::1", "2002::1"];
const PUBLIC = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"];

for (const address of PRIVATE_V4) {
  test(`publicAddress refuses ${address}`, () => {
    assert.equal(publicAddress(address), false);
  });
}
for (const address of PRIVATE_V6) {
  test(`publicAddress refuses ${address}`, () => {
    assert.equal(publicAddress(address), false);
  });
}
for (const address of PUBLIC) {
  test(`publicAddress allows ${address}`, () => {
    assert.equal(publicAddress(address), true);
  });
}
test("publicAddress refuses something that is not an IP at all", () => {
  assert.equal(publicAddress("metadata.google.internal"), false);
});

/** An http(s).request stand-in: records the URL, answers with a Readable shaped like IncomingMessage. */
function fakeHttp({ status = 200, headers = {}, body = "", remote = "93.184.216.34" } = {}) {
  const calls = [];
  const request = (url, _options, cb) => {
    const res = Readable.from(body === "" ? [] : [Buffer.from(body)]);
    res.statusCode = status;
    res.headers = headers;
    res.socket = { remoteAddress: remote };
    calls.push(String(url));
    queueMicrotask(() => cb(res));
    return {
      on() {
        return this;
      },
      end() {},
    };
  };
  return { request, requestTls: request, calls };
}

const resolving = (addresses) => async () => addresses;
const publicDns = resolving([{ address: "93.184.216.34", family: 4 }]);

test("loadMedia refuses the cloud metadata address before any packet leaves", async () => {
  await assert.rejects(loadMedia({ url: "http://169.254.169.254/latest/meta-data/" }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("loadMedia refuses a loopback URL", async () => {
  await assert.rejects(loadMedia({ url: "http://127.0.0.1:8766/healthz" }), { code: "MEDIA_ACCESS_DENIED" });
});

test("loadMedia refuses a non-http(s) scheme", async () => {
  await assert.rejects(loadMedia({ url: "file:///etc/passwd" }), { code: "MEDIA_ACCESS_DENIED" });
});

test("loadMedia refuses a URL with credentials in it", async () => {
  await assert.rejects(loadMedia({ url: "http://user:secret@93.184.216.34/x" }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("a hostname that resolves to a private address is refused (DNS rebinding)", async () => {
  const http = fakeHttp();
  await assert.rejects(
    publicMedia("http://attacker.example/pic.jpg", { ...http, resolve: resolving([{ address: "10.1.2.3", family: 4 }]) }),
    { code: "MEDIA_ACCESS_DENIED" }
  );
  assert.equal(http.calls.length, 0, "nothing was fetched once the answer was private");
});

test("a public URL that redirects to a private one is refused on the second hop", async () => {
  const http = fakeHttp({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  await assert.rejects(publicMedia("http://example.com/redirect", { ...http, resolve: publicDns }), {
    code: "MEDIA_ACCESS_DENIED",
  });
  assert.equal(http.calls.length, 1, "the redirect target is never requested");
});

test("a response that arrives from a private address is refused even when DNS looked clean", async () => {
  const http = fakeHttp({ remote: "10.0.0.1" });
  await assert.rejects(publicMedia("http://example.com/x", { ...http, resolve: publicDns }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("a hostname resolving to a public address fetches and reports the real URL", async () => {
  const http = fakeHttp({ body: "payload", headers: { "content-type": "image/png; charset=binary" } });
  const media = await publicMedia("http://example.com/pic", { ...http, resolve: publicDns });
  assert.equal(media.buffer.toString(), "payload");
  assert.equal(media.mime, "image/png");
  assert.equal(media.url, "http://example.com/pic");
});

test("a redirect to another public URL is followed and the final URL is reported", async () => {
  const first = fakeHttp({ status: 302, headers: { location: "https://cdn.example/final.jpg" } });
  const second = fakeHttp({ body: "img" });
  let hop = 0;
  const request = (url, options, cb) => (hop++ === 0 ? first : second).request(url, options, cb);
  const media = await publicMedia("http://example.com/start", {
    request,
    requestTls: request,
    resolve: publicDns,
  });
  assert.equal(media.buffer.toString(), "img");
  assert.equal(media.url, "https://cdn.example/final.jpg");
});

test("a content-length over the cap fails before the body is read", async () => {
  const http = fakeHttp({ headers: { "content-length": String(200 * 1024 * 1024) } });
  await assert.rejects(publicMedia("http://example.com/big", { ...http, resolve: publicDns }), {
    code: "FILE_TOO_LARGE",
  });
});
