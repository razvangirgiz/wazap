import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import {
  bold,
  box,
  brand,
  centerBlock,
  centerLine,
  cmd,
  colorEnabled,
  dim,
  fail,
  fix,
  humanLayout,
  info,
  maskNumber,
  next,
  nextHint,
  ok,
  openCanvas,
  openScreen,
  red,
  screenChrome,
  shortPath,
  step,
  tilde,
  warn,
  width,
  yellow,
} from "../dist/ui.js";

/** FORCE_COLOR decides on its own, so these tests do not depend on a terminal. */
function withColor(on, body) {
  const before = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = on ? "1" : "0";
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = before;
  }
}

function strip(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const PLAIN = [
  [() => brand("hello"), "hello"],
  [() => dim("hello"), "hello"],
  [() => bold("hello"), "hello"],
  [() => red("hello"), "hello"],
  [() => yellow("hello"), "hello"],
  [() => cmd("wazap login"), "wazap login"],
  [() => ok("linked"), "✓ linked"],
  [() => fail("no answer"), "✗ no answer"],
  [() => info("lock none"), "– lock none"],
  [() => warn("careful"), "! careful"],
  [() => fix("chmod 700 ~/.wazap"), "  → chmod 700 ~/.wazap"],
  [() => step(2, 3, "Link your phone"), "\nStep 2 of 3 · Link your phone"],
  [() => screenChrome(1, 6, "Link"), "wazap  1/6\nLink"],
];

for (const [render, expected] of PLAIN) {
  test(`with colour off it is exactly ${JSON.stringify(expected)}`, () => {
    assert.equal(withColor(false, render), expected);
  });
}

for (const [render, expected] of PLAIN) {
  test(`with FORCE_COLOR=1 it is ${JSON.stringify(expected)} once ANSI is stripped`, () => {
    const painted = withColor(true, render);
    assert.ok(painted.includes("\x1b["), `${JSON.stringify(painted)} carries no escape`);
    assert.equal(strip(painted), expected);
  });
}

test("colorEnabled follows FORCE_COLOR over NO_COLOR", () => {
  const before = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
  try {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    assert.equal(colorEnabled(), true);
    process.env.FORCE_COLOR = "0";
    assert.equal(colorEnabled(), false);
    delete process.env.FORCE_COLOR;
    assert.equal(colorEnabled(), false);
  } finally {
    if (before.force === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = before.force;
    if (before.no === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = before.no;
  }
});

test("next keeps the colon form off-TTY, so `Next: ` assertions still match", () => {
  assert.equal(withColor(false, () => next("wazap login")), "Next: wazap login");
  assert.equal(
    withColor(false, () => next("wazap connect claude-code", "(or cursor)")),
    "Next: wazap connect claude-code   (or cursor)",
  );
});

test("colour paints the Next line without reshaping it", () => {
  const painted = withColor(true, () => next("wazap connect claude-code", "(or cursor)"));
  assert.ok(painted.includes("\x1b["), "the command should be painted");
  assert.equal(
    strip(painted),
    withColor(false, () => next("wazap connect claude-code", "(or cursor)")),
    "FORCE_COLOR must not change the shape of the line, only its colour",
  );
});

test("nextHint is not cyan, because cyan means type this", () => {
  assert.equal(withColor(false, () => nextHint("Reload the Cursor window.")), "Next: Reload the Cursor window.");
  const painted = withColor(true, () => nextHint("Reload the Cursor window."));
  assert.ok(!painted.includes("\x1b[36m"), "prose must not be painted as a command");
  assert.equal(strip(painted), "Next: Reload the Cursor window.");
});

test("shortPath and the status layout follow the terminal, not FORCE_COLOR", () => {
  assert.equal(humanLayout(), false, "test stderr is piped");
  const home = homedir();
  assert.equal(withColor(true, () => shortPath(join(home, ".cursor", "mcp.json"))), join(home, ".cursor", "mcp.json"));
  assert.equal(withColor(false, () => shortPath(join(home, ".cursor", "mcp.json"))), join(home, ".cursor", "mcp.json"));
});

test("box wraps an ASCII code in a rule two wider than the text", () => {
  assert.equal(
    withColor(false, () => box("4R6K-ALTW")),
    ["  ╭───────────╮", "  │ 4R6K-ALTW │", "  ╰───────────╯"].join("\n"),
  );
});

test("box counts a wide string by display width, not by code points", () => {
  const lines = withColor(false, () => box("日本語")).split("\n");
  assert.equal(width("日本語"), 6);
  assert.equal(lines[0], `  ╭${"─".repeat(8)}╮`);
  assert.equal(lines[1], "  │ 日本語 │");
  assert.equal(lines[2], `  ╰${"─".repeat(8)}╯`);
});

test("tilde replaces the home directory only as a prefix", () => {
  const home = homedir();
  assert.equal(tilde(join(home, ".wazap")), `~${sep}.wazap`);
  assert.equal(tilde(home), "~");
  assert.equal(tilde(`/opt${home}/.wazap`), `/opt${home}/.wazap`);
  assert.equal(tilde(`${home}-backup/.wazap`), `${home}-backup/.wazap`);
  assert.equal(tilde("/var/tmp/wazap"), "/var/tmp/wazap");
});

test("maskNumber keeps the first three digits and groups the rest", () => {
  assert.equal(maskNumber("15550100"), "+15 5xx xxx");
  assert.equal(maskNumber("447700900123"), "+44 7xx xxx xxx x");
});

function captureStderr(body) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    body();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

test("openScreen off-TTY is the existing Step line, and never clears the terminal", () => {
  assert.equal(humanLayout(), false, "test stderr is piped");
  const text = withColor(false, () => captureStderr(() => openScreen(2, 3, "Link your phone")));
  assert.equal(text, "\nStep 2 of 3 · Link your phone\n");
  assert.equal(text.includes("\x1b[2J"), false);
});

test("openCanvas off-TTY paints nothing, so the QR stays inside the current log step", () => {
  const text = withColor(false, () => captureStderr(() => openCanvas("Scan this with WhatsApp")));
  assert.equal(text, "");
});

test("centerLine pads a short string into the middle of the row", () => {
  assert.equal(centerLine("ab", 6), "  ab");
  assert.equal(width(centerLine("ab", 6)), 4);
});

test("centerBlock keeps a ragged column aligned, then drops it in the middle of the screen", () => {
  const placed = centerBlock(["wazap", "hi"], 9, 6);
  assert.equal(placed[0], "");
  assert.equal(placed[1], "");
  assert.match(placed[2], /^\s+wazap$/);
  assert.match(placed[3], /^\s+hi$/);
  assert.equal(placed[2].indexOf("w"), placed[3].indexOf("h"));
});

test("width ignores ANSI, so a painted line still centers on its visible glyphs", () => {
  assert.equal(width("\x1b[32mhi\x1b[0m"), 2);
  assert.equal(centerLine("\x1b[32mhi\x1b[0m", 6), "  \x1b[32mhi\x1b[0m");
});
