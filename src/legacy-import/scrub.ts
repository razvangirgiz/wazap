/**
 * The protobuf half of "a retraction scrubs its quotes": AccountDb stores
 * bytes and cannot parse them, so whoever opens it hands over this function.
 * A reply carries a full copy of the message it quotes in its contextInfo;
 * when that message is deleted, the copy goes too, wherever in the payload's
 * wrappers the contextInfo sits.
 */
import { proto } from "baileys";
import { parseSid, type ScrubQuote } from "../db/index.js";

type Node = Record<string, unknown>;

/** Removes every embedded copy of the quoted message `quotedSid` names; null when the bytes do not decode. */
export const scrubQuote: ScrubQuote = (raw, quotedSid) => {
  const keyId = parseSid(quotedSid)?.keyId;
  if (keyId === undefined) return raw;
  let message: proto.WebMessageInfo;
  try {
    message = proto.WebMessageInfo.decode(raw);
  } catch {
    return null;
  }
  let changed = false;
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 32 || seen.has(value) || ArrayBuffer.isView(value)) return;
    seen.add(value);
    const node = value as Node;
    const context = node.contextInfo as { stanzaId?: unknown; quotedMessage?: unknown } | null | undefined;
    if (context && context.stanzaId === keyId && context.quotedMessage != null) {
      context.quotedMessage = null;
      changed = true;
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  };
  walk(message.message, 0);
  return changed ? proto.WebMessageInfo.encode(message).finish() : raw;
};
