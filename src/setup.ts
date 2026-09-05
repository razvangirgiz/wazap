import { chatgptSetup, chatgptConnectionGuide, effectiveChatgptConfig } from "./chatgpt.js";
import { loginThroughDaemon } from "./accounts-cli.js";
import { Accounts } from "./accounts.js";
import { readDaemon } from "./daemon.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import {
  ask,
  chooseLoginCode,
  leftoverRefusal,
  describeAccount,
  downloadTranscribeModel,
  linkAndSync,
  runLiveProbe,
  stepper,
} from "./cli.js";
import { WAZAP_VERSION, paths, type Config, type KeepRunning } from "./config.js";
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
  // the right channel. USE-ME.md sits at the package root, which is what `files`
  // publishes.
  if (config.agent) {
    process.stdout.write(readFileSync(new URL("../USE-ME.md", import.meta.url), "utf8"));
    return;
  }

  if (config.transcribeChoice && !["local", "openai", "off"].includes(config.transcribeChoice))
    throw new WazapError("INVALID_ID", `Unknown --transcribe ${config.transcribeChoice}.`, "Use --transcribe local|openai|off.");
  const selected = await chooseSetupClients(config);
  if (selected.length) config = await chooseSetupAccount(config);
  if (config.dryRun) {
    say("Simulation only — no files, settings, connections, installations or services changed.");
    say(selected.length ? `Destination: ${selected.join(", ")}` : "Destination: not selected");
    say("Would link or reuse the selected WhatsApp account, configure the chosen client, then verify the connection.");
    if (selected.includes("chatgpt")) for (const step of chatgptConnectionGuide(config).steps) say(`- ${step}`);
    if (config.transcribeChoice) say(`Would set transcription to ${config.transcribeChoice}.`);
    else say("Existing transcription settings would be kept.");
    say("Simulation finished. No connection has been verified.");
    return;
  }
  if (selected.length === 0) {
    say("Setup paused — choose where to use Wazap with `wazap setup --client chatgpt` or a local client.");
    return;
  }
  if (!humanLayout()) say(banner());
  let install = whereInstalled();
  say(`Using Wazap ${WAZAP_VERSION} from ${install.script}.`);
  if (install.kind === "checkout") say("Client configuration will use this checkout, not a different wazap command on PATH.");
  const announce = stepper(install.kind === "npx" ? 6 : 5);

  const account = readLinkedAccount(paths(config.dataDir).authDir);
  const rootPaths = paths(config.rootDataDir ?? config.dataDir);
  const daemon = readDaemon(rootPaths.daemonFile);
  const shared = !!config.accountId && !!daemon && lockHolder(rootPaths.lockFile) === daemon.pid;
  if (account === null && !shared) {
    const refusal = leftoverRefusal(config);
    if (refusal !== null) throw refusal;
  }
  const askWrites = config.writesAnswer === null && !config.assumeYes && process.stdin.isTTY === true;
  const loginCode = account !== null ? config.loginCode : shared ? true : await chooseLoginCode(config);
  const resolved = { ...config, loginCode };
  const w = maybeWizard(
    setupWizardSteps({
      linked: account !== null || shared,
      npx: install.kind === "npx",
      askWrites,
      loginCode,
    }) + (account === null && shared ? 1 : 0),
  );

  try {
    await runSetupSteps(resolved, { account, install, announce, w, selected, shared });
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
    selected: string[];
    shared: boolean;
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
    else if (ctx.shared) await w.next("Link", ["The running Wazap service will link this account."]);
    const bridged = await loginThroughDaemon(config, async () => {
      if (config.loginPhone) return config.loginPhone;
      return w ? w.prompt("Your WhatsApp number, including country code: ") : ask("Your WhatsApp number, including country code: ");
    });
    if (!bridged) await linkAndSync(config, () => {}, w);
  }

  if (install.kind === "npx") {
    if (!w) announce("Install");
    install = await offerGlobalInstall(config, install, w);
  }

  if (!w) announce("Connect");
  const chatgpt = ctx.selected.includes("chatgpt");
  const chosen = ctx.selected.filter((name) => name !== "chatgpt").map(findClient);
  if (w) await w.next("Connect", [account ? wizOk(`Already linked as ${describeAccount(account)}`) : "WhatsApp account linked."]);

  if (chosen.length === 0 && !chatgpt && !w) {
    say(info("No client connected yet."));
    say(connectNext());
  }
  const restarted = new Set<ClientSpec>();
  const notes: string[] = [];
  if (chosen.length === 0 && !chatgpt) notes.push(wizInfo("No client connected yet."), connectNext());
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
  const keep = chatgpt ? "client" : await chooseKeepRunning(config, w);
  let chatgptReady = false;
  if (chatgpt) {
    if (w) await w.next("ChatGPT", []);
    chatgptReady = await chatgptSetup(config, { install, wizard: w, remember: (line) => notes.push(line) });
  }
  if (keep !== "client") {
    if (install.kind === "npx") {
      const bin = stableWazap();
      if (bin !== null) install = whereInstalled(bin);
    }
    if (install.kind === "npx") {
      const message = "wazap is running out of the npx cache, which npm clears; a service cannot point at it.";
      const repair = `run \`npm i -g wazap-mcp@${WAZAP_VERSION}\`, then \`wazap service install\` again`;
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

  // Transcription is optional, after the connection steps. Never change it by default.
  if (!w) announce("Transcribe");
  await chooseTranscribe(config, w);
  const finish: string[] = [...notes];
  if (w) await w.next("Finish", finish, { reveal: false });
  else announce("Finish");
  const session = await proveSession(config, w, finish);
  let failing = session === "failed";
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
  const summary = failing ? "Setup finished with a failing check"
    : session === "version_mismatch" ? "Setup saved — the running service uses a different version"
    : chatgpt && !chatgptReady ? "Setup saved — ChatGPT connection still needs attention"
    : session !== "verified" ? "Setup saved — WhatsApp connection not verified"
    : "WhatsApp connected — verify the first read in your client";
  const nextStep = session === "version_mismatch"
    ? "Rerun this same setup with --service to use this installation for the background service. Then verify the first read in your client."
    : chatgpt
    ? 'In ChatGPT, enable Wazap and ask: "List my WhatsApp accounts." Setup is complete only when that succeeds.'
    : 'Open your chosen client and ask: "List my WhatsApp accounts." Client configuration alone does not verify access.';
  if (w) {
    finish.push(failing ? wizWarn(summary) : wizInfo(summary), "", nextStep);
    await w.paint(finish, { reveal: false });
    w.close();
  }
  // Retain the outcome in ordinary terminal scrollback after the alternate screen closes.
  say(summary);
  say(nextStep);
  if (chatgpt) {
    for (const line of notes) say(line);
    const guide = chatgptConnectionGuide(effectiveChatgptConfig(config, true));
    if (guide.endpoint) say(`MCP URL: ${guide.endpoint}`);
    say(guide.docs);
  }
  if (failing) process.exitCode = 1;
}

const NO_GLOBAL_NOTE = `Claude Desktop and \`wazap service install\` need a global install; run \`npm i -g wazap-mcp@${WAZAP_VERSION}\` before either.`;

/**
 * npx keeps no stable copy on disk, so Claude Desktop and the background service
 * have nothing to point at. Installing here is what lets the rest of this run
 * behave as a global install.
 */
async function offerGlobalInstall(config: Config, install: Install, w: Wizard | null = null): Promise<Install> {
  const lead = "wazap was started through npx, which keeps no stable copy on disk.";
  if (w) await w.next("Install", [lead]);
  else say(lead);
  if (config.dryRun || !(await askGlobal(config, w))) {
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
async function proveSession(config: Config, w: Wizard | null = null, buf: string[] = []): Promise<"verified" | "unverified" | "failed" | "version_mismatch"> {
  const put = (line: string): void => {
    if (w) buf.push(line);
    else say(line);
  };
  const p = paths(config.dataDir);
  if (config.dryRun || readLinkedAccount(p.authDir) === null) return "unverified";

  const rootPaths = paths(config.rootDataDir ?? config.dataDir);
  const running = lockHolder(rootPaths.lockFile) ?? lockHolder(p.lockFile);
  if (running !== null) {
    const daemon = readDaemon(rootPaths.daemonFile);
    if (!daemon || daemon.pid !== running) {
      put(w ? wizInfo(`A server already holds the session (pid ${running}); skipping the live check.`) : info(`A server already holds the session (pid ${running}); skipping the live check.`));
      return "unverified";
    }
    const client = new Client({ name: "wazap-setup-check", version: WAZAP_VERSION });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${daemon.token}`, "x-wazap-read-only": "1" }, signal: AbortSignal.timeout(5_000) },
      }));
      const result = await client.callTool({ name: "get_status", arguments: config.accountId ? { account_id: config.accountId } : {} }, undefined, { timeout: 5_000 });
      const status = result.structuredContent as Record<string, unknown> | undefined;
      const version = client.getServerVersion()?.version;
      if (version !== WAZAP_VERSION) put(`Running service: ${version ?? "unknown"}; this setup: ${WAZAP_VERSION}. Update the service before using new features.`);
      if (!result.isError && status?.status === "connected") {
        put(w ? wizOk("Connected · the wazap service holds the session") : ok("Connected · the wazap service holds the session"));
        return version === WAZAP_VERSION ? "verified" : "version_mismatch";
      }
      put(`The selected account reports ${status?.status ?? "an unavailable status"}. Run wazap status to diagnose it.`);
      return "failed";
    } catch {
      put("Could not read account status from the running service. Run wazap service status and retry; do not link the account again.");
      return "unverified";
    } finally { await client.close().catch(() => {}); }
  }

  const live = await runLiveProbe(config);
  if (live.reachable) {
    const line = live.chats === null ? "Connected" : `Connected · ${live.chats} chats`;
    put(w ? wizOk(line) : ok(line));
    return "verified";
  }
  put(w ? wizFail(live.reason ?? "no connection") : fail(live.reason ?? "no connection"));
  put(w ? "  → run `wazap status --live` after fixing it" : fix("run `wazap status --live` after fixing it"));
  return "failed";
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
  { choice: "keep", describe: "Later — keep current settings" },
];

const TRANSCRIBE_CHOICES = ["local", "openai", "off"];

async function chooseTranscribe(config: Config, w: Wizard | null = null, preface: string[] = []): Promise<void> {
  const flagged = config.transcribeChoice;
  if (flagged !== undefined && !TRANSCRIBE_CHOICES.includes(flagged)) {
    throw new WazapError("INVALID_ID", `Unknown --transcribe ${flagged}.`, `Use --transcribe ${TRANSCRIBE_CHOICES.join("|")}`);
  }

  if (flagged !== undefined && w) await w.next("Transcribe", preface);
  const choice = flagged ?? (await askTranscribe(config, w, preface));
  if (choice === null || choice === "keep") {
    const line = "Transcription settings kept. You can configure voice messages later with `wazap config transcribe`.";
    if (w) {
      const body = [...preface, ...(preface.length > 0 ? [""] : []), wizInfo(line)];
      if (!config.assumeYes && process.stdin.isTTY) await w.paint(body, { reveal: false });
      else await w.next("Transcribe", body, { reveal: false });
    }
    else say(info(line));
    return;
  }

  // The local report is left to installModel below, which knows whether the gap
  // it would announce is one setup is about to close.
  await applyTranscribe(config, choice, choice !== "local");
  if (choice === "local" && !config.dryRun) await installModel(config);
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
    if (answer === "") return "keep";
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
export const SETUP_CLIENTS = ["chatgpt", ...CLIENTS.map((c) => c.name)];

export function parseSetupChoice(answer: string): string[] | null {
  const value = answer.trim().toLowerCase();
  if (!value || value === "none") return [];
  const result: string[] = [];
  for (const token of value.split(/[\s,]+/)) {
    const name = /^\d+$/.test(token) ? SETUP_CLIENTS[Number(token) - 1] : token;
    if (!name || !SETUP_CLIENTS.includes(name)) return null;
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

async function chooseSetupClients(config: Config): Promise<string[]> {
  if (config.clients.length) {
    for (const name of config.clients) if (!SETUP_CLIENTS.includes(name))
      throw new WazapError("INVALID_ID", `Unknown client "${name}".`, `Pick one of: ${SETUP_CLIENTS.join(", ")}`);
    return [...new Set(config.clients)];
  }
  const detected = detectClients();
  if (config.assumeYes || !process.stdin.isTTY) return detected.length === 1 ? [detected[0]!.name] : [];
  say("Where do you want to use WhatsApp?");
  for (const [index, name] of SETUP_CLIENTS.entries())
    say(`  ${index + 1}. ${name === "chatgpt" ? "ChatGPT" : findClient(name).describe}`);
  for (let attempt = 0; attempt < CHOICE_ATTEMPTS; attempt++) {
    const answer = await ask('Choose a name or number (Enter to decide later): ');
    const choice = parseSetupChoice(answer);
    if (choice !== null) return choice;
    say("Choose a name or number from the list. No clients have been configured.");
  }
  throw new WazapError("INVALID_ID", "No valid client selected.", "Run setup again, or use --client chatgpt.");
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


async function chooseSetupAccount(config: Config): Promise<Config> {
  const registry = new Accounts(config.dataDir);
  const profiles = registry.list();
  if (!profiles.length && !config.accountId) return config;
  let id = config.accountId;
  if (!id && profiles.length > 1) {
    say("Which WhatsApp account do you want to set up?");
    for (const [index, profile] of profiles.entries()) say(`  ${index + 1}. ${profile.name}${profile.enabled ? "" : " (disabled)"}`);
    if (!process.stdin.isTTY || config.assumeYes)
      throw new WazapError("ACCOUNT_REQUIRED", "Choose an account for setup.", "Use --account with an ID from `wazap accounts list`.");
    for (let attempt = 0; attempt < CHOICE_ATTEMPTS; attempt++) {
      const answer = (await ask("Account name or number: ")).trim();
      const profile = profiles.find((p) => p.name.toLowerCase() === answer.toLowerCase() || p.id === answer)
        ?? (/^\d+$/.test(answer) ? profiles[Number(answer) - 1] : undefined);
      if (profile) { id = profile.id; break; }
      say("Choose an account from the list. No account has been changed.");
    }
    if (!id) throw new WazapError("ACCOUNT_REQUIRED", "No account selected.", "Run setup again.");
  }
  const profile = registry.get(id);
  if (!profile.enabled) throw new WazapError("ACCOUNT_DISABLED", "This account is disabled.", `Run wazap accounts enable ${profile.id} first.`);
  return registry.config(config, profile);
}
