import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Node warns when NO_COLOR and FORCE_COLOR are both set, so the child gets neither by inheritance. */
function cleanEnv(extra) {
  const env = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", ...extra };
  delete env.NO_COLOR;
  return env;
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const binary = join(root, "dist", "index.js");

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no console.log in src: stdout is the MCP JSON-RPC channel", () => {
  const offenders = sourceFiles(srcDir).filter((file) => readFileSync(file, "utf8").includes("console.log("));
  assert.deepEqual(offenders, [], "these files would corrupt the stdio protocol stream");
});

test("the setup guide and its legacy entry point ship in the package", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("AGENT.md"), `files: ${pkg.files.join(", ")}`);
  assert.ok(pkg.files.includes("USE-ME.md"), `files: ${pkg.files.join(", ")}`);
});

test("no leftover names from the pre-wazap fork", () => {
  // WHATSAPP_ERROR is a wazap error code; the ban is on the old env var prefix.
  const banned = [/pkgRoot/, /WHATSAPP_(?!ERROR\b)/, /MCP_AUTH_TOKEN/, /whatsapp-baileys-mcp/, /load_older_history/, /get_recent_chats/];
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of banned) if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
  }
  assert.deepEqual(offenders, []);
});

/**
 * Colour and layout are separate decisions. Colour follows FORCE_COLOR/NO_COLOR;
 * layout follows whether stderr is a terminal. Keying layout off colour once
 * broke ten spawn tests the moment FORCE_COLOR was exported, so pin it here.
 */
test("FORCE_COLOR paints piped output but never reshapes it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-hygiene-"));
  const args = [binary, "status", "--data-dir", dataDir];
  const plain = await run(process.execPath, args, { env: cleanEnv({ FORCE_COLOR: "0" }) });
  const painted = await run(process.execPath, args, { env: cleanEnv({ FORCE_COLOR: "1" }) });

  const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(strip(painted.stderr), plain.stderr, "colour must not change the words or the shape");
});

/** The glyph surfaces do paint, so the check above is not passing vacuously. */
test("FORCE_COLOR does paint the surfaces that use a glyph", async () => {
  const env = cleanEnv({ FORCE_COLOR: "1" });
  const err = await run(process.execPath, [binary, "frobnicate"], { env }).then(
    () => assert.fail("an unknown command must exit non-zero"),
    (rejected) => rejected,
  );
  assert.match(err.stderr, /\x1b\[31m/, "the failure glyph should be red");
  assert.match(err.stderr, /\x1b\[33m/, "the repair should be yellow");
  assert.equal(err.stderr.replace(/\x1b\[[0-9;]*m/g, ""), '✗ Unknown command "frobnicate".\n  → Run `wazap --help`\n');
});

test("no escape sequence ever reaches stdout, whatever the colour settings", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-stdout-"));
  const env = cleanEnv({ FORCE_COLOR: "1" });
  for (const args of [["status"], ["status", "--json"], ["config"], ["--help"], ["--version"]]) {
    const { stdout } = await run(process.execPath, [binary, ...args, "--data-dir", dataDir], { env });
    assert.ok(!stdout.includes("\x1b"), `${args.join(" ")} put an escape on the MCP channel`);
    assert.ok(!stdout.includes("\r"), `${args.join(" ")} put a carriage return on the MCP channel`);
  }
});
