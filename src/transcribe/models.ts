/**
 * The whisper.cpp model table and compatibility exports for the shared downloader.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WazapError } from "../errors.js";
import { downloadFile, type DownloadProgress, type DownloadResult } from "../model-download.js";
import type { ModelAlias } from "./types.js";

export { downloadFile, type DownloadOpts, type DownloadProgress, type DownloadResult } from "../model-download.js";

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
      `Pick one of: ${Object.keys(MODELS).join(", ")}`
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

export async function downloadModel(
  modelsDir: string,
  spec: ModelSpec,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
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
