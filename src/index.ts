#!/usr/bin/env node
import { Accounts } from "./accounts.js";
import { accountConfig, runAccounts, accountsStatus } from "./accounts-cli.js";
import { BANNER } from "./banner.js";
import {
  runContacts,
  runGreet,
  runLogin,
  runLogout,
  runServe,
  runStatus,
  runTranscribe,
} from "./cli.js";
import { WAZAP_VERSION, parseCli, pickDefaultAction } from "./config.js";
import { CLIENT_NAMES, runConnect } from "./connect.js";
import { SKILL_TARGET_NAMES, runSkills } from "./skills.js";
import { PROVIDER_NAMES, runExpose } from "./expose.js";
import { SERVICE_VERBS, runService } from "./service.js";
import { runSetup } from "./setup.js";
import { runUpdate } from "./update.js";
import { runConfig } from "./settings.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { fail, fix } from "./ui.js";

const USAGE = `${BANNER}

Usage:
  wazap [serve] [--http] [--host <host>] [--port <port>]   Run the MCP server (default: stdio)
  wazap accounts list|add|rename|enable|disable [<account_id>] [--name <name>]
  wazap login [--account <account_id>] [--phone +15550100] [--code]              Link a WhatsApp account (QR by default)
  wazap setup [--agent] [--client <name>]                  Link, connect your client and finish, in one command
  wazap connect <client> [--dry-run]                       Register wazap with an MCP client
  wazap skills install [<harness>] [--dry-run]              Copy the five skills into a harness, or into every one found
  wazap service ${SERVICE_VERBS}
                                                           Keep the server running in the background, under launchd or systemd
  wazap expose [tailscale|cloudflare|off]                  Give the running service a public https URL cloud agents can reach
  wazap config [writes on|off] [transcribe local|openai|off]
                                                           Show the effective settings, or change one
  wazap transcribe download [--model <alias>]              Fetch the whisper.cpp model into the data dir
  wazap transcribe test <audio file>                       Transcribe a local file with the configured provider
  wazap contacts resync                                    Fetch the phone's address book from WhatsApp again
  wazap update [--dry-run]                                 Upgrade wazap, then the service and the skills that follow it
  wazap status [--live] [--json]                           Check the install, the session and the server
  wazap logout                                             Unlink and delete local credentials

Clients for wazap connect: ${CLIENT_NAMES}, chatgpt (guided connection).
Harnesses for wazap skills install: ${SKILL_TARGET_NAMES}. wazap setup does this for the clients it connects.
Tunnel providers for wazap expose: ${PROVIDER_NAMES}.

Options:
  --account <id>     Select a profile from wazap accounts list
  --name <name>      Display name for accounts add or rename
  --data-dir <path>   Where wazap keeps its data (default ~/.wazap, or $WAZAP_DATA_DIR)
  --read-only         Refuse every write; the write tools are not registered at all
  --http              Serve Streamable HTTP instead of stdio
  --host <host>       HTTP bind address (default 127.0.0.1)
  --port <port>       HTTP port (default 8766)
  --code              Log in with an 8-character pairing code instead of the QR
  --phone <number>    Your number in international format; implies --code
  --agent             With setup: print the procedure for an AI agent on stdout, then exit
  --client <name>     With setup: connect this client instead of the detected ones (repeatable)
  --no-global         With setup: keep running from the npx cache instead of installing globally
  --no-brew           Never offer to install a missing whisper-cpp, ffmpeg or tailscale with Homebrew
  --relaunch          With setup: restart Claude Desktop after connecting it, without asking
  --transcribe <how>  With setup: answer the transcription question (local, openai or off)
  --service           With setup: keep wazap running on this machine, without asking
  --expose            With setup: also give it a public URL cloud agents can reach
  --model <alias>     With transcribe download: turbo (default), large-v3 or medium
  --dry-run           With setup, connect, skills install, service install or update: simulate without changes
  --live              With status: reach WhatsApp for real, then close the connection
  --json              With status or connect chatgpt: print structured output
  --writes            Allow the agent to write, without login asking
  --no-writes         Keep the agent read-only, without login asking
  -y, --yes           Do not ask anything at the end of login
  -h, --help          Show this help
  -v, --version       Show the version

Environment: WAZAP_DATA_DIR, WAZAP_READ_ONLY, WAZAP_SYNC_FULL_HISTORY, WAZAP_PERSIST_HISTORY,
WAZAP_TRANSPORT, WAZAP_HOST, WAZAP_PORT, WAZAP_READ_TOKEN, WAZAP_WRITE_TOKEN, WAZAP_PUBLIC_URL,
WAZAP_OAUTH_PASSWORD, WAZAP_RATE_LIMIT, WAZAP_EXPORT_DIR,
WAZAP_NO_SHARE, WAZAP_NO_UPDATE_CHECK, WAZAP_TRANSCRIBE, WAZAP_TRANSCRIBE_AUTO,
WAZAP_TRANSCRIBE_LANGUAGE, WAZAP_TRANSCRIBE_API_KEY, WAZAP_TRANSCRIBE_URL, WAZAP_TRANSCRIBE_MODEL,
WAZAP_WHISPER_MODEL, WAZAP_WHISPER_BIN.
An optional <data-dir>/.env is loaded if present.`;

