---
name: wazap-setup
description: Install, link or repair the WhatsApp connection. Use when the user wants to connect WhatsApp to Claude, when a WhatsApp tool returns NOT_LINKED, SESSION_EXPIRED or SESSION_CORRUPT, when `get_status` is anything but connected, or when the user asks how wazap works with Claude Desktop, Claude Code or HTTP.
---

# wazap setup

wazap links the user's own WhatsApp account as a "linked device" and exposes it as MCP tools. The phone must stay online; the link needs the user's hands once.

## Diagnose first

Run `npx wazap-mcp status` and branch on its output. It never contacts WhatsApp, so it is safe at any point.

| `status` says | Do |
| --- | --- |
| `wazap: command not found` / npx fails | Node 20+ is required. `node --version`; install from nodejs.org if older. |
| `linked: no` | Go to **Link**. |
| `linked: yes`, `server: running` | The server is up. If tools still fail, call `get_status` and follow its `fix`. |
| `linked: yes`, `server: not running` | Go to **Connect a client**. |

Below those lines is a `checks:` section. Every `✗` carries the command that
fixes it; run that command rather than improvising.

| `checks:` line | What it means |
| --- | --- |
| `✗ node` | The Node version is below 20. Nothing else will work until it is upgraded. |
| `✗ data dir` | Missing, not a directory, mode other than 0700, or not writable. The line names the `chmod` to run. |
| `– lock: stale` | A previous server died without cleaning up. Harmless; the next start reclaims it. |
| `✓ lock: held` | A server is running. Do not run `logout` or `status --live`; ask through the client with `get_status`. |
| `✗ credentials` | Unreadable. `npx wazap-mcp logout` then `npx wazap-mcp login`. |
| `writes: off` | Write tools are not registered. Enabling them is **Allow writes**. |
| `– update` | A newer wazap exists, or the check could not reach npm. Never blocking. |

`npx wazap-mcp status --live` reaches WhatsApp for real and reports whether the
phone is reachable, how many chats synced and how old the last message is. It
refuses while a server holds the lock, because one process owns the session.
`--json` gives the same report as one object.

## Link

1. Ask the user for their WhatsApp number in international format (`+40722123456`). Run `npx wazap-mcp login --phone <number>` in a terminal the user can see; it prints an 8-character code and waits.
2. Tell the user: WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → type the code. The command prints `Linked ✅` and exits.
3. If the code is refused or the user prefers scanning: `npx wazap-mcp login --qr` prints a QR in the terminal and saves `qr.png` in the data dir.
4. Done when `npx wazap-mcp status` prints `linked: yes`.

`SESSION_EXPIRED` means the phone removed the device: run `npx wazap-mcp login` again. `SESSION_CORRUPT` means unreadable credentials: `npx wazap-mcp logout` then `npx wazap-mcp login`.

## Connect a client

Run `npx wazap-mcp connect <client>`, where the client is one of `claude-code`,
`claude-desktop`, `cursor`, `codex`, `vscode` or `gemini`. It writes the entry,
keeps whatever else is in the file, backs it up once, and prints the next step
(restart, reload window, or `claude mcp list`). Running it twice is safe.

- Add `--dry-run` first if the user wants to see the entry before it is written.
- Claude Code users can install this plugin instead, which registers the server.
- Remote clients (claude.ai, another machine) need HTTP mode with tokens; follow "HTTP mode" in the wazap README rather than improvising.

Done when `get_status` returns `status: "connected"`. Then call `learn` once before using the other tools.

## Allow writes

Writes are off unless the user said yes at `login`. The write tools are then not
registered at all, so the agent cannot see them.

Turn them on with `npx wazap-mcp config writes on`, off again with
`npx wazap-mcp config writes off`. Both edit `WAZAP_READ_ONLY` in
`<data-dir>/.env`; a running server has to be restarted for the change to take
effect. `npx wazap-mcp config` alone prints every effective setting and where it
came from, which is how you tell a flag from an `.env` line.

## Limits the user should hear once

Baileys is an unofficial WhatsApp client; Meta can flag accounts, so heavy automated sending is the user's risk. One process owns the session: two wazap servers on the same data dir refuse to start.
