/**
 * A PDF's compressed streams measured before pdf.js or poppler reads them. A
 * stream is stored compressed (Flate, LZW, Brotli, run-length), and a few
 * megabytes can unpack to gigabytes: pdf.js unpacks a font program or a
 * page's content whole, in ArrayBuffers that the document worker's heap
 * limit does not count, and poppler does the same in its own process. Here
 * every stream is unpacked through its filters with a cap and then dropped:
 * one stream past the cap, or all of them past the total, refuses the file
 * before anything else reads it.
 *
 * Images are left out: the text read never decodes one, and poppler draws a
 * page's images a line at a time. The dictionary is read on a best-effort
 * basis, so a stream is tried as Flate whatever its dictionary says; what a
 * crafted dictionary still hides from this check is caught by the memory
 * watch around the reader (src/documents.ts, src/native-run.ts).
 */
import { brotliDecompressSync, constants, inflateSync } from "node:zlib";

const MB = 1_000_000;

/** What the streams of one PDF may unpack to. */
export const PDF_STREAM_LIMITS = { perStream: 64 * MB, total: 256 * MB };

/** How far back from `stream` its dictionary is looked for. */
const DICT_WINDOW = 64 * 1024;

class TooBig extends Error {}

/**
 * Why `pdf` is refused before it is read: a stream that unpacks past
 * `limits.perStream`, or streams past `limits.total` in all. Null for a file
 * whose streams fit.
 */
export function pdfBombReason(pdf: Uint8Array, limits = PDF_STREAM_LIMITS): string | null {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  let total = 0;
  let at = 0;
  for (;;) {
    const found = buf.indexOf("stream", at, "latin1");
    if (found < 0) return null;
    at = found + 6;
    if (found >= 3 && buf.toString("latin1", found - 3, found) === "end") continue;
    const dict = dictBefore(buf, found);
    // Only a dictionary opens a stream; a "stream" anywhere else is a word in some data.
    if (dict === null) continue;
    if (/\/Subtype\s*\/Image\b|\/Type\s*\/EmbeddedFile\b/.test(dict)) continue;
    const start = lineAfter(buf, found + 6);
    if (start === null) continue;
    const room = Math.min(limits.perStream, limits.total - total);
    let used: number;
    try {
      used = unpackedSize(buf.subarray(start), bodyEnd(buf, start, dict) - start, filtersOf(dict), /\/EarlyChange\s+0\b/.test(dict) ? 0 : 1, room);
    } catch (err) {
      if (!(err instanceof TooBig)) throw err;
      return room < limits.perStream
        ? `its streams unpack to more than ${limits.total / MB} MB in all (a compression bomb)`
        : `a stream in it unpacks to more than ${limits.perStream / MB} MB (a compression bomb)`;
    }
    total += used;
  }
}

/** The dictionary just before a `stream` keyword: `<< ... >>`, balanced backwards; null when there is none. */
function dictBefore(buf: Buffer, keyword: number): string | null {
  let end = keyword - 1;
  while (end >= 0 && isWhite(buf[end]!)) end--;
  if (end < 1 || buf[end] !== 0x3e || buf[end - 1] !== 0x3e) return null;
  const floor = Math.max(0, keyword - DICT_WINDOW);
  let depth = 0;
  for (let i = end; i > floor; i--) {
    if (buf[i] === 0x3e && buf[i - 1] === 0x3e) {
      depth++;
      i--;
    } else if (buf[i] === 0x3c && buf[i - 1] === 0x3c) {
      depth--;
      i--;
      if (depth === 0) return buf.toString("latin1", i, end + 1);
    }
  }
  return null;
}

