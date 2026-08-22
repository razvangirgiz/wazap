/**
 * stdout is the MCP JSON-RPC channel, so every human-readable line goes to
 * stderr. Anything else on stdout corrupts the protocol stream.
 */

const PREFIX = "[wazap]";

export function log(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${PREFIX} ERROR (${context}):`, message);
}

/** CLI output for a human at a terminal. Also stderr, for the same reason. */
export function say(...args: unknown[]): void {
  console.error(...args);
}
