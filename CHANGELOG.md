# Changelog

## 0.23.0
### Changed

- **`confirm_send` sends a draft at most once.** Drafts live in the account
  database with the WhatsApp message id they go out under. Confirming a sent
  draft again answers its receipt with `already_sent: true` instead of
  `DRAFT_NOT_FOUND`, for 24 hours, and two confirms at once send once. A
  failure once the message is handed to WhatsApp's relay answers the new
  `SEND_OUTCOME_UNKNOWN`, a stop in the middle included, and never sends that
  draft again; it used to put the draft back, so a timeout could become a
  second message. The draft counts as sent once WhatsApp echoes its id, and a
  send a crash interrupted is unknown after the restart. A failure before the
  relay (not connected, the write budget, the number lookup, a media upload)
  still keeps the draft, with the same code as before. Drafts are capped at 20
  per MCP session, instead of 20 per account, and 200 per account. Deleting a
  sent message or clearing its chat takes its words out of the send record, and
  `WAZAP_PERSIST_HISTORY=0` keeps no drafts and no send words across a restart.
- **A number lookup WhatsApp does not answer is `NOT_CONNECTED`**, not
  `NOT_ON_WHATSAPP`: only an answer says a number has no WhatsApp.
- **Echoes of wazap's own sends stay quiet after a restart.** The webhook
  recognises them by the message ids confirmed drafts recorded, not only by
  the last ten minutes of sends in memory.
- **Voice notes are transcribed from a durable queue.** The queue is kept in
  the account database, queued in the transaction that stores the note, so a
  restart or a crash resumes it instead of losing what was waiting. A failed
  download, a provider answering 429 or 5xx, or a whisper.cpp crash is retried
  after 10 s and a minute, three attempts in all; expired media, audio the
  provider refuses and files too large give up at once and record why. A note
  deleted or expired while it waits is dropped, and one still waiting a day
  after it was queued is given up on (`too_old`). A note queued under `local`
  is never uploaded to an API provider configured later (`provider_changed`).
  One transcriber serves every account in turn, only in the server, and a
  note that just arrived starts ahead of any backlog, so its webhook event
  carries the words. A provider that cannot take any note (not ready, key
  refused) pauses transcription for 30 s up to 15 minutes instead of
  downloading and uploading every note again, and events post the placeholder
  at once meanwhile. A stop waits up to 30 s for a transcription under way;
  removing an account cancels it. Notes a history sync brings are now
  transcribed when less than a day old (before, never). `get_status` has a
  `transcription` block and `wazap status` a `voice queue` line: counts, the
  current run's age, a pause and the latest reason, never content.
- **Webhook events survive a restart.** Each event waits in an outbox inside
  the account database, written with the message it announces, and is posted
  one at a time per account, in the order it was queued within its chat; a
  chat waiting for a retry or a transcript holds back no other chat. A
  timeout, an unreachable receiver, `408`, `425`, `429` or `5xx` is retried
  after 1 s, 5 s, 30 s, 2 min, then every 5 min and a last time at 24 hours,
  and at once when new traffic shows the receiver may be back; any other
  `4xx` still fails at once. After an outage only the newest `connection`
  status is posted. A POST a crash interrupted is sent again, so a receiver
  may see an event twice: dedupe on `message_id`. A message event carries the
  message as it is when posted, with an edit or transcript that arrived
  meanwhile, and is not posted at all once the message is deleted, expired or
  cleared. A voice note's event waits on the transcription queue, a restart
  included, and goes at once when its transcription fails or the provider is
  paused. Nothing waits in memory any more, so no event is dropped for a full
  backlog.
- **Webhook message events carry `contact_id` and `phone`.** `contact_id` is
  the sender's stable contact in the account database, and `phone` their
  number in E.164, `null` while unknown. `read_messages` and the other message
  views add `sender.contact_id`; `list_chats` adds `contact_id` and `phone`
  for one-to-one chats. No existing field changed.
- **`webhook.delivery` counts the outbox.** `delivered` covers the last 7
  days, `failed` and `cancelled` the last 30; `cancelled`, `pending`,
  `retrying`, `last_status` and `oldest_pending_at` are new. `wazap status` and
  doctor read it from the account database, server running or not; they warn
  while an event is being retried and fail once the oldest has been retried
  for 10 minutes. `accounts/<id>/webhook.json` is no longer written.

### Fixed

- **`recall` no longer answers a long question with one-word coincidences.**
  When a query has three or more words, a hit found only by its words must
  share at least two of them, or its meaning must clear the similarity floor;
  a question with no answer comes back empty again. An exact copy of a
  better-ranked hit, such as the same message forwarded to two chats, is
  listed once.

### Upgrade notes

- The account database moves to schema version 4 on the first start: version
  2 holds the drafts and sends, version 3 the voice-note transcription queue,
  which starts empty (nothing stored before the upgrade is transcribed on its
  own), version 4 the webhook outbox, which starts empty too. 0.22 refuses a
  version 2, 3 or 4 database (`SCHEMA_TOO_NEW`), and there is no downgrade:
  going back means restoring a copy taken before the upgrade.

## 0.22.0
### Changed

- **Every account is served from one database.** Chats, contacts, messages,
  reactions, votes, receipts, transcripts, notes, recall vectors and deletion
  barriers live in `accounts/<id>/wazap.sqlite`, and no history is held in
  memory: a restart, a chat with thousands of messages and an edit to an old
  message read the same file. The first start after the upgrade imports
  `store.json`, `history/`, `retention.json`, `notes.json`, `recall/` and the
  beta archive once, resuming if it is stopped; meanwhile the account's tools
  answer `NOT_CONNECTED` and `get_status` says it is preparing. Once imported,
  the legacy files move into `accounts/<id>/legacy/`, and the beta archive into
  `<data-dir>/legacy/` once every enabled account linked to its number has
  imported it; both are deleted a week later, at once with
  `WAZAP_RETENTION=1`. Only what wazap moved is deleted, never through a link.
  An import whose check found differences it could not explain keeps its
  legacy files until you delete them. An account not linked at the upgrade
  imports the beta archive once its number links; until an account has, the
  archive stays where it is.
- **`search_messages` has no per-chat window.** Every kept message is
  searched, and `coverage.per_chat_cap` is `null`. A query so short or so
  common that the search reaches its scan limit answers `scan_capped: true`
  and `searched_back_to`, with a line saying to narrow it.
