import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WazapError } from "./errors.js";
export const MEDIA_MAX = 100 * 1024 * 1024;
function denied(message: string): never {
  throw new WazapError("MEDIA_ACCESS_DENIED", message);
}
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export async function readAllowedFile(path: string, policy?: { exportDir?: string; dataDir: string }): Promise<Buffer> {
  if (!isAbsolute(path)) denied("Use an absolute media path.");
  const actual = await realpath(path).catch(() => {
    throw new WazapError("FILE_NOT_FOUND", `No file at ${path}`);
  });
  if (policy) {
    if (!policy.exportDir) denied("Remote files require WAZAP_EXPORT_DIR.");
    const root = await realpath(policy.exportDir);
    if (!within(root, actual)) denied("This file is outside WAZAP_EXPORT_DIR.");
    const data = await realpath(policy.dataDir).catch(() => resolve(policy.dataDir));
    if (within(data, actual)) denied("Wazap internal files cannot be exported.");
  }
  const file = await open(actual, "r");
  try {
    const stats = await file.stat();
    if (policy && stats.nlink > 1) denied("Export a separate copy; hard-linked internal files are not allowed.");
    const verified = await realpath(path);
    const check = await open(verified, "r");
    try {
      const again = await check.stat();
      if (actual !== verified || stats.ino !== again.ino || stats.dev !== again.dev)
        denied("The media file changed while opening it.");
    } finally {
      await check.close();
    }
    if (!stats.isFile()) denied("Media must be a regular file.");
    if (stats.size > MEDIA_MAX) throw new WazapError("FILE_TOO_LARGE", "Media exceeds 100 MiB.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of file.createReadStream({ autoClose: false })) {
      size += part.length;
      if (size > MEDIA_MAX) throw new WazapError("FILE_TOO_LARGE", "Media exceeds 100 MiB.");
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    const a = p[0]!,
      b = p[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return /^2[0-9a-f]{3}:/.test(a) && !a.startsWith("2001:") && !a.startsWith("2002:");
  }
  return false;
}
export interface MediaNetwork {
  resolve: typeof lookup;
  request: typeof httpRequest;
  requestTls: typeof httpsRequest;
  timeoutMs: number;
  maxBytes: number;
}
const network: MediaNetwork = {
  resolve: lookup,
  request: httpRequest,
  requestTls: httpsRequest,
  timeoutMs: 30_000,
  maxBytes: MEDIA_MAX,
};
/** Dependency injection is only a test seam; callers cannot set it through an MCP tool. */
export async function publicMedia(
  urlText: string,
  io: MediaNetwork = network,
): Promise<{ buffer: Buffer; mime: string | null; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), io.timeoutMs);
  try {
    let url = new URL(urlText);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        denied("Use a public HTTP(S) URL without credentials.");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([
            io.resolve(host, { all: true }),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(Error("Media download timed out"));
              else
                controller.signal.addEventListener("abort", () => reject(Error("Media download timed out")), {
                  once: true,
                });
            }),
          ]);
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        denied("Media URL resolves to a non-public address.");
      const chosen = addresses[0]!;
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = (url.protocol === "https:" ? io.requestTls : io.request)(
          url,
          {
            signal: controller.signal,
            lookup: ((_h: any, _o: any, cb: any) =>
              _o?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family)) as any,
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      });
      if (!publicAddress(response.socket.remoteAddress ?? "")) {
        response.destroy();
        denied("Connected to a non-public address.");
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.destroy();
        url = new URL(response.headers.location, url);
        continue;
      }
      if ((response.statusCode ?? 500) >= 400) {
        response.destroy();
        throw new WazapError("URL_FETCH_FAILED", `Media returned HTTP ${response.statusCode}`);
      }
      const declared = Number(response.headers["content-length"]);
      if (declared > io.maxBytes) {
        response.destroy();
        throw new WazapError("FILE_TOO_LARGE", "Media exceeds 100 MiB.");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > io.maxBytes) {
          response.destroy();
          throw new WazapError("FILE_TOO_LARGE", "Media exceeds 100 MiB.");
        }
        chunks.push(chunk);
      }
      return {
        buffer: Buffer.concat(chunks),
        mime: response.headers["content-type"]?.split(";")[0] ?? null,
        url: url.href,
      };
    }
    throw new WazapError("URL_FETCH_FAILED", "Media exceeded 5 redirects.");
  } catch (e) {
    if (e instanceof WazapError) throw e;
    throw new WazapError("URL_FETCH_FAILED", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
