/**
 * Logging for an stdio MCP server.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC channel. Anything written there that
 * is not a protocol message corrupts the stream, so ALL human-readable logging
 * (and the QR code) must go to stderr.
 */

const PREFIX = "[whatsapp-mcp]";

export function log(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${PREFIX} ERROR (${context}):`, message);
}
