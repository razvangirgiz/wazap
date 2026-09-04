/**
 * A catch-up with the chatter taken out. A day in a family group is half
 * "Da", "😘😘" and photos without a word; an agent reading it every morning
 * pays for every one. Compact keeps the messages that carry words, folds the
 * ones a person sent in a row into one line, and counts what it dropped so
 * nothing disappears without a trace.
 */
import type { MessageView, RecentConversation } from "./wa-types.js";

/** Messages from the same person this close together read as one. */
const RUN_GAP_MS = 5 * 60_000;

export interface CompactLine {
  timestamp: string;
  sender: string;
  from_me: boolean;
  text: string;
  message_ids: string[];
}

export interface CompactConversation {
  chat_id: string;
  chat_name: string;
  type: RecentConversation["type"];
  note?: string;
  lines: CompactLine[];
  /** What was left out: media without a caption, and messages with no letters or digits in them. */
  dropped: { media: number; wordless: number };
}

const HAS_WORDS = /[\p{L}\p{N}]/u;
/** A bare placeholder: media with nothing said about it. */
const BARE_MEDIA = /^\[(image|video|gif|sticker|audio|voice message[^\]]*|document[^\]]*)\]$/;

function keep(m: MessageView): "keep" | "media" | "wordless" {
  if (m.type === "system") return "wordless";
  if (BARE_MEDIA.test(m.text.trim())) return "media";
  if (m.text.includes("?")) return "keep";
  return HAS_WORDS.test(m.text.replace(/^\[[^\]]*\]\s*/, "")) ? "keep" : "wordless";
}

export function compactConversations(conversations: RecentConversation[]): CompactConversation[] {
  const out: CompactConversation[] = [];
  for (const c of conversations) {
    const lines: CompactLine[] = [];
    const dropped = { media: 0, wordless: 0 };
    for (const m of c.messages) {
      const verdict = keep(m);
      if (verdict !== "keep") {
        dropped[verdict]++;
        continue;
      }
      const last = lines[lines.length - 1];
      const at = Date.parse(m.timestamp);
      if (last && last.sender === m.sender.id && at - Date.parse(last.timestamp) <= RUN_GAP_MS) {
        last.text += ` · ${m.text}`;
        last.message_ids.push(m.message_id);
        continue;
      }
      lines.push({ timestamp: m.timestamp, sender: m.sender.id, from_me: m.from_me, text: m.text, message_ids: [m.message_id] });
      // The name rides on the line, once, for the renderer.
      (lines[lines.length - 1] as CompactLine & { name?: string }).name = m.from_me ? "me" : m.sender.name;
    }
    if (lines.length === 0 && dropped.media === 0 && dropped.wordless === 0) continue;
    out.push({ chat_id: c.chat_id, chat_name: c.chat_name, type: c.type, ...(c.note ? { note: c.note } : {}), lines, dropped });
  }
  return out;
}

export function renderCompact(conversations: CompactConversation[], hours: number): string {
  if (conversations.length === 0) return `No WhatsApp conversations in the last ${hours}h.`;
  const total = conversations.reduce((n, c) => n + c.lines.length, 0);
  const lines = [`# WhatsApp · last ${hours}h, compact (${conversations.length} chats, ${total} lines)`, ""];
  for (const c of conversations) {
    const left = [
      c.dropped.media > 0 ? `${c.dropped.media} media without a word` : null,
      c.dropped.wordless > 0 ? `${c.dropped.wordless} wordless` : null,
    ].filter(Boolean);
    lines.push(
      `## ${c.chat_name}${c.type === "group" ? " [group]" : ""}${c.note ? ` · ${c.note}` : ""} — \`${c.chat_id}\`${left.length ? ` (left out: ${left.join(", ")})` : ""}`,
    );
    for (const l of c.lines) {
      const stamp = l.timestamp.slice(5, 16).replace("T", " ");
      const name = (l as CompactLine & { name?: string }).name ?? (l.from_me ? "me" : l.sender);
      const count = l.message_ids.length > 1 ? ` (${l.message_ids.length} msgs)` : "";
      lines.push(`- [${stamp}] ${name}: ${l.text.length > 600 ? `${l.text.slice(0, 600)}…` : l.text}${count}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
