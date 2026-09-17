import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSkills, loadSkills, skillState } from "../dist/skills.js";
import { TOOL_NAMES } from "../dist/tools.js";
import { RETIRED_TOOLS } from "./helpers.mjs";

const root = new URL("..", import.meta.url).pathname;
const toolNames = new Set(TOOL_NAMES);
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

test("skills only reference tools the server registers, and no retired name", () => {
  for (const dir of skillDirs) {
    const text = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
    for (const [, name] of text.matchAll(
      /`((?:get|list|read|search|send|edit|react|forward|delete|manage|create|download|set|confirm|find|update|sync|mark|link|wait|catch|transcribe|save|remove)_[a-z_]+)(?:\(|`)/g
    )) {
      assert.ok(toolNames.has(name), `${dir}: unknown tool \`${name}\``);
    }
    for (const name of RETIRED_TOOLS) {
      // As a tool: in backticks or called. "recall" also names a setting (`wazap config recall`) and this skill.
      assert.doesNotMatch(text, new RegExp(`\`${name}[\`(]|[^-\\w\`]${name}\\(`), `${dir}: retired tool ${name}`);
    }
  }
});
test("plugin manifest lists the skills directory and the MCP server", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.name, "wazap");
  assert.equal(plugin.skills, "./skills/");
  assert.deepEqual(plugin.mcpServers.whatsapp.args, ["-y", "wazap-mcp"]);
});

test("plugin manifest version matches package.json", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
});

test("the server's instructions say a draft is made before asking: send_message sends nothing, and its preview is what the user says yes to", async () => {
  const { skillInstructions } = await import("../dist/skills.js");
  const instructions = skillInstructions(loadSkills());
  assert.match(instructions, /Never send without the user's explicit yes: draft with send_message \(it sends nothing\), show the preview it returns, and wait for the yes before confirm_send\./);
  assert.doesNotMatch(instructions, /show the recipient and the exact text, then wait for it/, "no longer read as: ask before any call");
});

test("a session that only reads is told so in the server's instructions: asked to send, it says so instead of pretending", async () => {
  const { skillInstructions } = await import("../dist/skills.js");
  for (const skills of [loadSkills(), []]) {
    const reads = skillInstructions(skills, { allowWrite: false });
    assert.match(reads, /This connection only reads: it cannot draft or send\. Asked to send, say so, and offer the text for the user to send from their phone or a connection with write access\./);
    assert.doesNotMatch(reads, /draft with send_message/);
    const writes = skillInstructions(skills, { allowWrite: true });
    assert.doesNotMatch(writes, /only reads/);
    assert.match(writes, /draft with send_message \(it sends nothing\)/, "the send rule stands without skills too");
  }
});

test("loadSkills reads the packaged skills into one registry", () => {
  const skills = loadSkills();
  assert.equal(skills.length, 5);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    [...skills.map((skill) => skill.name)].sort()
  );
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

test("skillState calls a harness missing one skill stale, so update still refreshes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-skillstate-gap-"));
  const target = { name: "temp", describe: "A throwaway harness", dir: () => dir, next: "" };
  installSkills(target, false);
  writeFileSync(join(dir, skillDirs[0], "SKILL.md"), "stale");
  rmSync(join(dir, skillDirs[1]), { recursive: true });
  assert.equal(skillState(target), "stale");

  for (const name of skillDirs) rmSync(join(dir, name), { recursive: true, force: true });
  assert.equal(skillState(target), "missing", "none left is a harness update leaves alone");
});

test("the send skill does not read a #private contact's thread unless the user asks", () => {
  const text = readFileSync(join(root, "skills", "whatsapp-send", "SKILL.md"), "utf8");
  const draft = text.slice(text.indexOf("## Draft"), text.indexOf("## Confirm, then send"));
  assert.match(draft, /#private[^\n]*do not read (?:their|the) (?:thread|messages)[^\n]*unless the user asks/i);
  assert.doesNotMatch(draft, /\(a read session, a contact tagged `#private`, an account that turned it off\), use `read_messages`/);
});
