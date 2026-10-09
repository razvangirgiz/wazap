/**
 * The binaries wazap shells out to but does not ship, and the one prompt that
 * installs them. Homebrew for all of them; llama-server also has a pinned
 * llama.cpp release build wazap fetches itself where Homebrew is not there
 * (Linux, a Mac without brew). apt and the rest keep the fix line each caller
 * already prints.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ask } from "./cli.js";
import { paths, type Config } from "./config.js";
import { REAL_PROBES, type Probes } from "./connect.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { downloadFile } from "./model-download.js";
import {
  LLAMA_PIN,
  findLlama,
  llamaAssetFor,
  llamaBuild,
  readRecallSettings,
  type LlamaAsset,
} from "./recall/index.js";
import { setEnvSetting } from "./settings.js";
import { brand, info, ok } from "./ui.js";

export interface Dependency {
  binary: string;
  brew: string;
  why: string;
}

/** `whisper-cli` is the name Homebrew's whisper-cpp formula installs; findWhisper looks for it first. */
export const DEPS = {
  whisper: { binary: "whisper-cli", brew: "whisper-cpp", why: "transcribes voice messages locally" },
  ffmpeg: { binary: "ffmpeg", brew: "ffmpeg", why: "converts voice notes for whisper" },
  llama: { binary: "llama-server", brew: "llama.cpp", why: "embeds messages for local semantic recall" },
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
  probes: Probes = REAL_PROBES
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

/** Where the pinned llama.cpp build lives inside a data dir. */
export function llamaInstallDir(dataDir: string): string {
  return join(dataDir, "bin", "llama");
}

/**
 * Fetches the pinned llama.cpp build into `<data-dir>/bin/llama`, verified
 * against its sha256 like every model, unpacks it with the system tar, checks
 * that the binary runs, and points WAZAP_EMBED_BIN at it in the data dir's
 * .env. Its RUNPATH is $ORIGIN, so the absolute path is all it needs to find
 * the libraries beside it. Returns that path.
 */
export async function installLlamaPrebuilt(
  dataDir: string,
  asset: LlamaAsset,
  root: string = LLAMA_PIN.root
): Promise<string> {
  const dir = llamaInstallDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archive = join(dir, asset.file);
  const where = `the llama.cpp build into ${dir}`;
  await downloadFile({ url: asset.url, path: archive, sha256: asset.sha256, bytes: asset.bytes, command: "wazap embed download" }).catch((err: unknown) => {
    throw err instanceof WazapError
      ? new WazapError("RECALL_FAILED", `Could not fetch ${where}: ${err.message}`, err.fix ?? "Run `wazap embed download` again")
      : err;
  });
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", dir], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (unpacked.error !== undefined || unpacked.status !== 0) {
    throw new WazapError(
      "RECALL_FAILED",
      `Could not unpack ${asset.file}: ${unpacked.error?.message ?? unpacked.stderr.trim()}`,
      "Check that `tar` is installed, then run `wazap embed download` again"
    );
  }
  const bin = join(dir, root, "llama-server");
  if (llamaBuild(bin) === null) {
    throw new WazapError(
      "RECALL_FAILED",
      `The llama.cpp build in ${join(dir, root)} does not run on this machine.`,
      "Install llama.cpp another way and set WAZAP_EMBED_BIN to its llama-server"
    );
  }
  // Verified and unpacked: the archive is only a second copy now.
  rmSync(archive, { force: true });
  setEnvSetting(paths(dataDir).envFile, "WAZAP_EMBED_BIN", bin);
  process.env.WAZAP_EMBED_BIN = bin;
  return bin;
}

/** What `ensureLlama` found or installed; `bin` is null when llama-server is still missing. */
export interface LlamaOutcome {
  bin: string | null;
  how: "found" | "brew" | "prebuilt" | "missing";
}

/**
 * llama-server by every route there is: WAZAP_EMBED_BIN or PATH, then the
 * Homebrew offer on a Mac that has it, then the pinned release build. The
 * download is only taken with `--yes` or a yes typed at a terminal: it is the
 * one network fetch here that is not a model.
 */
export async function ensureLlama(
  config: Config,
  probes: Probes = REAL_PROBES,
  asset: LlamaAsset | null = llamaAssetFor()
): Promise<LlamaOutcome> {
  const settings = readRecallSettings(process.env, config.dataDir);
  const present = findLlama(settings);
  if (present !== null) return { bin: present, how: "found" };

  if (process.platform === "darwin" && !config.noBrew && probes.onPath("brew")) {
    await ensureDeps([DEPS.llama], config, probes);
    const brewed = findLlama(settings);
    if (brewed !== null) return { bin: brewed, how: "brew" };
  }

  if (asset === null) return { bin: null, how: "missing" };
  if (!config.assumeYes) {
    if (process.stdin.isTTY !== true) return { bin: null, how: "missing" };
    say(info(`${DEPS.llama.binary} is not installed; it ${DEPS.llama.why}.`));
    const answer = await ask(`${brand("?")} Download llama.cpp ${LLAMA_PIN.tag} (${Math.round(asset.bytes / 1_000_000)} MB) into the data dir? [Y/n] `);
    if (/^n/i.test(answer.trim())) return { bin: null, how: "missing" };
  }
  const bin = await installLlamaPrebuilt(config.dataDir, asset);
  say(ok(`llama.cpp ${LLAMA_PIN.tag} installed; WAZAP_EMBED_BIN points at it`));
  return { bin, how: "prebuilt" };
}
