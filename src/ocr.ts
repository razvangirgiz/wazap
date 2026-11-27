/**
 * Opt-in local OCR for image messages (WAZAP_OCR=local).
 * On macOS, prefers Apple's native Vision framework (VNRecognizeTextRequest)
 * compiled lazily once into `<dataDir>/bin/`, falling back transparently to
 * tesseract when Xcode Command Line Tools are absent or on an image format
 * Vision cannot decode. On other platforms, uses tesseract.
 *
 * Runs locally through the shared native helper slots with bounded CPU, memory
 * and time; nothing ever leaves the machine.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import { helperSlots, runNative } from "./native-run.js";
import { which } from "./transcribe/local.js";

/** Maximum OCR characters stored per image message. */
export const OCR_TEXT_MAX = 2_000;
/** Per-image timeout for OCR. */
const OCR_TIMEOUT_MS = 15_000;
/** Resident memory cap for one OCR invocation. */
const OCR_RSS_BYTES = 512 * 1024 * 1024;
/** Compilation timeout & memory cap for the one-time macOS Vision helper. */
const VISION_COMPILE_TIMEOUT_MS = 60_000;
const VISION_COMPILE_RSS_BYTES = 1024 * 1024 * 1024;
/** Minimum alphanumeric characters required to keep OCR output rather than treating an image as textless. */
const MIN_ALNUM_CHARS = 5;

export type OcrRunner = (imagePath: string, signal?: AbortSignal) => Promise<string>;

const FALLBACK_BINS = ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"];

const VISION_SWIFT = `import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count > 1 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  fputs("cannot decode image\\n", stderr)
  exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["ro-RO", "en-US"]
let handler = VNImageRequestHandler(cgImage: img, options: [:])
try handler.perform([req])
let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\\n"))
`;

const VISION_HASH = createHash("sha256").update(VISION_SWIFT).digest("hex").slice(0, 12);
const visionBinCache = new Map<string, Promise<string | null>>();

/** Resolves swiftc on macOS without spawning. */
export function swiftcBin(): string | null {
  if (process.platform !== "darwin") return null;
  return which("swiftc") ?? which("/usr/bin/swiftc");
}

/** Deterministic path of the compiled macOS Vision OCR helper inside `dataDir`. */
export function visionBinaryPath(dataDir: string): string {
  return join(dataDir, "bin", `wazap-vision-ocr-${VISION_HASH}`);
}

/**
 * Ensures the native macOS Vision OCR helper is compiled inside `<dataDir>/bin/`.
 * Returns null on non-macOS platforms or when swiftc is unavailable / fails to compile.
 */
export function visionBinary(dataDir?: string, signal?: AbortSignal): Promise<string | null> {
  if (process.platform !== "darwin" || dataDir === undefined) return Promise.resolve(null);
  const binPath = visionBinaryPath(dataDir);
  if (existsSync(binPath)) return Promise.resolve(binPath);
  let pending = visionBinCache.get(binPath);
  if (pending === undefined) {
    pending = (async () => {
      const compiler = swiftcBin();
      if (compiler === null) return null;
      const binDir = join(dataDir, "bin");
      const suffix = randomBytes(6).toString("hex");
      const srcPath = join(binDir, `wazap-vision-ocr-${suffix}.swift`);
      const tmpBin = join(binDir, `wazap-vision-ocr-${suffix}.tmp`);
      try {
        await mkdir(binDir, { recursive: true, mode: 0o700 });
        await writeFile(srcPath, VISION_SWIFT, { mode: 0o600 });
        await runNative(compiler, ["-O", srcPath, "-o", tmpBin], {
          timeoutMs: VISION_COMPILE_TIMEOUT_MS,
          maxRssBytes: VISION_COMPILE_RSS_BYTES,
          ...(signal === undefined ? {} : { signal }),
        });
        await chmod(tmpBin, 0o700);
        await rename(tmpBin, binPath);
        log(`ocr: compiled macOS Vision helper (${binPath})`);
        return binPath;
      } catch (err) {
        if (signal?.aborted !== true) {
          log(`ocr: macOS Vision helper compile failed (${err instanceof Error ? err.message : "error"}); falling back to tesseract`);
        }
        return null;
      } finally {
        await rm(srcPath, { force: true }).catch(() => {});
        await rm(tmpBin, { force: true }).catch(() => {});
      }
    })();
    visionBinCache.set(binPath, pending);
    // Allow retry if aborted during shutdown.
    void pending.then((result) => {
      if (result === null && signal?.aborted === true) visionBinCache.delete(binPath);
    });
  }
  return pending;
}