- **`recall` matches by words and meaning at once**, fusing the two rankings;
  each hit says which matched, and `similarity` is `null` for a hit found by
  its words alone. A match found by meaning still fades with age, one chat
  still takes at most three leading places and a near-duplicate still trails.
  The index is kept in the database and indexing resumes where it stopped; a
  text the embedding server refuses is skipped until its words change.
  `WAZAP_RECALL_MAX` no longer caps anything.
- **`WAZAP_PERSIST_HISTORY=0` removes stored messages at every start and
  stop**, not only under `WAZAP_RETENTION=1`; barriers, chats, contacts and
  notes stay.
- **Logout deletes only the credentials.** The account database stays, tied
  to the number, so the same number linking again finds its history, and an
  earlier wazap's `store.json` is left to the legacy files' week instead of
  being deleted. A different number linking sets the database aside as
  `wazap.<time>.previous-owner.sqlite` and never imports the earlier number's
  files; the earlier number linking again gets its database back. A set-aside
  database nobody links is deleted a week later, whatever `WAZAP_RETENTION`
  says. `account remove` still deletes the whole folder.
- **`wazap status` reports each account's storage**, read-only, with the
  server running or not: preparing (with the import phase), ready, imported
  with unexplained differences (by category and count) or failing to open;
  the database's size, messages, chats and embedding queue; the legacy files
  and when they are deleted; set-aside databases; and the beta archive.
  `status --json` carries it as `storage`, and `get_status` as `storage`.
- **A handled chat reopens only when the other side writes after the ask**
  that was marked, and a receipt keeps the latest time it was reported.
- **Accounts come and go without a restart.** A running server follows
  `accounts.json`: `wazap account add`, `enable`, `disable`, `default` and
  `remove` apply to it at once, and a tool that names an account added since
  it last looked reads the registry again before answering
  `ACCOUNT_NOT_FOUND`. An added or enabled account gets its own socket; a
  disabled or removed one is stopped, and calls that name it answer
  `ACCOUNT_DISABLED` or `ACCOUNT_NOT_FOUND`. `account remove` stops the
  account before its folder is deleted. The last account a server runs keeps
  running until it stops, since a server with none refuses to start.
- **`wazap logout` works while a server runs.** Instead of refusing with
  `wazap is running (pid N)` unless the server was the `wazap service`, logout
  asks the running server to log the account out: it closes that account's
  socket and any pairing in flight, unlinks it from WhatsApp and deletes its
  credentials as an offline logout does, and keeps serving the
  other accounts. The account comes back not linked, so `link_account` can
  link it again. Output and exit codes are the offline ones.

### Security

- **The CLI reaches the running server over a private control line.** It is
  its own listener on an ephemeral `127.0.0.1` port, opened only by a random
  token the server writes to `<data-dir>/control.json` (`0600`). It is not the
  MCP listener a tunnel or proxy points at; `WAZAP_READ_TOKEN`,
  `WAZAP_WRITE_TOKEN`, OAuth grants, the bridge token and anonymous callers
  are refused; requests with an `Origin` or a non-loopback `Host` are refused;
  and no MCP tool reaches it. It exists with or without `WAZAP_NO_SHARE`.

### Upgrade notes

- **The first start imports each account once**, before serving it (see
  above); `wazap status` shows the phase. A rollback to 0.21 loses everything
  from the 0.22 period (messages, edits, notes, deletions: messages deleted
  meanwhile show again) and is impossible with `WAZAP_RETENTION=1` or once the
  legacy files' week is over. Back up the data dir first; the order of steps,
  and how to upgrade again without losing the 0.22 database, are in README,
  "Rolling back to 0.21".
- A server started by an older wazap has no control line: against it,
  `account` changes still say to restart, and `logout` and `account remove`
  still refuse. Restart it once on the new version.

## 0.21.0
### Security

- **An HTTP session belongs to the credential that opened it.** A session id
  used to select its transport whatever token came with it, so a read token, a
  different write token or an anonymous reader holding the id could drive a
  write session. Sessions are now bound to a fingerprint of the exact
  credential and its permissions; anyone else gets 404.
- **A draft can only be confirmed from the MCP session that made it.** Any
  write client could confirm another client's draft by id. A foreign or
  unknown draft now answers `DRAFT_NOT_FOUND` without revealing the recipient
  or consuming it. A new session, including one opened after an OAuth token
  rotation, drafts again.
- **Remote clients cannot read files off the server.** An HTTP write token
  could send any local file as media or a picture, and any client could pick
  the `download_media` directory. HTTP sessions, static tokens and OAuth alike,
  now refuse `file_path` and `save_to`; public URLs, forwards and the default
  download directory still work. Local stdio and the private daemon token used
  by bridges keep file access.
- **Forwarded addresses are trusted only from named proxies.** Every private
  peer counted as a proxy, and `CF-Connecting-IP` alone could pick the password
  lockout identity. `WAZAP_TRUST_PROXY` now lists the proxies that may supply
  `X-Forwarded-For` (default `loopback`, `none` for none), and the compose file
  trusts its own gateway.
- **Transcription endpoints no longer follow redirects**, and provider errors,
  signed URLs and decoder output no longer reach errors or logs; failures keep
  their HTTP status or error code (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, exit codes).
- **ffmpeg reads only local media files**, never network protocols, playlists
  or image sequences, for previews, GIFs and transcription.
- **HTTP logs name only known routes and RPC methods**, never query strings,
  arbitrary paths or request body excerpts.
- **A revoke only removes a message in the chat it arrived in.** A protocol
  message could name a message in another chat as its target.
- **OAuth refresh tokens rotate**, and a consumed one replayed after a 60-second
  grace window revokes its grant. Registrations, grants, consent pages and
  codes have hard caps, and a damaged `oauth.json` signs every agent out
  instead of being trusted.
- **A lost account policy fails closed.** Saving `accounts.json` writes an empty
  `accounts.json.required` marker; if the policy then disappears, wazap refuses
  to start with open defaults. Write tools read the policy from disk and never
  fall back to cached send rules. A malformed `WAZAP_READ_ONLY` is an error
  instead of meaning writes on.

### Added

- **Link previews on sent and edited text.** wazap builds the card itself from
  the first link: page and thumbnail fetched through the same DNS-pinned,
  size-capped path as media URLs, four seconds at most, JPEG thumbnails only,
  never while drafting. The sites see the server's public IP. Baileys' own
  unrestricted fetcher stays off.
