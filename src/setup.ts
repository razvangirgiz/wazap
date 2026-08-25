import { readFileSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import { ask, describeAccount, downloadTranscribeModel, linkAndSync, runLiveProbe, serviceLive, stepper } from "./cli.js";
import { paths, type Config, type KeepRunning } from "./config.js";
import {
  CLIENTS,
  REAL_PROBES,
  appRunning,
  connectClient,
  connectNext,
  detectClients,
  findClient,
  globalBinDir,
  installGlobally,
  launchCheck,
  mcpEntry,
  relaunch,
  stableWazap,
  whereInstalled,
  type ClientSpec,
  type Install,
  type Probes,
} from "./connect.js";
import { DEPS, ensureDeps } from "./deps.js";
import { checkLines } from "./doctor.js";
import { WazapError } from "./errors.js";
import { PROVIDERS, runExpose, type TunnelProvider } from "./expose.js";
import { INSTALL_WAIT_MS, installService, pickSupervisor } from "./service.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import { applyTranscribe } from "./settings.js";
import { installSkills, skillTargetFor } from "./skills.js";
import { MODELS, findWhisper, localProvider, readTranscribeSettings, which } from "./transcribe/index.js";
import { brand, fail, fix, humanLayout, info, ok, warn } from "./ui.js";
import {
  maybeWizard,
  setupWizardSteps,
  wizFail,
  wizInfo,
  wizOk,
  wizWarn,
  type Wizard,
} from "./wizard.js";

export async function runSetup(config: Config): Promise<void> {
  // The whole output is the document and this command never serves, so stdout is
  // the right channel. AGENT.md sits at the package root, which is what `files`
  // publishes.
  if (config.agent) {
    process.stdout.write(readFileSync(new URL("../AGENT.md", import.meta.url), "utf8"));
    return;
  }

  if (!humanLayout()) say(banner());
  let install = whereInstalled();
  const announce = stepper(install.kind === "npx" ? 6 : 5);

  const account = readLinkedAccount(paths(config.dataDir).authDir);
  const askWrites = config.writesAnswer === null && !config.assumeYes && process.stdin.isTTY === true;
  const w = maybeWizard(
    setupWizardSteps({
      linked: account !== null,
      npx: install.kind === "npx",
      askWrites,
      loginCode: Boolean(config.loginCode),
    }),
  );

  try {
    await runSetupSteps(config, { account, install, announce, w });
  } finally {
    w?.close();
  }
}

async function runSetupSteps(
  config: Config,
  ctx: {
    account: ReturnType<typeof readLinkedAccount>;
    install: Install;
    announce: ReturnType<typeof stepper>;
    w: Wizard | null;
  },
): Promise<void> {
  let { install } = ctx;
  const { account, announce, w } = ctx;

  if (account) {
    if (!w) {
      announce("Link");
      say(ok(`Already linked as ${describeAccount(account)}`));
    }
  } else {
    if (!w) announce("Link");
    await linkAndSync(config, () => {}, w);
  }

  // The spec puts this step after Permissions; linkAndSync asks the writes
  // question itself, at its own end, so here Transcribe follows Link directly.
  if (!w) announce("Transcribe");
  await chooseTranscribe(config, w, account && w ? [wizOk(`Already linked as ${describeAccount(account)}`)] : []);

  if (install.kind === "npx") {
    if (!w) announce("Install");
    install = await offerGlobalInstall(config, install, w);
  }

  if (!w) announce("Connect");
  const chosen = await chooseClients(config, w);
  if (chosen.length === 0 && !w) {
    say(info("No client connected yet."));
    say(connectNext());
  }
  const restarted = new Set<ClientSpec>();
  const notes: string[] = [];
  if (chosen.length === 0) notes.push(wizInfo("No client connected yet."), connectNext());
  for (const spec of chosen) {
    connectClient(spec, config, install);
    const target = skillTargetFor(spec.name);
    if (target) installSkills(target, config.dryRun);
    else {
      const line = `${spec.describe} gets the workflows from the server itself, as MCP prompts.`;
      if (w) notes.push(wizInfo(line));
      else say(info(line));
    }
    if (await offerRelaunch(spec, config, w)) restarted.add(spec);
  }

  if (!w) announce("Keep running");
  const keep = await chooseKeepRunning(config, w);
  if (keep !== "client") {
    if (install.kind === "npx") {
      const bin = stableWazap();
      if (bin !== null) install = whereInstalled(bin);
    }
    if (install.kind === "npx") {
      const message = "wazap is running out of the npx cache, which npm clears; a service cannot point at it.";
      const repair = "run `npm i -g wazap-mcp`, then `wazap service install` again";
      if (w) notes.push(wizFail(message), `  → ${repair}`);
      else {
        say(fail(message));
        say(fix(repair));
      }
    } else {
      await installService(config, pickSupervisor(), INSTALL_WAIT_MS, install);
    }
  }
  if (keep === "expose" && !config.dryRun && install.kind !== "npx") await runExpose(config);

  const finish: string[] = [...notes];
  if (w) await w.next("Finish", finish, { reveal: false });
  else announce("Finish");
  let failing = !(await proveSession(config, w, finish));
  for (const spec of chosen) {
    const check = launchCheck(spec, mcpEntry(config, spec, install));
    if (check.state === "fail") failing = true;
    for (const line of checkLines(check)) {
      if (w) finish.push(line);
      else say(line);
    }
  }

  for (const spec of chosen) {
    const line = restarted.has(spec) ? `${spec.describe} restarted` : spec.next;
    if (w) finish.push(restarted.has(spec) ? wizOk(line) : wizInfo(line));
    else say(restarted.has(spec) ? ok(`${spec.describe} restarted`) : info(spec.next));
  }
  if (w) {
    finish.push(failing ? wizWarn("Setup finished with a failing check") : wizOk("Setup complete"));
    finish.push("");
    finish.push('Ask your agent: "what did I miss on WhatsApp today?"');
    await w.paint(finish);
  } else {
    say(failing ? warn("Setup finished with a failing check") : ok("Setup complete"));
    say("");
    say('Ask your agent: "what did I miss on WhatsApp today?"');
  }
  if (failing) process.exit(1);
}

const NO_GLOBAL_NOTE = "Claude Desktop and `wazap service install` need a global install; run `npm i -g wazap-mcp` before either.";

/**
 * npx keeps no stable copy on disk, so Claude Desktop and the background service
 * have nothing to point at. Installing here is what lets the rest of this run
 * behave as a global install.
 */
async function offerGlobalInstall(config: Config, install: Install, w: Wizard | null = null): Promise<Install> {
  const lead = "wazap was started through npx, which keeps no stable copy on disk.";
  if (w) await w.next("Install", [lead]);
  else say(lead);
  if (!(await askGlobal(config, w))) {
    if (w) await w.paint([lead, "", wizInfo(NO_GLOBAL_NOTE)], { reveal: false });
    else say(info(NO_GLOBAL_NOTE));
    return install;
  }

  const check = installGlobally();
  for (const line of checkLines(check)) say(line);
  if (check.state !== "ok") return install;

  const bin = stableWazap();
  if (bin !== null) return whereInstalled(bin);
  const dir = globalBinDir();
  say(warn(`wazap-mcp is installed, but \`wazap\` is not on your PATH${dir === null ? "" : `; add ${dir}`}.`));
  return install;
}

/**
 * The one client whose "Restart X" setup can carry out itself. Asked only when
 * the app is already running, because restarting nothing answers nothing.
 */
/**
 * `--yes` is not a yes here: an agent running setup from inside Claude Desktop
 * would quit itself. A person at the prompt, or `--relaunch`, is the answer.
 */
async function offerRelaunch(spec: ClientSpec, config: Config, w: Wizard | null = null): Promise<boolean> {
  const app = spec.relaunch?.app;
  if (app === undefined || config.dryRun) return false;
  if (!appRunning(app)) return false;
  if (!config.relaunch) {
    if (process.stdin.isTTY !== true || config.assumeYes) return false;
    const question = `Restart ${spec.describe} now so it picks up wazap? [Y/n] `;
    const answer = w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`);
    if (/^n/i.test(answer.trim())) return false;
  }
  return relaunch(app);
}

/** Writing to the npm prefix takes a person or `--yes`; a pipe gets no install. */
async function askGlobal(config: Config, w: Wizard | null = null): Promise<boolean> {
  if (config.noGlobal) return false;
  if (config.assumeYes) return true;
  if (process.stdin.isTTY !== true) return false;
  const question = "Install it globally so Claude Desktop and the background service can find it? [Y/n] ";
  const answer = w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`);
  return !/^n/i.test(answer.trim());
}

/**
 * Whether the session really connects, which is the failure `setup` used to
 * leave for the first tool call inside a client. False only when the probe ran
 * and could not reach WhatsApp.
 */
async function proveSession(config: Config, w: Wizard | null = null, buf: string[] = []): Promise<boolean> {
  const put = (line: string): void => {
    if (w) buf.push(line);
    else say(line);
  };
  const p = paths(config.dataDir);
  if (config.dryRun || readLinkedAccount(p.authDir) === null) return true;

  // The service holds the session, so nothing else may open it. Its /healthz is
  // the only honest answer left, and it is the one the tunnel sees too.
  const running = lockHolder(p.lockFile);
  if (running !== null) {
    const served = await serviceLive(config, running);
    if (served === null) {
      put(w ? wizInfo(`A server already holds the session (pid ${running}); skipping the live check.`) : info(`A server already holds the session (pid ${running}); skipping the live check.`));
      return true;
    }
    if (served.reachable) {
      put(w ? wizOk("Connected · the wazap service holds the session") : ok("Connected · the wazap service holds the session"));
      return true;
    }
    put(w ? wizFail(`the service reports ${served.reason ?? "no connection"}`) : fail(`the service reports ${served.reason ?? "no connection"}`));
    put(w ? `  → run \`wazap service logs\`` : fix("run `wazap service logs`"));
    return false;
  }

  const live = await runLiveProbe(config);
  if (live.reachable) {
    const line = live.chats === null ? "Connected" : `Connected · ${live.chats} chats`;
    put(w ? wizOk(line) : ok(line));
    return true;
  }
  put(w ? wizFail(live.reason ?? "no connection") : fail(live.reason ?? "no connection"));
  put(w ? "  → run `wazap status --live` after fixing it" : fix("run `wazap status --live` after fixing it"));
  return false;
}

const CHOICE_ATTEMPTS = 3;

const KEEP_OPTIONS: readonly { choice: KeepRunning; describe: string }[] = [
  { choice: "client", describe: "Only while a client has it open" },
  { choice: "service", describe: "Always, on this machine            (wazap service install)" },
  { choice: "expose", describe: "Always, and reachable by cloud agents   (also wazap expose)" },
];

/**
 * Offering a public URL with nothing to tunnel through would be a dead end, and
 * Homebrew is one prompt away from a tunnel, so it counts as something.
 */
export function keepRunningOptions(
  providers: readonly TunnelProvider[] = PROVIDERS,
  probes: Probes = REAL_PROBES,
): typeof KEEP_OPTIONS {
  const reachable = providers.some((provider) => provider.available()) || probes.onPath("brew");
  return reachable ? KEEP_OPTIONS : KEEP_OPTIONS.slice(0, 2);
}

/** Only while a client has it open, unless a flag or a person says otherwise. */
async function chooseKeepRunning(config: Config, w: Wizard | null = null): Promise<KeepRunning> {
  if (config.keepRunning !== null) return config.keepRunning;
  if (config.assumeYes || process.stdin.isTTY !== true) return "client";

  const options = keepRunningOptions();
  const menu = ["Keep wazap running?", ...options.map((option, index) => `  ${index + 1}. ${option.describe}`)];
  if (w) await w.next("Keep running", menu);
  else {
    for (const line of menu) say(line);
  }
  for (let attempt = 1; ; attempt++) {
    const question = "Choose: [1] (enter to accept) ";
    const answer = (w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`)).trim();
    if (answer === "") return "client";
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) return options[picked - 1]!.choice;
    if (attempt === CHOICE_ATTEMPTS) return "client";
    if (w) await w.paint([...menu, wizFail(`Type a number from 1 to ${options.length}.`)], { reveal: false });
    else say(fail(`Type a number from 1 to ${options.length}.`));
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

async function chooseTranscribe(config: Config, w: Wizard | null = null, preface: string[] = []): Promise<void> {
  const flagged = config.transcribeChoice;
  if (flagged !== undefined && !TRANSCRIBE_CHOICES.includes(flagged)) {
    throw new WazapError("INVALID_ID", `Unknown --transcribe ${flagged}.`, `Use --transcribe ${TRANSCRIBE_CHOICES.join("|")}`);
  }

  if (flagged !== undefined && w) await w.next("Transcribe", preface);
  const choice = flagged ?? (await askTranscribe(config, w, preface));
  if (choice === null) {
    const line = "Transcription stays off. Turn it on with `wazap config transcribe local`.";
    if (w) await w.next("Transcribe", [...preface, ...(preface.length > 0 ? [""] : []), wizInfo(line)]);
    else say(info(line));
    return;
  }

  // The local report is left to installModel below, which knows whether the gap
  // it would announce is one setup is about to close.
  await applyTranscribe(config, choice, choice !== "local");
  if (choice === "local") await installModel(config);
}

/** Null when nobody is there to answer, which leaves the setting alone. */
async function askTranscribe(config: Config, w: Wizard | null = null, preface: string[] = []): Promise<string | null> {
  if (config.assumeYes || process.stdin.isTTY !== true) return null;

  const menu = [
    ...preface,
    ...(preface.length > 0 ? [""] : []),
    "Transcribe voice messages?",
    ...TRANSCRIBE_OPTIONS.map((option, index) => `  ${index + 1}. ${option.describe}`),
  ];
  if (w) await w.next("Transcribe", menu);
  else for (const line of menu) say(line);
  for (let attempt = 1; ; attempt++) {
    const question = "Choose: [3] (enter to accept) ";
    const answer = (w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`)).trim();
    if (answer === "") return "off";
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= TRANSCRIBE_OPTIONS.length) {
      return TRANSCRIBE_OPTIONS[picked - 1]!.choice;
    }
    if (attempt === CHOICE_ATTEMPTS) return null;
    if (w) await w.paint([...menu, wizFail(`Type a number from 1 to ${TRANSCRIBE_OPTIONS.length}.`)], { reveal: false });
    else say(fail(`Type a number from 1 to ${TRANSCRIBE_OPTIONS.length}.`));
  }
}

