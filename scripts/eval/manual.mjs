#!/usr/bin/env node
/**
 * The manual ChatGPT protocol (eval/chatgpt-protocol.md): an evaluation server
 * with OAuth behind a tunnel of its own, driven case by case from a terminal
 * while a person talks to ChatGPT. The server records the trace and effects;
 * the person pastes what ChatGPT answered and which confirmation dialogs they
 * approved or refused; score.mjs grades it like a Claude run.
 *
 *   node scripts/eval/manual.mjs start [--tunnel | --public-url https://…] [--port 8790] [--password …] [--cases chatgpt]
 *   node scripts/eval/manual.mjs next [<case>]      reset the world for the next case, print its script
 *   node scripts/eval/manual.mjs turn <n>           mark turn n (runs its hooks, says when to skip it)
 *   node scripts/eval/manual.mjs answer <n> [--approved <tool>…] [--refused <tool>…]   paste ChatGPT's reply on stdin
 *   node scripts/eval/manual.mjs finish             save the case's end state
 *   node scripts/eval/manual.mjs score              score the session (writes summary.json)
 *   node scripts/eval/manual.mjs status
 *
 * The session lives in ~/.wazap-eval/manual/session.json; transcripts in
 * ~/.wazap-eval/runs/<timestamp>-chatgpt/. Never point the tunnel at the
 * owner's service: this server has its own port, data and OAuth state.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { loadCases, loadToolMap, REPO_ROOT, resolveCase, selectCases } from "./cases.mjs";
import { controlClient } from "./client.mjs";
import { isolatedEnv } from "./run-claude.mjs";
import { renderSummary, scoreRun } from "./score.mjs";

const HOME = join(homedir(), ".wazap-eval");
const SESSION_FILE = join(HOME, "manual", "session.json");
const LIVE_PORTS = [8766, 8767];

const readSession = () => {
  if (!existsSync(SESSION_FILE)) throw new Error("No manual session: run `manual.mjs start` first");
  return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
};
const writeSession = (session) => {
  mkdirSync(join(HOME, "manual"), { recursive: true });
  writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
};
const option = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const optionList = (args, name) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]] : []));

function quickTunnel(port) {
  return new Promise((done, fail) => {
    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => fail(new Error("cloudflared printed no trycloudflare.com URL in 30 s")), 30_000);
    const scan = (chunk) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        done({ child, url: match[0] });
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", (err) => fail(new Error(`cloudflared could not start: ${err.message}`)));
  });
}

async function start(args) {
  const port = Number(option(args, "--port") ?? 8790);
  if (LIVE_PORTS.includes(port)) throw new Error(`Port ${port} belongs to a real wazap`);
  const password = option(args, "--password") ?? randomBytes(9).toString("base64url");
  let tunnel = null;
  let publicUrl = option(args, "--public-url");
  if (args.includes("--tunnel")) {
    tunnel = await quickTunnel(port);
    publicUrl = tunnel.url;
  }
  if (!publicUrl) throw new Error("Pass --tunnel (cloudflared quick tunnel) or --public-url https://…");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(HOME, "runs", `${stamp}-chatgpt`);
  mkdirSync(runDir, { recursive: true });
  const server = spawn(
    process.execPath,
    [join(REPO_ROOT, "scripts", "eval", "server.mjs"), "--port", String(port), "--oauth", "--public-url", publicUrl, "--password", password, "--state-dir", join(HOME, "oauth"), "--out", join(runDir, "_lobby")],
    { cwd: REPO_ROOT, env: isolatedEnv(), stdio: ["ignore", "pipe", "inherit"] }
  );
  const ready = await new Promise((done, fail) => {
    createInterface({ input: server.stdout }).on("line", (line) => line.startsWith("READY ") && done(JSON.parse(line.slice(6))));
    server.on("exit", (code) => fail(new Error(`evaluation server exited with ${code}`)));
  });
  const cases = selectCases(loadCases(), option(args, "--cases") ?? "chatgpt").map((theCase) => theCase.id);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({ wazap_version: pkg.version, arm: { model_requested: "chatgpt", mode: "chatgpt-manual" }, run: { id: `${stamp}-chatgpt`, cases: option(args, "--cases") ?? "chatgpt", reps: 1, started_at: new Date().toISOString() } }, null, 2)}\n`
  );
  writeSession({ run_dir: runDir, control_url: ready.control_url, control_token: ready.control_token, public_url: publicUrl, cases, done: [], current: null, anchor_sentence: ready.anchor_sentence });
  process.stdout.write(
    [
      "",
      "Evaluation server is up. Keep this terminal open (Ctrl-C stops the server and the tunnel).",
      "",
      `  MCP URL for ChatGPT:  ${publicUrl}/mcp`,
      `  Consent password:     ${password}`,
      `  Cases to run:         ${cases.join(" ")}`,
      "",
      "In ChatGPT (web): Settings → Apps / Connectors → Developer mode → Create app,",
      "authentication OAuth, the MCP URL above. On the consent page tick both accounts",
      "and write access, and enter the password. Then, in another terminal:",
      "",
      "  node scripts/eval/manual.mjs next",
      "",
    ].join("\n")
  );
  const stop = () => {
    tunnel?.child.kill("SIGTERM");
    server.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function next(args) {
  const session = readSession();
  const control = controlClient(session.control_url, session.control_token);
  const id = args[0] ?? session.cases.find((caseId) => !session.done.includes(caseId));
  if (!id) return process.stdout.write("Every case of this session is done. Run `manual.mjs score`.\n");
  const theCase = loadCases().find((entry) => entry.id === id);
  if (!theCase) throw new Error(`No case ${id}`);
  const dir = join(session.run_dir, id, "1");
  mkdirSync(dir, { recursive: true });
  const info = await control.reset({ patch: theCase.fixture?.patch, out: dir });
  const refs = await control.refs();
  writeFileSync(join(dir, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`);
  if (theCase.setup?.length) await control.hooks(theCase.setup);
  const resolved = resolveCase(theCase, refs);
  const attempt = { case: id, rep: 1, model_requested: "chatgpt", mode: "chatgpt-manual", turns: resolved.turns.map((turn) => ({ user: turn.user })), dialogs: [], infra_error: null, started_at: new Date().toISOString(), anchor_sentence: info.anchor_sentence };
  writeFileSync(join(dir, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`);
  session.current = { id, dir, started: Date.now() };
  writeSession(session);
  const lines = [
    "",
    `== ${id} [${theCase.severity}] ${theCase.title}`,
    "Open a NEW ChatGPT conversation (memory off, the evaluation app enabled). Start its first message with the",
    `clock line, on its own line: «${info.anchor_sentence}»`,
    "",
    ...resolved.turns.flatMap((turn, index) => [
      `Turn ${index + 1}${turn.new_session ? " (in a NEW conversation, clock line first)" : ""}${turn.when ? ` (only if ${turn.when}; \`turn ${index + 1}\` tells you)` : ""}:`,
      `  «${index === 0 || turn.new_session ? `${info.anchor_sentence}\n` : ""}${turn.user}»`,
      `  → node scripts/eval/manual.mjs turn ${index + 1}   (before you send it)`,
      `  → node scripts/eval/manual.mjs answer ${index + 1} [--approved <tool>] [--refused <tool>]   (paste the reply, then Ctrl-D)`,
    ]),
    "",
    "Confirmation dialogs: approve drafts and reads. Approve confirm_send (or any immediate write) only when the",
    "script's user already said yes to that exact message; otherwise refuse it and pass --refused <tool>.",
    "When done: node scripts/eval/manual.mjs finish",
    "",
  ];
  process.stdout.write(lines.join("\n"));
  return undefined;
}

async function turn(args) {
  const session = readSession();
  if (!session.current) throw new Error("No case in progress: run `manual.mjs next`");
  const control = controlClient(session.control_url, session.control_token);
  const number = Number(args[0]);
  const theCase = loadCases().find((entry) => entry.id === session.current.id);
  const spec = theCase.turns[number - 1];
  if (!spec) throw new Error(`${theCase.id} has no turn ${number}`);
  if (spec.when && spec.when !== "always") {
    const state = await control.state();
    const holds =
      (spec.when === "draft_open" && Object.values(state.accounts).some((account) => account.drafts.some((draft) => draft.state === "draft"))) ||
      (spec.when === "no_effects" && state.effects_count === 0);
    if (!holds) {
      const attemptPath = join(session.current.dir, "attempt.json");
      const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
      attempt.turns[number - 1].skipped = true;
      writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
      process.stdout.write(`SKIP turn ${number}: the condition "${spec.when}" does not hold. Do not send it.\n`);
      return;
    }
  }
  if (spec.before?.length) await control.hooks(spec.before);
  await control.turn(number, spec.new_session ? number : 1);
  process.stdout.write(`Turn ${number} marked. Send it now.\n`);
}

async function answer(args) {
  const session = readSession();
  if (!session.current) throw new Error("No case in progress");
  const number = Number(args[0]);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const attemptPath = join(session.current.dir, "attempt.json");
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  if (!attempt.turns[number - 1]) throw new Error(`No turn ${number}`);
  attempt.turns[number - 1].text = Buffer.concat(chunks).toString("utf8").trim();
  for (const tool of optionList(args, "--approved")) attempt.dialogs.push({ turn: number, tool, decision: "approved" });
  for (const tool of optionList(args, "--refused")) attempt.dialogs.push({ turn: number, tool, decision: "refused" });
  writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
  process.stdout.write(`Saved turn ${number} (${attempt.turns[number - 1].text.length} characters).\n`);
}

async function finish() {
  const session = readSession();
  if (!session.current) throw new Error("No case in progress");
  const control = controlClient(session.control_url, session.control_token);
  writeFileSync(join(session.current.dir, "state.json"), `${JSON.stringify(await control.state(), null, 2)}\n`);
  const attemptPath = join(session.current.dir, "attempt.json");
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  attempt.duration_ms = Date.now() - session.current.started;
  writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
  session.done.push(session.current.id);
  session.current = null;
  writeSession(session);
  const left = session.cases.filter((id) => !session.done.includes(id));
  process.stdout.write(`Saved. ${left.length} case(s) left${left.length ? `: ${left.join(" ")}` : " — run `manual.mjs score`"}.\n`);
}

function score() {
  const session = readSession();
  const summary = scoreRun(session.run_dir, { toolMap: loadToolMap("1.0") });
  writeFileSync(join(session.run_dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${renderSummary(summary)}\nsummary: ${join(session.run_dir, "summary.json")}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const commands = { start, next, turn, answer, finish, score, status: () => process.stdout.write(`${JSON.stringify(readSession(), null, 2)}\n`) };
  if (!commands[command]) throw new Error(`usage: manual.mjs ${Object.keys(commands).join("|")}`);
  await commands[command](args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}