- **`WAZAP_RETENTION=1`, strict retention, off by default.** Messages marked as
  disappearing expire locally at their earliest known deadline, from memory,
  history, snapshots, previews, transcripts and the recall index; keep-in-chat
  is not an exemption. With it, starting with `WAZAP_PERSIST_HISTORY=0` also
  discards caches an earlier history-on run left.
- **Request budgets**, configurable: eight running tool calls per MCP session
  and 32 in total (`WAZAP_MAX_INFLIGHT`, `WAZAP_MAX_INFLIGHT_TOTAL`), 240 POSTs a
  minute per credential (`WAZAP_HTTP_BUDGET`), 100 KiB request bodies, 32
  sessions per credential, and listener timeouts.

### Changed

- **Deleted messages leave no bytes behind.** An observed delete, revoke or
  chat clear now also removes the message from history files, the snapshot,
  automatic previews, transcripts and the recall index straight away, not at
  the next restart. `retention.json` keeps the deleted ids and clear cutoffs,
  without content, so a history sync cannot bring them back. Delete and clear
  tools wait for that cleanup and report a disk failure.
- **The recall index moves to format 3 in place.** Rows and progress are kept;
  nothing is re-embedded on upgrade.
- **Model downloads are bounded and exclusive.** Bytes are counted as they
  arrive and stop at the model's size, a stalled transfer times out after 30
  seconds, and the whole download gets 30 minutes or the model's size at
  100 KiB/s, whichever is longer. Two downloads of the same model no longer
  write one file: the second fails at once and names the lock directory.
- **Anonymous loopback reads require a loopback `Host` and same-origin
  requests**, which stops browser DNS rebinding; any port is accepted.

### Upgrade notes

- HTTP clients that sent `file_path` or `save_to` get an error; send a public
  URL instead, or use stdio.
- Behind a reverse proxy or tunnel that is not on loopback, set
  `WAZAP_TRUST_PROXY` to its address, or every OAuth caller shares one lockout.
  With the compose file, pull it: it pins its network and trusts that gateway.
- Drafts do not survive a new MCP session or an OAuth token rotation.
- Do not delete `accounts.json` to reset it: restore a backup, or delete
  `accounts.json.required` as well to start over on purpose.

## 0.20.2
### Fixed

- **A number WhatsApp moved away from no longer answers as someone else.**
  When WhatsApp pairs a lid with a new number, the old number kept pointing at
  that lid, so it could be named as the other person and deleting its chat
  reached their history too. The old number is now let go, while a number that
  gains a new lid keeps working for the older one, as WhatsApp's own table does.

### Changed

- **One table decides who a lid is.** The lid-to-number pairings lived in
  three maps plus the snapshot copy, and each resolver read a different one.
  They now live in one registry (`src/identity.ts`) with one set of rules for
  ids, names, votes and the account itself. A run comparing the old and new
  code over 400 scenarios found no other change in behavior.

## 0.20.1
### Fixed

- **A disappearing-messages change says who made it and for how long.**
  WhatsApp sends the timer as a protocol message, in a group and a one-to-one
  chat alike, and it read as a bare `[system message]`. It now reads
  "[Ana turned on disappearing messages: 7 days]" or "turned off", with
  `system.action` `set_disappearing` and the seconds as its value.
- **A request to join a group says who asked and what became of it.** It read
  as `[system message · GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD]`
  and now reads "[Ana asked to join]", "[Ana withdrew their request to join]"
  or "[Dan rejected Ana's request to join]", with `system.action`
  `join_request`.

Both were found testing 0.20.0 on a real account: read receipts, group
settings, join requests, poll votes from another number, admin deletes,
mentions, pins, stars, delete-for-me, block and `join_group` all behaved as
documented.

## 0.20.0
### Added

- **Poll votes and event responses land on their poll or event.** A vote is
  encrypted under the poll's secret and bound to the creator's and voter's
  jids exactly as WhatsApp spelled them, lid or number; wazap tries the
  spellings it knows until one authenticates and matches the option hashes to
  the poll's options. A poll carries `poll: {question, options: [{name, votes,
  voters}], voters}`, read_messages tags it "3 votes" and get_message lists who
  chose each option; an event carries `event_responses: {going, maybe,
  not_going}`. A newer vote replaces an older one, a withdrawal sticks, votes
  survive a restart, and votes stored before as lines of their own fold onto
  their poll. A vote whose poll is not loaded reads as "[vote on a poll that is
  not loaded]" until the poll arrives. `send_poll` no longer says votes cannot
  be read.
- **The user's own messages say how far they got.** One-to-one receipts raise
  `delivery.status` from sent to delivered, read and played and never lower
  it; in a group each member's receipt is kept, and `delivery.read_by` and
  `delivery.delivered_to` name who, with the time. A synced message's own
  status and receipts are the floor. read_messages tags "read" or "read by 3",
  get_message lists who.
- **Group admins run the group from wazap.** `manage_group` lists pending join
  requests and approves or rejects them, and sets announcement-only, locked
  info, who adds members, join approval and disappearing messages (`off`,
  `24h`, `7d`, `90d`). `get_group_info` reports those settings and whether the
  group is or belongs to a community. `delete_message` takes someone else's
  message in a group where the linked account is an admin.

- **`join_group` joins a group from an invite.** It takes a link, a code, or
  the `message_id` of an invite someone sent; without `confirm: true` it only
  previews the group (name, description, size, whether an admin must approve),
  and with it joins, or says the request waits for an admin. The invite code
  never reaches the logs. wazap now has 38 tools.
- **More of what the phone does, from `manage_chat`.** Pin and unpin a message
  for everyone (24 hours, 7 days or 30 days), star and unstar a message, clear a
  chat, delete a chat, and block or unblock a contact. The blocklist is read
  when the account connects, so `get_contact`'s `is_blocked` is right from the
  start.
- **Mentions are visible and actually mention.** A message that @-mentions
  people carries `mentions: [{id, name}]`. `send_message` with `mention_ids`
  puts the `@<number>` token WhatsApp needs into the text when it is missing,
  and the draft preview shows exactly the text that will be sent.

### Changed

- **`delete_message` needs `for_everyone`.** `true` retracts the message for
  everyone; `false` now deletes it only for the linked account instead of
  failing. There is no default, so an agent always says which one it means.

### Fixed

- **A deleted chat is gone, and stays gone.** Deleting or clearing a chat,
  from wazap or from the phone, removes its messages instead of leaving the chat
  in `list_chats`; they no longer come back when the server restarts, and
  `recall` forgets the whole chat, older indexed messages included. A message
  deleted only for the linked account stays deleted after a restart too.
- **A mentioned person, a reactor or a voter no longer borrows the sender's
  name** when wazap knows no name for them.
- **A receipt no longer moves a message in time.** A delivery or read receipt
  carries the moment it happened, and wazap wrote it over the message's own
  timestamp: a sent message jumped to when it was read, and a received one to
  when the phone read it, which reordered chats and aged asks wrongly.

## 0.19.1
### Fixed

- **Reinstalling or restarting the macOS service now runs what the unit
  says.** launchd keeps the plist it read when the job was loaded, and a
  restart used `kickstart -k`, which reruns that copy. So `wazap service
  install` over an existing service, `wazap service restart` after an update
  and `wazap expose` rewrote the unit and kept running the old command — an
  upgrade to a global install could go on serving the previous build. A
  restart now boots the job out, waits for launchd to release it, and loads
  the unit file again. If `wazap status` reports a version older than the one
  you installed, run `wazap service restart` once.

### Added

- **Group notices, pins and business messages read as what they are.**
  Templates, buttons, lists and interactive messages from businesses read and
  search as text, with their button labels; a tap reads as the choice. Pins,
  keeps and a shared chat history say who did it, and a pin carries the pinned
  message's id. Events and group invites have types of their own (`event`,
  `invite`); an invite's code and an event's call link never show. Orders,
  products, status mentions, scheduled calls, poll results, channel admin
  invites and sticker packs get short tags, a message kept off linked devices
  says to read it on the phone, and undecryptable, disappearing-mode, block,
  username, community and business-privacy notices are spelled out instead of
  `[system message · …]`.

## 0.19.0
### Security

- **Private encryption keys no longer reach stdout or the logs.** The Signal
  library prints whole session records, private and root keys included, with
  `console.info`. Over stdio that corrupted the MCP stream; under the service
  it landed in a world-readable log. Every console line from a dependency now
  goes to stderr, and a session record is cut down to the phrase that
  announced it. The service's log directory is `0700` and its logs `0600`,
  including logs launchd already created. Delete old `*.out.log` files that
  may still hold keys.
- **The OAuth consent page names who is really asking.** Client registration
  is open, so a client's name is only its own claim: the page and its tab now
  name the host the code goes back to, and show the client's name as unchecked.
  OAuth pages cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options`),
  send no referrer and are never cached.
