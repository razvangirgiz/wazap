import { test } from "node:test";
import assert from "node:assert/strict";

import { BANNER_ART } from "../dist/banner.js";
import {
  contentChars,
  isArtLine,
  loginWizardSteps,
  setupWizardSteps,
  typePrefix,
  wizardLines,
  wizardSpinLine,
} from "../dist/wizard.js";

function strip(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("wizardLines starts with the ASCII logo, then the step number and title", () => {
  const lines = wizardLines(1, 8, "Scan this with WhatsApp", ["Waiting for a QR from WhatsApp…"]);
  const plain = lines.map(strip);
  assert.equal(plain[0], BANNER_ART.split("\n")[0]);
  assert.ok(plain.includes("1 / 8"));
  assert.ok(plain.includes("Scan this with WhatsApp"));
  assert.ok(plain.includes("Waiting for a QR from WhatsApp…"));
});

test("typePrefix keeps the indent and walks visible characters, not SGR", () => {
  assert.equal(typePrefix("hello", 2), "he");
  assert.equal(typePrefix("  hello", 3), "  hel");
  assert.equal(contentChars("  hello"), 5);
  assert.equal(strip(typePrefix("\x1b[32mhello\x1b[0m", 3)), "hel");
});

test("isArtLine catches QR and box drawing, not a sentence", () => {
  assert.equal(isArtLine("████▄▀▄█▄▀"), true);
  assert.equal(isArtLine("  ╭───────────╮"), true);
  assert.equal(isArtLine("WhatsApp → Settings → Linked devices"), false);
});

test("wizardSpinLine keeps the copy still and only the glyph moves", () => {
  const a = strip(wizardSpinLine(0, "Syncing your chats…"));
  const b = strip(wizardSpinLine(1, "Syncing your chats…"));
  assert.notEqual(a[0], b[0]);
  assert.equal(a.slice(2), "Syncing your chats…");
  assert.equal(b.slice(2), "Syncing your chats…");
});

test("setupWizardSteps counts link screens, then transcribe, optional install, connect, keep, finish", () => {
  assert.equal(setupWizardSteps({ linked: false, npx: true, askWrites: true, loginCode: false }), 8);
  assert.equal(setupWizardSteps({ linked: true, npx: false, askWrites: false, loginCode: false }), 4);
  assert.equal(loginWizardSteps(false, true), 3);
  assert.equal(loginWizardSteps(true, true), 4);
});
