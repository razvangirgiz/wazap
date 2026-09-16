```
██╗    ██╗ █████╗ ███████╗ █████╗ ██████╗
██║    ██║██╔══██╗╚══███╔╝██╔══██╗██╔══██╗
██║ █╗ ██║███████║  ███╔╝ ███████║██████╔╝
██║███╗██║██╔══██║ ███╔╝  ██╔══██║██╔═══╝
╚███╔███╔╝██║  ██║███████╗██║  ██║██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝
```

**WhatsApp for your AI agent.** An MCP server that puts your WhatsApp account —
chats, messages, media, contacts, groups — behind 38 tools any MCP client can
call. Pairing-code login, no browser, no phone-number reseller, ~20 MB of RAM.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the
WhatsApp multi-device protocol over a WebSocket.

## Get started

The npm package is `wazap-mcp`; the command it installs is `wazap`.

```bash
npx wazap-mcp setup
```

That is the whole install. It links your account, finds the MCP clients
installed on this machine, writes their config, copies the five skills where
that client reads them, and tells you what to restart. At a terminal it is one
black, centered screen per step: ghosted ASCII logo, step number, then the
QR or the question. Piped output stays a log. When you
started through `npx`, `setup` offers to install wazap globally so Claude
Desktop and the background service have a path that does not change. It also
offers to `brew install` whisper-cpp, ffmpeg or Tailscale when a step needs one
and it is missing, and to restart Claude Desktop itself once it has connected it.

### Or the path your harness prefers