- **A stranger's wrong passwords no longer lock the owner out.** Behind a
  tunnel, the caller is taken from `X-Forwarded-For`, or `CF-Connecting-IP`
  when that is all cloudflared sends, and twenty misses from everywhere pause
  consent for a minute instead of fifteen.
- **A tunnel keeps sign-in on.** `wazap expose off` leaves `WAZAP_PUBLIC_URL`
  set while any unit still tunnels to the port, naming it and how to stop it,
  and `serve --http` refuses to start with no token and no sign-in when a
  tunnel reaches its port.
- **`/healthz` tells a stranger only whether wazap is up.** Without a token it
  answers `{ ok, status, since }`; the account list needs a read or write token.
- **Dependencies.** `npm audit fix` for sharp, express, body-parser, qs,
  fast-uri and hono; `npm audit --omit=dev` reports nothing, and CI now checks it.

### Fixed

- **A lost MCP session is a 404.** An `Mcp-Session-Id` wazap no longer holds,
  expired, evicted or lost to a restart, now gets `404`, which tells a client
  to start a fresh session, instead of a `400` it could not recover from.
- **A refused token says so.** A `401` for a token that was sent and refused
  carries `error="invalid_token"`, so a client knows to refresh or sign in
  again, and the request log names the client's User-Agent and OAuth client id.
- **A webhook receiver that refuses is no longer hammered or ignored.** A `4xx`
  other than `408`, `425` and `429` is posted once, with the status and a hint
  in the error, instead of three times per event. Events nobody subscribed to
  no longer take a place in the backlog.
- **The server lock holds under a race.** Two servers that find the same stale
  lock no longer both take it.
- **`.env` is written in one step**, so a failed write never leaves half of it.

### Added

- **Webhook delivery is visible.** `get_status` reports `webhook.delivery`:
  delivered, failed and dropped events, the failing run and the last failure.
  The server keeps them in `accounts/<id>/webhook.json`, so `wazap status`
  fails the webhook check after three failed events in a row and warns on a
  recent failure or drop. A run of identical failures logs a few lines, not one
  per event.
- **Releases ship everywhere from the tag.** The publish workflow checks the
  tag and the CHANGELOG, lints and typechecks, publishes to npm with
  provenance, publishes to the MCP Registry through GitHub OIDC with a
  hash-pinned publisher, and creates the GitHub Release with the Claude Desktop
  bundle `wazap-X.Y.Z.mcpb` attached.

### Changed

- **Node 22 is the minimum** (`engines`, the Claude Desktop manifest, doctor
  and the setup skill). CI tests Node 22 and 24, and a weekly canary runs the
  suite against the newest Baileys.

## 0.18.6
### Added

- **Group notices say who did what.** A group's system messages used to
  read as `[system message]`, so nobody could tell who added whom.
  Additions, removals, leaves, promotions, renames, description, photo and
  invite-link changes, the admin-only settings and member label changes
  now read as `[Medeea added Ana (40723124956)]`, and carry
  `system: {action, actor, targets, value}` with the people put to names
  and numbers. A stub wazap does not spell out yet names its type instead
  of hiding behind `[system message]`.
- **Reactions name who left them.** `read_messages` tags them as
  `❤️×2 😍` instead of a run of emoji, `get_message` lists each one with
  its author, and every reaction in a view carries `name`.
- **`manage_group` sets and removes the group photo.** `set_picture` takes
  `file_path` or `url` under the same JPEG, PNG or WebP, 10 MB rules as
  `set_profile_picture`; `remove_picture` takes the photo down. Both need
  admin rights and reach WhatsApp at once, so the agent shows the image and
  waits for a yes.

### Changed

- **`NOT_ADMIN` carries a fix** on every group action: ask an admin to make
  the linked account an admin, or to make the change themselves.

## 0.18.5
### Added

- **Per-account send rules — `wazap config send`.** An account can now be
  limited in who it may message: `send allow` makes a list exhaustive (and
  `allow none` locks the account to nobody), `send deny` refuses its
  entries whatever else is allowed, `send open` lifts every restriction.
  The rules live on the account record and are re-read when a draft is made
  and again at `confirm_send`, so one written while a draft waits still
  applies to it. A refused send fails `SEND_BLOCKED` naming the rule that
  fired, before the socket is touched — and the agent is told to tell you,
  not to retry or route around it.
