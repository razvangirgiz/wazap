/** Small helpers more than one part of WhatsAppService (src/whatsapp.ts, src/service/) reaches for. */

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
