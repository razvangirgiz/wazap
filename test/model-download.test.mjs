import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { downloadFile } from "../dist/transcribe/models.js";
import { downloadEmbed } from "../dist/recall/models.js";
import { childEnv, waitFor } from "./helpers.mjs";

const PAYLOAD = Buffer.from("synthetic model ".repeat(8));
const HASH = createHash("sha256").update(PAYLOAD).digest("hex");
const PRIVATE = "synthetic-private-url-token";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-download-security-"));
  t.after(() => {
    try {
      assert.equal(
        existsSync(join(dir, "model.bin.download-lock")),
        false,
        "every completed/failed invocation releases its claim"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const path = join(dir, "model.bin");
  return {
    dir,
    path,
    part: `${path}.part`,
    opts: { path, url: "https://model.example/fixture", bytes: PAYLOAD.length, sha256: HASH },
  };
}
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}/model`;
}
function streamed({ status = 200, statusText, headers = {}, count = 40, chunk = Buffer.alloc(16) } = {}) {
  let reads = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        reads++;
        c.enqueue(chunk);
        if (reads === count) c.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status, statusText, headers }
  );
  return { response, reads: () => reads, cancelled: () => cancelled };
}
const failed = (err) => {
  assert.equal(err.code, "TRANSCRIBE_FAILED");
  assert.ok(!err.message.includes(PRIVATE));
  return true;
};

for (const resume of [false, true]) {
  test(`model streams stop at the known size before excess bytes reach disk (resume=${resume})`, async (t) => {
    const { opts, path, part } = setup(t);
    const have = resume ? 16 : 0;
    if (resume) writeFileSync(part, PAYLOAD.subarray(0, have));
    const stream = streamed({
      status: resume ? 206 : 200,
      headers: resume ? { "content-range": `bytes ${have}-${PAYLOAD.length - 1}/${PAYLOAD.length}` } : {},
    });
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.headers.Range, resume ? `bytes=${have}-` : undefined);
      return stream.response;
    });
    const progress = [];
    await assert.rejects(downloadFile({ ...opts, onProgress: (p) => progress.push(p.received) }), failed);
    assert.ok(stream.reads() < 40, "do not drain an oversized stream before rejecting it");
    assert.equal(stream.cancelled(), true);
    assert.ok(progress.every((n) => n <= PAYLOAD.length));
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(part), false);
  });
}

test("oversized Content-Length is rejected without consuming the body", async (t) => {
  const { opts, path } = setup(t);
  const stream = streamed({ headers: { "content-length": String(PAYLOAD.length + 1) } });
  t.mock.method(globalThis, "fetch", async () => stream.response);
  await assert.rejects(downloadFile(opts), failed);
  assert.ok(stream.reads() <= 1);
  assert.equal(stream.cancelled(), true);
  assert.equal(existsSync(path), false);
});

for (const range of [
  `bytes 16-${PAYLOAD.length - 1}/${PAYLOAD.length + 1}`,
  `bytes 16-${PAYLOAD.length}/${PAYLOAD.length}`,
  `bytes 16-${PAYLOAD.length - 1}/${PAYLOAD.length} ${PRIVATE}`,
  "missing",
]) {
  test(`invalid Content-Range is refused without quoting it (${range.split(" ")[0]})`, async (t) => {
    const { opts, part } = setup(t);
    writeFileSync(part, PAYLOAD.subarray(0, 16));
    const stream = streamed({
      status: 206,
      headers: { "content-range": range },
      count: 1,
      chunk: PAYLOAD.subarray(16),
    });
    t.mock.method(globalThis, "fetch", async () => stream.response);
    await assert.rejects(downloadFile(opts), failed);
    assert.equal(stream.cancelled(), true);
    assert.equal(existsSync(part), false);
  });
}

for (const status of [201, 503, 416]) {
  test(`unused HTTP ${status} response is cancelled and reason text is not exposed`, async (t) => {
    const { opts, part } = setup(t);
    writeFileSync(part, PAYLOAD.subarray(0, 16));
    const stream = streamed({ status, statusText: PRIVATE });
    t.mock.method(globalThis, "fetch", async () => stream.response);
    await assert.rejects(downloadFile(opts), failed);
    assert.equal(stream.cancelled(), true);
    if (status === 503) assert.deepEqual(readFileSync(part), PAYLOAD.subarray(0, 16));
    if (status === 416) assert.equal(existsSync(part), false);
  });
}

test("transport exceptions do not expose signed URL details", async (t) => {
  const { opts } = setup(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error(`https://model.example/${PRIVATE}`);
  });
  await assert.rejects(downloadFile(opts), failed);
});

