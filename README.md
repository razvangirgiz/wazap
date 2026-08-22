# wazap

**WhatsApp for your AI agent.** An MCP server that puts your WhatsApp account —
chats, messages, media, contacts, groups — behind 22 tools any MCP client can
call. Pairing-code login, no browser, no phone-number reseller, ~20 MB of RAM.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the
WhatsApp multi-device protocol over a WebSocket.

## Get started

```bash
npx wazap login                          # link your account with a pairing code
claude mcp add whatsapp -- npx -y wazap  # tell Claude Code about it
npx wazap status                         # confirm it is linked
```

`login` asks for your number in international format, prints an 8-character
code, and you enter it on your phone under **Settings → Linked devices → Link a
device → Link with phone number instead**. Prefer a QR code? `npx wazap login --qr`.

### Claude Desktop

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "wazap"]
    }
  }
}
```

Any MCP client works the same way: the command is `npx -y wazap`, the transport
is stdio. Tell the agent to call `learn` first — it returns the id formats, the
workflows and every error code with what to do about it.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide to every tool, id format and error code. Call it first. |
| `get_status` | read | Connection status, sync state, linked account, versions, data dir. |
| `list_chats` | read | Conversations newest-first; filter `all`/`unread`/`groups`/`individual`/`archived`. |
| `read_messages` | read | Messages in a chat; `before` pages further back, pulling older history from the phone. |
| `get_recent_messages` | read | Everything from the last N hours, grouped by chat. The catch-up tool. |
| `search_messages` | read | Text search across the locally held messages. |
| `get_message` | read | One message in full, with its quoted message and reactions. |
| `search_contacts` | read | Find contacts by name or number. |
| `get_contact` | read | Name, number, about text, profile picture. |
| `get_group_info` | read | Participants, admins, announcement mode, invite link (when you are admin). |
| `download_media` | read | Save an attachment to disk; small images also come back inline. |
| `send_message` | write | Send text, optionally as a reply, with @-mentions. |
| `send_media` | write | Send an image, video, audio, voice note or document from a path or URL. |
| `send_poll` | write | Send a poll with 2–12 options. |
| `send_location` | write | Send a map pin. |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `forward_message` | write | Forward a message to another chat. |
| `delete_message` | write | Retract your own message, within WhatsApp's 2-day window. |
| `manage_chat` | write | Archive, pin, mute (8h by default), mark read/unread. |
| `create_group` | write | Create a group and add participants. |
| `manage_group` | write | Add, remove, promote, demote, leave, rename, invite links. |

Every message comes back with a non-empty `text`: media and system messages
carry a placeholder such as `[image] caption`, `[voice message]`, `[deleted]` or
`[poll] Pizza or pasta?`. Timestamps are ISO 8601 with the machine's UTC offset,
alongside a human `age` like `2h ago`.

## Skills

wazap ships five [Agent Skills](https://agentskills.io) that teach an agent the workflows behind the tools, not just the tools:

| Skill | What the agent does |
| --- | --- |
| `wazap-setup` | Diagnose with `wazap status`, link by pairing code, connect Claude Desktop or Claude Code, repair an expired session |
| `whatsapp-inbox` | "What did I miss?" Triage into *needs you / FYI / noise*, ranked, plus forgotten replies. Read-only |
| `whatsapp-recall` | "Find the invoice Dan sent." Search with query variants, page back in time, download and read the file. Read-only |
| `whatsapp-groups` | Catch up on a 300-message group: decisions, dates, what is asked of you. Read-only |
| `whatsapp-send` | Draft in the chat's own register, show recipient and text, send only after the user says yes |

Install everything (server and skills) as a Claude Code plugin:

```
/plugin marketplace add razvangirgiz/wazap
/plugin install wazap@wazap
```

Or copy `skills/<name>/` into any skills directory your agent reads.

## Errors

Every failure is a structured `{ error, message, fix }` rather than a stack
trace, so an agent can decide whether to retry, ask the user, or stop.

| Code | Meaning |
| --- | --- |
| `NOT_LINKED` | No account linked. Run `npx wazap login`. |
| `SESSION_EXPIRED` | Unlinked from the phone. Run `npx wazap login`. |
| `SESSION_CORRUPT` | Credentials unreadable. Run `npx wazap logout` then `login`. |
| `NOT_CONNECTED` | Still connecting or reconnecting. |
| `SYNC_IN_PROGRESS` | History sync has not finished; results may be partial. |
| `INVALID_PHONE` | Number is not in international format. |
| `INVALID_ID` | Not a WhatsApp chat, contact or group id. |
| `NOT_ON_WHATSAPP` | That number has no WhatsApp account. |
| `CHAT_NOT_FOUND` / `MESSAGE_NOT_FOUND` / `CONTACT_NOT_FOUND` / `GROUP_NOT_FOUND` | Unknown id. |
| `NOT_A_PARTICIPANT` / `NOT_ADMIN` / `GROUP_ANNOUNCEMENT_ONLY` | Group permissions. |
| `MEDIA_UNAVAILABLE` | WhatsApp expired the file, or it was never synced here. |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `URL_FETCH_FAILED` | Outbound media problems. |
| `TEXT_TOO_LONG` | Over WhatsApp's message limit. |
| `EDIT_WINDOW_EXPIRED` / `RETRACT_WINDOW_EXPIRED` / `NOT_OWN_MESSAGE` | WhatsApp's own limits on editing and deleting. |
| `READ_ONLY` | wazap is running read-only. |
| `RATE_LIMITED` | Too many writes; `fix` says how long to wait. |
| `TIMEOUT` / `WHATSAPP_ERROR` | WhatsApp did not answer, or rejected the operation. |

## Data directory

Everything lives in `~/.wazap` (override with `--data-dir` or `WAZAP_DATA_DIR`),
created `0700` with credentials written `0600`:

```
~/.wazap/
  auth/         WhatsApp credentials — treat this like a password
  media/        downloads from download_media
  history/      per-chat message history, so a restart is not amnesia
  store.json    chat-list snapshot
  server.lock   pid of the running server
  .env          optional settings, see .env.example
