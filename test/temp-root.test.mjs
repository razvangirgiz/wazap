/**
 * The temp root every test process loads (test/temp-root.mjs): what a test makes
 * under `os.tmpdir()` is gone once the process exits, and a root a killed run
 * left behind is swept by the next run once it is a day old, never sooner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELOAD = new URL("./temp-root.mjs", import.meta.url).pathname;

/** Runs `code` in a fresh node that loads the preload, as the top of a run, with `base` as the system temp. */
function runTop(base, code) {
  const env = { ...process.env, TMPDIR: base };
  delete env.WAZAP_TEST_TMP_ROOT;
  const result = spawnSync(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", code], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("what a test makes under tmpdir() is gone when its process exits", (t) => {
  const base = mkdtempSync(join(tmpdir(), "temp-root-base-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const made = JSON.parse(
    runTop(
      base,
      `import { mkdtempSync, writeFileSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       const dir = mkdtempSync(join(tmpdir(), "wazap-db-"));
       writeFileSync(join(dir, "wazap.sqlite"), "x");
       console.log(JSON.stringify({ dir, root: process.env.WAZAP_TEST_TMP_ROOT }));`,
    ),
  );

  assert.ok(made.dir.startsWith(`${made.root}/`), "the directory lives under the run's root");
  assert.ok(made.root.startsWith(join(base, "wazap-test-")), "the root lives under the system temp");
  assert.equal(existsSync(made.dir), false);
  assert.equal(existsSync(made.root), false);
});

test("the next run sweeps a root a killed run left a day ago, not one still in use", (t) => {
  const base = mkdtempSync(join(tmpdir(), "temp-root-base-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stale = join(base, "wazap-test-killed");
  const live = join(base, "wazap-test-live");
  const unrelated = join(base, "someone-elses-dir");
  for (const dir of [stale, live, unrelated]) mkdirSync(dir);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(stale, twoDaysAgo, twoDaysAgo);
  utimesSync(unrelated, twoDaysAgo, twoDaysAgo);

  runTop(base, "");

  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(unrelated), true);
});
