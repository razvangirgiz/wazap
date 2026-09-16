import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadFile } from "../dist/transcribe/models.js";
import { acquireModelDownloadLock } from "../dist/model-download-lock.js";
import { downloadEmbed } from "../dist/recall/models.js";
import { childEnv, waitFor } from "./helpers.mjs";

const PAYLOAD = Buffer.from("synthetic model coordination ".repeat(16));
const HASH = createHash("sha256").update(PAYLOAD).digest("hex");
const workerFile = fileURLToPath(new URL("./fixtures/model-download-worker.mjs", import.meta.url));
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "wazap-model-lock-"));
  const dir = join(root, "models");
  mkdirSync(dir);
  const children = [];
  t.after(async () => {
    for (const w of children) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
    await Promise.all(children.map((w) => w.closed));
    rmSync(root, { recursive: true, force: true });
  });
  const opts = {
    path: join(dir, "model.bin"),
    bytes: PAYLOAD.length,
    sha256: HASH,
    url: "https://synthetic.invalid/model?private=not-a-real-token",
  };
  return { root, dir, opts, children, lock: `${opts.path}.download-lock`, part: `${opts.path}.part` };
}
function worker(box, mode = "full", changes = {}) {
  const child = fork(workerFile, [JSON.stringify({ opts: { ...box.opts, ...changes }, payload: [...PAYLOAD], mode })], {
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("message", (m) => messages.push(m));
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const result = async () => {
    await waitFor(
      () => messages.some((m) => m.kind === "result") || child.exitCode !== null || child.signalCode !== null,
      10000,
      "download worker result"
    );
    const message = messages.find((m) => m.kind === "result");
    assert.ok(message, `worker exited without a result: ${stderr}`);
    await closed;
    return message;
  };
  const instance = { child, messages, closed, result };
  box.children.push(instance);
  return instance;
}
async function held(box) {
  const w = worker(box, "hold");
  await waitFor(() => existsSync(box.part) && statSync(box.part).size >= 32, 10000, "held partial model");
  return w;
}
function busy(result) {
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRANSCRIBE_FAILED");
  assert.match(result.message, /lock|another.*download/i);
  assert.ok(!JSON.stringify(result).includes("not-a-real-token"));
}

test("separate processes refuse the same destination before HTTP or partial-file mutation", async (t) => {
  const box = sandbox(t);
  const owner = await held(box);
  const prefix = readFileSync(box.part);
  const contenders = [worker(box, "fail"), worker(box, "fail"), worker(box, "fail")];
  for (const w of contenders) {
    busy(await w.result());
    assert.equal(w.messages.filter((m) => m.kind === "fetch").length, 0);
  }
  assert.deepEqual(readFileSync(box.part), prefix);
  assert.equal(existsSync(box.lock), true);
  owner.child.send("finish");
  assert.equal((await owner.result()).ok, true);
  assert.deepEqual(readFileSync(box.opts.path), PAYLOAD);
  assert.equal(existsSync(box.lock), false);
  const cached = worker(box);
  assert.equal((await cached.result()).result.alreadyPresent, true);
  assert.equal(cached.messages.filter((m) => m.kind === "fetch").length, 0);
  assert.equal(existsSync(box.lock), false);
});

test("relative and symlinked directory aliases share the same lock", async (t) => {
  const box = sandbox(t);
  const alias = join(box.root, "alias");
  symlinkSync(box.dir, alias, process.platform === "win32" ? "junction" : "dir");
  const owner = await held(box);
  for (const path of [relative(process.cwd(), box.opts.path), join(alias, "model.bin")]) {
    const contender = worker(box, "fail", { path });
    busy(await contender.result());
    assert.equal(contender.messages.filter((m) => m.kind === "fetch").length, 0);
  }
  owner.child.send("finish");
  assert.equal((await owner.result()).ok, true);
});

test("different destinations download concurrently, not under a global model-directory lock", async (t) => {
  const box = sandbox(t);
  const owner = await held(box);
  const otherPath = join(box.dir, "other.bin");
  const other = worker(box, "hold", { path: otherPath });
  await waitFor(
    () => existsSync(`${otherPath}.part`) && statSync(`${otherPath}.part`).size >= 32,
    10000,
    "second model prefix"
  );
  owner.child.send("finish");
  other.child.send("finish");
  assert.equal((await owner.result()).ok, true);
  assert.equal((await other.result()).ok, true);
  assert.deepEqual(readFileSync(otherPath), PAYLOAD);
});

test("a live lock never expires just because its timestamp is old", async (t) => {
  const box = sandbox(t);
  const owner = await held(box);
  assert.equal(existsSync(box.lock), true);
  utimesSync(box.lock, new Date(0), new Date(0));
  const contender = worker(box, "fail");
  busy(await contender.result());
  assert.equal(contender.messages.filter((m) => m.kind === "fetch").length, 0);
  owner.child.send("finish");
  assert.equal((await owner.result()).ok, true);
});

test("caller cancellation releases ownership and permits a resumed retry", async (t) => {
  const box = sandbox(t);
  const owner = await held(box);
  owner.child.send("abort");
  assert.equal((await owner.result()).ok, false);
  assert.equal(existsSync(box.lock), false);
  const retry = worker(box);
  const result = await retry.result();
  assert.equal(result.ok, true);
  assert.equal(result.result.resumed, true);
  assert.deepEqual(readFileSync(box.opts.path), PAYLOAD);
});

test("a killed owner's lock is recovered once, even with multiple simultaneous contenders", async (t) => {
  const box = sandbox(t);
  const dead = await held(box);
  assert.equal(existsSync(box.lock), true);
  dead.child.kill("SIGKILL");
  await dead.closed;
  const contenders = Array.from({ length: 4 }, () => worker(box, "hold"));
  await waitFor(() => contenders.some((w) => w.messages.some((m) => m.kind === "fetch")), 10000, "stale lock recovery");
  const winner = contenders.find((w) => w.messages.some((m) => m.kind === "fetch"));
  for (const w of contenders.filter((w) => w !== winner)) {
    busy(await w.result());
    assert.equal(w.messages.filter((m) => m.kind === "fetch").length, 0);
  }
  winner.child.send("finish");
  const result = await winner.result();
  assert.equal(result.ok, true);
  assert.equal(result.result.resumed, true);
  assert.deepEqual(readFileSync(box.opts.path), PAYLOAD);
  assert.equal(existsSync(box.lock), false);
});

test("owner records contain no request secrets and use private permissions", async (t) => {
  const box = sandbox(t);
  const lease = await acquireModelDownloadLock(box.opts.path);
  const names = readdirSync(box.lock);
  assert.equal(names.length, 1);
  const file = join(box.lock, names[0]);
  const text = readFileSync(file, "utf8");
  const owner = JSON.parse(text);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.version, 1);
  assert.ok(!text.includes("synthetic.invalid") && !text.includes("not-a-real-token"));
  if (process.platform !== "win32") {
    assert.equal(statSync(box.lock).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  await Promise.all([lease.release(), lease.release()]);
  const next = await acquireModelDownloadLock(box.opts.path);
  await lease.release();
  assert.equal(existsSync(box.lock), true, "repeated release cannot remove the successor");
  await next.release();
});

test("cleanup of a replaced lock never removes another owner's files", async (t) => {
  const box = sandbox(t);
  const lease = await acquireModelDownloadLock(box.opts.path);
  rmSync(box.lock, { recursive: true });
  mkdirSync(box.lock);
  writeFileSync(join(box.lock, "foreign-owner"), "untouched");
  await assert.rejects(lease.release(), { code: "TRANSCRIBE_FAILED" });
  assert.equal(readFileSync(join(box.lock, "foreign-owner"), "utf8"), "untouched");
});

for (const code of ["EPERM", "EIO"]) {
  test(`an inconclusive PID probe (${code}) cannot justify reclaiming a lock`, async (t) => {
    const box = sandbox(t);
    const lease = await acquireModelDownloadLock(box.opts.path);
    t.mock.method(process, "kill", () => {
      throw Object.assign(Error("unavailable"), { code });
    });
    await assert.rejects(acquireModelDownloadLock(box.opts.path), { code: "TRANSCRIBE_FAILED" });
    assert.equal(existsSync(box.lock), true);
    await lease.release();
  });
}

test("a regular file at the lock path is not overwritten or deleted", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.lock, "opaque fixture");
  await assert.rejects(downloadFile(box.opts), { code: "TRANSCRIBE_FAILED" });
  assert.equal(readFileSync(box.lock, "utf8"), "opaque fixture");
});

test("a symlink at the lock path is not followed for stale-owner cleanup", async (t) => {
  const box = sandbox(t);
  const other = await acquireModelDownloadLock(join(box.dir, "other.bin"));
  const otherDir = `${other.path}.download-lock`;
  const before = readdirSync(otherDir);
  symlinkSync(otherDir, box.lock, process.platform === "win32" ? "junction" : "dir");
  t.mock.method(process, "kill", () => {
    throw Object.assign(Error("gone"), { code: "ESRCH" });
  });
  await assert.rejects(downloadFile(box.opts), { code: "TRANSCRIBE_FAILED" });
  assert.deepEqual(readdirSync(otherDir), before, "do not unlink another directory's ownership record");
  await other.release();
});

test("embedding contention keeps the lock recovery guidance with its own error code", async (t) => {
  const box = sandbox(t);
  const owner = await held(box);
  t.mock.method(globalThis, "fetch", async () => assert.fail("contender must not fetch"));
  await assert.rejects(
    downloadEmbed(box.dir, { file: "model.bin", bytes: box.opts.bytes, sha256: HASH, url: box.opts.url }),
    (err) => {
      assert.equal(err.code, "RECALL_FAILED");
      assert.match(err.fix, /only after confirming no downloader/);
      return true;
    }
  );
  owner.child.send("finish");
  assert.equal((await owner.result()).ok, true);
});

for (const shape of ["empty", "unknown-file", "malformed", "foreign-scope", "null-scope"]) {
  test(`ambiguous ${shape} locks fail closed, including on cached model hits`, async (t) => {
    const box = sandbox(t);
    writeFileSync(box.opts.path, PAYLOAD);
    mkdirSync(box.lock);
    if (shape === "unknown-file") writeFileSync(join(box.lock, "unrecognized"), "leave intact");
    if (shape === "malformed")
      writeFileSync(join(box.lock, "owner-00000000-0000-0000-0000-000000000000.json"), "{not json");
    if (shape === "foreign-scope" || shape === "null-scope")
      writeFileSync(
        join(box.lock, "owner-00000000-0000-0000-0000-000000000000.json"),
        JSON.stringify({ version: 1, pid: 2147483647, scope: shape === "null-scope" ? null : "another host/namespace" })
      );
    const before = readdirSync(box.lock);
    t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
    await assert.rejects(downloadFile(box.opts), (err) => {
      busy({ ok: false, code: err.code, message: err.message, fix: err.fix });
      return true;
    });
    assert.deepEqual(readdirSync(box.lock), before);
    assert.deepEqual(readFileSync(box.opts.path), PAYLOAD);
  });
}

test("same-process concurrent invocations do not treat their shared PID as shared ownership", async (t) => {
  const box = sandbox(t);
  const finish = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(PAYLOAD.subarray(0, 32));
          finish.push(() => {
            c.enqueue(PAYLOAD.subarray(32));
            c.close();
          });
        },
      })
    );
  });
  const first = downloadFile(box.opts);
  // Always settle the owner even if a pre-fix assertion fails.
  try {
    await waitFor(() => existsSync(box.part) && statSync(box.part).size === 32, 3000, "same-process owner prefix");
    await assert.rejects(downloadFile({ ...box.opts, signal: AbortSignal.timeout(200) }), {
      code: "TRANSCRIBE_FAILED",
    });
    assert.equal(calls, 1);
  } finally {
    try {
      finish[0]?.();
    } finally {
      await first.catch(() => {});
    }
  }
});
