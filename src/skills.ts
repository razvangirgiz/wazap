import { cpSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { info, next, nextHint, ok, shortPath } from "./ui.js";

export interface SkillTarget {
  name: string;
  describe: string;
  /** Where the five directories go, or null when this harness takes them another way. */
  dir: (() => string) | null;
  next: string;
}

/**
 * Every path here is the one that harness's own docs name today. Codex is the
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

/** The `skills/` folder shipped in the npm package, next to `dist/`. */
function packagedSkills(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function skillNames(): string[] {
  try {
    return readdirSync(packagedSkills(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new WazapError(
      "FILE_NOT_FOUND",
      "This wazap install ships no skills/ directory.",
      "Upgrade with `npm i -g wazap-mcp@latest`, or run this from a checkout.",
    );
  }
}

export function findSkillTarget(name: string): SkillTarget {
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

  const dir = target.dir();
  const names = skillNames();
  say(info(`${target.describe} · ${config.dryRun ? "would copy into" : "copying into"} ${shortPath(dir)}`));

  for (const name of names) {
    // Overwriting is the point: this is how an upgrade reaches an already
    // installed harness, and re-running it must land in the same place.
    if (!config.dryRun) cpSync(join(packagedSkills(), name), join(dir, name), { recursive: true, force: true });
    say(`  ${ok(name)}`);
  }

  say(nextHint(target.next));
}
