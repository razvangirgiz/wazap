# wazap setup, driven by an agent

You are connecting the WhatsApp account of the person you work for. Everything below runs without a terminal session of its own (no TTY, no prompts), in this order. wazap keeps stdout for the MCP protocol and writes every human-readable line to stderr, so run each command with `2>&1`. Every error prints `✗ message` and `→ fix`: do what the fix says, never retry blindly.

Two places you may be running, and the steps say where they differ:

- **On the person's own computer** (Claude Code, Cursor, Codex, Gemini CLI, Claude Desktop): wazap runs beside you and your client launches it.
- **On your own always-on Linux box** (a hosted agent that reaches MCP servers by https URL and signs in with OAuth): wazap runs on your box as a background service, and you hand the person a URL.

## 1. Install

If `wazap --version` already answers, skip this. Otherwise run:

```
curl -fsSL https://raw.githubusercontent.com/razvangirgiz/wazap/main/scripts/install.sh | sh 2>&1
```

It needs no sudo and no Node: it installs a pinned, sha256-checked Node and wazap into `~/.local/share/wazap` and puts `wazap` in `~/.local/bin`. Your current shell may not have that directory on PATH yet: run `export PATH="$HOME/.local/bin:$PATH"` once, or call `~/.local/bin/wazap`. Running the installer again upgrades.

## 2. Ask the person two things

- Their WhatsApp number, in international format (e.g. +15550100).
- What you may do. Offer three answers, and make the second the default:
  1. read only (`--no-writes`);
  2. **draft, and they approve every send** (`--drafts-only`): you write messages, nothing you can call sends them;
  3. send without asking each time (`--writes`).

## 3. Link the account with a pairing code

Run `wazap status --json 2>/dev/null`. If `linked` is true, skip to step 4. Otherwise start the link in the background and keep reading its output:

```
wazap login --phone <number> --drafts-only --yes > /tmp/wazap-login.log 2>&1 &
```

(`--no-writes` or `--writes` instead of `--drafts-only`, per their answer.) Within about 10 seconds the log has a line `pairing code: XXXX-XXXX`. Tell the person exactly: "On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead → enter XXXX-XXXX". Keep reading the log until `Linked as …` and then `Synced N chats …`. If the code expired, start the login again. Nothing else may use the data dir while the login runs.

If you already have the `whatsapp` tools, `link_account` with the number does the same and returns the code; poll `get_status` every 10 seconds until it says `connected`.

## 4. Keep it running

On your own box, always. On the person's computer, only if they want it running after your client closes.

```
wazap serve --daemon 2>&1
```

It uses launchd or systemd when the machine has them, and wazap's own supervisor otherwise (a container whose PID 1 is tini or a shell): it restarts wazap if it crashes and survives the shell that started it. `wazap service status`, `wazap service logs` and `wazap service stop` work with all three. wazap's own supervisor does not start at boot: after the box restarts, run `wazap service start`.

On the person's computer, if you are not keeping it running, register wazap with your client instead: `wazap connect <client>` (claude-code, claude-desktop, cursor, codex or gemini), then `wazap skills install <client>` for claude-code, codex and cursor. Tell the person what `connect` printed as `Next`. Then skip to step 7.

## 5. Give it a public URL

```
wazap expose quick 2>&1
```

It needs no account anywhere: it fetches a pinned, sha256-checked cloudflared and opens a Cloudflare quick tunnel, then prints a box with the **MCP URL** and the **password** (the password only the first time). If the person already set up Tailscale Funnel or a Cloudflare named tunnel, `wazap expose tailscale` or `wazap expose cloudflare` gives a URL that never changes.

A quick tunnel's URL changes whenever the tunnel, the service or the box restarts. `wazap status --json 2>/dev/null` always has the current one in `public.mcp_url`. When it changes, give the person the new URL.

## 6. Hand it over

Give the person, in your reply to them and nowhere else:

- the MCP URL, to add as an MCP server (a "custom connector") in the agent they use; if your own platform lets you add an MCP server by URL, add it yourself;
- the password, once. They type it on the sign-in page that opens when the connector is added, where they also choose what the agent may do (draft and approve each send is preselected), and on the approval page of each draft. Never write it into a file, a config, a connector setting or any other message.

On your own box you can read wazap's files, its credentials included: the drafts-only promise holds for what reaches wazap through the MCP URL, not for a shell on the machine it runs on. Say so if the person asks how safe it is.

## 7. Verify

`wazap status --json 2>/dev/null` must show `linked: true`, the server running, and no failing check. Once connected over MCP, call `get_status` and then `learn`. Then offer: "what did I miss on WhatsApp today?"

## Drafts-only, once connected

`send_message` returns a draft that is not sent, with up to three ways for the person to send it: `approve_url` (the approval page, which asks their wazap password), `approve_command` (`wazap drafts approve <draft_id>`, run on the wazap machine), and `send_yourself_url` (a wa.me link that opens WhatsApp with the text typed in). Show them the preview and these, say it is not sent yet, and never ask for the password. `wazap drafts` lists what waits.

## More than one account

`wazap account add <id>` creates a slot; link it with `login --account <id>` or `link_account(account_id)`. `account list` shows them; `account default <id>` picks the one tools use when a call does not say. A running server applies `account add|enable|disable|default|remove` at once, and `logout --account <id>` works while it runs. When several accounts could own a chat, write tools return AMBIGUOUS_ACCOUNT: pass `account_id`. One process owns a data dir: while `login` runs, stop the background service first if it holds the session (`wazap service stop`); two servers on one data dir refuse to start.
