# whatsapp-baileys-mcp

A local [MCP](https://modelcontextprotocol.io) server that connects to your WhatsApp account through [Baileys](https://github.com/WhiskeySockets/Baileys), a pure WebSocket client with no browser, and exposes it to any MCP client: Claude Desktop, Claude Code, or anything that speaks stdio or Streamable HTTP.

- Logs in with a QR code once; the session is saved and reused.
- 17 tools: chats, messages, full-text search, contacts, media, reactions, chat management, groups.
- stdio by default. Optional HTTP mode with two bearer tokens, one read-only and one that unlocks sending, so a leaked read token can never message anyone.
- Optional read-only mode for a personal number: every mutation is refused in code.
- In-memory store fed by Baileys events, with optional snapshots and per-chat JSONL history so reads survive restarts.

> Baileys is an unofficial WhatsApp library. Use it with a number you are comfortable risking; unofficial clients can get an account flagged.

## Install

Node 18 or newer.

```bash
git clone https://github.com/razvangirgiz/whatsapp-baileys-mcp
cd whatsapp-baileys-mcp
npm install
npm run build
```

## First login

```bash
npm start
```

A QR code is printed to the terminal and written to `qr.png`. On your phone: WhatsApp → Settings → Linked devices → Link a device, and scan it. You will see:

```
[whatsapp-mcp] authenticated — session saved, no need to scan again next time.
[whatsapp-mcp] WhatsApp is ready.
```

Stop with Ctrl+C. A clean shutdown keeps the saved session valid; `kill -9` mid-write can corrupt it (delete `.baileys_auth/` and scan again if that happens).

All logs and the QR go to stderr. stdout is reserved for MCP traffic, so the same process works standalone and when an MCP client launches it.

## Connect a client

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-baileys-mcp/dist/index.js"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add whatsapp -- node /absolute/path/to/whatsapp-baileys-mcp/dist/index.js
```

Scan the QR once from a terminal first; after that, the client-launched process starts already authenticated.

## HTTP mode

For a remote client, run over Streamable HTTP behind HTTPS with a bearer token.

```bash
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
echo "MCP_WRITE_TOKEN=$(openssl rand -hex 32)" >> .env   # only for clients allowed to send
TRANSPORT=http PORT=8766 npm start
# http://127.0.0.1:8766/mcp     health: http://127.0.0.1:8766/healthz
```

A session authenticated with `MCP_AUTH_TOKEN` gets the read tools only. A session authenticated with `MCP_WRITE_TOKEN` gets everything. Without `MCP_AUTH_TOKEN` the endpoint is unauthenticated; the server warns and you should keep it on loopback.

Expose it with any HTTPS tunnel (Cloudflare named tunnel, Tailscale Funnel, ngrok) and point the client at `https://your-host/mcp` with `Authorization: Bearer <token>`.

One process owns the WhatsApp session. Run stdio or HTTP, not both.

## Tools

`learn` returns a short usage guide (chat id format, workflow, caveats). The other tool descriptions tell the agent to call it first, for clients that ignore server instructions.

Read:

| Tool | What it does |
| --- | --- |
| `get_status` | Connection status, linked account, last error |
| `get_recent_chats` | List chats; `filter`: all / unread / groups / individual / archived |
| `read_messages` | Recent messages from one chat, with ids and media/reply flags |
| `search_messages` | Full-text search, globally or within one chat |
| `search_contacts` | Find contacts by name or number |
| `get_contact` | About, profile picture, blocked/business flags |
| `download_media` | Save a message's media to `media/`; small images returned inline |
| `get_group_info` | Group name, description, owner, participants with admin flags |

Write (require the write token in HTTP mode, always available on stdio unless `WHATSAPP_READONLY=1`):

| Tool | What it does |
| --- | --- |
| `send_message` | Send text; `reply_to` quotes an existing message |
| `send_media` | Send image/video/audio/document from a local path or URL |
| `react_to_message` | Add or remove an emoji reaction |
| `forward_message` | Forward to another chat |
| `delete_message` | Delete for me, or retract for everyone |
| `manage_chat` | archive, pin, mute, mark read/unread |
| `create_group` | Create a group with participants |
| `manage_group` | add/remove/promote/demote/leave, subject, description, invite link |

`chat_id` accepts a full serialized id from `get_recent_chats` / `search_contacts`, or a bare phone number, treated as `<digits>@c.us`. Message-level tools take the id returned by `read_messages` / `search_messages`. Sends, deletes and group changes are real and have no undo.

## Configuration

Everything is optional; see [`.env.example`](.env.example). Paths resolve relative to the package folder, not the working directory.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHATSAPP_AUTH_PATH` | `.baileys_auth` | Session folder |
| `QR_FILE` | `qr.png` | Where the login QR is written |
| `WHATSAPP_READONLY` | `0` | Refuse every mutation on this connection |
| `WHATSAPP_SYNC_FULL_HISTORY` | `0` | Ask for a fuller history sync |
| `WHATSAPP_STORE_CACHE` | unset | Snapshot file for chats and recent messages |
| `WHATSAPP_HISTORY_STORE_DIR` | unset | Per-chat JSONL history directory |
| `WHATSAPP_JOURNAL_DIR` | unset | Append-only message journal directory |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `HOST` / `PORT` | `127.0.0.1` / `8766` | HTTP bind address |
| `MCP_AUTH_TOKEN` | unset | Read token for HTTP |
| `MCP_WRITE_TOKEN` | unset | Write token for HTTP |

## Development

```bash
npm run dev         # run from source with tsx
npm run typecheck
npm test            # builds, then runs the reconnect tests
```

The reconnect test covers backoff with jitter, the retry cap and the generation guard that stops a stale socket from reviving a replaced connection.

## Security

- `.baileys_auth/` is your live WhatsApp session. Treat it like a password. It is git-ignored.
- `.env`, `qr.png`, snapshots and history are git-ignored too.
- In stdio mode the server opens no network port.
- In HTTP mode, set both tokens and terminate TLS in front of it.

## Structure

```
src/
  index.ts      entry point: config, WhatsApp session, stdio or HTTP transport
  config.ts     .env loading
  whatsapp.ts   Baileys wrapper: login, reconnect, store, chat and message ops
  tools.ts      the 17 MCP tools
  wa-types.ts   shared types
  logger.ts     stderr-only logging
test/
  reconnect.test.mjs
```

## License

MIT. Built by [Răzvan Girgiz](https://razvangirgiz.com).