function isWhite(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

/** Where a stream's data starts: after the end of the keyword's line, as pdf.js skips to it. */
function lineAfter(buf: Buffer, from: number): number | null {
  const limit = Math.min(buf.length, from + 256);
  for (let i = from; i < limit; i++) {
    if (buf[i] === 0x0a) return i + 1;
    if (buf[i] === 0x0d) return buf[i + 1] === 0x0a ? i + 2 : i + 1;
  }
  return null;
}

/** Where a stream's data ends: at its direct /Length when "endstream" follows there, else at the next "endstream". */
function bodyEnd(buf: Buffer, start: number, dict: string): number {
  const stated = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
  if (stated) {
    const end = start + Number(stated[1]);
    let after = end;
    while (after < buf.length && isWhite(buf[after]!)) after++;
    if (end <= buf.length && buf.toString("latin1", after, after + 9) === "endstream") return end;
  }
  const marker = buf.indexOf("endstream", start, "latin1");
  return marker < 0 ? buf.length : marker;
}

/** The names under /Filter, in order; [] for none; null when they cannot be read (an indirect reference). */
function filtersOf(dict: string): string[] | null {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[^\s/[\]<>()%]+|\d+\s+\d+\s+R)/.exec(dict);
  if (!match) return [];
  if (/\d+\s+\d+\s+R/.test(match[1]!)) return null;
  return [...match[1]!.matchAll(/\/([^\s/[\]<>()%]+)/g)].map((name) => name[1]!);
}

/**
 * What a stream's data unpacks to through `filters`, every stage counted
 * (pdf.js keeps each stage's output whole), within `room` bytes. Flate and
 * Brotli data is given the rest of the file: each ends itself, so a stray
 * "endstream" inside it cannot hide the rest. The other formats read the
 * stream's body (`bodyLength` bytes), since data past it would count as
 * theirs. Throws TooBig past `room`.
 */
function unpackedSize(rest: Buffer, bodyLength: number, filters: string[] | null, earlyChange: number, room: number): number {
  // Whatever the dictionary says (or seems to), data that inflates is measured as Flate.
  const chain = filters === null || filters.length === 0 ? ["FlateDecode"] : filters;
  const selfEnding = (filter: string): boolean => ["FlateDecode", "Fl", "BrotliDecode"].includes(filter);
  let input: Uint8Array = selfEnding(chain[0]!) ? rest : rest.subarray(0, Math.max(0, bodyLength));
  let used = 0;
  for (const filter of chain) {
    const left = room - used;
    let output: Uint8Array | null;
    switch (filter) {
      case "FlateDecode":
      case "Fl":
        output = guarded(() => inflateSync(input, { maxOutputLength: left + 1, finishFlush: constants.Z_SYNC_FLUSH }));
        break;
      case "BrotliDecode":
        output = guarded(() => brotliDecompressSync(input, { maxOutputLength: left + 1, finishFlush: constants.BROTLI_OPERATION_FLUSH }));
        break;
      case "LZWDecode":
      case "LZW":
        output = lzwDecode(input, earlyChange, left);
        break;
      case "RunLengthDecode":
      case "RL":
        output = runLengthDecode(input, left);
        break;
      case "ASCII85Decode":
      case "A85":
        output = ascii85Decode(input, left);
        break;
      case "ASCIIHexDecode":
      case "AHx":
        output = asciiHexDecode(input, left);
        break;
      default:
        // An image codec, encryption or a name pdf.js does not know: nothing here unpacks further.
        output = null;
    }
    if (output === null) break;
    if (output.length > left) throw new TooBig();
    used += output.length;
    input = output;
  }
  return used;
}

/** A zlib or Brotli decode: past its cap is TooBig; data that is not of that format unpacks to nothing here. */
function guarded(decode: () => Buffer): Buffer | null {
  try {
    return decode();
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw new TooBig();
    return null;
  }
}

/** A growable output that refuses to pass `cap`. */
class Output {
  bytes: Uint8Array;
  length = 0;

  constructor(
    private readonly cap: number,
    hint: number
  ) {
    this.bytes = new Uint8Array(Math.max(1, Math.min(cap, hint)));
  }

