import { readFileSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import { ask, describeAccount, downloadTranscribeModel, linkAndSync, runLiveProbe, serviceLive, stepper } from "./cli.js";
import { paths, type Config, type KeepRunning } from "./config.js";
import {
  CLIENTS,
  commandPath,
  connectClient,
  connectNext,
  detectClients,
  findClient,
  globalBinDir,
  installGlobally,
  launchCheck,
  mcpEntry,
  whereInstalled,
  type ClientSpec,
  type Install,
} from "./connect.js";
import { checkLines } from "./doctor.js";
import { WazapError } from "./errors.js";
import { PROVIDERS, runExpose, type TunnelProvider } from "./expose.js";
import { INSTALL_WAIT_MS, installService, pickSupervisor } from "./service.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import { applyTranscribe } from "./settings.js";
import { installSkills, skillTargetFor } from "./skills.js";
import { MODELS, findWhisper, localProvider, readTranscribeSettings, which } from "./transcribe/index.js";
import { brand, fail, fix, info, ok, warn } from "./ui.js";

export async function runSetup(config: Config): Promise<void> {
  // The whole output is the document and this command never serves, so stdout is
  // the right channel. AGENT.md sits at the package root, which is what `files`
  // publishes.
  if (config.agent) {
    process.stdout.write(readFileSync(new URL("../AGENT.md", import.meta.url), "utf8"));
    return;
  }

  say(banner());
  let install = whereInstalled();
  const announce = stepper(install.kind === "npx" ? 6 : 5);

  announce("Link");
  const account = readLinkedAccount(paths(config.dataDir).authDir);
  if (account) say(ok(`Already linked as ${describeAccount(account)}`));
  else await linkAndSync(config);

  // The spec puts this step after Permissions; linkAndSync asks the writes
  // question itself, at its own end, so here Transcribe follows Link directly.
  announce("Transcribe");
  await chooseTranscribe(config);

  if (install.kind === "npx") {
    announce("Install");
    install = await offerGlobalInstall(config, install);
  }

  announce("Connect");
  const chosen = await chooseClients(config);
  if (chosen.length === 0) {
    say(info("No client connected yet."));
    say(connectNext());
  }
  // The client choice is the answer to where the skills go, so setup never asks
  // a second question about them.
  for (const spec of chosen) {
    connectClient(spec, config, install);
    const target = skillTargetFor(spec.name);
    if (target) installSkills(target, config.dryRun);
    else say(info(`${spec.describe} gets the workflows from the server itself, as MCP prompts.`));
  }

  announce("Keep running");
  const keep = await chooseKeepRunning(config);
  if (keep !== "client") await installService(config, pickSupervisor(), INSTALL_WAIT_MS, install);
  if (keep === "expose" && !config.dryRun) await runExpose(config);

  announce("Finish");
  let failing = !(await proveSession(config));
  for (const spec of chosen) {
    const check = launchCheck(spec, mcpEntry(config, spec, install));
    if (check.state === "fail") failing = true;
    for (const line of checkLines(check)) say(line);
  }

  for (const spec of chosen) say(info(spec.next));
  say(failing ? warn("Setup finished with a failing check") : ok("Setup complete"));
  say("");
  say('Ask your agent: "what did I miss on WhatsApp today?"');
  if (failing) process.exit(1);
}

const NO_GLOBAL_NOTE = "Claude Desktop and `wazap service install` need a global install; run `npm i -g wazap-mcp` before either.";

/**
 * npx keeps no stable copy on disk, so Claude Desktop and the background service
 * have nothing to point at. Installing here is what lets the rest of this run
 * behave as a global install.
 */
async function offerGlobalInstall(config: Config, install: Install): Promise<Install> {
  say("wazap was started through npx, which keeps no stable copy on disk.");
  if (!(await askGlobal(config))) {
    say(info(NO_GLOBAL_NOTE));
    return install;
  }

  const check = installGlobally();
  for (const line of checkLines(check)) say(line);
  if (check.state !== "ok") return install;

  const bin = commandPath("wazap");
  if (bin !== null) return whereInstalled(bin);
  const dir = globalBinDir();
  say(warn(`wazap-mcp is installed, but \`wazap\` is not on your PATH${dir === null ? "" : `; add ${dir}`}.`));
  return install;
}

/** The question defaults to yes, and so does anything that cannot be asked. */
async function askGlobal(config: Config): Promise<boolean> {
  if (config.noGlobal) return false;
  if (config.assumeYes || process.stdin.isTTY !== true) return true;
  const answer = await ask(
    `${brand("?")} Install it globally so Claude Desktop and the background service can find it? [Y/n] `,
  );
  return !/^n/i.test(answer.trim());
}

/**
 * Whether the session really connects, which is the failure `setup` used to
 * leave for the first tool call inside a client. False only when the probe ran
 * and could not reach WhatsApp.
 */
async function proveSession(config: Config): Promise<boolean> {
  const p = paths(config.dataDir);
  if (config.dryRun || readLinkedAccount(p.authDir) === null) return true;

  // The service holds the session, so nothing else may open it. Its /healthz is
  // the only honest answer left, and it is the one the tunnel sees too.
  const running = lockHolder(p.lockFile);
  if (running !== null) {
    const served = await serviceLive(config, running);
    if (served === null) {
      say(info(`A server already holds the session (pid ${running}); skipping the live check.`));
      return true;
    }
    if (served.reachable) {
      say(ok("Connected · the wazap service holds the session"));
      return true;
    }
    say(fail(`the service reports ${served.reason ?? "no connection"}`));
    say(fix("run `wazap service logs`"));
    return false;
  }

  const live = await runLiveProbe(config);
  if (live.reachable) {
    say(ok(live.chats === null ? "Connected" : `Connected · ${live.chats} chats`));
    return true;
  }
  say(fail(live.reason ?? "no connection"));
  say(fix("run `wazap status --live` after fixing it"));
  return false;
}

const CHOICE_ATTEMPTS = 3;

const KEEP_OPTIONS: readonly { choice: KeepRunning; describe: string }[] = [
  { choice: "client", describe: "Only while a client has it open" },
  { choice: "service", describe: "Always, on this machine            (wazap service install)" },
  { choice: "expose", describe: "Always, and reachable by cloud agents   (also wazap expose)" },
];

/** Offering a public URL with nothing to tunnel through would be a dead end. */
export function keepRunningOptions(providers: readonly TunnelProvider[] = PROVIDERS): typeof KEEP_OPTIONS {
  return providers.some((provider) => provider.available()) ? KEEP_OPTIONS : KEEP_OPTIONS.slice(0, 2);
}

/** Only while a client has it open, unless a flag or a person says otherwise. */
async function chooseKeepRunning(config: Config): Promise<KeepRunning> {
  if (config.keepRunning !== null) return config.keepRunning;
  if (config.assumeYes || process.stdin.isTTY !== true) return "client";

  const options = keepRunningOptions();
  say("Keep wazap running?");
  options.forEach((option, index) => say(`  ${index + 1}. ${option.describe}`));
  for (let attempt = 1; ; attempt++) {
    const answer = (await ask(`${brand("?")} Choose: [1] (enter to accept) `)).trim();
    if (answer === "") return "client";
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) return options[picked - 1]!.choice;
    if (attempt === CHOICE_ATTEMPTS) return "client";
    say(fail(`Type a number from 1 to ${options.length}.`));
  }
}

