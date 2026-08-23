import { cpSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { WazapError } from "./errors.js";
import { log, say } from "./logger.js";
import { info, next, nextHint, ok, shortPath } from "./ui.js";

export interface SkillTarget {
  name: string;
  describe: string;
  /** Where the five directories go, or null when this harness takes them another way. */
  dir: (() => string) | null;
  next: string;
}

/**
 * Each path is the one that harness's own docs name today. Codex is the
 * one that moved: `~/.codex/skills` still loads, but its docs call that
 * location deprecated and put user skills in `~/.agents/skills`, which Cursor
 * and OpenCode read too.
 */
export const SKILL_TARGETS: readonly SkillTarget[] = [
  {
    name: "claude-code",
    describe: "Claude Code",
    dir: null,
    next: "/plugin marketplace add razvangirgiz/wazap",
  },
  {
    name: "codex",
    describe: "Codex CLI",
    dir: () => join(homedir(), ".agents", "skills"),
    next: "Restart Codex. Cursor and OpenCode read this directory too.",
  },
  {
    name: "cursor",
    describe: "Cursor",
    dir: () => join(homedir(), ".cursor", "skills"),
    next: "Reload the Cursor window.",
  },
  {
    name: "opencode",
    describe: "OpenCode",
    dir: () => join(homedir(), ".config", "opencode", "skills"),
    next: "Restart OpenCode.",
  },
  {
    name: "agents",
    describe: "This project, any agent",
    dir: () => join(process.cwd(), ".agents", "skills"),
    next: "Commit .agents/skills to share them with whoever clones this repo.",
  },
];

export const SKILL_TARGET_NAMES: string = SKILL_TARGETS.map((target) => target.name).join(", ");

/** One workflow: what it is for, and the markdown that teaches it. */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** The `skills/` folder shipped in the npm package, next to `dist/`. */
function packagedSkills(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

/**
 * Frontmatter is a `---` block of one-line values, the same shape
 * scripts/build-context.mjs strips to build GEMINI.md.
 */
function parseSkill(text: string): Skill | null {
  const close = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  if (close === -1) return null;
  const front = text.slice(4, close + 1);
  const field = (key: string): string => new RegExp(`^${key}: (.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
  const name = field("name");
  const description = field("description");
  if (name === "" || description === "") return null;
  return { name, description, body: text.slice(close + 5).trim() };
}

/** Every packaged workflow, by name. Empty rather than fatal: the server serves tools either way. */
export function loadSkills(): Skill[] {
  try {
    const dir = packagedSkills();
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseSkill(readFileSync(join(dir, entry.name, "SKILL.md"), "utf8")))
      .filter((skill): skill is Skill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    log(`no workflows to offer: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The skill's own H1, which is what a prompt picker shows. */
function skillTitle(skill: Skill): string {
  return /^# (.+)$/m.exec(skill.body)?.[1]?.trim() ?? skill.name;
}

/**
 * A description through the sentence that names its triggers, which every skill
 * has. What follows is the read-only note the tool annotations already carry,
 * and the instructions block has a budget.
 */
function trigger(description: string): string {
  const sentence = /\bUse (?:when|for)\b[^.]*\./.exec(description);
  return sentence === null ? description : description.slice(0, sentence.index + sentence[0].length);
}

/**
 * What the client shows its model before the first tool call. Short on purpose:
 * the bodies are the prompts, this is only the index to them.
 */
export function skillInstructions(skills: readonly Skill[]): string {
  const intro =
    "Call `learn` first: it returns every tool, the id formats and every error code with what to do about it.";
  if (skills.length === 0) return intro;
  return [
    intro,
    "",
    "The workflows behind these tools:",
    ...skills.map((skill) => `- **${skill.name}**: ${trigger(skill.description)}`),
    "",
    "Each one is available in full as the MCP prompt of the same name. Never send from the user's WhatsApp without their explicit yes: show the recipient and the exact text, then wait for it.",
  ].join("\n");
}

/** The same workflows a skill-aware harness reads off disk, for every client that has no skills directory. */
export function registerSkillPrompts(server: McpServer, skills: readonly Skill[]): void {
  for (const skill of skills) {
    server.registerPrompt(
      skill.name,
      { title: skillTitle(skill), description: skill.description },
      async () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: skill.body } }] }),
    );
  }
}

function findSkillTarget(name: string): SkillTarget {
  const target = SKILL_TARGETS.find((candidate) => candidate.name === name);
  if (!target) {
    throw new WazapError("INVALID_ID", `Unknown harness "${name}".`, `Pick one of: ${SKILL_TARGET_NAMES}`);
  }
  return target;
}

export function runSkills(config: Config): void {
  if (config.args[0] !== "install") {
    throw new WazapError("INVALID_ID", `Unknown skills command "${config.args[0]}".`, "Run `wazap skills install <harness>`");
  }

  const target = findSkillTarget(config.args[1] ?? "");
  if (target.dir === null) {
    say(info(`${target.describe} loads these skills from the wazap plugin, along with the MCP server.`));
    say(next(target.next));
    return;
  }

  const skills = loadSkills();
  if (skills.length === 0) {
    throw new WazapError(
      "FILE_NOT_FOUND",
      "This wazap install ships no skills/ directory.",
      "Upgrade with `npm i -g wazap-mcp@latest`, or run this from a checkout.",
    );
  }

  const dir = target.dir();
  say(info(`${target.describe} · ${config.dryRun ? "would copy into" : "copying into"} ${shortPath(dir)}`));
  for (const skill of skills) {
    // Overwriting is the point: this is how an upgrade reaches an already
    // installed harness, and re-running it must land in the same place.
    if (!config.dryRun) cpSync(join(packagedSkills(), skill.name), join(dir, skill.name), { recursive: true, force: true });
    say(`  ${ok(skill.name)}`);
  }

  say(nextHint(target.next));
}
