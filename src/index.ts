#!/usr/bin/env node
import { BANNER } from "./banner.js";
import { runContacts, runGreet, runLogin, runLogout, runServe, runStatus, runTranscribe } from "./cli.js";
import { WAZAP_VERSION, parseCli, pickDefaultAction } from "./config.js";
import { CLIENT_NAMES, runConnect } from "./connect.js";
import { SKILL_TARGET_NAMES, runSkills } from "./skills.js";
import { runSetup } from "./setup.js";
import { runConfig } from "./settings.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { fail, fix } from "./ui.js";

const USAGE = `${BANNER}

Usage:
  wazap [serve] [--http] [--host <host>] [--port <port>]   Run the MCP server (default: stdio)
  wazap login [--phone +15550100] [--code]              Link a WhatsApp account (QR by default)
  wazap setup [--agent] [--client <name>]                  Link, connect your client and finish, in one command
  wazap connect <client> [--dry-run]                       Register wazap with an MCP client
  wazap skills install [<harness>] [--dry-run]              Copy the five skills into a harness, or into every one found
  wazap config [writes on|off] [transcribe local|openai|off]
                                                           Show the effective settings, or change one
  wazap transcribe download [--model <alias>]              Fetch the whisper.cpp model into the data dir
  wazap transcribe test <audio file>                       Transcribe a local file with the configured provider
  wazap contacts resync                                    Fetch the phone's address book from WhatsApp again
  wazap status [--live] [--json]                           Check the install, the session and the server
  wazap logout                                             Unlink and delete local credentials

Clients for wazap connect: ${CLIENT_NAMES}.
Harnesses for wazap skills install: ${SKILL_TARGET_NAMES}. wazap setup does this for the clients it connects.

Options:
  --data-dir <path>   Where wazap keeps its data (default ~/.wazap, or $WAZAP_DATA_DIR)
  --read-only         Refuse every write; the write tools are not registered at all
  --http              Serve Streamable HTTP instead of stdio
  --host <host>       HTTP bind address (default 127.0.0.1)
  --port <port>       HTTP port (default 8766)
  --code              Log in with an 8-character pairing code instead of the QR
  --phone <number>    Your number in international format; implies --code
  --agent             With setup: print the procedure for an AI agent on stdout, then exit
  --client <name>     With setup: connect this client instead of the detected ones (repeatable)
  --transcribe <how>  With setup: answer the transcription question (local, openai or off)
  --model <alias>     With transcribe download: turbo (default), large-v3 or medium
  --dry-run           With connect or skills install: print what would be written, and write nothing
  --live              With status: reach WhatsApp for real, then close the connection
  --json              With status: print the whole report as one JSON object on stdout
  --writes            Allow the agent to write, without login asking
  --no-writes         Keep the agent read-only, without login asking
  -y, --yes           Do not ask anything at the end of login
  -h, --help          Show this help
  -v, --version       Show the version

Environment: WAZAP_DATA_DIR, WAZAP_READ_ONLY, WAZAP_SYNC_FULL_HISTORY, WAZAP_PERSIST_HISTORY,
WAZAP_TRANSPORT, WAZAP_HOST, WAZAP_PORT, WAZAP_READ_TOKEN, WAZAP_WRITE_TOKEN, WAZAP_PUBLIC_URL,
WAZAP_OAUTH_PASSWORD, WAZAP_RATE_LIMIT,
WAZAP_NO_SHARE, WAZAP_NO_UPDATE_CHECK, WAZAP_TRANSCRIBE, WAZAP_TRANSCRIBE_AUTO,
WAZAP_TRANSCRIBE_LANGUAGE, WAZAP_TRANSCRIBE_API_KEY, WAZAP_TRANSCRIBE_URL, WAZAP_TRANSCRIBE_MODEL,
WAZAP_WHISPER_MODEL, WAZAP_WHISPER_BIN.
An optional <data-dir>/.env is loaded if present.`;

async function main(): Promise<void> {
  const invocation = parseCli();
  if (invocation.kind === "help") {
    say(USAGE);
    return;
  }
  if (invocation.kind === "version") {
    say(WAZAP_VERSION);
    return;
  }

  const { config } = invocation;
  switch (config.command) {
    case "serve":
      if (pickDefaultAction(config, process.stdin.isTTY === true, process.stderr.isTTY === true) === "greet") {
        await runGreet(config);
        return;
      }
      await runServe(config);
      return;
    case "login":
      await runLogin(config);
      return;
    case "setup":
      await runSetup(config);
      return;
    case "connect":
      runConnect(config);
      return;
    case "skills":
      runSkills(config);
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