/** The model is 574 MB and unusable without the binaries, so those come first. */
async function installModel(config: Config): Promise<void> {
  const settings = readTranscribeSettings({ ...process.env, WAZAP_TRANSCRIBE: "local" }, config.dataDir);
  await ensureDeps([DEPS.whisper, DEPS.ffmpeg], config);
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
async function chooseClients(config: Config, w: Wizard | null = null): Promise<ClientSpec[]> {
  if (config.clients.length > 0) return config.clients.map(findClient);

  const detected = detectClients();
  if (config.assumeYes || process.stdin.isTTY !== true) return detected;

  const menu = CLIENTS.map(
    (spec, index) => `  ${index + 1}. [${detected.includes(spec) ? "x" : " "}] ${spec.describe}`,
  );
  const suggested = detected.map((spec) => CLIENTS.indexOf(spec) + 1).join(",");
  if (w) await w.next("Connect", menu);
  else for (const line of menu) say(line);

  for (let attempt = 1; ; attempt++) {
    const question = `Connect to: [${suggested}] (enter to accept, or type numbers, "all", "none") `;
    const answer = w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`);
    const picked = parseChoice(answer, detected);
    if (picked !== null) return picked;
    if (attempt === CHOICE_ATTEMPTS) return detected;
    if (w) await w.paint([...menu, wizFail('Type numbers from the list, "all", or "none".')], { reveal: false });
    else say(fail('Type numbers from the list, "all", or "none".'));
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
