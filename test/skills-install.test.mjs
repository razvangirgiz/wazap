import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "dist", "index.js");
const SKILLS = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * A HOME, a working directory and a PATH of their own, so no real skills
 * directory is ever touched and client detection sees only what a case sets up.
 */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "wazap-skills-home-"));
  return { home, cwd: mkdtempSync(join(tmpdir(), "wazap-skills-cwd-")), bin: join(home, "bin") };
}

function install(box, ...args) {
  return run(process.execPath, [binary, "skills", "install", ...args], {
    cwd: box.cwd,
    env: { ...process.env, HOME: box.home, USERPROFILE: box.home, PATH: box.bin },
  });
}

const TARGETS = [
  { harness: "claude-code", dir: (box) => join(box.home, ".claude", "skills") },
  { harness: "codex", dir: (box) => join(box.home, ".agents", "skills") },
  { harness: "cursor", dir: (box) => join(box.home, ".cursor", "skills") },
  { harness: "opencode", dir: (box) => join(box.home, ".config", "opencode", "skills") },
  { harness: "agents", dir: (box) => join(box.cwd, ".agents", "skills") },
];

for (const { harness, dir } of TARGETS) {
  test(`skills install ${harness} copies all five skills`, async () => {
    const box = sandbox();
    const { stderr } = await install(box, harness);
    for (const name of SKILLS) {
      assert.match(stderr, new RegExp(`✓ ${name}`), `${harness}: no ✓ for ${name}`);
      const skill = join(dir(box), name, "SKILL.md");
      assert.ok(existsSync(skill), `${harness}: ${skill} missing`);
      assert.equal(readFileSync(skill, "utf8"), readFileSync(join(root, "skills", name, "SKILL.md"), "utf8"));
    }
    assert.match(stderr, /Next/);
  });
}

test("a second install overwrites whatever the first one left", async () => {
  const box = sandbox();
  await install(box, "cursor");
  const skill = join(box.home, ".cursor", "skills", "whatsapp-send", "SKILL.md");
  writeFileSync(skill, "stale");

  await install(box, "cursor");
  assert.equal(readFileSync(skill, "utf8"), readFileSync(join(root, "skills", "whatsapp-send", "SKILL.md"), "utf8"));
});

test("--dry-run lists the five skills and writes nothing", async () => {
  const box = sandbox();
  const { stderr } = await install(box, "codex", "--dry-run");
  assert.match(stderr, /would copy into/);
  for (const name of SKILLS) assert.match(stderr, new RegExp(`✓ ${name}`));
  assert.ok(!existsSync(join(box.home, ".agents")), "dry run must not create the directory");
});

test("install with no harness lands the skills in every client it finds", async () => {
  const box = sandbox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  mkdirSync(join(box.home, ".codex"), { recursive: true });

  const { stderr } = await install(box);
  for (const dir of [join(box.home, ".cursor", "skills"), join(box.home, ".agents", "skills")]) {
    for (const name of SKILLS) assert.ok(existsSync(join(dir, name, "SKILL.md")), `${dir}: ${name} missing`);
  }
  assert.match(stderr, /Reload the Cursor window\./);
  assert.match(stderr, /Restart Codex\./);
});

test("install with no harness and nothing installed names the harnesses that exist", async () => {
  const box = sandbox();
  await assert.rejects(install(box), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /claude-code, codex, cursor, opencode, agents/);
    return true;
  });
});

test("an unknown harness names the ones that exist", async () => {
  const box = sandbox();
  await assert.rejects(install(box, "emacs"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /claude-code, codex, cursor, opencode, agents/);
    return true;
  });
});

test("the npm package ships the skills the command copies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("skills"), `files: ${pkg.files.join(", ")}`);
});