  reserve(n: number): void {
    if (this.length + n > this.cap) throw new TooBig();
    if (this.length + n <= this.bytes.length) return;
    const grown = new Uint8Array(Math.min(this.cap, Math.max(this.bytes.length * 2, this.length + n)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  done(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** LZW as PDF writes it (9 to 12-bit codes, 256 clears, 257 ends), as pdf.js reads it, within `cap`. */
export function lzwDecode(input: Uint8Array, earlyChange: number, cap: number): Uint8Array {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  const out = new Output(cap, input.length * 4 + 1024);
  let next = 258;
  let codeLength = 9;
  let previous = -1;
  let bits = 0;
  let bitCount = 0;
  let pos = 0;
  const write = (code: number, at: number): void => {
    for (let c = code, i = at + length[code]! - 1; c >= 0; c = prefix[c]!, i--) out.bytes[i] = suffix[c]!;
  };
  for (;;) {
    while (bitCount < codeLength) {
      if (pos >= input.length) return out.done();
      bits = ((bits << 8) | input[pos++]!) & 0xffffff;
      bitCount += 8;
    }
    const code = (bits >>> (bitCount - codeLength)) & ((1 << codeLength) - 1);
    bitCount -= codeLength;
    if (code === 256) {
      next = 258;
      codeLength = 9;
      previous = -1;
      continue;
    }
    if (code === 257) return out.done();
    const at = out.length;
    let first: number;
    if (code < 256 || (code >= 258 && code < next)) {
      out.reserve(length[code]!);
      write(code, at);
      out.length = at + length[code]!;
      first = out.bytes[at]!;
    } else if (code === next && previous >= 0) {
      const size = length[previous]! + 1;
      out.reserve(size);
      write(previous, at);
      first = out.bytes[at]!;
      out.bytes[at + size - 1] = first;
      out.length = at + size;
    } else {
      return out.done();
    }
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      length[next] = length[previous]! + 1;
      next++;
    }
    previous = code;
    const reach = next + earlyChange;
    codeLength = reach >= 2048 ? 12 : reach >= 1024 ? 11 : reach >= 512 ? 10 : 9;
  }
}

/** Run-length data (a count, then bytes or one byte repeated; 128 ends), within `cap`. */
function runLengthDecode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length * 2 + 1024);
  let pos = 0;
  while (pos < input.length) {
    const n = input[pos++]!;
    if (n === 128) break;
    if (n < 128) {
      const count = Math.min(n + 1, input.length - pos);
      out.reserve(count);
      out.bytes.set(input.subarray(pos, pos + count), out.length);
      out.length += count;
      pos += count;
    } else {
      if (pos >= input.length) break;
      const count = 257 - n;
      out.reserve(count);
      out.bytes.fill(input[pos++]!, out.length, out.length + count);
      out.length += count;
    }
  }
  return out.done();
}

/** ASCII85 to its end mark `~>`, within `cap` ("z" alone is four zero bytes). */
function ascii85Decode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length);
  const group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (group[i] ?? 84);
    out.reserve(count);
    for (let i = 0; i < count; i++) out.bytes[out.length++] = (value >>> (24 - 8 * i)) & 0xff;
  };
  for (let pos = 0; pos < input.length; pos++) {
    const byte = input[pos]!;
    if (byte === 0x7e) break;
    if (byte === 0x7a && group.length === 0) {
      out.reserve(4);
      out.bytes.fill(0, out.length, out.length + 4);
      out.length += 4;
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) {
      flush(4);
      group.length = 0;
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return out.done();
}

/** Hex digits to their end mark `>`, within `cap`. */
function asciiHexDecode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length / 2 + 1);
  let high = -1;
  for (let pos = 0; pos < input.length; pos++) {
    const byte = input[pos]!;
    if (byte === 0x3e) break;
    const digit = byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 55 : byte >= 0x61 && byte <= 0x66 ? byte - 87 : -1;
    if (digit < 0) continue;
    if (high < 0) high = digit;
    else {
      out.reserve(1);
      out.bytes[out.length++] = (high << 4) | digit;
      high = -1;
    }
  }
  if (high >= 0) {
    out.reserve(1);
    out.bytes[out.length++] = high << 4;
  }
  return out.done();
}
