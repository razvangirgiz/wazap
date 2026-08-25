```
██╗    ██╗ █████╗ ███████╗ █████╗ ██████╗
██║    ██║██╔══██╗╚══███╔╝██╔══██╗██╔══██╗
██║ █╗ ██║███████║  ███╔╝ ███████║██████╔╝
██║███╗██║██╔══██║ ███╔╝  ██╔══██║██╔═══╝
╚███╔███╔╝██║  ██║███████╗██║  ██║██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝
```

**WhatsApp for your AI agent.** An MCP server that puts your WhatsApp account —
chats, messages, media, contacts, groups — behind 25 tools any MCP client can
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
| Anything else | the MCP entry `npx -y wazap-mcp` over stdio, or a [self-hosted](#self-host) URL |

Each of those registers the server. Linking the WhatsApp account is a separate,
one-time step in every one of them: `npx wazap-mcp login`.

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
| anything remote | client's MCP URL field: `https://your-host/mcp` with header `Authorization: Bearer <token>`, or just the URL once [OAuth](#hosted-agents-oauth) is on (see [Self-host](#self-host)) |

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
stops the service, pairs, and starts it again on its own.

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
| `get_status` | read | Connection status, sync state, linked account, named-contact count, versions, data dir. |
| `link_account` | read | Pair the account without a terminal: returns the code to type into the phone. Registered in read-only mode too. |
| `list_chats` | read | Conversations newest-first; filter `all`/`unread`/`groups`/`individual`/`archived`. |
| `read_messages` | read | Messages in a chat; `before` pages further back, pulling older history from the phone; `types` narrows to one or more message types, e.g. `["call"]`. |
| `get_recent_messages` | read | Everything from the last N hours, grouped by chat. The catch-up tool. `include_system` adds WhatsApp's own notices, `types` narrows to one or more message types. |
| `search_messages` | read | Text search across the locally held messages. |
| `get_message` | read | One message in full, with its quoted message and reactions. |
| `search_contacts` | read | Find contacts by name or number. |
| `sync_contacts` | read | Fetch the phone's address book from WhatsApp again, when names are missing. |
| `get_contact` | read | Name, number, about text, profile picture. |
| `get_group_info` | read | Participants, admins, announcement mode, invite link (when you are admin). |
| `download_media` | read | Save an attachment to disk; small images also come back inline. |
| `transcribe_audio` | read | Turn a voice note or audio message into text, with the local or the API provider. |
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
carry a placeholder such as `[image] caption`, `[voice message · 0:42]`, `[deleted]` or
`[poll] Pizza or pasta?`. Timestamps are ISO 8601 with the machine's UTC offset,
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
the source; an interrupted download resumes where it stopped.

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
- A provider's own error message has the key stripped out of it before wazap
  prints it.
- A plain-`http` `WAZAP_TRANSCRIBE_URL` is refused unless it points back at this
  machine.

### Without being asked

With a provider configured, incoming voice notes of up to ten minutes are
transcribed in the background as they arrive, one at a time, never holding up a
message. The transcript is cached by message id and persisted, so a voice note is
transcribed once and not again after a restart. Audio *files* are left alone,
since one can be an hour long; call `transcribe_audio(message_id)` for those.
`WAZAP_TRANSCRIBE_AUTO=0` keeps the tool and stops the background work.

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
  models/       whisper.cpp models, when transcription runs locally
  store.json    chat-list snapshot
  server.lock   pid of the running server
  daemon.json   loopback endpoint a second wazap bridges to
  oauth.json    registered agents and hashed OAuth grants, when OAuth is on
  .env          optional settings, see .env.example
```

Credential writes go to a temp file and are renamed into place, so killing the
process mid-write cannot leave you re-linking your phone.

## Several clients at once

Claude Desktop, Claude Code and Cursor each launch their own `wazap`. WhatsApp
allows one socket per linked device, so they share one session instead of
fighting over it. The first `wazap` on a data directory owns the session and
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

Writes are opt-in. `login` asks once and stores the answer in
`<data-dir>/.env`; `wazap config writes on|off` changes it, and `wazap config`
alone prints every effective setting with where it came from.

`WAZAP_READ_ONLY=1` or `wazap serve --read-only` does not register the write
tools at all. The agent never sees them, so it cannot message anyone from your
number even by mistake — useful when the linked account is your personal one.

Writes are also rate limited to `WAZAP_RATE_LIMIT` per minute (default 20, `0`
disables). Sending faster than a human is how accounts get banned.

## HTTP mode

```bash
WAZAP_READ_TOKEN=$(openssl rand -hex 32) \
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32) \
npx wazap-mcp serve --http --host 0.0.0.0 --port 8766
```

Streamable HTTP at `/mcp`, with a health check at `/healthz`. That check answers
`{ ok, status, since }`. It turns 503 once the socket has been anything but
connected for two minutes, so a tunnel or a monitor sees a real outage rather
than a reconnect in progress. Two bearer tokens:
the read token gets the read tools, the write token also unlocks the write
tools, so a leaked read token can never message anyone. wazap refuses to bind a
non-loopback address without a read token. Agents that cannot carry a header
sign in with [OAuth](#hosted-agents-oauth) instead.

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
  address out for fifteen minutes; twenty from anywhere close the page for
  everyone for fifteen minutes.
- With OAuth on, `/mcp` never answers an unauthenticated request, whether or
  not a read token is set.
- Grants live in `<data-dir>/oauth.json` as hashes. Delete the file to sign
  every agent out at once, running server included; `wazap status` lists who
  holds one. Disconnecting an agent on its side revokes its refresh token and
  every access token it minted. A refresh token unused for ninety days is
  dropped.
- A read grant never sees a write tool, whatever scope the agent requested.
  The radio button on the consent page is the only thing that decides.

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
| `WAZAP_PUBLIC_URL` | unset | The `https` address agents reach the server at. With the password, turns OAuth on. |
| `WAZAP_OAUTH_PASSWORD` | unset | What the consent page asks for. At least 8 characters. |
| `WAZAP_NO_UPDATE_CHECK` | `0` | `1` stops `status` asking npm for a newer version. |
| `WAZAP_TRANSCRIBE` | `off` | `local`, `openai` or `off`. |
| `WAZAP_TRANSCRIBE_AUTO` | `1` | Transcribe incoming voice notes in the background. |
| `WAZAP_TRANSCRIBE_LANGUAGE` | `auto` | Spoken language, e.g. `ro`. |
| `WAZAP_WHISPER_MODEL` | `turbo` | `turbo`, `large-v3` or `medium`. |
| `WAZAP_WHISPER_BIN` | unset | Path to a whisper.cpp binary that is not on `PATH`. |
| `WAZAP_TRANSCRIBE_API_KEY` | unset | API key; `OPENAI_API_KEY` is the fallback. Never a flag. |
| `WAZAP_TRANSCRIBE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL. |
| `WAZAP_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Model at that URL. |

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
