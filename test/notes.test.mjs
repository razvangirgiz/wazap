import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Notes } from "../dist/notes.js";

const JID = "40700000000@s.whatsapp.net";

function notesPath() {
  return join(mkdtempSync(join(tmpdir(), "wazap-notes-")), "notes.json");
}

test("a missing file is a clean default, not an error", () => {
  const notes = new Notes(notesPath());
  assert.equal(notes.error, null);
  assert.equal(notes.noteFor(JID), undefined);
  notes.setNote(JID, "Hermi, my agent");
  assert.equal(notes.noteFor(JID), "Hermi, my agent");
  assert.equal(notes.error, null);
});

test("a corrupt file surfaces instead of silently starting over", () => {
  const file = notesPath();
  writeFileSync(file, "{ not json");
  const notes = new Notes(file);
  assert.match(notes.error, /JSON|Expected/);
  assert.equal(notes.noteFor(JID), undefined, "reads still answer from the empty maps");
  assert.throws(() => notes.setNote(JID, "x"), /Cannot overwrite unreadable notes/);
  assert.throws(() => notes.markHandled(JID, "a1"), /Cannot overwrite unreadable notes/);
  assert.equal(readFileSync(file, "utf8"), "{ not json", "the corrupt file is left alone");
});

test("an unsupported version is an error too, and also refuses the overwrite", () => {
  const file = notesPath();
  writeFileSync(file, JSON.stringify({ v: 2, contacts: {} }));
  const notes = new Notes(file);
  assert.equal(notes.error, "Unsupported notes file version");
  assert.throws(() => notes.setNote(JID, "x"), /unreadable notes/);
});

test(
  "an unreadable file (EACCES) is reported like a corrupt one",
  { skip: process.getuid?.() === 0 },
  () => {
    const file = notesPath();
    writeFileSync(file, JSON.stringify({ v: 1 }));
    chmodSync(file, 0o000);
    try {
      const notes = new Notes(file);
      assert.match(notes.error, /EACCES|permission/i);
      assert.throws(() => notes.setNote(JID, "x"), /Cannot overwrite unreadable notes/);
    } finally {
      chmodSync(file, 0o600);
    }
  }
);

test("a good file still loads and a failed save records the error", () => {
  const file = notesPath();
  writeFileSync(file, JSON.stringify({ v: 1, contacts: { [JID]: { note: "n", updated_at: "x" } } }));
  const notes = new Notes(file);
  assert.equal(notes.error, null);
  assert.equal(notes.noteFor(JID), "n");
});
