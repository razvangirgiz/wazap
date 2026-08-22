import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
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
  assert.deepEqual(plugin.mcpServers.whatsapp.args, ["-y", "wazap"]);
});