test("a pre-aborted call preserves even an existing invalid file and makes no request", async (t) => {
  const { opts, path } = setup(t);
  writeFileSync(path, "old fixture");
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  await assert.rejects(downloadFile({ ...opts, signal: AbortSignal.abort(Error(PRIVATE)) }), failed);
  assert.equal(readFileSync(path, "utf8"), "old fixture");
});

for (const phase of ["headers", "body", "active transfer"]) {
  test(`model download timeout covers ${phase}`, async (t) => {
    const { opts, path } = setup(t);
    const timers = [];
    t.after(() => timers.forEach(clearInterval));
    const url = await listen(t, (_req, res) => {
      if (phase === "headers") return;
      res.writeHead(200);
      res.flushHeaders();
      if (phase === "active transfer") {
        const timer = setInterval(() => res.write(PAYLOAD.subarray(0, 1)), 20);
        timers.push(timer);
        res.on("close", () => clearInterval(timer));
      }
    });
    // Watchdog makes the pre-fix reproducer terminate too, rather than hanging.
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(Error(PRIVATE)), 800);
    t.after(() => clearTimeout(watchdog));
    await assert.rejects(
      downloadFile({
        ...opts,
        url,
        signal: controller.signal,
        timeoutMs: phase === "active transfer" ? 150 : 2000,
        idleTimeoutMs: phase === "active transfer" ? 2000 : 100,
      }),
      (err) => {
        failed(err);
        assert.match(err.message, /timed out/i);
        return true;
      }
    );
    assert.equal(existsSync(path), false);
  });
}

test("an interrupted transfer retains a bounded prefix that a later invocation can resume", async (t) => {
  const { opts, path, part } = setup(t);
  let requests = 0;
  let resumedRange;
  const url = await listen(t, (req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(200);
      res.write(PAYLOAD.subarray(0, 32));
      return;
    }
    resumedRange = req.headers.range;
    res.writeHead(206, { "content-range": `bytes 32-${PAYLOAD.length - 1}/${PAYLOAD.length}` });
    res.end(PAYLOAD.subarray(32));
  });
  const controller = new AbortController();
  const pending = downloadFile({ ...opts, url, signal: controller.signal });
  const rejected = assert.rejects(pending, failed);
  await waitFor(() => existsSync(part) && statSync(part).size === 32, 3000, "partial model bytes");
  controller.abort(Error(PRIVATE));
  await rejected;
  assert.deepEqual(readFileSync(part), PAYLOAD.subarray(0, 32));
  const result = await downloadFile({ ...opts, url });
  assert.equal(result.resumed, true);
  assert.equal(resumedRange, "bytes=32-");
  assert.deepEqual(readFileSync(path), PAYLOAD);
  assert.equal(existsSync(part), false);
});

