/** Shared streaming, size-bounded and SHA-256-verified model downloader. */
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { WazapError } from "./errors.js";
import { discardResponse } from "./http-response.js";
import { log } from "./logger.js";
import { withCode } from "./error-code.js";
import { acquireModelDownloadLock, type ModelDownloadLock } from "./model-download-lock.js";

export interface DownloadProgress {
  received: number;
  total: number;
}
export interface DownloadResult {
  path: string;
  bytes: number;
  resumed: boolean;
  alreadyPresent: boolean;
}
export interface DownloadOpts {
  url: string;
  path: string;
  sha256: string;
  bytes: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Network/write phase deadlines, also injectable for deterministic local tests. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /** The command that retries, for the fix text. */
  command?: string;
}

const TOTAL_MS = 30 * 60 * 1000;
const IDLE_MS = 30 * 1000;
/** A slow but steady link must finish: the idle deadline is what catches a stall. */
const SLOWEST_BYTES_PER_SECOND = 100 * 1024;

/** Thirty minutes, or as long as the model takes at 100 KiB/s: large-v3 gets about three hours. */
export function downloadDeadlineMs(bytes: number): number {
  return Math.max(TOTAL_MS, Math.ceil(bytes / SLOWEST_BYTES_PER_SECOND) * 1000);
}
const IO_CODES = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "EISDIR",
  "ENOTDIR",
  "EIO",
  "EMFILE",
  "ENFILE",
]);
type Failure = (message: string) => WazapError;

function failureFor(command: string): Failure {
  const fix = `Check the network and free disk space, then run \`${command}\` again`;
  return (message) => new WazapError("TRANSCRIBE_FAILED", message, fix);
}

