# Wazap 0.15 beta

This is an opt-in beta for 5–10 early testers using their own WhatsApp accounts and their own Wazap installation. Start with read access. Allow 3–7 days of ordinary use before considering a stable release; completing the checks matters more than the calendar.

## Install

Supported Wazap hosts for this beta: **macOS and Linux**. Native Windows hosting is not validated: the full suite exposed POSIX permission and process-fixture incompatibilities. Windows CI checks packaging and MCP startup only. Windows AI clients may connect to a supported host over HTTPS; WSL2 and Docker Desktop remain additional usability checks. The MCPB beta advertises macOS/Linux only.

Requirements: Node 22.16 or newer, your phone with WhatsApp, and an MCP client. ChatGPT requires Developer mode availability and a Wazap host reachable through HTTPS. The host must remain awake and online. Wazap does not require an OpenAI API key for ChatGPT; optional API transcription is separate and can incur costs.

```bash
node --version
npm install -g wazap-mcp@0.15.0-beta.1
wazap --version
wazap setup
```

The version must be `0.15.0-beta.1`. Select your client; setup links or reuses your account and offers optional hosting and transcription. Later preserves existing transcription settings. For ChatGPT, use `wazap setup --client chatgpt` and follow the [connection guide](chatgpt.md). For a preview with no changes, add `--dry-run`.

The npm `beta` tag points to the current beta; use the exact version above for reproducible testing. Do not use `wazap update` to switch beta versions: install the next explicitly announced beta and restart its service. `latest` stays on the stable release.

A Claude Desktop MCPB bundle and an npm tarball are attached to the GitHub prerelease. Docker users can build the tagged source:

```bash
git clone --branch v0.15.0-beta.1 --depth 1 https://github.com/razvangirgiz/wazap.git
cd wazap
docker build -t wazap:0.15.0-beta.1 .
```

Follow the README's self-hosting instructions for persistent volumes and HTTPS. No public Docker registry image is required for this beta.

## Existing installation

Before upgrading, stop the Wazap process using your service manager or close the client that owns it. Copy the **entire** Wazap data directory to a separate, private backup while no Wazap process writes to it. Preserve the old version number and launch settings. A copy made while SQLite is writing is not a verified backup.

Install the exact beta. If Wazap runs as a service, use `wazap service install` from that installation; it restarts the service and retains its configured port. The first start imports the old JSONL history into SQLite, leaves the source files intact, and binds the archive to the linked account. An import error must be investigated; never delete history to make startup succeed. See [migration](consolidation.md) and [multiple accounts](multi-account.md).

## First-session checks

Use ordinary data you are comfortable sharing with your selected AI client. Messages and attachments are external content and may contain misleading instructions; the workflow guidance is not a guarantee against prompt injection.

1. Start a timer before setup. Record OS, Node version, Wazap version, client and the first step that needed help.
2. In the client, ask to list WhatsApp accounts and check the selected account's status. If the ChatGPT action list is empty after connecting, refresh the plugin in settings and start a new chat with Wazap selected.
3. Read three recent messages from one chosen conversation. Verify them against your phone. Do not mark them as read or send anything for this check.
4. Search for a distinctive phrase you know was received by this linked device. Check the conversation and date. Page backwards at least once and check for duplicates.
5. Ask what you missed recently and who may be waiting for a reply. Confirm that summaries cite the right account and that triage is presented as candidates.
6. Make at least 12 ordinary read/status/search calls over several turns. They should continue without `Too many sessions`.
7. Restart Wazap once and repeat a read and a search. The account should stay linked and the archive available.
8. If you use two accounts, add/link the second under its own name and repeat account-specific reads. OAuth must be renewed to authorize the additional account. Never share one data directory between different people's installations.
9. Check that a read-only connection cannot send. Do not enable writes merely to test the beta. Any intentional real sending requires a reviewed draft and the user's explicit confirmation.

For optional write testing, use synthetic data and an intercepted transport: do not run the [conversation evaluation](chatgpt-evaluation.md) write cases against real recipients.

## Known limits

- Archive coverage includes messages Wazap received; complete phone history is unknown. `partial` or an empty page after a timeout does not prove absence.
- This beta has automated multi-account and recovery tests plus a real ChatGPT connection/read check. The complete 30-case ChatGPT model evaluation has not been run.
- Media downloads live on the Wazap host. A local path is not a downloadable attachment in ChatGPT. WhatsApp may no longer have an attachment available.
- Baileys is an unofficial WhatsApp client. Wazap is not an official WhatsApp service and does not guarantee WhatsApp account availability.
- Mobile ChatGPT flows, every MCP client version and independent users' first-time phone pairing remain beta feedback areas. Automated cross-platform CI is a separate signal from usability on those clients.

## Report a problem

Open a [beta feedback issue](https://github.com/razvangirgiz/wazap/issues/new?title=%5BBeta%5D+&body=Wazap+version%3A%0ANode+version+%2F+OS+%2F+AI+client%3A%0AStep+and+setup+time%3A%0AExpected+result%3A%0AActual+result+and+redacted+error+code%3A%0ASteps+to+reproduce%3A%0A%0ARemove+credentials%2C+phone+numbers+and+private+messages+before+submitting.). Include the step, expected/actual result, client and versions, plus the error code. Share only redacted excerpts needed to reproduce the issue.

Never attach `.env`, `auth/`, `oauth.json`, `daemon.json`, a database, a data-directory backup, access tokens, QR/pairing codes, phone numbers or message contents. Do not paste complete status output or logs without checking them. No tool sends reports automatically.

## Roll back

Stop the beta first. Preserve its directory separately if you need messages received since the upgrade. Install the exact previously recorded version and point it at a **separate copy of the pre-upgrade backup**, using the old launch configuration. Do not point two versions at the same directory or replace your original backup.

Versions before the SQLite archive cannot read messages received only by the beta. Revoked OAuth grants need fresh consent. If account ownership, archive migration or uncertain sending errors appear, stop testing that operation and report it before retrying.

## Stable-release gate

Record anonymized outcomes for at least five independent testers: first-read success, elapsed setup time, steps needing help, OS/client and repeat-read/restart result. Multi-account beta users must also verify account selection. Resolve every data-loss, account-mixing, unauthorized-action or unrecoverable-setup defect; rerun its regression and the relevant user flow. Review the complete evaluation results before claiming model-level reliability. Passing automated tests alone does not promote the beta.
