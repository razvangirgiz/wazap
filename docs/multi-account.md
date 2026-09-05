# Multiple personal accounts

Wazap 0.15.0 supports several of your own WhatsApp accounts through one MCP connection. This is a single-owner installation, not a service for unrelated users.

## Add and use an account

```sh
wazap accounts list
wazap accounts add --name Business
wazap login --account <account_id>
wazap status --account <account_id>
wazap accounts rename <account_id> --name Work
```

Use the ID printed by `accounts add`. When an existing account lives at the data-directory root, Wazap registers it as `default` without moving its files. Fresh profiles receive stable generated IDs. Names can change; IDs do not.

A running shared daemon handles phone-number pairing through its private bridge. Use `--phone +<number>` for non-interactive login, then enter the displayed code on the phone. Standalone login also supports QR. If sharing is disabled, stop the process holding the account before standalone login. Never run two owners against the same account directory.

In the agent, call `list_accounts`. With one profile, existing calls without `account_id` still work. With multiple profiles, specify the account on every account operation—even if only one is connected. The server does not maintain a global active account.

```json
{"name":"read_messages","arguments":{"account_id":"<id>","chat_id":"<chat-id>"}}
```

A draft includes the account name and ID. Show that account, the recipient and the exact content before confirmation. Pass the exact returned `draft_id` to `confirm_send`; it includes routing information that remains valid after rename or restart. It cannot be transferred to another account or client. Unknown sending outcomes still require reconciliation, never automatic resend.

## Combined search and triage

`search_messages`, `get_recent_messages` and `get_unanswered` accept `account_ids` or `all_accounts: true`, as alternatives to `account_id`. Other tools remain per account. A chat/contact ID filter requires one account; the `from: "me"` search filter can span accounts.

Every actionable result includes its account. The same group, contact or message ID may appear in two accounts; keep both results. No contact identities or conversations are merged between accounts.

Search returns `next_before`; recent messages return `next_cursor`. Pass the cursor unchanged with the same filters and account selection. Combined pages are ordered by timestamp, account ID and message ID; cursors also fix a per-archive ingestion watermark, excluding later backfills. Removed or expired content remains removed during pagination.

An unavailable account produces partial results and no continuation cursor. Retry that same page, or start a new query with fewer accounts. A disconnected account can still contribute its local archive. Phone-history coverage remains unknown; a missing result does not establish that a message never existed. Follow-up candidates remain heuristic suggestions.

## Permissions and configuration

OAuth first verifies the password, then shows account checkboxes and read/write scope. No account is preselected. Grants retain only the selected IDs through refresh; newly added accounts require new consent. Older OAuth tokens without account consent are refused for the managed multi-account server and need reconnection.

Static tokens can be restricted with comma-separated IDs:

```dotenv
WAZAP_READ_ACCOUNTS=default,a_<generated-id>
WAZAP_WRITE_ACCOUNTS=a_<generated-id>
```

`WAZAP_ACCOUNTS` restricts the process/client as a whole, including a private bridge client. Omission permits all configured profiles; an explicit empty value grants no profiles. Rights are intersected with process and per-account settings. Session account-set or permission changes require HTTP reinitialization. Existing OAuth grants never expand just because a new profile was added.

Transport, tokens and OAuth belong to `<data-dir>/.env`. Account settings belong to `<data-dir>/accounts/<account_id>/.env`; the legacy `default` profile retains the root location. Supported account overrides are read-only, history persistence, full-history sync, export directory and transcription settings. Account settings never mutate the process environment. Global read-only and persistence-off cannot be relaxed by an account.

Use `wazap config writes on|off` for the installation and `wazap config --account <id> writes on|off` for an individual profile. Root transport/permission changes require restarting the daemon. Profile settings and enabled state are noticed by the running manager; HTTP clients must reinitialize after a permission change. `--read-only` always wins.

HTTP media exports are restricted per selected account, and internal files anywhere under the installation root are blocked. Setting the export directory to the Wazap root cannot expose another account's credentials. Stdio and the private bridge retain local-file access.

## Disable, recover and inspect

```sh
wazap accounts disable <account_id>
wazap accounts enable <account_id>
wazap accounts list --json
wazap status --json
```

Disabling stops the account runtime and reopens its archive without a WhatsApp connection. It preserves credentials and local history. Logout is a separate explicit operation; permanent account-data deletion is not included.

Each enabled account reconnects independently. Exhausted reconnection attempts restart only that account. A corrupt registry fails closed. A failed archive stays visible in diagnostics and is not replaced with an empty archive. Repair the diagnosed cause before restarting; do not delete history to clear an error.

`accounts list`/`status` inspect profiles and persistence without opening WhatsApp connections. `get_status(account_id)` reports the live service state. `/healthz` exposes no names or phone numbers and fails when required persistence for an enabled account fails.

The combined message cache is capped at 10,000 entries (and 1,000 per chat), shared across account runtimes. Archives remain complete for messages Wazap received. SQLite workers are separate, but the daemon process is shared: a fatal process crash still affects all accounts. Three-account capacity testing is not a guarantee of unlimited scaling.

## Upgrade and rollback

Back up data before a real upgrade. During implementation all migration and restart tests use synthetic temporary directories.

The first managed startup atomically registers an existing root account without moving its credentials, JSONL backups or SQLite archive. Each new account has its own archive, outbox, notes and media. Pairing another phone number into an existing profile is refused; use a new profile. Registering one WhatsApp identity twice is refused.

To return to a previous release, stop 0.15.0 first. The old release can use a single compatible account directory; it does not understand `accounts.json` or manage several profiles. Do not run old and new releases on the same directory simultaneously. The earlier JSONL-to-SQLite rollback limitation still applies: versions predating the SQLite archive cannot read messages subsequently added there.

The HTTP server uses Express 5, whose dependency ranges admit the patched `qs` version. The npm package carries `npm-shrinkwrap.json` so consumers install the audited dependency versions; package-local `overrides` alone are not sufficient when Wazap is installed as a dependency.

No release is published by the implementation workflow. Live WhatsApp testing, real migration and a restricted pilot are separate release gates.