async function sizeOf(path: string, failure: Failure): Promise<number | null> {
  try {
    const info = await stat(path);
    // Do not delete a directory or treat an unreadable path as an absent file.
    if (!info.isFile()) throw failure("Model download destination is not a regular file.");
    return info.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function digestOf(path: string, into: Hash, signal: AbortSignal): Promise<void> {
  for await (const chunk of createReadStream(path, { signal })) into.update(chunk as Uint8Array);
}

/** The range must run from the part's end to the model's last byte; an unknown total (`*`) is allowed, a wrong one is not. */
function validRange(response: Response, start: number, total: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
  return !!match && Number(match[1]) === start && Number(match[2]) === total - 1 && (match[3] === "*" || Number(match[3]) === total);
}

/**
 * Only a completed stream with the exact byte count and digest can be published.
 * Interrupted transfers keep a bounded prefix; invalid ranges, overflow and
 * verification mismatches discard it. CDN redirects intentionally remain enabled:
 * production URLs/digests come from curated model tables, not MCP arguments.
 */
export async function downloadFile(opts: DownloadOpts): Promise<DownloadResult> {
  const failure = failureFor(opts.command ?? "wazap transcribe download");
  const timeoutMs = opts.timeoutMs ?? downloadDeadlineMs(opts.bytes);
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_MS;
  if (
    !Number.isSafeInteger(opts.bytes) ||
    opts.bytes <= 0 ||
    !/^[\da-f]{64}$/i.test(opts.sha256) ||
    [timeoutMs, idleTimeoutMs].some((ms) => !Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647)
  ) {
    throw failure("Invalid model download size, digest or timeout.");
  }
  let part = `${opts.path}.part`;
  let lock: ModelDownloadLock | undefined;
  const expectedHash = opts.sha256.toLowerCase();
  const controller = new AbortController();
  const abort = () => controller.abort(); // Never propagate a caller's secret-bearing abort reason.
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  let timedOut = false;
  let totalTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let response: Response | undefined;
  let discardPart = false;
  const expire = () => {
    timedOut = true;
    controller.abort();
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, idleTimeoutMs);
  };
  const checkAbort = () => {
    if (controller.signal.aborted) throw failure(timedOut ? "Model download timed out." : "Model download cancelled.");
  };
  try {
    checkAbort();
    // Exclude other invocations before cache hashing, deletion, resume or HTTP.
    lock = await acquireModelDownloadLock(opts.path);
    checkAbort();
    const target = lock.path;
    part = `${target}.part`;
    const present = await sizeOf(target, failure);
    if (present === opts.bytes) {
      const hash = createHash("sha256");
      await digestOf(target, hash, controller.signal);
      checkAbort();
      if (hash.digest("hex") === expectedHash) {
        return { path: opts.path, bytes: present, resumed: false, alreadyPresent: true };
      }
    }
    checkAbort();
    if (present !== null) await rm(target, { force: true });

    let have = (await sizeOf(part, failure)) ?? 0;
    checkAbort();
    if (have >= opts.bytes) {
      await rm(part, { force: true });
      have = 0;
    }
    let resumed = have > 0;
    let hash = createHash("sha256");
    // Hash the prefix before opening an HTTP response, not while its body waits.
    if (resumed) await digestOf(part, hash, controller.signal);
    checkAbort();

    totalTimer = setTimeout(expire, timeoutMs);
    resetIdle();
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (resumed) headers.Range = `bytes=${have}-`;
    response = await fetch(opts.url, { headers, signal: controller.signal, redirect: "follow" });
    checkAbort();
    resetIdle();
    if (![200, 206].includes(response.status) || response.body === null) {
      discardPart = response.status === 416;
      throw failure(`Model download failed: HTTP ${response.status}.`);
    }
    if (response.status === 200 && resumed) {
      have = 0;
      resumed = false;
      hash = createHash("sha256");
    }
    if (response.status === 206 && !validRange(response, have, opts.bytes)) {
      discardPart = true;
      throw failure("Model download resumed at the wrong offset or returned an invalid range.");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw failure("Model download returned an unsupported content encoding.");
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > opts.bytes - have)
    ) {
      discardPart = true;
      throw failure("Model download response exceeds the expected size or declares an invalid length.");
    }

    let received = have;
    let reportedAt = 0;
    const report = (force: boolean) => {
      if (!opts.onProgress) return;
      const now = Date.now();
      if (!force && now - reportedAt < 100) return;
      reportedAt = now;
      opts.onProgress({ received, total: opts.bytes });
    };
    report(true);
    checkAbort();
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (chunk.byteLength > opts.bytes - received) {
          discardPart = true;
          callback(failure("Model download exceeded the expected size."));
          return;
        }
        try {
          received += chunk.byteLength;
          hash.update(chunk);
          if (chunk.byteLength > 0) resetIdle();
          report(false);
          callback(null, chunk);
        } catch (err) {
          callback(err instanceof Error ? err : failure("Model download progress callback failed."));
        }
      },
    });
    // pipeline owns errors/backpressure/close for all streams. A failed disk write
    // must not leave a drain waiter hanging or publish a partially written model.
    const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
    await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), limiter, out, {
      signal: controller.signal,
    });
    checkAbort();
    report(true);
    checkAbort();
    const digest = hash.digest("hex");
    if (received !== opts.bytes || digest !== expectedHash) {
      discardPart = true;
      throw failure(
        `Model download did not verify: got ${received} bytes and sha256 ${digest}, expected ${opts.bytes} bytes and sha256 ${expectedHash}.`
      );
    }
    await rename(part, target);
    return { path: opts.path, bytes: received, resumed, alreadyPresent: false };
  } catch (err) {
    if (discardPart) {
      try {
        await rm(part, { force: true });
      } catch {
        throw failure(
          "Could not remove the invalid partial model. Check the model directory permissions before retrying."
        );
      }
    }
    checkAbort();
    if (err instanceof WazapError) throw err;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    throw failure(
      code && IO_CODES.has(code)
        ? `Model download could not access or write its files (${code}).`
        : `Model download failed${withCode(err)}.`
    );
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", abort);
    if (response) await discardResponse(response);
    // A leftover claim must not turn a verified model into a failure, nor hide
    // the error already on its way out. The next run reports it with its path.
    await lock?.release().catch(() => log(`model download: could not remove ${lock!.path}.download-lock`));
  }
}
