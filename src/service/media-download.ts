/**
 * One media download into memory, as WhatsAppService.mediaBuffer does it:
 * inside the process's download budget (src/media-budget.ts), stopped when
 * WhatsApp's CDN goes quiet or takes too long, refused past the in-memory
 * cap, and checked against deletion as it lands. Split out of
 * src/whatsapp.ts so it can be tested with a stream of its own.
 */
import type { Readable } from "node:stream";
import { WazapError } from "../errors.js";
import { downloadBudget as processBudget, UNKNOWN_SIZE_RESERVE, type DownloadBudget } from "../media-budget.js";

export interface DownloadSource {
  /** The decrypted media as a stream (Baileys' downloadMediaMessage). */
  open(): Promise<Readable>;
  /** Throws when the message is gone (deleted, expired, cleared): checked per chunk. */
  stillThere(): void;
}

/** Why a download was stopped by its own clock. */
class Stalled extends Error {
  constructor(readonly why: "idle" | "total") {
    super(why);
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / 1_000_000)} MB`;
}

/** The size refusal, before a byte is fetched or once the stream outgrows the cap. */
export function tooLarge(messageId: string, cap: number, size?: number): WazapError {
  return new WazapError(
    "FILE_TOO_LARGE",
    `${size === undefined ? `The media of ${messageId} is over ${megabytes(cap)}` : `The media of ${messageId} is ${megabytes(size)}`}; ` +
      `wazap holds a download in memory and takes at most ${megabytes(cap)}, so this one cannot be fetched.`,
    "Tell the user it is too large to open here; they can open it on the phone"
  );
}

/**
 * The media's bytes. `declared` (the envelope's size) is reserved in the
 * budget and, when it is under the cap, allocated once so the download is
 * not held twice while it is concatenated.
 */
export async function downloadToMemory(
  messageId: string,
  source: DownloadSource,
  { declared, cap, budget = processBudget }: { declared?: number; cap: number; budget?: DownloadBudget }
): Promise<Buffer> {
  if (declared !== undefined && declared > cap) throw tooLarge(messageId, cap, declared);
  const release = await budget.acquire(declared ?? UNKNOWN_SIZE_RESERVE);
  const { idleMs, totalMs } = budget.limits;
  let stream: Readable | null = null;
  let stalled: Stalled | null = null;
  let fail: (err: Stalled) => void = () => {};
  const clock = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  clock.catch(() => {});
  const stop = (why: "idle" | "total"): void => {
    stalled ??= new Stalled(why);
    fail(stalled);
    stream?.destroy(stalled);
  };
  const total = setTimeout(() => stop("total"), totalMs);
  let idle = setTimeout(() => stop("idle"), idleMs);
  try {
    // The CDN may not answer at all: the clocks run from before the request, and a stream that
    // arrives after they ran out is closed unread.
    const opened = source.open();
    opened.then((late) => (stalled !== null ? late.destroy() : undefined)).catch(() => {});
    stream = await Promise.race([opened, clock]);
    let out: Buffer | null = declared !== undefined && declared > 0 ? Buffer.allocUnsafe(declared) : null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleMs);
      source.stillThere();
      const piece = chunk as Buffer;
      if (bytes + piece.length > cap) {
        stream.destroy();
        throw tooLarge(messageId, cap);
      }
      if (out !== null && bytes + piece.length <= out.length) piece.copy(out, bytes);
      else {
        // More than the envelope said: from here on, chunks are kept and joined at the end.
        if (out !== null) {
          chunks.push(out.subarray(0, bytes));
          out = null;
        }
        chunks.push(piece);
      }
      bytes += piece.length;
    }
    return out !== null ? out.subarray(0, bytes) : Buffer.concat(chunks, bytes);
  } catch (err) {
    if (err instanceof Stalled || stalled !== null) {
      const why = (stalled ?? (err as Stalled)).why;
      throw new WazapError(
        "TIMEOUT",
        why === "idle"
          ? `The download of ${messageId} stalled: WhatsApp sent nothing for ${idleMs / 1000} s.`
          : `The download of ${messageId} took over ${totalMs / 1000} s and was stopped.`,
        "Retry once; if it stalls again, check the connection with get_status"
      );
    }
    throw err;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    release();
  }
}
