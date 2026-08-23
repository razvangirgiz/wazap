/**
 * The whisper.cpp model table and a resumable, verified downloader.
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { WazapError } from "../errors.js";
import type { ModelAlias } from "./types.js";

export interface ModelSpec {
  alias: ModelAlias;
  file: string;
  bytes: number;
  sha256: string;
}

/**
 * Downloads go to the resolve endpoint, which the official
 * models/download-ggml-model.sh uses:
 * https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>
 * Upstream publishes only SHA-1, so these digests were read from the Hugging
 * Face LFS pointers at
 * https://huggingface.co/ggerganov/whisper.cpp/raw/main/<file>
 * Verified 2026-08-23. The CDN's ETag on the final 200 is a Xet content hash,
 * not the SHA-256, so it must never be used to verify a download.
 */
export const MODELS: Record<ModelAlias, ModelSpec> = {
  turbo: {
    alias: "turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 574041195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
  "large-v3": {
    alias: "large-v3",
    file: "ggml-large-v3-q5_0.bin",
    bytes: 1081140203,
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
  },
  medium: {
    alias: "medium",
    file: "ggml-medium-q5_0.bin",
    bytes: 539212467,
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  },
};

const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

export function modelSpec(name: string): ModelSpec {
  const spec = (MODELS as Record<string, ModelSpec | undefined>)[name];
  if (spec === undefined) {
    throw new WazapError(
      "INVALID_ID",
      `Unknown whisper model "${name}".`,
      `Pick one of: ${Object.keys(MODELS).join(", ")}`,
    );
  }
  return spec;
}

export function modelUrl(spec: ModelSpec): string {
  return BASE_URL + spec.file;
}

export function modelPath(modelsDir: string, spec: ModelSpec): string {
  return join(modelsDir, spec.file);
}

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
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** Where a 206 body begins, from content-range. NaN when the server is lying. */
function rangeStart(response: Response): number {
  const header = response.headers.get("content-range");
  if (header === null) return Number.NaN;
  const match = /^bytes\s+(\d+)-/.exec(header);
  return match === null ? Number.NaN : Number(match[1]);
}

async function digestOf(path: string, into: Hash): Promise<void> {
  const stream = createReadStream(path);
  for await (const chunk of stream) into.update(chunk as Uint8Array);
}

/**
 * Streams `url` into `<path>.part`, and renames it onto `path` only once the
 * digest matches, so an interrupted download can never be mistaken for a model.
 */
export async function downloadFile(opts: DownloadOpts): Promise<DownloadResult> {
  const part = `${opts.path}.part`;

  const present = await sizeOf(opts.path);
  if (present === opts.bytes) {
    const hash = createHash("sha256");
    await digestOf(opts.path, hash);
    if (hash.digest("hex") === opts.sha256) {
      return { path: opts.path, bytes: present, resumed: false, alreadyPresent: true };
    }
  }
  if (present !== null) await rm(opts.path, { force: true });

  let have = (await sizeOf(part)) ?? 0;
  // A part at or past the full size can only be junk, and asking to resume from
  // it would earn a 416 on every retry instead of converging.
  if (have >= opts.bytes) {
    await rm(part, { force: true });
    have = 0;
  }
  let resumed = have > 0;

  const headers: Record<string, string> = {};
  if (resumed) headers.Range = `bytes=${have}-`;
  const response = await fetch(opts.url, { headers, signal: opts.signal, redirect: "follow" });
  if (!response.ok || response.body === null) {
    // 416 means the part cannot be resumed from, so it goes now; any other
    // failure is likely transient and the bytes on disk are still worth keeping.
    if (response.status === 416) await rm(part, { force: true });
    throw new WazapError(
      "TRANSCRIBE_FAILED",
      `Model download failed: HTTP ${response.status} ${response.statusText}`.trim(),
      "Check the network and run `wazap transcribe download` again",
    );
  }

  // A server that ignores Range answers 200 with the whole file, so what is on
  // disk is not a prefix of what is arriving and the resume has to be dropped.
  if (resumed && response.status !== 206) {
    have = 0;
    resumed = false;
  }

  // A 206 that starts somewhere other than where the part ends would splice a
  // gap into the file. Dropping the part costs one retry instead of a bad model.
  if (resumed && rangeStart(response) !== have) {
    await rm(part, { force: true });
    throw new WazapError(
      "TRANSCRIBE_FAILED",
      `Model download resumed at the wrong offset: ${response.headers.get("content-range") ?? "no content-range"}.`,
      "Run `wazap transcribe download` again",
    );
  }

  const hash = createHash("sha256");
  if (resumed) await digestOf(part, hash);

  const total = opts.bytes;
  let received = have;
  let reportedAt = 0;
  const report = (force: boolean): void => {
    if (opts.onProgress === undefined) return;
    const now = Date.now();
    if (!force && now - reportedAt < 100) return;
    reportedAt = now;
    opts.onProgress({ received, total });
  };

  const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
  try {
    report(true);
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
      report(false);
    }
  } finally {
    out.end();
    await finished(out).catch(() => {});
  }
  report(true);

  const digest = hash.digest("hex");
  if (received !== opts.bytes || digest !== opts.sha256) {
    await rm(part, { force: true });
    const problem =
      received === opts.bytes
        ? `sha256 ${digest}, expected ${opts.sha256}`
        : `${received} bytes and sha256 ${digest}, expected ${opts.bytes} bytes and sha256 ${opts.sha256}`;
    throw new WazapError(
      "TRANSCRIBE_FAILED",
      `Model download did not verify: got ${problem}.`,
      "Run `wazap transcribe download` again",
    );
  }

  await rename(part, opts.path);
  return { path: opts.path, bytes: received, resumed, alreadyPresent: false };
}

export async function downloadModel(
  modelsDir: string,
  spec: ModelSpec,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  await mkdir(modelsDir, { recursive: true });
  return downloadFile({
    url: modelUrl(spec),
    path: modelPath(modelsDir, spec),
    sha256: spec.sha256,
    bytes: spec.bytes,
    onProgress,
    signal,
  });
}