- **Read tools say who the sender actually is.** `get_message`,
  `search_messages`, recall and `download_media` add the number behind the
  sender's id and a `name_source` — `contact` when the shown name is your
  own address-book entry, `pushname` when it is the name the sender
  publishes, `none` — with `is_saved` alongside, so a shown name is no
  longer mistaken for a saved contact.
- **Every `search_messages` answer reports its coverage.** How many held
  messages were scanned, across how many chats, and the oldest/newest
  bounds of the window — so "nothing found" no longer reads as "nothing
  synced". The keyword scan covers the whole disk window, not only what
  memory holds.
- **`get_status` reports how fresh the local history is.** The initial-sync
  state and the newest inbound message wazap holds, flagged stale past
  24 h; a scoped query adds the newest message held for that chat.
- **`download_media` returns the media contract.** The saved file now names
  the caption and the original filename the envelope carried.
- **A message id survives re-identification.** A chat first seen under a
  lid keeps its messages findable under both spellings once the number
  pairs, raw `<chat>_<stanza>` ids still reach the record, and an id the
  resolved account cannot file is tried on every other binding before it
  misses.
- **Send drafts render the full preview.** Every send tool's draft shows
  Not sent, the resolved recipient (name + number, or the group), the exact
  body for its kind, and the `confirm_send` instruction. A draft to someone
  known only by a pushName flags `unnamed_recipient` until `save_contact`
  files them under a real name, and `get_group_info` marks digit-named and
  unresolved-lid participants `[unnamed]`. `confirm_send` on a missing or
  expired draft names the recovery instead of failing bare.

### Changed

- **`wazap update` no longer puts back skills you removed.** It used to copy
  the skills into every detected client that lacked them, so deleting them
  from `~/.claude/skills` lasted until the next update. Now it refreshes only
  clients that already hold a copy, stale or upgraded; a client with none is
  left alone. `wazap setup` and `wazap skills install` still install them, and
  a copy missing only some skills, such as one a release added, still counts
  as stale and is refreshed.

### Fixed

- **`wazap config <setting>` with no value is the arity complaint again.**
  `config send` had widened the gate to one positional, so a bare
  `wazap config writes` reached the setter and failed "Cannot set" instead
  of being told a value is missing.

## 0.18.4
### Added

- **The embedding sidecar now sleeps when unused.** An idle `llama-server`
  held ~330-500 MB of RAM for the life of the service even when recall was
  queried once a week. `WAZAP_EMBED_IDLE_MINUTES` (default 30, `0` keeps it
  resident) reaps a quiet server; the next embed re-spawns it transparently.
  The shared registry from 0.18.3 means one clock and one respawn for every
  account on the same model.
- **Recall results are diversified and keyword-aware.** A single chat used
  to fill every slot of a clustered answer; now it holds at most three
  leading slots and near-duplicates trail the list. A query token a hit
  carries verbatim — a name, a number, a time — earns a small bounded bonus,
  since embeddings are weakest exactly where `search_messages` is strongest.
  Raw `similarity` and the similarity floor are untouched; only `score`
  carries the bonus, capped so it reorders neighbours and never rescues
  noise.

### Fixed

- **One unembeddable message no longer stalls the index.** A text over the
  model's context window gets a deterministic 400 from llama-server, which
  the queue used to retry until it declared the whole backend dead — and
  every restart re-fed the same poison. A 4xx now surfaces as
  `RECALL_BAD_INPUT`; the queue bisects the batch, drops the offending
  message, and keeps going.
