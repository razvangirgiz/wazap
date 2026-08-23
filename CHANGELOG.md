# Changelog

## Unreleased
### Added

- **`wazap update` is the whole upgrade.** It reads the registry, then does what
  this install needs: `npm i -g wazap-mcp@<latest>` when wazap is global, a
  restart of the background service so it runs the new code, and a fresh copy of
  the skills for every harness that keeps them, taken from the package it just
  installed rather than from the running one. A checkout is told to pull and
  build; an npx run is told to rerun `setup` through the new version.
  `--dry-run` prints the numbered plan and stops there. `status` now sends you
  here instead of to `npx wazap-mcp@latest`.
- **`wazap setup` installs wazap globally when npx is how it started.** The npx
  cache is a copy npm clears, so Claude Desktop could not launch what setup had
  just connected, and `service install` refused outright. Setup now asks once,
  before it connects anything, and `npm i -g wazap-mcp@<this version>` gives the
  rest of the run a path that lasts. `--yes` accepts, `--no-global` declines and
  setup carries on. `status` reports where this wazap lives, as
  `install: global|checkout|npx` with the script behind it.
- **`wazap service` keeps the session up without a client.**
  `wazap service install|status|start|stop|restart|logs|uninstall` writes a
  launchd agent or a systemd user unit, starts it and waits for `/healthz`.
  The unit runs
  `serve --http` on loopback with the absolute path of this Node and this
  install, so it survives a reboot and a logout, and `status` says when it still
  runs an older build than the one installed. `wazap login` needs the session to
  itself, so it now stops the service, pairs, and starts it again. `wazap status`
  gained a service check. A wazap running out of the npx cache refuses to install
  one, because npm clears that path.
- **`wazap expose` gives the service a public URL** for agents that are not on
  this machine. It uses Tailscale Funnel or Cloudflare Tunnel, whichever is
  installed, writes `WAZAP_PUBLIC_URL` and a fresh `WAZAP_OAUTH_PASSWORD`,
  restarts the service and checks the URL from here, then prints the MCP URL and
  the consent password once. `wazap expose off` takes the tunnel down and keeps
  the password.
- **`wazap setup` asks whether to keep wazap running**, as a fifth step: only
  while a client has it open, always on this machine, or always and reachable by
  cloud agents. `--service` and `--expose` answer it for `setup --yes`.
- **The workflows reach every client, with no second command.** `wazap setup`
  now copies the five skills into each client it connects, and the server
  carries them as well: it sends a short `instructions` block naming all five
  and registers each one as an MCP prompt of the same name. Claude Desktop, VS
  Code, Gemini and Windsurf keep no skills directory, so this is how they get
  the workflows. A bridged client sees the same prompts as the session holder,
  and the Claude Desktop bundle now ships `skills/` so it can serve them.
- **`wazap skills install` with no harness** installs into every client it finds
  on this machine.
- **`wazap setup` proves the install works before it says so.** The Finish step
  now connects the session once and reports the chat count, and checks that each
  client it connected can actually launch wazap. Claude Desktop starts its MCP
  servers with launchd's PATH, where neither `wazap` nor `npx` is found, so
  `connect claude-desktop` now writes the absolute `node` path and the script
  behind the global bin. A failing check exits 1 instead of printing "Setup
  complete".
- **`wazap status` reports the skills**, per detected harness, as installed,
  stale or missing. A global upgrade leaves the copies in `~/.cursor/skills` and
  the others behind, and until now nothing said so. Bare `wazap` and
  `status --json` carry the check too.

### Changed

- **`serve` exits 3 when WhatsApp keeps refusing the socket.** Ten failed
  reconnects used to leave a live MCP server answering NOT_CONNECTED forever.
  Now it logs and exits, so a supervisor restarts it and a client shows the
  error. An account unlinked from the phone is the exception and stays up in
  `auth_failure`: no restart brings that back.
