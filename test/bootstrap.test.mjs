/**
 * The first-run path: the pinned llama.cpp build and its installer, what
 * `embed download` says when llama-server is still missing, the demo seed and
 * its refusals, the shell's `search` and `embed index`, and the bootstrap
 * script itself with --offline-stub — none of it reaches the network: the
 * "release" is a tarball served from loopback, embeddings come from the
 * evaluation's stub, and the demo never opens a socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installLlamaPrebuilt, ensureLlama } from "../dist/deps.js";
import { llamaReport } from "../dist/cli.js";
import { DEMO_MARKER, demoAnchor, demoRefusal, seedRecords, loadWorld, DEFAULT_FIXTURE, parseAt } from "../dist/demo.js";
import { LLAMA_PIN, llamaAssetFor, llamaBuildOf, llamaInstallFix, GEMMA_MIN_LLAMA_BUILD } from "../dist/recall/index.js";
import { startEmbedStub } from "../scripts/eval/embed-stub.mjs";
import { BINARY, childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

/** Runs the built binary; resolves with its exit code and both streams, whatever the code. */
async function wazap(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BINARY, ...args], { env: childEnv(env), timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// The pin table ---------------------------------------------------------------

test("the llama.cpp pin covers Linux x64, Linux arm64 and Apple Silicon, each by tag, size and sha256", () => {
  assert.match(LLAMA_PIN.tag, /^b\d+$/);
  assert.equal(LLAMA_PIN.build, Number(LLAMA_PIN.tag.slice(1)));
  assert.ok(LLAMA_PIN.build >= GEMMA_MIN_LLAMA_BUILD, "the pinned build must run embeddinggemma");
  for (const key of ["linux-x64", "linux-arm64", "darwin-arm64"]) {
    const asset = LLAMA_PIN.assets[key];
    assert.ok(asset, `no pinned build for ${key}`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.bytes > 1_000_000);
    assert.equal(asset.url, `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_PIN.tag}/${asset.file}`);
    assert.ok(asset.file.startsWith(`${LLAMA_PIN.root}-bin-`));
  }
  assert.equal(llamaAssetFor("linux", "x64"), LLAMA_PIN.assets["linux-x64"]);
  assert.equal(llamaAssetFor("win32", "x64"), null);
  assert.equal(llamaAssetFor("darwin", "x64"), null, "no Intel Mac build is pinned");
});

test("the Dockerfile's WITH_RECALL build pins the same llama.cpp release, by the same digests", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, new RegExp(`ARG LLAMA_TAG=${LLAMA_PIN.tag}\\b`));
  assert.match(dockerfile, /^ARG WITH_RECALL=0$/m, "recall stays opt-in for the image");
  for (const [arch, key] of [["ubuntu-x64", "linux-x64"], ["ubuntu-arm64", "linux-arm64"]]) {
    assert.match(dockerfile, new RegExp(`name=${arch};\\s+sum=${LLAMA_PIN.assets[key].sha256}`));
  }
  assert.match(dockerfile, /sha256sum -c -/);
});

test("the build number is read from both --version spellings", () => {
  assert.equal(llamaBuildOf("version: 0.6.0-dev (build 11516, commit d4d82d67f)\nbuilt with GNU 11.4.0"), 11516);
  assert.equal(llamaBuildOf("version: 6800 (abc1234)\nbuilt with clang"), 6800);
  assert.equal(llamaBuildOf("llama-server, no idea"), null);
});

test("the install fix names what works on each platform", () => {
  assert.match(llamaInstallFix("linux", "x64"), /wazap embed download --yes/);
  assert.match(llamaInstallFix("darwin", "arm64"), /brew install llama\.cpp/);
  assert.match(llamaInstallFix("linux", "riscv64"), /WAZAP_EMBED_BIN/);
});

// The installer, against a release served from loopback ----------------------------

