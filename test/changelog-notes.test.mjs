import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { notesFor } from "../scripts/changelog-notes.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/changelog-notes.mjs", import.meta.url));

const CHANGELOG = `# Changelog

## 1.2.10
### Added

- **Ten.** The newest entry.

## 1.2.1
### Added

- **One.** Its own entry.

### Changed

- **Still one.** A sub-heading does not end the section.

## 1.2.0

- **Oldest.** The last section runs to the end of the file.
`;

test("a release gets exactly its own section, sub-headings included", () => {
  assert.equal(
    notesFor(CHANGELOG, "1.2.1"),
    "### Added\n\n- **One.** Its own entry.\n\n### Changed\n\n- **Still one.** A sub-heading does not end the section."
  );
});

test("1.2.1 is not mistaken for the 1.2.10 heading that starts with it", () => {
  assert.equal(notesFor(CHANGELOG, "1.2.10"), "### Added\n\n- **Ten.** The newest entry.");
});

test("the last section runs to the end of the file", () => {
  assert.equal(notesFor(CHANGELOG, "1.2.0"), "- **Oldest.** The last section runs to the end of the file.");
});

test("Windows line endings read the same", () => {
  assert.equal(notesFor(CHANGELOG.replace(/\n/g, "\r\n"), "1.2.10"), "### Added\n\n- **Ten.** The newest entry.");
});

test("a version with no section fails naming the heading it looked for", () => {
  assert.throws(() => notesFor(CHANGELOG, "1.3.0"), { message: 'no "## 1.3.0" section' });
});

test("a section with only its heading fails rather than giving empty notes", () => {
  assert.throws(() => notesFor("## 2.0.0\n\n## 1.0.0\n- one\n", "2.0.0"), {
    message: 'the "## 2.0.0" section is empty',
  });
});

test("the command prints the notes, and exits 1 with the file named when they are missing", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "wazap-changelog-")), "CHANGELOG.md");
  writeFileSync(file, CHANGELOG);

  const { stdout } = await run(process.execPath, [script, "1.2.0", file]);
  assert.equal(stdout, "- **Oldest.** The last section runs to the end of the file.\n");

  await assert.rejects(run(process.execPath, [script, "9.9.9", file]), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.ok(error.stderr.includes(`${file}: no "## 9.9.9" section`), error.stderr);
    return true;
  });
});