- **`/healthz` answers 503 on a real outage**, with `{ ok, status, since }`. A
  socket that has been anything but connected for two minutes is down; a
  reconnect in progress is not.
- `wazap skills install claude-code` copies into `~/.claude/skills/` instead of
  printing the plugin command. The plugin is still the other route, and the
  README says so.

## 0.10.0
### Added

- **OAuth for hosted agents.** claude.ai Connectors, ChatGPT and Poke's OAuth
  mode would not take a static bearer token, so a self-hosted wazap was out of
  their reach. `WAZAP_PUBLIC_URL` plus `WAZAP_OAUTH_PASSWORD` now make wazap
  its own OAuth 2.1 server: discovery at `/.well-known`, dynamic client
  registration, S256 PKCE, `/token` with refresh, `/revoke`. An agent gets the
  `/mcp` URL and nothing else; the person lands on a consent page on their own
  host, types the password, and picks read or read-and-send for that agent.
  Grants live hashed in `<data-dir>/oauth.json`; deleting it signs everyone
  out. The bearer tokens still work next to it.
- **`wazap status` lists OAuth grants**, by agent name and scope.

### Changed

- A 401 from `/mcp` now carries `WWW-Authenticate` with the resource metadata
  URL when OAuth is on, which is how a client learns to start the flow.
- HTTP request logs show the full path again for routes mounted under a router.

## 0.9.8
### Added

- **Voice messages become text.** A voice note is the one message an agent could
  not read. With transcription on it reads as
  `[voice message · 0:42] "sunt la notar, ajung în 20 de minute"`, carries the
  bare words in a `transcript` field, and is findable by them:
  `search_messages` matches the rendered text, so a recording is searchable by
  what was said in it. A note nobody has transcribed still says how long it runs.
- **Two providers, both opt-in.** `wazap config transcribe local` runs
  whisper.cpp on this machine, free, and the audio never leaves. `wazap config
  transcribe openai` posts to any OpenAI-compatible `/audio/transcriptions`,
  which is fast and costs money and sends the audio away; Groq works unchanged.
  `wazap setup` asks the question between Link and Connect, defaulting to
  neither.
- **`transcribe_audio(message_id, language?)`.** One recording on demand, capped
  at ten calls a minute so a loop cannot run up a bill. The transcript is cached
  by message id and persisted in the snapshot and the chat's own JSONL, so a
  recording reaches a provider once and survives a restart, and two callers
  wanting the same one join a single upload instead of paying twice.
- **Transcribed as they arrive.** With a provider configured, incoming voice
  notes are transcribed in the background, one at a time, never holding up
  ingestion. "As they arrive" is meant strictly: a history sync replays a
  backlog and transcribing all of it is a bill nobody asked for, so the hook
  hangs off live delivery only. Notes the user recorded, audio files, anything
  past ten minutes and anything WhatsApp stated no length for are left for the
  tool to do deliberately. `WAZAP_TRANSCRIBE_AUTO=0` keeps the tool and stops
  the background work.
- **`wazap transcribe download` and `wazap transcribe test <file>`.** The model
  is fetched into `<data-dir>/models/` behind one progress line, resumes from
  its `.part` if you interrupt it, and is renamed into place only once its
  SHA-256 matches the digest pinned in the source. `transcribe test` runs the
  configured provider on a recording of your own, which is how you check a
  language before trusting it with your WhatsApp. `status` reports the provider,
  the binaries, the model and its size.
- **`turbo` is the default model** (`ggml-large-v3-turbo-q5_0.bin`, 574 MB),
  because it is the smallest one that still gets Romanian right. `medium` and
  below drop diacritics and mangle names, which is worse than no transcript at
  all: a missing transcript is a question, a wrong name is a wrong answer.
  `WAZAP_WHISPER_MODEL` picks `large-v3` or `medium` instead.
