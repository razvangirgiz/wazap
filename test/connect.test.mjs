import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isNpxPath, launcher } from "../dist/connect.js";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "wazap-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wazap-cwd-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "wazap"), "", { mode: 0o755 });
  return { home, cwd, bin };
}

function connect(box, ...args) {
  return run(process.execPath, [binary, "connect", ...args], {
    cwd: box.cwd,
    env: {
      ...process.env,
      HOME: box.home,
      USERPROFILE: box.home,
      APPDATA: join(box.home, "AppData", "Roaming"),
      PATH: `${box.bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const desktopFile = (home) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");

const FILES = [
  { client: "cursor", file: (home) => join(home, ".cursor", "mcp.json"), key: "mcpServers" },
  { client: "gemini", file: (home) => join(home, ".gemini", "settings.json"), key: "mcpServers" },
  { client: "claude-desktop", file: desktopFile, key: "mcpServers" },
  { client: "windsurf", file: (home) => join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
];

for (const { client, file, key } of FILES) {
  test(`connect ${client} writes the whatsapp entry into a fresh config`, async () => {
    const box = sandbox();
    const target = file(box.home);
    const { stderr } = await connect(box, client);
    assert.match(stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(readJson(target)[key].whatsapp, { command: "wazap", args: [] });
    assert.ok(readFileSync(target, "utf8").endsWith("}\n"), "trailing newline");
    assert.ok(!existsSync(`${target}.bak`), "nothing to back up for a new file");
  });
}

test("connect opencode writes the one-array command its schema demands", async () => {
  const box = sandbox();
  await connect(box, "opencode");
  const target = join(box.home, ".config", "opencode", "opencode.json");
  assert.deepEqual(readJson(target).mcp.whatsapp, { type: "local", command: ["wazap"] });
});

test("connect vscode writes the workspace file with a stdio type", async () => {
  const box = sandbox();
  await connect(box, "vscode");
  const target = join(box.cwd, ".vscode", "mcp.json");
  assert.deepEqual(readJson(target).servers.whatsapp, { type: "stdio", command: "wazap", args: [] });
});

test("connect keeps the other keys, backs the file up once, and is idempotent", async () => {
  const box = sandbox();
  const target = join(box.home, ".cursor", "mcp.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "other" } }, ui: { theme: "dark" } }, null, 2));
  const original = readFileSync(target, "utf8");

  await connect(box, "cursor");
  const written = readJson(target);
  assert.deepEqual(written.mcpServers.other, { command: "other" });
  assert.deepEqual(written.ui, { theme: "dark" });
  assert.deepEqual(written.mcpServers.whatsapp, { command: "wazap", args: [] });
  assert.equal(readFileSync(`${target}.bak`, "utf8"), original);

  const afterFirst = readFileSync(target, "utf8");
  const backupStat = statSync(`${target}.bak`);
  const { stderr } = await connect(box, "cursor");
  assert.match(stderr, /already has this entry/);
  assert.equal(readFileSync(target, "utf8"), afterFirst);
  assert.equal(statSync(`${target}.bak`).mtimeMs, backupStat.mtimeMs);
});

test("connect refuses a config file it cannot parse and leaves it alone", async () => {
  const box = sandbox();
  const target = join(box.home, ".cursor", "mcp.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "{ not json");
  await assert.rejects(connect(box, "cursor"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /is not valid JSON/);
    assert.match(err.stderr, /move the file aside/);
    return true;
  });
  assert.equal(readFileSync(target, "utf8"), "{ not json");
  assert.ok(!existsSync(`${target}.bak`));
});

test("connect codex appends its table and leaves the rest of the TOML byte-for-byte", async () => {
  const box = sandbox();
  const target = join(box.home, ".codex", "config.toml");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');

  await connect(box, "codex");
  const text = readFileSync(target, "utf8");
  assert.ok(text.startsWith('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n'), text);
  assert.match(text, /\[mcp_servers\.whatsapp\]\ncommand = "wazap"\nargs = \[\]\n$/);

  const appended = text;
  await connect(box, "codex");
  assert.equal(readFileSync(target, "utf8"), appended);
});

test("connect codex replaces an existing whatsapp table without touching its neighbours", async () => {
  const box = sandbox();
  const target = join(box.home, ".codex", "config.toml");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    '[mcp_servers.whatsapp]\ncommand = "stale"\nargs = ["old"]\nenv = { A = "1" }\n\n[mcp_servers.other]\ncommand = "other"\n',
  );

  await connect(box, "codex");
  const text = readFileSync(target, "utf8");
  assert.equal(text, '[mcp_servers.whatsapp]\ncommand = "wazap"\nargs = []\n\n[mcp_servers.other]\ncommand = "other"\n');
  assert.ok(existsSync(`${target}.bak`));
});

const BIN_PATHS = [
  ["/Users/x/.npm/_npx/8a1b/node_modules/wazap/dist/index.js", true],
  ["C:\\Users\\x\\AppData\\npm-cache\\_npx\\8a1b\\node_modules\\wazap\\dist\\index.js", true],
  ["/usr/local/lib/node_modules/wazap/dist/index.js", false],
  ["/Users/x/Projects/wazap/dist/index.js", false],
  ["", false],
];

for (const [binPath, expected] of BIN_PATHS) {
  test(`isNpxPath ${binPath || "(empty)"} is ${expected}`, () => {
    assert.equal(isNpxPath(binPath), expected);
  });
}

const LAUNCHERS = [
  ["/Users/x/.npm/_npx/8a1b/node_modules/wazap/dist/index.js", "/usr/bin", [], { command: "npx", args: ["-y", "wazap-mcp"] }],
  ["/usr/local/lib/node_modules/wazap/dist/index.js", "/usr/local/bin:/usr/bin", ["/usr/local/bin/wazap"], { command: "wazap", args: [] }],
  ["/Users/x/Projects/wazap/dist/index.js", "/usr/local/bin:/usr/bin", [], { command: "node", args: ["/Users/x/Projects/wazap/dist/index.js"] }],
];

for (const [binPath, pathEnv, present, expected] of LAUNCHERS) {
  test(`launcher for ${binPath} is ${expected.command}`, () => {
    assert.deepEqual(launcher(binPath, pathEnv, (p) => present.includes(p)), expected);
  });
}

test("connect codex leaves the comments that introduce the next table alone", async () => {
  const box = sandbox();
  const target = join(box.home, ".codex", "config.toml");
  mkdirSync(dirname(target), { recursive: true });
  const rest = '\n# notes about the other server\n# second line\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(target, `[mcp_servers.whatsapp]\ncommand = "stale"\n${rest}`);

  await connect(box, "codex");
  assert.equal(readFileSync(target, "utf8"), `[mcp_servers.whatsapp]\ncommand = "wazap"\nargs = []\n${rest}`);
});

test("connect codex --dry-run leaves the TOML file untouched", async () => {
  const box = sandbox();
  const target = join(box.home, ".codex", "config.toml");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'model = "gpt-5"\n');
  const { stderr } = await connect(box, "codex", "--dry-run");
  assert.match(stderr, /\[mcp_servers\.whatsapp\]/);
  assert.equal(readFileSync(target, "utf8"), 'model = "gpt-5"\n');
});

test("connect refuses a config file it cannot read rather than replacing it", { skip: process.getuid?.() === 0 }, async () => {
  const box = sandbox();
  const target = join(box.home, ".cursor", "mcp.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '{"mcpServers":{"other":{"command":"o"}}}');
  chmodSync(target, 0o200);
  try {
    await assert.rejects(connect(box, "cursor"), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /cannot be read/);
      return true;
    });
  } finally {
    chmodSync(target, 0o600);
  }
  assert.equal(readFileSync(target, "utf8"), '{"mcpServers":{"other":{"command":"o"}}}');
});

test("connect --dry-run prints the entry and touches nothing", async () => {
  const box = sandbox();
  const { stderr } = await connect(box, "cursor", "--dry-run");
  assert.match(stderr, /would write/);
  assert.match(stderr, /"command": "wazap"/);
  assert.ok(!existsSync(join(box.home, ".cursor", "mcp.json")));
});

test("connect claude-code --dry-run prints the claude command it would run", async () => {
  const box = sandbox();
  const { stderr } = await connect(box, "claude-code", "--dry-run");
  assert.match(stderr, /claude mcp add whatsapp -- wazap/);
});

test("a non-default data dir carries through into the entry args", async () => {
  const box = sandbox();
  const dataDir = join(box.home, "elsewhere");
  await connect(box, "cursor", "--data-dir", dataDir);
  assert.deepEqual(readJson(join(box.home, ".cursor", "mcp.json")).mcpServers.whatsapp.args, ["--data-dir", dataDir]);
});

test("--read-only carries through into the entry args", async () => {
  const box = sandbox();
  await connect(box, "cursor", "--read-only");
  assert.deepEqual(readJson(join(box.home, ".cursor", "mcp.json")).mcpServers.whatsapp.args, ["--read-only"]);
});

test("an unknown client names the ones that exist", async () => {
  const box = sandbox();
  await assert.rejects(connect(box, "emacs"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /claude-code, claude-desktop, cursor, codex, vscode, gemini, windsurf, opencode/);
    return true;
  });
});