/** Resolves the tesseract executable without spawning; checks Homebrew/local prefixes too for launchd environments. */
export function tesseractBin(): string | null {
  const onPath = which("tesseract");
  if (onPath !== null) return onPath;
  for (const candidate of FALLBACK_BINS) {
    const found = which(candidate);
    if (found !== null) return found;
  }
  return null;
}

/** True when at least one local OCR backend (Apple Vision on macOS, or tesseract) is available. */
export function ocrAvailable(dataDir?: string): boolean {
  if (tesseractBin() !== null) return true;
  if (process.platform === "darwin" && dataDir !== undefined) {
    return existsSync(visionBinaryPath(dataDir)) || swiftcBin() !== null;
  }
  return false;
}

const langCache = new Map<string, Promise<string>>();

/** Picks `eng+ron` when both packs are installed, else `eng` (or whatever tesseract reports). Cached per binary. */
export function tesseractLanguages(bin: string): Promise<string> {
  let pending = langCache.get(bin);
  if (pending === undefined) {
    pending = runNative(bin, ["--list-langs"], { timeoutMs: 5_000, maxRssBytes: OCR_RSS_BYTES })
      .then(({ stdout, stderr }) => {
        const lines = `${stdout}\n${stderr}`
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^[a-z]{2,4}(?:_[A-Za-z0-9]+)?$/.test(line));
        const langs = new Set(lines);
        if (langs.has("eng") && langs.has("ron")) return "eng+ron";
        if (langs.has("eng")) return "eng";
        if (langs.has("ron")) return "ron";
        return lines[0] ?? "eng";
      })
      .catch(() => "eng");
    langCache.set(bin, pending);
  }
  return pending;
}

/**
 * Cleans raw OCR output: strips control characters, collapses spacing,
 * drops pure-symbol noise lines, and returns "" for textless photos.
 */
export function cleanOcrText(raw: string): string {
  const lines = raw
    .replace(/(?![\r\n\t])\p{Cc}/gu, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length >= 2 && /[\p{L}\p{N}]/u.test(line));
  const cleaned = lines.join("\n").trim();
  const alnum = (cleaned.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum < MIN_ALNUM_CHARS) return "";
  return cleaned.length <= OCR_TEXT_MAX ? cleaned : cleaned.slice(0, OCR_TEXT_MAX);
}

async function runTesseract(imagePath: string, signal?: AbortSignal): Promise<string> {
  const bin = tesseractBin();
  if (bin === null) throw new Error("tesseract not found");
  const langs = await tesseractLanguages(bin);
  const { stdout } = await helperSlots.run(
    () =>
      runNative(bin, [imagePath, "stdout", "-l", langs], {
        timeoutMs: OCR_TIMEOUT_MS,
        maxRssBytes: OCR_RSS_BYTES,
        ...(signal === undefined ? {} : { signal }),
      }),
    signal
  );
  return cleanOcrText(stdout);
}

/**
 * Runs local OCR on an image file on disk and returns cleaned text (or "" when
 * none). Prefers macOS Apple Vision when available and falls back to tesseract.
 */
export async function ocrFile(imagePath: string, signal?: AbortSignal, dataDir?: string): Promise<string> {
  const vision = await visionBinary(dataDir, signal);
  if (vision !== null) {
    try {
      const { stdout } = await helperSlots.run(
        () =>
          runNative(vision, [imagePath], {
            timeoutMs: OCR_TIMEOUT_MS,
            maxRssBytes: OCR_RSS_BYTES,
            ...(signal === undefined ? {} : { signal }),
          }),
        signal
      );
      return cleanOcrText(stdout);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      // Unsupported image format (e.g. animated WebP) — fall back to tesseract when installed.
      if (tesseractBin() !== null) return runTesseract(imagePath, signal);
      throw err;
    }
  }
  return runTesseract(imagePath, signal);
}

function extForMime(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "image/png") return ".png";
  if (base === "image/webp") return ".webp";
  if (base === "image/gif") return ".gif";
  if (base === "image/tiff") return ".tiff";
  return ".jpg";
}

/** Runs an OcrRunner over an in-memory image buffer via a private temporary file. */
export async function ocrBufferWith(
  buffer: Buffer,
  mime: string,
  runner: OcrRunner = ocrFile,
  signal?: AbortSignal
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wazap-ocr-"));
  const file = join(dir, `img${extForMime(mime)}`);
  try {
    await writeFile(file, buffer, { mode: 0o600 });
    return cleanOcrText(await runner(file, signal));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