- **`whatsapp-inbox` and `whatsapp-recall` read voice notes.** A transcribed
  note is triaged and quoted as the text it is. Notes nobody transcribed are
  counted in one closing line, once, rather than an offer repeated per item.

### Security

- **The API key is never a command-line argument**, and typing it as one is
  refused with the reason: an argument is kept in your shell history and
  readable in `ps` by anyone on the machine. It is asked for at a prompt that
  echoes nothing, not even asterisks, and stored only in `<data-dir>/.env` at
  mode 0600. `status`, `status --json`, `config`, `get_status` and any error a
  provider hands back show at most `api key: set (…abcd)`.
- **Read-only keeps its meaning.** It has always promised no side effect anyone
  outside this machine can see, so it refuses the API provider, which uploads
  the user's audio and spends their money, and leaves whisper.cpp alone, which
  does neither.
- **A plain-`http` `WAZAP_TRANSCRIBE_URL` is refused** unless it points back at
  this machine.

## 0.9.7
### Added

- **A call is a message.** A WhatsApp call now has `type: "call"` and a `call`
  field carrying kind, direction, outcome and, when someone picked up, the
  duration. It reads as `[voice call · 6 min]` or `[missed voice call]` where it
  used to read "[system message]" or "[unsupported]". Three shapes say the same
  thing and collapse into one: WhatsApp's own call log, the four CALL_MISSED_*
  notices, and the placeholder baileys writes for a group call offer.
  `getContentType` is blind to the proto field — WhatsApp spells it
  `callLogMesssage`, with three s's — so the check runs ahead of the table that
  types every other message.
- **Calls that happen while wazap runs.** Baileys reports a call as a stream of
  status events and never as a message, so wazap folds that stream into one
  entry per call and stores it the way any message is stored: snapshot, history
  file, digest, `list_chats.last_message`. A call whose closing event never
  arrives is settled two minutes after the last one; an answered call is not,
  because that would record a conversation still going on as two minutes long.
  The same call reaching the store from two directions is reconciled to
  whichever account of it says more.
- **`types` on `read_messages` and `get_recent_messages`.** Narrow a read to a
  subset of message types; `types: ["call"]` is the call log of a chat and
  nothing else. `limit` counts messages that matched, and paging with `before`
  is unaffected by the filter.
- **Triage reads calls as answers.** A question the user answered by calling
  back is no longer reported as unanswered: `whatsapp-inbox` moves it to
  *Probably handled by call* with the time and duration, and asks at the end
  about calls placed outside WhatsApp, which nothing on a linked device can see.
  `whatsapp-groups` treats an answered group call the same way.

## 0.9.6
### Added

- **MCP Registry.** `server.json` and `mcpName` in package.json, the two proofs
  the registry wants: the GitHub login for the `io.github.razvangirgiz/*`
  namespace, `mcpName` on the published npm version for the package.
  `scripts/release-registry.sh` publishes it, and refuses early when the
  versions disagree or npm's copy of this version has no `mcpName` — which
  cannot be added afterwards. `npm run registry:validate` checks the file
  against the schema it names.
- **A Claude Desktop bundle.** `npm run bundle:mcpb` produces
  `wazap-<version>.mcpb`: the server, a 512×512 icon and production
  `node_modules`, installed by double-clicking, with no npx and no config file
  to edit. Two settings in Claude Desktop's own UI, Read-only and Data
  directory. Read-only ships ticked, because a bundle that can message people
  from your number before you have said so is the wrong default.
- **A Gemini CLI extension.** `gemini extensions install
  https://github.com/razvangirgiz/wazap` registers the server and loads
  `GEMINI.md`, which is the five skills concatenated. It is generated by
  `npm run context:build`, and a test fails when it drifts from `skills/`, so a
  workflow is still only ever edited in its skill.
- **One-click install for Cursor and VS Code.** Two badges under *Other MCP
  clients*, both carrying the entry `connect` would write.
  `node scripts/badges.mjs` reprints them.
