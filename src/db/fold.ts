/**
 * The trigram index's fold, in JavaScript: what FTS5's trigram tokenizer with
 * remove_diacritics 1 does to each code point — case folding in every script
 * it knows, diacritics removed only where SQLite removes them — and nothing
 * else. The short-query scan and the hybrid query words match through this,
 * so a message a two-letter query finds is one the index would find too.
 * The table is generated from SQLite (scripts/gen-fold-table.mjs).
 */
import { FOLD_RUNS } from "./fold-table.js";

const BMP = new Uint16Array(0x10000);
const ASTRAL = new Map<number, number>();
for (let cp = 0; cp < BMP.length; cp++) BMP[cp] = cp;
for (const [first, count, delta, step] of FOLD_RUNS) {
  for (let k = 0; k < count; k++) {
    const cp = first + k * step;
    if (cp < 0x10000) BMP[cp] = cp + delta;
    else ASTRAL.set(cp, cp + delta);
  }
}

export function foldCodePoint(cp: number): number {
  return cp < 0x10000 ? BMP[cp]! : (ASTRAL.get(cp) ?? cp);
}

export function foldText(text: string): string {
  let plain = true;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x80 || (unit >= 0x41 && unit <= 0x5a)) {
      plain = false;
      break;
    }
  }
  if (plain) return text;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const folded = foldCodePoint(cp);
    out += folded === cp ? ch : String.fromCodePoint(folded);
  }
  return out;
}
