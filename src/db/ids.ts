/**
 * Chronological message ids: `id = second * 2^20 + seq`. Ordering by id is
 * ordering by time, history backfill included, so "newest first" is a
 * backwards walk of the primary key and a page cursor is a plain `id < ?`.
 * The id's second always equals the message timestamp's second, which the
 * schema enforces with a CHECK; `seq` only orders messages inside one second.
 */
import { StorageError } from "./errors.js";

export const SEQ_SPAN = 2 ** 20;
/** The last second whose whole id range stays a safe integer (the year 2242). */
export const MAX_ID_SECOND = Math.floor(Number.MAX_SAFE_INTEGER / SEQ_SPAN) - 1;

/** A millisecond timestamp the store can file: a positive safe integer inside the id space. */
export function checkTimestamp(ms: unknown, name: string): number {
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || Math.floor(ms / 1000) > MAX_ID_SECOND) {
    throw new StorageError("INVALID_INPUT", `${name} must be a positive epoch-millisecond timestamp, got ${String(ms)}.`);
  }
  return ms;
}

/** A nullable instant (expiry, edit, deletion): null stays null, anything else must be ≥ 0. */
export function checkInstant(ms: unknown, name: string): number | null {
  if (ms === null || ms === undefined) return null;
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) {
    throw new StorageError("INVALID_INPUT", `${name} must be an epoch-millisecond timestamp, got ${String(ms)}.`);
  }
  return ms;
}

export function secondOf(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The first id of the second `ms` falls in. */
export function firstIdOfSecond(ms: number): number {
  return secondOf(ms) * SEQ_SPAN;
}

/** The smallest id a message at or after `sinceMs` can carry (inclusive bound). */
export function idLowerBound(sinceMs: number): number {
  return Math.max(0, firstIdOfSecond(Math.max(0, sinceMs)));
}

/** The first id past every message at or before `untilMs` (exclusive bound). */
export function idUpperBound(untilMs: number): number {
  if (untilMs < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, (secondOf(untilMs) + 1) * SEQ_SPAN);
}

export function secondOfId(id: number): number {
  return Math.floor(id / SEQ_SPAN);
}