- **`wazap skills install <harness>`.** Copies the five skills into the
  directory that harness reads: `~/.agents/skills` for Codex, `~/.cursor/skills`
  for Cursor, `~/.config/opencode/skills` for OpenCode, `./.agents/skills` for
  the project. Re-running overwrites, so an upgrade is the same command.
  `--dry-run` lists without writing. Claude Code is pointed at the plugin.
- **`wazap connect windsurf` and `wazap connect opencode`.** Windsurf takes
  `~/.codeium/windsurf/mcp_config.json`; OpenCode wants the command and its
  arguments as one array under `mcp.whatsapp`, and its schema refuses anything
  else, so `connect` now writes the whole object each client asks for rather
  than merging fields into a fixed one.

### Fixed

- An unanswered setting in the Claude Desktop bundle arrives as the literal
  `${user_config.data_dir}` rather than as nothing. Any `WAZAP_` variable that
  is still a template is dropped, so an empty picker means `~/.wazap` instead of
  a directory named after the question.

## 0.9.5
### Fixed

- Contact names never arrived. WhatsApp hands a companion the phone's address
  book inside the app state sync, and it sends each collection's snapshot only
  to a connection asking from version zero. The socket that pairs has no store,
  so whatever it synced was thrown away — and by saving the versions it left
  every later connection resyncing from a point with nothing more to send.
  Contacts stayed bare phone numbers for the life of the session. That socket
  now runs on an auth state whose app-state-sync journal reads empty and refuses
  writes, and declines the history sync outright, so it can neither consume the
  delivery nor bump the counter that makes later connections skip their own sync.
- Sessions already linked heal themselves. A connection that settles with no
  address-book name in hand, while stored versions prove one was delivered
  somewhere, forgets those versions and resyncs all five collections. Once per
  process, and at most once a week per account, so a phone with genuinely no
  saved contacts is not asked again on every start. On the account this was
  found on: 0 named contacts before, 217 within three seconds.
- A name made only of digits and masking is no longer treated as a name.
  WhatsApp fills a contact it will not identify with the masked number
  `+40∙∙∙∙∙∙∙98`; `search_contacts`, `is_my_contact` and every sender line were
  taking that at face value and showing dots where the plain number belongs.

### Added

- `sync_contacts` — a read tool that asks WhatsApp for the address book and
  waits up to 15 seconds, returning `named_before` and `named_after`.
- `wazap contacts resync` — the same from a terminal. It refuses while a server
  owns the session and points at the tool instead.
- `get_status` reports `contacts_named`: contacts carrying a name from the phone,
  which is `0` exactly when the address book has not arrived.

### Changed

- "Synced N chats, N contacts, N messages" counts contacts from the address book
  rather than everyone the store has ever seen, which included every stranger in
  a group and every group itself. Login waits for those names before it calls the
  sync finished.

## 0.9.4
### Fixed

- Senders in a group rendered as a bare LID — fifteen digits that read as a
  phone number and are not one. One `displayName` ladder now names every sender,
  chat, contact and group participant: the saved contact, the business name, the
  name the sender publishes on their own profile, the chat title, the phone
  number, and only then `unknown (lid …7515)`. A LID is resolved to its number
  first, from the contact list, from group metadata, and from the table Baileys
  already holds and wazap never asked. Naming someone never renames their chat,
  so a chat id and the message ids under it stay what they were.
- The name a sender publishes arrives on their messages and nowhere else, and
  was being thrown away. It is kept per sender and persisted, so someone who is
  not in the address book still has a name after a restart, and
  `search_contacts` finds them by it.
- `0@s.whatsapp.net`, the pseudo-chat WhatsApp files its own notices under, sat
  at the top of `list_chats` and in the digest. It and the status feed are now
  refused at ingest, on load of a store an older version wrote, and where chats
  are listed.
