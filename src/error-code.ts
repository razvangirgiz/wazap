/**
 * What a failure was, without what it said. Messages can carry signed URLs,
 * credentials, paths or decoded content; a system or library code cannot, and
 * it is what separates a refused connection from a bad certificate.
 */
export function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    if (typeof code === "number" && Number.isSafeInteger(code)) return `exit ${code}`;
    current = (current as { cause?: unknown }).cause;
  }
  const name = err instanceof Error ? err.name : undefined;
  return name !== undefined && /^[A-Z][A-Za-z]{0,40}Error$/.test(name) && name !== "Error" && name !== "TypeError"
    ? name
    : undefined;
}

/** ` (CODE)` for a sentence, or nothing. */
export function withCode(err: unknown): string {
  const code = errorCode(err);
  return code === undefined ? "" : ` (${code})`;
}