for (const code of ["ENOSPC", "EACCES"]) {
  test(`write ${code} under backpressure is caught, closes the source and never publishes`, async (t) => {
    const { opts } = setup(t);
    const script = `
      import fs from 'node:fs';
      import { Writable } from 'node:stream';
      import { syncBuiltinESMExports } from 'node:module';
      let cancelled = false;
      fs.createWriteStream = () => new Writable({ highWaterMark: 1, write(_chunk, _encoding, cb) { setImmediate(() => cb(Object.assign(Error('${PRIVATE}'), { code: '${code}' }))); } });
      syncBuiltinESMExports();
      globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }));
      const { downloadFile } = await import('./dist/transcribe/models.js');
      try { await downloadFile(${JSON.stringify(opts)}); process.exitCode = 2; }
      catch (err) { process.stdout.write(JSON.stringify({ code: err.code, message: err.message, cancelled, installed: fs.existsSync(${JSON.stringify(opts.path)}) })); }
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 5000,
      env: childEnv(),
    });
    const result = JSON.parse(stdout);
    assert.equal(result.code, "TRANSCRIBE_FAILED");
    assert.equal(result.cancelled, true);
    assert.equal(result.installed, false);
    assert.ok(!`${stdout}${stderr}`.includes(PRIVATE));
  });
}

test("curated-model CDN redirects still work with identity encoding and verification", async (t) => {
  const { opts, path } = setup(t);
  let encoding;
  const target = await listen(t, (req, res) => {
    encoding = req.headers["accept-encoding"];
    res.end(PAYLOAD);
  });
  const source = await listen(t, (_req, res) => {
    res.writeHead(302, { location: target });
    res.end();
  });
  await downloadFile({ ...opts, url: source });
  assert.equal(encoding, "identity");
  assert.deepEqual(readFileSync(path), PAYLOAD);
});

for (const changes of [
  { bytes: 0 },
  { bytes: -1 },
  { bytes: Infinity },
  { bytes: 1.5 },
  { sha256: PRIVATE },
  { timeoutMs: 0 },
  { idleTimeoutMs: NaN },
  { timeoutMs: 2 ** 31 },
]) {
  test(`invalid downloader options fail before touching disk (${JSON.stringify(changes)})`, async (t) => {
    const { opts, path } = setup(t);
    writeFileSync(path, "keep this fixture");
    t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
    await assert.rejects(downloadFile({ ...opts, ...changes }), failed);
    assert.equal(readFileSync(path, "utf8"), "keep this fixture");
  });
}

test("an unsolicited 206 must describe the complete requested model", async (t) => {
  const { opts, path } = setup(t);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(PAYLOAD, {
        status: 206,
        headers: { "content-range": `bytes 16-${PAYLOAD.length - 1}/${PAYLOAD.length}` },
      })
  );
  await assert.rejects(downloadFile(opts), failed);
  assert.equal(existsSync(path), false);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(PAYLOAD, {
        status: 206,
        headers: { "content-range": `bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}` },
      })
  );
  await downloadFile(opts);
  assert.deepEqual(readFileSync(path), PAYLOAD);
});

test("a dishonest small Content-Length does not replace actual byte counting", async (t) => {
  const { opts } = setup(t);
  const stream = streamed({ headers: { "content-length": "1" } });
  t.mock.method(globalThis, "fetch", async () => stream.response);
  await assert.rejects(downloadFile(opts), failed);
  assert.equal(stream.cancelled(), true);
  assert.ok(stream.reads() < 40);
});

test("compressed responses are rejected and cancelled before file writing", async (t) => {
  const { opts, part } = setup(t);
  const stream = streamed({ headers: { "content-encoding": "gzip" } });
  t.mock.method(globalThis, "fetch", async () => stream.response);
  await assert.rejects(downloadFile(opts), failed);
  assert.equal(stream.cancelled(), true);
  assert.equal(existsSync(part), false);
});

test("clean EOF before the expected size never publishes and discards the partial file", async (t) => {
  const { opts, path, part } = setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(PAYLOAD.subarray(0, 8)));
  await assert.rejects(downloadFile(opts), failed);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(part), false);
});

test("progress callback errors cancel the response without exposing arbitrary callback text", async (t) => {
  const { opts } = setup(t);
  const stream = streamed();
  t.mock.method(globalThis, "fetch", async () => stream.response);
  await assert.rejects(
    downloadFile({
      ...opts,
      onProgress() {
        throw Error(PRIVATE);
      },
    }),
    failed
  );
  assert.equal(stream.cancelled(), true);
});

test("a final write error cannot be swallowed after the complete digest has been computed", async (t) => {
  const { opts, path, part } = setup(t);
  const script = `
    import fs from 'node:fs';
    import { Writable } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    const bytes = Buffer.from(${JSON.stringify([...PAYLOAD])});
    fs.createWriteStream = () => {
      fs.writeFileSync(${JSON.stringify(part)}, bytes);
      return new Writable({ write(_c, _e, cb) { cb(); }, final(cb) { cb(Object.assign(Error('${PRIVATE}'), { code: 'EIO' })); } });
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => new Response(bytes);
    const { downloadFile } = await import('./dist/transcribe/models.js');
    try { await downloadFile(${JSON.stringify(opts)}); process.exitCode = 2; }
    catch (err) { process.stdout.write(JSON.stringify({ code: err.code, message: err.message })); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 5000,
    env: childEnv(),
  });
  assert.equal(JSON.parse(stdout).code, "TRANSCRIBE_FAILED");
  assert.equal(existsSync(path), false);
  assert.ok(!`${stdout}${stderr}`.includes(PRIVATE));
});

test("embedding downloads share the byte cap and retain their own error code/fix", async (t) => {
  const { dir } = setup(t);
  const stream = streamed();
  t.mock.method(globalThis, "fetch", async () => stream.response);
  await assert.rejects(
    downloadEmbed(dir, {
      file: "embedding.gguf",
      bytes: PAYLOAD.length,
      sha256: HASH,
      url: "https://model.example/embedding",
    }),
    (err) => {
      assert.equal(err.code, "RECALL_FAILED");
      assert.match(err.fix, /wazap embed download/);
      return true;
    }
  );
  assert.equal(stream.cancelled(), true);
  assert.ok(stream.reads() < 40);
});
