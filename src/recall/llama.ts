/**
 * What wazap knows about llama.cpp itself: the release it installs when there
 * is no Homebrew (pinned by tag and sha256, like the model table), and the
 * build number an installed llama-server reports, which decides whether it can
 * run embeddinggemma at all.
 */
import { spawnSync } from "node:child_process";

/** embeddinggemma needs gemma-embedding support, which landed in llama.cpp b6800. */
export const GEMMA_MIN_LLAMA_BUILD = 6800;

export interface LlamaAsset {
  /** The release file, as GitHub names it. */
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface LlamaPin {
  tag: string;
  build: number;
  /** The directory the archive unpacks to; llama-server sits directly inside it. */
  root: string;
  /** Keyed `${process.platform}-${process.arch}`. */
  assets: Partial<Record<string, LlamaAsset>>;
}

const RELEASES = "https://github.com/ggml-org/llama.cpp/releases/download";

function asset(tag: string, name: string, bytes: number, sha256: string): LlamaAsset {
  const file = `llama-${tag}-bin-${name}.tar.gz`;
  return { file, url: `${RELEASES}/${tag}/${file}`, bytes, sha256 };
}

/**
 * The CPU builds of one llama.cpp release. Digests taken from a download of
 * each file and confirmed by running its llama-server --version (build 11516)
 * on 2026-10-09. The binaries carry RUNPATH $ORIGIN, so the shared libraries
 * beside them load without LD_LIBRARY_PATH as long as the binary is run from
 * where it was unpacked.
 */
export const LLAMA_PIN: LlamaPin = {
  tag: "b11516",
  build: 11516,
  root: "llama-b11516",
  assets: {
    "linux-x64": asset("b11516", "ubuntu-x64", 17793290, "8fd844c411fd56475215238a7a12e6510420dbfd963c8d76f84663dafb6557c8"),
    "linux-arm64": asset("b11516", "ubuntu-arm64", 13790094, "39a3d8fb891ff7cf69d23c192e59335a1c08a22874ba2d42b864dcb1cc125e41"),
    "darwin-arm64": asset("b11516", "macos-arm64", 12047327, "e7e5e5107ae9a26fa79b64d6b351b961b38cfb575e21a989d77195c18fe15c33"),
  },
};

/** The pinned build for this machine, or null where llama.cpp publishes none wazap pins. */
export function llamaAssetFor(platform: string = process.platform, arch: string = process.arch): LlamaAsset | null {
  return LLAMA_PIN.assets[`${platform}-${arch}`] ?? null;
}

/**
 * The build number in `llama-server --version` output: the current
 * "version: 0.6.0-dev (build 11516, commit …)" and the older
 * "version: 6800 (abc1234)" spellings both.
 */
export function llamaBuildOf(output: string): number | null {
  const current = /\(build (\d+)\b/.exec(output);
  if (current) return Number(current[1]);
  const older = /version:\s*(\d+)\s*\(/.exec(output);
  return older ? Number(older[1]) : null;
}

/** The build an installed llama-server reports, or null when it does not say or does not run. */
export function llamaBuild(bin: string): number | null {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (result.error !== undefined) return null;
  return llamaBuildOf(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

/** The repair line for a missing llama-server, by platform. */
export function llamaInstallFix(platform: string = process.platform, arch: string = process.arch): string {
  const pinned = llamaAssetFor(platform, arch) !== null;
  if (platform === "darwin") {
    return pinned
      ? "Run `brew install llama.cpp`, or `wazap embed download --yes` to fetch the pinned llama.cpp build into the data dir"
      : "Run `brew install llama.cpp`";
  }
  if (pinned) return "Run `wazap embed download --yes`: it fetches the pinned llama.cpp build into the data dir";
  return "Build llama.cpp from https://github.com/ggml-org/llama.cpp and put llama-server on PATH, or set WAZAP_EMBED_BIN to it";
}