| Harness | Fastest path |
| --- | --- |
| Claude Code | `/plugin marketplace add razvangirgiz/wazap`, then `/plugin install wazap@wazap` |
| Claude Desktop | download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases) and double-click it |
| Gemini CLI | `gemini extensions install https://github.com/razvangirgiz/wazap` |
| Cursor | the [Install in Cursor](#other-mcp-clients) badge, then `npx wazap-mcp skills install cursor` |
| VS Code | the [Install in VS Code](#other-mcp-clients) badge |
| Codex CLI | `npx wazap-mcp connect codex`, then `npx wazap-mcp skills install codex` |
| OpenCode | `npx wazap-mcp connect opencode`, then `npx wazap-mcp skills install opencode` |
| Windsurf | `npx wazap-mcp connect windsurf` |
| Grok Bot | [Grok Bot / remote MCP](#grok-bot--remote-mcp) |
| Anything else | the MCP entry `npx -y wazap-mcp` over stdio, or a [self-hosted](#self-host) URL |

Each local harness registers the server. Grok Bot is a URL you paste. Linking
the WhatsApp account is a separate, one-time step: `npx wazap-mcp login`.

Or have your agent do it. Paste this:

*Set up WhatsApp for me: run `npx wazap-mcp setup --agent` and follow what it prints.*

Then ask your agent: *"what did I miss on WhatsApp today?"*

Below are the steps `setup` runs for you. Each is still its own command when you
want to run it by hand.

`npx wazap-mcp login` shows a QR code; scan it from **Settings → Linked devices
→ Link a device**. No camera handy, or linking over SSH? `npx wazap-mcp login --phone +15550100`
prints an 8-character code you type under *Link with phone number instead*.
It ends by asking whether the agent may send messages; the answer is no unless
you say yes, and `npx wazap-mcp config writes on` changes it later.

`npx wazap-mcp connect claude-code` writes the MCP entry for one client. The
table under **Connect a client** has the rest.

`npx wazap-mcp` on its own is safe to run: it prints where you stand and what to do
next, and starts no server. When something is off, `npx wazap-mcp status` is the
first thing to run — it checks Node, the data directory, the lock, the
credentials and whether a newer version is out, and prints the fix next to
anything broken.

### Connect a client

`wazap connect <client>` writes the entry for you, keeping whatever else is in
the file and backing it up once before the first change. `--dry-run` shows what
it would write.

| Client | What `connect` writes |
| --- | --- |
| `claude-code` | runs `claude mcp add whatsapp` for you |
| `claude-desktop` | `claude_desktop_config.json` in the Claude application directory |
| `cursor` | `~/.cursor/mcp.json` |
| `codex` | `[mcp_servers.whatsapp]` in `~/.codex/config.toml` |
| `vscode` | `./.vscode/mcp.json`, for the current workspace |
| `gemini` | `~/.gemini/settings.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `opencode` | `mcp.whatsapp` in `~/.config/opencode/opencode.json` |
| Grok Bot | client's MCP URL field: `http://<host>:<port>/mcp` with header `Authorization: Bearer <token>` (see [Grok Bot / remote MCP](#grok-bot--remote-mcp)) |
| anything remote | client's MCP URL field: `https://your-host/mcp` with header `Authorization: Bearer <token>`, or just the URL once [OAuth](#hosted-agents-oauth) is on (see [Self-host](#self-host)) |

### Grok Bot / remote MCP

Grok Bot is an HTTP MCP client. It does not launch wazap over stdio.

1. On the machine that will run wazap, `npx wazap-mcp login` until the CLI says the account is linked. `get_status` and `link_account` are MCP tools; they need HTTP already serving (step 3) and Grok already connected (step 4).
2. Answer writes yes or no at login. Writes stay on when `WAZAP_READ_ONLY` is unset. A Bearer write token is not writes being enabled. If write tools are missing, you need writes on (`wazap config writes on` and restart) and a write Bearer on this session. Config alone is not enough on HTTP.
3. Serve HTTP with a read token:

```bash
WAZAP_READ_TOKEN=$(openssl rand -hex 32) \
npx wazap-mcp serve --http
```

Set `WAZAP_WRITE_TOKEN` too only if this client should send, and put that value in the header in step 4.

4. In Grok Bot, add an MCP server at `http://<host>:<port>/mcp` with header `Authorization: Bearer <token>`. Then call `learn`, then `get_status`. `connected` means the WhatsApp socket is up. This session can send only when write tools are registered (`write_tools: true`, or send tools appear in the tool list). Then read.

`wazap setup` asks `Remote client (Grok Bot / HTTP MCP)?` and prints the same URL and header. Answering yes does not start `expose`.

### Other MCP clients

Cursor and VS Code install from a link:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](cursor://anysphere.cursor-deeplink/mcp/install?name=whatsapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndhemFwLW1jcCJdfQ)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22whatsapp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22wazap-mcp%22%5D%7D)

Both carry the same entry `connect` writes. Where a custom scheme is stripped
before you can click it, VS Code also takes
[the https form](https://insiders.vscode.dev/redirect/mcp/install?name=whatsapp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22wazap-mcp%22%5D%7D).
`node scripts/badges.mjs` reprints all three.

Any other MCP client works the same way: the command is `npx -y wazap-mcp`, the
transport is stdio. Tell the agent to call `learn` first — it returns the id
formats, the workflows and every error code with what to do about it.

<details>
<summary>The raw entries, for editing by hand</summary>

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "wazap-mcp"]
    }
  }
}
```

Claude Desktop, Cursor, Gemini CLI and Windsurf take exactly that. VS Code nests
it under `servers` and wants a `"type": "stdio"` alongside `command`. Codex CLI
is TOML:

```toml
[mcp_servers.whatsapp]
command = "npx"
args = ["-y", "wazap-mcp"]
```

OpenCode takes the command and its arguments as one array, under `mcp`:

```json
{
  "mcp": {
    "whatsapp": { "type": "local", "command": ["npx", "-y", "wazap-mcp"] }
  }
}
```

</details>

The `skills/` folder follows the [Agent Skills](https://agentskills.io) format, so Codex, Cursor and other skill-aware agents can load the same five skills.

### Gemini CLI

```bash
gemini extensions install https://github.com/razvangirgiz/wazap
```

That reads `gemini-extension.json` at the repo root, so it registers the MCP
server and loads `GEMINI.md` — the five skills below, concatenated, because the
Gemini CLI takes one context file per extension rather than a skills directory.
`wazap connect gemini` writes the server alone, without the context.

`GEMINI.md` is generated: `npm run context:build` rebuilds it from
`skills/*/SKILL.md`, and a test fails if the two have drifted, so a workflow is
only ever edited in its skill.

### Claude Desktop, without a terminal

Download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases)
and double-click it. Claude Desktop installs the server, its Node dependencies
and the icon, and shows two settings: **Read-only**, ticked, and **Data
directory**, empty. `wazap connect claude-desktop` does the same job by editing
`claude_desktop_config.json`. Claude Desktop starts its servers without your
shell PATH, so that entry is the absolute path to `node` when wazap is installed
globally, and `npx` otherwise; `wazap setup` checks that the entry it wrote is
one Claude Desktop can actually launch.

Then ask Claude to link your WhatsApp. It calls `link_account` with your number,
hands back an 8-character code, and you type that code into **WhatsApp →
Settings → Linked devices → Link a device → Link with phone number instead**.
No terminal at any point. `npx wazap-mcp login` does the same job from a shell
when you have one.

Untick **Read-only** to let Claude send. It ships ticked because a bundle that
can message people from your number before you have said so is the wrong
default, and because the setting cannot be left unanswered: the manifest format
has no way to omit an argument, so the box you see is the answer the server gets.
`link_account` is registered either way. Read-only exists to stop Claude
messaging people from your number, and relinking your own dead session messages
nobody.

Build it yourself with `npm run bundle:mcpb`, which stages `dist/`, the
manifest, the icon and a fresh production `node_modules`, then packs them with
[`@anthropic-ai/mcpb`](https://github.com/modelcontextprotocol/mcpb).

### Keep it running

A wazap started by a client lives as long as that client does. Quit Claude Code
and the session is gone until you open it again. Two commands change that.
Staying up and being reachable are separate choices.

```bash
npx wazap-mcp service install
```

That writes a launchd agent on macOS (`~/Library/LaunchAgents/com.wazap.server.plist`)
or a systemd user unit on Linux (`~/.config/systemd/user/wazap.service`), starts
it, and waits for `/healthz` to answer. The unit runs `serve --http` on
`127.0.0.1:8766` with the absolute path of this Node and this install, so it
survives a reboot and a logout. Point any client at
`http://127.0.0.1:8766/mcp`, or keep using the stdio entry. A second wazap on
the same data directory becomes a bridge onto the session this one holds.

`service status` prints the pid, the health check and whether the unit still
runs the version you have installed. `service logs` tails it. `service restart`
picks up an upgrade; `service uninstall` removes the unit and leaves your
session and credentials alone. `wazap login` needs the session to itself, so it
stops the service, pairs, and starts it again on its own. `wazap logout` and
`wazap account` changes do not stop anything: the running server applies them.

A sleeping Mac is an offline wazap. System Settings → Lock Screen, or Battery →
Options, has the switch that keeps it awake on power.

```bash
npx wazap-mcp expose
```

That gives the running service a public `https` URL, for agents that are not on
this machine: a cloud agent, claude.ai, ChatGPT. It uses Tailscale Funnel if
`tailscale` is installed, Cloudflare Tunnel if `cloudflared` is, opens the
tunnel, writes `WAZAP_PUBLIC_URL` and a fresh `WAZAP_OAUTH_PASSWORD` into
`<data-dir>/.env`, restarts the service and checks the URL from here. It then
prints the MCP URL and the password once.

Give an agent the URL only. It signs in on a consent page on your own host with
that password and picks read or read-and-send there; `wazap status` lists who
holds a grant. See [Hosted agents (OAuth)](#hosted-agents-oauth) for what that
page does. `npx wazap-mcp expose off` takes the tunnel down and keeps the
password, so the next `expose` hands agents the same one.

`npx wazap-mcp setup` asks all of this once, as its fourth step.

### Upgrade

```bash
npx wazap-mcp update
```

One command for what used to be three. It compares this install against the
registry, installs the new package when wazap is global, restarts the service so
it runs the new code, and copies the new skills into every harness that keeps
them. `--dry-run` prints the plan and touches nothing.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide to every tool, id format and error code. Call it first. |
| `get_status` | read | Connection status, sync state, linked account, named-contact count, versions, data dir. Top-level fields are the default account; `accounts` lists every live one. Optional `account_id` on this and every other tool. |
| `list_accounts` | read | Every configured account: id, name, status, masked phone, owner name, writes policy. Call this first when more than one account is linked. |
| `link_account` | read | Pair an account that already exists (`wazap account add`). Returns the code to type into the phone. Registered in read-only mode too. |
| `list_chats` | read | Conversations newest-first; filter `all`/`unread`/`groups`/`individual`/`archived`. |
| `read_messages` | read | Messages in a chat; `before` pages further back, pulling older history from the phone; `types` narrows to one or more message types, e.g. `["call"]`; `include_previews` attaches a small image of each photo. |
| `get_recent_messages` | read | Everything from the last N hours, grouped by chat. The catch-up tool. `include_system` adds WhatsApp's own notices, `types` narrows to one or more message types, `include_previews` attaches a small image of each photo, `compact` halves it for a routine catch-up. |
| `get_unanswered` | read | Who is waiting on the user: chats whose last word is theirs and asks for something, with the ask quoted. Groups only when the user was @-mentioned or replied to. |
| `set_contact_note` | local | Remember something about a person, on this machine only; it then shows next to their name everywhere. |
| `update_contact_details` | local | File tags and key-value details on a person ("role": "contabil", tag "client"); `search_contacts` matches them, so roles and groups of people resolve. |
| `mark_handled` | local | Take a chat off `get_unanswered` until the other side writes again. Nothing changes on WhatsApp. |
| `get_stories` | read | The stories (status updates) received in the last day, by author, with previews on request. They show nowhere else. |
| `wait_for_messages` | read | Block up to 55 s until a message arrives, then return it with a cursor for the next call. `addressed_to_me` wakes only for direct messages, @-mentions and replies. |
| `search_messages` | read | Text search across every message the account keeps; `since`, `until` and `from` narrow it, and the answer says how many messages it searched, or how far back when a very short or common query reached the scan limit. |
| `recall` | read | Search by meaning and by words at once over the whole kept history, so a paraphrase or another language still hits. Off until [turned on](#semantic-recall). |
| `get_message` | read | One message in full, with its quoted message, each reaction with who left it, and who voted for each option of a poll or answered an event. On your own messages, `delivery` says whether it was sent, delivered, read or played, and in a group who read it and when; it stops at delivered or is missing when read receipts are off on either side, and large groups may send none. |
| `search_contacts` | read | Find contacts by name, number, tag or detail; `tag` alone lists everyone filed under it. |
| `sync_contacts` | read | Fetch the phone's address book from WhatsApp again, when names are missing. |
| `get_contact` | read | Name, number, about text, profile picture. |
| `get_group_info` | read | Participants, admins, announcement mode, who may edit the info or add members, join approval, disappearing messages, community, invite link (when you are admin). |
| `download_media` | read | Save an attachment to disk; small images also come back inline. |
| `transcribe_audio` | read | Turn a voice note or audio message into text, with the local or the API provider. |
| `send_message` | write | Draft text, optionally as a reply, with @-mentions. Does not send. |
| `send_media` | write | Draft an image, video, audio, voice note, document or GIF (`as_gif`: an mp4 loops, a .gif is converted with ffmpeg) from a path or URL. Does not send. |
| `send_poll` | write | Draft a poll with 2–12 options. Does not send. The votes then show on the poll message. |
| `send_location` | write | Draft a map pin. Does not send. |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `forward_message` | write | Draft a forward to another chat. Does not send. |
| `confirm_send` | write | Send a draft after the user has seen the preview and said yes. A draft is sent at most once; see [Sending once](#sending-once). |
| `delete_message` | write | `for_everyone: true` retracts your own message, within WhatsApp's 2-day window, and in a group where you are admin someone else's message too. `for_everyone: false` deletes any message for the linked account only, at any age. |
| `set_profile_picture` | write | Set the linked account's own profile photo from a local path or URL. Hits WhatsApp immediately. |
| `manage_chat` | write | Archive, pin, mute (8h by default), mark read/unread; pin a message for everyone (24h, 7 days or 30 days) or star it; clear or delete the chat for the linked account; block or unblock a person. |
| `create_group` | write | Create a group and add participants. |
| `join_group` | write | Join a group from an invite link or an invite message. Without `confirm: true` it only shows the group's name, description, size and whether an admin must approve; with it, it joins, or leaves the request waiting for an admin. |
| `manage_group` | write | Add, remove, promote, demote, leave, rename, set or remove the group photo, invite links, list, approve or reject join requests, and change the settings: only admins post, only admins edit the info, who adds members, join approval, disappearing messages. Every member sees a change at once. |
| `save_contact` | write | Add a number to the account's WhatsApp contacts, or rename an entry; `save_on_phone` (default) also writes the phone's own address book. |
| `remove_contact` | write | Drop a contact entry; the chat and its history stay. |

### Sending once

Nothing reaches WhatsApp until `confirm_send`, and a draft goes out at most
once, even across a crash. Drafts are kept in the account database for 15
minutes, at most 20 per MCP session and 200 per account, each with the WhatsApp
message id it will be sent under. Confirming a draft again answers the same receipt with
`already_sent: true`, and two confirms at once send it once. A failure while
the message is still being prepared (not connected, the write budget, the
number lookup, a missing file, a media upload) leaves the draft as it was, to
confirm again. Once the message is handed to WhatsApp's relay (which also looks
up the recipient's devices and encrypts it before writing), a failure answers
`SEND_OUTCOME_UNKNOWN`: WhatsApp may have the message, so that draft is never
sent again. The agent checks the chat instead. When WhatsApp later echoes that
message id, the send is recorded as sent, and the session that confirmed it gets
the receipt from then on. For 24 hours a confirmed draft answers its receipt or
`SEND_OUTCOME_UNKNOWN` to that session; deleting the sent message, or clearing
or deleting its chat, removes its words from the record. MCP sessions do not survive a restart: after one, no
session can confirm a draft made before it, sent or not, though a send the
restart interrupted is still recorded as unknown and still settles when its id
is echoed.

### Seeing, waiting, following up

`include_previews: true` on `get_recent_messages` or `read_messages` attaches a
small JPEG of each photo as an image block, newest first, up to 12 per call,
and labels each message line with the preview it belongs to, so a catch-up can
say "a photo of a receipt" without a download. WhatsApp used to ship such a
preview inside every image message and in 2026 almost never does, so when
none is there wazap downloads the photo once, shrinks it to 320 px on this
machine with pure JavaScript, and keeps the result as a file under
`previews/` in the data directory, so a restart does not redo it. A video gets
one frame, taken by ffmpeg a second in, when ffmpeg is installed. The first
call over a day of photos takes a few seconds; the next is instant.

`wait_for_messages` blocks until something arrives, up to 55 seconds, then
returns it with a `cursor`. Calling it again with that cursor replays whatever
landed in between, so an agent can sit in a loop and miss nothing. With
`addressed_to_me` only direct messages, @-mentions of the user and replies to
their messages wake it; group chatter does not. The user's own messages and
WhatsApp's notices never do.

`get_unanswered` returns the chats whose last word is the other side's and reads
as an ask: a question mark, a request word, or a voice note nobody has heard
yet. "Ok, thanks" is not an ask, a link is not a question, and an ask older
than two weeks (`max_age_hours`) was abandoned rather than left waiting. People
come first, then the oldest wait, each with the ask quoted and how long they
have been waiting; a WhatsApp Business account is marked, since its asks are
often automatic replies.

Every message comes back with a non-empty `text`: media and system messages
carry a placeholder such as `[image] caption`, `[voice message · 0:42]`, `[deleted]` or
`[poll] Pizza or pasta?`. A poll also carries each option with who voted for it,
and an event who answered going, maybe or not going. Timestamps are ISO 8601 with the machine's UTC offset,
alongside a human `age` like `2h ago`.

## Voice messages

A voice note is the one message an agent cannot read. Switch transcription on and
it becomes text: `[voice message · 0:42] "sunt la notar, ajung în 20 de minute"`,
with the bare words also in a `transcript` field. `get_recent_messages` and
`search_messages` see that text, so a voice note becomes findable by what was
said in it.

Pick a provider once, in `wazap setup` or later:

```bash
wazap config transcribe local     # free and private, one 574 MB model on disk
wazap config transcribe openai    # cheap and fast, the audio leaves this machine
wazap config transcribe off
```

| | `local` | `openai` |
| --- | --- | --- |
| Runs | whisper.cpp, here | any OpenAI-compatible `/audio/transcriptions` |
| Costs | nothing | per minute of audio, on your key |
| Privacy | the audio never leaves this machine | **the audio leaves this machine** |
| Needs | `whisper-cpp` and `ffmpeg`, plus a model | an API key |

### Local, with whisper.cpp

```bash
brew install whisper-cpp ffmpeg      # macOS; elsewhere build whisper.cpp, install ffmpeg from your package manager
wazap transcribe download            # fetch and verify the model
wazap transcribe test recording.ogg  # prove it before you trust it
```

`wazap setup` and `wazap transcribe download` offer that `brew install`
themselves when either binary is missing, and go straight on to the model in the
same run. `--no-brew` turns the offer off everywhere.

Models land in `<data-dir>/models/` and are checked against a SHA-256 pinned in
the source. The shared whisper/embedding downloader stops an oversized response
before excess bytes are written, independently of `Content-Length`. Only a
successfully closed write with the exact size and digest is renamed from `.part`
to the final model file.

The network/write phase has a 30-second no-progress timeout (including waiting
for response headers) and an overall deadline of 30 minutes or the time the
model takes at 100 KiB/s, whichever is longer (about three hours for large-v3). A timeout or interrupted
transfer keeps a bounded partial file for a later retry to resume; an invalid
range, oversized response or failed verification discards it. A receiver that
ignores Range restarts the download safely. CDN redirects remain supported,
but compressed responses are refused so byte ranges remain unambiguous. Errors
report status/category, not signed URLs, response excerpts or raw disk errors.

Each destination has an exclusive `<model>.download-lock/` directory, held from
cache verification through the final rename and cleanup. A simultaneous download
of that model fails promptly with a retry hint; different models can download
in parallel. Directory symlinks and relative paths use the same canonical parent.
The lock is released on success, handled failures and cancellation; if it
cannot be removed, the verified model is kept and the next run names the
directory.

A known dead owner on the same host/PID scope can be recovered automatically;
Linux also checks the PID namespace. Live owners are never evicted by age. If a
process dies during lock initialization/cleanup, or the owner record is corrupt,
from another scope or inaccessible, recovery fails closed. Inspect the
`owner-*.json` inside the lock directory and remove **only that lock directory**
only after confirming no downloader is still using the model. Then rerun the
command to reuse the partial file when possible. Never remove an active lock.
This coordinates cooperating versions on one host, not distributed downloads
across machines; stop older downloaders before upgrading.

| `WAZAP_WHISPER_MODEL` | File | Size |
| --- | --- | --- |
| `turbo` (default) | `ggml-large-v3-turbo-q5_0.bin` | 574 MB |
| `large-v3` | `ggml-large-v3-q5_0.bin` | 1.08 GB |
| `medium` | `ggml-medium-q5_0.bin` | 539 MB |

`turbo` is the default because it is the smallest model that still gets Romanian
right. `medium` and below drop diacritics and mangle names, which is worse than
no transcript at all: a missing transcript is a question, a wrong name is a wrong
answer. `large-v3` is the same accuracy for several times the wait.

### An API, OpenAI-compatible

`wazap config transcribe openai` asks for the key without echoing it and stores
it in `<data-dir>/.env`. The default endpoint is OpenAI; Groq works unchanged:

```bash
WAZAP_TRANSCRIBE_URL=https://api.groq.com/openai/v1
WAZAP_TRANSCRIBE_MODEL=whisper-large-v3-turbo
```

**With this provider the audio leaves your machine.** Every voice note wazap
transcribes is uploaded to that endpoint. If that is not acceptable, use `local`,
which uploads nothing.

The key is treated as a secret rather than as a setting:

- It is never accepted as a command-line argument, because an argument lands in
  your shell history and in `ps`.
- The prompt echoes nothing, not even asterisks.
- It is stored only in `<data-dir>/.env`, mode `0600`.
- `status`, `status --json`, `config` and `get_status` show at most
  `api key: set (…abcd)`.
- Provider error bodies, transport exception details and malformed-JSON excerpts
  are not printed. Errors retain HTTP status, timeouts and actionable fixes.
- A plain-`http` `WAZAP_TRANSCRIBE_URL` is refused unless it points back at this
  machine. Userinfo credentials, queries and fragments are not allowed in this
  base URL; set the API key separately.
- Redirects are refused, including same-origin redirects: configure the final
  base endpoint directly. This keeps audio and credentials on the intended route.
- Successful JSON responses are capped at 1 MiB, including chunked responses.
  Error response bodies are discarded without being read.

### Without being asked

With a provider configured, incoming voice notes of up to ten minutes are
transcribed in the background as they arrive, never holding up a message. The
transcript is stored with the message, so a voice note is transcribed once, and
its words are searchable, recalled and carried by the webhook event.

- **Durable.** The note is queued in the account database in the same
  transaction that stores it, so a restart or a crash resumes the queue
  instead of dropping it. A note that just arrived starts at once, ahead of any
  backlog, which is what lets its webhook event carry the words. A stop waits
  up to 30 s for a transcription under way to store its words, so a note is
  not paid for twice; removing an account cancels it instead.
- **One at a time for the whole server.** Every account shares one
  transcriber and they take turns, so a backlog on one does not starve another
  and two whisper.cpp runs never fight for the machine. Only the server
  (`wazap serve`, the service) transcribes; short commands such as
  `wazap status --live` queue what arrives and leave it to the server.
- **Retried, then given up on.** A download that times out, a provider
  answering 429 or 5xx, or whisper.cpp crashing is tried again after 10 s and
  after a minute more, three attempts in all. Media WhatsApp no longer holds,
  audio the provider refuses as input, or a file too large gives up at once.
  A note given up on is not queued again; `transcribe_audio(message_id)`
  still tries it on request.
- **Waiting costs nothing.** A note whose account is disconnected spends no
  attempt and runs within seconds of the connection opening. A provider that
  cannot take any note — whisper.cpp or its model missing, an API refusing the
  key — pauses all transcription for 30 s, then twice as long each time up to
  15 minutes, and one note probes it before any other audio is downloaded.
  Meanwhile webhook events post the `[voice message · 0:42]` placeholder at
  once instead of waiting for words that are not coming.
- **Deleted means dropped.** A note deleted, expired or cleared while it
  waits leaves the queue and is never uploaded.
- **A day at most.** A note still waiting 24 hours after it was queued (the
  account offline, the provider paused) is given up on as `too_old` and never
  transcribed on its own later.
- **Local stays local.** Each note remembers whether it was queued for
  `local` or for an API. A note queued under `local` is never sent to an API
  provider configured afterwards: it is given up on as `provider_changed`. A
  note queued for an API may still be transcribed locally.
- **History: the last day only.** A note that a history sync brings (a first
  link, a relink) is queued only when it is less than 24 hours old, so linking
  never transcribes the archive. A note WhatsApp delivers live is always
  queued, however old its timestamp.

Audio *files* are left alone, since one can be an hour long, and so are notes
you recorded and notes WhatsApp gave no length for; call
`transcribe_audio(message_id)` for those. `WAZAP_TRANSCRIBE_AUTO=0` keeps the
tool and stops the background work; with it, or with the provider switched
off, a queue already stored is kept and waits, and it continues under the
provider configured next, within the day and the local-stays-local rule.
`get_status` shows the queue under `transcription` (how many wait, how long
the current run has taken, how many were given up on, the latest reason, a
pause and until when, never content), and `wazap status` prints a
`voice queue` line, a warning when notes wait and nothing will run them.

## Semantic recall

`search_messages` matches exact words; `recall` matches what was meant and the
words at once: a paraphrase or another language still hits through its meaning,
a short or foreign-language question through its words, and the two rankings
are fused. Both reach every message the account keeps. For an exact string — an
id, a phone number, a URL — `search_messages` stays the right tool.

Off by default, and fully local: a `llama-server` sidecar bound to loopback
does the embedding, so nothing leaves the machine. It needs llama.cpp, the
pinned model and persisted history (`WAZAP_PERSIST_HISTORY`, on by default):

```bash
brew install llama.cpp      # macOS; elsewhere build llama.cpp and put llama-server on PATH
wazap embed download        # fetch the embedding model, ~318 MB sha256-verified
wazap config recall local   # then restart the service
```

`wazap embed download` offers the `brew install` itself when `llama-server`
is missing. `wazap status` runs the three checks — `recall`, `llama-server`,
`embed model` — and `get_status` reports the index as `off`, `indexing`,
`ready` or `degraded`.

`chat_id`, `since`, `until` and `from` narrow a recall exactly like
`search_messages`. Hits rank by a fused score (reciprocal rank fusion of the
word and meaning rankings), and a hit found only by meaning must clear the
similarity floor, so a question with no answer comes back empty. A match found
by meaning counts half as much a month on, one chat takes at most three leading
places before other chats' hits, and a near-duplicate trails the list. The vectors
live in the account database next to their messages, are made in the
background for every message that has none, and leave with their message when
it is deleted, revoked or expires; an edit makes its vector again. A message
wazap holds only as text — carried over from the recall index an older wazap
built — is marked `index only`: `get_message` returns its text, but
`download_media` has nothing to open and it cannot be replied to or forwarded.

Embedding requests refuse redirects, cap replies at 4 MiB and validate vector
shape and finite values. Provider bodies and decoder stderr are not copied into
errors. The test-only `WAZAP_EMBED_URL` override is an operator-controlled sink:
setting it to another machine sends message/query text there. Do not point it at
an untrusted service; credentials, query strings and fragments in that URL are
refused, and diagnostics show its host only.

The knobs — `WAZAP_RECALL`, `WAZAP_EMBED_MODEL` (`embeddinggemma-300m` by
default, `e5-base-multilingual` for an older llama.cpp), `WAZAP_EMBED_BIN`,
`WAZAP_RECALL_MIN_SIMILARITY` — are documented in `.env.example`.
`WAZAP_RECALL_MAX` is still validated but no longer caps anything: every kept
message is indexed.

## Skills

wazap ships five [Agent Skills](https://agentskills.io) that teach an agent the workflows behind the tools, not just the tools:

| Skill | What the agent does |
| --- | --- |
| `wazap-setup` | Diagnose with `wazap status`, link by QR or pairing code, connect a client with `wazap connect`, repair an expired session |
| `whatsapp-inbox` | "What did I miss?" Triage into *needs you / FYI / noise*, ranked, plus forgotten replies. Read-only |
| `whatsapp-recall` | "Find the invoice Dan sent." Search with query variants, page back in time, download and read the file. Read-only |
| `whatsapp-groups` | Catch up on a 300-message group: decisions, dates, what is asked of you. Read-only |
| `whatsapp-send` | Draft in the chat's own register, show recipient and text, send only after the user says yes |

`wazap setup` copies them into every client it connects, so there is usually
nothing to run. The command behind it, for a harness `setup` never offered or
for a checkout you want to install by hand:

```bash
npx wazap-mcp skills install codex     # or claude-code, cursor, opencode, agents
```

With no harness named it installs into every client it finds on this machine.
For Claude Code the other route is the plugin, which carries the server as well:

```
/plugin marketplace add razvangirgiz/wazap
/plugin install wazap@wazap
```

| Harness | Where the five directories land |
| --- | --- |
| `claude-code` | `~/.claude/skills/` |
| `codex` | `~/.agents/skills/`, the directory Codex documents for user skills. Cursor and OpenCode read it too |
| `cursor` | `~/.cursor/skills/` |
| `opencode` | `~/.config/opencode/skills/` |
| `agents` | `./.agents/skills/`, in the current project, for anything that reads the cross-tool convention |

Re-running overwrites, so an upgrade is the same command. `--dry-run` lists
what it would copy.

A client with no skills directory is not left out. The server registers each of
the five as an MCP prompt of the same name, and sends a short `instructions`
block that names all five and says when each applies, so an agent that never saw
the skill files still follows them. That is how Claude Desktop, VS Code and
Windsurf get the workflows. A bridged session and a self-hosted HTTP server
carry them the same way.

## Errors

Every failure is a structured `{ error, message, fix }` rather than a stack
trace, so an agent can decide whether to retry, ask the user, or stop.

| Code | Meaning |
| --- | --- |
| `NOT_LINKED` | No account linked. Call `link_account`, or run `npx wazap-mcp login`. |
| `ALREADY_LINKED` | `link_account` was called on a session that is already linked. Call `get_status`. |
| `SESSION_EXPIRED` | Unlinked from the phone. Run `npx wazap-mcp login`. |
| `SESSION_CORRUPT` | Credentials unreadable. Run `npx wazap-mcp logout` then `login`. |
| `NOT_CONNECTED` | Still connecting or reconnecting, or preparing the account database once after an upgrade. |
| `SYNC_IN_PROGRESS` | History sync has not finished; results may be partial. |
| `INVALID_PHONE` | Number is not in international format. |
| `INVALID_ID` | Not a WhatsApp chat, contact or group id. |
| `NOT_ON_WHATSAPP` | WhatsApp answered that the number has no account. A lookup it did not answer is `NOT_CONNECTED`. |
| `CHAT_NOT_FOUND` / `MESSAGE_NOT_FOUND` / `CONTACT_NOT_FOUND` / `GROUP_NOT_FOUND` | Unknown id. |
| `NOT_A_PARTICIPANT` / `NOT_ADMIN` / `GROUP_ANNOUNCEMENT_ONLY` | Group permissions. |
| `MEDIA_UNAVAILABLE` | WhatsApp expired the file, or it was never synced here. |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `URL_FETCH_FAILED` / `INVALID_IMAGE` | Outbound media problems. |
| `TEXT_TOO_LONG` | Over WhatsApp's message limit. |
| `EDIT_WINDOW_EXPIRED` / `RETRACT_WINDOW_EXPIRED` / `NOT_OWN_MESSAGE` | WhatsApp's own limits on editing and deleting. |
| `READ_ONLY` | wazap is running read-only. |
| `RATE_LIMITED` | Too many writes; `fix` says how long to wait. |
| `DRAFT_NOT_FOUND` / `DRAFT_EXPIRED` | The draft is unknown, from another MCP session, sent more than 15 minutes ago, or expired unsent. Draft again. |
| `SEND_OUTCOME_UNKNOWN` | The message reached the socket and then the send failed, so WhatsApp may have it. The draft is never sent again; check the chat before drafting anew. |
| `SEND_BLOCKED` | The account's send rules refuse this recipient. `wazap config send` changes them; the agent must not route around. |
| `AMBIGUOUS_ACCOUNT` | More than one account could handle this, or a write named a chat no account knows. Pass `account_id`. |
| `ACCOUNT_NOT_FOUND` | No account with that id. Run `wazap account add`, or call `list_accounts`. |
| `ACCOUNT_DISABLED` | That account is disabled. Run `wazap account enable <id>`; a running server picks it up. |
| `TIMEOUT` / `WHATSAPP_ERROR` | WhatsApp did not answer, or rejected the operation. |

## Data directory

Everything lives in `~/.wazap` (override with `--data-dir` or `WAZAP_DATA_DIR`),
created `0700` with credentials written `0600`. A data dir from before several
accounts moves into `accounts/default/` the first time a wazap command runs.

```
~/.wazap/
  accounts.json     which accounts exist, and which is default
  accounts.json.required  empty marker: missing policy must not reset permissions
  accounts/<id>/
    auth/           WhatsApp credentials — treat this like a password
    media/          downloads from download_media
    wazap.sqlite    the account database: chats, contacts, messages, reactions,
                    receipts, transcripts, notes, recall vectors, deletion
                    barriers, the webhook outbox (plus -wal and -shm beside it)
    previews/       one small JPEG per photo or video already previewed
    qr.png          last QR, when login showed one
    legacy/         an earlier wazap's store.json, history/, retention.json,
                    notes.json and recall/, once imported; deleted a week later
    wazap.<time>.previous-owner.sqlite
                    the database a different number's link set aside; deleted a week later
  legacy/           the 0.15 beta archive.sqlite, once imported; deleted a week later
  models/           whisper.cpp and embedding models, when transcription or recall run locally
  server.lock       pid of the running server
  daemon.json       loopback endpoint a second wazap bridges to
  control.json      private loopback line the CLI uses to change the running server
  oauth.json        registered agents and hashed OAuth grants, when OAuth is on
  .env              optional settings, see .env.example
  migration.json    written once when a flat dir moved into accounts/default
```

Credential writes go to a temp file and are renamed into place, so killing the
process mid-write cannot leave you re-linking your phone.

### The account database

Each account keeps what it has seen in one SQLite file, `wazap.sqlite` (`0600`,
in a `0700` folder), written with a full sync on every commit. Nothing of the
history is held in memory: every read, search and restart goes to the file, and
only small bounded caches stay in the process.

- **Upgrade.** A data dir an earlier wazap wrote has `store.json`, `history/`,
  `retention.json`, `notes.json`, `recall/` and perhaps the beta
  `archive.sqlite`. The first start imports them once, before the account is
  served; meanwhile its tools answer `NOT_CONNECTED` and `get_status` says it is
  preparing its database. A stop in the middle resumes where it left off at the
  next start. The import checks the database against what those files showed;
  a difference it cannot explain is logged by category and count, shown by
  `wazap status`, and the account is served from the database anyway. An
  unreadable `retention.json` stops the import, since history without its
  deletion barriers could bring deleted messages back. Once imported, the legacy
  files move into `legacy/` and are never read again; see
  [Upgrading to 0.22](#upgrading-to-022).
- **Logout** deletes the credentials, and nothing else: the database stays,
  tied to the number, so the same number linking again finds its history.
  **A different number linking** sets the earlier database aside as
  `wazap.<time>.previous-owner.sqlite` and starts an empty one: one person's
  history never shows under another's, and legacy files the earlier number
  never imported stay for it. When the earlier number links again, its
  set-aside database comes back. A set-aside file nobody links is deleted a
  week later; `WAZAP_RETENTION=1` does not shorten that week.
  **`wazap account remove`** stops the account, closes its database and deletes
  the whole folder with it.
- **`WAZAP_PERSIST_HISTORY=0`** removes every stored message at each start and
  stop, whatever `WAZAP_RETENTION` says, and with them every draft and the words
  of every send record; chats, contacts, notes, deletion barriers and the send
  records themselves stay, and recall is off.

- **`wazap status`** reads each database read-only, with the server running or
  not: whether it is preparing (and the import phase), ready or imported with
  unexplained differences, its size, messages, chats and embedding queue, the
  legacy files and when they go, set-aside databases and the beta archive.
  `--json` carries the same as `storage`.

### Upgrading to 0.22

0.22 moves each account from its files to the account database, once.

1. **The first start imports.** Each account imports `store.json`, `history/`,
   `retention.json`, `notes.json`, `recall/` and, for the number it is linked
   to, the 0.15 beta `archive.sqlite`. Until that is done the account's tools
   answer `NOT_CONNECTED`, and `get_status` and `wazap status` say it is
   preparing, with the phase it reached. A stop resumes at the next start. An
   account not linked at the upgrade imports the beta archive at the first
   start after its number links.
2. **The files move aside.** Once imported, an account's files move into
   `accounts/<id>/legacy/`, and the beta archive into `<data-dir>/legacy/` once
   every enabled account linked to its number has imported it. They are deleted
   a week after the move (`wazap status` shows the date), or at once with
   `WAZAP_RETENTION=1`. Only what wazap moved is deleted. An import whose check
   found differences it could not explain keeps its files until you delete
   them, and `wazap status` says how. A beta archive nobody linked to its
   number has imported stays where it is.

#### Rolling back to 0.21

A rollback trades what happened since the upgrade for the old files, and is
only possible while those files exist.

- **What you lose on 0.21:** every message, edit, reaction and note from the
  time you ran 0.22, and every deletion made then. Messages deleted while you
  ran 0.22 show again on 0.21, because its files predate the deletion.
- **When you cannot:** with `WAZAP_RETENTION=1` (the files were deleted at the
  upgrade), and once the week after the move is over. `wazap status` tells you
  whether `legacy/` still exists.

In this order:

1. Stop the server: `wazap service stop`, or stop the process that runs it.
2. Back up the whole data dir (`cp -a ~/.wazap ~/.wazap-backup`) and keep that
   copy until you are sure.
3. For each account, move everything in `accounts/<id>/legacy/` back into
   `accounts/<id>/`. Leave `wazap.sqlite` where it is: 0.21 ignores it.
4. Install 0.21.0 (`npm i -g wazap-mcp@0.21.0`) and start it.

To upgrade again later: stop the server, move `wazap.sqlite` with its `-wal`
and `-shm` out of `accounts/<id>/` (into your backup; do not delete it, it
holds what arrived while you ran 0.22), put the beta archive back at
`<data-dir>/archive.sqlite` if you want it imported again, and start 0.22. It
imports the files as 0.21 left them. Never remove `wazap.sqlite` while part of
the legacy files is still in `legacy/` or already deleted: the next start would
build the account from what is left.

### Deleted and disappearing messages

An observed delete or revoke tombstones the message in the database in one
transaction: its text, protobuf, transcript, reactions, votes, receipts and
recall vector go, a reply quoting it loses the quoted copy, and reads stop
showing it at once. Its preview file is removed through a queue kept
in the database, so a crash between the two finishes the removal at the next
start. Successful delete/clear tools wait for that cleanup; a disk failure is
reported even if WhatsApp already accepted the deletion. Pending
preview/transcription results cannot restore a deleted message. A revoke only
ever removes a message in the chat it arrived in. Chat metadata never keeps an
embedded copy of a message.

The tombstones and each chat's clear time are the barriers: message IDs and
times, no bodies. They keep replay and backfill from resurrecting a deleted
message, and they remain even with `WAZAP_PERSIST_HISTORY=0`. Clearing a chat
hides it at once and purges it in chunks that resume after a crash; backfill
dated at or before the local clear time is refused. WhatsApp timestamps have
second precision, so a message in the same second can be suppressed. A
database that cannot be opened keeps the account from being served rather than
replay deleted messages.

#### Strict retention (`WAZAP_RETENTION=1`, off by default)

Without it, wazap keeps what it has seen, as before 0.21: disappearing-message
timers are not enforced locally. With it:

- For messages carrying disappearing-message metadata, wazap keeps the earliest
  observed deadline across edits, aliases, backfill and restarts. Reads refuse
  the message at that instant; one background timer per account tombstones it
  in the database the way a deletion does. Preview/transcription results,
  forwards, quoted replies and queued/retried webhooks recheck retention before
  publication. Already-started operations cannot be recalled.
- The policy is conservative: a marked ephemeral message without a computable
  deadline is refused, and **keep-in-chat hints are not an indefinite exemption**.
  Current chat settings are not retroactively applied to unmarked messages. Keep
  the system clock synchronized.
- A text-only row carried over from an older recall index keeps the deadline
  the legacy files knew for it; one they knew none for stays.

The database overwrites what it deletes (`secure_delete`), but this is not
secure erasure of heap pages, backups or filesystem snapshots. Explicit exports,
independent quotes/forwards and data already returned or sent are not recalled.
While wazap is stopped or suspended, disk cleanup waits until it runs again. Old
unrecorded deletions cannot be reconstructed. See [the audit report](docs/security-audit.md).

## Several accounts

One `wazap serve` holds every enabled account in the data dir. Each account is
its own Baileys socket and its own folder under `accounts/<id>/`. The first
account is `default`. Add another with `wazap account add work --name Work`,
then `wazap login --account work`.

`--account` picks one on `login`, `logout`, `status`, `config writes` and
`webhook test`. MCP tools take an optional `account_id`. Call `list_accounts`
first when more than one is linked. A chat only one account knows selects that
account. A send to a chat no account knows, with two or more accounts, fails
`AMBIGUOUS_ACCOUNT` instead of falling back to default.

Reads without a chat and without `account_id` use the default account; the
response still carries `account_id`. `link_account` needs an account that
already exists. Five accounts is advice, not a cap. One phone number is one
account.

A running server follows the registry; there is nothing to restart.
`wazap account add`, `enable`, `disable`, `default` and `remove` tell it at
once: an added or enabled account gets its socket, a disabled one is stopped
and tools that name it answer `ACCOUNT_DISABLED`, a removed one is stopped
before its folder is deleted. A tool that names an account the server has not
seen yet reads `accounts.json` again before answering `ACCOUNT_NOT_FOUND`, so
`account add` followed by `link_account` works even when nothing told the
server. The last account a server runs stays up until the server stops,
because a server with no enabled account refuses to start: `account disable`
says so, and `account remove` refuses it.

`wazap logout --account work` unlinks one account. With a server running it
asks that server to do it: the account's socket closes (a pairing in flight is
cancelled), WhatsApp is told to unlink the device, its credentials and chat
snapshot are deleted, and the account stays in the registry, not linked, ready
for `link_account` or `login`. The other accounts are not touched. Without
`--account`, logout is for the default account. With no server running, logout
does the same work itself.

The CLI reaches the running server over a private line, not the MCP endpoint:
a listener on an ephemeral `127.0.0.1` port and a random token, both written
to `<data-dir>/control.json` (`0600`) by the server as it starts. Nothing else
opens it — not `WAZAP_READ_TOKEN` or `WAZAP_WRITE_TOKEN`, not an OAuth grant,
not the bridge token in `daemon.json`, not an anonymous caller — and no tool
exposes it to an agent. A tunnel or proxy pointed at `WAZAP_PORT` never
reaches it. It is there whether or not the session is shared. A server started
by an older wazap has no such line: against it, account changes print a
restart hint, and `logout` and `account remove` work as they used to (stop the
`wazap service` around the logout, or refuse while another server runs).

An account can override the global webhook URL, secret and event list in
`accounts.json` (`webhook_url`, `webhook_secret`, `webhook_events`).
`wazap webhook test --account work` posts with that account's id and name.

## Several clients at once

Claude Desktop, Claude Code and Cursor each launch their own `wazap`. The first
one on a data directory owns every enabled account, each on its own socket, and
opens an MCP endpoint on `127.0.0.1`; every later one bridges to it over that
endpoint. There is nothing to configure, and no client can tell the difference.
The owner publishes `<data-dir>/daemon.json` (`0600`) with its pid, its port
and the token a bridge authenticates with.

A bridge serves whatever the owner exposes, so an owner started `--read-only`
makes every client read-only, whatever flags that client was launched with.

When the owner exits, the bridges exit with it, and the next `wazap` a client
starts becomes the new owner.

`WAZAP_NO_SHARE=1` opts out: a second `wazap` on the same directory exits with
code 2 naming the pid of the one already running. An explicit `--http` is a
server of its own rather than a bridge, and is refused the same way.

## Read-only mode

Writes are opt-in at `login` (the question defaults to no and stores the
answer in `<data-dir>/.env`). `wazap config writes on|off` changes it later.
`wazap config` and `wazap status` print the effective setting and where it
came from. If that line says off, write tools are not registered: run
`wazap config writes on` and restart the server.

An unset `WAZAP_READ_ONLY` and `WAZAP_READ_ONLY=0` both register write tools
(`wazap config` then says "writes: on"). `WAZAP_READ_ONLY=1` or
`wazap serve --read-only` does not register them at all. The agent never
sees them, so it cannot message anyone from your number even by mistake.

Writes are also rate limited to `WAZAP_RATE_LIMIT` per minute (default 20, `0`
disables). Sending faster than a human is how accounts get banned.

## Link previews and media processing

Text sent or edited by wazap can include a controlled preview of the first
explicit HTTP(S) URL. Fetching happens at send/confirm or edit, never while
creating an MCP draft. Pages and thumbnail URLs both go through the public-media
checks: public DNS answers only, a pinned socket lookup, a public connected peer,
and validation at every redirect. HTTPS downgrades are refused. Baileys's own
page/thumbnail fetcher stays disabled, including when our preview fails.

The page and image share a four-second network budget, with at most three
redirects each. Pages are capped at 256 KiB and images at 2 MiB. At most four
previews run concurrently; excess requests send without one. Only HTML metadata
is scanned (Open Graph, Twitter or title/description), with no JavaScript,
embeds, cookies, authentication headers or Referer. Sites can still observe the
server's preview request/IP. There is no cross-message URL cache.

Thumbnail decoding currently supports JPEG only, capped at 4 megapixels and
32 MiB decoder memory. An unsafe, oversized, unavailable or unsupported image
leaves a text card. An invalid/missing page preview leaves the original message
unchanged, without a card. URLs and provider errors are not logged. Forwarding
an existing message may retain its embedded preview without fetching it again.

Photo previews are decoded locally. Video frames, outgoing video thumbnails,
GIF conversion and local transcription use restricted ffmpeg inputs: local-file
protocol only, with a media-format allowlist that excludes playlists and image
sequences. GIF conversion also requires the GIF demuxer. An unavailable video
thumbnail does not fall back to Baileys's unrestricted ffmpeg command.

These checks are not a codec sandbox. Keep ffmpeg and image decoders updated;
exotic formats outside the allowlist may no longer work. Decoder errors omit
raw stderr, which can contain untrusted metadata or private content.

## Send rules

An account can also be limited in *who* it may message — the case where the
agent may send, but only to the people you run it for. The rules live on the
account record in `accounts.json` and are edited per account with
`wazap config send` (`--account` picks which; run without a verb to print them).
Entries are chat ids or numbers in international format, comma-separated:

- `wazap config send deny 40722123456,120363000000000001@g.us` refuses those
  recipients, whatever else is allowed.
- `wazap config send allow +15550100,40722123456` makes the list exhaustive —
  only those may be messaged. `allow none` locks the account to nobody.
- `wazap config send open` lifts every restriction.

The send tools check the rules when a message is drafted and again at
`confirm_send`, so a rule written while a draft waits still applies to it. A
refused send fails `SEND_BLOCKED` naming the rule that fired; the agent is
told to tell you, not to retry or route around it.

Saving policy or starting the account hub writes an empty `0600`
`accounts.json.required` marker. If that known policy disappears, wazap refuses
unrestricted defaults. Restore the policy from a trusted backup. To start over
on purpose with one default account and no send rules, delete the marker too;
never do it just to get past the error. Fresh/legacy directories without a marker keep
their bootstrap behavior. Explicit layout rollback removes the modern registry
and marker; old flat-layout versions do not enforce per-account rules.

Every write tool checks the current disk policy before preparing work. Corrupt,
missing, disabled or newly read-only accounts refuse the write without consuming
an owned draft. Cached rules are not a fallback. The running account roster
follows the registry (see [Several accounts](#several-accounts)); relaxing
startup read-only settings still needs a restart, and these checks cannot undo
an already-started operation. A registry that is missing or malformed is never
applied: the running roster stays as it was and the calls that need it fail. Malformed `WAZAP_READ_ONLY`
values are refused. Unset global settings still mean writes on; for a durable
account-level prohibition use `wazap config writes off --account <id>`.

## HTTP mode

```bash
WAZAP_READ_TOKEN=$(openssl rand -hex 32) \
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32) \
npx wazap-mcp serve --http --host 0.0.0.0 --port 8766
```

Streamable HTTP at `/mcp`, with a health check at `/healthz`. That check answers
`{ ok, status, since }`; the list of accounts and their status needs a read or write token.
It turns 503 once the socket has been anything but
connected for two minutes, so a tunnel or a monitor sees a real outage rather
than a reconnect in progress. Two bearer tokens:
the read token gets the read tools, the write token can unlock the write
tools. A leaked read token can never message anyone. A write token is not
the same as writes being enabled: if the server is read-only, even a write
token session has no write tools. `get_status` says so and how to turn
writes on. wazap refuses to bind a non-loopback address without a read
token. Agents that cannot carry a header sign in with
[OAuth](#hosted-agents-oauth) instead.

### Client isolation

HTTP MCP sessions are bound to the exact bearer credential that initialized
them (stored in memory as a SHA-256 fingerprint), including its read/write
permissions. Another credential cannot use that session's POST, GET or DELETE
endpoint, even if it knows the session id; it receives `404 Session not found`.
Each request still validates the token, so expiry or revocation returns 401.
After an OAuth access token rotates, initialize a new MCP session when the old
session returns 404.

Clients sharing a static token share an identity, and unauthenticated readers
share an anonymous identity. Use distinct credentials/OAuth grants for isolation;
do not enable anonymous access on a sensitive endpoint. This is not per-client
account isolation: authorized clients still share account data and account-level
policies.

Drafts are owned by the MCP session that created them, including stdio servers
and each bridge's upstream session. Another session cannot confirm a draft even
if it knows its id; it receives `DRAFT_NOT_FOUND`, without consuming the draft.
Resuming the same authenticated session preserves its drafts. A new initialize
(after eviction, reconnect with a new session, or OAuth token rotation) requires
a new draft and fresh user approval. Two sessions using the same token have
separate drafts, but sharing that token is still sharing an identity: anyone
holding both that token and the owner's session id can act as that session.
Draft/confirm is a workflow, not independent proof of human consent; the agent
can call both tools unless a trusted harness enforces approval.

### Request budgets

MCP POSTs authenticate before JSON parsing, accept at most 100 KiB and refuse
compressed bodies. Each credential has 240 POSTs/minute across its sessions
(`WAZAP_HTTP_BUDGET`);
429 responses include `Retry-After`. The session registry holds at most 128
sessions overall and 32 per credential, evicting that credential's oldest first.
Tool work is capped at eight concurrent operations per MCP session and 32
across the process, including stdio/bridges (`WAZAP_MAX_INFLIGHT`,
`WAZAP_MAX_INFLIGHT_TOTAL`). Slots remain held until work settles,
not merely until a client disconnects. Retry once after pending work completes.

The HTTP listener caps connections at 256, header receipt at ten seconds and
request-body receipt at thirty seconds; this does not time out legitimate SSE
streams or long-running tools. Anonymous loopback requests must have a loopback
Host name (on any port, so a mapped container port works) and, when supplied, a
matching Origin; browser rebinding/cross-origin
requests are refused. Always configure credentials for a proxy/tunnel. These
bounds are not a DDoS shield or per-tenant fairness guarantee.

### Host files and remote media

HTTP clients — static read/write tokens and OAuth grants — cannot use
`file_path` or override `download_media` with `save_to`. This applies even on
loopback: a reverse proxy or tunnel also reaches the server from localhost.
The tools return `MEDIA_ACCESS_DENIED` before looking up a path or touching a
file. A write token grants WhatsApp writes, not access to the host filesystem.

Remote clients can use public HTTP(S) media URLs, forward existing WhatsApp
messages, and download attachments into the account's default media directory.
Small downloaded images still return inline. Other attachments are saved on the
server; there is no arbitrary-file upload/download endpoint.

Local stdio clients retain local file access. A local bridge gets it only through
the private daemon credential stored in `daemon.json`, never through a public
read/write token or OAuth grant. Keep that credential private; it is a local
filesystem capability as well as a WhatsApp credential. No client-provided flag
or argument enables it.

URL media fetches check every DNS answer and redirect, pin the validated address
for the connection, check the peer address, and cap response size. Fetch errors
do not echo signed URLs. HTTP request logs omit queries, arbitrary URL paths,
request bodies and raw Accept headers; malformed-request errors are sanitized.
Client labels are bounded and stripped of log/terminal control characters. Do
not place secrets in client names or User-Agent labels, which remain diagnostic
metadata.

## Self-host

Run wazap on a server of your own when the agent is not on your laptop: another machine, a VPS, a client's infrastructure. The session stays on that server; nothing goes through a third party.

### With systemd

```bash
npm install -g wazap-mcp
sudo useradd --system --home /var/lib/wazap --create-home wazap
sudo -u wazap WAZAP_DATA_DIR=/var/lib/wazap wazap login --phone +15550100   # pairing code works over SSH
sudo -u wazap tee /var/lib/wazap/.env >/dev/null <<END
WAZAP_READ_TOKEN=$(openssl rand -hex 32)
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32)
END
sudo curl -fsSL https://raw.githubusercontent.com/razvangirgiz/wazap/main/deploy/wazap.service -o /etc/systemd/system/wazap.service
sudo systemctl enable --now wazap
curl -s http://127.0.0.1:8766/healthz
```

The unit binds loopback only. Put TLS in front with the two-line [`deploy/Caddyfile`](deploy/Caddyfile) (`caddy run --config deploy/Caddyfile` after editing the hostname) or any reverse proxy, then point the client at `https://your-host/mcp` with `Authorization: Bearer <read or write token>`.

### With Docker

```bash
git clone https://github.com/razvangirgiz/wazap && cd wazap
printf 'WAZAP_READ_TOKEN=%s\nWAZAP_WRITE_TOKEN=%s\n' $(openssl rand -hex 32) $(openssl rand -hex 32) > .env
docker compose run --rm wazap login --phone +15550100   # once; the session lands in the wazap-data volume
docker compose up -d
curl -s http://127.0.0.1:8766/healthz
```

The container publishes `8766` on loopback only; add the same TLS proxy in front. Upgrading is `git pull && docker compose up -d --build`; the volume keeps the session.

A proxy on the host reaches the container through the published port, so inside
the container its address is the compose network's gateway, not loopback. The
compose file pins that network to `172.30.87.0/24` and trusts its gateway,
`172.30.87.1`, for `X-Forwarded-For`; without that, every OAuth caller would
share one password lockout. If the subnet clashes with one of yours, change both
together, or set `WAZAP_TRUST_PROXY` in `.env`.

### From a machine without a public address

A laptop or a box behind NAT can still serve hosted agents through a tunnel, with no port opened and TLS done at the edge. `npx wazap-mcp expose` does the whole thing with Tailscale Funnel or Cloudflare Tunnel, whichever is installed. See [Keep it running](#keep-it-running).

wazap keeps binding loopback either way; only the tunnel reaches it.

<details>
<summary>By hand, with Cloudflare Tunnel and a domain on Cloudflare</summary>

```bash
cloudflared tunnel login
cloudflared tunnel create wazap
cloudflared tunnel route dns wazap wazap.example.com
cloudflared tunnel run --url http://127.0.0.1:8766 wazap
```

Set `WAZAP_PUBLIC_URL=https://wazap.example.com` for OAuth and keep `cloudflared` running the way you keep wazap running (a systemd unit, a launchd agent). Tailscale Funnel or ngrok work the same way: whatever ends at `https://your-host` with `/mcp` behind it.

</details>

### Which clients can reach it

Claude Code, Claude Desktop, Cursor, Codex, VS Code, Poke and any client with an "MCP URL + header" field connect with the bearer token. Keep the read token in clients that only need to read; hand out the write token deliberately.

claude.ai Connectors, ChatGPT and some hosted agents will not take a static header. They want OAuth, which is the next section.

### Reverse proxy trust

With OAuth enabled, `WAZAP_TRUST_PROXY` controls which peers may supply
`X-Forwarded-For` for password lockouts and request limits. The default is
`loopback`, not every private or Docker address. Set it to `none` for direct
connections without a proxy, or to a comma-separated list of exact proxy IPs
or CIDRs, for example `loopback,172.20.0.2/32`. Restart after changing it.
Do not trust a whole LAN just because the proxy runs there.

The trusted proxy must remove or sanitize incoming `X-Forwarded-For` and append
the actual client address. `CF-Connecting-IP` alone is ignored; configure a
Cloudflare/tunnel ingress to produce a trustworthy `X-Forwarded-For` chain.
Otherwise callers behind that ingress share the proxy's rate-limit identity.
Check the real header chain before exposing the service. Proxy trust does not
grant authentication, write permissions, or local-file access.

### Hosted agents (OAuth)

Two more lines in the same `.env` turn wazap into its own OAuth 2.1 server:

```bash
WAZAP_PUBLIC_URL=https://wazap.example.com
WAZAP_OAUTH_PASSWORD=$(openssl rand -base64 18)
```

Then give an agent nothing but `https://wazap.example.com/mcp`. It finds the
authorization server at `/.well-known/oauth-protected-resource/mcp`, registers
itself (RFC 7591, so there is no client id to paste anywhere), and sends you to
a page on your own host that asks two things: the password above, and whether
this agent may only read or also send. A refresh token keeps the agent signed
in until you revoke it; access tokens rotate every 24 hours on their own.

Tested against the flow claude.ai, ChatGPT and Poke use: S256 PKCE, public
clients, `/token` with refresh, `/revoke`. The bearer tokens keep working next
to it, so a laptop client on a header and a hosted agent on OAuth share one
server.

What to know before exposing it:

- `WAZAP_PUBLIC_URL` must be `https` and a bare origin, no path: the
  endpoints live at its root. The password travels to it.
- The password is the whole identity layer. Use a long one. A consent page
  takes three wrong guesses and is gone; five from one address lock that
  address out for fifteen minutes; twenty from anywhere pause consent for
  everyone for one minute.
- With OAuth on, `/mcp` never answers an unauthenticated request, whether or
  not a read token is set.
- Grants live in `<data-dir>/oauth.json` as hashes. Delete the file to sign
  every agent out at once, running server included; `wazap status` lists who
  holds one. Disconnecting an agent on its side revokes its refresh token and
  every access token in that grant family. Refresh tokens rotate on every use:
  clients must save the returned token. A consumed token still works for 60
  seconds from its rotation, so two refreshes at once or a lost response do not
  sign the agent out; replaying it later, within the last 32 consumed tokens,
  revokes the family, and older tokens are simply invalid. At most eight access
  tokens per grant remain active. A refresh token unused for ninety days is dropped. Damaged persisted grants require sign-in
  again rather than becoming unexpiring.
- A read grant never sees a write tool, whatever scope the agent requested.
  The radio button on the consent page is the only thing that decides. Refresh
  requests may narrow scopes; asking for more gets the grant's scopes, and a
  request with none of them is rejected.
- A supplied OAuth `resource` must be this server's exact MCP URL, including
  `/mcp`. A different path, origin, query or fragment is rejected at authorization,
  code exchange and refresh. Older clients may omit `resource`.
- Write tools may be visible because one linked account allows them. Each write
  still checks the resolved account's read-only policy before draft creation or
  media preparation, as well as the existing service-level send check. This is
  account policy enforcement, not per-client account ACLs; policy changes still
  require the documented server restart.

## Outbound webhook

Live events POST to one URL. Off by default. History sync is not posted.
Only `message_received` is posted unless you ask for more, because a consumer
that answers every POST without reading `event` would otherwise answer the
messages its own owner typed on the phone.

The `event` field names one of three. `message_received` is a message another
person sent. `message_sent` is a message this account sent itself, typed on
the phone or on another linked device; a message wazap sent through its own
tools is not announced, so a consumer can never be made to answer itself.
`connection` says the link came up, went down or expired.

Ask for the other two in `WAZAP_WEBHOOK_EVENTS`, comma-separated
(`message_received,connection`), or say `all` for the three of them. Case
does not matter and the spaces around a name are ignored. An unknown name
fails `wazap status`, doctor and setup. An account carries its own list as
`webhook_events` in `accounts.json`.

```bash
npx wazap-mcp config webhook on    # asks for URL + secret (secret is not echoed)
npx wazap-mcp webhook test         # POST a probe event
npx wazap-mcp webhook test --event connection   # needs connection enabled
npx wazap-mcp webhook test --account work
npx wazap-mcp config webhook off
```

On without a URL or secret fails `wazap status`, doctor and setup. A failed
delivery never stops WhatsApp or MCP.

Events wait in an outbox inside the account database, written in the same
transaction as the message they announce, so a restart or a crash loses none.
They are posted one at a time per account, oldest first, each POST bounded by
10 seconds. A timeout, an unreachable URL, or a `408`, `425`, `429` or `5xx` is
retried after 1 s, 5 s, 30 s, 2 min and 10 min, then hourly, until 24 hours
after the event; then it has failed. Any other `4xx`, such as the `401` of a
receiver whose API key changed, is a refusal: the event is posted once and
fails, and the error names the status with a hint. Either way the failure sets
`webhook.last_error`, which the next delivery clears. An event is posted at
least once: a POST a crash interrupted is sent again, so dedupe on
`message_id`. Turning the webhook off, or dropping an event from
`WAZAP_WEBHOOK_EVENTS`, cancels what waits; nothing is queued while it is off.

A message event is built when it is posted, from the message as it is then: an
edit or a transcript that arrived in the meantime goes with it, and a message
deleted, expired or cleared first is not posted at all.

Redirects are never followed. Response bodies are cancelled without being read,
including successful ones. Diagnostics retain the destination host, status and
failure category, not URL paths/queries, response bodies or transport exception
excerpts. URL query tokens remain supported, but userinfo credentials and
fragments are refused. Webhook and transcription destinations are trusted
operator configuration, not agent-supplied public-media URLs: configure only
receivers allowed to see this account's data.

`get_status` counts the outbox's events in `webhook.delivery`: `delivered`
(kept 7 days), `failed` and `cancelled` (kept 30 days; a retried event that
never got through counts once), `pending`, `dropped` (events the account
database could not store), `consecutive_failures`, `retrying` (failed POSTs of
the oldest waiting event), `last_success_at`, `last_failure_at`,
`last_failure`, `last_status`, `last_dropped_at` and `oldest_pending_at`.
`wazap status` and doctor read the same outbox read-only, whether or not the
server runs: three failed events in a row, or three failed POSTs of the oldest
waiting one, fail the webhook check with the fix; one failure since the last
delivery, or an event being retried, warns; the check passes again with the
next delivery. `webhook test` posts its probe directly, not through the
outbox, and does not change the counters. The log says the first failure of a
run, a count every 100 failures, and one line when delivery comes back, not a
line per event.

An account may set `webhook_url`,
`webhook_secret` and `webhook_events` in `accounts.json`; those win over the
global URL, secret and event list, and `config webhook off --account work`
clears all three.

`webhook test --event <name>` posts nothing and exits non-zero when that
event is not enabled, and says what to enable it with. While the webhook is
on, `wazap config` prints the events it posts on an `events:` line.

HMAC: `X-Wazap-Signature` is `sha256=<hex>`, HMAC-SHA256 of the exact raw
JSON body with the secret that signed it. Verify that raw body, not a
re-serialized object. HTTPS only, except `http://` on loopback.

`contact_id` is the sender's contact in the account database: the same number
for the same person however WhatsApp spells their id, including after the
number behind a `@lid` becomes known. `phone` is the sender's number in E.164
(`+15550100`), or `null` while WhatsApp has not revealed it; `from` keeps its
old form. For `message_sent` both name the account itself.

`text` is a preview, cut at 2000 characters and ending in a single `…`.
`truncated` is true when it was cut. For `kind: "audio"`, `text` is the
transcription when wazap auto-transcribed the note itself, which it does for
incoming notes only; the event waits up to 60 seconds for those words. In
every other case `text` is the `[voice message · 0:42]` placeholder: a note
you recorded yourself, a note longer than 600 seconds, a note WhatsApp stated
no duration for, and a transcription that failed every attempt or did not
finish within the 60 seconds. `ts` is the original local
time with a numeric offset, kept for consumers already reading it, and
`timestamp` is the same instant in UTC.

Events arrive in the order the account queued them: nothing is posted while an
older event waits for its transcript or its next retry. That is the order
WhatsApp delivered the messages in, which a late or retried delivery on its
side can make differ from the order they were written, so order by `timestamp`
when it matters.

A message another person sent:

```json
{
  "event": "message_received",
  "from": "15550100",
  "contact_id": 42,
  "phone": "+15550100",
  "chat_id": "15550100@s.whatsapp.net",
  "ts": "2026-09-08T17:00:00+03:00",
  "timestamp": "2026-09-08T14:00:00.000Z",
  "text": "hello, or a preview of something longer",
  "truncated": false,
  "kind": "text",
  "from_me": false,
  "is_self_chat": false,
  "message_id": "false_15550100@s.whatsapp.net_3EB0…",
  "account_id": "default",
  "account_name": "default"
}
```

A message sent from the phone, here in the "Message yourself" chat:

```json
{
  "event": "message_sent",
  "from": "15551234",
  "contact_id": 1,
  "phone": "+15551234",
  "chat_id": "15551234@s.whatsapp.net",
  "ts": "2026-09-08T17:04:12+03:00",
  "timestamp": "2026-09-08T14:04:12.000Z",
  "text": "call the notary at 14:00 on Wednesday",
  "truncated": false,
  "kind": "text",
  "from_me": true,
  "is_self_chat": true,
  "message_id": "true_15551234@s.whatsapp.net_3EB0…",
  "account_id": "default",
  "account_name": "default"
}
```

A connection change. `status` is `linked`, `disconnected` or `expired`;
`not_linked`, `linking` and `connecting` post nothing, and two changes that
mean the same status post once.

```json
{
  "event": "connection",
  "status": "expired",
  "timestamp": "2026-09-08T14:10:00.000Z",
  "account_id": "default",
  "account_name": "default"
}
```

`connection` reports what the socket does while wazap is running. A clean
shutdown posts nothing, and a crash posts nothing either, so silence does not
mean the link is up. Poll `get_status` when you need to know that. A
`connection` event the receiver did not take is retried like any other, and
the next change waits behind it.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `WAZAP_DATA_DIR` | `~/.wazap` | Where everything is stored. |
| `WAZAP_READ_ONLY` | unset (`0`) | `1` does not register the write tools. Unset and `0` both do. |
| `WAZAP_SYNC_FULL_HISTORY` | `0` | Ask WhatsApp for a fuller history sync. |
| `WAZAP_PERSIST_HISTORY` | `1` | Keep messages across restarts. `0` removes them at each start and stop; barriers, chats, contacts and notes stay. |
| `WAZAP_RATE_LIMIT` | `20` | Write tool calls per minute; `0` disables. |
| `WAZAP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `WAZAP_HOST` / `WAZAP_PORT` | `127.0.0.1` / `8766` | HTTP bind address. |
| `WAZAP_READ_TOKEN` / `WAZAP_WRITE_TOKEN` | unset | HTTP bearer tokens. |
| `WAZAP_PUBLIC_URL` | unset | The `https` address agents reach the server at. With the password, turns OAuth on. |
| `WAZAP_OAUTH_PASSWORD` | unset | What the consent page asks for. At least 8 characters. |
| `WAZAP_TRUST_PROXY` | `loopback` | OAuth proxy IPs/CIDRs trusted for X-Forwarded-For, comma-separated; `none` disables proxy trust. |
| `WAZAP_NO_UPDATE_CHECK` | `0` | `1` stops `status` asking npm for a newer version. |
| `WAZAP_TRANSCRIBE` | `off` | `local`, `openai` or `off`. |
| `WAZAP_TRANSCRIBE_AUTO` | `1` | Transcribe incoming voice notes in the background. |
| `WAZAP_TRANSCRIBE_LANGUAGE` | `auto` | Spoken language, e.g. `ro`. |
| `WAZAP_WHISPER_MODEL` | `turbo` | `turbo`, `large-v3` or `medium`. |
| `WAZAP_WHISPER_BIN` | unset | Path to a whisper.cpp binary that is not on `PATH`. |
| `WAZAP_TRANSCRIBE_API_KEY` | unset | API key; `OPENAI_API_KEY` is the fallback. Never a flag. |
| `WAZAP_TRANSCRIBE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL. |
| `WAZAP_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Model at that URL. |
| `WAZAP_WEBHOOK` | `off` | `on` posts the enabled events to the webhook URL. |
| `WAZAP_WEBHOOK_URL` | unset | HTTPS endpoint. `http://` only on loopback. An account `webhook_url` wins. |
| `WAZAP_WEBHOOK_SECRET` | unset | Shared secret for `X-Wazap-Signature`. Never a flag. An account `webhook_secret` wins. |
| `WAZAP_WEBHOOK_EVENTS` | unset (`message_received`) | Which events to post, comma-separated, or `all`. An account `webhook_events` wins. |

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
- **Names come from the phone's address book.** WhatsApp delivers it as an app
  state sync, and only to a connection asking for it from scratch. If contacts
  read as phone numbers and `get_status` shows `contacts_named: 0`, ask for it
  again with the `sync_contacts` tool or `wazap contacts resync`.
- **Calls are WhatsApp calls only.** A call shows up as a message with
  `type: "call"`, carrying its kind, direction, outcome and duration. WhatsApp's
  own call log and the missed-call notices arrive on their own; a call that
  starts and ends while wazap is running is recorded live, so calls placed or
  received while it is stopped can be missing entirely. A cellular call from the
  phone's dialler is never visible, on any device.
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
