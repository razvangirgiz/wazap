import { readFileSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import { ask, describeAccount, linkAndSync, stepper } from "./cli.js";
import { paths, type Config } from "./config.js";
import { CLIENTS, connectClient, connectNext, detectClients, findClient, type ClientSpec } from "./connect.js";
import { say } from "./logger.js";
import { brand, fail, info, ok } from "./ui.js";

export async function runSetup(config: Config): Promise<void> {
  // The whole output is the document and this command never serves, so stdout is
  // the right channel. AGENT.md sits at the package root, which is what `files`
  // publishes.
  if (config.agent) {
    process.stdout.write(readFileSync(new URL("../AGENT.md", import.meta.url), "utf8"));
    return;
  }

  say(banner());
  const announce = stepper(3);

  announce("Link");
  const account = readLinkedAccount(paths(config.dataDir).authDir);
  if (account) say(ok(`Already linked as ${describeAccount(account)}`));
  else await linkAndSync(config);

  announce("Connect");
  const chosen = await chooseClients(config);
  if (chosen.length === 0) {
    say(info("No client connected yet."));
    say(connectNext());
  }
  for (const spec of chosen) connectClient(spec, config);

  announce("Finish");
  say(ok("Setup complete"));
  for (const spec of chosen) say(info(spec.next));
  say("");
  say('Ask your agent: "what did I miss on WhatsApp today?"');
}

const CHOICE_ATTEMPTS = 3;

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
