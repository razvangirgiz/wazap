/**
 * whisper.cpp on this machine. Free and private: the audio never leaves.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { WazapError } from "../errors.js";
import { modelPath, MODELS } from "./models.js";
import type { Provider, Readiness, TranscribeOpts, TranscribeSettings, Transcript } from "./types.js";

const run = promisify(execFile);

/**
 * Upstream renamed `main` to `whisper-cli` in Dec 2024 and Homebrew's
 * whisper-cpp formula installs that name; the others are older builds.
 */
const WHISPER_NAMES = ["whisper-cli", "whisper-cpp", "main"];
const TIMEOUT_MS = 5 * 60 * 1000;
/** whisper prints a screenful of ggml loader noise on every run. */
const MAX_OUTPUT = 8 * 1024 * 1024;

interface WhisperSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperSegment[];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH resolution without spawning anything: a probe must never be slow. */
export function which(name: string): string | null {
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  if (name.includes("/") || name.includes("\\") || isAbsolute(name)) {
    for (const suffix of suffixes) if (executable(name + suffix)) return name + suffix;
    return null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/** The override first, then the names whisper.cpp has shipped under. */
export function findWhisper(settings: TranscribeSettings): string | null {
  const names = settings.whisperBin === null ? WHISPER_NAMES : [settings.whisperBin, ...WHISPER_NAMES];
  for (const name of names) {
    const found = which(name);
    if (found !== null) return found;
  }
  return null;
}

function installFix(): string {
  if (process.platform === "darwin") return "Run `brew install whisper-cpp ffmpeg`";
  return "Build whisper.cpp from https://github.com/ggml-org/whisper.cpp#quick-start and install ffmpeg from your package manager";
}

function tail(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-4).join("\n").slice(-600);
}

async function spawnStep(what: string, bin: string, args: string[]): Promise<void> {
  try {
    await run(bin, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true });
  } catch (err) {
    const failure = err as { killed?: boolean; stderr?: string; message?: string };
    if (failure.killed === true) {
      throw new WazapError("TRANSCRIBE_FAILED", `${what} timed out after 5 minutes.`, "Try a shorter recording");
    }
    const detail = tail(failure.stderr ?? failure.message ?? "");
    throw new WazapError("TRANSCRIBE_FAILED", `${what} failed: ${detail}`);
  }
}

/**
 * 16 kHz mono 16-bit PCM is 32000 bytes a second after a 44-byte header, so the
 * converted file's size is the duration. No ffprobe, no second binary.
 */
function wavSeconds(wav: string): number | undefined {
  try {
    return Math.round((statSync(wav).size - 44) / 32000);
  } catch {
    return undefined;
  }
}

export const localProvider: Provider = {
  async transcribe(settings: TranscribeSettings, file: string, opts: TranscribeOpts): Promise<Transcript> {
    if (!existsSync(file)) throw new WazapError("FILE_NOT_FOUND", `No such file: ${file}`);
    const readiness = await localProvider.ready(settings);
    if (!readiness.ok) throw new WazapError("TRANSCRIBE_UNAVAILABLE", readiness.detail, readiness.fix);

    const whisper = findWhisper(settings)!;
    const ffmpeg = which("ffmpeg")!;
    const model = modelPath(settings.modelsDir, MODELS[settings.model]);
    const dir = await mkdtemp(join(tmpdir(), "wazap-transcribe-"));
    try {
      const wav = join(dir, "audio.wav");
      const out = join(dir, "out");
      const ffmpegArgs = ["-nostdin", "-loglevel", "error", "-y", "-i", file, "-ar", "16000", "-ac", "1", "-f", "wav", wav];
      await spawnStep("ffmpeg", ffmpeg, ffmpegArgs);
      const language = opts.language ?? settings.language;
      const whisperArgs = ["-m", model, "-f", wav, "-l", language, "-nt", "-np", "-oj", "-of", out];
      await spawnStep("whisper.cpp", whisper, whisperArgs);

      let parsed: WhisperJson;
      try {
        parsed = JSON.parse(await readFile(`${out}.json`, "utf8")) as WhisperJson;
      } catch (err) {
        throw new WazapError(
          "TRANSCRIBE_FAILED",
          `whisper.cpp wrote no readable JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const segments = parsed.transcription ?? [];
      const text = segments
        .map((segment) => segment.text ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const lastTo = segments[segments.length - 1]?.offsets?.to;
      const seconds = wavSeconds(wav) ?? (typeof lastTo === "number" ? Math.round(lastTo / 1000) : undefined);
      const detected = parsed.result?.language;
      return {
        text,
        ...(detected === undefined ? {} : { language: detected }),
        ...(seconds === undefined ? {} : { duration_seconds: seconds }),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  async ready(settings: TranscribeSettings): Promise<Readiness> {
    if (findWhisper(settings) === null) {
      return { ok: false, detail: `whisper.cpp not found (looked for ${WHISPER_NAMES.join(", ")})`, fix: installFix() };
    }
    if (which("ffmpeg") === null) return { ok: false, detail: "ffmpeg not found", fix: installFix() };
    const spec = MODELS[settings.model];
    const model = modelPath(settings.modelsDir, spec);
    if (!existsSync(model)) {
      return { ok: false, detail: `model ${spec.file} is not downloaded`, fix: "Run `wazap transcribe download`" };
    }
    return { ok: true, detail: `whisper.cpp with ${spec.file}` };
  },
};
