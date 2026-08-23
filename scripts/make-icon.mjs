#!/usr/bin/env node
/**
 * icon.png for the Claude Desktop bundle: the banner green with a white W, at
 * the 512×512 mcpb's own validator recommends. Written byte by byte rather
 * than pulled from an image library, because one icon is not worth a
 * dependency in a package people npx.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SIZE = 512;
/** xterm-256 colour 42, the one src/ui.ts paints the banner with. */
const BRAND = [0x00, 0xd7, 0x87];
const RADIUS = SIZE * 0.22;
const SAMPLES = 3;

/** The five corners of a W, in fractions of the canvas. */
const W_POINTS = [
  [0.22, 0.3],
  [0.36, 0.72],
  [0.5, 0.45],
  [0.64, 0.72],
  [0.78, 0.3],
].map(([x, y]) => [x * SIZE, y * SIZE]);
const STROKE = SIZE * 0.052;

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

function insideW(x, y) {
  for (let i = 0; i < W_POINTS.length - 1; i++) {
    if (distanceToSegment(x, y, W_POINTS[i], W_POINTS[i + 1]) <= STROKE) return true;
  }
  return false;
}

/** Coverage of both shapes at one pixel, supersampled so the diagonals are not jagged. */
function coverage(px, py) {
  let background = 0;
  let letter = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      if (insideRoundedSquare(x, y)) background++;
      if (insideW(x, y)) letter++;
    }
  }
  const total = SAMPLES * SAMPLES;
  return { background: background / total, letter: letter / total };
}

function pixels() {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (1 + SIZE * 4);
    raw[row] = 0;
    for (let x = 0; x < SIZE; x++) {
      const { background, letter } = coverage(x, y);
      const white = Math.min(letter, background);
      const at = row + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[at + c] = Math.round(BRAND[c] + (255 - BRAND[c]) * white);
      raw[at + 3] = Math.round(background * 255);
    }
  }
  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(pixels(), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = fileURLToPath(new URL("../icon.png", import.meta.url));
writeFileSync(target, png);
console.log(`wrote icon.png (${SIZE}×${SIZE}, ${png.length} bytes)`);
