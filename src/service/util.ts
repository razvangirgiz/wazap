/** Small helpers more than one part of WhatsAppService (src/whatsapp.ts, src/service/) reaches for. */

import { proto } from "baileys";

/** How long a profile photo lookup may take before the answer goes without it. */
export const PROFILE_LOOKUP_MS = 8_000;

/** Resolves to `null` when `work` rejects or is still pending after `ms`. */
export function orNullAfter<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), guard]).finally(() => clearTimeout(timer));
}

/** The HTTP-like status Baileys puts on a Boom error, when it put one. */
export function statusCodeOf(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

/** What the service writes: directories and files only the user can read. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** A result limit a caller left out or spelled wrong reads as the tools' own default. */
export function pageLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;
}

/** A group the account left: WhatsApp delivers it as read-only (see chatSummary). */
export function leftGroup(bytes: Uint8Array): boolean {
  return proto.Conversation.decode(bytes).readOnly === true;
}