- Linking a device left history-sync and peer-data payloads in the user's
  self-chat, shown as four `[system message]` rows and counted as conversation
  in the 24h digest. Payloads devices exchange with each other are dropped;
  everything a person did — a retraction, a disappearing-messages toggle, a
  group membership change — stays.
- An edited message no longer also appears as a `[system message]` row of its
  own. The edit is applied to the message it edits, as before.

### Changed

- `get_recent_messages` leaves WhatsApp's own notices out of its bodies and its
  counts, and takes `include_system: true` to put them back.
- An unsupported payload names itself, `[unsupported: <key>]` rather than
  `[unsupported message]`, so a bug report says which one to add. A payload
  wazap does not model yet is reported this way instead of being flattened into
  `[system message]`, which used to hide events, albums and orders.


## 0.9.3
### Added

- One session, many clients. The first `wazap serve` on a data directory owns
  the WhatsApp session and shares it over a loopback MCP endpoint; every later
  `wazap` on the same directory becomes a bridge onto it instead of exiting 2.
  Claude Desktop, Claude Code and Cursor can run at the same time, with nothing
  to configure. `WAZAP_NO_SHARE=1` keeps the old one-at-a-time behaviour, and so
  does an explicit `--http`.
- `<data-dir>/daemon.json` (`0600`), the record a bridge reads to find the owner:
  its pid, its loopback port, a per-run token and the version. It goes when the
  lock goes.

### Changed

- `wazap status` names the endpoint a shared session is reachable on, as
  `server: running (pid N, sharing on 127.0.0.1:PORT)`, and `--json` carries the
  same as a `daemon` object with the pid and the port. The token stays out of
  both, and out of every log line.


## 0.9.2
### Added

- `wazap setup`: the one command from nothing to a working agent. It links the
  account, detects which MCP clients are installed on this machine over the same
  client table `connect` writes from, writes their entries and prints what to
  restart. `--client <name>` overrides the detection; `-y` takes the detected
  set without asking.
- `wazap setup --agent` prints the procedure an AI agent follows to set wazap up
  for its user. That text is `AGENT.md`, and the command reads the file, so the
  document and the command cannot drift.
- `login` prints a `pairing code: XXXX-XXXX` line whenever its output is not a
  terminal, so an agent running `login` in the background can read the code and
  hand it to the user.

### Changed

- `login` and `setup` hold the session lock while they link. A server started
  meanwhile is refused instead of racing them for the credentials, and a killed
  `login` leaves no stale lock behind.
- `logout` says WhatsApp had already unlinked this device, instead of surfacing
  the pairing-code error that WhatsApp's 401 means at login time.


## 0.9.1
### Changed

- `login` shows a QR code by default; `--phone` or `--code` switches to the 8-character pairing code.
- `login` now stays up after linking until WhatsApp has delivered the chat history, so a fresh account no longer comes up with zero chats.
- `list_chats` lists any chat that has messages, even before WhatsApp describes it.
- The CLI draws for a human at a terminal: a brand-coloured banner, numbered
  steps through `login` with the pairing code in a box and a spinner counting it
  down, an aligned `status` block, and one `Next` line telling you the single
  command to run. Failures render as `✗ what happened` with `→ the repair`
  under them. Colour is on only when stderr is a terminal and `NO_COLOR` is
  unset; `FORCE_COLOR` decides either way, and piped output keeps the same
  words it had before.
- The linked account's number is masked wherever it is printed, so a `status`
  screenshot no longer carries it.


## 0.9.0

First release under the name `wazap`. The project was a developer's MCP server
for one machine; this turns it into something a stranger can install with
`npx wazap-mcp login`.

### Added

- `wazap` CLI with `login`, `status`, `logout` and `serve`. `login` uses a
  pairing code by default (`--qr` falls back to a QR code), so linking never
  needs a screenshot of a terminal.