const TRANSCRIBE_OPTIONS: readonly { choice: string; describe: string }[] = [
  {
    choice: "local",
    describe: `Locally with whisper.cpp — free and private, downloads a ${Math.round(MODELS.turbo.bytes / 1_000_000)} MB model`,
  },
  { choice: "openai", describe: "OpenAI-compatible API — needs a key, audio leaves this machine" },
  { choice: "off", describe: "Not now" },
];

const TRANSCRIBE_CHOICES = TRANSCRIBE_OPTIONS.map((option) => option.choice);

async function chooseTranscribe(config: Config): Promise<void> {
  const flagged = config.transcribeChoice;
  if (flagged !== undefined && !TRANSCRIBE_CHOICES.includes(flagged)) {
    throw new WazapError("INVALID_ID", `Unknown --transcribe ${flagged}.`, `Use --transcribe ${TRANSCRIBE_CHOICES.join("|")}`);
  }

  const choice = flagged ?? (await askTranscribe(config));
  if (choice === null) {
    say(info("Transcription stays off. Turn it on with `wazap config transcribe local`."));
    return;
  }

  // The local report is left to installModel below, which knows whether the gap
  // it would announce is one setup is about to close.
  await applyTranscribe(config, choice, choice !== "local");
  if (choice === "local") await installModel(config);
}

