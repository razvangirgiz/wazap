/**
 * Variety in a ranked recall list, the rules the old recall index applied
 * after ranking, now over the fused hybrid ranking: a greedy walk in rank
 * order where a near-duplicate of a picked hit, or a hit from a chat that
 * already holds CHAT_SLOT_CAP leading slots, trails the list instead of
 * filling it. Demoted hits keep their score and sit behind the picked ones,
 * duplicates last, so a list scoped to a single chat keeps its order. The one
 * hit dropped is a copy of a better-ranked hit's exact words — a forward, a
 * paste — since it would only repeat that answer.
 */

/** One chat holds at most this many leading slots; further hits yield to other chats first. */
export const CHAT_SLOT_CAP = 3;
/** Word overlap at or above this marks a hit a near-duplicate of a picked one. */
export const NEAR_DUP_JACCARD = 0.8;

interface Profile {
  /** Folded, whitespace-collapsed text: two hits equal here differ only in case, accents or spacing. */
  norm: string;
  words: Set<string>;
}

/** Case- and diacritic-insensitive, so "Sâmbătă" and "sambata" are one word. */
function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function profile(text: string): Profile {
  const folded = fold(text);
  const words = new Set<string>();
  for (const match of folded.matchAll(/[\p{L}\p{N}]+/gu)) words.add(match[0]);
  return { norm: folded.replace(/\s+/g, " ").trim(), words };
}

/** Word Jaccard: two texts sharing most of their words are one answer. */
function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= NEAR_DUP_JACCARD;
}

export function diversify<T>(ranked: readonly T[], of: (hit: T) => { chat: string; text: string }): T[] {
  const picked: T[] = [];
  const overflow: T[] = [];
  const duplicates: T[] = [];
  const perChat = new Map<string, number>();
  const chosen: Profile[] = [];
  /** The exact words of every hit walked so far, whitespace aside. */
  const said = new Set<string>();
  for (const hit of ranked) {
    const { chat, text } = of(hit);
    const exact = text.replace(/\s+/g, " ").trim();
    if (exact !== "") {
      if (said.has(exact)) continue;
      said.add(exact);
    }
    const current = profile(text);
    if (current.norm !== "" && chosen.some((p) => p.norm === current.norm || nearDuplicate(p.words, current.words))) {
      duplicates.push(hit);
      continue;
    }
    const held = perChat.get(chat) ?? 0;
    if (held >= CHAT_SLOT_CAP) {
      overflow.push(hit);
      continue;
    }
    perChat.set(chat, held + 1);
    picked.push(hit);
    chosen.push(current);
  }
  return [...picked, ...overflow, ...duplicates];
}
