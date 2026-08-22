import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

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