- **e5 is honestly calibrated instead of a guess.** Measured on a real 12k
  index, e5's noise and real hits overlap (~0.84 vs 0.82-0.88), so its floor
  moves to 0.85 — erring toward silence — and `wazap status` no longer
  flags it uncalibrated. A per-model `maxChars` (e5's window is 512 tokens)
  keeps over-context messages out of the server entirely. Gemma stays the
  recommended model.

### Changed

- **Faster boots.** OAuth, express, QR and bridge modules load lazily —
  spawn to ready is ~14% faster on a warm machine, and bridge-mode children
  skip the HTTP stack entirely.

## 0.18.3
### Added

- **One llama-server for every account.** Recall used to spawn an embedding
  sidecar per account — ~330 MB of model and runtime RAM each. The
  /embedding API is stateless, so accounts on the same binary and model now
  share a single server through a refcounted registry; the last account to
  stop is the one that kills it. Concurrent boot backfills join the same
  spawn, never two.
- **`scripts/recall-eval.mjs`: a fixed case set scored against the live
  daemon.** Each case pairs a query with an expected hit or `expectNone`;
  the run reports rank, raw similarity and the floor band between worst
  expected hit and best noise hit, exiting non-zero on any failure — so a
  prompt, model or floor change gets measured instead of eyeballed.

### Fixed

- **The similarity floor is per-model now.** It travels with the model spec:
  embeddinggemma-300m keeps its measured 0.35, e5-base-multilingual gets a
  conservative 0.7 flagged `uncalibrated` in `wazap status` — e5's prompted
  cosines sit in a higher band and silently inheriting gemma's floor would
  pass noise as answers. `WAZAP_RECALL_MIN_SIMILARITY` still overrides both.
- **The daemon stdin-shutdown test no longer flakes under load.** A spawned
  child pays Node boot plus the whole module graph before it can write
  daemon.json — under a second idle, several seconds when the suite runs
  children in parallel. Startup/shutdown budgets widened to 30s/10s, and a
  timeout now carries the child's last stderr lines instead of an opaque
  wait.

## 0.18.2
### Fixed

- **Recall embeds with the model's own task prompts.** llama-server was fed
  raw text while embeddinggemma was trained on asymmetric retrieval prompts
  (`task: search result | query:` for the query, `title: none | text:` for
  documents). A/B on a real index: noise drops from 0.45-0.54 cosine to
  under 0.31, nonsense queries return nothing, and true paraphrases surface
  again — so `WAZAP_RECALL_MIN_SIMILARITY` is recalibrated to 0.35. e5 gets
  its documented `query:`/`passage:` prefixes too. Existing indexes are
  wiped and rebuilt on first boot: mixed embedding spaces would rank
  garbage.

## 0.18.1
### Fixed

- **Recall no longer ranks noise as answers.** On the live index, unrelated
  queries matched ultra-short texts ("Da", "Ceau") at 0.45-0.54 cosine while
  real matches start around 0.5, so a nonsense query returned confident
  junk. Hits must now clear `WAZAP_RECALL_MIN_SIMILARITY` (default 0.5,
  calibrated on embeddinggemma-300m; another model needs its own value),
  texts under five letters or digits never enter the index, and results
  surviving but staying weak are flagged in the output instead of being
  listed like found facts.

## 0.18.0
### Added

- **Local semantic recall ("living memory").** A new read tool, `recall`,
  searches the whole indexed WhatsApp history by meaning rather than exact
  words — a paraphrase or another language still hits, and it keeps finding
  messages too old for `search_messages` to see. Off by default: turn it on
  with `wazap config recall local`, install llama.cpp
  (`brew install llama.cpp`) and fetch the model with `wazap embed download`.
  Embedding runs on-device — a `llama-server` sidecar bound to loopback — and
  the index lives per account under `accounts/<id>/recall/` with history's
  permissions (0700/0600). Hits rank by similarity scaled by recency and each
  carries its date; one that fell out of the live store is marked "index
  only" and answers from the index's own copy. `chat_id`, `since`, `until`
  and `from` narrow a search the way they narrow `search_messages`. Recall
  requires `persistHistory` — the index never outlives its source — and
  deletes, edits, revokes and expired stories leave it. `get_status` reports
  the index as `off`, `indexing`, `ready` or `degraded`; `wazap doctor`
  checks the binary and the model file. Knobs: `WAZAP_RECALL`,
  `WAZAP_EMBED_MODEL` (`embeddinggemma-300m` default, `e5-base-multilingual`
  fallback for older llama.cpp), `WAZAP_EMBED_BIN`, `WAZAP_RECALL_MAX`.

## 0.17.0
### Added

- **The new webhook events are opt-in.** `WAZAP_WEBHOOK_EVENTS` names what
  gets posted, comma-separated, and unset means `message_received` only, so
  an existing endpoint sees nothing new unless it asks for it. Say `all` for
  every event. An account overrides the list with `webhook_events` in
  `accounts.json`, beside `webhook_url` and `webhook_secret`, and
  `config webhook off --account <id>` clears all three. An unknown name
  fails `wazap status`, doctor and setup.

- **The webhook posts messages you send, too.** A message typed on the phone
  or on another linked device arrives as `event: "message_sent"`. A message
  wazap sent through its own tools is not announced, so a consumer cannot be
  made to answer itself. History sync is still not posted.

- **Connection changes are an event.** `event: "connection"` carries a
  `status` of `linked`, `disconnected` or `expired`. `not_linked`, `linking`
  and `connecting` post nothing, and two changes that mean the same status
  post once.

- **Five payload fields.** `timestamp` is the same instant as `ts` in ISO
  8601 UTC, `truncated` says whether `text` was cut, `kind` is `text`,
  `audio`, `image` or `other`, and `from_me` and `is_self_chat` say who sent
  it and where. Existing consumers keep every field they had, `ts` included,
  with the meaning it had.

- **`wazap webhook test --event <name>`** posts `message_received` (the
  default), `message_sent` or `connection`. An unknown name exits 1. An event
  you have not enabled posts nothing and exits non-zero.

### Changed

- **An existing webhook endpoint receives exactly what it received before.**
  `message_sent` and `connection` stay off until `WAZAP_WEBHOOK_EVENTS` asks
  for them. Once you do ask, branch on `event`. `message_sent` is a message
  this account sent, not one to reply to, and `connection` carries no `from`,
  `text` or `message_id`.

- **The webhook text preview is cut at 2000 characters, not 500.** A cut
  preview ends in a single `…`, and `truncated` is true.

- **A voice note's webhook waits for its transcript.** The event of an
  auto-transcribed voice note carries the words in `text` instead of the
  `[voice message · 0:42]` placeholder.

## 0.16.0
### Added

- **`wazap account default <id>`** picks the account tools use when a call
  does not say otherwise. `config webhook on|off --account <id>` sets or
  clears that account's webhook URL/secret in `accounts.json` (the on/off
  switch stays global in `.env`). `account list` and `list_accounts` show the
  persisted `owner`, masked, for accounts with no live socket.

### Fixed

- **Account changes while a server runs now say so.** `account
  add|enable|disable|default` warn that the running server needs a restart,
  and a tool given an `account_id` that exists on disk but not in the
  server's snapshot answers ACCOUNT_NOT_FOUND with "restart the server"
  instead of "run `wazap account add`".
- **`wazap logout` yields the session the way `login` does.** When the
  background service holds the lock, logout stops it, unlinks, and starts it
  again instead of refusing with a `kill` that the supervisor would respawn.
  `account remove` refuses with `wazap service stop` in the same case.
- **The layout migration refuses while a process holds the session.** A
  `status` against a flat `~/.wazap` used to move `auth/` out from under a
  running pre-0.15 server. Now it says to stop the holder first;
  `migrate rollback` refuses the same way, and commands that never open
  account state (`service`, `connect`, `skills`, `expose`, `update`,
  `transcribe`) skip the migration so `wazap service stop` can free the lock.
- **`status --json` `linked` is true when any account is linked**, not only
  the selected one; `accounts[]` still carries each account's own state, and
  the credentials check names the linked ids. A linked `work` no longer
  sends a setup flow back through pairing because `default` is unlinked.
- **`config writes on --account x` warns when global read-only still wins.**
  The account flag is stored, but the message no longer claims writes are on.
- **`wazap status` tells a newer service from an older one.** A service
  ahead of the installed wazap gets `wazap update`, not a restart that keeps
  the same build.
- **`link_account` persists `owner`** on the account's record once the
  pairing settles, so `list_accounts` and `account list` can name it later.

## 0.15.0
### Added

- **Several WhatsApp accounts in one process.** `accounts.json` names each
  account; auth, store, history, media, previews and notes live under
  `accounts/<id>/`. A flat `~/.wazap` moves into `accounts/default/` on the
  first command (`wazap migrate rollback` undoes it). `wazap account
  add|remove|list|enable|disable` manages slots. `--account` picks one on
  `login`, `logout`, `status`, `config writes` and `webhook test`. One
  `wazap serve` starts a socket per enabled account. MCP tools take optional
  `account_id`; `list_accounts` lists them. A chat only one account knows
  selects that account. A send to a chat no account knows, with two or more
  accounts, fails `AMBIGUOUS_ACCOUNT`. `get_status` keeps today's top-level
  fields and adds `accounts[]`.

