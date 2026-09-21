import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { BANNER_ART } from "../dist/banner.js";
import { QR_ROWS, centerBlock, qrFits, qrScreenRows } from "../dist/ui.js";
import {
  contentChars,
  isArtLine,
  loginWizardSteps,
  qrScreenBody,
  setupWizardSteps,
  typePrefix,
  wizardLines,
  wizardSpinLine,
} from "../dist/wizard.js";

function strip(text) {
  // eslint-disable-next-line no-control-regex -- asserting on ANSI output
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

/** A code of the height WhatsApp's is, each row marked so a cut shows which rows went. */
const art = Array.from({ length: QR_ROWS }, (_, i) => `▄▀ qr-row-${i} ▀▄`);
const SAVED = "Also saved to ~/.wazap/qr.png";

test("a QR screen is exactly as tall as qrScreenRows says: whole from that height, cut at the top below it", () => {
  const body = qrScreenBody(art, 999, SAVED);
  for (let rows = 10; rows <= 60; rows++) {
    // What the wizard draws: the logo and step lines, the body, and the waiting line under it.
    const content = wizardLines(1, 5, "Scan this with WhatsApp", [...body, wizardSpinLine(0, "Waiting for your phone…")]);
    const shown = centerBlock(content, 100, rows).map(strip);
    const whole = art.every((line) => shown.some((shownLine) => shownLine.includes(line)));
    assert.equal(whole, qrFits(rows), `at ${rows} rows the code is ${whole ? "whole" : "cut"}, qrFits says ${qrFits(rows)}`);
  }
  assert.equal(qrScreenRows(), QR_ROWS + 4);
});

test("a window that holds the QR is shown the QR and how to scan it", () => {
  const plain = qrScreenBody(art, qrScreenRows(), SAVED).map(strip);
  assert.deepEqual(plain.slice(0, art.length), art);
  assert.ok(plain.some((line) => line.includes("Linked devices")));
  assert.ok(plain.includes(SAVED), "and where the picture was saved");
});

test("a window too short for the QR is told so, and is not shown half a code", () => {
  const rows = 24;
  const plain = qrScreenBody(art, rows, SAVED).map(strip);
  for (const line of art) assert.ok(!plain.some((shown) => shown.includes(line)), "no part of the code is drawn");
  const text = plain.join("\n");
  assert.match(text, new RegExp(`This window is ${rows} rows tall and the QR code needs ${qrScreenRows(art.length)}`));
  assert.match(text, /taller/, "it says to make the window taller");
  assert.match(text, /npx wazap-mcp login --phone/, "and the way that needs no room");
});

test("a flow that awaits the wizard's typing is not cut off when nothing else keeps the process open", async () => {
  // The state after the QR-or-code question: stdin closed, no socket yet. The
  // typing's own timers were the only thing pending, and they were unref'd, so
  // Node left mid-await with exit code 0 and the person saw one character.
  const wizard = pathToFileURL(new URL("../dist/wizard.js", import.meta.url).pathname).href;
  const script = `
    const { startWizard } = await import(${JSON.stringify(wizard)});
    const w = startWizard(3);
    await w.next("Scan this with WhatsApp", ["a line the typing has to finish"]);
    process.stderr.write("\\nTYPED-TO-THE-END\\n");
    w.close();
  `;
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.ok(stderr.includes("TYPED-TO-THE-END"), `the process left before the typing was done (exit ${code})`);
  assert.equal(code, 0);
});
