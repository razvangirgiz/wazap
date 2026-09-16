// A server process that dies at a chosen moment: after it stored a message and
// its event, or while its POST is in flight (the receiver kills it). SIGKILL,
// so nothing is flushed or closed on the way out.
import { AccountDb } from "../../dist/db/index.js";
import { WebhookOutbox } from "../../dist/webhook-outbox.js";
import { WebhookSink } from "../../dist/webhook.js";

const { path, mode, url, secret, chat, key, at } = JSON.parse(process.argv[2]);
const db = AccountDb.open(path);

if (mode === "enqueue") {
  db.transaction(() => {
    const stored = db.messages.upsert({ chatJid: chat, keyId: key, fromMe: false, ts: at, type: "text", text: "before the crash" });
    db.events.enqueue({ kind: "message_received", lane: "chat:1", messageId: stored.id, payload: "{}", createdAt: Date.now() });
  });
  process.kill(process.pid, "SIGKILL");
}

if (mode === "post") {
  const sink = new WebhookSink({ WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: secret });
  const outbox = new WebhookOutbox({
    db: () => db,
    sink: () => sink,
    payload: (event, message) => ({ event: event.kind, message_id: message.sid, text: message.text }),
    awaitingTranscript: () => false,
  });
  outbox.kick();
  process.send?.("posting");
}
