import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installSkills, loadSkills, skillState } from "../dist/skills.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const toolNames = new Set([...readFileSync(join(root, "src/tools.ts"), "utf8").matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]));
const skillDirs = readdirSync(join(root, "skills"));

test("every skill has matching frontmatter and a trigger-bearing description", () => {
  assert.ok(skillDirs.length >= 5);
  for (const dir of skillDirs) {
    const text = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
    const fm = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(fm, `${dir}: frontmatter`);
    assert.equal(fm[1], dir, `${dir}: name matches directory`);
    assert.ok(fm[2].length > 40 && fm[2].length <= 1024, `${dir}: description length`);
    assert.match(fm[2], /Use (when|for)/, `${dir}: description names its triggers`);
  }
});

test("skills only reference tools the server registers", () => {
  for (const dir of skillDirs) {
    const text = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
    for (const [, name] of text.matchAll(/`((?:get|list|read|search|send|edit|react|forward|delete|manage|create|download)_[a-z_]+)`/g)) {
      assert.ok(toolNames.has(name), `${dir}: unknown tool \`${name}\``);
    }
  }
});

test("plugin manifest lists the skills directory and the MCP server", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.name, "wazap");
  assert.equal(plugin.skills, "./skills/");
  assert.deepEqual(plugin.mcpServers.whatsapp.args, ["-y", `wazap-mcp@${plugin.version}`]);
});

test("plugin manifest version matches package.json", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
});

test("loadSkills reads the packaged skills into one registry", () => {
  const skills = loadSkills();
  assert.equal(skills.length, 5);
  assert.deepEqual(skills.map((skill) => skill.name), [...skills.map((skill) => skill.name)].sort());
  for (const skill of skills) {
    assert.ok(skillDirs.includes(skill.name), `${skill.name} has no directory`);
    assert.ok(skill.description.length > 0, `${skill.name}: empty description`);
    assert.ok(skill.body.startsWith("# "), `${skill.name}: body must start at the title, not the frontmatter`);
  }
});

test("skillState reads missing, then installed, then stale as the packaged copies change", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-skillstate-"));
  const target = { name: "temp", describe: "A throwaway harness", dir: () => dir, next: "" };
  assert.equal(skillState(target), "missing");

  installSkills(target, false);
  assert.equal(skillState(target), "installed");

  writeFileSync(join(dir, skillDirs[0], "SKILL.md"), "what an older wazap shipped\n");
  assert.equal(skillState(target), "stale");
});

test("skillState calls a harness missing one skill missing, not stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-skillstate-gap-"));
  const target = { name: "temp", describe: "A throwaway harness", dir: () => dir, next: "" };
  installSkills(target, false);
  writeFileSync(join(dir, skillDirs[0], "SKILL.md"), "stale");
  rmSync(join(dir, skillDirs[1]), { recursive: true });
  assert.equal(skillState(target), "missing");
});
