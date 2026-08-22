# Changelog

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