async function main(): Promise<void> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || (major === 22 && minor! < 16)) {
    say("Node 22.16 or newer is required. Upgrade Node and restart wazap.");
    process.exitCode = 1;
    return;
  }
  const invocation = parseCli();
  if (invocation.kind === "help") {
    say(USAGE);
    return;
  }
  if (invocation.kind === "version") {
    say(WAZAP_VERSION);
    return;
  }

  let { config } = invocation;
  if (config.command === "accounts") {
    await runAccounts(config);
    return;
  }
  if (config.command === "setup") {
    await runSetup(config);
    return;
  }
  const registry = new Accounts(config.dataDir);
  if (
    config.command === "status" &&
    !config.accountId &&
    registry.list().length > 1
  ) {
    if (config.live)
      throw new WazapError(
        "ACCOUNT_REQUIRED",
        "Choose --account for a live probe.",
      );
    await accountsStatus(config);
    return;
  }
  if (
    ["login", "logout", "transcribe", "contacts", "status", "setup"].includes(
      config.command,
    ) ||
    (config.command === "config" && config.accountId)
  ) {
    config = accountConfig(config);
    if (
      config.offline &&
      ["login", "contacts", "setup"].includes(config.command)
    )
      throw new WazapError(
        "ACCOUNT_DISABLED",
        "Enable this account first: wazap accounts enable <account_id>.",
      );
    if (
      config.command === "login" &&
      config.loginPhone &&
      config.rootDataDir &&
      config.accountId
    )
      new Accounts(config.rootDataDir).checkPhone(
        config.accountId,
        config.loginPhone,
      );
  } else if (config.accountId)
    throw new WazapError(
      "INVALID_ID",
      "--account is for account operations; the server always manages the whole installation. Use WAZAP_ACCOUNTS to restrict a client.",
    );
  switch (config.command) {
    case "serve":
      if (
        pickDefaultAction(
          config,
          process.stdin.isTTY === true,
          process.stderr.isTTY === true,
        ) === "greet"
      ) {
        if (registry.list().length > 1) await accountsStatus(config);
        else await runGreet(config);
        return;
      }
      await runServe(config);
      return;
    case "login":
      await runLogin(config);
      return;
    case "connect":
      runConnect(config);
      return;
    case "skills":
      runSkills(config);
      return;
    case "service":
      await runService(config);
      return;
    case "expose":
      await runExpose(config);
      return;
    case "config":
      await runConfig(config);
      return;
    case "transcribe":
      await runTranscribe(config);
      return;
    case "contacts":
      await runContacts(config);
      return;
    case "update":
      await runUpdate(config);
      return;
    case "status":
      await runStatus(config);
      return;
    case "logout":
      await runLogout(config);
      return;
  }
}

main().catch((err: unknown) => {
  say(fail(err instanceof Error ? err.message : String(err)));
  if (err instanceof WazapError && err.fix) say(fix(err.fix));
  process.exit(1);
});
