import type { WAMessage, WAMessageContent } from "baileys";
import { protoNumber } from "./messages.js";

/** undefined: ordinary message; 0: marked ephemeral but no safe deadline can be determined. */
export function messageExpiry(raw: WAMessage): number | undefined {
  try {
    let marked = false;
    let invalid = false;
    const durations: number[] = [];
    const seconds = (value: unknown): number | undefined => {
      if (value === undefined || value === null) return undefined;
      const n = protoNumber(value as Parameters<typeof protoNumber>[0]);
      if (n === 0) return undefined; // protobuf default, not an infinite-lived ephemeral exception
      if (n === undefined || !Number.isSafeInteger(n) || n < 0) { invalid = true; return undefined; }
      return n;
    };
    const duration = (value: unknown): void => {
      if (value !== undefined && value !== null && value !== 0) marked = true;
      const n = seconds(value);
      if (n !== undefined) durations.push(n);
    };
    duration(raw.ephemeralDuration);
    const explicitStart = seconds(raw.ephemeralStartTimestamp);
    if (explicitStart !== undefined || invalid) marked = true;
    let content: WAMessageContent | null | undefined = raw.message;
    for (let depth = 0; content; depth++) {
      if (depth >= 16) return 0;
      if (content.ephemeralMessage) marked = true;
      // Only the actual payload's context, never quotedMessage or a chat's
      // ephemeralSettingTimestamp / protocolMessage.ephemeralExpiration.
      for (const payload of Object.values(content)) {
        if (payload && typeof payload === "object" && "contextInfo" in payload) {
          duration((payload.contextInfo as { expiration?: unknown } | null)?.expiration);
        }
      }
      content = content.ephemeralMessage?.message ?? content.deviceSentMessage?.message ??
        content.documentWithCaptionMessage?.message ?? content.associatedChildMessage?.message ??
        content.editedMessage?.message ?? content.viewOnceMessage?.message ??
        content.viewOnceMessageV2?.message ?? content.viewOnceMessageV2Extension?.message;
    }
    if (!marked && !invalid) return undefined;
    const sent = seconds(raw.messageTimestamp);
    // Never extend retention using a later start/receipt timestamp. When both
    // are available, the earlier message-specific clock is the conservative bound.
    const starts = [explicitStart, sent].filter((n): n is number => n !== undefined);
    if (invalid || !durations.length || !starts.length) return 0;
    const deadline = (Math.min(...starts) + Math.min(...durations)) * 1000;
    return Number.isSafeInteger(deadline) && deadline > 0 ? deadline : 0;
  } catch {
    return 0; // Malformed ephemeral/protobuf metadata cannot buy indefinite retention.
  }
}