- **Webhook payload names the account.** Each `message_received` body includes
  `account_id` and `account_name`. An account may set `webhook_url` and
  `webhook_secret` in `accounts.json`; those win over the global `.env`
  values. `wazap webhook test --account x` posts with that account's override
  and id.

## 0.14.0
### Added

- **`set_profile_picture`.** Write tool that updates the linked account's own
  profile photo via Baileys `updateProfilePicture`. Exactly one of `file_path`
  or `url` (same loader as `send_media`). JPEG, PNG or WebP, at most 10 MB.
  Hidden when writes are off. No draft, no remove, no group avatars. Show the
  image and wait for a yes first; the call hits WhatsApp immediately.

- **Outbound webhook (`message_received`).** `wazap config webhook on|off`
  sets one URL and an HMAC secret. Each live inbound message POSTs a small
  JSON body (`event`, `from`, `chat_id`, `ts`, `text`, `message_id`). On
  without a URL or secret fails `status` / doctor / setup. A failed delivery
  retries twice, then sets `webhook.last_error` and leaves the WhatsApp and
  MCP paths up. `wazap webhook test` sends a probe. History sync is not
  posted. Stubs and system notices are not posted. Signature: see README.

- **Grok Bot / remote MCP.** README and `wazap setup` now have the four-step
  HTTP path: `wazap login` on the host until the CLI says linked, answer
  writes at login, `serve --http` with `WAZAP_READ_TOKEN` (set
  `WAZAP_WRITE_TOKEN` only if this client should send), then connect that
  URL on Grok Bot and call `learn`, `get_status`, read. Missing write tools
  on HTTP need writes on and a write Bearer on the session; config alone is
  not enough. `connected` is the socket; `write_tools` (or send tools in
  the list) is whether this session can send. Setup asks "remote client?"
  and prints the URL template; it does not start `expose`.

### Fixed

- **`.env` writes quote values dotenv would otherwise cut.** A secret with
  `#` (or spaces, quotes) is written quoted so it round-trips through
  dotenv. Unquoted `p@ss#word` used to load as `p@ss`.
- **Outbound webhook skips stubs and system notices.** Only a person sending
  something fires `message_received`. Group-join stubs and protocol
  machinery stay in the store, they are not POSTed.
- **`wazap config` and `readOnlySetting` agree.** Unset `WAZAP_READ_ONLY`
  means writes are on, which is what config already printed as
  "writes: on (default)". One function now decides that, so the two cannot
  drift. When writes are off, `status` / doctor / setup say the write tools
  are missing and to run `wazap config writes on` then restart. On HTTP or
  a public URL they also say a Bearer write token is not writes being
  enabled, and that a read token never registers write tools.
- **`get_status` last message after a restart.** `last_message_received_at`
  no longer stays `never` when the store or history already has inbound
  messages; it reports the latest of those until a live message arrives.

## 0.13.0
### Added

- **`wait_for_messages`.** Blocks up to 55 s until a message from someone else
  arrives, then returns it with a `cursor`; the next call with that cursor
  replays what landed in between. `addressed_to_me` wakes only for direct
  messages, @-mentions and replies to the user. An agent can stay on the line
  instead of polling every few minutes and reporting nothing.
- **`include_previews` on `get_recent_messages` and `read_messages`.** A
  small JPEG of each photo comes back as an image block, newest first, up to
  12 per call, with the message line labelled. WhatsApp almost never ships a
  preview inside the message any more, so the photo is downloaded once and
  shrunk to 320 px here with jpeg-js (pure JavaScript, no native build), and
  the result is kept on disk, one file per message under `previews/`, across
  restarts. A video gets one frame, taken by ffmpeg a second in. A catch-up
  can tell a receipt from a baby without asking for a download.
- **`get_stories`.** The status updates received in the last day, by author,
  newest first, with `include_previews` for the photos. WhatsApp keeps a story
  for a day and so does wazap; they never appear in chats, catch-ups or waits.
- **`set_contact_note` and `mark_handled`.** Two tools that change wazap's
  own notes on this machine and nothing on WhatsApp, so they are there in
  read-only mode too. A note on a person ("Hermi, my own agent") shows next
  to their name in every list; "handled" takes a chat off `get_unanswered`
  until the other side writes again. Kept in `notes.json`. In a chat or a
  group the note introduces the sender once, then the name stands alone.
- **`search_messages` takes `since`, `until` and `from`**, so "what did Sorin
  say about RCA last week" is one call.
- **`compact` on `get_recent_messages`.** Media without a caption and
  messages without a word in them are left out and counted, a run of
  messages from one person folds into one line. About half the size.
- **`get_unanswered`.** Chats whose last word is the other side's and reads as
  an ask (a question mark, a request word, an unheard voice note), people
  first, oldest wait first, with the ask quoted. A link is not a question, an
  ask older than two weeks is abandoned rather than waiting, a business
  account is marked. Groups count only when the user was @-mentioned or
  replied to. The inbox skill uses it instead of guessing from `list_chats`.

- **`as_gif` on `send_media`.** An mp4 goes out looping, the way WhatsApp
  plays a GIF; a .gif file is turned into that mp4 first with ffmpeg on the
  machine running wazap. The draft preview says `[gif]`.

- **A catch-up names the senders in a busy group.** `get_recent_messages`
  fetches the metadata of the groups that spoke in the window, once each, so
  someone the address book does not know reads by the name the group carries
  instead of "unknown (lid …)".
- **A message filed under a lid keeps its sender after a restart.** The
  pairings WhatsApp's own lid table taught are written to the snapshot, and
  in a one-to-one chat the other side is the sender whatever id the key
  carries, so "unknown (lid …)" is gone from direct chats.
- **A photo or video sent inside an album, or in reply to a story, is a photo
  or video again** (`associatedChildMessage` is an envelope, now unwrapped like
  the others), and an encrypted edit notice reads as `[edited a message]`, a
  notice, instead of `[unsupported: …]`.
- **Animated stickers read as `[sticker]`, an album header as `[album · 4
  items]`** and is a notice, hidden from the catch-up like the other notices,
  since the photos follow as messages of their own.

### Changed

- `whatsapp.ts` gave up its store (`store.ts`) and the outgoing media helpers
  (`outgoing-media.ts`), 2.9k lines down to 2.5k. No behaviour changed.

### Fixed

- **Reactions vanished on restart and showed up as messages of their own.** A
  reaction now goes onto the message it answers the moment it arrives, live,
  from a history sync or back from disk, is written to the snapshot, and never
  appears as a "[reaction] 👍" line. A withdrawn reaction comes off. An older
  snapshot's loose reaction lines fold onto their targets on load.
