/**
 * The binaries wazap shells out to but does not ship, and the one prompt that
 * installs them. Homebrew only: apt and the rest keep the fix line each caller
 * already prints.
 */
import { spawnSync } from "node:child_process";
import { ask } from "./cli.js";
import type { Config } from "./config.js";
import { REAL_PROBES, type Probes } from "./connect.js";
import { say } from "./logger.js";
import { brand, info } from "./ui.js";

export interface Dependency {
  binary: string;
  brew: string;
  why: string;
}

/** `whisper-cli` is the name Homebrew's whisper-cpp formula installs; findWhisper looks for it first. */
export const DEPS = {
  whisper: { binary: "whisper-cli", brew: "whisper-cpp", why: "transcribes voice messages locally" },
  ffmpeg: { binary: "ffmpeg", brew: "ffmpeg", why: "converts voice notes for whisper" },
  tailscale: { binary: "tailscale", brew: "tailscale", why: "gives wazap a public https URL" },
  cloudflared: { binary: "cloudflared", brew: "cloudflared", why: "gives wazap a public https URL" },
} as const satisfies Record<string, Dependency>;

function andList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Offers `brew install` for what is missing; true when every dependency is now
 * on PATH. Says nothing when it cannot offer, so the caller's own repair line
 * is the only one the user reads.
 */
export async function ensureDeps(
  deps: readonly Dependency[],
  config: Config,
  probes: Probes = REAL_PROBES,
): Promise<boolean> {
  const missing = deps.filter((dep) => !probes.onPath(dep.binary));
  if (missing.length === 0) return true;
  if (config.noBrew || !probes.onPath("brew")) return false;
  if (!config.assumeYes && process.stdin.isTTY !== true) return false;

  for (const dep of missing) say(info(`${dep.binary} is not installed; it ${dep.why}.`));
  const formulae = missing.map((dep) => dep.brew);
  if (!config.assumeYes) {
    const answer = await ask(`${brand("?")} Install ${andList(formulae)} with Homebrew? [Y/n] `);
    if (/^n/i.test(answer.trim())) return false;
  }

  spawnSync("brew", ["install", ...formulae], { stdio: "inherit" });
  return missing.every((dep) => probes.onPath(dep.binary));
}
