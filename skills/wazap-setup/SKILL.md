---
name: wazap-setup
description: Install, link or repair the WhatsApp connection. Use when the user wants to connect WhatsApp to Claude, when a WhatsApp tool returns NOT_LINKED, SESSION_EXPIRED or SESSION_CORRUPT, when `get_status` is anything but connected, or when the user asks how wazap works with Claude Desktop, Claude Code or HTTP.
---

# wazap setup

## Account selection

Call `list_accounts` first. With multiple profiles, pass the chosen `account_id` to every account operation below, including `get_status` and `link_account`. Preserve `(account_id, chat_id/message_id)` from results; matching names or IDs across accounts do not make them interchangeable. Show the sending account in every draft and pass its exact `draft_id` to `confirm_send`.

For an explicitly combined inbox, `search_messages`, `get_recent_messages` and `get_unanswered` accept `account_ids` or `all_accounts: true`. Keep account labels in the summary. Follow each pagination cursor unchanged; an unavailable account makes results partial, never proof of absence. Other tools remain per account. Account additions require new OAuth consent.


wazap links the user's own WhatsApp account as a "linked device" and exposes it as MCP tools. The phone must stay online; the link needs the user's hands once.

## Diagnose first

Run `npx wazap-mcp@0.15.0-beta.1 status` and branch on its output. It never contacts WhatsApp, so it is safe at any point.

| `status` says | Do |
| --- | --- |
| `wazap: command not found` / npx fails | Node 22.16+ is required. `node --version`; install from nodejs.org if older. |
| `linked: no` | Go to **Link**. |
| `linked: yes`, `server: running` | The server is up. If tools still fail, call `get_status` and follow its `fix`. |
| `linked: yes`, `server: not running` | Go to **Connect a client**. |

Below those lines is a `checks:` section. Every `✗` carries the command that
fixes it; run that command rather than improvising.

| `checks:` line | What it means |
| --- | --- |
| `✗ node` | The Node version is below 22.16. Nothing else will work until it is upgraded. |
| `✗ data dir` | Missing, not a directory, mode other than 0700, or not writable. The line names the `chmod` to run. |
| `– lock: stale` | A previous server died without cleaning up. Harmless; the next start reclaims it. |
| `✓ lock: held` | A server is running. Do not run `logout` or `status --live`; ask through the client with `get_status`. |
| `✗ credentials` | Unreadable. Call `link_account`, or `npx wazap-mcp@0.15.0-beta.1 logout` then `npx wazap-mcp@0.15.0-beta.1 login`. |
| `writes: off` | Write tools are not registered. Enabling them is **Allow writes**. |
| `– update` | A newer wazap exists, or the check could not reach npm. Never blocking. |

`npx wazap-mcp@0.15.0-beta.1 status --live` reaches WhatsApp for real and reports whether the
phone is reachable, how many chats synced and how old the last message is. It
refuses while a server holds the lock, because one process owns the session.
`--json` gives the same report as one object.

## Link

Inside an MCP client that already has the `whatsapp` tools, call `link_account`
with the user's number in international format. No terminal is involved. It
returns an 8-character code, and `get_status` reports `linking` with that code
until the phone accepts it. Tell the user: WhatsApp → Settings → Linked devices
→ Link a device → Link with phone number instead, then type the code. Poll
`get_status` every 10 seconds until it says `connected`, for up to 3 minutes.
Codes expire, so call `link_account` again for a fresh one if the status falls
back to `not_linked`.

Without those tools, run `npx wazap-mcp@0.15.0-beta.1 setup --agent` and follow what it prints.
That procedure starts `login` in the background and reads the
`pairing code: XXXX-XXXX` line out of its output, so the user is left with the
one part of linking a machine cannot do, typing the code into the phone.

`SESSION_EXPIRED` means the phone removed the device, and `NOT_LINKED` that
nothing was ever linked. Both are `link_account`, or `npx wazap-mcp@0.15.0-beta.1 login` where
the tool is unavailable. `SESSION_CORRUPT` means unreadable credentials, which
`link_account` clears before it pairs; from a terminal that is
`npx wazap-mcp@0.15.0-beta.1 logout` then `npx wazap-mcp@0.15.0-beta.1 login`.

## Connect a client

For ChatGPT, have the user run `wazap setup --client chatgpt --data-dir <installation-directory>` on the Wazap host. It guides HTTPS/OAuth setup; publishing requires choosing that option. Use `wazap connect chatgpt` for read-only guidance. A successful first read in the chosen client is required before declaring setup complete. `setup --dry-run` makes no changes; deferring transcription preserves existing settings. ChatGPT does not automatically have a shell on that host. Follow `docs/chatgpt.md`; never ask the user to paste authentication secrets into chat. Additional accounts require new OAuth consent.

Run `npx wazap-mcp@0.15.0-beta.1 connect <client>`, where the client is one of `claude-code`,
`claude-desktop`, `cursor`, `codex`, `vscode` or `gemini`. It writes the entry,
keeps whatever else is in the file, backs it up once, and prints the next step
(restart, reload window, or `claude mcp list`). Running it twice is safe.

- Add `--dry-run` first if the user wants to see the entry before it is written.
- Claude Code users can install this plugin instead, which registers the server.
- Remote clients use HTTP with the authentication their client supports; hosted OAuth clients use the OAuth flow in the README. Do not substitute a bearer token in conversation.

Done when `get_status` returns `status: "connected"`. Then call `learn` once before using the other tools.

## Allow writes

Writes are off unless the user said yes at `login`. The write tools are then not
registered at all, so the agent cannot see them.

Turn them on with `npx wazap-mcp@0.15.0-beta.1 config writes on`, off again with
`npx wazap-mcp@0.15.0-beta.1 config writes off`. Both edit `WAZAP_READ_ONLY` in
`<data-dir>/.env`; a running server has to be restarted for the change to take
effect. `npx wazap-mcp@0.15.0-beta.1 config` alone prints every effective setting and where it
came from, which is how you tell a flag from an `.env` line.

## Limits the user should hear once

Baileys is an unofficial WhatsApp client; Meta can flag accounts, so heavy automated sending is the user's risk. One process owns the session: two wazap servers on the same data dir refuse to start.
