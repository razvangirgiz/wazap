---
name: wazap-setup
description: Install, link or repair the WhatsApp connection. Use when the user wants to connect WhatsApp to Claude, when a WhatsApp tool returns NOT_LINKED, SESSION_EXPIRED or SESSION_CORRUPT, when `get_status` is anything but connected, or when the user asks how wazap works with Claude Desktop, Claude Code or HTTP.
---

# wazap setup

wazap links the user's own WhatsApp account as a "linked device" and exposes it as MCP tools. The phone must stay online; the link needs the user's hands once.

## Diagnose first

Run `npx wazap status` and branch on its output. It never contacts WhatsApp, so it is safe at any point.

| `status` says | Do |
| --- | --- |
| `wazap: command not found` / npx fails | Node 20+ is required. `node --version`; install from nodejs.org if older. |
| `linked: no` | Go to **Link**. |
| `linked: yes`, `server: running` | The server is up. If tools still fail, call `get_status` and follow its `fix`. |
| `linked: yes`, `server: not running` | Go to **Connect a client**. |

## Link

1. Ask the user for their WhatsApp number in international format (`+40722123456`). Run `npx wazap login --phone <number>` in a terminal the user can see; it prints an 8-character code and waits.
2. Tell the user: WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → type the code. The command prints `Linked ✅` and exits.
3. If the code is refused or the user prefers scanning: `npx wazap login --qr` prints a QR in the terminal and saves `qr.png` in the data dir.
4. Done when `npx wazap status` prints `linked: yes`.

`SESSION_EXPIRED` means the phone removed the device: run `npx wazap login` again. `SESSION_CORRUPT` means unreadable credentials: `npx wazap logout` then `npx wazap login`.

## Connect a client

- Claude Code: `claude mcp add whatsapp -- npx -y wazap` (or install this plugin, which registers the server).
- Claude Desktop: add `{"mcpServers":{"whatsapp":{"command":"npx","args":["-y","wazap"]}}}` to `claude_desktop_config.json` and restart Desktop.
- Read-only is the safe default for a personal number: `npx -y wazap --read-only`. Writes are then refused before they reach WhatsApp.
- Remote clients (claude.ai, another machine) need HTTP mode with tokens; follow "HTTP mode" in the wazap README rather than improvising.

Done when `get_status` returns `status: "connected"`. Then call `learn` once before using the other tools.

## Limits the user should hear once

Baileys is an unofficial WhatsApp client; Meta can flag accounts, so heavy automated sending is the user's risk. One process owns the session: two wazap servers on the same data dir refuse to start.