/** A tarball shaped like a llama.cpp release whose llama-server answers --version. */
function fakeRelease(build = 9999) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-llama-release-"));
  const top = join(dir, "llama-bX");
  mkdirSync(top);
  writeFileSync(join(top, "llama-server"), `#!/bin/sh\necho "version: 0.6.0-dev (build ${build}, commit fake)" >&2\n`, { mode: 0o755 });
  const tarball = join(dir, "release.tar.gz");
  const made = spawnSync("tar", ["-czf", tarball, "-C", dir, "llama-bX"]);
  assert.equal(made.status, 0, "tar is needed for this test");
  const bytes = readFileSync(tarball);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function serve(bytes) {
  const server = createServer((_req, res) => res.writeHead(200, { "content-length": bytes.length }).end(bytes));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/llama.tar.gz`, close: () => new Promise((done) => server.close(done)) };
}

test("the pinned build is fetched, verified, unpacked, run once and written into the data dir's .env", { skip: !posix }, async () => {
  const release = fakeRelease();
  const server = await serve(release.bytes);
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-llama-"));
  const before = process.env.WAZAP_EMBED_BIN;
  try {
    const bin = await installLlamaPrebuilt(dataDir, { file: "llama.tar.gz", url: server.url, bytes: release.bytes.length, sha256: release.sha256 }, "llama-bX");
    assert.equal(bin, join(dataDir, "bin", "llama", "llama-bX", "llama-server"));
    assert.match(readFileSync(join(dataDir, ".env"), "utf8"), new RegExp(`^WAZAP_EMBED_BIN=${bin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
    assert.equal(existsSync(join(dataDir, "bin", "llama", "llama.tar.gz")), false, "the verified archive is not kept twice");
  } finally {
    if (before === undefined) delete process.env.WAZAP_EMBED_BIN;
    else process.env.WAZAP_EMBED_BIN = before;
    await server.close();
  }
});

test("a release whose sha256 does not match is refused and nothing is written", { skip: !posix }, async () => {
  const release = fakeRelease();
  const server = await serve(release.bytes);
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-llama-"));
  try {
    await assert.rejects(
      installLlamaPrebuilt(dataDir, { file: "llama.tar.gz", url: server.url, bytes: release.bytes.length, sha256: "0".repeat(64) }, "llama-bX"),
      (err) => err.code === "RECALL_FAILED"
    );
    assert.equal(existsSync(join(dataDir, ".env")), false);
    assert.equal(existsSync(join(dataDir, "bin", "llama", "llama-bX")), false);
  } finally {
    await server.close();
  }
});

test("without --yes and without a terminal, ensureLlama downloads nothing and says missing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-llama-"));
  const path = process.env.PATH;
  const tty = process.stdin.isTTY;
  const bin = process.env.WAZAP_EMBED_BIN;
  process.env.PATH = mkdtempSync(join(tmpdir(), "wazap-empty-path-"));
  delete process.env.WAZAP_EMBED_BIN;
  process.stdin.isTTY = false;
  try {
    // The URL is never fetched: a fetch would fail the test on its own.
    const asset = { file: "x.tar.gz", url: "http://127.0.0.1:9/never", bytes: 1, sha256: "0".repeat(64) };
    const outcome = await ensureLlama({ dataDir, assumeYes: false, noBrew: true }, { onPath: () => false }, asset);
    assert.deepEqual(outcome, { bin: null, how: "missing" });
  } finally {
    process.env.PATH = path;
    process.stdin.isTTY = tty;
    if (bin !== undefined) process.env.WAZAP_EMBED_BIN = bin;
  }
});

test("embed download reports a missing llama-server as a problem with its fix, and an old one as too old for gemma", () => {
  const missing = llamaReport(null, "embeddinggemma-300m");
  assert.equal(missing.found, false);
  assert.match(missing.problem, /llama-server is still missing/);
  assert.ok(missing.fix);

  const old = llamaReport("/opt/llama-server", "embeddinggemma-300m", false, 5000);
  assert.match(old.problem, /build 5000 is too old for embeddinggemma/);
  assert.match(old.fix, /e5-base-multilingual/);

  assert.equal(llamaReport("/opt/llama-server", "e5-base-multilingual", false, 5000).problem, null, "e5 runs on an old build");
  assert.equal(llamaReport("/opt/llama-server", "embeddinggemma-300m", false, 11516).problem, null);
  assert.equal(llamaReport("/opt/llama-server", "embeddinggemma-300m", false, null).problem, null, "an unknown build is not refused");
  assert.equal(llamaReport(null, "embeddinggemma-300m", true).problem, null, "an external embedding server needs no binary");
});

