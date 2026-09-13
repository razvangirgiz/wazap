/**
 * The embedding model table. Same shape as the whisper table: alias, file,
 * size and digest, so a download verifies against a pinned sha256 rather than
 * trusting whatever the network returned.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WazapError } from "../errors.js";
import {
  downloadFile,
  type DownloadProgress,
  type DownloadResult,
} from "../transcribe/index.js";
import type { EmbedModelAlias } from "./types.js";

export interface EmbedModelSpec {
  alias: EmbedModelAlias;
  file: string;
  bytes: number;
  sha256: string;
  /** Vector length this model emits; a mismatch against the index forces a rebuild. */
  dims: number;
  url: string;
  /**
   * The task prefixes the model was trained with, prepended at embed time.
   * Queries and documents live on different sides of a retrieval pair — the
   * prefix is what tells the model which side a text is on.
   */
  prompts: { query: string; document: string };
  /**
   * Cosine floor a recall hit must clear when WAZAP_RECALL_MIN_SIMILARITY is
   * unset. Each model's prompted space prices similarity differently — a score
   * that means "real match" for one is noise for another — so the floor
   * travels with the spec. `floorCalibrated` is false while the value is a
   * placeholder rather than a measurement on a real index; doctor says so.
   */
  defaultMinSimilarity: number;
  floorCalibrated: boolean;
}

/**
 * Digests read from the Hugging Face LFS pointers at
 * https://huggingface.co/<repo>/raw/main/<file>, then confirmed against a
 * real download. Verified 2026-09-13.
 * embeddinggemma needs llama.cpp with gemma-embedding support (b6800+; Homebrew
 * 0.4.0 runs it); e5-base is the safe fallback for an older llama.cpp.
 */
export const EMBED_MODELS: Record<EmbedModelAlias, EmbedModelSpec> = {
  "embeddinggemma-300m": {
    alias: "embeddinggemma-300m",
    file: "embeddinggemma-300M-Q8_0.gguf",
    bytes: 333590944,
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    dims: 768,
    url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
    // EmbeddingGemma's own retrieval task, from its model card.
    prompts: { query: "task: search result | query: ", document: "title: none | text: " },
    // Measured on a real index under those prompts: noise tops out ~0.31,
    // real paraphrases start ~0.35.
    defaultMinSimilarity: 0.35,
    floorCalibrated: true,
  },
  "e5-base-multilingual": {
    alias: "e5-base-multilingual",
    file: "multilingual-e5-base-q8_0.gguf",
    bytes: 303138624,
    sha256: "548c31b068947aa26b86c8bbfc1f2fabe5233f6d0e1241319832b20a01e5968a",
    dims: 768,
    url: "https://huggingface.co/dinab/multilingual-e5-base-Q8_0-GGUF/resolve/main/multilingual-e5-base-q8_0.gguf",
    // e5's documented asymmetric prefixes.
    prompts: { query: "query: ", document: "passage: " },
    // UNCALIBRATED — a placeholder, not a measurement. e5's contrastive
    // training compresses prompted cosines into a much higher band than
    // gemma's: unrelated pairs commonly read ~0.6-0.75 where real matches
    // start ~0.8, so gemma's 0.35 would pass noise as answers. 0.7 errs
    // high on purpose: a dropped real hit answers "nothing found", a false
    // hit is a wrong memory an agent will repeat. Re-measure on a real
    // index before flipping floorCalibrated.
    defaultMinSimilarity: 0.7,
    floorCalibrated: false,
  },
};

export function embedModelSpec(name: string): EmbedModelSpec {
  const spec = (EMBED_MODELS as Record<string, EmbedModelSpec | undefined>)[name];
  if (spec === undefined) {
    throw new WazapError(
      "INVALID_ID",
      `Unknown embedding model "${name}".`,
      `Pick one of: ${Object.keys(EMBED_MODELS).join(", ")}`
    );
  }
  return spec;
}

export function embedModelPath(modelsDir: string, spec: EmbedModelSpec): string {
  return join(modelsDir, spec.file);
}

/**
 * The shared verified downloader, pointed at this table's URL. Its errors are
 * transcribe-flavoured, so they are re-coded here: the fix must name the
 * command the user actually ran.
 */
export async function downloadEmbed(
  modelsDir: string,
  spec: EmbedModelSpec,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  await mkdir(modelsDir, { recursive: true });
  try {
    return await downloadFile({
      url: spec.url,
      path: embedModelPath(modelsDir, spec),
      sha256: spec.sha256,
      bytes: spec.bytes,
      onProgress,
      signal,
    });
  } catch (err) {
    if (err instanceof WazapError) {
      throw new WazapError("RECALL_FAILED", err.message, "Run `wazap embed download` again");
    }
    throw err;
  }
}
