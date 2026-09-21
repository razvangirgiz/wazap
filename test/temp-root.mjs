/**
 * The tests make their scratch directories with `mkdtempSync(join(tmpdir(), …))`
 * and nothing removes them: a few hundred runs left 225,000 directories and 50 GB
 * in the system temp folder. Rather than chase every call, each test process
 * gets one root of its own, `TMPDIR` points into it (so `os.tmpdir()` and any CLI
 * a test spawns land there), and the root goes when the process exits.
 *
 * A run killed midway skips the exit hook and leaves its root behind; the next
 * top-level run removes roots older than a day, never a live run's.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "wazap-test-";
const STALE_MS = 24 * 60 * 60 * 1000;
const base = tmpdir();

// Only the process that starts the run sweeps; the per-file processes it spawns
// inherit the marker and nest their roots inside its root.
if (!process.env.WAZAP_TEST_TMP_ROOT) {
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(base, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run removed it first, or it is not ours to read: leave it.
    }
  }
}

const root = mkdtempSync(join(base, PREFIX));
process.env.TMPDIR = root;
process.env.WAZAP_TEST_TMP_ROOT = root;
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