- A single data directory, `~/.wazap` by default (`--data-dir` or
  `WAZAP_DATA_DIR`), holding credentials, media, history and the server lock.
  Nothing is written next to the installed package any more.
- Atomic credential writes: every auth file is written to a temp file and
  renamed into place, so a kill during a write can no longer corrupt the session
  and force a re-link.
- A lock file per data directory. A second server on the same directory exits
  with code 2 naming the pid of the one already running.
- A structured error model. Every tool returns `{ error, message, fix }` with
  one of 27 codes instead of a raw exception, and `learn` documents what an
  agent should do about each.
- A sync gate: read tools wait up to 10 seconds for the initial history sync and
  report `sync: "in_progress"` when they answer early.
- A write rate limiter, 20 calls per minute by default (`WAZAP_RATE_LIMIT`,
  `0` disables).
- New tools: `get_message`, `send_poll`, `send_location`, `edit_message`.
- `wazap connect <client>` for `claude-code`, `claude-desktop`, `cursor`,
  `codex`, `vscode` and `gemini`. It writes the MCP entry itself, keeps the rest
  of the file, backs it up once before the first change, refuses a config file
  it cannot parse rather than clobbering it, and is a no-op on a second run.
  `--dry-run` prints what it would write.
- Writes are opt-in. `login` asks once and stores the answer as
  `WAZAP_READ_ONLY` in `<data-dir>/.env`; `wazap config writes on|off` changes
  it later, and `wazap config` prints every effective setting together with
  where it came from (flag, environment, `.env` or default).
- Bare `wazap` at a terminal prints the banner, the status and the one command
  to run next instead of starting a silent MCP server on stdin. Explicit
  `wazap serve` always serves.
- `wazap status` became a doctor: it checks the Node version, the data
  directory's existence, mode and writability, the lock (none, held, or stale),
  the credentials, the writes setting, and whether npm has a newer version, and
  prints the fix beside anything broken. `--live` reaches WhatsApp for real and
  reports the phone, the chat count and the last message; `--json` prints the
  whole report as one object for scripts. `WAZAP_NO_UPDATE_CHECK=1` turns the
  registry call off.
- `Dockerfile`, `docker-compose.yml`, a systemd unit and a Caddyfile under
  `deploy/`, with a Self-host section in the README; a "Works with" table for
  Cursor, Codex, VS Code and Gemini CLI.
- Five Agent Skills under `skills/` (`wazap-setup`, `whatsapp-inbox`,
  `whatsapp-recall`, `whatsapp-groups`, `whatsapp-send`) and a Claude Code
  plugin manifest that installs them together with the MCP server.
- `send_media` gained `as_voice` for voice notes, `send_message` gained
  `mention_ids`, `manage_group` gained `revoke_invite_link` and per-participant
  results, `get_group_info` reports admin status, announcement mode and the
  invite link.

### Changed

- 22 tools, with schemas describing every field. `get_recent_chats` is now
  `list_chats`, and `load_older_history` is absorbed into `read_messages`
  through its `before` argument.
- Messages have a richer shape: typed `type`, a never-empty `text` with
  placeholders like `[voice message]` and `[poll] question`, quoted message,
  reactions, forwarded and edited flags, media metadata, ISO 8601 timestamps
  with a UTC offset, and a human `age`.
- Identifiers are canonicalized in one place. Tools always return
  `<digits>@s.whatsapp.net` or `<id>@g.us`, and accept phone numbers, `@c.us`
  and `@lid` on input.
- Read-only mode no longer registers the write tools at all, rather than failing
  them at call time.
- Environment variables use the `WAZAP_` prefix. The old `WHATSAPP_*` and `MCP_*`
  names are gone, with no compatibility layer.
- Requires Node 20.

### Removed

- The `whatsapp-web.js`-shaped adapter layer and its message hooks, unused since
  the move to Baileys.
- The separate message journal. History now comes from the store under the data
  directory.
- QR rendering inside the server. Linking is the `login` command's job.