/** Null when nobody is there to answer, which leaves the setting alone. */
async function askTranscribe(config: Config): Promise<string | null> {
  if (config.assumeYes || process.stdin.isTTY !== true) return null;

  say("Transcribe voice messages?");
  TRANSCRIBE_OPTIONS.forEach((option, index) => say(`  ${index + 1}. ${option.describe}`));
  for (let attempt = 1; ; attempt++) {
    const answer = (await ask(`${brand("?")} Choose: [3] (enter to accept) `)).trim();
    if (answer === "") return "off";
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= TRANSCRIBE_OPTIONS.length) {
      return TRANSCRIBE_OPTIONS[picked - 1]!.choice;
    }
    if (attempt === CHOICE_ATTEMPTS) return null;
    say(fail(`Type a number from 1 to ${TRANSCRIBE_OPTIONS.length}.`));
  }
}

/** The model is 574 MB and unusable without the binaries, so those come first. */
async function installModel(config: Config): Promise<void> {
  const settings = readTranscribeSettings({ ...process.env, WAZAP_TRANSCRIBE: "local" }, config.dataDir);
  if (findWhisper(settings) === null || which("ffmpeg") === null) {
    const readiness = await localProvider.ready(settings);
    say(warn(readiness.detail));
    if (readiness.fix !== undefined) say(fix(readiness.fix));
    say(info("Setup continues. Run `wazap transcribe download` once they are installed."));
    return;
  }
  await downloadTranscribeModel(settings, MODELS[settings.model]);
}

/**
 * The whole table is printed, not only what was found: that is what makes the
 * numbers and "all" mean something, and it lets someone pick a client the
 * probes missed.
 */
async function chooseClients(config: Config): Promise<ClientSpec[]> {
  if (config.clients.length > 0) return config.clients.map(findClient);

  const detected = detectClients();
  if (config.assumeYes || process.stdin.isTTY !== true) return detected;

  CLIENTS.forEach((spec, index) => {
    say(`  ${index + 1}. [${detected.includes(spec) ? "x" : " "}] ${spec.describe}`);
  });
  const suggested = detected.map((spec) => CLIENTS.indexOf(spec) + 1).join(",");

  for (let attempt = 1; ; attempt++) {
    const answer = await ask(
      `${brand("?")} Connect to: [${suggested}] (enter to accept, or type numbers, "all", "none") `,
    );
    const picked = parseChoice(answer, detected);
    if (picked !== null) return picked;
    if (attempt === CHOICE_ATTEMPTS) return detected;
    say(fail('Type numbers from the list, "all", or "none".'));
  }
}

/** Null when the answer names something that is not on the list. */
export function parseChoice(answer: string, detected: readonly ClientSpec[]): ClientSpec[] | null {
  const text = answer.trim();
  if (text === "") return [...detected];
  if (/^all$/i.test(text)) return [...CLIENTS];
  if (/^none$/i.test(text)) return [];

  const picked = new Set<ClientSpec>();
  for (const token of text.split(/[\s,]+/)) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > CLIENTS.length) return null;
    picked.add(CLIENTS[n - 1]!);
  }
  return [...picked];
}