// The demo seed -------------------------------------------------------------------

test("the demo world ships with the package and resolves every message", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("eval/fixtures/world.json"), "npx users get the demo world too");
  assert.equal(DEFAULT_FIXTURE, join(root, "eval", "fixtures", "world.json"));
  const world = loadWorld(DEFAULT_FIXTURE);
  // A morning run anchors on yesterday's 15:30, an evening one on today's.
  for (const now of [new Date(2026, 9, 9, 9, 0).getTime(), new Date(2026, 9, 9, 20, 0).getTime()]) {
    const anchor = demoAnchor(now);
    assert.ok(anchor <= now && now - anchor < 86_400_000);
    for (const account of world.accounts) {
      for (const m of seedRecords(account, anchor).messages) assert.ok(Number(m.messageTimestamp) * 1000 <= now, "nothing is dated in the future");
    }
  }
  const anchor = demoAnchor(Date.parse("2026-10-09T18:00:00Z"));
  const seeds = world.accounts.map((account) => seedRecords(account, anchor));
  const personal = seeds.find((seed) => seed.id === "personal");
  assert.ok(personal.messages.some((m) => m.message?.conversation?.includes("Lalelelor")));
  assert.ok(personal.transcripts.length > 0, "voice notes carry their transcripts");
  assert.equal(parseAt("-3d", anchor), anchor - 3 * 86_400_000);
});

test("the demo refuses the default data dir, and a dir holding accounts it did not make", () => {
  const home = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "wazap-home-"));
  process.env.HOME = fakeHome;
  try {
    assert.match(demoRefusal(join(fakeHome, ".wazap")).message, /never seeds/);
  } finally {
    process.env.HOME = home;
  }
  const real = mkdtempSync(join(tmpdir(), "wazap-real-"));
  writeFileSync(join(real, "accounts.json"), "{}");
  assert.match(demoRefusal(real).message, /did not make/);
  writeFileSync(join(real, DEMO_MARKER), "");
  assert.equal(demoRefusal(real), null, "a dir the demo made may be seeded again");
  assert.equal(demoRefusal(mkdtempSync(join(tmpdir(), "wazap-empty-"))), null);
});

// The CLI: demo seed, embed index, search ------------------------------------------

test("demo seed, embed index --wait and search, on the stub embedder, never touching WhatsApp", { timeout: 120_000 }, async () => {
  const stub = await startEmbedStub();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-demo-"));
  const env = { WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url, WAZAP_RECALL_MIN_SIMILARITY: "0.3" };
  try {
    const seeded = await wazap(["demo", "seed", "--data-dir", dataDir], env);
    assert.equal(seeded.code, 0, seeded.stderr);
    assert.match(seeded.stderr, /Personal \(personal\): \d+ messages/);
    assert.equal(seeded.stdout, "", "stdout stays clean");
    assert.equal(existsSync(join(dataDir, DEMO_MARKER)), true);

    const before = await wazap(["embed", "index", "--json", "--data-dir", dataDir], env);
    assert.equal(before.code, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).ready, false, "a seeded dir is not indexed until asked");

    const words = await wazap(["search", "Lalelelor", "--match", "words", "--json", "--data-dir", dataDir], env);
    assert.equal(words.code, 0, words.stderr);
    const byWords = JSON.parse(words.stdout);
    assert.equal(byWords.mode, "words");
    assert.match(byWords.hits[0].text, /Lalelelor 7/);

    const built = await wazap(["embed", "index", "--wait", "--json", "--data-dir", dataDir], env);
    assert.equal(built.code, 0, built.stderr);
    const index = JSON.parse(built.stdout);
    assert.equal(index.ready, true);
    assert.deepEqual(index.accounts.map((a) => a.account).sort(), ["personal", "work"]);
    assert.ok(index.accounts.every((a) => a.index.state === "ready" && a.index.indexed > 0 && a.index.pending === 0));

    const meaning = await wazap(["search", "adresa trimisă de Ana", "--match", "meaning", "--json", "--limit", "3", "--data-dir", dataDir], env);
    assert.equal(meaning.code, 0, meaning.stderr);
    const answer = JSON.parse(meaning.stdout);
    assert.equal(answer.mode, "meaning");
    const hit = answer.hits.find((h) => h.text.includes("Lalelelor"));
    assert.ok(hit, `no Lalelelor hit in ${meaning.stdout}`);
    assert.notEqual(hit.matched, "words");
    assert.equal(answer.index.state, "ready");

    const plain = await wazap(["search", "adresa trimisă de Ana", "--data-dir", dataDir], env);
    assert.equal(plain.stdout, "", "a person's output goes to stderr");
    assert.match(plain.stderr, /Ana Vasile: Vă aștept pe Lalelelor 7/);

    const work = await wazap(["search", "contract", "--account", "work", "--match", "words", "--json", "--data-dir", dataDir], env);
    assert.equal(JSON.parse(work.stdout).account, "work");
    assert.ok(JSON.parse(work.stdout).hits.length > 0);
  } finally {
    await stub.close();
  }
});

