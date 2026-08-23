# wazap setup, driven by an agent

You are setting up WhatsApp access for the person you are working with. Use the pairing-code flow (it is plain text); never the QR.

wazap keeps stdout for the MCP protocol and writes every human-readable line to stderr, so read stderr as well: run each command with `2>&1`.

1. Run `npx wazap-mcp status --json`. If `linked` is true, skip to step 5.
2. Ask the person for their WhatsApp number in international format (e.g. +15550100) and whether the agent may send messages (default: no).
3. Start the link IN THE BACKGROUND and keep reading its output:
   `npx wazap-mcp login --phone <number> --no-writes --yes 2>&1` (or `--writes`).
   Within ~10 s the output contains a line `pairing code: XXXX-XXXX`.
4. Show the person exactly: "On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead → enter XXXX-XXXX". Keep reading the output until `Linked as …` and then `Synced N chats …` appear (up to 3 minutes). If the output says the code expired, run step 3 again.
5. If step 1 reported `install.kind: "npx"`, run `npm i -g wazap-mcp` first: Claude Desktop and the background service cannot launch from the npx cache, which npm clears. Register wazap with the client you are running in: `npx wazap-mcp connect <client>` where <client> is claude-code, claude-desktop, cursor, codex, vscode or gemini. Tell the person what the command printed as `Next`. Then, for claude-code, codex, cursor and opencode, run `npx wazap-mcp skills install <client>`, which copies the five workflow skills where that client reads them. The other clients need no such step, because the server hands them the same five workflows as MCP prompts.
6. Verify: `npx wazap-mcp status --json` must show `linked: true` and no failing check. If the client needs a restart, say so; otherwise call the `get_status` tool and then `learn`.
7. Done when `get_status` returns `connected`. Then offer: "what did I miss on WhatsApp today?"
8. Ask whether wazap should keep running after this client closes, and whether cloud agents should reach it. For the first, run `npx wazap-mcp service install`, which writes a launchd agent or a systemd user unit and starts it. For the second, also run `npx wazap-mcp expose`. It opens a tunnel, prints an https URL and a consent password, and restarts the service. Give an agent the URL only. The password is for the person, on their consent page; never paste it into a chat, a config file or a message.

Errors: every wazap error prints `✗ message` and `→ fix`; do what the fix says, do not retry blindly. One process owns the session, so while the `login` of step 3 runs, no server and no other wazap command may touch the same data dir; two servers on one data dir refuse to start. Stop the other one first.
