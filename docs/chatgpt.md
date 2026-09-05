# Wazap in ChatGPT

Wazap uses the same account permissions and tools in ChatGPT and other MCP clients. No custom UI or OpenAI API key is required by Wazap for this integration. ChatGPT availability depends on your account and workspace policy.

## Connect

Start with `wazap setup --client chatgpt` on the Wazap host. The wizard reuses your linked account, lets you choose among multiple accounts, and offers three hosting choices: set up HTTPS here, use an HTTPS origin you manage, or finish later. Publishing a tunnel requires choosing that option. A background service needs a stable installation. `--dry-run` previews the process without changing anything, even for an unlinked account.

If needed, setup creates a sign-in password and displays it in the terminal for your password manager. After configuring HTTPS, it verifies discovery and the MCP sign-in challenge. It also checks the selected account through the running service; a service version mismatch remains visible. Re-run the same installation's setup with `--service` when you intend to update that service. An existing service port is retained unless you explicitly choose another port.

A successful endpoint check does not prove ChatGPT is connected. Finish consent and a first read below. Choosing Later preserves your account and transcription settings; rerun setup to resume.

Run `wazap connect chatgpt --data-dir <installation-directory>`. Add `--json` for structured guidance. The command reads configuration and prints next steps; it does not open a tunnel, register a connection, modify client files or verify connectivity. `configured` means the required settings exist, not that ChatGPT is connected.

For the public HTTPS route, configure the installation `.env` with `WAZAP_TRANSPORT=http`, `WAZAP_PUBLIC_URL=https://your-host.example` and a strong unique `WAZAP_OAUTH_PASSWORD`. Start or restart the service and provide HTTPS routing to `/mcp`. Use the root installation directory, not an individual account directory. Keep the host and service running.

Follow the [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt): enable Developer mode if available, add the MCP connection in ChatGPT Plugins, and enter the HTTPS MCP URL. For private development, Secure MCP Tunnel is an alternative with its own setup. This release does not provision that tunnel automatically.

Authenticate on Wazap's OAuth page, select the accounts to authorize and begin with read access. Do not paste your password or bearer tokens into chat. Start a new conversation, enable the connection and ask “List my WhatsApp accounts.” Successful account retrieval is the first end-to-end check. If the plugin is connected but its action list is empty, use Refresh in its ChatGPT settings, then start a new conversation with Wazap explicitly selected. The current Romanian interface uses Pluginuri → Personale → Creează o aplicație; Developer mode is under Securitate și autentificare.

Reauthorize if your grant is revoked or if you need additional accounts or write access. If Developer mode is unavailable, check workspace policy; changing Wazap settings cannot enable a ChatGPT feature your account does not have.

## Use

- “Ce am ratat pe WhatsApp Business în ultimele 24 de ore?” — bounded catch-up with the source account visible.
- “Caută «contract» în ambele conturi.” — cross-account literal search; results retain separate identities.
- “Cine pare să aștepte un răspuns pe Personal?” — heuristic candidates, with context checked before drawing conclusions.
- “Pregătește un răspuns către Ana de pe Business.” — a draft only. Review the account, recipient and exact content before confirming.

The agent should resolve account names through `list_accounts`, preserve account IDs with message IDs, and ask when a recipient or account is ambiguous. Cursors continue the same query; empty or partial results are not proof that a message never existed. A new conversation must not inherit an assumed global sending account.

Downloads are saved on the Wazap host. Small supported images may appear inline; a server-local path is not a downloadable ChatGPT attachment. A secure browser download service and custom message cards are outside this change. `wait_for_messages` is an active wait during a conversation, not persistent background monitoring.

## Evaluate

Use [the ChatGPT evaluation set](chatgpt-evaluation.md) with synthetic accounts and messages before using personal data. Record the actual selected tools, arguments, answer and approvals. Automated server tests verify contracts and authorization, but do not measure ChatGPT's tool selection.

OpenAI recommends [tool metadata evaluation](https://developers.openai.com/plugins/guides/optimize-metadata) and [output schemas and concise server instructions](https://developers.openai.com/plugins/build/mcp-server). Wazap publishes an output schema for every tool and puts account selection, approval and uncertainty guidance in the first 512 characters of server instructions.