test("search falls back to words when meaning search is off, and --match meaning then fails", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-demo-"));
  assert.equal((await wazap(["demo", "seed", "--data-dir", dataDir])).code, 0);
  const hybrid = await wazap(["search", "Lalelelor", "--json", "--data-dir", dataDir], { WAZAP_RECALL: "off" });
  assert.equal(hybrid.code, 0, hybrid.stderr);
  const answer = JSON.parse(hybrid.stdout);
  assert.equal(answer.mode, "keyword_fallback");
  assert.equal(answer.recall_unavailable.code, "RECALL_UNAVAILABLE");
  assert.match(answer.hits[0].text, /Lalelelor/);

  const meaning = await wazap(["search", "Lalelelor", "--match", "meaning", "--data-dir", dataDir], { WAZAP_RECALL: "off" });
  assert.equal(meaning.code, 1);
  assert.match(meaning.stderr, /Semantic recall is off/);

  const index = await wazap(["embed", "index", "--wait", "--data-dir", dataDir], { WAZAP_RECALL: "off" });
  assert.equal(index.code, 1);
  assert.match(index.stderr, /wazap config recall local/);
});

test("search and embed index refuse a data dir a running server owns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-demo-"));
  assert.equal((await wazap(["demo", "seed", "--data-dir", dataDir])).code, 0);
  // This test process stands in for the server: its pid is alive.
  writeFileSync(join(dataDir, "server.lock"), String(process.pid));
  const searched = await wazap(["search", "Lalelelor", "--data-dir", dataDir]);
  assert.equal(searched.code, 1);
  assert.match(searched.stderr, new RegExp(`pid ${process.pid}`));
  const indexed = await wazap(["embed", "index", "--data-dir", dataDir], { WAZAP_RECALL: "local" });
  assert.equal(indexed.code, 1);
});

test("search refuses a bad --match or --limit", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-demo-"));
  assert.match((await wazap(["search", "x", "--match", "vibes", "--data-dir", dataDir])).stderr, /--match hybrid\|meaning\|words/);
  assert.match((await wazap(["search", "x", "--limit", "0", "--data-dir", dataDir])).stderr, /--limit must be/);
});

// The bootstrap script ------------------------------------------------------------

test("bootstrap --offline-stub seeds, indexes and finds the address by meaning, with no download", { skip: !posix, timeout: 180_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-bootstrap-"));
  const result = spawnSync("bash", [join(root, "scripts", "bootstrap.sh"), "--offline-stub", "--no-build", "--data-dir", dataDir], {
    cwd: root,
    env: childEnv({ HOME: mkdtempSync(join(tmpdir(), "wazap-home-")) }),
    encoding: "utf8",
    timeout: 170_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /✓ "invitație la petrecere pe strada Lalelelor" → Ana Vasile: Vă aștept pe Lalelelor 7/);
  assert.match(result.stderr, /no downloads/);
  assert.doesNotMatch(result.stderr, /Downloading|llama\.cpp b\d+ installed/);
  assert.equal(existsSync(join(dataDir, "models")), false, "no model was fetched");
  assert.match(readFileSync(join(dataDir, ".env"), "utf8"), /^WAZAP_RECALL=local$/m);
});
