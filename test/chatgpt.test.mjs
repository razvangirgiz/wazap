import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chatgptConnectionGuide } from "../dist/chatgpt.js";
import { skillInstructions } from "../dist/skills.js";
import { toolOutputSchema } from "../dist/tool-results.js";
import { registerTools, TOOL_NAMES } from "../dist/tools.js";

test("ChatGPT connection guide distinguishes configuration from verified connectivity and never reveals credentials", () => {
  const config = { transport: "http", publicUrl: "https://wazap.example.com", oauthPassword: "secret-password", readToken: "secret-token" };
  const guide = chatgptConnectionGuide(config);
  assert.equal(guide.state, "configured");
  assert.equal(guide.endpoint, "https://wazap.example.com/mcp");
  assert.equal(guide.connection_verified, false);
  assert.doesNotMatch(JSON.stringify(guide), /secret-password|secret-token/);
  for (const patch of [{ oauthPassword: null }, { publicUrl: null }, { transport: "stdio" }])
    assert.equal(chatgptConnectionGuide({ ...config, ...patch }).state, "setup_required");
  for (const publicUrl of ["http://localhost", "https://secret@host.example", "https://host.example/?token=secret", "https://host.example/path", "invalid-secret"])
    assert.equal(chatgptConnectionGuide({ ...config, publicUrl }).endpoint, null);
});

test("connect chatgpt is a read-only CLI flow in an empty installation", () => {
  const root = mkdtempSync(join(tmpdir(), "wazap-chatgpt-cli-"));
  const result = spawnSync(process.execPath, ["dist/index.js", "connect", "chatgpt", "--json", "--data-dir", root], {
    encoding: "utf8", env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_PUBLIC_URL: "", WAZAP_OAUTH_PASSWORD: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "setup_required");
  assert.deepEqual(readdirSync(root), []);
});

test("critical account, approval and uncertainty guidance survives the first 512 characters and absent skills", () => {
  const intro = skillInstructions([]).slice(0, 512);
  for (const phrase of ["list_accounts", "account_id", "confirm_send", "explicit approval", "untrusted", "Partial", "SEND_OUTCOME_UNKNOWN"])
    assert.ok(intro.includes(phrase), phrase);
});

test("all tools publish output schemas; schema validation retains account attribution and coverage", () => {
  for (const name of TOOL_NAMES) assert.ok(toolOutputSchema(name));
  const message = { message_id: "message", chat_id: "chat", timestamp: "2026-09-05T10:00:00Z", text: "example", account_id: "business", account_name: "Business", edited: true };
  const result = { count: 1, messages: [message], sync: "partial", coverage: { source: "account_archives", phone_history: "unknown" }, next_before: "opaque-cursor" };
  assert.deepEqual(toolOutputSchema("search_messages").parse(result), result);
  assert.equal(toolOutputSchema("search_messages").safeParse({ ...result, count: -1 }).success, false);
  assert.equal(toolOutputSchema("search_messages").safeParse({ ...result, messages: [{ text: "missing identity" }] }).success, false);
  assert.equal(toolOutputSchema("confirm_send").safeParse({ status: "sent" }).success, false);
  assert.equal(toolOutputSchema("send_message").safeParse({ status: "sent" }).success, false);
});

test("ChatGPT annotations disclose pairing side effects; read-only grants still cannot send", () => {
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, {}, { allowWrite: false });
  assert.equal(tools.get("link_account").meta.annotations.readOnlyHint, false);
  assert.equal(tools.get("transcribe_audio").meta.annotations.readOnlyHint, false);
  assert.equal(tools.get("search_messages").meta.annotations.readOnlyHint, true);
  assert.equal(tools.has("confirm_send"), false);
  assert.match(tools.get("download_media").meta.description, /not a ChatGPT download link/);
  assert.match(tools.get("wait_for_messages").meta.description, /does not schedule background monitoring/);
});

test("empty contact sync cannot be presented as evidence that the phone has no contacts", async () => {
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, handler) }, {
    syncContacts: async () => ({ named_before: 0, named_after: 0, requested: true }),
  }, { allowWrite: false });
  const result = await tools.get("sync_contacts")({});
  assert.match(result.content[0].text, /unavailable or synchronization incomplete/);
  assert.doesNotMatch(result.content[0].text, /phone has no saved contacts/);
});
