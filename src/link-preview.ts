import type { WAUrlInfo } from "baileys";
import { makePreview } from "./previews.js";
import { publicMedia, type MediaNetwork } from "./safe-media.js";

const PAGE_MAX = 256 * 1024;
const IMAGE_MAX = 2 * 1024 * 1024;
const TOTAL_MS = 4000;
const MAX_ACTIVE = 4;
let active = 0;

/** Only explicit HTTP(S) links; never guess a scheme or scan multiple destinations. */
export function firstPreviewUrl(text: string): string | null {
  let found = /https?:\/\/[^\s<>"'`]+/i.exec(text)?.[0];
  if (!found || found.length > 2048) return null;
  found = found.replace(/[.,!?;:]+$/, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (found.endsWith(close) && found.split(close).length > found.split(open).length) found = found.slice(0, -1);
  }
  return found;
}

function entities(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole: string, entity: string) => {
    if (!entity.startsWith("#")) return Object.hasOwn(named, entity) ? named[entity]! : whole;
    const hex = entity[1]?.toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

function label(text: string, limit: number): string {
  return entities(text)
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** A bounded metadata scanner, not a browser: no scripts, base tags, embeds or subresources. */
export function previewMetadata(html: string): { title: string; description: string; image?: string } {
  html = html.slice(0, PAGE_MAX);
  // ASCII folding preserves offsets (Unicode lowercasing can expand characters).
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const meta = new Map<string, string>();
  let title = "";
  let at = 0;
  while (at < html.length) {
    const start = html.indexOf("<", at);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    let end = start + 1;
    let quote = "";
    for (; end < Math.min(html.length, start + 8192); end++) {
      const char = html[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (html[end] !== ">") break;
    const tag = html.slice(start + 1, end);
    const name = /^\s*(\/?[a-z][\w-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
    at = end + 1;
    if (name === "body" || name === "/head") break;
    if (name && ["script", "style", "template", "noscript", "title"].includes(name)) {
      const closing = new RegExp(`</${name}\\s*>`, "g");
      closing.lastIndex = at;
      const match = closing.exec(lower);
      if (!match) break;
      if (name === "title" && !title) title = html.slice(at, Math.min(match.index, at + 8192));
      at = closing.lastIndex;
      continue;
    }
    if (name !== "meta") continue;
    const attrs = new Map<string, string>();
    const pattern = /([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of tag.slice(4).matchAll(pattern)) {
      const key = match[1]!.toLowerCase();
      if (!attrs.has(key)) attrs.set(key, match[2] ?? match[3] ?? match[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const image = meta.get("og:image") ?? meta.get("twitter:image");
  return {
    title: label(meta.get("og:title") ?? meta.get("twitter:title") ?? title, 200),
    description: label(
      meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "",
      500
    ),
    ...(image ? { image: entities(image).trim() } : {}),
  };
}

/** Explicit result (including null) always suppresses Baileys's own fetcher.
 * IO overrides are a test seam, never MCP arguments. No cookies/auth/referrer,
 * URL logs, cross-message cache, browser execution or unvalidated thumbnail URL.
 */
export async function safeLinkPreview(text: string, io: Partial<MediaNetwork> = {}): Promise<WAUrlInfo | null> {
  const url = firstPreviewUrl(text);
  if (!url || active >= MAX_ACTIVE) return null;
  active++;
  const deadline = performance.now() + Math.min(TOTAL_MS, io.timeoutMs ?? TOTAL_MS);
  const fetchResource = (target: string, maxBytes: number) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Preview deadline reached.");
    return publicMedia(target, { ...io, maxBytes, timeoutMs: remaining, maxRedirects: 3, allowHttpsDowngrade: false });
  };
  try {
    const page = await fetchResource(url, PAGE_MAX);
    if (!["text/html", "application/xhtml+xml"].includes(page.mime?.trim().toLowerCase() ?? "")) return null;
    const metadata = previewMetadata(page.buffer.toString("utf8"));
    if (!metadata.title) return null;
    const preview: WAUrlInfo = {
      "matched-text": url,
      "canonical-url": page.url,
      title: metadata.title,
      description: metadata.description,
    };
    if (metadata.image) {
      try {
        const imageUrl = new URL(metadata.image, page.url);
        if (new URL(page.url).protocol === "https:" && imageUrl.protocol !== "https:") return preview;
        const image = await fetchResource(imageUrl.href, IMAGE_MAX);
        // JPEG only for now: bounded pure-JS decoding, never Jimp.read(URL),
        // SVG, ffmpeg, or a decoder that can open external resources.
        if (image.mime?.trim().toLowerCase() === "image/jpeg") {
          const made = makePreview(image.buffer, 200, { maxResolutionInMP: 4, maxMemoryUsageInMB: 32 });
          preview.jpegThumbnail = Buffer.from(made.base64, "base64");
        }
      } catch {
        /* A missing/unsafe thumbnail must not prevent a text card or send. */
      }
    }
    return preview;
  } catch {
    return null;
  } finally {
    active--;
  }
}
