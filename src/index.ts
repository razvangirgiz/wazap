#!/usr/bin/env node
import { runLogin, runLogout, runServe, runStatus } from "./cli.js";
import { WAZAP_VERSION, parseCli } from "./config.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";

const USAGE = `wazap — WhatsApp for your AI agent.

Usage:
  wazap [serve] [--http] [--host <host>] [--port <port>]   Run the MCP server (default: stdio)
  wazap login [--phone +40722123456] [--qr]                Link a WhatsApp account
  wazap status                                             Show what is linked and whether a server is running
  wazap logout                                             Unlink and delete local credentials

Options:
  --data-dir <path>   Where wazap keeps its data (default ~/.wazap, or $WAZAP_DATA_DIR)
  --read-only         Refuse every write; the write tools are not registered at all
  --http              Serve Streamable HTTP instead of stdio
  --host <host>       HTTP bind address (default 127.0.0.1)
  --port <port>       HTTP port (default 8766)
  --phone <number>    Phone number in international format, for login
  --qr                Log in by QR code instead of a pairing code
  -h, --help          Show this help
  -v, --version       Show the version

Environment: WAZAP_DATA_DIR, WAZAP_READ_ONLY, WAZAP_SYNC_FULL_HISTORY, WAZAP_PERSIST_HISTORY,
WAZAP_TRANSPORT, WAZAP_HOST, WAZAP_PORT, WAZAP_READ_TOKEN, WAZAP_WRITE_TOKEN, WAZAP_RATE_LIMIT.
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
      await runServe(config);
      return;
    case "login":
      await runLogin(config);
      return;
    case "status":
      runStatus(config);
      return;
    case "logout":
      await runLogout(config);
      return;
  }
}

main().catch((err: unknown) => {
  if (err instanceof WazapError) {
    say(err.message);
    if (err.fix) say(err.fix);
  } else {
    say(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