```

Credential writes go to a temp file and are renamed into place, so killing the
process mid-write cannot leave you re-linking your phone.

One server per data directory: a second `wazap serve` on the same directory
exits with code 2 and tells you the pid of the one already running.

## Read-only mode

`WAZAP_READ_ONLY=1` or `wazap serve --read-only` does not register the write
tools at all. The agent never sees them, so it cannot message anyone from your
number even by mistake — useful when the linked account is your personal one.

Writes are also rate limited to `WAZAP_RATE_LIMIT` per minute (default 20, `0`
disables). Sending faster than a human is how accounts get banned.

## HTTP mode

```bash
WAZAP_READ_TOKEN=$(openssl rand -hex 32) \
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32) \
npx wazap serve --http --host 0.0.0.0 --port 8766
```

Streamable HTTP at `/mcp`, with a health check at `/healthz`. Two bearer tokens:
the read token gets the read tools, the write token also unlocks the write
tools, so a leaked read token can never message anyone. wazap refuses to bind a
non-loopback address without a read token.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `WAZAP_DATA_DIR` | `~/.wazap` | Where everything is stored. |
| `WAZAP_READ_ONLY` | `0` | Do not register the write tools. |
| `WAZAP_SYNC_FULL_HISTORY` | `0` | Ask WhatsApp for a fuller history sync. |
| `WAZAP_PERSIST_HISTORY` | `1` | Keep chats and messages across restarts. |
| `WAZAP_RATE_LIMIT` | `20` | Write tool calls per minute; `0` disables. |
| `WAZAP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `WAZAP_HOST` / `WAZAP_PORT` | `127.0.0.1` / `8766` | HTTP bind address. |
| `WAZAP_READ_TOKEN` / `WAZAP_WRITE_TOKEN` | unset | HTTP bearer tokens. |

Flags beat environment variables, which beat `<data-dir>/.env`.

## Known limitations

- **Unofficial.** Baileys reverse-engineers the WhatsApp multi-device protocol.
  This is not the WhatsApp Business API and Meta does not support it.
- **Ban risk is real.** Automated sending, bulk messaging or anything a human
  would not plausibly type can get the number banned, and that is not
  recoverable from here. The rate limit helps; it is not a guarantee.
- **Media keys expire.** WhatsApp drops old attachments from its servers, so
  `download_media` on an old message returns `MEDIA_UNAVAILABLE`.
- **History is what the phone syncs.** wazap sees the history WhatsApp hands the
  linked device, not your full phone archive. `read_messages` with `before` asks
  for more, within whatever WhatsApp still keeps.
- **`@lid` ids.** Newer accounts are addressed by a privacy id rather than a
  phone number. wazap translates them back to phone numbers when it has learned
  the mapping, and passes the `@lid` through when it has not.
- **Your phone must stay reachable.** A linked device stops receiving once the
  phone has been offline long enough; `get_status` says so in `hint`.

## Development

```bash
npm install
npm run typecheck
npm test                       # builds, then runs node --test
node test/smoke-stdio.mjs      # drives the built binary over MCP stdio
npm run dev -- status          # run from source with tsx
```

`npm test` needs no WhatsApp session. The stdio smoke test spawns the built
binary against a throwaway data directory and checks that an unlinked install
still answers `initialize`, `tools/list` and `get_status`.

MIT licensed.