- **A GIF reads as `[gif]`**, not `[video]`.
- **`search_contacts` listed a person twice**, once by number and once by lid.
  The lid entry now moves in with the phone entry as soon as the pairing is
  known, and the search never returns the same person under two ids.
- **A name learned earlier survived a later contact update that knew less.**
  Baileys sends a contact with unknown fields set to undefined; spread as they
  were, they erased the name. And a number is now named from what arrived
  under its lid, and the lid from what arrived under the number.
- **`wazap service restart` now records the version it started**, so `status` stops saying an older one runs.
- **`list_chats` showed some people twice.** WhatsApp files a contact under a
  `@lid` chat and a phone chat, and once the pairing is known both rows
  canonicalised to the same `chat_id`. The list now merges the aliases: the
  newer row keeps its flags, the unread count is the larger of the two.
- **`get_contact` on a number WhatsApp does not know hung for 60 s.** The
  about-text and profile-picture lookups never answered. They now give up
  after 8 s and the contact comes back from the store with both set to null.
- **`search_contacts` matches a number typed with the national leading zero**
  (`0734 404…` finds `40734404…`).
- **`get_recent_messages` listed the same conversation twice after a restart.**
  The history file was read before the snapshot that knows which number a
  lid belongs to, so a message that arrived under a lid was filed under the
  lid and under the phone. The snapshot now loads first, a ring left under a
  lid folds into the phone chat, and a pairing learned later folds the chat
  the moment it arrives, from a contact or from WhatsApp's own lid table.
- **A message from the other side showed as sent by you.** Baileys puts an
  empty `participant` on a direct message that arrives under a lid, and the
  empty string was taken as "absent", which handed the message to the
  linked account.

## 0.12.0
### Added

- **Outbound sends are a draft, then `confirm_send`.** `send_message`,
  `send_media`, `send_poll`, `send_location` and `forward_message` ask the
  session to resolve the recipient and return a `draft_id` plus a preview
  (`To: Ana (+40 722 …)` and the exact text). WhatsApp is reached only by
  `confirm_send`. A draft lasts 15 minutes, is one-shot, and lives on the
  session that owns the socket. Drafting does not spend the write rate
  limit; that bucket is taken when the session actually writes.
  `DRAFT_NOT_FOUND` and `DRAFT_EXPIRED` tell the agent to draft again.

### Fixed

- **`login` and `setup` print a leftover on the real screen.** A client-held
  lock used to fail inside the wizard alt buffer, so `close()` wiped
  `kill <pid>` and left `EXIT:1` on an empty terminal. They now refuse
  before the wizard opens, and `yieldSession` throws instead of
  `process.exit` so a later failure still lands on the main screen.
- **Unlinked `status` / greet no longer send you past setup.** Service,
  skills and transcribe still show as facts. The `→ run …` lines stay
  off until an account is linked, because setup is the next command.
- **The QR screen no longer tells you to start setup over, and no longer
  draws two countdowns.** After you already picked QR, the `--phone` hint
  is gone. The saved-path line is omitted when it would wrap. A QR taller
  than the terminal keeps the last rows, so the spinner is not painted
  twice.

- **A leftover server no longer hides the next step.** Bare `wazap` on an
  unlinked data dir used to stop at "a server is already running" and
  `login` told you to quit the client that launched it, without a command.
  Greet now still says `Next wazap setup` and names `kill <pid>`. A second
  `wazap` that finds a `not_linked` owner answering `/healthz` 503 becomes a
  bridge instead of claiming the first process is an older version.
- **A command with no arguments names its own usage.** `wazap connect`,
  `skills`, `service`, `transcribe`, `contacts` and a half-typed `config`
  used to dump you into `--help`. They now list the clients, verbs or
  settings they accept. An unknown command still points at `--help`.
- **Setup asks QR or pairing code before it draws a QR.** Ctrl+C then
  `wazap login --phone` abandoned the rest of setup. `--phone` / `--code`
  and `--yes` skip the question. The QR hint, if you still get one, is
  `wazap setup --phone` from setup and `wazap login --phone` from login.

- **`setup` through npx can still install the service** when a global `wazap`
  already exists. npx puts its cache first on PATH, so after `npm i -g` (or a
  previous global install) the running process still looked like the throwaway
  copy and `service install` refused. Setup now asks `npm prefix -g` for the
  bin, and prints the repair instead of crashing if nothing stable is there.
  The unit's script is the realpath of that global bin, not `import.meta.url`
  of the npx process, which would have pointed launchd at a cache npm clears.

### Changed

- **`setup` and `login` are one screen at a time at a terminal.** Each step is
  a black, centered frame: the ASCII logo ghosted at the top, the step number,
  the title, then the QR or the question. Waiting states (QR, pairing
  countdown, chat sync, model download) run an 80ms spinner on one line
  instead of a once-a-second redraw. Titles, hints and menus type on from the
  left, like a keyboard; the QR and the ASCII logo appear at once. Piped
  output, tests and `setup --agent` stay a log, so agents still parse
  `Step N of M`.

## 0.11.0
### Added

- **`setup` installs the binaries it needs, and restarts Claude Desktop for
  you.** Local transcription used to stop at "run `wazap transcribe download`
  once whisper-cpp and ffmpeg are installed" and `expose` at "tailscale is not
  installed". Both now offer one `brew install` for the whole missing set and
  carry on in the same run; Tailscale still needs `tailscale up`, which setup
  prints as the next step rather than running. The keep-running menu offers a
  public URL when Homebrew could install a tunnel, not only when one is already
  there. Connecting Claude Desktop offers to quit and reopen it, so the last
  manual step of a macOS setup is gone. `--yes` accepts the install and
  `--no-brew` declines it; the restart takes a person at the prompt or
  `--relaunch`, because an agent running setup from inside Claude Desktop
  would otherwise quit itself.
- **`link_account` pairs WhatsApp from inside the chat**, so linking no longer
  needs a terminal. The server is already running and idle when nothing is
  linked, so it pairs itself: the tool takes a phone number, returns an
  8-character code and the steps to type it into the phone, and `get_status`
  reports `linking` with that code until WhatsApp accepts it. It stays
  registered in read-only mode, because read-only is there to stop the agent
  messaging people, and relinking a dead session messages nobody. `ALREADY_LINKED`
  is the new error for calling it on a live session. The pairing socket and the
  CLI's `login --phone` now run the same code, in `src/pairing.ts`.
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
