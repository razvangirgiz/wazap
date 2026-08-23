import { readFileSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import { ask, describeAccount, downloadTranscribeModel, linkAndSync, stepper } from "./cli.js";
import { paths, type Config } from "./config.js";
import { CLIENTS, connectClient, connectNext, detectClients, findClient, type ClientSpec } from "./connect.js";
import { WazapError } from "./errors.js";
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
  const announce = stepper(4);

  announce("Link");
  const account = readLinkedAccount(paths(config.dataDir).authDir);
  if (account) say(ok(`Already linked as ${describeAccount(account)}`));
  else await linkAndSync(config);

  // The spec puts this step after Permissions; linkAndSync asks the writes
  // question itself, at its own end, so here Transcribe follows Link directly.
  announce("Transcribe");
  await chooseTranscribe(config);

  announce("Connect");
  const chosen = await chooseClients(config);
  if (chosen.length === 0) {
    say(info("No client connected yet."));
    say(connectNext());
  }
  // The client choice is the answer to where the skills go, so setup never asks
  // a second question about them.
  for (const spec of chosen) {
    connectClient(spec, config);
    const target = skillTargetFor(spec.name);
    if (target) installSkills(target, config.dryRun);
    else say(info(`${spec.describe} gets the workflows from the server itself, as MCP prompts.`));
  }

  announce("Finish");
  say(ok("Setup complete"));
  for (const spec of chosen) say(info(spec.next));
  say("");
  say('Ask your agent: "what did I miss on WhatsApp today?"');
}

const CHOICE_ATTEMPTS = 3;

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
