/**
 * A small JPEG of a photo, made here. WhatsApp used to ship a preview inside
 * every image message; in 2026 almost none carries one (1 in 500 in a real
 * account), so the preview an agent needs to tell a receipt from a baby has
 * to be computed from the photo itself. jpeg-js is pure JavaScript: no
 * native build, no sharp, and the photo never leaves the machine.
 */
import jpeg from "jpeg-js";

/** Longest edge of a preview. 320 px reads a receipt's total and a face. */
export const PREVIEW_MAX_EDGE = 320;
const PREVIEW_QUALITY = 60;

export interface PreviewImage {
  mime: string;
  base64: string;
  width: number;
  height: number;
}

/** Decode a JPEG, shrink it with a box filter, encode it small. Throws on a file that is not a JPEG. */
export function makePreview(input: Buffer, maxEdge = PREVIEW_MAX_EDGE): PreviewImage {
  const source = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 50, maxMemoryUsageInMB: 512 });
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const out = Buffer.alloc(width * height * 4);
  const src = source.data;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * source.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * source.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * source.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, at += 4) {
          r += src[at]!;
          g += src[at + 1]!;
          b += src[at + 2]!;
          n++;
        }
      }
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / n);
      out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n);
      out[to + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: out, width, height }, PREVIEW_QUALITY);
  return { mime: "image/jpeg", base64: Buffer.from(encoded.data).toString("base64"), width, height };
}
