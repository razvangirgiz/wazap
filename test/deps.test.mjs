/**
 * `ensureDeps`, against a PATH that holds nothing but a sandbox. The `brew` here
 * is a stub that records its argv and creates the binaries the real one would
 * install, so no test ever reaches Homebrew.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEPS, ensureDeps } from "../dist/deps.js";

const LOCAL = [DEPS.whisper, DEPS.ffmpeg];

function sandbox({ brew = true, present = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-deps-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "brew.log");
  for (const name of present) writeFileSync(join(bin, name), "", { mode: 0o755 });
  if (brew) {
    // Homebrew's whisper-cpp formula installs a binary called whisper-cli, which
    // is the gap between what ensureDeps asks for and what it re-probes for.
    writeFileSync(
      join(bin, "brew"),
      `#!/bin/sh
echo "$@" >> ${log}
shift
for formula in "$@"; do
  [ "$formula" = whisper-cpp ] && formula=whisper-cli
  : > ${bin}/$formula
  /bin/chmod +x ${bin}/$formula
done
exit 0
`,
      { mode: 0o755 },
    );
  }
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

/**
 * The PATH, the captured lines and the TTY answer are process-wide, so every case
 * restores all three. stdin is forced to a pipe: no test may reach a prompt,
 * whatever the suite was started from.
 */
async function run(box, config) {
  const path = process.env.PATH;
  const tty = process.stdin.isTTY;
  const original = console.error;
  const lines = [];
  process.env.PATH = box.bin;
  process.stdin.isTTY = false;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { ok: await ensureDeps(LOCAL, { assumeYes: false, noBrew: false, ...config }), said: lines.join("\n") };
  } finally {
    process.env.PATH = path;
    process.stdin.isTTY = tty;
    console.error = original;
  }
}

test("every dependency already on PATH is true, and brew is never called", async () => {
  const box = sandbox({ present: ["whisper-cli", "ffmpeg"] });
  const { ok, said } = await run(box, { assumeYes: true });

  assert.equal(ok, true);
  assert.deepEqual(box.calls(), [], "nothing to install means nothing to run");
  assert.equal(said, "", "a satisfied dependency is not news");
});

test("--yes installs the missing formulae in one brew call and re-probes", async () => {
  const box = sandbox();
  const { ok, said } = await run(box, { assumeYes: true });

  assert.equal(ok, true);
  assert.deepEqual(box.calls(), ["install whisper-cpp ffmpeg"], "one call for the whole set");
  assert.equal(existsSync(join(box.bin, "whisper-cli")), true);
  assert.match(said, /whisper-cli is not installed; it transcribes voice messages locally\./);
  assert.match(said, /ffmpeg is not installed; it converts voice notes for whisper\./);
});

test("only what is missing reaches the brew command line", async () => {
  const box = sandbox({ present: ["ffmpeg"] });
  const { ok } = await run(box, { assumeYes: true });

  assert.equal(ok, true);
  assert.deepEqual(box.calls(), ["install whisper-cpp"]);
});

test("--no-brew never calls brew and answers false", async () => {
  const box = sandbox();
  const { ok, said } = await run(box, { assumeYes: true, noBrew: true });

  assert.equal(ok, false);
  assert.deepEqual(box.calls(), []);
  assert.equal(said, "", "the caller owns the fix line, so ensureDeps adds none");
});

test("no brew on PATH answers false, and leaves the fix line to the caller", async () => {
  const box = sandbox({ brew: false });
  const { ok, said } = await run(box, { assumeYes: true });

  assert.equal(ok, false);
  assert.equal(said, "");
});

test("a pipe with no --yes is never prompted", async () => {
  const box = sandbox();
  const { ok } = await run(box, {});

  assert.equal(ok, false);
  assert.deepEqual(box.calls(), [], "nobody is there to answer, so nothing is installed");
});

test("a brew that installs nothing is reported as still missing", async () => {
  const box = sandbox();
  writeFileSync(join(box.bin, "brew"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { ok } = await run(box, { assumeYes: true });

  assert.equal(ok, false, "the answer is what is on PATH afterwards, not brew's exit code");
});

test("the table names the binary each formula puts on PATH", () => {
  assert.deepEqual(
    Object.values(DEPS).map((dep) => [dep.binary, dep.brew]),
    [
      ["whisper-cli", "whisper-cpp"],
      ["ffmpeg", "ffmpeg"],
      ["tailscale", "tailscale"],
      ["cloudflared", "cloudflared"],
    ],
  );
});
